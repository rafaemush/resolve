/**
 * Follows of public shadow markets and the private early reveal (plan §19.2 item 5, §17.3 P7-lite). A tenant follows a
 * shadow market (tenant_id null, not a test market, open) and reads its committed verdicts before the platform resolves
 * (GET /v1/shadow/:market_id, the shadow.committed webhook). The early reveal is private and labeled: it is never part
 * of the public record, and it never carries the nonce or the preimage, which stay private until the public reveal.
 * A follow delivers only while it is entitled (followBlock): a free-plan (evaluation) tenant only while it holds a live
 * key, and every plan only for its oldest follows of open markets up to the plan's cap, so an expired evaluation key or
 * a lowered plan stops the early reveal instead of leaving it on forever. The routes name a market by its uuid or by
 * the venue id /record prints, "<platform>:<external_id>" (plan §22.3 #4, parseMarketRef).
 * Pure rules here (tested in tests/follows.test.ts); the atomic cap + insert is follow_market() and the facts the rules
 * read are follow_entitlements() (migration 014).
 */
import { z } from "zod";
import type { Db } from "../db/supabase";
import { CommittedVerdict, DISCLAIMER, marketRef, type CommittedFields } from "../bot/commit";
import type { MarketRow } from "../ingest/types";
import { Platform } from "../resolve/schema";
import { venueBasis } from "../api/public-names";

export const PLANS = ["free", "payg", "builder", "growth", "platform"] as const;
export const Plan = z.enum(PLANS);
export type Plan = z.infer<typeof Plan>;

export const EARLY_REVEAL_LABEL = "private early reveal — excluded from the public record";

/**
 * Active follows of open markets per tenant (plan §17.3 P7-lite): 50 by default, 500 on Growth, unlimited (null) on
 * Platform. A follow of a settled market does not count: it can produce no further event.
 */
export function followCap(plan: Plan): number | null {
  switch (plan) {
    case "platform": return null;
    case "growth": return 500;
    case "free": case "payg": case "builder": return 50;
    default: { const never: never = plan; throw new Error(`unknown plan ${String(never)}`); }
  }
}

const MarketUuid = z.string().uuid();
/** "<platform>:<external_id>": the platforms of markets.platform (migration 002), an external_id as registered (1-200 characters). */
const VENUE_ID = new RegExp(`^(${Platform.options.join("|")}):([\\s\\S]{1,200})$`);
export const MARKET_REF_HINT = `market id must be a uuid or a venue id <platform>:<external_id> (platform ${Platform.options.join(", ")}), as /record prints it`;

/** A market as a follow or early-reveal path names it. */
export type MarketRef = { kind: "uuid"; id: string } | { kind: "venue"; platform: z.infer<typeof Platform>; externalId: string };

/**
 * Pure. The market a path names: its uuid, or its venue id "<platform>:<external_id>" exactly as /record and the home
 * page print it (external_id as registered, 1 to 200 characters). A venue id names only a public shadow market: the
 * route looks it up with tenant_id null, is_test false and deleted_at null, and one match is required. Null for
 * anything else.
 */
export function parseMarketRef(raw: string): MarketRef | null {
  if (MarketUuid.safeParse(raw).success) return { kind: "uuid", id: raw };
  const m = VENUE_ID.exec(raw);
  return m ? { kind: "venue", platform: m[1] as z.infer<typeof Platform>, externalId: m[2]! } : null;
}

/** Pure. The one market a lookup found: a venue id that matches more than one public shadow market is refused, never guessed. */
export const onlyMatch = <T>(rows: readonly T[] | null | undefined): T | null => (rows?.length === 1 ? rows[0]! : null);

/** The markets columns the follow rules read. */
export interface FollowTarget { id: string; tenant_id: string | null; is_test: boolean; status: string; deleted_at: string | null }
export interface FollowRefusal { status: 400 | 404; code: "not_found" | "validation_error"; message: string }

/**
 * Pure. Why `tenantId` may not follow this market, or null. Another tenant's market and a test market answer exactly
 * like a missing one, so the route never confirms that a private market exists.
 */
export function followRefusal(m: FollowTarget | null, tenantId: string): FollowRefusal | null {
  const missing: FollowRefusal = { status: 404, code: "not_found", message: "market not found" };
  if (!m || m.deleted_at) return missing;
  if (m.tenant_id !== null && m.tenant_id === tenantId) {
    return { status: 400, code: "validation_error", message: "this is your own market: its verdicts reach you as market.* webhooks and GET /v1/markets/:id/resolutions; only public shadow markets can be followed" };
  }
  if (m.tenant_id !== null || m.is_test) return missing;
  if (m.status !== "open") {
    return { status: 400, code: "validation_error", message: `market is ${m.status}: only open shadow markets can be followed; its commits and reveal are on the public record (GET /v1/track-record/verify?hash=)` };
  }
  return null;
}

/** follow_market()'s answer (migration 014). active = the tenant's active follows of open markets (what the cap counts). */
export const FollowAnswer = z.discriminatedUnion("result", [
  z.object({ result: z.literal("followed"), follow_id: z.string(), active: z.number().int() }),
  z.object({ result: z.literal("already_following"), follow_id: z.string(), active: z.number().int() }),
  z.object({ result: z.literal("cap_reached"), active: z.number().int(), cap: z.number().int() }),
  z.object({ result: z.literal("not_followable"), reason: z.string() }),
]);
export type FollowAnswer = z.infer<typeof FollowAnswer>;

/** Follow through follow_market(): tenant row locked, cap counted and row inserted in one transaction. Throws on a DB error. */
export async function followMarket(client: Db, tenantId: string, marketId: string, cap: number | null): Promise<FollowAnswer> {
  const { data, error } = await client.rpc("follow_market", { p_tenant: tenantId, p_market: marketId, p_cap: cap });
  if (error) throw new Error(`follow_market: ${error.message}`);
  const parsed = FollowAnswer.safeParse(data);
  if (!parsed.success) throw new Error(`follow_market answered ${JSON.stringify(data).slice(0, 200)}`);
  return parsed.data;
}

/** One row of follow_entitlements() (migration 014): facts about an active follow; followBlock() applies the rules. */
export const FollowEntitlement = z.object({
  tenant_id: z.string(),
  follow_id: z.string(),
  plan: Plan,
  /** The tenant holds a key that is not revoked, not deleted and not expired. */
  live_key: z.boolean(),
  /** The follow's position, oldest first, among the tenant's follows of open markets plus this market. */
  open_rank: z.number().int().positive(),
});
export type FollowEntitlement = z.infer<typeof FollowEntitlement>;

export type FollowBlock = "evaluation_ended" | "over_follow_limit";

/**
 * Pure. Why this follow receives nothing now, or null when it delivers. A free-plan follow is part of an evaluation key
 * and lasts only while a key is live (docs/pricing.md); on every plan only the oldest follows up to the plan's cap
 * deliver, which is what follow_market() admitted unless the plan was lowered since.
 */
export function followBlock(e: FollowEntitlement): FollowBlock | null {
  if (e.plan === "free" && !e.live_key) return "evaluation_ended";
  const cap = followCap(e.plan);
  return cap !== null && e.open_rank > cap ? "over_follow_limit" : null;
}

/** follow_entitlements() for a market (one tenant's follow only, when tenantId is given); error when it could not be read. */
export async function followEntitlements(client: Db, marketId: string, tenantId?: string): Promise<{ rows: FollowEntitlement[]; error: string | null }> {
  const { data, error } = await client.rpc("follow_entitlements", tenantId ? { p_market: marketId, p_tenant: tenantId } : { p_market: marketId });
  if (error) return { rows: [], error: error.message };
  const parsed = z.array(FollowEntitlement).safeParse(data ?? []);
  if (!parsed.success) return { rows: [], error: `follow_entitlements answered ${JSON.stringify(data).slice(0, 200)}` };
  return { rows: parsed.data, error: null };
}

/**
 * Tenants whose follow of the market delivers now (live tenants, followBlock null); error when the follows could not
 * be read. A follow that is blocked is not an error: its tenant simply gets no event.
 */
export async function followerTenants(client: Db, marketId: string): Promise<{ tenants: string[]; error: string | null }> {
  const r = await followEntitlements(client, marketId);
  if (r.error) return { tenants: [], error: r.error };
  return { tenants: [...new Set(r.rows.filter((e) => followBlock(e) === null).map((e) => e.tenant_id))], error: null };
}

/**
 * How a venue-facing surface names the route: "web_evidence" for the model route. Customer-facing surfaces never name
 * the model (plan §2.1, MCA §2.3(a)); the venue report prints the same wording. Defined with the other public names in
 * src/api/public-names.ts and re-exported here for existing imports.
 */
export { venueBasis };

/** The verdict fields a follower sees: the committed (public-floored) verdict, never the preimage or the nonce. */
export function shadowVerdict(c: CommittedFields): Record<string, unknown> {
  return {
    resolution_status: c.resolution_status, winning_outcome: c.winning_outcome, confidence_score: c.confidence_score,
    caveats: c.caveats, determination_basis: venueBasis(c.determination_basis), thresholds_version: c.thresholds_version,
  };
}

const sha = (v: unknown): string | null => (typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null);

export interface ShadowCommitRow { id: string; commitment_sha256: string; created_at: string; channel: string; telegram_date: string | null; payload: Record<string, unknown> }
export type ShadowMarket = Pick<MarketRow, "id" | "platform" | "external_id" | "status" | "deadline_utc">;

/**
 * Pure: one commit as a follower reads it. A commit recorded before migration 012 has no payload.committed; its
 * verdict is null (it is readable after the reveal through /v1/track-record/verify) and its hashes come from the payload.
 */
export function shapeShadowCommit(row: ShadowCommitRow): Record<string, unknown> {
  const committed = CommittedVerdict.safeParse(row.payload?.committed);
  return {
    commitment_sha256: row.commitment_sha256,
    committed_at: row.created_at,
    posted: row.channel === "telegram",
    posted_at: row.telegram_date,
    verdict: committed.success ? shadowVerdict(committed.data) : null,
    evidence: {
      raw_sha256: committed.success ? committed.data.raw_sha256 : sha(row.payload?.evidence_raw_sha256),
      canonical_sha256: committed.success ? committed.data.canonical_sha256 : sha(row.payload?.canonical_sha256),
    },
  };
}

/** Pure: GET /v1/shadow/:market_id. Commits newest first; latest is the verdict the market stands on now. */
export function shapeShadow(m: ShadowMarket, commits: ShadowCommitRow[]): Record<string, unknown> {
  const shaped = [...commits]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id))
    .map(shapeShadowCommit);
  return {
    market_id: m.id, platform: m.platform, external_id: m.external_id, market: marketRef(m), status: m.status, deadline_utc: m.deadline_utc,
    label: EARLY_REVEAL_LABEL,
    latest: shaped[0] ?? null,
    commits: shaped,
    how_to_verify: "Each commitment_sha256 is public in the channel from the moment it is posted; after the platform resolves, the reveal prints the preimage, and sha256(preimage) = commitment_sha256 (GET /v1/track-record/verify?hash=).",
    disclaimer: DISCLAIMER,
  };
}

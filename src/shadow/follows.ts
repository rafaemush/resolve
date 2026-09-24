/**
 * Follows of public shadow markets and the private early reveal (plan §19.2 item 5, §17.3 P7-lite). A tenant follows a
 * shadow market (tenant_id null, not a test market, open) and reads its committed verdicts before the platform resolves
 * (GET /v1/shadow/:market_id, the shadow.committed webhook). The early reveal is private and labeled: it is never part
 * of the public record, and it never carries the nonce or the preimage, which stay private until the public reveal.
 * Pure rules here (tested in tests/follows.test.ts); the atomic cap + insert is follow_market() (migration 014).
 */
import { z } from "zod";
import type { Db } from "../db/supabase";
import { CommittedVerdict, DISCLAIMER, marketRef, type CommittedFields } from "../bot/commit";
import type { MarketRow } from "../ingest/types";

export const PLANS = ["free", "payg", "builder", "growth", "platform"] as const;
export const Plan = z.enum(PLANS);
export type Plan = z.infer<typeof Plan>;

export const EARLY_REVEAL_LABEL = "private early reveal — excluded from the public record";

/** Active follows per tenant (plan §17.3 P7-lite): 50 by default, 500 on Growth, unlimited (null) on Platform. */
export function followCap(plan: Plan): number | null {
  switch (plan) {
    case "platform": return null;
    case "growth": return 500;
    case "free": case "payg": case "builder": return 50;
    default: { const never: never = plan; throw new Error(`unknown plan ${String(never)}`); }
  }
}

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

/** follow_market()'s answer (migration 014). */
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

/** Tenants with an active follow of the market (live tenants only); error when the follows could not be read. */
export async function followerTenants(client: Db, marketId: string): Promise<{ tenants: string[]; error: string | null }> {
  const { data, error } = await client.from("market_follows").select("tenant_id, tenants!inner(deleted_at)").eq("market_id", marketId).is("deleted_at", null).is("tenants.deleted_at", null);
  if (error) return { tenants: [], error: error.message };
  return { tenants: [...new Set(((data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id))], error: null };
}

/** The verdict fields a follower sees: the committed (public-floored) verdict, never the preimage or the nonce. */
export function shadowVerdict(c: CommittedFields): Record<string, unknown> {
  return {
    resolution_status: c.resolution_status, winning_outcome: c.winning_outcome, confidence_score: c.confidence_score,
    caveats: c.caveats, determination_basis: c.determination_basis, thresholds_version: c.thresholds_version,
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

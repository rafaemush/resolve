/**
 * Commit-reveal for shadow verdicts (plan §10, §16.4 P2 step 1, §17.3 P2a).
 *
 * Commit: the bot_posts row is INSERTED FIRST (channel 'pending', unique dedup_key) with the commitment hash, the nonce
 * and the exact committed verdict (payload.committed), then posted, then only the delivery columns are filled
 * (migration 012's trigger lets exactly that transition through, once). A failed post leaves a pending row that the
 * channel poster (src/bot/post.ts) re-posts and the reconcile job alerts on after 15 minutes; a failed insert never
 * becomes a public post. Before 012 the post went first: a failed insert orphaned a public post and a failed post lost
 * the commitment. Since 017 a commit is deduped against the market's latest commit only, and the legs of one event
 * (markets.event_key) are posted as one message by the channel poster.
 *
 * Reveal: a reply to the commit that prints the full preimage and the nonce, so sha256(preimage) = commitment can be
 * recomputed from the post text alone. Preimage v2's first field is platform:external_id (printed on every post);
 * v1 used the internal market uuid, which nobody outside could see before the reveal.
 */
import { z } from "zod";
import type { Env } from "../env";
import { db, type Db } from "../db/supabase";
import { sha256Hex } from "../resolve/text";
import { telegramConfigured } from "./telegram";
import { claimChannel, deliverMessage, releaseChannel, INLINE_LEASE_S } from "./channel";
import { ResolutionStatus, WinningOutcome, DeterminationBasis, type Verdict } from "../resolve/schema";
import type { MarketRow } from "../ingest/types";
import { alert } from "../ops/alerts";
import { redact } from "../ops/redact";

export const DISCLAIMER = "Informational signal, not financial advice, not an oracle of record.";

/**
 * Public confidence floor (plan §17.3 P2a, §19.2 item 3). During the first 100 public commits, counted by distinct event
 * (the 24 legs of one ladder are one), a Jev-route RESOLVED verdict whose published confidence is below 0.90 is
 * committed as UNRESOLVED/NONE with this caveat: one wrong public RESOLVED before n=100 is the most damaging event on the
 * record, and abstaining is never wrong on it. An event's place is commit_context().public_events_before: the other
 * events whose first public commit came before this event's first, so every leg of the 100th event is floored, not only
 * the leg that happened to commit first. The resolutions row keeps the original verdict; payload.committed carries the
 * floored one, and reveal and reconcile read only payload.committed.
 */
export const PUBLIC_FLOOR = { confidence: 0.9, firstCommits: 100, caveat: "below_public_floor_0.90" } as const;

/**
 * SQLSTATE of migration 012's bot_posts_commit_market_open: the market stopped being open (the reconcile settled it)
 * while this verdict was computed. Nothing is recorded or posted: a commit on a settled market would never be
 * reconciled or revealed, yet would count as a public call.
 */
export const MARKET_NOT_OPEN_SQLSTATE = "RS001";

export const CommittedVerdict = z.object({
  preimage_version: z.enum(["v1", "v2"]),
  preimage: z.string().min(1),
  resolution_status: ResolutionStatus,
  winning_outcome: WinningOutcome,
  confidence_score: z.number().min(0).max(0.99),
  caveats: z.array(z.string()),
  canonical_sha256: z.string().nullable(),
  raw_sha256: z.string().nullable(),
  thresholds_version: z.string(),
  determination_basis: DeterminationBasis.nullable(),
});
export type CommittedVerdict = z.infer<typeof CommittedVerdict>;
export type CommittedFields = Omit<CommittedVerdict, "preimage_version" | "preimage">;

export type Agreement = "agree" | "disagree" | "void" | "abstained" | "unresolved_by_platform";
export type OfficialAtSource = "gamma_closed_time" | "limitless_api_poll" | "first_observed_poll";
/** The platform of record's answer as reconcile stores it; outcome null = no official outcome (close-out). */
export interface OfficialRecord {
  outcome: "OPTION_A" | "OPTION_B" | "VOID" | null;
  label: string | null;
  at: string | null;
  at_source: OfficialAtSource | null;
  source_url: string | null;
}

export function verdictSignature(v: Pick<Verdict, "resolution_status" | "winning_outcome" | "error_reason">): string {
  return `${v.resolution_status}|${v.winning_outcome}|${v.error_reason ?? ""}`;
}

export function marketRef(m: Pick<MarketRow, "platform" | "external_id">): string { return `${m.platform}:${m.external_id}`; }
export function marketTag(m: Pick<MarketRow, "platform" | "external_id">): string { return `#${m.platform}-${m.external_id}`.replace(/[^#\w.-]/g, "_").slice(0, 60); }

/** first|status|outcome|confidence(2dp)|caveats joined by ,|canonical_sha256|thresholds_version|nonce. first = platform:external_id (v2) or the market uuid (v1). */
export function buildPreimage(first: string, c: CommittedFields, nonce: string): string {
  return `${first}|${c.resolution_status}|${c.winning_outcome}|${c.confidence_score.toFixed(2)}|${c.caveats.join(",")}|${c.canonical_sha256 ?? ""}|${c.thresholds_version}|${nonce}`;
}

/** The fields a commit binds, confidence rounded to the 2 decimals the preimage prints. */
export function committedFields(v: Verdict): CommittedFields {
  return {
    resolution_status: v.resolution_status,
    winning_outcome: v.winning_outcome,
    confidence_score: Number(v.confidence_score.toFixed(2)),
    caveats: [...v.caveats],
    canonical_sha256: v.evidence?.canonical_sha256 ?? null,
    raw_sha256: v.evidence?.raw_sha256 ?? null,
    thresholds_version: v.thresholds_version,
    determination_basis: v.determination_basis,
  };
}

/** Only a Jev RESOLVED below the floor can change; everything else is committed as the resolver produced it. */
export function floorCandidate(c: CommittedFields): boolean {
  return c.determination_basis === "jev" && c.resolution_status === "RESOLVED" && c.confidence_score < PUBLIC_FLOOR.confidence;
}

/** Pure. eventsBefore = distinct events whose first public commit came before this market's event's first. */
export function applyPublicFloor(c: CommittedFields, eventsBefore: number): CommittedFields {
  if (!floorCandidate(c) || eventsBefore >= PUBLIC_FLOOR.firstCommits) return c;
  const caveats = c.caveats.includes(PUBLIC_FLOOR.caveat) ? c.caveats : [...c.caveats, PUBLIC_FLOOR.caveat];
  return { ...c, resolution_status: "UNRESOLVED", winning_outcome: "NONE", caveats };
}

export function commitText(m: Pick<MarketRow, "platform" | "external_id">, commitment: string, rawSha: string | null, committedAt: string): string {
  return [
    `${marketTag(m)} | verdict committed`,
    `market ${marketRef(m)}`,
    `commitment sha256 ${commitment}`,
    `evidence raw sha256 ${rawSha ?? "n/a"}`,
    `committed ${committedAt}`,
    "The verdict and nonce are revealed as a reply once the platform resolves: sha256(preimage) = commitment.",
    DISCLAIMER,
  ].join("\n");
}

function randomNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * commit_context() (migration 017): the market's event_key, its latest commit (created_at desc, id desc: the order
 * settle_market makes the final commit), the other open legs of its event, and the event's place in the public record
 * (distinct other events whose first public commit came before this event's first).
 */
const CommitContext = z.object({
  event_key: z.string().min(1),
  latest: z.object({ id: z.string(), verdict_signature: z.string().nullable(), created_at: z.string() }).nullable(),
  event_open_markets: z.number().int().nonnegative(),
  public_events_before: z.number().int().nonnegative(),
});
type CommitContext = z.infer<typeof CommitContext>;

async function readCommitContext(client: Db, marketId: string): Promise<{ ok: true; ctx: CommitContext } | { ok: false; error: string }> {
  const { data, error } = await client.rpc("commit_context", { p_market: marketId });
  if (error) return { ok: false, error: redact(error.message).slice(0, 200) };
  const p = CommitContext.safeParse(data);
  return p.success ? { ok: true, ctx: p.data } : { ok: false, error: `unexpected commit_context answer ${JSON.stringify(data).slice(0, 200)}` };
}

/** The unique dedup_key of a commit: at most one commit follows a given latest commit (or none), so two invocations
 * that read the same latest collide instead of both committing. */
export function commitDedupKey(marketId: string, latestCommitId: string | null): string {
  return `commit:${marketId}:after:${latestCommitId ?? "none"}`;
}

/**
 * A commit row as recorded: what the private early reveal (src/shadow/events.ts) sends to followers. committed_at is the
 * bot_posts row's created_at, the database's clock at the insert: what "commit" means everywhere (shadow.committed,
 * v_venue_report.committed_at, /record's "release to commit"). The Telegram post is a separate step (posted_at, filled by
 * the inline post or the channel poster, paced), so a commit can precede its post by minutes.
 */
export interface RecordedCommit { id: string; commitment_sha256: string; committed_at: string; committed: CommittedVerdict }

export interface CommitResult { committed: boolean; posted: boolean; reason: string; commit?: RecordedCommit }

/** Two commits of the market landed while this one was recorded; the third attempt is not made (alerted). */
const COMMIT_ATTEMPTS = 2;

/**
 * Record the commit (INSERT first), then post it. Deduped against the market's LATEST commit only: a verdict equal to
 * it is not committed again, any other is, so a verdict that returns to an earlier signature (A -> B -> A) is committed
 * and the final commit reconcile settles is always the market's current verdict. A commit whose market shares its
 * event with another open leg is left pending for the channel poster (src/bot/post.ts), which posts an event's legs as
 * one message; a single-market commit is posted inline under the channel lease, or left pending when the channel is
 * busy or at its pacing ceiling. Test markets are recorded with channel 'none' and never posted. `commit` is set
 * whenever a row was recorded. opts.recorded (runWatch: the private early reveal, publishShadowCommitted) runs once the
 * row exists and before any post: an inline post can take seconds (the channel's 1.2 s gap, up to 3 attempts of 8 s,
 * 429 waits), and an invocation that ends inside it (an official release's inline commit runs late in waitUntil's 30 s)
 * must not leave a commit whose reveal was never queued, since a later run finds the commit and does not publish again.
 * It must never throw (publishShadowCommitted never does). Its subrequests are its own.
 * Subrequests: commit_context 1 + insert 1 (both again after a dedup collision) + inline post 6 (lease claim, send 3,
 * receipt, release), plus one alert on a failure.
 */
export async function commitVerdict(env: Env, market: MarketRow, resolutionId: string, v: Verdict, opts: { recorded?: (commit: RecordedCommit) => Promise<void> } = {}): Promise<CommitResult> {
  const client = db(env);
  const isTest = market.is_test === true;
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    const read = await readCommitContext(client, market.id);
    if (!read.ok) {
      await alert(env, `commit_insert_${market.id}`, `commit for ${marketRef(market)} (resolution ${resolutionId}) was not recorded: its latest commit could not be read (${read.error}). Nothing was posted.`, { dedupMinutes: 60 });
      return { committed: false, posted: false, reason: `commit_context: ${read.error}` };
    }
    const ctx = read.ctx;
    let fields = committedFields(v);
    // The floor counts distinct events (plan §17.3): the legs of one ladder are one public call, all floored or none.
    if (!isTest && floorCandidate(fields)) fields = applyPublicFloor(fields, ctx.public_events_before);
    const signature = verdictSignature({ resolution_status: fields.resolution_status, winning_outcome: fields.winning_outcome, error_reason: fields.resolution_status === "ERROR" ? v.error_reason : null });
    if (ctx.latest?.verdict_signature === signature) return { committed: false, posted: false, reason: "the market's latest commit already has this verdict signature" };
    const batched = !isTest && ctx.event_open_markets > 0;
    const nonce = randomNonce();
    const preimage = buildPreimage(marketRef(market), fields, nonce);
    const commitment = await sha256Hex(preimage);
    const committed: CommittedVerdict = { preimage_version: "v2", preimage, ...fields };
    const payload = { text: commitText(market, commitment, fields.raw_sha256, new Date().toISOString()), verdict_signature: signature, evidence_raw_sha256: fields.raw_sha256, canonical_sha256: fields.canonical_sha256, committed, post_attempts: 0, batched };
    const { data: row, error } = await client.from("bot_posts").insert({
      resolution_id: resolutionId, market_id: market.id, channel: isTest ? "none" : "pending", kind: "commit", message_id: null, telegram_date: null, posted_at: null,
      commitment_sha256: commitment, nonce, payload, dedup_key: commitDedupKey(market.id, ctx.latest?.id ?? null),
    }).select("id, created_at").single();
    // Another commit of this market landed after the read: compare against it instead.
    if (error?.code === "23505") continue;
    if (error?.code === MARKET_NOT_OPEN_SQLSTATE) return { committed: false, posted: false, reason: `not committed: ${error.message}` };
    if (error || !row) {
      await alert(env, `commit_insert_${market.id}`, `commit for ${marketRef(market)} (resolution ${resolutionId}, ${signature}) was not recorded: ${error?.message ?? "no row"}. Nothing was posted.`, { dedupMinutes: 60 });
      return { committed: false, posted: false, reason: `bot_posts insert: ${error?.message ?? "no row"}` };
    }
    const commit: RecordedCommit = { id: row.id as string, commitment_sha256: commitment, committed_at: String(row.created_at), committed };
    // the reveal is queued before the post, never after it (see above)
    if (opts.recorded) await opts.recorded(commit);
    if (isTest) return { committed: true, posted: false, reason: "test market: recorded, never posted", commit };
    if (!telegramConfigured(env)) return { committed: true, posted: false, reason: "pending: telegram not configured", commit };
    if (batched) return { committed: true, posted: false, reason: `pending: event ${ctx.event_key} has ${ctx.event_open_markets} other open market(s); the channel poster posts its legs as one message`, commit };
    const claim = await claimChannel(client, INLINE_LEASE_S);
    if (!claim.claimed) return { committed: true, posted: false, reason: `pending: ${claim.detail}; the channel poster posts it`, commit };
    try {
      const d = await deliverMessage(env, client, [commit.id], "commit", payload.text, null);
      return { committed: true, posted: d.posted, reason: d.posted ? "posted" : `pending: ${d.error}`, commit };
    } finally {
      await releaseChannel(client, claim.session);
    }
  }
  await alert(env, `commit_insert_${market.id}`, `commit for ${marketRef(market)} (resolution ${resolutionId}) was not recorded: ${COMMIT_ATTEMPTS} other commits of the market landed while it was being recorded. The latest of them stands; nothing was posted for this one.`, { dedupMinutes: 60 });
  return { committed: false, posted: false, reason: `not committed: ${COMMIT_ATTEMPTS} concurrent commits of this market` };
}

export interface CommitRow { id: string; market_id: string; nonce: string; commitment_sha256: string; payload: Record<string, unknown> }
export interface ResolutionFallback { resolution_status: Verdict["resolution_status"]; winning_outcome: Verdict["winning_outcome"]; confidence_score: number | string; caveats: string[] | null; thresholds_version: string | null; determination_basis: Verdict["determination_basis"] }

/**
 * What a commit bound: payload.committed (v2), or for v1 commits (before migration 012) the resolutions row plus the
 * canonical hash the v1 payload kept, with the v1 preimage (market uuid first). null when neither is readable. The
 * caller checks sha256(preimage) against the stored commitment before revealing anything.
 */
export function committedOf(commit: CommitRow, resolution: ResolutionFallback | null): CommittedVerdict | null {
  const parsed = CommittedVerdict.safeParse(commit.payload?.committed);
  if (parsed.success) return parsed.data;
  if (!resolution) return null;
  const raw = commit.payload?.evidence_raw_sha256;
  const canonical = commit.payload?.canonical_sha256;
  const fields: CommittedFields = {
    resolution_status: resolution.resolution_status,
    winning_outcome: resolution.winning_outcome,
    confidence_score: Number(resolution.confidence_score),
    caveats: resolution.caveats ?? [],
    canonical_sha256: typeof canonical === "string" ? canonical : null,
    raw_sha256: typeof raw === "string" && raw !== "n/a" ? raw : null,
    thresholds_version: resolution.thresholds_version ?? "",
    determination_basis: resolution.determination_basis,
  };
  if (!Number.isFinite(fields.confidence_score)) return null;
  return { preimage_version: "v1", preimage: buildPreimage(commit.market_id, fields, commit.nonce), ...fields };
}

/** Pure: the reveal post and the payload stored with it. The text alone is enough to recompute the commitment. */
export function buildReveal(m: Pick<MarketRow, "platform" | "external_id">, commit: Pick<CommitRow, "id" | "commitment_sha256" | "nonce">, committed: CommittedVerdict, official: OfficialRecord, agreement: Agreement): { text: string; payload: Record<string, unknown> } {
  const first = committed.preimage_version === "v2" ? "platform:external_id" : "internal market id (v1)";
  const off = official.outcome
    ? `official ${official.outcome}${official.label ? ` (${official.label})` : ""}${official.at ? ` at ${official.at} (${official.at_source ?? "unlabeled"})` : ""} -> ${agreement}`
    : `official none: the platform published no outcome within 21 days of the deadline -> ${agreement}`;
  const text = [
    `${marketTag(m)} | reveal`,
    `market ${marketRef(m)}`,
    `commitment sha256 ${commit.commitment_sha256}`,
    `preimage ${committed.preimage}`,
    `nonce ${commit.nonce}`,
    `format ${first}|status|outcome|confidence|caveats|canonical_sha256|thresholds_version|nonce`,
    `committed ${committed.resolution_status} ${committed.winning_outcome} confidence ${committed.confidence_score.toFixed(2)} caveats [${committed.caveats.join(",")}]`,
    off,
    ...(official.source_url ? [official.source_url] : []),
    "Check: sha256 of the text after \"preimage \" equals the commitment.",
    DISCLAIMER,
  ].join("\n");
  return { text, payload: { text, commit_id: commit.id, committed, official, agreement, post_attempts: 0 } };
}

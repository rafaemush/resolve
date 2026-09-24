/**
 * Commit-reveal for shadow verdicts (plan §10, §16.4 P2 step 1, §17.3 P2a).
 *
 * Commit: the bot_posts row is INSERTED FIRST (channel 'pending', unique dedup_key) with the commitment hash, the nonce
 * and the exact committed verdict (payload.committed), then posted, then only the delivery columns are filled
 * (migration 012's trigger lets exactly that transition through, once). A failed post leaves a pending row that
 * retryUnposted re-posts and the reconcile job alerts on after 15 minutes; a failed insert never becomes a public post.
 * Before 012 the post went first: a failed insert orphaned a public post and a failed post lost the commitment.
 *
 * Reveal: a reply to the commit that prints the full preimage and the nonce, so sha256(preimage) = commitment can be
 * recomputed from the post text alone. Preimage v2's first field is platform:external_id (printed on every post);
 * v1 used the internal market uuid, which nobody outside could see before the reveal.
 */
import { z } from "zod";
import type { Env } from "../env";
import { db, type Db } from "../db/supabase";
import { sha256Hex } from "../resolve/text";
import { sendMessage, telegramConfigured } from "./telegram";
import { ResolutionStatus, WinningOutcome, DeterminationBasis, type Verdict } from "../resolve/schema";
import type { MarketRow } from "../ingest/types";
import { alert } from "../ops/alerts";
import { redact } from "../ops/redact";
import { Budget, COST } from "../ops/budget";

export const DISCLAIMER = "Informational signal, not financial advice, not an oracle of record.";

/**
 * Public confidence floor (plan §17.3 P2a, §19.2 item 3). During the first 100 public commits (kind='commit' rows on
 * non-test markets), a Jev-route RESOLVED verdict whose published confidence is below 0.90 is committed as
 * UNRESOLVED/NONE with this caveat: one wrong public RESOLVED before n=100 is the most damaging event on the record, and
 * abstaining is never wrong on it. The resolutions row keeps the original verdict; payload.committed carries the
 * floored one, and reveal and reconcile read only payload.committed.
 */
export const PUBLIC_FLOOR = { confidence: 0.9, firstCommits: 100, caveat: "below_public_floor_0.90" } as const;

/** A pending commit younger than this may still have its first post attempt in flight; retryUnposted leaves it alone. */
export const RETRY_AFTER_S = 60;

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

/** Pure. publicCommitsSoFar = kind='commit' rows on non-test markets before this one. */
export function applyPublicFloor(c: CommittedFields, publicCommitsSoFar: number): CommittedFields {
  if (!floorCandidate(c) || publicCommitsSoFar >= PUBLIC_FLOOR.firstCommits) return c;
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

/** kind='commit' rows on non-test markets; null when the count could not be read. */
async function countPublicCommits(client: Db): Promise<number | null> {
  const { count, error } = await client.from("bot_posts").select("id, markets!inner(is_test)", { count: "exact", head: true }).eq("kind", "commit").eq("markets.is_test", false);
  return error || count === null ? null : count;
}

/** A pending bot_posts row as the delivery path needs it. */
export interface PendingPost { id: string; kind: "commit" | "reveal"; payload: Record<string, unknown> }

/**
 * Post a pending row and record the receipt (or the failure) on it. A post whose receipt cannot be saved leaves the row
 * pending, so a retry would post it again: that is alerted, never silent (a duplicate of the same commitment is
 * harmless to the record; a lost commitment is not).
 */
async function deliver(env: Env, client: Db, row: PendingPost, replyTo: number | null, budget: Budget | null): Promise<{ posted: boolean; error: string | null }> {
  const r = await sendMessage(env, String(row.payload.text ?? ""), { replyTo });
  if (r.ok) {
    const receipt = { channel: "telegram", message_id: r.message_id, telegram_date: r.date, posted_at: r.date, ...(row.kind === "reveal" ? { reply_to_message_id: replyTo } : {}) };
    const { error } = await client.from("bot_posts").update(receipt).eq("id", row.id).eq("channel", "pending");
    if (!error) return { posted: true, error: null };
    const text = `${row.kind} ${row.id} was posted (message ${r.message_id}) but its receipt was not saved: ${error.message}. The row is still pending; the next retry posts it again.`;
    if (!budget || budget.take(COST.alert)) await alert(env, `post_receipt_${row.id}`, text, { dedupMinutes: 60 });
    else console.error(JSON.stringify({ level: "error", job: "bot_post", error: redact(text) }));
    return { posted: true, error: `receipt not saved: ${error.message}` };
  }
  const postError = redact(r.error ?? "unknown").slice(0, 300);
  const payload = { ...row.payload, post_error: postError, post_attempts: Number(row.payload.post_attempts ?? 0) + 1 };
  const { error } = await client.from("bot_posts").update({ payload }).eq("id", row.id).eq("channel", "pending");
  if (error) console.error(JSON.stringify({ level: "error", job: "bot_post", id: row.id, error: redact(error.message) }));
  return { posted: false, error: postError };
}

/** A commit row as recorded: what the private early reveal (src/shadow/events.ts) sends to followers. */
export interface RecordedCommit { id: string; commitment_sha256: string; committed_at: string; committed: CommittedVerdict }

/**
 * Record the commit (INSERT first), then post it. Deduped per market + committed verdict signature by the unique
 * dedup_key. Test markets are recorded with channel 'none' and never posted. `commit` is set whenever a row was recorded.
 */
export async function commitVerdict(env: Env, market: MarketRow, resolutionId: string, v: Verdict): Promise<{ committed: boolean; posted: boolean; reason: string; commit?: RecordedCommit }> {
  const client = db(env);
  const isTest = market.is_test === true;
  let fields = committedFields(v);
  if (!isTest && floorCandidate(fields)) {
    // An unreadable count fails closed: the floor applies.
    fields = applyPublicFloor(fields, (await countPublicCommits(client)) ?? 0);
  }
  const signature = verdictSignature({ resolution_status: fields.resolution_status, winning_outcome: fields.winning_outcome, error_reason: fields.resolution_status === "ERROR" ? v.error_reason : null });
  const nonce = randomNonce();
  const preimage = buildPreimage(marketRef(market), fields, nonce);
  const commitment = await sha256Hex(preimage);
  const committed: CommittedVerdict = { preimage_version: "v2", preimage, ...fields };
  const payload = { text: commitText(market, commitment, fields.raw_sha256, new Date().toISOString()), verdict_signature: signature, evidence_raw_sha256: fields.raw_sha256, canonical_sha256: fields.canonical_sha256, committed, post_attempts: 0 };
  const { data: row, error } = await client.from("bot_posts").insert({
    resolution_id: resolutionId, market_id: market.id, channel: isTest ? "none" : "pending", kind: "commit", message_id: null, telegram_date: null, posted_at: null,
    commitment_sha256: commitment, nonce, payload, dedup_key: `commit:${market.id}:${signature}`,
  }).select("id, created_at").single();
  if (error?.code === "23505") return { committed: false, posted: false, reason: "already committed for this verdict signature" };
  if (error?.code === MARKET_NOT_OPEN_SQLSTATE) return { committed: false, posted: false, reason: `not committed: ${error.message}` };
  if (error || !row) {
    await alert(env, `commit_insert_${market.id}`, `commit for ${marketRef(market)} (resolution ${resolutionId}, ${signature}) was not recorded: ${error?.message ?? "no row"}. Nothing was posted.`, { dedupMinutes: 60 });
    return { committed: false, posted: false, reason: `bot_posts insert: ${error?.message ?? "no row"}` };
  }
  const commit: RecordedCommit = { id: row.id as string, commitment_sha256: commitment, committed_at: String(row.created_at), committed };
  if (isTest) return { committed: true, posted: false, reason: "test market: recorded, never posted", commit };
  if (!telegramConfigured(env)) return { committed: true, posted: false, reason: "pending: telegram not configured", commit };
  const d = await deliver(env, client, { id: commit.id, kind: "commit", payload }, null, null);
  return { committed: true, posted: d.posted, reason: d.posted ? "posted" : `pending: ${d.error}`, commit };
}

export interface PendingRow { id: string; kind: string; channel: string; created_at: string; payload: Record<string, unknown> }

/** Pure: commits still pending after RETRY_AFTER_S, oldest first, at most max. */
export function retryCandidates<T extends PendingRow>(rows: T[], nowMs: number, max: number): T[] {
  return rows
    .filter((r) => r.kind === "commit" && r.channel === "pending" && nowMs - Date.parse(r.created_at) >= RETRY_AFTER_S * 1000)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, max));
}

/** Re-post commits still pending after 60 s (bounded by max and the invocation's subrequest budget). */
export async function retryUnposted(env: Env, max = 5, budget: Budget = new Budget(COST.db + max * (COST.telegram + COST.db))): Promise<{ attempted: number; posted: number; failed: number; stopped: boolean }> {
  const out = { attempted: 0, posted: 0, failed: 0, stopped: false };
  if (!telegramConfigured(env) || max <= 0) return out;
  if (!budget.take(COST.db)) return { ...out, stopped: true };
  const client = db(env);
  const now = Date.now();
  const { data, error } = await client.from("bot_posts").select("id, kind, channel, created_at, payload").eq("kind", "commit").eq("channel", "pending")
    .lte("created_at", new Date(now - RETRY_AFTER_S * 1000).toISOString()).order("created_at", { ascending: true }).limit(max);
  if (error) { console.error(JSON.stringify({ level: "error", job: "retry_unposted", error: redact(error.message) })); return { ...out, failed: 1 }; }
  for (const row of retryCandidates((data ?? []) as PendingRow[], now, max)) {
    if (!budget.take(COST.telegram + COST.db)) { out.stopped = true; break; }
    out.attempted++;
    const d = await deliver(env, client, { id: row.id, kind: "commit", payload: row.payload }, null, budget);
    if (d.posted) out.posted++; else out.failed++;
  }
  return out;
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

/**
 * Post at most max pending reveals (oldest first) as replies to their commits. A reveal whose commit is itself still
 * pending waits: a reveal must never reach the channel before its commitment.
 */
export async function postPendingReveals(env: Env, budget: Budget, max = 5): Promise<{ posted: number; waiting: number; failed: number; stopped: boolean }> {
  const out = { posted: 0, waiting: 0, failed: 0, stopped: false };
  if (!telegramConfigured(env) || max <= 0) return out;
  if (!budget.take(COST.db)) return { ...out, stopped: true };
  const client = db(env);
  const { data, error } = await client.from("bot_posts").select("id, kind, channel, created_at, payload").eq("kind", "reveal").eq("channel", "pending").order("created_at", { ascending: true }).limit(max);
  if (error) { console.error(JSON.stringify({ level: "error", job: "reveals", error: redact(error.message) })); return { ...out, failed: 1 }; }
  const reveals = (data ?? []) as PendingRow[];
  if (!reveals.length) return out;
  if (!budget.take(COST.db)) return { ...out, stopped: true };
  const commitIds = [...new Set(reveals.map((r) => String(r.payload.commit_id ?? "")))].filter(Boolean);
  const { data: commits, error: ce } = await client.from("bot_posts").select("id, channel, message_id").in("id", commitIds);
  if (ce) { console.error(JSON.stringify({ level: "error", job: "reveals", error: redact(ce.message) })); return { ...out, failed: 1 }; }
  const byId = new Map((commits ?? []).map((c) => [c.id as string, c as { channel: string; message_id: number | null }]));
  for (const r of reveals) {
    const c = byId.get(String(r.payload.commit_id ?? ""));
    if (!c || c.channel !== "telegram" || !c.message_id) { out.waiting++; continue; }
    if (!budget.take(COST.telegram + COST.db)) { out.stopped = true; break; }
    const d = await deliver(env, client, { id: r.id, kind: "reveal", payload: r.payload }, c.message_id, budget);
    if (d.posted) out.posted++; else out.failed++;
  }
  return out;
}

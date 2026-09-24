/**
 * shadow.committed and shadow.revealed: the follower webhooks of the private early reveal (plan §17.3 P7-lite).
 * shadow.committed goes out right after a commit row exists (the verdict, its commitment hash and the evidence hashes,
 * never the preimage or the nonce); shadow.revealed goes out when the reconcile settles the market (official outcome,
 * agreement, and the preimage of every commit that is revealed publicly). Payload builders are pure.
 */
import type { Env } from "../env";
import { db } from "../db/supabase";
import { DISCLAIMER, marketRef, type Agreement, type CommittedFields, type CommittedVerdict, type OfficialRecord, type RecordedCommit } from "../bot/commit";
import type { MarketRow } from "../ingest/types";
import { alert } from "../ops/alerts";
import { COST } from "../ops/budget";
import { redact } from "../ops/redact";
import { deliverInline, enqueueEvent, type WaitUntil } from "../webhooks/deliver";
import { EARLY_REVEAL_LABEL, followerTenants, shadowVerdict } from "./follows";

type MarketRef = Pick<MarketRow, "id" | "platform" | "external_id">;
type Row = Record<string, unknown>;

/**
 * Queueing an event for a market's followers: the follows read, the endpoint read, the insert, and one alert when any
 * of them fails (the first failure stops it). Reconcile reserves this with each settle; the inline half
 * (inlineSubrequests(INLINE_MAX) = 1 + 2 x 4 + 5 = 14) runs on its own budget, or on what a reconcile run has left.
 * On the watch path the two halves add at most 3 + 14 = 17 to a run that, by count of src/ingest/watch.ts,
 * src/resolve/runtime.ts and src/bot/commit.ts, makes at most 26 subrequests on a web + Jev path before its alerts
 * (each alert 5 more; since migration 017 the commit takes 8: commit_context, insert, lease claim, send 3, receipt,
 * release, and 2 more after a dedup collision; 5 more when the page redirects WEB_MAX_REDIRECTS times, src/ingest/web.ts,
 * each hop a request of its own); a run that still hits Workers Free's 50 leaves its claimed rows 'delivering', and the drain's
 * stale sweep requeues them.
 */
export const QUEUE_SUBREQUESTS = 3 * COST.db + COST.alert;

/** Pure: the shadow.committed payload. The committed verdict is the one the commitment binds (after the public floor). */
export function shadowCommittedPayload(m: MarketRef, c: { commitment_sha256: string; committed_at: string; committed: CommittedFields }): Record<string, unknown> {
  return {
    market_id: m.id, platform: m.platform, external_id: m.external_id, market: marketRef(m),
    commitment_sha256: c.commitment_sha256, committed_at: c.committed_at,
    verdict: shadowVerdict(c.committed),
    evidence: { raw_sha256: c.committed.raw_sha256, canonical_sha256: c.committed.canonical_sha256 },
    label: EARLY_REVEAL_LABEL,
    disclaimer: DISCLAIMER,
  };
}

/** One commit of a settled market as shadow.revealed reports it; committed is null for a commit that cannot be revealed. */
export interface RevealedCommit { commitment_sha256: string; committed_at: string; agreement: Agreement; final: boolean; committed: CommittedVerdict | null }

/**
 * Pure: the shadow.revealed payload. agreement is the market's one public agreement (the final commit's). A commit
 * whose preimage does not hash to its commitment is never revealed (reconcile alerts it), so it carries no preimage.
 */
export function shadowRevealedPayload(m: MarketRef, official: OfficialRecord, commits: RevealedCommit[]): Record<string, unknown> {
  return {
    market_id: m.id, platform: m.platform, external_id: m.external_id, market: marketRef(m),
    official: { outcome: official.outcome, label: official.label, at: official.at, at_source: official.at_source, source_url: official.source_url },
    agreement: commits.find((c) => c.final)?.agreement ?? null,
    commits: commits.map((c) => ({
      commitment_sha256: c.commitment_sha256, committed_at: c.committed_at, agreement: c.agreement, final: c.final,
      revealed: c.committed !== null,
      verdict: c.committed ? shadowVerdict(c.committed) : null,
      preimage: c.committed?.preimage ?? null,
    })),
    how_to_verify: "sha256(preimage) = commitment_sha256; the preimage's last field is the nonce.",
    disclaimer: DISCLAIMER,
  };
}

export interface QueueResult { followers: number; rows: Row[]; error: string | null }

/**
 * Queue an event for every entitled follower of a market (followBlock: an ended evaluation or a follow above a lowered
 * plan's cap gets nothing; at most QUEUE_SUBREQUESTS). A follows read that failed drops the event, so it alerts; the
 * followers can still read the verdict at GET /v1/shadow/:market_id.
 */
export async function queueForFollowers(env: Env, m: MarketRef, eventType: "shadow.committed" | "shadow.revealed", payload: Record<string, unknown>): Promise<QueueResult> {
  const f = await followerTenants(db(env), m.id);
  if (f.error) {
    const error = redact(f.error).slice(0, 200);
    await alert(env, "shadow_followers_unreadable", `${eventType} for ${marketRef(m)} was not queued: the followers could not be read (${error}). Followers still read the verdict at GET /v1/shadow/${m.id}; the webhook is lost.`, { dedupMinutes: 60, meta: { market_id: m.id, event_type: eventType } });
    return { followers: 0, rows: [], error };
  }
  if (!f.tenants.length) return { followers: 0, rows: [], error: null };
  return { followers: f.tenants.length, rows: await enqueueEvent(env, f.tenants, eventType, payload), error: null };
}

/**
 * shadow.committed for every follower, right after the commit row exists, with the first attempt inline (under the
 * caller's waitUntil when it has one). Test markets and tenant markets have no followers by construction and are
 * skipped without a read. Never throws.
 */
export async function publishShadowCommitted(env: Env, market: MarketRow, commit: RecordedCommit, opts: { waitUntil?: WaitUntil } = {}): Promise<QueueResult> {
  if (market.is_test === true || market.tenant_id !== null) return { followers: 0, rows: [], error: null };
  try {
    const q = await queueForFollowers(env, market, "shadow.committed", shadowCommittedPayload(market, commit));
    await deliverInline(env, q.rows, { waitUntil: opts.waitUntil });
    return q;
  } catch (e) {
    const error = redact(String(e)).slice(0, 200);
    await alert(env, "shadow_followers_unreadable", `shadow.committed for ${marketRef(market)} (commitment ${commit.commitment_sha256}) threw before it was queued: ${error}. Followers still read it at GET /v1/shadow/${market.id}.`, { dedupMinutes: 60, meta: { market_id: market.id } });
    return { followers: 0, rows: [], error };
  }
}

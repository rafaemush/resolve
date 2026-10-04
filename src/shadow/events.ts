/**
 * shadow.committed and shadow.revealed: the follower webhooks of the private early reveal (plan §17.3 P7-lite).
 * shadow.committed goes out right after a commit row exists (the verdict, its commitment hash and the evidence hashes,
 * never the preimage or the nonce); shadow.revealed goes out when the reconcile settles the market (official outcome,
 * agreement, and the preimage of every commit that is revealed publicly). Both carry a `venue` object in the platform's
 * own identifiers (src/shadow/venue.ts: Limitless slug, conditionId and a proposed winningOutcomeIndex; Polymarket
 * conditionId, slug, event id and the proposed outcome label), proposed only for a RESOLVED commit. Payload builders
 * are pure.
 */
import type { Env } from "../env";
import { db } from "../db/supabase";
import { DISCLAIMER, marketRef, type Agreement, type CommittedFields, type CommittedVerdict, type OfficialRecord, type RecordedCommit } from "../bot/commit";
import type { MarketRow } from "../ingest/types";
import { alert, alertMany, type AlertItem } from "../ops/alerts";
import { COST, type Budget } from "../ops/budget";
import { redact } from "../ops/redact";
import { crossingItems, type Crossing } from "../billing/events";
import { publicBase, topUp, type TopUp } from "../billing/top-up";
import { deliverInline, enqueueEvent, insertEvents, readEndpoints, subscribes, type EventItem, type WaitUntil } from "../webhooks/deliver";
import { EARLY_REVEAL_LABEL, entitledFollowers, followerTenants, shadowVerdict } from "./follows";
import { lockedReveal, revealAccess, revealDueAt, revealEntitlements, revealPriority, revealRequestId, type LockedReveal, type RevealAccess, type RevealAnswer } from "./reveal";
import { venuePayload, type VenueMarket } from "./venue";

type MarketRef = Pick<MarketRow, "id" | "platform" | "external_id">;
/** What a payload names: the market, and the options and platform identifiers its venue object is built from. */
export type PayloadMarket = MarketRef & VenueMarket;
type Row = Record<string, unknown>;

/**
 * Queueing shadow.revealed for a market's followers (queueForFollowers): the follows read, the endpoint read, the insert,
 * and one alert when any of them fails (the first failure stops it). Reconcile reserves this with each settle; the inline
 * half (inlineSubrequests(INLINE_MAX) = 1 + 2 x 4 + 5 = 14) runs on its own budget, or on what a reconcile run has left.
 */
export const QUEUE_SUBREQUESTS = 3 * COST.db + COST.alert;

/**
 * Queueing a priced shadow.committed (publishShadowCommitted, since migration 023): the follows read, the endpoint read
 * (before any charge: only a follower with a subscribed endpoint is charged at publish), one charge_reveals() call for
 * every such follower whatever their number (none for a verdict that is not RESOLVED), the insert (the events, with the
 * credits.low of every crossing the charge claimed), and one alertMany() that carries every alert of the publish (the
 * followers or endpoints unreadable, billing unavailable, the insert failed, each credits.low crossing for the operator).
 * When rows were queued, those alerts ride in the inline attempt's own alertMany() (deliverInline's alerts): the publish
 * and its inline half spend at most 4 + inlineSubrequests(INLINE_MAX) = 4 + 1 + 2 x 4 + 5 = 18 together, alerts
 * included; when nothing was queued, 4 + 5 = 9. On the watch path that is added to a run that, by count of
 * src/ingest/watch.ts, src/resolve/runtime.ts and src/bot/commit.ts, makes at most 26 subrequests on a web + Jev path
 * before its alerts (each alert 5 more; since migration 017 the commit takes 8: commit_context, insert, lease claim, send
 * 3, receipt, release, and 2 more after a dedup collision), and 31 when the page redirects WEB_MAX_REDIRECTS times
 * (src/ingest/web.ts, each hop a request of its own): 31 + 18 = 49 of Workers Free's 50, with no room for an alert of
 * the run's own. A run that still goes over fails its last subrequests (the inline attempts under waitUntil): a claimed
 * row stays 'delivering' until the drain's stale sweep requeues it, and a paid reveal not attempted within
 * REVEAL_LATE_MINUTES is refunded by refund_late_reveals(). The charge itself is one transaction: it stands or nothing
 * is charged.
 */
export const COMMITTED_QUEUE_SUBREQUESTS = 4 * COST.db + COST.alert;

/**
 * Pure: the shadow.committed payload. The committed verdict is the one the commitment binds (after the public floor);
 * the venue object proposes that verdict in the platform's identifiers (null proposal unless it is RESOLVED). `reveal`
 * says why this tenant receives it and what it was charged (src/shadow/reveal.ts); with `locked` (a RESOLVED verdict the
 * tenant has not paid for) the payload keeps the market, the commitment, the evidence hashes and the venue identifiers,
 * and carries verdict null, a venue object that proposes nothing, and the locked object (price, balance, top_up).
 */
export function shadowCommittedPayload(m: PayloadMarket, c: { commitment_sha256: string; committed_at: string; committed: CommittedFields }, reveal: RevealAccess | null = null, locked: LockedReveal | null = null): Record<string, unknown> {
  const open = locked === null;
  return {
    market_id: m.id, platform: m.platform, external_id: m.external_id, market: marketRef(m),
    commitment_sha256: c.commitment_sha256, committed_at: c.committed_at,
    verdict: open ? shadowVerdict(c.committed) : null,
    evidence: { raw_sha256: c.committed.raw_sha256, canonical_sha256: c.committed.canonical_sha256 },
    venue: venuePayload(m, open ? c.committed : null),
    reveal,
    locked,
    label: EARLY_REVEAL_LABEL,
    disclaimer: DISCLAIMER,
  };
}

/** One follower's shadow.committed as queued: the payload, its delivery priority, and the charge it carries (or null). */
export interface RevealItem { tenant: string; payload: Record<string, unknown>; priority: number; revealCharge: { requestId: string; dueAt: string } | null }

/**
 * Pure. Each follower's shadow.committed from its reveal answer: the verdict, or the locked payload with the card pointer
 * `top`. A charge taken now (not a replay) rides on every delivery of the event with its refund deadline (committed_at +
 * REVEAL_LATE_MINUTES). Payloads that say the same thing are one object (one hash for all of them).
 */
export function revealItems(m: PayloadMarket, c: { commitment_sha256: string; committed_at: string; committed: CommittedFields }, answers: readonly RevealAnswer[], top: TopUp): RevealItem[] {
  const shared = new Map<string, Record<string, unknown>>();
  return answers.map((a) => {
    const locked = lockedReveal(a, top, m.id);
    const access = revealAccess(a);
    const key = locked ? null : `${access.reason}|${access.credits_charged}|${access.replayed}`;
    const payload = (key && shared.get(key)) || shadowCommittedPayload(m, c, access, locked);
    if (key) shared.set(key, payload);
    return {
      tenant: a.tenant_id, payload, priority: revealPriority(a),
      revealCharge: a.charged > 0 && !a.replayed && !locked ? { requestId: revealRequestId(a.tenant_id, m.id), dueAt: revealDueAt(c.committed_at) } : null,
    };
  });
}

/** One commit of a settled market as shadow.revealed reports it; committed is null for a commit that cannot be revealed. */
export interface RevealedCommit { commitment_sha256: string; committed_at: string; agreement: Agreement; final: boolean; committed: CommittedVerdict | null }

/**
 * Pure: the shadow.revealed payload. agreement is the market's one public agreement (the final commit's), and the venue
 * object proposes the final commit's verdict. A commit whose preimage does not hash to its commitment is never revealed
 * (reconcile alerts it), so it carries no preimage, no verdict, no evidence hashes and no proposal.
 */
export function shadowRevealedPayload(m: PayloadMarket, official: OfficialRecord, commits: RevealedCommit[]): Record<string, unknown> {
  const final = commits.find((c) => c.final) ?? null;
  return {
    market_id: m.id, platform: m.platform, external_id: m.external_id, market: marketRef(m),
    official: { outcome: official.outcome, label: official.label, at: official.at, at_source: official.at_source, source_url: official.source_url },
    agreement: final?.agreement ?? null,
    venue: venuePayload(m, final?.committed ?? null),
    commits: commits.map((c) => ({
      commitment_sha256: c.commitment_sha256, committed_at: c.committed_at, agreement: c.agreement, final: c.final,
      revealed: c.committed !== null,
      verdict: c.committed ? shadowVerdict(c.committed) : null,
      evidence: c.committed ? { raw_sha256: c.committed.raw_sha256, canonical_sha256: c.committed.canonical_sha256 } : null,
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

export interface PublishResult extends QueueResult { charged: number; locked: number }

/**
 * shadow.committed for every entitled follower with a subscribed endpoint, right after the commit row exists, with the
 * first attempts inline (under the caller's waitUntil when it has one; paid reveals first). A RESOLVED verdict is priced:
 * one charge_reveals() call for all of them (src/shadow/reveal.ts), the verdict to those it releases it to, a locked
 * payload to the rest. When that call fails, nothing is released free and nothing is dropped: included plans get the
 * verdict, every other follower a locked payload with reason billing_unavailable, and the operator one alert. A
 * follower without a subscribed endpoint is not charged here: its first read is. Test markets and tenant markets have no
 * followers by construction and are skipped without a read. At most COMMITTED_QUEUE_SUBREQUESTS before the inline
 * attempt, which runs on opts.budget when given (the inline commit of an official release: what its invocation's
 * reservation leaves, src/ingest/official-watch.ts inlinePlan; whole deliveries only, the rest left to the drain), else
 * on its own inlineSubrequests(INLINE_MAX). Never throws.
 */
export async function publishShadowCommitted(env: Env, market: MarketRow, commit: RecordedCommit, opts: { waitUntil?: WaitUntil; base?: string | null; budget?: Budget } = {}): Promise<PublishResult> {
  const none: PublishResult = { followers: 0, rows: [], error: null, charged: 0, locked: 0 };
  if (market.is_test === true || market.tenant_id !== null) return none;
  const alerts: AlertItem[] = [];
  const out: PublishResult = { ...none };
  try {
    const client = db(env);
    const f = await entitledFollowers(client, market.id);
    if (f.error) {
      out.error = redact(f.error).slice(0, 200);
      alerts.push({ key: "shadow_followers_unreadable", dedupMinutes: 60, meta: { market_id: market.id, event_type: "shadow.committed" }, text: `shadow.committed for ${marketRef(market)} was not queued: the followers could not be read (${out.error}). Followers still read the verdict at GET /v1/shadow/${market.id}; the webhook is lost.` });
      return out;
    }
    out.followers = f.followers.length;
    if (!f.followers.length) return out;
    // the endpoints before the charge: a follower that cannot receive the webhook is charged by its first read instead
    const eps = await readEndpoints(env, f.followers.map((x) => x.tenant_id));
    if (eps.error) {
      out.error = eps.error;
      alerts.push({ key: "webhook_enqueue_failed", dedupMinutes: 60, meta: { market_id: market.id, event_type: "shadow.committed" }, text: `shadow.committed for ${marketRef(market)} (commitment ${commit.commitment_sha256}) was not queued for ${f.followers.length} follower(s): ${eps.error}. Nothing was charged; followers still read it at GET /v1/shadow/${market.id} (charged then).` });
      return out;
    }
    const hooked = f.followers.filter((x) => eps.endpoints.some((e) => e.tenant_id === x.tenant_id && subscribes(e, "shadow.committed")));
    if (!hooked.length) return out;
    const resolved = commit.committed.resolution_status === "RESOLVED";
    const ent = await revealEntitlements(client, hooked.map((x) => ({ tenant_id: x.tenant_id, market_id: market.id, plan: x.plan })), { resolved, source: "webhook" });
    if (ent.error) alerts.push({ key: "shadow_reveal_billing_unavailable", dedupMinutes: 60, meta: { market_id: market.id, commitment_sha256: commit.commitment_sha256 }, text: `charge_reveals failed for ${marketRef(market)} (commitment ${commit.commitment_sha256}): ${ent.error}. Included plans received the verdict; ${ent.answers.filter((a) => a.reason === "billing_unavailable").length} other follower(s) received a locked shadow.committed (reason billing_unavailable) and were not charged. They are charged and receive it on their next read of GET /v1/shadow/${market.id} once billing answers. Check the charge_reveals RPC (migration 023).` });
    const base = opts.base !== undefined ? opts.base : publicBase(env);
    const top = topUp(env, base);
    const items: EventItem[] = revealItems(market, commit, ent.answers, top).map((i) => ({ tenant: i.tenant, eventType: "shadow.committed", payload: i.payload, priority: i.priority, revealCharge: i.revealCharge }));
    out.charged = ent.answers.reduce((n, a) => n + a.charged, 0);
    out.locked = items.filter((i) => (i.payload as { locked?: unknown }).locked).length;
    // credits.low for every crossing the charge claimed, in the same insert; the operator hears of each in the one alertMany
    const crossings: Crossing[] = ent.answers.filter((a) => a.low_credit === true && a.low_credit_threshold !== null && a.balance !== null)
      .map((a) => ({ tenantId: a.tenant_id, plan: a.plan, balance: a.balance!, threshold: a.low_credit_threshold!, requestId: revealRequestId(a.tenant_id, market.id) }));
    const low = crossingItems(crossings, top);
    const unclaimed = ent.answers.filter((a) => a.charged > 0 && a.low_credit === null);
    if (unclaimed.length) alerts.push({ key: "low_credit_check_failed", dedupMinutes: 60, meta: { market_id: market.id, tenant_ids: unclaimed.map((a) => a.tenant_id).slice(0, 20) }, text: `charge_reveals charged ${unclaimed.length} follower(s) for ${marketRef(market)} but could not claim their low-credit notice (is app_config low_credit_threshold a whole number?); credits.low waits for their next charge. Tenants: ${unclaimed.map((a) => a.tenant_id).slice(0, 20).join(", ")}` });
    const q = await insertEvents(env, eps.endpoints, [...items, ...low.events]);
    if (q.error) {
      out.error = q.error;
      alerts.push({ key: "webhook_enqueue_failed", dedupMinutes: 60, meta: { market_id: market.id, event_type: "shadow.committed", charged: out.charged }, text: `shadow.committed for ${marketRef(market)} (commitment ${commit.commitment_sha256}) was not queued for ${hooked.length} follower(s): ${q.error}. ${out.charged > 0 ? `${out.charged} credit(s) were charged; refund_late_reveals refunds them ${REVEAL_REFUND_NOTE}. ` : ""}Followers still read it at GET /v1/shadow/${market.id}.${crossings.length ? ` The low-credit notice of ${crossings.length} tenant(s) stays claimed (no credits.low until their next purchase or grant).` : ""}` });
    } else alerts.push(...low.alerts);
    out.rows = q.rows;
    // the publish's alerts ride in the inline attempt's one alertMany() (sent on their own when nothing was queued)
    const handed = alerts.splice(0);
    await deliverInline(env, q.rows, { waitUntil: opts.waitUntil, alerts: handed, ...(opts.budget ? { budget: opts.budget } : {}) });
    return out;
  } catch (e) {
    const error = redact(String(e)).slice(0, 200);
    alerts.push({ key: "shadow_followers_unreadable", dedupMinutes: 60, meta: { market_id: market.id }, text: `shadow.committed for ${marketRef(market)} (commitment ${commit.commitment_sha256}) threw before it was queued: ${error}. Followers still read it at GET /v1/shadow/${market.id}. A charge it took stands in the ledger and is refunded by refund_late_reveals ${REVEAL_REFUND_NOTE}.` });
    return { ...out, rows: [], error };
  } finally {
    // alertMany never throws; one call carries every alert of the publish not handed to the inline attempt
    if (alerts.length) await alertMany(env, alerts);
  }
}

/** When refund_late_reveals() (migration 023, every 5 minutes) refunds a webhook charge that was never delivered. */
const REVEAL_REFUND_NOTE = "within 15 minutes of the commit (no delivery carries the charge)";

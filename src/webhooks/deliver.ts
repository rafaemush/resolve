/**
 * Outbound webhooks: HMAC-signed, capped backoff (0s,60s,5m,30m,2h,12h,24h), DLQ, replay.
 *
 * First attempt inline (plan §18 (a)): the publisher queues the rows, claims them exactly as claim_webhook_deliveries()
 * does (status 'delivering' + a 60 s lease, only while still 'pending'), and attempts them at once, under the request's
 * waitUntil when it has one. The 5-minute drain is the retry path: it only ever claims 'pending' rows, so a row claimed
 * inline is never delivered twice by the two, and a row an inline attempt never finished is requeued by its stale sweep.
 */
import type { Env } from "../env";
import { db, rpc, type Db } from "../db/supabase";
import { hmacHex, sha256Hex } from "../resolve/text";
import { alert, alertMany, type AlertItem } from "../ops/alerts";
import { Budget, COST } from "../ops/budget";
import { redact } from "../ops/redact";
import { publicEventPayload } from "../api/public-names";

/**
 * Every event a tenant endpoint can subscribe to (POST /v1/webhooks). An endpoint registered without an events list gets
 * all of them; webhook_endpoints.events keeps its SQL default (migration 009) for rows written any other way.
 */
export const WEBHOOK_EVENTS = ["market.resolved", "market.unresolved_update", "market.error", "credits.low", "payment.credited", "shadow.committed", "shadow.revealed"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * Pure. Whether an endpoint receives this event: it is in the endpoint's registered events. One rule for the queue and
 * for the follow route's endpoints_subscribed count, so the count says exactly what enqueueEvent will do.
 */
export const subscribes = (e: { events: string[] | null }, eventType: WebhookEvent): boolean => (e.events ?? []).includes(eventType);

const BACKOFF_S = [0, 60, 300, 1800, 7200, 43200, 86400];
export const MAX_ATTEMPTS = BACKOFF_S.length;
/** Deliveries per scheduled drain (the 5-minute cron, src/jobs/schedule.ts). */
export const DRAIN_MAX = 5;
/** Worst case of one delivery: endpoint read, the POST, the delivery update, the endpoint update. */
export const DELIVERY_COST = 3 * COST.db + COST.http;
/**
 * claim_webhook_deliveries() takes only 'pending' rows, so a row whose claiming run died before writing an outcome
 * (CPU limit, isolate eviction, a call that hung) would never be delivered. The drain requeues a 'delivering' row whose
 * 60 s lease expired this long ago: far past any healthy run (a drain claims at most 10 rows, each POST capped at 10 s).
 * A run still alive that late costs one duplicate delivery, which the receiver drops by X-Resolve-Event-Id.
 */
export const STALE_DELIVERING_MINUTES = 15;
/** The drain's budget: the stale sweep, the claim, `max` deliveries and one alertMany() that carries every alert of the run. */
export const drainSubrequests = (max: number): number => 2 * COST.db + max * DELIVERY_COST + COST.alert;
/** A dead endpoint DLQs one delivery per event; one DM per endpoint per 6 h is enough to act on. */
export const DLQ_DEDUP_MINUTES = 360;

/** Inline first attempts per publish; queued rows beyond them wait for the drain (at most 5 minutes). */
export const INLINE_MAX = 2;
/** claim_webhook_deliveries()'s lease (migration 009): an inline claim holds a row exactly as long as the drain's would. */
export const LEASE_SECONDS = 60;
/** One inline attempt of n rows: the claim, n deliveries, one alertMany() for everything it raises. */
export const inlineSubrequests = (n: number): number => COST.db + n * DELIVERY_COST + COST.alert;
/** A caller without waitUntil waits this long for its inline attempt: one POST timeout (10 s) plus its writes. */
export const INLINE_AWAIT_MS = 12_000;

/** ExecutionContext.waitUntil of the invocation that publishes: work under it outlives the response. */
export type WaitUntil = (p: Promise<unknown>) => void;

type Row = Record<string, unknown>;

/** One event for one tenant (queueEvents). */
export interface EventItem { tenant: string; eventType: WebhookEvent; payload: Record<string, unknown> }
/** Queued rows, or why nothing was queued. "No subscribed endpoint" is not an error: rows [] and error null. */
export interface QueueOutcome { rows: Row[]; error: string | null }

/**
 * Queue events in one endpoint read and one insert whatever their number: one delivery ('pending', attempt 0) per event
 * and active endpoint of its tenant that subscribes to its type. No alert of its own, for a job that carries every alert
 * of its run in one alertMany() (the deposit scan); enqueueEvent is the alerting form. At most 2 subrequests.
 */
export async function queueEvents(env: Env, items: readonly EventItem[]): Promise<QueueOutcome> {
  const tenants = [...new Set(items.map((i) => i.tenant))];
  if (!tenants.length) return { rows: [], error: null };
  const client = db(env);
  const { data: eps, error: readError } = await client.from("webhook_endpoints").select("id, tenant_id, events").in("tenant_id", tenants).eq("active", true).is("deleted_at", null);
  if (readError) return { rows: [], error: `the endpoint read failed (${redact(readError.message)})` };
  const endpoints = (eps ?? []) as Array<{ id: string; tenant_id: string; events: string[] | null }>;
  const rows: Row[] = [];
  const shas = new Map<Record<string, unknown>, string>(); // one hash per payload: enqueueEvent fans one out to many tenants
  for (const i of items) {
    const targets = endpoints.filter((e) => e.tenant_id === i.tenant && subscribes(e, i.eventType));
    if (!targets.length) continue;
    const sha = shas.get(i.payload) ?? await sha256Hex(JSON.stringify(i.payload));
    shas.set(i.payload, sha);
    for (const e of targets) rows.push({ endpoint_id: e.id, tenant_id: e.tenant_id, event_type: i.eventType, payload: i.payload, payload_sha256: sha, status: "pending", attempt: 0 });
  }
  if (!rows.length) return { rows: [], error: null };
  const { data, error } = await client.from("webhook_deliveries").insert(rows).select("*");
  if (error) return { rows: [], error: `the insert of ${rows.length} deliver${rows.length === 1 ? "y" : "ies"} failed (${redact(error.message)})` };
  return { rows: (data ?? []) as Row[], error: null };
}

/**
 * Queue one delivery per active endpoint of these tenants that subscribes to the event; returns the inserted rows
 * ('pending', attempt 0). "No subscribed endpoint" and "could not read the endpoints" differ: the second drops the
 * event, so it alerts, as does a failed insert. At most 2 subrequests, plus an alert on failure.
 */
export async function enqueueEvent(env: Env, tenants: string | readonly string[], eventType: WebhookEvent, payload: Record<string, unknown>): Promise<Row[]> {
  const ids = [...new Set(typeof tenants === "string" ? [tenants] : tenants)];
  const q = await queueEvents(env, ids.map((tenant) => ({ tenant, eventType, payload })));
  if (q.error) {
    const who = ids.length === 1 ? `tenant ${ids[0]}` : `${ids.length} tenants`;
    await alert(env, "webhook_enqueue_failed", `${eventType} for ${who} was not queued: ${q.error}. The event is lost unless it is re-emitted.`, { dedupMinutes: 60, meta: { tenant_ids: ids.slice(0, 20), event_type: eventType } });
  }
  return q.rows;
}

export interface DrainSummary { requeued: number; claimed: number; delivered: number; failed: number; dlq: number; errors: number; claim_error: string | null; alerts: string[] }
export interface Dlq { endpoint: string; tenant: string; delivery: string; reason: string }

/** One alert per endpoint that DLQ'd deliveries this run (key webhook_dlq_<endpoint_id>). Pure. */
export function dlqAlerts(dlqs: Dlq[]): AlertItem[] {
  const by = new Map<string, Dlq[]>();
  for (const d of dlqs) by.set(d.endpoint, [...(by.get(d.endpoint) ?? []), d]);
  return [...by.entries()].map(([endpoint, ds]) => ({
    key: `webhook_dlq_${endpoint}`,
    dedupMinutes: DLQ_DEDUP_MINUTES,
    text: `${ds.length} webhook deliver${ds.length === 1 ? "y" : "ies"} to endpoint ${endpoint} (tenant ${ds[0]!.tenant}) moved to dlq: ${ds[0]!.reason}. The tenant receives nothing for these events until they are replayed (POST /v1/webhooks/deliveries/:id/replay). Deliveries: ${ds.map((d) => d.delivery).join(", ")}`,
    meta: { endpoint_id: endpoint, tenant_id: ds[0]!.tenant, deliveries: ds.map((d) => d.delivery) },
  }));
}

/**
 * How one claimed delivery ended. released = handed back 'pending' at the same attempt (the endpoint could not be read,
 * or the attempt threw before an outcome was written): not a failure of the endpoint. problems = writes that failed.
 */
export interface DeliveryResult { id: string; outcome: "delivered" | "retry" | "dlq" | "released"; dlq: Dlq | null; problems: string[] }

/** Tally of a batch of DeliveryResults, shared by the drain and the inline path. */
interface Tally { delivered: number; failed: number; dlq: number; errors: number; dlqs: Dlq[]; problems: string[] }
const newTally = (): Tally => ({ delivered: 0, failed: 0, dlq: 0, errors: 0, dlqs: [], problems: [] });
function count(t: Tally, r: DeliveryResult): void {
  switch (r.outcome) {
    case "delivered": t.delivered++; break;
    case "retry": t.failed++; break;
    case "dlq": t.dlq++; if (r.dlq) t.dlqs.push(r.dlq); break;
    case "released": break;
    default: { const never: never = r.outcome; throw new Error(`unhandled delivery outcome ${String(never)}`); }
  }
  t.errors += r.problems.length;
  t.problems.push(...r.problems);
}

/**
 * Requeues stale 'delivering' rows (STALE_DELIVERING_MINUTES), then claims only what the budget can finish, so a row
 * this run claims is never left for the sweep. Every alert of the run (DLQ per endpoint, requeued rows, claim and
 * bookkeeping failures) goes out in one alertMany() reserved before the sweep.
 */
export async function drainWebhooks(env: Env, max = 10, budget: Budget = new Budget(drainSubrequests(max))): Promise<DrainSummary> {
  const client = db(env);
  const out: DrainSummary = { requeued: 0, claimed: 0, delivered: 0, failed: 0, dlq: 0, errors: 0, claim_error: null, alerts: [] };
  const t = newTally();
  const fixed = 2 * COST.db + COST.alert;
  if (!budget.take(fixed)) return out;
  const n = Math.min(max, Math.floor(budget.left / DELIVERY_COST));
  if (n < 1 || !budget.take(n * DELIVERY_COST)) { budget.release(fixed); return out; }

  // Before the claim, so a requeued row is delivered by this same run.
  const requeued = await requeueStale(client, t);
  out.requeued = requeued.length;
  let rows: Row[] = [];
  try { rows = await rpc<Row[]>(client, "claim_webhook_deliveries", { p_max: n }); }
  catch (e) { out.claim_error = redact(String(e)).slice(0, 300); }
  for (const d of rows) {
    out.claimed++;
    count(t, await deliverOne(client, d));
  }
  Object.assign(out, { delivered: t.delivered, failed: t.failed, dlq: t.dlq, errors: t.errors });

  const items = dlqAlerts(t.dlqs);
  if (requeued.length) items.push({ key: "webhook_stuck_delivering", dedupMinutes: 60, meta: { deliveries: requeued }, text: `${requeued.length} webhook deliver${requeued.length === 1 ? "y was" : "ies were"} still 'delivering' ${STALE_DELIVERING_MINUTES} min after the lease expired: the run that claimed ${requeued.length === 1 ? "it" : "them"} died before writing an outcome (CPU limit, eviction or a hung call). Requeued as 'pending' at the same attempt, so the tenant gets the event now (receivers drop duplicates by X-Resolve-Event-Id). The same ids alerting again means the delivery itself kills the drain: move it to dlq by hand. Deliveries: ${requeued.slice(0, 20).join(", ")}` });
  if (out.claim_error) items.push({ key: "webhook_claim_failed", dedupMinutes: 60, text: `claim_webhook_deliveries failed; no webhook is being delivered until it recovers: ${out.claim_error}` });
  if (t.problems.length) items.push({ key: "webhook_drain_errors", dedupMinutes: 60, text: `${t.problems.length} webhook drain step(s) failed. A delivery left in 'delivering' is requeued by the drain ${STALE_DELIVERING_MINUTES} min after its lease expired. ${t.problems.slice(0, 5).join("; ")}` });
  if (items.length) { await alertMany(env, items); out.alerts = items.map((i) => i.key); }
  else budget.release(COST.alert);
  return out;
}

/** 'delivering' rows whose lease expired STALE_DELIVERING_MINUTES ago go back to 'pending' (one UPDATE); their ids. */
async function requeueStale(client: Db, t: Tally): Promise<string[]> {
  const cutoff = new Date(Date.now() - STALE_DELIVERING_MINUTES * 60_000).toISOString();
  const { data, error } = await client.from("webhook_deliveries")
    .update({ status: "pending", lease_until: null, last_error: `requeued: still 'delivering' ${STALE_DELIVERING_MINUTES} min after its lease expired` })
    .eq("status", "delivering").lt("lease_until", cutoff).select("id");
  if (error) { t.errors++; t.problems.push(`stale 'delivering' sweep: ${redact(error.message)}`); return []; }
  return ((data ?? []) as Array<{ id: unknown }>).map((r) => String(r.id));
}

async function write(r: DeliveryResult, what: string, q: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await q;
  if (error) r.problems.push(`${what}: ${redact(error.message)}`);
}

/**
 * Attempt one delivery the caller has claimed ('delivering' + lease: the drain through claim_webhook_deliveries, the
 * inline path through claimForInline) and write its outcome. At most DELIVERY_COST subrequests. Never throws: an
 * attempt that throws before its outcome is written hands the row back 'pending' at the same attempt, since a row left
 * 'delivering' would wait STALE_DELIVERING_MINUTES for the sweep.
 */
export async function deliverOne(client: Db, d: Row): Promise<DeliveryResult> {
  const r: DeliveryResult = { id: String(d.id), outcome: "released", dlq: null, problems: [] };
  const state = { settled: false };
  try { await attempt(client, d, r, state); }
  catch (e) {
    r.problems.push(`delivery ${r.id}: ${redact(String(e)).slice(0, 200)}`);
    if (!state.settled) { r.outcome = "released"; await write(r, `delivery ${r.id} release`, client.from("webhook_deliveries").update({ status: "pending", lease_until: null }).eq("id", r.id)); }
  }
  return r;
}

/** deliverOne's body. `state.settled` turns true once the outcome write is under way. */
async function attempt(client: Db, d: Row, r: DeliveryResult, state: { settled: boolean }): Promise<void> {
  const id = r.id, endpointId = String(d.endpoint_id);
  const { data: ep, error: epError } = await client.from("webhook_endpoints").select("url, secret, active, deleted_at, consecutive_failures").eq("id", endpointId).maybeSingle();
  if (epError) {
    // Could not look at the endpoint: hand the row back at the same attempt instead of calling the endpoint dead.
    r.problems.push(`endpoint ${endpointId} read: ${redact(epError.message)}`);
    state.settled = true;
    await write(r, `delivery ${id} release`, client.from("webhook_deliveries").update({ status: "pending", lease_until: null }).eq("id", id));
    return;
  }
  const attemptNo = Number(d.attempt) + 1;
  if (!ep || !ep.active || ep.deleted_at) {
    state.settled = true;
    r.outcome = "dlq";
    r.dlq = { endpoint: endpointId, tenant: String(d.tenant_id), delivery: id, reason: "endpoint inactive or deleted" };
    await write(r, `delivery ${id} dlq`, client.from("webhook_deliveries").update({ status: "dlq", attempt: attemptNo, last_error: "endpoint inactive", lease_until: null }).eq("id", id));
    return;
  }
  // A market.* or shadow.* payload queued before the public names keeps its stored form (stored values never change): it
  // is sent, and re-sent on every retry and replay, in the public shape (src/api/public-names.ts). Idempotent for newer rows.
  const body = JSON.stringify({ id: d.event_id, type: d.event_type, created_at: d.created_at, data: publicEventPayload(String(d.event_type), d.payload) });
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacHex(ep.secret as string, `${t}.${body}`);
  let status: number | null = null, err: string | null = null;
  try {
    const res = await fetch(ep.url as string, { method: "POST", headers: { "Content-Type": "application/json", "X-Resolve-Signature": `t=${t},v1=${sig}`, "X-Resolve-Event-Id": String(d.event_id), "X-Resolve-Event-Type": String(d.event_type), "X-Resolve-Delivery-Attempt": String(attemptNo), "User-Agent": "ResolveWebhooks/1.0" }, body, signal: AbortSignal.timeout(10_000) });
    status = res.status;
    if (!res.ok) err = `HTTP ${res.status}`;
  } catch (e) { err = String(e).slice(0, 200); }
  state.settled = true;
  if (!err) {
    r.outcome = "delivered";
    await write(r, `delivery ${id} delivered`, client.from("webhook_deliveries").update({ status: "delivered", attempt: attemptNo, last_status_code: status, last_error: null, delivered_at: new Date().toISOString(), lease_until: null }).eq("id", id));
    await write(r, `endpoint ${endpointId} reset`, client.from("webhook_endpoints").update({ consecutive_failures: 0 }).eq("id", endpointId));
  } else if (attemptNo >= MAX_ATTEMPTS) {
    r.outcome = "dlq";
    r.dlq = { endpoint: endpointId, tenant: String(d.tenant_id), delivery: id, reason: `${MAX_ATTEMPTS} attempts failed, last: ${err}` };
    await write(r, `delivery ${id} dlq`, client.from("webhook_deliveries").update({ status: "dlq", attempt: attemptNo, last_status_code: status, last_error: err, lease_until: null }).eq("id", id));
    await write(r, `endpoint ${endpointId} failures`, client.from("webhook_endpoints").update({ consecutive_failures: Number(ep.consecutive_failures) + 1 }).eq("id", endpointId));
  } else {
    r.outcome = "retry";
    const next = new Date(Date.now() + (BACKOFF_S[attemptNo] ?? 86400) * 1000).toISOString();
    await write(r, `delivery ${id} retry`, client.from("webhook_deliveries").update({ status: "pending", attempt: attemptNo, last_status_code: status, last_error: err, next_attempt_at: next, lease_until: null }).eq("id", id));
    await write(r, `endpoint ${endpointId} failures`, client.from("webhook_endpoints").update({ consecutive_failures: Number(ep.consecutive_failures) + 1 }).eq("id", endpointId));
  }
}

// ---- inline first attempt (plan §18 (a)) -------------------------------------------------------------------------

/** Pure: the claim claim_webhook_deliveries() writes: status 'delivering' and a LEASE_SECONDS lease from now. */
export function claimPatch(nowMs: number): { status: "delivering"; lease_until: string } {
  return { status: "delivering", lease_until: new Date(nowMs + LEASE_SECONDS * 1000).toISOString() };
}

/** Pure: the queued rows an inline attempt takes: still 'pending', in queue order (created_at, then id), at most max. */
export function inlineCandidates(rows: Row[], max: number): Row[] {
  return rows
    .filter((r) => r.status === "pending")
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(0, max));
}

/** Pure: rows grouped by endpoint, first-seen order. One endpoint's rows run in order: consecutive_failures is read-modify-write. */
export function byEndpoint(rows: Row[]): Row[][] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(String(r.endpoint_id), [...(groups.get(String(r.endpoint_id)) ?? []), r]);
  return [...groups.values()];
}

export interface InlineSummary { queued: number; attempted: number; delivered: number; failed: number; dlq: number; left_for_drain: number; errors: number; alerts: string[] }

/**
 * First attempt for rows this invocation just queued, inside the budget (claim + DELIVERY_COST per row + one alert). The
 * claim is claim_webhook_deliveries()'s, row by id: only a row still 'pending' is taken (one that the drain claimed first
 * is left to it), and a claimed row is invisible to the drain's claim until its outcome is written. Rows not taken, and
 * failed attempts (back to 'pending' at the next backoff step), are the drain's. Never throws.
 */
export async function attemptInline(env: Env, rows: Row[], budget: Budget, max = INLINE_MAX): Promise<InlineSummary> {
  const out: InlineSummary = { queued: rows.length, attempted: 0, delivered: 0, failed: 0, dlq: 0, left_for_drain: rows.length, errors: 0, alerts: [] };
  const fixed = COST.db + COST.alert;
  const n = Math.min(inlineCandidates(rows, max).length, Math.floor((budget.left - fixed) / DELIVERY_COST));
  if (n < 1 || !budget.take(fixed + n * DELIVERY_COST)) return out;
  const pick = inlineCandidates(rows, n);
  const client = db(env);
  const t = newTally();
  const { data, error } = await client.from("webhook_deliveries").update(claimPatch(Date.now())).in("id", pick.map((r) => r.id)).eq("status", "pending").select("*");
  if (error) { t.errors++; t.problems.push(`inline claim of ${pick.length} deliver${pick.length === 1 ? "y" : "ies"}: ${redact(error.message)}`); }
  const claimed = error ? [] : ((data ?? []) as Row[]);
  budget.release((n - claimed.length) * DELIVERY_COST);
  out.attempted = claimed.length;
  const results = await Promise.all(byEndpoint(claimed).map(async (group) => {
    const rs: DeliveryResult[] = [];
    for (const d of group) rs.push(await deliverOne(client, d));
    return rs;
  }));
  for (const r of results.flat()) count(t, r);
  Object.assign(out, { delivered: t.delivered, failed: t.failed, dlq: t.dlq, errors: t.errors, left_for_drain: rows.length - t.delivered - t.dlq });
  const items = dlqAlerts(t.dlqs);
  if (t.problems.length) items.push({ key: "webhook_inline_errors", dedupMinutes: 60, text: `${t.problems.length} inline webhook step(s) failed; the rows stay queued for the drain (a row left 'delivering' is requeued ${STALE_DELIVERING_MINUTES} min after its lease). ${t.problems.slice(0, 5).join("; ")}` });
  if (items.length) { await alertMany(env, items); out.alerts = items.map((i) => i.key); }
  else budget.release(COST.alert);
  return out;
}

/** Resolves when p settles or after ms, whichever comes first (the pending timer never outlives it). */
export async function settleWithin(p: Promise<unknown>, ms: number): Promise<"settled" | "timed_out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => { timer = setTimeout(() => resolve("timed_out"), ms); });
  try { return await Promise.race([p.then(() => "settled" as const, () => "settled" as const), timeout]); }
  finally { clearTimeout(timer); }
}

/**
 * Give queued rows their inline first attempt: under waitUntil when the caller has one, else awaited for at most
 * INLINE_AWAIT_MS (an attempt cut short leaves its rows 'delivering'; the drain's stale sweep requeues them).
 */
export async function deliverInline(env: Env, rows: Row[], opts: { waitUntil?: WaitUntil; budget?: Budget } = {}): Promise<void> {
  if (!rows.length) return;
  const run = attemptInline(env, rows, opts.budget ?? new Budget(inlineSubrequests(INLINE_MAX))).catch(async (e) => {
    await alert(env, "webhook_inline_errors", `inline webhook attempt threw; the rows stay queued for the drain: ${redact(String(e)).slice(0, 300)}`, { dedupMinutes: 60 });
  });
  if (opts.waitUntil) opts.waitUntil(run);
  else await settleWithin(run, INLINE_AWAIT_MS);
}

/**
 * Queue an event for the tenants' subscribed endpoints and give it its first attempt now (plan §18 (a)). The queueing
 * is awaited in every case: a queued row is the durable part, delivered by the drain whatever happens to the inline
 * attempt. Never throws (a queueing failure is alerted by enqueueEvent).
 */
export async function publishEvent(env: Env, tenants: string | readonly string[], eventType: WebhookEvent, payload: Record<string, unknown>, opts: { waitUntil?: WaitUntil } = {}): Promise<{ queued: number }> {
  let rows: Row[] = [];
  try { rows = await enqueueEvent(env, tenants, eventType, payload); }
  catch (e) {
    await alert(env, "webhook_enqueue_failed", `${eventType} was not queued: enqueue threw (${redact(String(e)).slice(0, 200)}). The event is lost unless it is re-emitted.`, { dedupMinutes: 60, meta: { event_type: eventType } });
    return { queued: 0 };
  }
  await deliverInline(env, rows, opts);
  return { queued: rows.length };
}

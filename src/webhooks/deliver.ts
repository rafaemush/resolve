/** Outbound webhooks: HMAC-signed, capped backoff (0s,60s,5m,30m,2h,12h,24h), DLQ, replay. */
import type { Env } from "../env";
import { db, rpc, type Db } from "../db/supabase";
import { hmacHex, sha256Hex } from "../resolve/text";
import { alert, alertMany, type AlertItem } from "../ops/alerts";
import { Budget, COST } from "../ops/budget";
import { redact } from "../ops/redact";

const BACKOFF_S = [0, 60, 300, 1800, 7200, 43200, 86400];
export const MAX_ATTEMPTS = BACKOFF_S.length;
/** Deliveries per scheduled drain (the 5-minute cron, src/jobs/schedule.ts). */
export const DRAIN_MAX = 5;
/** Worst case of one delivery: endpoint read, the POST, the delivery update, the endpoint update. */
export const DELIVERY_COST = 3 * COST.db + COST.http;
/** The drain's budget: the claim, `max` deliveries and one alertMany() that carries every alert of the run. */
export const drainSubrequests = (max: number): number => COST.db + max * DELIVERY_COST + COST.alert;
/** A dead endpoint DLQs one delivery per event; one DM per endpoint per 6 h is enough to act on. */
export const DLQ_DEDUP_MINUTES = 360;

export async function enqueueEvent(env: Env, tenantId: string, eventType: string, payload: Record<string, unknown>): Promise<number> {
  const client = db(env);
  // "found no endpoint" and "could not read the endpoints" differ: the second drops the event, so it alerts.
  const { data: eps, error: readError } = await client.from("webhook_endpoints").select("id, events").eq("tenant_id", tenantId).eq("active", true).is("deleted_at", null);
  if (readError) {
    await alert(env, "webhook_enqueue_failed", `${eventType} for tenant ${tenantId} was not queued: the endpoint read failed (${redact(readError.message)}). The event is lost unless the verdict is re-emitted.`, { dedupMinutes: 60, meta: { tenant_id: tenantId, event_type: eventType } });
    return 0;
  }
  const targets = (eps ?? []).filter((e) => (e.events as string[]).includes(eventType));
  if (!targets.length) return 0;
  const sha = await sha256Hex(JSON.stringify(payload));
  const { error } = await client.from("webhook_deliveries").insert(targets.map((e) => ({ endpoint_id: e.id, tenant_id: tenantId, event_type: eventType, payload, payload_sha256: sha })));
  if (error) {
    await alert(env, "webhook_enqueue_failed", `${eventType} for tenant ${tenantId} was not queued for ${targets.length} endpoint(s): ${redact(error.message)}. The event is lost unless the verdict is re-emitted.`, { dedupMinutes: 60, meta: { tenant_id: tenantId, event_type: eventType } });
    return 0;
  }
  return targets.length;
}

export interface DrainSummary { claimed: number; delivered: number; failed: number; dlq: number; errors: number; claim_error: string | null; alerts: string[] }
interface Dlq { endpoint: string; tenant: string; delivery: string; reason: string }

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

type Row = Record<string, unknown>;
interface Run { out: DrainSummary; dlqs: Dlq[]; problems: string[] }

/**
 * Claims only what the budget can finish: claim_webhook_deliveries() never re-claims a 'delivering' row, so a row
 * claimed and not processed would be stuck. Every alert of the run (DLQ per endpoint, claim and bookkeeping failures)
 * goes out in one alertMany() reserved before the claim.
 */
export async function drainWebhooks(env: Env, max = 10, budget: Budget = new Budget(drainSubrequests(max))): Promise<DrainSummary> {
  const client = db(env);
  const run: Run = { out: { claimed: 0, delivered: 0, failed: 0, dlq: 0, errors: 0, claim_error: null, alerts: [] }, dlqs: [], problems: [] };
  const { out } = run;
  if (!budget.take(COST.db + COST.alert)) return out;
  const n = Math.min(max, Math.floor(budget.left / DELIVERY_COST));
  if (n < 1 || !budget.take(n * DELIVERY_COST)) { budget.release(COST.db + COST.alert); return out; }

  let rows: Row[] = [];
  try { rows = await rpc<Row[]>(client, "claim_webhook_deliveries", { p_max: n }); }
  catch (e) { out.claim_error = redact(String(e)).slice(0, 300); }
  for (const d of rows) {
    out.claimed++;
    const state = { settled: false };
    try { await deliverOne(client, d, run, state); }
    catch (e) {
      // A row left 'delivering' is never claimed again: hand it back unless its outcome was already written.
      problem(run, `delivery ${String(d.id)}: ${redact(String(e)).slice(0, 200)}`);
      if (!state.settled) await write(run, `delivery ${String(d.id)} release`, client.from("webhook_deliveries").update({ status: "pending", lease_until: null }).eq("id", d.id as string));
    }
  }

  const items = dlqAlerts(run.dlqs);
  if (out.claim_error) items.push({ key: "webhook_claim_failed", dedupMinutes: 60, text: `claim_webhook_deliveries failed; no webhook is being delivered until it recovers: ${out.claim_error}` });
  if (run.problems.length) items.push({ key: "webhook_drain_errors", dedupMinutes: 60, text: `${run.problems.length} webhook drain step(s) failed. A delivery left in 'delivering' is never claimed again (claim_webhook_deliveries takes only 'pending'); set it back to 'pending' by id. ${run.problems.slice(0, 5).join("; ")}` });
  if (items.length) { await alertMany(env, items); out.alerts = items.map((i) => i.key); }
  else budget.release(COST.alert);
  return out;
}

function problem(run: Run, text: string): void { run.out.errors++; run.problems.push(text); }

async function write(run: Run, what: string, q: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await q;
  if (error) problem(run, `${what}: ${redact(error.message)}`);
}

/** One claimed delivery, at most DELIVERY_COST subrequests. `state.settled` turns true once its outcome is written. */
async function deliverOne(client: Db, d: Row, run: Run, state: { settled: boolean }): Promise<void> {
  const { out } = run;
  const id = d.id as string, endpointId = String(d.endpoint_id);
  const { data: ep, error: epError } = await client.from("webhook_endpoints").select("url, secret, active, deleted_at, consecutive_failures").eq("id", endpointId).maybeSingle();
  if (epError) {
    // Could not look at the endpoint: hand the row back at the same attempt instead of calling the endpoint dead.
    problem(run, `endpoint ${endpointId} read: ${redact(epError.message)}`);
    state.settled = true;
    await write(run, `delivery ${id} release`, client.from("webhook_deliveries").update({ status: "pending", lease_until: null }).eq("id", id));
    return;
  }
  const attempt = Number(d.attempt) + 1;
  if (!ep || !ep.active || ep.deleted_at) {
    state.settled = true;
    await write(run, `delivery ${id} dlq`, client.from("webhook_deliveries").update({ status: "dlq", attempt, last_error: "endpoint inactive", lease_until: null }).eq("id", id));
    run.dlqs.push({ endpoint: endpointId, tenant: String(d.tenant_id), delivery: id, reason: "endpoint inactive or deleted" });
    out.dlq++;
    return;
  }
  const body = JSON.stringify({ id: d.event_id, type: d.event_type, created_at: d.created_at, data: d.payload });
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacHex(ep.secret as string, `${t}.${body}`);
  let status: number | null = null, err: string | null = null;
  try {
    const res = await fetch(ep.url as string, { method: "POST", headers: { "Content-Type": "application/json", "X-Resolve-Signature": `t=${t},v1=${sig}`, "X-Resolve-Event-Id": String(d.event_id), "X-Resolve-Event-Type": String(d.event_type), "X-Resolve-Delivery-Attempt": String(attempt), "User-Agent": "ResolveWebhooks/1.0" }, body, signal: AbortSignal.timeout(10_000) });
    status = res.status;
    if (!res.ok) err = `HTTP ${res.status}`;
  } catch (e) { err = String(e).slice(0, 200); }
  state.settled = true;
  if (!err) {
    await write(run, `delivery ${id} delivered`, client.from("webhook_deliveries").update({ status: "delivered", attempt, last_status_code: status, last_error: null, delivered_at: new Date().toISOString(), lease_until: null }).eq("id", id));
    await write(run, `endpoint ${endpointId} reset`, client.from("webhook_endpoints").update({ consecutive_failures: 0 }).eq("id", endpointId));
    out.delivered++;
  } else if (attempt >= MAX_ATTEMPTS) {
    await write(run, `delivery ${id} dlq`, client.from("webhook_deliveries").update({ status: "dlq", attempt, last_status_code: status, last_error: err, lease_until: null }).eq("id", id));
    await write(run, `endpoint ${endpointId} failures`, client.from("webhook_endpoints").update({ consecutive_failures: Number(ep.consecutive_failures) + 1 }).eq("id", endpointId));
    run.dlqs.push({ endpoint: endpointId, tenant: String(d.tenant_id), delivery: id, reason: `${MAX_ATTEMPTS} attempts failed, last: ${err}` });
    out.dlq++;
  } else {
    const next = new Date(Date.now() + (BACKOFF_S[attempt] ?? 86400) * 1000).toISOString();
    await write(run, `delivery ${id} retry`, client.from("webhook_deliveries").update({ status: "pending", attempt, last_status_code: status, last_error: err, next_attempt_at: next, lease_until: null }).eq("id", id));
    await write(run, `endpoint ${endpointId} failures`, client.from("webhook_endpoints").update({ consecutive_failures: Number(ep.consecutive_failures) + 1 }).eq("id", endpointId));
    out.failed++;
  }
}

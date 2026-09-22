/** Outbound webhooks: HMAC-signed, capped backoff (0s,60s,5m,30m,2h,12h,24h), DLQ, replay. */
import type { Env } from "../env";
import { db, rpc } from "../db/supabase";
import { hmacHex, sha256Hex } from "../resolve/text";

const BACKOFF_S = [0, 60, 300, 1800, 7200, 43200, 86400];
export const MAX_ATTEMPTS = BACKOFF_S.length;

export async function enqueueEvent(env: Env, tenantId: string, eventType: string, payload: Record<string, unknown>): Promise<number> {
  const client = db(env);
  const { data: eps } = await client.from("webhook_endpoints").select("id, events").eq("tenant_id", tenantId).eq("active", true).is("deleted_at", null);
  const targets = (eps ?? []).filter((e) => (e.events as string[]).includes(eventType));
  if (!targets.length) return 0;
  const sha = await sha256Hex(JSON.stringify(payload));
  const { error } = await client.from("webhook_deliveries").insert(targets.map((e) => ({ endpoint_id: e.id, tenant_id: tenantId, event_type: eventType, payload, payload_sha256: sha })));
  if (error) { console.error("enqueueEvent failed", error.message); return 0; }
  return targets.length;
}

export async function drainWebhooks(env: Env, max = 10): Promise<{ claimed: number; delivered: number; failed: number; dlq: number }> {
  const client = db(env);
  const out = { claimed: 0, delivered: 0, failed: 0, dlq: 0 };
  let rows: Array<Record<string, unknown>> = [];
  try { rows = await rpc<Array<Record<string, unknown>>>(client, "claim_webhook_deliveries", { p_max: max }); } catch (e) { console.error("claim failed", String(e)); return out; }
  for (const d of rows) {
    out.claimed++;
    const { data: ep } = await client.from("webhook_endpoints").select("url, secret, active, deleted_at, consecutive_failures").eq("id", d.endpoint_id as string).single();
    const attempt = Number(d.attempt) + 1;
    if (!ep || !ep.active || ep.deleted_at) { await client.from("webhook_deliveries").update({ status: "dlq", attempt, last_error: "endpoint inactive", lease_until: null }).eq("id", d.id as string); out.dlq++; continue; }
    const body = JSON.stringify({ id: d.event_id, type: d.event_type, created_at: d.created_at, data: d.payload });
    const t = Math.floor(Date.now() / 1000);
    const sig = await hmacHex(ep.secret as string, `${t}.${body}`);
    let status: number | null = null, err: string | null = null;
    try {
      const res = await fetch(ep.url as string, { method: "POST", headers: { "Content-Type": "application/json", "X-Resolve-Signature": `t=${t},v1=${sig}`, "X-Resolve-Event-Id": String(d.event_id), "X-Resolve-Event-Type": String(d.event_type), "X-Resolve-Delivery-Attempt": String(attempt), "User-Agent": "ResolveWebhooks/1.0" }, body, signal: AbortSignal.timeout(10_000) });
      status = res.status;
      if (!res.ok) err = `HTTP ${res.status}`;
    } catch (e) { err = String(e).slice(0, 200); }
    if (!err) {
      await client.from("webhook_deliveries").update({ status: "delivered", attempt, last_status_code: status, last_error: null, delivered_at: new Date().toISOString(), lease_until: null }).eq("id", d.id as string);
      await client.from("webhook_endpoints").update({ consecutive_failures: 0 }).eq("id", d.endpoint_id as string);
      out.delivered++;
    } else if (attempt >= MAX_ATTEMPTS) {
      await client.from("webhook_deliveries").update({ status: "dlq", attempt, last_status_code: status, last_error: err, lease_until: null }).eq("id", d.id as string);
      await client.from("webhook_endpoints").update({ consecutive_failures: Number(ep.consecutive_failures) + 1 }).eq("id", d.endpoint_id as string);
      out.dlq++;
    } else {
      const next = new Date(Date.now() + (BACKOFF_S[attempt] ?? 86400) * 1000).toISOString();
      await client.from("webhook_deliveries").update({ status: "pending", attempt, last_status_code: status, last_error: err, next_attempt_at: next, lease_until: null }).eq("id", d.id as string);
      await client.from("webhook_endpoints").update({ consecutive_failures: Number(ep.consecutive_failures) + 1 }).eq("id", d.endpoint_id as string);
      out.failed++;
    }
  }
  return out;
}

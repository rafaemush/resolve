/**
 * Stand-ins for the functions POST /v1/request-key calls, step for step in the SQL's order, over the in-memory database
 * (tests/lib/fake-db.ts): migration 005's rate_limit_hit (fixed-window counters in rate_limit_buckets), migration 014's
 * log_touch (idempotent on request_id), and migration 004's grant_credits (tests/lib/fake-money.ts). They exist so the
 * form can be tested end to end, the key it issues included, without Postgres. Run inside fakeDb's rpc(): one
 * subrequest, rolled back on error.
 */
import type { FakeDb, FakeDbOptions } from "./fake-db";
import { grantCredits } from "./fake-money";

/** rate_limit_hit(p_key, p_window_ms, p_limit): count this hit in the key's window (a new window once it has reset). */
export async function rateLimitHit(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const buckets = (db.tables.rate_limit_buckets ??= []);
  const now = Date.now();
  const newReset = new Date(now + a.p_window_ms).toISOString();
  let b = buckets.find((x) => x.key === a.p_key);
  if (!b) { b = { key: a.p_key, count: 1, reset_at: newReset }; buckets.push(b); }
  else if (Date.parse(b.reset_at) <= now) Object.assign(b, { count: 1, reset_at: newReset });
  else b.count += 1;
  return { data: [{ allowed: b.count <= a.p_limit, remaining: Math.max(0, a.p_limit - b.count), reset_at: b.reset_at }], error: null };
}

/** log_touch: a retry with the same request_id returns the touch already recorded; the same id with other content is refused. */
export async function logTouch(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const touches = (db.tables.gtm_touches ??= []);
  const lead = (db.tables.leads ?? []).find((l) => l.id === a.p_lead);
  const request = String(a.p_request_id ?? "").trim() || null;
  const prev = request ? touches.find((t) => t.request_id === request) : undefined;
  if (prev) {
    if (prev.lead_id !== a.p_lead || prev.summary !== a.p_summary) return { data: null, error: { code: "23505", message: `log_touch: request_id ${request} already records touch ${prev.id} with different content` } };
    return { data: prev.id, error: null };
  }
  if (!lead) return { data: null, error: { code: "23503", message: `gtm_touches: no lead ${a.p_lead}` } };
  if (lead.deleted_at) return { data: null, error: { code: "RS002", message: `lead ${a.p_lead} is deleted: no new touch` } };
  const row = { id: `touch-${touches.length + 1}`, lead_id: a.p_lead, kind: a.p_kind, direction: a.p_direction, summary: a.p_summary, request_id: request, touched_at: new Date().toISOString() };
  touches.push(row);
  return { data: row.id, error: null };
}

export const REQUEST_KEY_RPCS: NonNullable<FakeDbOptions["rpc"]> = { rate_limit_hit: rateLimitHit, log_touch: logTouch, grant_credits: grantCredits };

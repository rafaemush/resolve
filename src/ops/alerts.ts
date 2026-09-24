/**
 * Operator alerting: one `alerts` row + one Telegram DM per key per dedup window.
 * Never throws: an alert that cannot be delivered is logged, and the caller's work continues.
 */
import type { Env } from "../env";
import { db, type Db } from "../db/supabase";
import { alertOperator } from "../bot/telegram";
import { redact } from "./redact";

export interface AlertOptions { dedupMinutes?: number; meta?: Record<string, unknown> }
export interface AlertItem { key: string; text: string; dedupMinutes?: number; meta?: Record<string, unknown> }
export interface AlertManyResult { sent: string[]; deduped: string[] }

const DEFAULT_DEDUP_MINUTES = 60;
const TEXT_MAX = 3500;
/** Telegram caps a message at 4096 characters; alerts that share one DM split this between them. */
const DM_MAX = 4000;

const log = (job: string, key: string, e: unknown) => console.error(JSON.stringify({ level: "error", job, key, error: redact(String(e)).slice(0, 300) }));

/**
 * When this isolate last DMed each key. Read only when the alerts table cannot be (often the very outage being alerted,
 * which the every-minute tick raises every minute): the dedup window then holds per isolate instead of not at all. Best
 * effort: a fresh isolate starts empty and alerts, the safe side.
 */
const sentHere = new Map<string, number>();
const SENT_HERE_MAX = 500;
function rememberSent(key: string, at: number): void {
  sentHere.delete(key); // re-insert so the oldest entry is the first one evicted
  sentHere.set(key, at);
  if (sentHere.size > SENT_HERE_MAX) sentHere.delete(sentHere.keys().next().value!);
}

export async function alert(env: Env, key: string, text: string, opts: AlertOptions = {}): Promise<{ sent: boolean; deduped: boolean }> {
  const r = await alertMany(env, [{ key, text, dedupMinutes: opts.dedupMinutes, meta: opts.meta }]);
  return { sent: r.sent.length > 0, deduped: r.deduped.length > 0 };
}

/**
 * Any number of alerts for the subrequests of one (COST.alert): one dedup read over every key, one insert of the rows
 * not deduped, one DM carrying them all. A job with a fixed subrequest budget (the webhook drain) raises a per-key alert
 * for each thing that went wrong this way. Each item keeps its own dedup window; a key repeated in `items` is alerted
 * once (first text wins). An unreadable dedup table falls back to what this isolate sent; beyond that it alerts
 * anyway: a duplicate DM beats a silent failure.
 */
export async function alertMany(env: Env, items: AlertItem[]): Promise<AlertManyResult> {
  const byKey = new Map<string, AlertItem>();
  for (const i of items) if (!byKey.has(i.key)) byKey.set(i.key, i);
  const unique = [...byKey.values()];
  if (!unique.length) return { sent: [], deduped: [] };
  const now = Date.now();
  const windowMs = (i: AlertItem) => (i.dedupMinutes ?? DEFAULT_DEDUP_MINUTES) * 60_000;
  const body = (i: AlertItem) => redact(i.text).slice(0, TEXT_MAX);
  const within = (i: AlertItem, at: number | undefined) => at !== undefined && at >= now - windowMs(i);
  let fresh = unique;
  let client: Db | null = null;
  try {
    client = db(env);
    const since = new Date(now - Math.max(...unique.map(windowMs))).toISOString();
    const { data: recent, error: readError } = await client.from("alerts").select("key, created_at").in("key", unique.map((i) => i.key)).gte("created_at", since);
    if (readError) throw new Error(readError.message);
    const last = new Map<string, number>();
    for (const r of (recent ?? []) as Array<{ key: string; created_at: string }>) last.set(r.key, Math.max(last.get(r.key) ?? 0, Date.parse(r.created_at)));
    fresh = unique.filter((i) => !within(i, last.get(i.key)));
  } catch (e) {
    log("alert_dedup", unique[0]!.key, e);
    fresh = unique.filter((i) => !within(i, sentHere.get(i.key)));
  }
  if (fresh.length && client) {
    try {
      const { error } = await client.from("alerts").insert(fresh.map((i) => ({ key: i.key, text: body(i), meta: i.meta ?? {} })));
      if (error) log("alert", fresh[0]!.key, error.message);
    } catch (e) {
      log("alert", fresh[0]!.key, e);
    }
  }
  const deduped = unique.filter((i) => !fresh.includes(i)).map((i) => i.key);
  if (!fresh.length) return { sent: [], deduped };
  const share = Math.max(200, Math.floor(DM_MAX / fresh.length) - 40);
  const dm = fresh.map((i) => `[resolve] ${i.key}\n${body(i).slice(0, share)}`).join("\n\n");
  try {
    const r = await alertOperator(env, dm);
    if (r.ok) {
      for (const i of fresh) rememberSent(i.key, now);
      return { sent: fresh.map((i) => i.key), deduped };
    }
    log("alert_dm", fresh[0]!.key, r.error);
  } catch (e) {
    log("alert_dm", fresh[0]!.key, e);
  }
  return { sent: [], deduped };
}

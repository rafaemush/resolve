/**
 * Operator alerting: one `alerts` row + one Telegram DM per key per dedup window.
 * Never throws: an alert that cannot be delivered is logged, and the caller's work continues.
 */
import type { Env } from "../env";
import { db } from "../db/supabase";
import { alertOperator } from "../bot/telegram";
import { redact } from "./redact";

export interface AlertOptions { dedupMinutes?: number; meta?: Record<string, unknown> }

export async function alert(env: Env, key: string, text: string, opts: AlertOptions = {}): Promise<{ sent: boolean; deduped: boolean }> {
  const dedupMinutes = opts.dedupMinutes ?? 60;
  const body = redact(text).slice(0, 3500);
  try {
    const client = db(env);
    const since = new Date(Date.now() - dedupMinutes * 60_000).toISOString();
    const { data: recent } = await client.from("alerts").select("id").eq("key", key).gte("created_at", since).limit(1);
    if (recent && recent.length > 0) return { sent: false, deduped: true };
    const { error } = await client.from("alerts").insert({ key, text: body, meta: opts.meta ?? {} });
    if (error) console.error(JSON.stringify({ level: "error", job: "alert", key, error: redact(error.message) }));
  } catch (e) {
    console.error(JSON.stringify({ level: "error", job: "alert", key, error: redact(String(e)) }));
  }
  try {
    await alertOperator(env, `[resolve] ${key}\n${body}`);
    return { sent: true, deduped: false };
  } catch (e) {
    console.error(JSON.stringify({ level: "error", job: "alert_dm", key, error: redact(String(e)) }));
    return { sent: false, deduped: false };
  }
}

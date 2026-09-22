import type { Env } from "../env";
import { db } from "../db/supabase";

/** One cron tick. Insert failures are also written to R2 so a scheduled context's silent errors become visible. */
export async function runTick(env: Env, cron: string): Promise<{ loop: string; inserted: boolean; error: string | null; ms: number }> {
  const started = Date.now();
  const loop = cron === "*/10 * * * *" ? "reconcile" : "worker_liveness";
  let error: string | null = null;
  try {
    const client = db(env);
    const { error: e } = await client.from("loop_runs").insert({
      loop_name: loop, outcome: "success", rows_written: 1, duration_ms: Date.now() - started,
      meta: { cron, scheduled_at: new Date().toISOString() },
    });
    if (e) error = `${e.code ?? ""} ${e.message} ${e.details ?? ""}`.trim();
  } catch (e) {
    error = `exception: ${String(e)}`;
  }
  if (error) {
    try { await env.BACKUPS.put(`diag/tick-${new Date().toISOString()}.json`, JSON.stringify({ loop, cron, error, has_url: !!env.SUPABASE_URL, has_key: !!env.SUPABASE_SERVICE_ROLE_KEY })); } catch { /* nothing else to do */ }
  }
  return { loop, inserted: !error, error, ms: Date.now() - started };
}

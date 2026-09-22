import type { Env } from "../env";
import { db } from "../db/supabase";

/** One cron tick. Returns the insert outcome so the admin route can surface errors that cron logs would hide. */
export async function runTick(env: Env, cron: string): Promise<{ loop: string; inserted: boolean; error: string | null; ms: number }> {
  const started = Date.now();
  const loop = cron === "*/10 * * * *" ? "reconcile" : "worker_liveness";
  const client = db(env);
  const { error } = await client.from("loop_runs").insert({
    loop_name: loop,
    outcome: "success",
    rows_written: 1,
    duration_ms: Date.now() - started,
    meta: { cron, scheduled_at: new Date().toISOString() },
  });
  return { loop, inserted: !error, error: error ? `${error.code ?? ""} ${error.message}`.trim() : null, ms: Date.now() - started };
}

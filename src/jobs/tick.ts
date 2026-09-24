/**
 * The every-minute liveness tick: one worker_liveness row plus one read of the newest select_due_watches row, nothing
 * else (Workers Free: 1,440 ticks a day, so every subrequest here is multiplied). pg_cron runs select_due_watches every
 * minute and it writes one loop_runs row per run (migration 007; since 013 a run that throws writes 'failure'), but the
 * database cannot DM anyone: the tick turns a skipped, failed or missing dispatch into an operator alert.
 */
import type { Env } from "../env";
import { db } from "../db/supabase";
import { alertMany, type AlertItem } from "../ops/alerts";
import { redact } from "../ops/redact";

export const LIVENESS_CRON = "* * * * *";
/** pg_cron dispatches every minute; three minutes without a row is a stopped scheduler, not jitter. */
export const DISPATCH_LOOKBACK_MINUTES = 3;
export const DISPATCH_ALERT_DEDUP_MINUTES = 60;
export const TICK_INSERT_DEDUP_MINUTES = 30;

export interface DispatchRow { outcome: string; started_at: string; error: string | null; meta: Record<string, unknown> | null }
export type DispatchState =
  | { kind: "row"; row: DispatchRow }
  | { kind: "absent" }
  | { kind: "unreadable"; error: string };

export interface TickResult { inserted: boolean; error: string | null; dispatch: DispatchState; alerts: string[]; ms: number }

/**
 * Which alerts one tick raises (pure). dispatch_skipped / dispatch_failure carry the row's error and meta; no row in the
 * lookback is dispatch_absent (pg_cron job unscheduled, cron worker down, database paused: no watch is being polled).
 * When the tick's own insert failed, an unreadable dispatch row is the same outage and rides on tick_insert_failed.
 */
export function tickAlerts(insertError: string | null, dispatch: DispatchState): AlertItem[] {
  const out: AlertItem[] = [];
  if (insertError) out.push({ key: "tick_insert_failed", dedupMinutes: TICK_INSERT_DEDUP_MINUTES, text: `The every-minute worker_liveness row could not be written: ${insertError}${dispatch.kind === "unreadable" ? `. The dispatch check could not read loop_runs either: ${dispatch.error}` : ""}` });
  switch (dispatch.kind) {
    case "row": {
      const { outcome, started_at, error, meta } = dispatch.row;
      if (outcome === "skipped" || outcome === "failure") out.push({
        key: `dispatch_${outcome}`, dedupMinutes: DISPATCH_ALERT_DEDUP_MINUTES,
        text: `select_due_watches ${outcome === "skipped" ? "skipped" : "failed"} at ${started_at}: ${error ?? "no error recorded"}. Watches are not being dispatched while this lasts.${meta && Object.keys(meta).length ? ` meta: ${JSON.stringify(meta).slice(0, 500)}` : ""}`,
        meta: { started_at, error: error === null ? null : redact(error), meta: meta ?? {} },
      });
      break;
    }
    case "absent":
      out.push({ key: "dispatch_absent", dedupMinutes: DISPATCH_ALERT_DEDUP_MINUTES, text: `No select_due_watches run in the last ${DISPATCH_LOOKBACK_MINUTES} minutes: pg_cron is not dispatching watches (job unscheduled or inactive, cron worker down, or the database paused). No watch is being polled.` });
      break;
    case "unreadable":
      if (!insertError) out.push({ key: "dispatch_unreadable", dedupMinutes: DISPATCH_ALERT_DEDUP_MINUTES, text: `The tick could not read select_due_watches from loop_runs, so watch dispatch is unobserved: ${dispatch.error}` });
      break;
    default: {
      const never: never = dispatch;
      throw new Error(`unhandled dispatch state ${JSON.stringify(never)}`);
    }
  }
  return out;
}

const summary = (d: DispatchState) => (d.kind === "row" ? { kind: d.kind, outcome: d.row.outcome, started_at: d.row.started_at } : { kind: d.kind });

export async function runTick(env: Env): Promise<TickResult> {
  const started = Date.now();
  const client = db(env);
  let dispatch: DispatchState;
  try {
    const since = new Date(started - DISPATCH_LOOKBACK_MINUTES * 60_000).toISOString();
    const { data, error } = await client.from("loop_runs").select("outcome, started_at, error, meta").eq("loop_name", "select_due_watches").gte("started_at", since).order("started_at", { ascending: false }).limit(1);
    const row = (data as DispatchRow[] | null)?.[0];
    dispatch = error ? { kind: "unreadable", error: redact(error.message).slice(0, 300) } : row ? { kind: "row", row } : { kind: "absent" };
  } catch (e) {
    dispatch = { kind: "unreadable", error: redact(String(e)).slice(0, 300) };
  }
  let error: string | null = null;
  try {
    const { error: e } = await client.from("loop_runs").insert({
      loop_name: "worker_liveness", outcome: "success", rows_written: 1, duration_ms: Date.now() - started,
      meta: { cron: LIVENESS_CRON, scheduled_at: new Date(started).toISOString(), dispatch: summary(dispatch) },
    });
    if (e) error = redact(`${e.code ?? ""} ${e.message} ${e.details ?? ""}`.trim()).slice(0, 300);
  } catch (e) {
    error = `exception: ${redact(String(e)).slice(0, 300)}`;
  }
  if (error) {
    // R2 is a different store: the one place the failure survives when Postgres itself is the problem.
    try { await env.BACKUPS.put(`diag/tick-${new Date().toISOString()}.json`, JSON.stringify({ loop: "worker_liveness", error, has_url: !!env.SUPABASE_URL, has_key: !!env.SUPABASE_SERVICE_ROLE_KEY })); } catch { /* the alert below still goes out */ }
  }
  const alerts = tickAlerts(error, dispatch);
  if (alerts.length) await alertMany(env, alerts);
  return { inserted: !error, error, dispatch, alerts: alerts.map((a) => a.key), ms: Date.now() - started };
}

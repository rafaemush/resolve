/**
 * The every-minute liveness tick: one worker_liveness row plus one read of the newest select_due_watches row, and on one
 * tick in ten a read of the newest Limitless recorder run (RECORDER_CHECK_MINUTE), nothing else (Workers Free: 1,440
 * ticks a day, so every subrequest here is multiplied). pg_cron runs select_due_watches every minute and it writes one
 * loop_runs row per run (migration 007; since 013 a run that throws writes 'failure'), but the database cannot DM
 * anyone: the tick turns a skipped, failed or missing dispatch into an operator alert.
 */
import type { Env } from "../env";
import { db, type Db } from "../db/supabase";
import { alertMany, type AlertItem } from "../ops/alerts";
import { redact } from "../ops/redact";
import { COST } from "../ops/budget";
import { RECORDER_LOOP } from "./limitless-recorder";

export const LIVENESS_CRON = "* * * * *";
/**
 * The tick's worst case: the dispatch read, the recorder read (1 tick in 10), the liveness insert and one alertMany that
 * carries every alert of the tick (the R2 diag write is a binding call). The channel poster gets what is left.
 */
export const TICK_SUBREQUESTS = 3 * COST.db + COST.alert;
/** pg_cron dispatches every minute; three minutes without a row is a stopped scheduler, not jitter. */
export const DISPATCH_LOOKBACK_MINUTES = 3;
export const DISPATCH_ALERT_DEDUP_MINUTES = 60;
export const TICK_INSERT_DEDUP_MINUTES = 30;

export interface DispatchRow { outcome: string; started_at: string; error: string | null; meta: Record<string, unknown> | null }
export type DispatchState =
  | { kind: "row"; row: DispatchRow }
  | { kind: "absent" }
  | { kind: "unreadable"; error: string };

/**
 * The Limitless recorder is dispatched at :00, :10, :20, ... (pg_cron job limitless_recorder, migration 018). One that is
 * never dispatched (the cron job removed or inactive, dispatch_internal skipping or failing in the database) raises
 * nothing by itself, and dispatch_failures() counts only answers. So the tick at :05, :15, ... (half-way between
 * dispatches: it never races the run it looks for) reads the newest recorder run, one more read on 144 of the 1,440
 * ticks a day. Not in the 10-minute invocation: every subrequest there is reconcile's (RECONCILE_SUBREQUESTS).
 */
export const RECORDER_CHECK_MINUTE = 5;
/** Three missed 10-minute runs is a stopped recorder, not jitter. */
export const RECORDER_STALE_MINUTES = 30;
export const RECORDER_STALE_DEDUP_MINUTES = 360;

/** Pure. Whether the tick at this time reads the newest recorder run. */
export function recorderCheckDue(nowMs: number): boolean {
  return new Date(nowMs).getUTCMinutes() % 10 === RECORDER_CHECK_MINUTE;
}

/** The newest limitless_recorder row, none at all, or a read that failed (never taken for "none"). */
export type RecorderRun =
  | { kind: "row"; started_at: string; outcome: string }
  | { kind: "absent" }
  | { kind: "unreadable"; error: string };

/**
 * The alert one recorder observation raises (pure), or null while the newest run is at most RECORDER_STALE_MINUTES old.
 * No row at all is stale too: the recorder never ran (right after its first deploy this fires once unless a pass is run
 * by hand, docs/runbooks/limitless-recorder.md).
 */
export function recorderStaleAlert(run: RecorderRun, nowMs: number): AlertItem | null {
  const look = "Look at: select jobname, schedule, active from cron.job where jobname = 'limitless_recorder'; select started_at, outcome, error from loop_runs where loop_name = 'dispatch_internal' order by started_at desc limit 5; (docs/runbooks/limitless-recorder.md).";
  const lost = "First sightings of Limitless outcomes are not being recorded while this lasts.";
  const item = (text: string): AlertItem => ({ key: "limitless_recorder_stale", dedupMinutes: RECORDER_STALE_DEDUP_MINUTES, text });
  switch (run.kind) {
    case "row": {
      const age = nowMs - Date.parse(run.started_at);
      if (age <= RECORDER_STALE_MINUTES * 60_000) return null; // an unparsable time (NaN) is stale, never fresh
      return item(`The Limitless recorder's newest run is from ${run.started_at} (${Number.isFinite(age) ? `${Math.round(age / 60_000)} min ago` : "unparsable time"}, outcome ${run.outcome}); it runs every 10 min. ${lost} ${look}`);
    }
    case "absent":
      return item(`No Limitless recorder run is recorded in loop_runs at all. ${lost} ${look}`);
    case "unreadable":
      return item(`The tick could not read the newest limitless_recorder run from loop_runs, so whether the recorder runs is unobserved: ${run.error}`);
    default: {
      const never: never = run;
      throw new Error(`unhandled recorder run ${JSON.stringify(never)}`);
    }
  }
}

async function newestRecorderRun(client: Db): Promise<RecorderRun> {
  try {
    const { data, error } = await client.from("loop_runs").select("started_at, outcome").eq("loop_name", RECORDER_LOOP).order("started_at", { ascending: false }).limit(1);
    if (error) return { kind: "unreadable", error: redact(error.message).slice(0, 300) };
    const row = (data as Array<{ started_at: string; outcome: string }> | null)?.[0];
    return row ? { kind: "row", started_at: row.started_at, outcome: row.outcome } : { kind: "absent" };
  } catch (e) {
    return { kind: "unreadable", error: redact(String(e)).slice(0, 300) };
  }
}

/** recorder: null on the ticks that do not read it. */
export interface TickResult { inserted: boolean; error: string | null; dispatch: DispatchState; recorder: RecorderRun | null; alerts: string[]; ms: number }

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

/** opts.checkRecorder: the scheduler passes recorderCheckDue(now); off, the tick is its usual two subrequests. */
export async function runTick(env: Env, opts: { checkRecorder?: boolean } = {}): Promise<TickResult> {
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
  const recorder = opts.checkRecorder ? await newestRecorderRun(client) : null;
  let error: string | null = null;
  try {
    const { error: e } = await client.from("loop_runs").insert({
      loop_name: "worker_liveness", outcome: "success", rows_written: 1, duration_ms: Date.now() - started,
      meta: { cron: LIVENESS_CRON, scheduled_at: new Date(started).toISOString(), dispatch: summary(dispatch), ...(recorder ? { recorder } : {}) },
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
  // As with the dispatch row, an unreadable recorder row when the tick's own insert failed is that outage: it rides on tick_insert_failed.
  const stale = recorder && !(error && recorder.kind === "unreadable") ? recorderStaleAlert(recorder, Date.now()) : null;
  if (stale) alerts.push(stale);
  if (alerts.length) await alertMany(env, alerts);
  return { inserted: !error, error, dispatch, recorder, alerts: alerts.map((a) => a.key), ms: Date.now() - started };
}

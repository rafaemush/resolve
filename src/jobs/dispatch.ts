/**
 * pg_net dispatch outcomes (plan §16.4 P0 step 7). Two database jobs POST to the Worker through pg_net and never look at
 * the answer: select_due_watches() (one POST per due watch) and, since migration 018, dispatch_internal() (internal
 * jobs: limitless_record every 10 minutes). pg_net keeps each answer in net._http_response for a few hours. A POST the
 * Worker refused (403: the HMAC secret in vault and the Worker disagree), could not finish (5xx, CPU or subrequest
 * limit, a run that could not record itself) or never reached (timeout, DNS, the daily request cap) is a run that
 * silently did not happen. dispatch_failures() (migration 013) counts them all; this job, on the 10-minute cron, turns
 * a count into an alert whose breakdown query tells the two jobs apart.
 * The same job reads the storage status (storage_status(), migration 022; plan §22.5): the database cannot DM the
 * operator, so the Worker alerts once the database passes 300 MB and again past 400 MB of the Supabase Free plan's
 * 500 MB, where the project turns read-only, and when the daily retention purge that keeps it small failed, has not run
 * for PURGE_STALE_HOURS, or lost its cron job: a purge that stopped would otherwise be heard of only at 300 MB. Since
 * migration 023 the same answer carries the refund rule of the priced reveal (refund_late_reveals, every 5 minutes from
 * pg_cron): its newest run failed, is older than REFUND_STALE_MINUTES, or its cron job is gone, and charged reveals that
 * were never delivered stay charged, so each of those alerts too. Both reads run in parallel and every alert of the run
 * goes out in one alertMany(), so the job costs DISPATCH_CHECK_SUBREQUESTS (src/ops/budget.ts): two reads and one alert.
 */
import { z } from "zod";
import type { Env } from "../env";
import { db, rpc } from "../db/supabase";
import { alertMany, type AlertItem } from "../ops/alerts";
import { redact } from "../ops/redact";

/** The window equals the cron interval, so consecutive checks tile the timeline. */
export const DISPATCH_WINDOW_MINUTES = 10;
export const DISPATCH_FAILURE_DEDUP_MINUTES = 60;

/** 1 MB as pg_size_pretty prints it. */
export const MB = 1_048_576;
/** The size alerts, in MB: the Supabase Free plan holds 500 MB and the project turns read-only there. */
export const DB_SIZE_ALERT_MB = [300, 400] as const;
/** While the database stays past a level its alert repeats this often: the first notice weekly, the second daily. */
export const DB_SIZE_DEDUP_MINUTES: Record<(typeof DB_SIZE_ALERT_MB)[number], number> = { 300: 7 * 1440, 400: 1440 };
export const DB_SIZE_UNREADABLE_DEDUP_MINUTES = 360;
/** purge_retention runs daily at 03:23 UTC (migration 022): a newest run older than this is a purge that stopped. */
export const PURGE_STALE_HOURS = 26;
/** A purge alert repeats daily while it holds: the purge itself runs once a day. */
export const PURGE_ALERT_DEDUP_MINUTES = 1440;

/** refund_late_reveals runs every 5 minutes (migration 023): a newest run older than this is a refund rule that stopped. */
export const REFUND_STALE_MINUTES = 30;
/** A refund alert repeats hourly while it holds: charged reveals that were not delivered wait for it. */
export const REFUND_ALERT_DEDUP_MINUTES = 60;

const LastRun = z.object({ started_at: z.string(), outcome: z.string(), error: z.string().nullable() }).nullable();
/**
 * storage_status()'s answer (migration 022; last_refund and refund_scheduled since 023): jsonb, so database_bytes is a
 * JSON number. The two refund keys are absent only where migration 023 is not applied, which refundAlert reports.
 */
export const StorageStatus = z.object({
  database_bytes: z.number().int().min(0).refine(Number.isSafeInteger),
  purge_scheduled: z.boolean().nullable(),
  last_purge: LastRun,
  refund_scheduled: z.boolean().nullable().optional(),
  last_refund: LastRun.optional(),
});
export type StorageStatus = z.infer<typeof StorageStatus>;

export interface DispatchCheck {
  ok: boolean; failures: number | null; error: string | null; alert: string | null;
  db_size: { bytes: number | null; error: string | null; alert: string | null };
  retention: { last_purge: StorageStatus["last_purge"]; scheduled: boolean | null; alert: string | null };
  refunds: { last_refund: StorageStatus["last_purge"]; scheduled: boolean | null; alert: string | null };
}

/** The alert (key + text) one check raises, or null (pure). "Could not count" is never "counted zero". */
export function dispatchCheckAlert(failures: number | null, error: string | null): { key: string; text: string } | null {
  if (error !== null || failures === null) return { key: "dispatch_check_failed", text: `Could not count pg_net dispatch failures: ${error ?? "no answer"}. Dispatch outcomes (watch polls and internal jobs) are unobserved until this recovers.` };
  // net._http_response has no URL; dispatch_internal keeps its pg_net request id in loop_runs, so the join names the job.
  if (failures > 0) return {
    key: "dispatch_http_failures",
    text: `${failures} pg_net dispatch(es) to the Worker failed in the last ${DISPATCH_WINDOW_MINUTES} min (HTTP >= 400, a transport error or a timeout): watch polls, or internal jobs such as limitless_record, that did not run. Breakdown by job: select coalesce(d.meta->>'id', 'watch poll') as job, r.status_code, r.error_msg, count(*) from net._http_response r left join loop_runs d on d.loop_name = 'dispatch_internal' and d.started_at > now() - interval '1 hour' and d.meta->>'request_id' = r.id::text where r.created > now() - interval '${DISPATCH_WINDOW_MINUTES} minutes' and (r.status_code >= 400 or r.error_msg is not null) group by 1, 2, 3;`,
  };
  return null;
}

/**
 * The size alert one check raises, or null (pure): the highest level the database has passed, each level its own key
 * (db_size_300mb, db_size_400mb) so passing 400 MB alerts at once even while the 300 MB notice is deduplicated. "Could
 * not read the size" is its own alert, never "small".
 */
export function dbSizeAlert(bytes: number | null, error: string | null): AlertItem | null {
  if (error !== null || bytes === null) return { key: "db_size_check_failed", dedupMinutes: DB_SIZE_UNREADABLE_DEDUP_MINUTES, text: `Could not read the database size (storage_status(), migration 022): ${error ?? "no answer"}. Growth toward the Supabase Free plan's 500 MB, and the daily retention purge, are unobserved until this recovers.` };
  const passed = [...DB_SIZE_ALERT_MB].reverse().find((mb) => bytes > mb * MB);
  if (passed === undefined) return null;
  const mb = (bytes / MB).toFixed(1);
  return {
    key: `db_size_${passed}mb`, dedupMinutes: DB_SIZE_DEDUP_MINUTES[passed], meta: { bytes, level_mb: passed },
    text: `The database is ${mb} MB (pg_database_size), past ${passed} MB of the Supabase Free plan's 500 MB; the project turns read-only at 500 MB. purge_retention (daily, migration 022) keeps loop_runs and closed markets' evidence excerpts to 30 days; see its runs: select started_at, outcome, meta from loop_runs where loop_name = 'retention_purge' order by started_at desc limit 5; the largest tables: select relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_statio_user_tables order by pg_total_relation_size(relid) desc limit 10;`,
  };
}

async function countFailures(env: Env): Promise<{ failures: number | null; error: string | null }> {
  try {
    const n = await rpc<unknown>(db(env), "dispatch_failures", { p_minutes: DISPATCH_WINDOW_MINUTES });
    const parsed = z.number().int().min(0).safeParse(n);
    return parsed.success ? { failures: parsed.data, error: null } : { failures: null, error: `dispatch_failures returned ${JSON.stringify(n).slice(0, 80)}, not a count` };
  } catch (e) {
    return { failures: null, error: redact(String(e)).slice(0, 300) };
  }
}

/**
 * The retention purge's alert, or null (pure): its cron job missing or inactive, its newest run older than
 * PURGE_STALE_HOURS, or its newest run a failure (the run rolled back: nothing purged). No run yet with the job scheduled
 * is quiet: the first runs at the next 03:23 UTC after the migration.
 */
export function purgeAlert(s: Pick<StorageStatus, "purge_scheduled" | "last_purge">, now: number): AlertItem | null {
  const runs = "select started_at, outcome, error, meta from loop_runs where loop_name = 'retention_purge' order by started_at desc limit 5;";
  const base = { dedupMinutes: PURGE_ALERT_DEDUP_MINUTES, meta: { purge_scheduled: s.purge_scheduled, last_purge: s.last_purge } };
  if (s.purge_scheduled === false) {
    return { ...base, key: "retention_purge_unscheduled", text: `The pg_cron job purge_retention (migration 022) is missing or inactive: loop_runs and closed markets' evidence excerpts are no longer purged, and the database grows toward the Supabase Free plan's 500 MB. Schedule it again: select cron.schedule('purge_retention', '23 3 * * *', 'select public.purge_retention()');` };
  }
  const p = s.last_purge;
  if (!p) return null;
  // an unreadable time is a stale run, never a fresh one
  if (!(now - Date.parse(p.started_at) <= PURGE_STALE_HOURS * 3_600_000)) {
    return { ...base, key: "retention_purge_stale", text: `The retention purge (purge_retention, daily at 03:23 UTC, migration 022) last ran ${p.started_at} (${p.outcome}), more than ${PURGE_STALE_HOURS} h ago: is pg_cron running? Its runs: ${runs} pg_cron's own log: select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'purge_retention') order by start_time desc limit 5;` };
  }
  if (p.outcome === "failure") {
    return { ...base, key: "retention_purge_failed", text: `The retention purge failed at ${p.started_at}: ${p.error ?? "no error text"}. The run rolled back, nothing was purged; the next run is at 03:23 UTC. Its runs: ${runs} Run it by hand once fixed: select public.purge_retention();` };
  }
  return null;
}

/**
 * The priced reveal's refund rule alert, or null (pure): storage_status() without its refund keys (migration 023 not
 * applied: "could not look", never "fine"), the refund_late_reveals cron job missing or inactive, its newest run older
 * than REFUND_STALE_MINUTES or missing while the job is scheduled for longer, or a failure (a refund that failed, or a run
 * that rolled back). Each of those leaves charged reveals that were never delivered charged.
 */
export function refundAlert(s: Pick<StorageStatus, "refund_scheduled" | "last_refund">, now: number): AlertItem | null {
  const runs = "select started_at, outcome, error, meta from loop_runs where loop_name = 'reveal_refund' order by started_at desc limit 5;";
  const base = { dedupMinutes: REFUND_ALERT_DEDUP_MINUTES, meta: { refund_scheduled: s.refund_scheduled ?? null, last_refund: s.last_refund ?? null } };
  if (s.refund_scheduled === undefined || s.last_refund === undefined) {
    return { ...base, key: "reveal_refund_unobserved", text: "storage_status() carries no refund status: migration 023 (priced reveal) is not applied, or storage_status() was replaced. The refund rule of charged reveals (refund_late_reveals) cannot be observed. Apply 023: npx tsx scripts/migrate.ts" };
  }
  if (s.refund_scheduled === false) {
    return { ...base, key: "reveal_refund_unscheduled", text: "The pg_cron job refund_late_reveals (migration 023) is missing or inactive: charged reveals whose webhook Resolve did not attempt within 10 minutes are no longer refunded. Schedule it again: select cron.schedule('refund_late_reveals', '*/5 * * * *', 'select public.refund_late_reveals(10)');" };
  }
  const r = s.last_refund;
  if (!r) return null; // scheduled, no run yet: the first runs within 5 minutes of the migration
  // an unreadable time is a stale run, never a fresh one
  if (!(now - Date.parse(r.started_at) <= REFUND_STALE_MINUTES * 60_000)) {
    return { ...base, key: "reveal_refund_stale", text: `The refund rule of charged reveals (refund_late_reveals, every 5 minutes, migration 023) last ran ${r.started_at} (${r.outcome}), more than ${REFUND_STALE_MINUTES} min ago: is pg_cron running? Undelivered charged reveals stay charged until it runs. Its runs: ${runs} Run it by hand: select public.refund_late_reveals(10);` };
  }
  if (r.outcome === "failure") {
    return { ...base, key: "reveal_refund_failed", text: `The refund rule of charged reveals failed at ${r.started_at}: ${r.error ?? "no error text"}. A refund that failed stays owed (the next run retries it while the charge is under 3 days old). Its runs: ${runs}` };
  }
  return null;
}

/** storage_status() parsed; anything else (an error, another shape) is an error, never "small" or "purged". */
async function storageStatus(env: Env): Promise<{ status: StorageStatus | null; error: string | null }> {
  try {
    const out = await rpc<unknown>(db(env), "storage_status", {});
    const parsed = StorageStatus.safeParse(out);
    return parsed.success ? { status: parsed.data, error: null } : { status: null, error: `storage_status returned ${JSON.stringify(out).slice(0, 120)}, not a storage status` };
  } catch (e) {
    return { status: null, error: redact(String(e)).slice(0, 300) };
  }
}

export async function checkDispatchFailures(env: Env): Promise<DispatchCheck> {
  const [{ failures, error }, storage] = await Promise.all([countFailures(env), storageStatus(env)]);
  const a = dispatchCheckAlert(failures, error);
  const bytes = storage.status?.database_bytes ?? null;
  const s = dbSizeAlert(bytes, storage.error);
  const p = storage.status ? purgeAlert(storage.status, Date.now()) : null;
  const rf = storage.status ? refundAlert(storage.status, Date.now()) : null;
  const items: AlertItem[] = [
    ...(a ? [{ ...a, dedupMinutes: DISPATCH_FAILURE_DEDUP_MINUTES, meta: { failures, window_minutes: DISPATCH_WINDOW_MINUTES } }] : []),
    ...(s ? [s] : []),
    ...(p ? [p] : []),
    ...(rf ? [rf] : []),
  ];
  if (items.length) await alertMany(env, items);
  return {
    ok: items.length === 0, failures, error, alert: a?.key ?? null,
    db_size: { bytes, error: storage.error, alert: s?.key ?? null },
    retention: { last_purge: storage.status?.last_purge ?? null, scheduled: storage.status?.purge_scheduled ?? null, alert: p?.key ?? null },
    refunds: { last_refund: storage.status?.last_refund ?? null, scheduled: storage.status?.refund_scheduled ?? null, alert: rf?.key ?? null },
  };
}

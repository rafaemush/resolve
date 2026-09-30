/**
 * pg_net dispatch outcomes (plan §16.4 P0 step 7). Two database jobs POST to the Worker through pg_net and never look at
 * the answer: select_due_watches() (one POST per due watch) and, since migration 018, dispatch_internal() (internal
 * jobs: limitless_record every 10 minutes). pg_net keeps each answer in net._http_response for a few hours. A POST the
 * Worker refused (403: the HMAC secret in vault and the Worker disagree), could not finish (5xx, CPU or subrequest
 * limit, a run that could not record itself) or never reached (timeout, DNS, the daily request cap) is a run that
 * silently did not happen. dispatch_failures() (migration 013) counts them all; this job, on the 10-minute cron, turns
 * a count into an alert whose breakdown query tells the two jobs apart.
 * The same job reads the database size (database_size_bytes(), migration 022; plan §22.5): the database cannot DM the
 * operator, so the Worker alerts once it passes 300 MB and again past 400 MB of the Supabase Free plan's 500 MB, where
 * the project turns read-only. Both reads run in parallel and every alert of the run goes out in one alertMany(), so the
 * job costs DISPATCH_CHECK_SUBREQUESTS (src/ops/budget.ts): two reads and one alert.
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

export interface DispatchCheck {
  ok: boolean; failures: number | null; error: string | null; alert: string | null;
  db_size: { bytes: number | null; error: string | null; alert: string | null };
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
  if (error !== null || bytes === null) return { key: "db_size_check_failed", dedupMinutes: DB_SIZE_UNREADABLE_DEDUP_MINUTES, text: `Could not read the database size (database_size_bytes(), migration 022): ${error ?? "no answer"}. Growth toward the Supabase Free plan's 500 MB is unobserved until this recovers.` };
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

/** bigint arrives as a JSON number from PostgREST (a numeric string is accepted too); anything else is an error. */
async function databaseBytes(env: Env): Promise<{ bytes: number | null; error: string | null }> {
  try {
    const n = await rpc<unknown>(db(env), "database_size_bytes", {});
    const bytes = typeof n === "number" ? n : typeof n === "string" && /^\d{1,15}$/.test(n) ? Number(n) : NaN;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? { bytes, error: null } : { bytes: null, error: `database_size_bytes returned ${JSON.stringify(n).slice(0, 80)}, not a size` };
  } catch (e) {
    return { bytes: null, error: redact(String(e)).slice(0, 300) };
  }
}

export async function checkDispatchFailures(env: Env): Promise<DispatchCheck> {
  const [{ failures, error }, size] = await Promise.all([countFailures(env), databaseBytes(env)]);
  const a = dispatchCheckAlert(failures, error);
  const s = dbSizeAlert(size.bytes, size.error);
  const items: AlertItem[] = [
    ...(a ? [{ ...a, dedupMinutes: DISPATCH_FAILURE_DEDUP_MINUTES, meta: { failures, window_minutes: DISPATCH_WINDOW_MINUTES } }] : []),
    ...(s ? [s] : []),
  ];
  if (items.length) await alertMany(env, items);
  return { ok: items.length === 0, failures, error, alert: a?.key ?? null, db_size: { ...size, alert: s?.key ?? null } };
}

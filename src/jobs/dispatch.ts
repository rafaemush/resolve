/**
 * pg_net dispatch outcomes (plan §16.4 P0 step 7). select_due_watches() fires one pg_net POST per due watch and never
 * looks at the answer; pg_net keeps each answer in net._http_response for a few hours. A POST the Worker refused
 * (403: the HMAC secret in vault and the Worker disagree), could not finish (5xx, CPU or subrequest limit, a run that
 * could not record itself) or never reached (timeout, DNS, the daily request cap) is a watch poll that silently did not
 * happen. dispatch_failures() (migration 013) counts them; this job, on the 10-minute cron, turns a count into an alert.
 */
import { z } from "zod";
import type { Env } from "../env";
import { db, rpc } from "../db/supabase";
import { alert } from "../ops/alerts";
import { redact } from "../ops/redact";

/** The window equals the cron interval, so consecutive checks tile the timeline. */
export const DISPATCH_WINDOW_MINUTES = 10;
export const DISPATCH_FAILURE_DEDUP_MINUTES = 60;

export interface DispatchCheck { ok: boolean; failures: number | null; error: string | null; alert: string | null }

/** The alert (key + text) one check raises, or null (pure). "Could not count" is never "counted zero". */
export function dispatchCheckAlert(failures: number | null, error: string | null): { key: string; text: string } | null {
  if (error !== null || failures === null) return { key: "dispatch_check_failed", text: `Could not count pg_net dispatch failures: ${error ?? "no answer"}. Watch dispatch outcomes are unobserved until this recovers.` };
  if (failures > 0) return { key: "dispatch_http_failures", text: `${failures} pg_net dispatch(es) of watch polls to the Worker failed in the last ${DISPATCH_WINDOW_MINUTES} min (HTTP >= 400, a transport error or a timeout); those polls did not run. Breakdown: select status_code, error_msg, count(*) from net._http_response where created > now() - interval '${DISPATCH_WINDOW_MINUTES} minutes' and (status_code >= 400 or error_msg is not null) group by 1, 2;` };
  return null;
}

export async function checkDispatchFailures(env: Env): Promise<DispatchCheck> {
  let failures: number | null = null, error: string | null = null;
  try {
    const n = await rpc<unknown>(db(env), "dispatch_failures", { p_minutes: DISPATCH_WINDOW_MINUTES });
    const parsed = z.number().int().min(0).safeParse(n);
    if (parsed.success) failures = parsed.data;
    else error = `dispatch_failures returned ${JSON.stringify(n).slice(0, 80)}, not a count`;
  } catch (e) {
    error = redact(String(e)).slice(0, 300);
  }
  const a = dispatchCheckAlert(failures, error);
  if (a) await alert(env, a.key, a.text, { dedupMinutes: DISPATCH_FAILURE_DEDUP_MINUTES, meta: { failures, window_minutes: DISPATCH_WINDOW_MINUTES } });
  return { ok: a === null, failures, error, alert: a?.key ?? null };
}

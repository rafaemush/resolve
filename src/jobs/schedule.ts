/**
 * Cron routing (plan §16.4 P0 steps 7 and 10). Workers Free runs each cron trigger as its own invocation with its own
 * 50 subrequests, so the jobs are grouped by cost and ordered by what running out of subrequests would break:
 *   every minute   liveness: a worker_liveness row and one read of the newest dispatch row, at :05, :15, ... one more
 *                  read, of the newest Limitless recorder run (TICK_SUBREQUESTS = 8 with its alert), then the channel
 *                  poster on what is left (CHANNEL_POST_SUBREQUESTS = 37): pending commits of at most 4 events (the legs
 *                  of an event as one message) and pending reveals of at most 4 commit messages, under the channel lease
 *                  and at most 15 messages a minute (src/bot/post.ts, src/bot/channel.ts)
 *   every 5 min    webhook drain first (cap 5 on a fixed budget of 2 + 5 x 4 + 5 = 27: a claimed row it could not finish
 *                  would sit in 'delivering' until the stale sweep), then the USDC deposit scan on what is left
 *                  (DEPOSIT_SCAN_SUBREQUESTS = 18; safe to cut off: credits are INSERT-first and the cursor moves only
 *                  past handled logs, so a cut is a retry, never a lost deposit). Its Alchemy transfers path spends
 *                  SCAN_RESERVE 6 + cursor read 1 + safe header 1 + cursor write 1, then 1 per page of up to 1,000
 *                  transfers (TRANSFER_PAGE_COST, any block range) and 1 per credit (+ PAYMENT_EVENTS_COST 3 once): a
 *                  one-page catch-up over any gap reserves 10 (SCAN_RESERVE + cursor read + TRANSFERS_MIN), leaving 8
 *                  for more pages and credits, and a scan with no alert sends 5 of the 10. The eth_getLogs fallback
 *                  keeps its per-window cost (safe header, eth_getLogs, cursor write: 3 per 2,000 blocks)
 *   every 10 min   pg_net dispatch check (6), then reconcile on its own budget (RECONCILE_SUBREQUESTS = 39)
 * Every invocation keeps EXCEPTION_RESERVE back: a job that throws becomes an operator alert, not a log line.
 * wrangler.toml [triggers] must list exactly the CRONS below (tests/schedule.test.ts reads it).
 */
import type { Env } from "../env";
import { parseConfig } from "../env";
import { runTick, recorderCheckDue, LIVENESS_CRON, TICK_SUBREQUESTS } from "./tick";
import { checkDispatchFailures } from "./dispatch";
import { runReconcile } from "./reconcile";
import { scanDeposits } from "./deposits";
import { drainWebhooks, drainSubrequests, DRAIN_MAX } from "../webhooks/deliver";
import { postPending } from "../bot/post";
import { alert } from "../ops/alerts";
import { Budget, EXCEPTION_RESERVE, INVOCATION_SUBREQUESTS } from "../ops/budget";
import { redact } from "../ops/redact";

export const CRONS = { liveness: LIVENESS_CRON, fiveMinutes: "*/5 * * * *", tenMinutes: "*/10 * * * *" } as const;
export type JobName = "liveness" | "channel_post" | "webhook_drain" | "deposit_scan" | "dispatch_check" | "reconcile";
export const JOB_EXCEPTION_DEDUP_MINUTES = 60;
/** The channel poster's share of the every-minute invocation: what the tick and one exception alert leave. */
export const CHANNEL_POST_SUBREQUESTS = INVOCATION_SUBREQUESTS - TICK_SUBREQUESTS - EXCEPTION_RESERVE;
/** Per minute: events whose pending commits are posted, and commit messages whose pending reveals are posted. */
export const CHANNEL_POST_LIMITS = { commitEvents: 4, revealGroups: 4 } as const;
/** The deposit scan's share of the 5-minute invocation: what the drain's fixed budget and one exception alert leave. */
export const DEPOSIT_SCAN_SUBREQUESTS = INVOCATION_SUBREQUESTS - drainSubrequests(DRAIN_MAX) - EXCEPTION_RESERVE;

/** The jobs one cron trigger runs, in order (pure); [] for a cron this code does not route. */
export function jobsForCron(cron: string): JobName[] {
  switch (cron) {
    case CRONS.liveness: return ["liveness", "channel_post"];
    case CRONS.fiveMinutes: return ["webhook_drain", "deposit_scan"];
    case CRONS.tenMinutes: return ["dispatch_check", "reconcile"];
    default: return [];
  }
}

export const jobExceptionKey = (job: JobName): string => `job_${job}_exception`;

export interface JobReport { job: JobName; ok: boolean; result?: unknown; error?: string }
export interface ScheduledReport { cron: string; jobs: JobReport[] }

/** One job. `ok` is false for a failure the job already alerted itself (a failed insert, a claim error, a scan that did not scan). */
async function execute(env: Env, job: JobName): Promise<{ ok: boolean; result: unknown }> {
  switch (job) {
    case "liveness": { const r = await runTick(env, { checkRecorder: recorderCheckDue(Date.now()) }); return { ok: r.inserted && r.alerts.length === 0, result: r }; }
    case "channel_post": { const r = await postPending(env, new Budget(CHANNEL_POST_SUBREQUESTS), CHANNEL_POST_LIMITS); return { ok: r.errors.length === 0 && r.send_errors.length === 0, result: r }; }
    case "webhook_drain": { const r = await drainWebhooks(env, DRAIN_MAX); return { ok: r.claim_error === null && r.errors === 0, result: r }; }
    case "deposit_scan": { const r = await scanDeposits(env, parseConfig(env), new Budget(DEPOSIT_SCAN_SUBREQUESTS)); return { ok: r.scanned, result: r }; }
    case "dispatch_check": { const r = await checkDispatchFailures(env); return { ok: r.ok, result: r }; }
    case "reconcile": { const r = await runReconcile(env); return { ok: r.errors.length === 0 && r.unreachable === 0, result: r }; }
    default: { const never: never = job; throw new Error(`unrouted job ${String(never)}`); }
  }
}

/** Runs a job; an exception becomes an operator alert (job_<name>_exception) and the invocation's next job still runs. */
export async function runJob(env: Env, job: JobName): Promise<JobReport> {
  try {
    const { ok, result } = await execute(env, job);
    return { job, ok, result };
  } catch (e) {
    const error = redact(e instanceof Error ? (e.stack ?? e.message) : String(e)).slice(0, 500);
    console.error(JSON.stringify({ level: "error", job, error }));
    await alert(env, jobExceptionKey(job), `Scheduled job ${job} threw; its work for this run stopped there and the next run retries it:\n${error}`, { dedupMinutes: JOB_EXCEPTION_DEDUP_MINUTES });
    return { job, ok: false, error };
  }
}

/** Whether a healthy report is routine enough to leave out of the logs. */
function quiet(r: JobReport): boolean {
  if (r.job === "liveness") return true;
  return r.job === "channel_post" && (r.result as { messages?: number } | undefined)?.messages === 0;
}

/** The scheduled handler and POST /internal/tick. Never throws. */
export async function runScheduled(env: Env, cron: string): Promise<ScheduledReport> {
  const jobs = jobsForCron(cron);
  if (!jobs.length) {
    await alert(env, "cron_unrouted", `Cron trigger "${cron}" fired but src/jobs/schedule.ts routes no job to it (wrangler.toml [triggers] and CRONS disagree); nothing ran.`, { dedupMinutes: JOB_EXCEPTION_DEDUP_MINUTES });
    return { cron, jobs: [] };
  }
  const reports: JobReport[] = [];
  for (const job of jobs) {
    const r = await runJob(env, job);
    // A healthy liveness tick and an idle poster are the lines a day would otherwise hold 1,440 times each.
    if (!r.ok || !quiet(r)) console.log(JSON.stringify({ cron, ...r }));
    reports.push(r);
  }
  return { cron, jobs: reports };
}

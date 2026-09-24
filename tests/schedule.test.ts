/**
 * Cron routing (plan §16.4 P0 steps 7 and 10): which jobs each trigger runs, that wrangler.toml lists exactly the routed
 * crons, that each invocation's worst case fits Workers Free's 50 subrequests, and that a job that throws becomes an
 * operator alert while the invocation's next job still runs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

const h = vi.hoisted(() => {
  const state = { throwIn: null as string | null, ran: [] as string[] };
  /** A stand-in job that records that it ran and throws when the test says so. */
  const job = (name: string, result: Record<string, unknown>) => vi.fn(async (..._args: unknown[]) => {
    state.ran.push(name);
    if (state.throwIn === name) throw new Error(`${name} exploded with key=abc123secret`);
    return result;
  });
  return { state, job };
});
vi.mock("../src/jobs/tick", () => ({ LIVENESS_CRON: "* * * * *", TICK_SUBREQUESTS: 7, runTick: h.job("liveness", { inserted: true, alerts: [] }) }));
vi.mock("../src/bot/post", () => ({ postPending: h.job("channel_post", { errors: [], send_errors: [], messages: 0 }) }));
vi.mock("../src/jobs/dispatch", () => ({ checkDispatchFailures: h.job("dispatch_check", { ok: true }) }));
vi.mock("../src/jobs/reconcile", () => ({ runReconcile: h.job("reconcile", { errors: [], unreachable: 0 }) }));
vi.mock("../src/jobs/deposits", async (actual) => ({ ...(await actual<typeof import("../src/jobs/deposits")>()), scanDeposits: h.job("deposit_scan", { scanned: true }) }));
// The drain's budget arithmetic stays real (the deposit scan's share is derived from it); only the run is stubbed.
vi.mock("../src/webhooks/deliver", async (actual) => ({ ...(await actual<typeof import("../src/webhooks/deliver")>()), drainWebhooks: h.job("webhook_drain", { claim_error: null, errors: 0 }) }));
vi.mock("../src/env", () => ({ parseConfig: () => ({}) }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })), alertMany: vi.fn(async () => ({ sent: [], deduped: [] })) }));

import { CHANNEL_POST_LIMITS, CHANNEL_POST_SUBREQUESTS, CRONS, DEPOSIT_SCAN_SUBREQUESTS, jobsForCron, jobExceptionKey, runScheduled, type JobName } from "../src/jobs/schedule";
import { postPending } from "../src/bot/post";
import { alert } from "../src/ops/alerts";
import { drainWebhooks, drainSubrequests, DRAIN_MAX } from "../src/webhooks/deliver";
import { scanDeposits, SCAN_RESERVE } from "../src/jobs/deposits";
import { Budget, COST, DISPATCH_CHECK_SUBREQUESTS, EXCEPTION_RESERVE, INVOCATION_SUBREQUESTS } from "../src/ops/budget";

const env = {} as Env;
const alerts = () => vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes]);

describe("jobsForCron", () => {
  it("every minute: liveness, then the channel poster; drain + deposits every 5 min; dispatch check + reconcile every 10", () => {
    expect(jobsForCron("* * * * *")).toEqual(["liveness", "channel_post"]);
    expect(jobsForCron("*/5 * * * *")).toEqual(["webhook_drain", "deposit_scan"]);
    expect(jobsForCron("*/10 * * * *")).toEqual(["dispatch_check", "reconcile"]);
  });
  it("an unknown cron routes nothing (the caller alerts)", () => {
    expect(jobsForCron("*/15 * * * *")).toEqual([]);
    expect(jobsForCron("")).toEqual([]);
  });
  it("every job runs on exactly one cron", () => {
    const all = Object.values(CRONS).flatMap((c) => jobsForCron(c));
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set<JobName>(["liveness", "channel_post", "webhook_drain", "deposit_scan", "dispatch_check", "reconcile"]));
  });
  it("wrangler.toml [triggers] lists exactly the routed crons", () => {
    const toml = readFileSync(resolve(import.meta.dirname, "../wrangler.toml"), "utf8");
    const line = toml.split("\n").find((l) => /^crons\s*=/.test(l));
    expect(line).toBeDefined();
    const crons = JSON.parse(line!.slice(line!.indexOf("=") + 1)) as string[];
    expect(crons.sort()).toEqual(Object.values(CRONS).sort());
  });
});

describe("exception alert keys", () => {
  it("job_<name>_exception", () => {
    expect(jobExceptionKey("reconcile")).toBe("job_reconcile_exception");
    expect(jobExceptionKey("webhook_drain")).toBe("job_webhook_drain_exception");
    expect(jobExceptionKey("deposit_scan")).toBe("job_deposit_scan_exception");
  });
});

describe("per-invocation subrequest budgets (Workers Free: 50)", async () => {
  const { RECONCILE_SUBREQUESTS } = await vi.importActual<typeof import("../src/jobs/reconcile")>("../src/jobs/reconcile");
  it("10-minute invocation: dispatch check + reconcile + one exception alert fit", () => {
    expect(DISPATCH_CHECK_SUBREQUESTS).toBe(COST.db + COST.alert);
    expect(DISPATCH_CHECK_SUBREQUESTS + RECONCILE_SUBREQUESTS + EXCEPTION_RESERVE).toBeLessThanOrEqual(INVOCATION_SUBREQUESTS);
  });
  it("5-minute invocation: the drain's fixed budget + the deposit scan's budget + one exception alert = 50", () => {
    expect(DRAIN_MAX).toBe(5);
    expect(drainSubrequests(DRAIN_MAX)).toBe(2 * COST.db + DRAIN_MAX * (3 * COST.db + COST.http) + COST.alert); // sweep + claim + 5 x 4 + one alertMany
    expect(drainSubrequests(DRAIN_MAX) + DEPOSIT_SCAN_SUBREQUESTS + EXCEPTION_RESERVE).toBe(INVOCATION_SUBREQUESTS);
    // The scan's reserve, its cursor read and one window's minimum (safe header, eth_getLogs, cursor write) fit.
    expect(DEPOSIT_SCAN_SUBREQUESTS).toBeGreaterThanOrEqual(SCAN_RESERVE + COST.db + 2 * COST.http + COST.db);
  });
  it("every-minute invocation: the tick (read, insert, one alertMany) + the channel poster's budget + one exception alert = 50", async () => {
    const { TICK_SUBREQUESTS } = await vi.importActual<typeof import("../src/jobs/tick")>("../src/jobs/tick");
    expect(TICK_SUBREQUESTS).toBe(2 * COST.db + COST.alert);
    expect(TICK_SUBREQUESTS + CHANNEL_POST_SUBREQUESTS + EXCEPTION_RESERVE).toBe(INVOCATION_SUBREQUESTS);
    // the poster's claim + release, the three reads and one message with its alert fit
    expect(CHANNEL_POST_SUBREQUESTS).toBeGreaterThanOrEqual(2 * COST.db + 3 * COST.db + COST.telegram + COST.db + COST.alert);
  });
  it("the manual drain (POST /internal/webhooks/drain, max 10) fits one invocation", () => {
    expect(drainSubrequests(10)).toBeLessThanOrEqual(INVOCATION_SUBREQUESTS);
  });
});

describe("runScheduled", () => {
  beforeEach(() => { h.state.throwIn = null; h.state.ran = []; vi.mocked(alert).mockClear(); });

  it("runs the routed jobs in order and reports them ok", async () => {
    const r = await runScheduled(env, "*/5 * * * *");
    expect(h.state.ran).toEqual(["webhook_drain", "deposit_scan"]);
    expect(r.jobs.map((j) => [j.job, j.ok])).toEqual([["webhook_drain", true], ["deposit_scan", true]]);
    expect(vi.mocked(drainWebhooks).mock.calls[0]![1]).toBe(5);
    // The scan runs on the invocation's remainder, not unbounded.
    const scanBudget = vi.mocked(scanDeposits).mock.calls.at(-1)![2] as Budget;
    expect(scanBudget).toBeInstanceOf(Budget);
    expect(scanBudget.limit).toBe(DEPOSIT_SCAN_SUBREQUESTS);
    expect(alerts()).toEqual([]);
  });

  it("the every-minute invocation runs the tick, then the channel poster on its own budget (at most 4 events)", async () => {
    const r = await runScheduled(env, "* * * * *");
    expect(h.state.ran).toEqual(["liveness", "channel_post"]);
    expect(r.jobs.map((j) => [j.job, j.ok])).toEqual([["liveness", true], ["channel_post", true]]);
    const [, budget, limits] = vi.mocked(postPending).mock.calls.at(-1)! as unknown as [unknown, Budget, typeof CHANNEL_POST_LIMITS];
    expect(budget.limit).toBe(CHANNEL_POST_SUBREQUESTS);
    expect(limits).toEqual({ commitEvents: 4, revealGroups: 4 });
  });

  it("a job that throws becomes a redacted alert and the next job still runs", async () => {
    h.state.throwIn = "webhook_drain";
    const r = await runScheduled(env, "*/5 * * * *");
    expect(h.state.ran).toEqual(["webhook_drain", "deposit_scan"]);
    expect(r.jobs.map((j) => [j.job, j.ok])).toEqual([["webhook_drain", false], ["deposit_scan", true]]);
    expect(alerts()).toEqual([["job_webhook_drain_exception", 60]]);
    const text = vi.mocked(alert).mock.calls[0]![2];
    expect(text).toContain("webhook_drain exploded");
    expect(text).not.toContain("abc123secret");
  });

  it("reconcile and deposit scan exceptions are alerted under their own keys", async () => {
    h.state.throwIn = "reconcile";
    await runScheduled(env, "*/10 * * * *");
    h.state.throwIn = "deposit_scan";
    await runScheduled(env, "*/5 * * * *");
    expect(alerts()).toEqual([["job_reconcile_exception", 60], ["job_deposit_scan_exception", 60]]);
  });

  it("a cron nobody routes is alerted, not ignored", async () => {
    const r = await runScheduled(env, "0 * * * *");
    expect(r.jobs).toEqual([]);
    expect(h.state.ran).toEqual([]);
    expect(alerts()).toEqual([["cron_unrouted", 60]]);
  });
});

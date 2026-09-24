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
vi.mock("../src/jobs/tick", () => ({ LIVENESS_CRON: "* * * * *", runTick: h.job("liveness", { inserted: true, alerts: [] }) }));
vi.mock("../src/jobs/dispatch", () => ({ checkDispatchFailures: h.job("dispatch_check", { ok: true }) }));
vi.mock("../src/jobs/reconcile", () => ({ runReconcile: h.job("reconcile", { errors: [], unreachable: 0 }) }));
vi.mock("../src/jobs/deposits", () => ({ scanDeposits: h.job("deposit_scan", { scanned: true }) }));
vi.mock("../src/webhooks/deliver", () => ({ DRAIN_MAX: 5, drainWebhooks: h.job("webhook_drain", { claim_error: null, errors: 0 }) }));
vi.mock("../src/env", () => ({ parseConfig: () => ({}) }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { CRONS, jobsForCron, jobExceptionKey, runScheduled, type JobName } from "../src/jobs/schedule";
import { alert } from "../src/ops/alerts";
import { drainWebhooks } from "../src/webhooks/deliver";
import { COST, DISPATCH_CHECK_SUBREQUESTS, EXCEPTION_RESERVE, INVOCATION_SUBREQUESTS } from "../src/ops/budget";

const env = {} as Env;
const alerts = () => vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes]);

describe("jobsForCron", () => {
  it("the every-minute tick only writes liveness; drain + deposits every 5 min; dispatch check + reconcile every 10", () => {
    expect(jobsForCron("* * * * *")).toEqual(["liveness"]);
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
    expect(new Set(all)).toEqual(new Set<JobName>(["liveness", "webhook_drain", "deposit_scan", "dispatch_check", "reconcile"]));
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
  const { drainSubrequests, DRAIN_MAX } = await vi.importActual<typeof import("../src/webhooks/deliver")>("../src/webhooks/deliver");
  it("10-minute invocation: dispatch check + reconcile + one exception alert fit", () => {
    expect(DISPATCH_CHECK_SUBREQUESTS).toBe(COST.db + COST.alert);
    expect(DISPATCH_CHECK_SUBREQUESTS + RECONCILE_SUBREQUESTS + EXCEPTION_RESERVE).toBeLessThanOrEqual(INVOCATION_SUBREQUESTS);
  });
  it("5-minute invocation: the drain's fixed budget leaves room for the deposit scan and one exception alert", () => {
    expect(DRAIN_MAX).toBe(5);
    expect(drainSubrequests(DRAIN_MAX)).toBe(26);
    expect(INVOCATION_SUBREQUESTS - drainSubrequests(DRAIN_MAX) - EXCEPTION_RESERVE).toBeGreaterThanOrEqual(19);
  });
});

describe("runScheduled", () => {
  beforeEach(() => { h.state.throwIn = null; h.state.ran = []; vi.mocked(alert).mockClear(); });

  it("runs the routed jobs in order and reports them ok", async () => {
    const r = await runScheduled(env, "*/5 * * * *");
    expect(h.state.ran).toEqual(["webhook_drain", "deposit_scan"]);
    expect(r.jobs.map((j) => [j.job, j.ok])).toEqual([["webhook_drain", true], ["deposit_scan", true]]);
    expect(vi.mocked(drainWebhooks).mock.calls[0]![1]).toBe(5);
    expect(alerts()).toEqual([]);
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

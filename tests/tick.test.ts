/**
 * The every-minute tick and the 10-minute dispatch check (plan §16.4 P0 step 7): which alert each dispatch observation
 * raises (skipped, failure, no row at all, unreadable), that a failed liveness insert alerts, that the healthy tick costs
 * exactly two subrequests, and that "could not count" pg_net failures is never "counted zero".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, failInsert: null as string | null }));
vi.mock("../src/db/supabase", () => ({
  db: () => ({
    ...h.db.client,
    // A liveness insert that Postgres refuses (the database paused, a revoked grant).
    from: (t: string) => {
      const q = h.db.client.from(t);
      if (t !== "loop_runs" || !h.failInsert) return q;
      return new Proxy(q, { get: (o, k) => (k === "insert" ? () => Promise.resolve({ data: null, error: { code: "57P01", message: h.failInsert } }) : Reflect.get(o, k)) });
    },
  }),
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })), alertMany: vi.fn(async () => ({ sent: [], deduped: [] })) }));

import { runTick, tickAlerts, DISPATCH_LOOKBACK_MINUTES, type DispatchState } from "../src/jobs/tick";
import { checkDispatchFailures, dispatchCheckAlert, DISPATCH_WINDOW_MINUTES } from "../src/jobs/dispatch";
import { alert, alertMany } from "../src/ops/alerts";

const put = vi.fn(async () => undefined);
const env = { BACKUPS: { put }, SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" } as unknown as Env;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const dispatchRow = (outcome: string, minutesAgo: number, over: Record<string, unknown> = {}) => ({ loop_name: "select_due_watches", outcome, started_at: ago(minutesAgo), error: null, meta: {}, ...over });
const keys = (items: Array<{ key: string; dedupMinutes?: number }>) => items.map((i) => [i.key, i.dedupMinutes]);
const row = (outcome: string, error: string | null = null): DispatchState => ({ kind: "row", row: { outcome, started_at: ago(1), error, meta: {} } });

describe("tickAlerts (pure)", () => {
  it("a healthy dispatch (success / no_op) raises nothing", () => {
    expect(tickAlerts(null, row("success"))).toEqual([]);
    expect(tickAlerts(null, row("no_op"))).toEqual([]);
  });
  it("skipped and failure alert as dispatch_<outcome> with the row's error and meta", () => {
    const [s] = tickAlerts(null, { kind: "row", row: { outcome: "skipped", started_at: "t", error: "watch_daily_cap reached: 50000", meta: {} } });
    expect([s!.key, s!.dedupMinutes]).toEqual(["dispatch_skipped", 60]);
    expect(s!.text).toContain("watch_daily_cap reached: 50000");
    const [f] = tickAlerts(null, { kind: "row", row: { outcome: "failure", started_at: "t", error: "function hmac(bytea, bytea, unknown) does not exist", meta: { sqlstate: "42883" } } });
    expect([f!.key, f!.dedupMinutes]).toEqual(["dispatch_failure", 60]);
    expect(f!.text).toContain("42883");
    expect(f!.meta).toEqual({ started_at: "t", error: "function hmac(bytea, bytea, unknown) does not exist", meta: { sqlstate: "42883" } });
  });
  it("no dispatch row in the lookback is a stopped scheduler, not silence", () => {
    expect(keys(tickAlerts(null, { kind: "absent" }))).toEqual([["dispatch_absent", 60]]);
  });
  it("an unreadable dispatch row alerts on its own, or rides on tick_insert_failed when the insert failed too", () => {
    expect(keys(tickAlerts(null, { kind: "unreadable", error: "timeout" }))).toEqual([["dispatch_unreadable", 60]]);
    const both = tickAlerts("57P01 terminating connection", { kind: "unreadable", error: "timeout" });
    expect(keys(both)).toEqual([["tick_insert_failed", 30]]);
    expect(both[0]!.text).toContain("could not read loop_runs either");
  });
  it("a failed insert and a separate dispatch problem both alert", () => {
    expect(keys(tickAlerts("boom", row("skipped", "cap")))).toEqual([["tick_insert_failed", 30], ["dispatch_skipped", 60]]);
    expect(keys(tickAlerts("boom", { kind: "absent" }))).toEqual([["tick_insert_failed", 30], ["dispatch_absent", 60]]);
  });
});

describe("runTick", () => {
  beforeEach(() => { h.failInsert = null; put.mockClear(); vi.mocked(alertMany).mockClear(); });

  it("healthy: one select + one insert, the newest dispatch row recorded in the liveness row, no alert", async () => {
    h.db = fakeDb({ loop_runs: [dispatchRow("skipped", 2.5, { error: "old" }), dispatchRow("success", 0.5)] });
    const r = await runTick(env);
    expect(r).toMatchObject({ inserted: true, error: null, alerts: [], dispatch: { kind: "row", row: { outcome: "success" } } });
    expect(h.db.calls).toEqual([{ table: "loop_runs", action: "select" }, { table: "loop_runs", action: "insert" }]);
    const live = h.db.tables.loop_runs!.find((x) => x.loop_name === "worker_liveness")!;
    expect(live).toMatchObject({ outcome: "success", rows_written: 1, meta: { cron: "* * * * *", dispatch: { kind: "row", outcome: "success" } } });
    expect(vi.mocked(alertMany)).not.toHaveBeenCalled();
  });

  it("the newest row in the lookback decides: skipped alerts with its error", async () => {
    h.db = fakeDb({ loop_runs: [dispatchRow("success", 2), dispatchRow("skipped", 0.2, { error: "watch_daily_cap reached: 50000" })] });
    const r = await runTick(env);
    expect(r.alerts).toEqual(["dispatch_skipped"]);
    expect(vi.mocked(alertMany).mock.calls[0]![1]![0]!.text).toContain("watch_daily_cap reached: 50000");
  });

  it(`rows older than ${DISPATCH_LOOKBACK_MINUTES} minutes do not count: dispatch_absent`, async () => {
    h.db = fakeDb({ loop_runs: [dispatchRow("success", DISPATCH_LOOKBACK_MINUTES + 1), { loop_name: "watch", outcome: "success", started_at: ago(0.1), error: null, meta: {} }] });
    expect((await runTick(env)).alerts).toEqual(["dispatch_absent"]);
  });

  it("a refused liveness insert alerts tick_insert_failed and leaves an R2 diagnostic", async () => {
    h.db = fakeDb({ loop_runs: [dispatchRow("no_op", 0.5)] });
    h.failInsert = "terminating connection due to administrator command";
    const r = await runTick(env);
    expect(r).toMatchObject({ inserted: false, alerts: ["tick_insert_failed"] });
    expect(keys(vi.mocked(alertMany).mock.calls[0]![1]!)).toEqual([["tick_insert_failed", 30]]);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe("dispatch_failures check", () => {
  beforeEach(() => vi.mocked(alert).mockClear());
  it("pure: zero is quiet, a count alerts, could-not-count is its own alert", () => {
    expect(dispatchCheckAlert(0, null)).toBeNull();
    expect(dispatchCheckAlert(3, null)!.key).toBe("dispatch_http_failures");
    expect(dispatchCheckAlert(null, "rpc dispatch_failures: PGRST202")!.key).toBe("dispatch_check_failed");
    expect(dispatchCheckAlert(0, "late error")!.key).toBe("dispatch_check_failed");
  });

  const withRpc = (answer: { data: unknown; error: unknown }) => {
    const seen: unknown[] = [];
    h.db = fakeDb({}, {}, { rpc: { dispatch_failures: async (_db, args) => { seen.push(args); return answer; } } });
    return seen;
  };
  it("asks for the cron window and alerts above zero (dedup 60)", async () => {
    const seen = withRpc({ data: 4, error: null });
    const r = await checkDispatchFailures(env);
    expect(seen).toEqual([{ p_minutes: DISPATCH_WINDOW_MINUTES }]);
    expect(r).toMatchObject({ ok: false, failures: 4, alert: "dispatch_http_failures" });
    expect(vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes])).toEqual([["dispatch_http_failures", 60]]);
  });
  it("zero failures: one RPC, no alert", async () => {
    withRpc({ data: 0, error: null });
    expect(await checkDispatchFailures(env)).toMatchObject({ ok: true, failures: 0, alert: null });
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
    expect(h.db.calls).toEqual([{ table: "rpc:dispatch_failures", action: "rpc" }]);
  });
  it("an RPC error or a non-count answer is dispatch_check_failed, never zero", async () => {
    withRpc({ data: null, error: { code: "PGRST202", message: "Could not find the function public.dispatch_failures" } });
    expect(await checkDispatchFailures(env)).toMatchObject({ ok: false, failures: null, alert: "dispatch_check_failed" });
    withRpc({ data: "3", error: null });
    expect(await checkDispatchFailures(env)).toMatchObject({ ok: false, failures: null, alert: "dispatch_check_failed" });
  });
});

/**
 * Jev gate alerts in the runtime (plan §16.4 P0 step 7): the breaker opening (upstream_record_failure answers true), the
 * daily USD ceiling refusing a Jev call, an unreadable gate and a failed accounting write each raise an operator alert;
 * a verdict that never needed Jev raises none. A resolutions row that cannot be written still leaves the Jev call
 * ledgered (spend, breaker), is alerted, and throws so the caller refunds. The Jev request itself is untouched
 * (fixtures are keyed by its hash).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Env } from "../src/env";
import { fakeDb, type FakeDb } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, refuseVerdictRow: null as string | null }));
vi.mock("../src/db/supabase", () => ({
  db: () => ({
    ...h.db.client,
    // Postgres refusing the verdict row (a CHECK, a timeout); a plain status update (the stub marked failed) still works.
    from: (t: string) => {
      const q = h.db.client.from(t);
      if (t !== "resolutions" || !h.refuseVerdictRow) return q;
      const refused = () => { const f: any = { eq: () => f, then: (ok: any, no: any) => Promise.resolve({ data: null, error: { code: "23514", message: h.refuseVerdictRow } }).then(ok, no) }; return f; };
      return new Proxy(q, { get: (o, k) => (k === "insert" ? refused : k === "update" ? (patch: Record<string, unknown>) => (patch.status_row === "complete" ? refused() : o.update(patch)) : Reflect.get(o, k)) });
    },
  }),
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })), alertMany: vi.fn(async () => ({ sent: [], deduped: [] })) }));

import { resolveWithRuntime, jevAlerts, BREAKER_THRESHOLD, BREAKER_OPEN_SECONDS, ResolutionNotRecordedError, type JevAlertInput } from "../src/resolve/runtime";
import { MarketRegistration, EvidenceInput } from "../src/resolve/schema";
import { alertMany } from "../src/ops/alerts";

const base: JevAlertInput = { gate: null, route: "jev", gatesError: null, breakerOpened: false, spendTodayUsd: 0.2, ceilingUsd: 1, lastJevError: null, accountingErrors: [] };
const keys = (i: Partial<JevAlertInput>) => jevAlerts({ ...base, ...i }).map((a) => [a.key, a.dedupMinutes]);

describe("jevAlerts (pure)", () => {
  it("a normal Jev call raises nothing", () => expect(keys({})).toEqual([]));
  it("the call that opened the breaker raises jev_breaker_open with the last error", () => {
    expect(keys({ breakerOpened: true })).toEqual([["jev_breaker_open", 60]]);
    const [a] = jevAlerts({ ...base, breakerOpened: true, lastJevError: "HTTP 529: overloaded" });
    expect(a!.text).toContain("HTTP 529: overloaded");
    expect(a!.text).toContain(`${BREAKER_THRESHOLD} consecutive`);
    expect(a!.text).toContain(`${BREAKER_OPEN_SECONDS} s`);
  });
  it("the ceiling alerts only when it refused a Jev call", () => {
    expect(keys({ gate: "BUDGET_EXCEEDED", spendTodayUsd: 1.02 })).toEqual([["jev_daily_ceiling", 60]]);
    expect(jevAlerts({ ...base, gate: "BUDGET_EXCEEDED", spendTodayUsd: 1.02 })[0]!.text).toContain("$1.0200 spent of $1.00");
    expect(keys({ gate: "BUDGET_EXCEEDED", route: "structured" })).toEqual([]);
    expect(keys({ gate: "BUDGET_EXCEEDED", route: "precheck" })).toEqual([]);
  });
  it("a breaker already open and the paid-route gate are not new events", () => {
    expect(keys({ gate: "MODEL_UNAVAILABLE" })).toEqual([]);
    expect(keys({ gate: "PAID_JEV_DISABLED" })).toEqual([]);
  });
  it("unreadable gates matter only on the Jev route; accounting failures always", () => {
    expect(keys({ gatesError: "rpc check_gates: timeout" })).toEqual([["jev_gates_unreadable", 60]]);
    expect(keys({ gatesError: "rpc check_gates: timeout", route: "structured" })).toEqual([]);
    expect(keys({ accountingErrors: ["record_jev_spend: timeout"] })).toEqual([["jev_accounting_failed", 60]]);
  });
});

// ---- the runtime wiring ------------------------------------------------------------------------------------------

const market = MarketRegistration.parse({
  external_id: "t-1", condition: "Will PR #4821 in openai/openai-python be merged before 2026-10-01 00:00 UTC?", event_statement: "PR #4821 in openai/openai-python is merged",
  option_a: "Yes, merged before the deadline", option_b: "No, not merged before the deadline", positive_option: "OPTION_A", anchors: ["openai/openai-python", "#4821"],
  sources: [{ kind: "web_fetch", ref: "https://github.com/openai/openai-python" }], open_at: "2026-09-01T00:00:00Z", deadline_utc: "2026-10-01T00:00:00Z",
});
const evidence = EvidenceInput.parse({ source_kind: "web_fetch", source_url: "https://github.com/openai/openai-python/releases/tag/v1.52.0", fetched_at: "2026-09-21T10:00:00Z",
  text: "Release notes for openai/openai-python. Pull request #4821 (add retries to the streaming client) was merged by the maintainers on 2026-09-20 and shipped in v1.52.0. The change is live on PyPI and the changelog lists #4821 under Fixed." });
const env = { TYPESAFE_API_KEY: "apikey_unit_test_key_0000000000", SPOTLIGHT_SECRET: "eval-spotlight-v1" } as unknown as Env;
const cfg = { jevPaidRoutesEnabled: false, jevDailyUsdCeiling: 1, jevModel: "jev-1.13.0", jevTimeoutMs: 2500, jevUsdPerMtok: 0.042, thresholdsVersion: "v1" } as Config;
const input = { marketId: "m1", market, evidence, evidenceId: null, mode: "shadow" as const, tenantId: null, apiKeyId: null, requestId: null, creditsCharged: 0, now: new Date("2026-09-22T12:00:00Z") };
const alerted = () => vi.mocked(alertMany).mock.calls.flatMap((c) => c[1]!.map((i) => i.key));

describe("resolveWithRuntime alerts", () => {
  let jevHits: number;
  const gates = (spend: number, open = false) => async () => ({ data: { jev_breaker_open: open, jev_spend_today_usd: spend }, error: null });
  beforeEach(() => {
    jevHits = 0;
    vi.mocked(alertMany).mockClear();
    vi.stubGlobal("fetch", async (url: string) => {
      if (!String(url).startsWith("https://api.typesafe.ai/")) throw new Error(`unexpected fetch ${url}`);
      jevHits++;
      return new Response("upstream overloaded", { status: 529 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the ceiling refuses the Jev call: no call, one jev_daily_ceiling alert", async () => {
    h.db = fakeDb({ resolutions: [], jev_calls: [] }, {}, { rpc: { check_gates: gates(1.5) } });
    const r = await resolveWithRuntime(env, cfg, input);
    expect(r.result.route).toBe("jev");
    expect(r.result.verdict).toMatchObject({ error_code: "UPSTREAM_UNAVAILABLE", error_reason: "BUDGET_EXCEEDED" });
    expect(jevHits).toBe(0);
    expect(alerted()).toEqual(["jev_daily_ceiling"]);
  });

  it("the failure that opens the breaker raises jev_breaker_open; the calls are still ledgered", async () => {
    const recorded: unknown[] = [];
    h.db = fakeDb({ resolutions: [], jev_calls: [] }, {}, { rpc: { check_gates: gates(0.1), upstream_record_failure: async (_db, a) => { recorded.push(a); return { data: true, error: null }; } } });
    const r = await resolveWithRuntime(env, cfg, input);
    expect(jevHits).toBe(2); // one bounded retry on 529
    expect(recorded).toEqual([{ p_name: "jev", p_threshold: BREAKER_THRESHOLD, p_open_seconds: BREAKER_OPEN_SECONDS }]);
    expect(h.db.tables.jev_calls).toHaveLength(2);
    expect(r.result.verdict.error_reason).toBe("MODEL_UNAVAILABLE");
    expect(alerted()).toEqual(["jev_breaker_open"]);
  });

  it("a failure below the threshold alerts nothing; an unreadable breaker write alerts jev_accounting_failed", async () => {
    h.db = fakeDb({ resolutions: [], jev_calls: [] }, {}, { rpc: { check_gates: gates(0.1), upstream_record_failure: async () => ({ data: false, error: null }) } });
    await resolveWithRuntime(env, cfg, input);
    expect(alerted()).toEqual([]);
    h.db = fakeDb({ resolutions: [], jev_calls: [] }, {}, { rpc: { check_gates: gates(0.1), upstream_record_failure: async () => ({ data: null, error: { code: "57014", message: "statement timeout" } }) } });
    await resolveWithRuntime(env, cfg, input);
    expect(alerted()).toEqual(["jev_accounting_failed"]);
  });

  it("check_gates failing does not block the call but is alerted", async () => {
    h.db = fakeDb({ resolutions: [], jev_calls: [] }, {}, { rpc: { check_gates: async () => ({ data: null, error: { code: "PGRST000", message: "connection refused" } }), upstream_record_failure: async () => ({ data: false, error: null }) } });
    await resolveWithRuntime(env, cfg, input);
    expect(jevHits).toBe(2);
    expect(alerted()).toEqual(["jev_gates_unreadable"]);
  });
});

describe("the free plan has structured verdicts only, whatever JEV_PAID_ROUTES_ENABLED says", () => {
  let jevHits: number;
  const gatesRead: unknown[] = [];
  const rpcs = { check_gates: async () => { gatesRead.push(1); return { data: { jev_breaker_open: false, jev_spend_today_usd: 0.1 }, error: null }; }, record_jev_spend: async () => ({ data: null, error: null }), upstream_record_failure: async () => ({ data: false, error: null }) };
  const on = { ...cfg, jevPaidRoutesEnabled: true };
  const tenant = { ...input, mode: "tenant" as const, tenantId: "t1", requestId: null, creditsCharged: 5 };
  beforeEach(() => {
    jevHits = 0; gatesRead.length = 0;
    vi.mocked(alertMany).mockClear();
    vi.stubGlobal("fetch", async () => { jevHits++; return new Response("upstream overloaded", { status: 529 }); });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a free-plan key (the plan from the key's auth): WEB_EVIDENCE_DISABLED, no model call, no gate read", async () => {
    h.db = fakeDb({ resolutions: [], jev_calls: [], tenants: [{ id: "t1", plan: "payg" }] }, {}, { rpc: rpcs });
    const r = await resolveWithRuntime(env, on, { ...tenant, tenantPlan: "free" });
    expect(r.result.route).toBe("jev");
    expect(r.result.verdict).toMatchObject({ error_code: "UPSTREAM_UNAVAILABLE", error_reason: "PAID_JEV_DISABLED" });
    expect(jevHits).toBe(0);
    expect(gatesRead).toEqual([]);
    expect(h.db.tables.jev_calls).toEqual([]);
  });

  it("no plan passed (a watch): tenants.plan is read; free or unreadable refuses, a paid plan reaches the model", async () => {
    for (const [tenants, called] of [[[{ id: "t1", plan: "free" }], 0], [[], 0], [[{ id: "t1", plan: "enterprise" }], 0], [[{ id: "t1", plan: "payg" }], 2]] as const) {
      h.db = fakeDb({ resolutions: [], jev_calls: [], tenants: tenants.map((t) => ({ ...t })) }, {}, { rpc: rpcs });
      jevHits = 0;
      const r = await resolveWithRuntime(env, on, tenant);
      expect(jevHits, JSON.stringify(tenants)).toBe(called);
      if (!called) expect(r.result.verdict.error_reason).toBe("PAID_JEV_DISABLED");
    }
  });

  it("a paid plan from the key's auth reaches the model; shadow resolutions are not a tenant's", async () => {
    h.db = fakeDb({ resolutions: [], jev_calls: [] }, {}, { rpc: rpcs });
    await resolveWithRuntime(env, on, { ...tenant, tenantPlan: "builder" });
    expect(jevHits).toBe(2);
    jevHits = 0;
    await resolveWithRuntime(env, on, input);
    expect(jevHits).toBe(2);
  });
});

describe("a verdict that cannot be recorded", () => {
  const usage = JSON.stringify({ error: "overloaded", usage: { input_tokens: 1_000, output_tokens: 0 } });
  const spend: unknown[] = [];
  const breaker: unknown[] = [];
  const rpcs = { check_gates: async () => ({ data: { jev_breaker_open: false, jev_spend_today_usd: 0.1 }, error: null }), record_jev_spend: async (_db: FakeDb, a: Record<string, unknown>) => { spend.push(a); return { data: null, error: null }; }, upstream_record_failure: async (_db: FakeDb, a: Record<string, unknown>) => { breaker.push(a); return { data: false, error: null }; } };
  beforeEach(() => {
    spend.length = 0; breaker.length = 0;
    vi.mocked(alertMany).mockClear();
    vi.stubGlobal("fetch", async () => new Response(usage, { status: 529 }));
  });
  afterEach(() => { vi.unstubAllGlobals(); h.refuseVerdictRow = null; });

  it("/v1/resolve stub: the Jev call is still ledgered, the stub is marked failed, resolution_write_failed is raised, and it throws", async () => {
    h.refuseVerdictRow = "new row for relation \"resolutions\" violates check constraint";
    h.db = fakeDb({ resolutions: [{ id: "req1", status_row: "pending", tenant_id: "t1" }], jev_calls: [] }, {}, { rpc: rpcs });
    const err = await resolveWithRuntime(env, { ...cfg, jevPaidRoutesEnabled: true }, { ...input, mode: "tenant", tenantId: "t1", tenantPlan: "payg", requestId: "req1", creditsCharged: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(ResolutionNotRecordedError);
    expect(h.db.tables.jev_calls!.map((c) => c.resolution_id)).toEqual(["req1", "req1"]);
    expect(spend).toEqual([{ p_input_tokens: 2_000, p_usd: expect.any(Number) }]);
    expect(breaker).toHaveLength(1);
    expect(h.db.tables.resolutions![0]).toMatchObject({ id: "req1", status_row: "failed" });
    expect(alerted()).toEqual(["resolution_write_failed"]);
    const item = vi.mocked(alertMany).mock.calls[0]![1]!.find((i) => i.key === "resolution_write_failed")!;
    expect(item).toMatchObject({ dedupMinutes: 60, meta: { request_id: "req1", tenant_id: "t1" } });
    expect(item.text).toContain("violates check constraint");
    expect(item.text).toContain("the stub is marked failed");
  });

  it("a watch or shadow insert that fails: jev_calls carry no dangling resolution id, and it is alerted", async () => {
    h.refuseVerdictRow = "canceling statement due to statement timeout";
    h.db = fakeDb({ resolutions: [], jev_calls: [] }, {}, { rpc: rpcs });
    await expect(resolveWithRuntime(env, cfg, input)).rejects.toBeInstanceOf(ResolutionNotRecordedError);
    expect(h.db.tables.jev_calls!.map((c) => c.resolution_id)).toEqual([null, null]);
    expect(spend).toHaveLength(1);
    expect(h.db.tables.resolutions).toEqual([]);
    expect(alerted()).toEqual(["resolution_write_failed"]);
  });
});

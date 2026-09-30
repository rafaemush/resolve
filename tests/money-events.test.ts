/**
 * Money events (plan §16.4 P3 step 3): the payment.credited and credits.low payloads, credits.low once per crossing
 * (claim_low_credit_notice() and the purchase/grant reset of migration 020, as stand-ins over the in-memory database),
 * a notice whose event could not be queued given back instead of lost, and POST /v1/resolve notifying on the charge that
 * crosses the threshold and never again until a purchase or grant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { ledgerInsert, MIGRATION_020_CONFIG, MONEY_RPCS } from "./lib/fake-money";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, failInsert: false }));
vi.mock("../src/db/supabase", () => ({
  db: () => ({
    ...h.db.client,
    from: (t: string) => {
      const q = h.db.client.from(t);
      if (t !== "webhook_deliveries" || !h.failInsert) return q;
      return new Proxy(q, { get: (o, k) => (k === "insert" ? () => ({ select: () => Promise.resolve({ data: null, error: { message: "insert refused" } }) }) : Reflect.get(o, k)) });
    },
  }),
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })), alertMany: vi.fn(async () => ({ sent: [], deduped: [] })) }));
vi.mock("../src/api/auth", () => ({
  authenticate: async () => ({ ok: true, auth: { keyId: "k1", tenantId: "t1", plan: "payg", strictV0: false, environment: "test", scopes: [], requestsToday: 0, dailyCap: 1000 } }),
  rateLimit: async () => ({ allowed: true }),
  extractApiKey: () => null,
  invalidateKeyCache: async () => undefined,
}));
vi.mock("../src/markets/register", () => ({ registerMarket: async () => ({ marketId: "m1", status: "open", reasons: [], watches: [] }) }));
vi.mock("../src/ingest/watch", () => ({ runWatch: vi.fn() }));
vi.mock("../src/resolve/runtime", async () => {
  const { JevUnavailableError } = await vi.importActual<typeof import("../src/resolve")>("../src/resolve");
  return {
    JevUnavailableError,
    resolveWithRuntime: vi.fn(async (_env: unknown, _cfg: unknown, o: { requestId: string }) => ({
      resolutionId: o.requestId, jevCalls: 1, jevCostUsd: 0,
      result: { verdict: { resolution_status: "RESOLVED", winning_outcome: "OPTION_A", confidence_score: 0.95, caveats: [], error_code: null, error_reason: null }, pre: { windows: [], markers: [] } },
    })),
  };
});

import { creditsLowPayload, creditsLowTopUp, noteCharge, paymentCreditedPayload, queuePaymentsCredited } from "../src/billing/events";
import { alert } from "../src/ops/alerts";
import { v1 } from "../src/api/v1";
import { MarketRegistration } from "../src/resolve/schema";

const env = { JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "60", SPOTLIGHT_SECRET: "eval-spotlight-v1", SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized", INTERNAL_HMAC_SECRET: "x", ADMIN_API_KEY: "x", EVAL_REPORT_KEY: "x", JEV_PAID_ROUTES_ENABLED: "1" } as unknown as Env;
const hook = (events: string[]): Row => ({ id: "e1", tenant_id: "t1", url: "https://hooks.example/e1", secret: "s", active: true, deleted_at: null, events, consecutive_failures: 0 });
const lowEvents = () => (h.db.tables.webhook_deliveries ?? []).filter((d) => d.event_type === "credits.low");
const alertKeys = () => vi.mocked(alert).mock.calls.map((c) => c[1]);

function newDb(balance: number, extra: Record<string, Row[]> = {}) {
  h.failInsert = false;
  h.db = fakeDb({
    tenants: [{ id: "t1", credits_balance: balance, deleted_at: null, low_credit_notified_at: null }],
    app_config: structuredClone(MIGRATION_020_CONFIG), credit_ledger: [], webhook_endpoints: [hook(["credits.low", "payment.credited"])], webhook_deliveries: [], ...extra,
  }, {}, { rpc: MONEY_RPCS });
}
/** A charge the way begin_resolution makes it: balance down, one ledger row (no reset: a charge never clears the notice). */
const charge = (n: number) => { const t = h.db.tables.tenants![0]!; t.credits_balance -= n; ledgerInsert(h.db, { tenant_id: "t1", delta: -n, reason: "charge", request_id: `r${h.db.tables.credit_ledger!.length}`, balance_after: t.credits_balance }); };
const grant = (n: number) => { const t = h.db.tables.tenants![0]!; t.credits_balance += n; ledgerInsert(h.db, { tenant_id: "t1", delta: n, reason: "grant", request_id: null, balance_after: t.credits_balance }); };

beforeEach(() => vi.mocked(alert).mockClear());

describe("payload builders", () => {
  it("payment.credited: exactly tx_hash, log_index, amount_usdc (exact decimal), credits, balance_after", () => {
    expect(paymentCreditedPayload({ tx_hash: "0xABC", log_index: 2, amount_usdc: "250.500000", credits: 27_555, balance_after: 30_000 }))
      .toEqual({ tx_hash: "0xabc", log_index: 2, amount_usdc: "250.5", credits: 27_555, balance_after: 30_000 });
  });
  it("credits.low: the balance, the threshold it fell below, the charge that crossed it, where to top up", () => {
    expect(creditsLowPayload({ balance: 499, threshold: 500, request_id: "r1", top_up: "/pricing" })).toEqual({ balance: 499, threshold: 500, request_id: "r1", top_up: "/pricing" });
  });
  it("credits.low tops up by card while card checkout is offered, else at /pricing; never at the USDC address, even with one configured", () => {
    const usdc = { USDC_RECEIVING_ADDRESS: `0x${"1".repeat(40)}` };
    const card = { WHOP_CHECKOUT_ENABLED: "1", WHOP_API_KEY: "whop_test_key", WHOP_PLAN_ID_50: "plan_a", WHOP_PLAN_ID_250: "plan_b" };
    expect(creditsLowTopUp({ ...env, ...usdc } as Env)).toBe("/pricing");
    expect(creditsLowTopUp({ ...env, ...usdc, ...card } as unknown as Env)).toBe("POST /v1/billing/checkout");
    expect(creditsLowTopUp({ ...env, ...usdc, ...card, WHOP_CHECKOUT_ENABLED: "0" } as unknown as Env)).toBe("/pricing");
  });
});

describe("noteCharge: credits.low once per crossing", () => {
  it("fires on the charge that crosses, not again, and again only after a purchase or grant", async () => {
    newDb(510);
    charge(5); // 505: above
    expect(await noteCharge(env, "t1", "r-a")).toEqual({ crossed: false, queued: 0 });
    charge(10); // 495: crossed
    expect(await noteCharge(env, "t1", "r-b")).toEqual({ crossed: true, queued: 1 });
    expect(lowEvents().map((d) => d.payload)).toEqual([{ balance: 495, threshold: 500, request_id: "r-b", top_up: "/pricing" }]);
    charge(5);
    expect(await noteCharge(env, "t1", "r-c")).toEqual({ crossed: false, queued: 0 }); // still low: once per crossing
    const t = h.db.tables.tenants![0]!;
    t.credits_balance += 5; // a refund raises the balance but is not a purchase: no second notice
    expect(await noteCharge(env, "t1", "r-d")).toMatchObject({ crossed: false });
    grant(100); // 595... a grant clears the notice
    expect(t.low_credit_notified_at).toBeNull();
    charge(100); // 495
    expect(await noteCharge(env, "t1", "r-e")).toEqual({ crossed: true, queued: 1 });
    expect(lowEvents()).toHaveLength(2);
    expect(alertKeys()).toEqual([]);
  });

  it("the threshold is data: app_config low_credit_threshold (500 when absent)", async () => {
    newDb(120);
    h.db.tables.app_config!.find((r) => r.key === "low_credit_threshold")!.value = "100";
    expect((await noteCharge(env, "t1", "r1")).crossed).toBe(false);
    h.db.tables.app_config = h.db.tables.app_config!.filter((r) => r.key !== "low_credit_threshold");
    expect((await noteCharge(env, "t1", "r2")).crossed).toBe(true);
  });

  it("an event that could not be queued gives the notice back (the next charge retries) and alerts", async () => {
    newDb(400);
    h.failInsert = true;
    expect(await noteCharge(env, "t1", "r1")).toEqual({ crossed: true, queued: 0 });
    expect(h.db.tables.tenants![0]!.low_credit_notified_at).toBeNull();
    expect(alertKeys()).toEqual(["low_credit_event_failed"]);
    h.failInsert = false;
    expect(await noteCharge(env, "t1", "r2")).toEqual({ crossed: true, queued: 1 });
  });

  it("a claim that fails is alerted, never thrown; a bad threshold is one", async () => {
    newDb(400);
    h.db.tables.app_config!.find((r) => r.key === "low_credit_threshold")!.value = "five hundred";
    expect(await noteCharge(env, "t1", "r1")).toEqual({ crossed: false, queued: 0 });
    expect(alertKeys()).toEqual(["low_credit_check_failed"]);
    expect(h.db.tables.tenants![0]!.low_credit_notified_at).toBeNull();
  });
});

describe("queuePaymentsCredited: one batch for every deposit a scan credited", () => {
  it("reads balance_after from the purchase ledger rows and queues one event each, in three calls", async () => {
    newDb(0, { webhook_endpoints: [hook(["payment.credited"]), { ...hook(["payment.credited"]), id: "e2", tenant_id: "t2" }] });
    h.db.tables.tenants!.push({ id: "t2", credits_balance: 0, deleted_at: null });
    ledgerInsert(h.db, { tenant_id: "t1", delta: 5_000, reason: "purchase", tx_hash: "0xa1", log_index: 0, balance_after: 5_000 });
    ledgerInsert(h.db, { tenant_id: "t2", delta: 27_500, reason: "purchase", tx_hash: "0xa2", log_index: 7, balance_after: 27_500 });
    h.db.calls.length = 0;
    const r = await queuePaymentsCredited(env, [
      { tenant: "t1", tx: "0xa1", logIndex: 0, amountUsdc: "50", credits: 5_000 },
      { tenant: "t2", tx: "0xa2", logIndex: 7, amountUsdc: "250.000000", credits: 27_500 },
    ]);
    expect(r).toEqual({ queued: 2, error: null });
    expect(h.db.calls).toHaveLength(3);
    expect(h.db.tables.webhook_deliveries!.map((d) => [d.tenant_id, d.payload])).toEqual([
      ["t1", { tx_hash: "0xa1", log_index: 0, amount_usdc: "50", credits: 5_000, balance_after: 5_000 }],
      ["t2", { tx_hash: "0xa2", log_index: 7, amount_usdc: "250", credits: 27_500, balance_after: 27_500 }],
    ]);
  });
  it("a deposit without its ledger row is reported, never sent with a made-up balance", async () => {
    newDb(0);
    const r = await queuePaymentsCredited(env, [{ tenant: "t1", tx: "0xmissing", logIndex: 1, amountUsdc: "50", credits: 5_000 }]);
    expect(r).toEqual({ queued: 0, error: "no purchase ledger row for 0xmissing#1" });
    expect(h.db.tables.webhook_deliveries).toEqual([]);
  });
});

// ---- POST /v1/resolve: the charge that crosses notifies ----------------------------------------------------------------

const market = MarketRegistration.parse({
  external_id: "t-1", condition: "Will PR #4821 in openai/openai-python be merged before 2026-10-01 00:00 UTC?", event_statement: "PR #4821 in openai/openai-python is merged",
  option_a: "Yes, merged before the deadline", option_b: "No, not merged before the deadline", positive_option: "OPTION_A", anchors: ["openai/openai-python", "#4821"],
  sources: [{ kind: "web_fetch", ref: "https://github.com/openai/openai-python" }], open_at: "2026-09-01T00:00:00Z", deadline_utc: "2026-10-01T00:00:00Z",
});
const body = JSON.stringify({ market, evidence: { source_kind: "web_fetch", source_url: "https://github.com/openai/openai-python/releases/tag/v1.52.0",
  text: "Release notes for openai/openai-python. Pull request #4821 (add retries to the streaming client) was merged by the maintainers on 2026-09-20 and shipped in v1.52.0. The change is live on PyPI and the changelog lists #4821 under Fixed." } });

describe("POST /v1/resolve: credits.low on the charge that crosses the threshold, off the response path", () => {
  it("notifies once, under waitUntil", async () => {
    newDb(507, { markets: [{ id: "m1", tenant_id: "t1", ...market }], resolutions: [], api_request_log: [] });
    h.db.options.rpc = { ...MONEY_RPCS, begin_resolution: async (db, a) => {
      const t = db.tables.tenants!.find((x) => x.id === a.p_tenant)!;
      t.credits_balance -= a.p_amount;
      const id = `req${db.tables.resolutions!.length}`;
      db.tables.resolutions!.push({ id, tenant_id: a.p_tenant, status_row: "pending", credits_charged: a.p_amount });
      ledgerInsert(db, { tenant_id: a.p_tenant, delta: -a.p_amount, reason: "charge", request_id: id, balance_after: t.credits_balance });
      return { data: [{ request_id: id, replayed: false, ok: true, balance: t.credits_balance, charged: a.p_amount }], error: null };
    } };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const post = async () => { const res = await v1.request("/resolve", { method: "POST", headers: { "content-type": "application/json" }, body }, env, ctx); await Promise.all(pending.splice(0)); return res; };
    expect((await post()).status).toBe(200); // 502: above the threshold
    expect(lowEvents()).toHaveLength(0);
    expect((await post()).status).toBe(200); // 497: crossed
    expect(lowEvents().map((d) => d.payload)).toEqual([{ balance: 497, threshold: 500, request_id: "req1", top_up: "/pricing" }]);
    expect((await post()).status).toBe(200); // 492: already notified
    expect(lowEvents()).toHaveLength(1);
  });
});

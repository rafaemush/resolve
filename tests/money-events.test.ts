/**
 * Money events (plan §16.4 P3 step 3): the payment.credited and credits.low payloads, credits.low once per crossing
 * (claim_low_credit_notice() and the purchase/grant reset of migration 020, as stand-ins over the in-memory database),
 * a notice whose event could not be queued given back instead of lost, and POST /v1/resolve notifying on the charge that
 * crosses the threshold and never again until a purchase or grant. The money path's pointers (plan §22.3 #1, #2): the
 * 402 and credits.low point to the card rail while card checkout is offered, else to support, and never to the USDC
 * address; GET /v1/payments/address refuses unless USDC_DEPOSITS_OFFERED is exactly "1"; each crossing alerts the
 * operator once ("first paid use" on the free plan), never with the key or an email, and no alert can fail the charge.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { ledgerInsert, MIGRATION_020_CONFIG, MONEY_RPCS } from "./lib/fake-money";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb, failInsert: false, failAlerts: false, plan: "payg",
  alerts: [] as Array<{ key: string; text: string; meta: Record<string, unknown>; many: boolean; batch: number }>, batches: 0,
}));
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
vi.mock("../src/ops/alerts", () => ({
  alert: vi.fn(async (_env: unknown, key: string, text: string, opts?: { meta?: Record<string, unknown> }) => {
    h.alerts.push({ key, text, meta: opts?.meta ?? {}, many: false, batch: ++h.batches });
    return { sent: true, deduped: false };
  }),
  alertMany: vi.fn(async (_env: unknown, items: Array<{ key: string; text: string; meta?: Record<string, unknown> }>) => {
    if (h.failAlerts) throw new Error("alert store down");
    const batch = ++h.batches;
    for (const i of items) h.alerts.push({ key: i.key, text: i.text, meta: i.meta ?? {}, many: true, batch });
    return { sent: items.map((i) => i.key), deduped: [] };
  }),
}));
vi.mock("../src/api/auth", () => ({
  authenticate: async () => ({ ok: true, auth: { keyId: "k1", tenantId: "t1", plan: h.plan, strictV0: false, environment: "test", scopes: [], requestsToday: 0, dailyCap: 1000 } }),
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

import { creditsLowAlert, creditsLowPayload, noteCharge, paymentCreditedPayload, queuePaymentsCredited } from "../src/billing/events";
import { topUp, topUpText, usdcDepositsOffered, type TopUp } from "../src/billing/top-up";
import { v1 } from "../src/api/v1";
import { MarketRegistration } from "../src/resolve/schema";
import { PLAN_20, PLAN_250, PLAN_50 } from "./lib/fake-whop";

const env = { JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "60", SPOTLIGHT_SECRET: "eval-spotlight-v1", SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized", INTERNAL_HMAC_SECRET: "x", ADMIN_API_KEY: "x", EVAL_REPORT_KEY: "x", JEV_PAID_ROUTES_ENABLED: "1" } as unknown as Env;
/** The USDC receiving address as production holds one (set for the deposit scan): no tenant answer may carry it. */
const USDC_ADDRESS = "0x00000000000000000000000000000000000000ee";
/** Card checkout switched on and configured (wrangler.toml's plan ids for $20; test plans for the others). */
const card = { ...env, RESOLVE_PUBLIC_URL: "https://resolve.example.com/", USDC_RECEIVING_ADDRESS: USDC_ADDRESS, WHOP_CHECKOUT_ENABLED: "1", WHOP_API_KEY: "whop_api_key_test", WHOP_PLAN_ID_20: PLAN_20, WHOP_PLAN_ID_50: PLAN_50, WHOP_PLAN_ID_250: PLAN_250 } as unknown as Env;
const noCard = { ...card, WHOP_CHECKOUT_ENABLED: "0" } as unknown as Env;
const CARD_TOP_UP: TopUp = {
  method: "card", checkout: "POST /v1/billing/checkout", page: "https://resolve.example.com/pricing#pay-by-card",
  packs: [{ pack: "20", price: "20.00", currency: "usd", credits: 2000 }, { pack: "50", price: "50.00", currency: "usd", credits: 5000 }, { pack: "250", price: "250.00", currency: "usd", credits: 27500 }],
};
const hook = (events: string[]): Row => ({ id: "e1", tenant_id: "t1", url: "https://hooks.example/e1", secret: "s", active: true, deleted_at: null, events, consecutive_failures: 0 });
const lowEvents = () => (h.db.tables.webhook_deliveries ?? []).filter((d) => d.event_type === "credits.low");
const alertKeys = () => h.alerts.map((a) => a.key);
/** Nothing a tenant reads may point at USDC: not the address, not the route that serves it. */
const expectNoUsdc = (s: string) => { expect(s).not.toContain(USDC_ADDRESS); expect(s.toLowerCase()).not.toContain("payments/address"); expect(s).not.toMatch(/usdc/i); };

function newDb(balance: number, extra: Record<string, Row[]> = {}, plan = "payg") {
  h.failInsert = false;
  h.db = fakeDb({
    tenants: [{ id: "t1", plan, credits_balance: balance, deleted_at: null, low_credit_notified_at: null }],
    app_config: structuredClone(MIGRATION_020_CONFIG), credit_ledger: [], webhook_endpoints: [hook(["credits.low", "payment.credited"])], webhook_deliveries: [], ...extra,
  }, {}, { rpc: MONEY_RPCS });
}
/** A charge the way begin_resolution makes it: balance down, one ledger row (no reset: a charge never clears the notice). */
const charge = (n: number) => { const t = h.db.tables.tenants![0]!; t.credits_balance -= n; ledgerInsert(h.db, { tenant_id: "t1", delta: -n, reason: "charge", request_id: `r${h.db.tables.credit_ledger!.length}`, balance_after: t.credits_balance }); };
const grant = (n: number) => { const t = h.db.tables.tenants![0]!; t.credits_balance += n; ledgerInsert(h.db, { tenant_id: "t1", delta: n, reason: "grant", request_id: null, balance_after: t.credits_balance }); };

beforeEach(() => { h.alerts = []; h.batches = 0; h.failAlerts = false; h.plan = "payg"; });

describe("payload builders", () => {
  it("payment.credited: exactly tx_hash, log_index, amount_usdc (exact decimal), credits, balance_after", () => {
    expect(paymentCreditedPayload({ tx_hash: "0xABC", log_index: 2, amount_usdc: "250.500000", credits: 27_555, balance_after: 30_000 }))
      .toEqual({ tx_hash: "0xabc", log_index: 2, amount_usdc: "250.5", credits: 27_555, balance_after: 30_000 });
  });
  it("credits.low: the balance, the threshold it fell below, the charge that crossed it, where to top up", () => {
    expect(creditsLowPayload({ balance: 499, threshold: 500, request_id: "r1", top_up: CARD_TOP_UP })).toEqual({ balance: 499, threshold: 500, request_id: "r1", top_up: CARD_TOP_UP });
  });
});

describe("the top-up pointer: the card rail while it is offered, else support, never USDC", () => {
  it("offered: POST /v1/billing/checkout, the pricing page's card form and the three packs; the public origin as configured", () => {
    expect(topUp(card, "https://resolve.example.com")).toEqual(CARD_TOP_UP);
    expect(topUpText(CARD_TOP_UP)).toBe('Top up by card: POST /v1/billing/checkout with {"pack": "20" | "50" | "250"} answers a checkout_url, or use the form at https://resolve.example.com/pricing#pay-by-card.');
    expect(topUp(card, null)).toMatchObject({ method: "card", page: "/pricing#pay-by-card" });
  });
  it("not offered (switched off, or a plan id missing): contact support, never the USDC route or address", () => {
    for (const e of [noCard, { ...card, WHOP_PLAN_ID_20: "" }, { ...card, WHOP_API_KEY: "" }, env] as Env[]) {
      const t = topUp(e, "https://resolve.example.com");
      expect(t).toEqual({ method: "contact_support", page: "https://resolve.example.com/terms#contact" });
      expect(topUpText(t)).toContain("contact support");
      expectNoUsdc(JSON.stringify(t) + topUpText(t));
    }
  });
  it("USDC deposits are offered only by the exact string \"1\"", () => {
    for (const v of [undefined, "", "0", "true", "yes", " 1", "1 "]) expect(usdcDepositsOffered({ USDC_DEPOSITS_OFFERED: v }), String(v)).toBe(false);
    expect(usdcDepositsOffered({ USDC_DEPOSITS_OFFERED: "1" })).toBe(true);
  });
});

describe("the operator's credits.low alert (plan §22.3 #2)", () => {
  it("tenant, plan, balance, threshold and the pay-by-card page; 'first paid use' on the free plan; keyed per crossing", () => {
    const a = creditsLowAlert({ tenantId: "t1", plan: "free", balance: 299, threshold: 500, requestId: "req-9", topUp: CARD_TOP_UP });
    expect(a.key).toBe("credits_low_t1_req-9");
    for (const s of ["Credits low: first paid use (free plan)", "Tenant: t1", "Plan: free", "Balance: 299, below the threshold of 500, after charge req-9", "Pay by card: https://resolve.example.com/pricing#pay-by-card", "$20 = 2000 credits"]) expect(a.text).toContain(s);
    expect(a.meta).toMatchObject({ tenant_id: "t1", request_id: "req-9", plan: "free", balance: 299, threshold: 500, first_paid_use: true, top_up: "card" });
    const paid = creditsLowAlert({ tenantId: "t1", plan: "payg", balance: 480, threshold: 500, requestId: "req-10", topUp: { method: "contact_support", page: "/terms#contact" } });
    expect(paid.text).not.toContain("first paid use");
    expect(paid.text).toContain("Card checkout is not offered");
    expect(creditsLowAlert({ tenantId: "t1", plan: null, balance: 1, threshold: 500, requestId: "r", topUp: CARD_TOP_UP }).text).toContain("Plan: unknown");
  });
  it("'first paid use' is the free plan's label alone: never on another plan, nor on a plan that could not be read", () => {
    for (const plan of ["payg", "builder", "growth", "platform", null, "Free", "free "]) {
      const a = creditsLowAlert({ tenantId: "t1", plan, balance: 1, threshold: 500, requestId: "r", topUp: CARD_TOP_UP });
      expect(a.text, String(plan)).not.toContain("first paid use");
      expect(a.text.split("\n")[0], String(plan)).toBe("Credits low");
      expect(a.meta!.first_paid_use, String(plan)).toBe(false);
    }
  });
});

describe("noteCharge: credits.low once per crossing", () => {
  it("fires on the charge that crosses, not again, and again only after a purchase or grant", async () => {
    newDb(510);
    charge(5); // 505: above
    expect(await noteCharge(env, "t1", "r-a")).toEqual({ crossed: false, queued: 0 });
    charge(10); // 495: crossed
    expect(await noteCharge(env, "t1", "r-b")).toEqual({ crossed: true, queued: 1 });
    expect(lowEvents().map((d) => d.payload)).toEqual([{ balance: 495, threshold: 500, request_id: "r-b", top_up: { method: "contact_support", page: "/terms#contact" } }]);
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
    // the operator hears of each crossing once, the charges between them say nothing
    expect(alertKeys()).toEqual(["credits_low_t1_r-b", "credits_low_t1_r-e"]);
  });

  it("while card checkout is offered, credits.low's top_up is the card rail at the public origin, never the USDC address", async () => {
    newDb(400);
    expect(await noteCharge(card, "t1", "r1")).toEqual({ crossed: true, queued: 1 });
    expect(lowEvents().map((d) => d.payload.top_up)).toEqual([CARD_TOP_UP]);
    expectNoUsdc(JSON.stringify(lowEvents()));
    expectNoUsdc(JSON.stringify(h.alerts));
    // the base a route passes (the request's origin) wins over the configured one
    newDb(400);
    await noteCharge(card, "t1", "r2", { base: "https://other.example" });
    expect(lowEvents()[0]!.payload.top_up.page).toBe("https://other.example/pricing#pay-by-card");
  });

  it("the plan comes from the caller when it has it, else one read at the crossing; an unreadable plan still alerts", async () => {
    newDb(400, {}, "free");
    h.db.calls.length = 0;
    await noteCharge(card, "t1", "r1");
    expect(h.db.calls.map((c) => c.table)).toEqual(["rpc:claim_low_credit_notice", "webhook_endpoints", "webhook_deliveries", "tenants"]);
    expect(h.alerts[0]!.text).toContain("first paid use");
    newDb(400, {}, "free");
    h.db.calls.length = 0;
    h.alerts = [];
    await noteCharge(card, "t1", "r2", { plan: "payg" });
    expect(h.db.calls.map((c) => c.table)).toEqual(["rpc:claim_low_credit_notice", "webhook_endpoints", "webhook_deliveries"]);
    expect(h.alerts[0]!.text).toContain("Plan: payg");
    newDb(400);
    h.alerts = [];
    h.db.tables.tenants![0]!.plan = 7; // not a plan: never guessed
    await noteCharge(card, "t1", "r3");
    expect(h.alerts[0]!.text).toContain("Plan: unknown");
  });

  it("an operator alert that fails never fails the charge nor the event", async () => {
    newDb(400);
    h.failAlerts = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await noteCharge(card, "t1", "r1")).toEqual({ crossed: true, queued: 1 });
      expect(lowEvents()).toHaveLength(1);
      expect(h.db.tables.tenants![0]!.low_credit_notified_at).not.toBeNull();
    } finally { errors.mockRestore(); }
  });

  it("the threshold is data: app_config low_credit_threshold (500 when absent)", async () => {
    newDb(120);
    h.db.tables.app_config!.find((r) => r.key === "low_credit_threshold")!.value = "100";
    expect((await noteCharge(env, "t1", "r1")).crossed).toBe(false);
    h.db.tables.app_config = h.db.tables.app_config!.filter((r) => r.key !== "low_credit_threshold");
    expect((await noteCharge(env, "t1", "r2")).crossed).toBe(true);
  });

  it("an event that could not be queued gives the notice back (the next charge retries); the operator hears of the crossing at once, in the failure's DM", async () => {
    newDb(400);
    h.failInsert = true;
    expect(await noteCharge(card, "t1", "r1", { plan: "free" })).toEqual({ crossed: true, queued: 0 });
    expect(h.db.tables.tenants![0]!.low_credit_notified_at).toBeNull();
    expect(h.alerts.map((a) => [a.key, a.batch])).toEqual([["low_credit_event_failed_t1", 1], ["credits_low_t1_r1", 1]]);
    expect(h.alerts[0]!.text).toContain("given back: the next charge queues it again");
    expect(h.alerts[1]!.text).toContain("first paid use");
    // the charge that claims it again queues credits.low and says so, for that charge
    h.failInsert = false;
    expect(await noteCharge(card, "t1", "r2")).toEqual({ crossed: true, queued: 1 });
    expect(alertKeys()).toEqual(["low_credit_event_failed_t1", "credits_low_t1_r1", "credits_low_t1_r2"]);
  });

  it("the failure alert is keyed per tenant: a second tenant's failure in the same hour is not deduplicated into the first", async () => {
    newDb(400);
    h.db.tables.tenants!.push({ id: "t2", plan: "free", credits_balance: 300, deleted_at: null, low_credit_notified_at: null });
    h.db.tables.webhook_endpoints!.push({ ...hook(["credits.low"]), id: "e2", tenant_id: "t2" });
    h.failInsert = true;
    await noteCharge(card, "t1", "r1");
    await noteCharge(card, "t2", "r2");
    expect(alertKeys()).toEqual(["low_credit_event_failed_t1", "credits_low_t1_r1", "low_credit_event_failed_t2", "credits_low_t2_r2"]);
  });

  it("a notice that could not be given back either: the operator's alert goes now, in the same DM as the failure", async () => {
    newDb(400);
    h.failInsert = true;
    h.db.options.rpc = { ...MONEY_RPCS, release_low_credit_notice: async () => ({ data: null, error: { code: "57014", message: "statement timeout" } }) };
    expect(await noteCharge(card, "t1", "r1", { plan: "free" })).toEqual({ crossed: true, queued: 0 });
    expect(h.alerts.map((a) => [a.key, a.batch])).toEqual([["low_credit_event_failed_t1", 1], ["credits_low_t1_r1", 1]]);
    expect(h.alerts[0]!.text).toContain("not given back either");
    expect(h.alerts[1]!.text).toContain("first paid use");
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
    expect(lowEvents().map((d) => d.payload)).toEqual([{ balance: 497, threshold: 500, request_id: "req1", top_up: { method: "contact_support", page: "http://localhost/terms#contact" } }]);
    expect((await post()).status).toBe(200); // 492: already notified
    expect(lowEvents()).toHaveLength(1);
    expect(alertKeys()).toEqual(["credits_low_t1_req1"]);
  });
});

// ---- the 402, the operator alert on a charge, GET /v1/payments/address ------------------------------------------------

const KEY = `rsl_test_${"k3y".repeat(10)}xy`;
/** begin_resolution over the in-memory database: charges when the balance covers it, else answers ok=false (the 402). */
function resolvingDb(balance: number, plan = "free") {
  h.plan = plan; // the key's plan (auth), which the route passes on: no plan read
  newDb(balance, { markets: [{ id: "m1", tenant_id: "t1", ...market }], resolutions: [], api_request_log: [] }, plan);
  h.db.options.rpc = { ...MONEY_RPCS, begin_resolution: async (db, a) => {
    const t = db.tables.tenants!.find((x) => x.id === a.p_tenant)!;
    const id = `req${db.tables.resolutions!.length}`;
    if (t.credits_balance < a.p_amount) return { data: [{ request_id: id, replayed: false, ok: false, balance: t.credits_balance, charged: 0 }], error: null };
    t.credits_balance -= a.p_amount;
    db.tables.resolutions!.push({ id, tenant_id: a.p_tenant, status_row: "pending", credits_charged: a.p_amount });
    ledgerInsert(db, { tenant_id: a.p_tenant, delta: -a.p_amount, reason: "charge", request_id: id, balance_after: t.credits_balance });
    return { data: [{ request_id: id, replayed: false, ok: true, balance: t.credits_balance, charged: a.p_amount }], error: null };
  } };
}
async function resolveWith(e: Env): Promise<{ status: number; text: string }> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await v1.request("/resolve", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body }, e, ctx);
  await Promise.all(pending);
  return { status: res.status, text: await res.text() };
}

describe("POST /v1/resolve's 402 points to the card rail, never to USDC", () => {
  it("card checkout offered: the message and top_up name POST /v1/billing/checkout and the pricing page's card form", async () => {
    resolvingDb(3);
    const r = await resolveWith(card);
    expect(r.status).toBe(402);
    const j = JSON.parse(r.text);
    expect(j).toMatchObject({ ok: false, error: { code: "insufficient_credits" }, balance: 3, price_credits: 5, route: "web_evidence", top_up: CARD_TOP_UP });
    expect(j.error.message).toBe(`This request costs 5 credit(s); balance is 3. ${topUpText(CARD_TOP_UP)}`);
    expectNoUsdc(r.text);
  });
  it("not offered: contact support; with RESOLVE_PUBLIC_URL unset the request's own origin", async () => {
    resolvingDb(3);
    const r = await resolveWith({ ...noCard, RESOLVE_PUBLIC_URL: undefined } as unknown as Env);
    const j = JSON.parse(r.text);
    expect(j.top_up).toEqual({ method: "contact_support", page: "http://localhost/terms#contact" });
    expect(j.error.message).toContain("contact support");
    expectNoUsdc(r.text);
  });
  it("the USDC address never appears, whatever USDC_DEPOSITS_OFFERED says", async () => {
    for (const USDC_DEPOSITS_OFFERED of [undefined, "0", "true", "1"]) {
      for (const e of [card, noCard]) {
        resolvingDb(0);
        expectNoUsdc((await resolveWith({ ...e, USDC_DEPOSITS_OFFERED } as Env)).text);
      }
    }
  });
});

describe("a charge that crosses the threshold alerts the operator once, never with the key", () => {
  it("a free key's first charge crosses (300 < 500): one alert naming 'first paid use' and the card page; the next charge none", async () => {
    resolvingDb(300, "free");
    expect((await resolveWith(card)).status).toBe(200);
    expect(alertKeys()).toEqual(["credits_low_t1_req0"]);
    const a = h.alerts[0]!;
    for (const s of ["first paid use", "Tenant: t1", "Plan: free", "Balance: 295, below the threshold of 500, after charge req0", "https://resolve.example.com/pricing#pay-by-card"]) expect(a.text).toContain(s);
    expect((await resolveWith(card)).status).toBe(200);
    expect(alertKeys()).toEqual(["credits_low_t1_req0"]);
    // a grant resets the notice: the next charge below the threshold alerts again, once
    grant(200); // 490
    expect((await resolveWith(card)).status).toBe(200);
    expect(alertKeys()).toEqual(["credits_low_t1_req0", "credits_low_t1_req2"]);
    const all = JSON.stringify(h.alerts);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(KEY.slice("rsl_test_".length));
    expect(all).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expectNoUsdc(all);
  });
  it("the route passes the key's plan: no plan read at the crossing, and the key's plan is the one alerted", async () => {
    resolvingDb(300, "free");
    h.db.tables.tenants![0]!.plan = "payg"; // the row says otherwise: the alert must carry the key's plan, not read it
    h.db.calls.length = 0;
    expect((await resolveWith(card)).status).toBe(200);
    expect(h.db.calls.filter((c) => c.table === "tenants")).toEqual([]);
    expect(h.alerts[0]!.text).toContain("Plan: free");
    expect(h.alerts[0]!.text).toContain("first paid use");
  });
  it("a crossing that empties the balance and whose event could not be queued still reaches the operator: the next request is a 402 and charges nothing", async () => {
    resolvingDb(5, "free");
    h.failInsert = true;
    expect((await resolveWith(card)).status).toBe(200); // 0 left: crossed
    expect(alertKeys()).toEqual(["low_credit_event_failed_t1", "credits_low_t1_req0"]);
    expect(h.alerts[1]!.text).toContain("first paid use");
    expect((await resolveWith(card)).status).toBe(402);
    expect(alertKeys()).toEqual(["low_credit_event_failed_t1", "credits_low_t1_req0"]);
  });
  it("a failing alert store never fails the charge's answer", async () => {
    resolvingDb(300, "free");
    h.failAlerts = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const r = await resolveWith(card);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text).data).toMatchObject({ credits_charged: 5, balance: 295 });
      expect(lowEvents()).toHaveLength(1);
    } finally { errors.mockRestore(); }
  });
});

describe("GET /v1/payments/address: only while USDC_DEPOSITS_OFFERED is exactly \"1\"", () => {
  const get = async (e: Env) => { const res = await v1.request("/payments/address", { method: "GET", headers: { authorization: `Bearer ${KEY}` } }, e, { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext); return { status: res.status, text: await res.text() }; };
  it("refuses with 503 'USDC deposits are not offered' and the card pointer, before reading anything, with the address set", async () => {
    for (const USDC_DEPOSITS_OFFERED of [undefined, "", "0", "true", "yes"]) {
      newDb(0, { app_config: [] });
      h.db.calls.length = 0;
      const r = await get({ ...card, USDC_DEPOSITS_OFFERED } as Env);
      expect(r.status, String(USDC_DEPOSITS_OFFERED)).toBe(503);
      const j = JSON.parse(r.text);
      expect(j).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" }, error_reason: "USDC_NOT_OFFERED", top_up: CARD_TOP_UP });
      expect(j.error.message).toMatch(/^USDC deposits are not offered\. Top up by card: /);
      expect(r.text).not.toContain(USDC_ADDRESS);
      expect(h.db.calls.filter((c) => c.table !== "api_request_log")).toEqual([]);
    }
  });
  it("\"1\" serves the address as before (the founder's switch); tests/wallet.test.ts covers its tiers", async () => {
    newDb(0, { app_config: structuredClone(MIGRATION_020_CONFIG) });
    const r = await get({ ...card, USDC_DEPOSITS_OFFERED: "1" } as Env);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).data).toMatchObject({ chain: "base", token: "USDC", receiving_address: USDC_ADDRESS });
  });
});

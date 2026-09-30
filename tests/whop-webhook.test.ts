/**
 * POST /webhooks/whop end to end over the in-memory database with the stand-ins of grant_credits and rate_limit_hit
 * (tests/lib/fake-whop.ts): an unverified request (no, wrong, stale or tampered signature) is refused with 401 and
 * touches nothing; a verified payment of a pack credits its tenant exactly once whatever repeats, and moves a free
 * tenant to payg with its key's expiry cleared while every other plan is left alone; a wrong amount or currency, an
 * unknown plan, a missing or deleted tenant grant nothing and alert; refunds and disputes take back their share once,
 * never more than the payment granted and never below a zero balance (the shortfall is alerted, never thrown); a refund
 * or formal dispute processed before its payment is credited stops the automatic grant; unknown event types are ignored
 * and logged without the body; every answer is no-store; no alert carries the buyer's full email address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { PLAN_20, PLAN_250, PLAN_50, WHOP_RPCS, WHOP_SECRET, disputeEvent, envelope, nativeRefundEvent, paymentSucceeded, refundEvent, whopMoney, whopRequest } from "./lib/fake-whop";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  alerts: [] as Array<{ key: string; text: string; meta: Record<string, unknown> }>,
  /** "<table>.<action>" or "rpc:<fn>" -> answer a database error instead. */
  broken: null as null | ((what: string, args?: Record<string, any>) => boolean),
  /** Runs before an rpc, outside its transaction: another request's write landing just before this one. */
  before: null as null | ((fn: string, args: Record<string, any>) => void),
}));
vi.mock("../src/db/supabase", () => ({
  db: () => client(),
  rpc: async (c: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await c.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/ops/alerts", () => ({
  alert: vi.fn(async (_env: unknown, key: string, text: string, opts?: { meta?: Record<string, unknown> }) => { h.alerts.push({ key, text, meta: opts?.meta ?? {} }); return { sent: true, deduped: false }; }),
}));

import { app } from "../src/index";
import { upgradeIfFree } from "../src/billing/whop-events";

const DOWN = { code: "08006", message: "connection failure" };
function client(): FakeDb["client"] {
  const base = h.db.client;
  return {
    rpc: async (fn: string, args: Record<string, any>) => {
      if (h.broken?.(`rpc:${fn}`, args)) { h.db.calls.push({ table: `rpc:${fn}`, action: "rpc" }); return { data: null, error: DOWN }; }
      h.before?.(fn, args);
      return base.rpc(fn, args);
    },
    from: (t: string) => new Proxy(base.from(t), {
      get(o: any, k) {
        if (k !== "select" && k !== "update" && k !== "insert") return Reflect.get(o, k);
        return (...args: any[]) => {
          if (h.broken?.(`${t}.${String(k)}`)) {
            h.db.calls.push({ table: t, action: String(k) });
            const p: any = new Proxy(() => undefined, { get: (_x, kk) => (kk === "then" ? (ok: any) => Promise.resolve({ data: null, error: DOWN }).then(ok) : kk === "single" || kk === "maybeSingle" ? () => Promise.resolve({ data: null, error: DOWN }) : () => p) });
            return p;
          }
          return o[k](...args);
        };
      },
    }) as any,
  } as FakeDb["client"];
}

const NOW = Date.parse("2026-09-30T12:00:00Z");
const DAY = 86_400_000;
const FREE = "11111111-1111-4111-8111-111111111111";
const BUILDER = "22222222-2222-4222-8222-222222222222";
const PAYG = "33333333-3333-4333-8333-333333333333";
const GONE = "44444444-4444-4444-8444-444444444444";
const env = { WHOP_WEBHOOK_SECRET: WHOP_SECRET, WHOP_PLAN_ID_20: PLAN_20, WHOP_PLAN_ID_50: PLAN_50, WHOP_PLAN_ID_250: PLAN_250, WHOP_API_KEY: "whop_api_key_test", WHOP_CHECKOUT_ENABLED: "0" } as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const send = (event: unknown, o: Parameters<typeof whopRequest>[1] = {}, e: Env = env) => app.request("/webhooks/whop", whopRequest(event, o), e, ctx);
const rows = (t: string) => h.db.tables[t] ?? [];
const tenant = (id: string) => rows("tenants").find((t) => t.id === id)!;
const ledger = () => rows("credit_ledger");

function seed(): FakeDb {
  const tenants: Row[] = [
    { id: FREE, display_name: "Ada (web form)", plan: "free", credits_balance: 300, watch_limit: 5, deleted_at: null },
    { id: BUILDER, display_name: "Builder Co", plan: "builder", credits_balance: 12000, watch_limit: 50, deleted_at: null },
    { id: PAYG, display_name: "Payg Co", plan: "payg", credits_balance: 100, watch_limit: 5, deleted_at: null },
    { id: GONE, display_name: "Gone Co", plan: "free", credits_balance: 0, watch_limit: 5, deleted_at: "2026-09-29T00:00:00Z" },
  ];
  const api_keys: Row[] = [
    // the free tenant rotated once: the old key's overlap ends soon, the new key keeps the 30-day evaluation expiry
    { id: "k-free-old", tenant_id: FREE, name: "request-key", environment: "test", expires_at: new Date(NOW + 3600_000).toISOString(), revoked_at: null, deleted_at: null, created_at: new Date(NOW - 10 * DAY).toISOString() },
    { id: "k-free-new", tenant_id: FREE, name: "rotated", environment: "test", expires_at: new Date(NOW + 20 * DAY).toISOString(), revoked_at: null, deleted_at: null, created_at: new Date(NOW - 3600_000).toISOString() },
    { id: "k-builder", tenant_id: BUILDER, name: "initial", environment: "live", expires_at: new Date(NOW + 5 * DAY).toISOString(), revoked_at: null, deleted_at: null, created_at: new Date(NOW - 50 * DAY).toISOString() },
  ];
  return fakeDb({ tenants, api_keys, credit_ledger: [] }, {}, { rpc: WHOP_RPCS });
}

let logs: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  h.db = seed();
  h.alerts = [];
  h.broken = null;
  h.before = null;
  logs = [];
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
});
afterEach(() => { vi.useRealTimers(); for (const s of spies) s.mockRestore(); });

async function expectAnswer(res: Response, status: number, result?: string): Promise<Record<string, any>> {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.status).toBe(status);
  const body = (await res.json()) as Record<string, any>;
  if (result) expect(body.data?.result ?? body.result).toBe(result);
  return body;
}

describe("only Whop's signed requests are believed", () => {
  const cases: Array<[string, Parameters<typeof whopRequest>[1]]> = [
    ["no signature header", { signature: null }],
    ["a signature that is not the HMAC of this request", { signature: `v1,${"A".repeat(43)}=` }],
    ["another secret", { secret: `${WHOP_SECRET}x` }],
    ["a timestamp 301 s old", { ts: NOW / 1000 - 301 }],
    ["a timestamp 301 s ahead", { ts: NOW / 1000 + 301 }],
    ["a tampered body", { signedBody: JSON.stringify(paymentSucceeded(FREE, { total: whopMoney("1.00") })) }],
  ];
  for (const [label, o] of cases) {
    it(`${label}: 401, nothing read, written or alerted`, async () => {
      const res = await send(paymentSucceeded(FREE), o);
      const body = await expectAnswer(res, 401);
      expect(body.error.code).toBe("invalid_signature");
      expect(h.db.calls).toEqual([]);
      expect(h.alerts).toEqual([]);
      expect(ledger()).toEqual([]);
      expect(tenant(FREE)).toMatchObject({ plan: "free", credits_balance: 300 });
      // the refusal is logged by reason only: nothing of the request
      expect(logs.join("\n")).not.toMatch(/pay_test50|buyer@|resolve_tenant_id/);
    });
  }

  it("a secret that is not set refuses every request with 503 (Whop retries) and alerts once by name", async () => {
    const res = await send(paymentSucceeded(FREE), {}, { ...env, WHOP_WEBHOOK_SECRET: "" } as Env);
    await expectAnswer(res, 503);
    expect(ledger()).toEqual([]);
    expect(h.alerts.map((a) => a.key)).toEqual(["whop_config_missing"]);
    expect(h.alerts[0]!.text).toContain("WHOP_WEBHOOK_SECRET");
  });

  it("a verified test event of a type Resolve does not act on is answered 200 and ignored, logged without its body", async () => {
    const res = await send(envelope("membership.activated", { id: "mem_1", user: { email: "someone@example.com" } }));
    await expectAnswer(res, 200, "ignored");
    expect(h.db.calls).toEqual([]);
    expect(h.alerts).toEqual([]);
    expect(logs.some((l) => l.includes('"outcome":"ignored"') && l.includes("membership.activated"))).toBe(true);
    expect(logs.join("\n")).not.toContain("someone@example.com");
  });
});

describe("a verified payment of a pack credits its tenant exactly once", () => {
  it("free tenant: 5,000 credits under whop:<payment id>, the plan moves to payg and the newest key stops expiring", async () => {
    // with card checkout switched off: the webhook verifies and records either way (a dashboard test event is answered)
    expect(env.WHOP_CHECKOUT_ENABLED).toBe("0");
    const body = await expectAnswer(await send(paymentSucceeded(FREE)), 200, "credited");
    expect(body.data).toMatchObject({ payment_id: "pay_test50", tenant_id: FREE, credits: 5000, balance: 5300 });
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]).toMatchObject({ tenant_id: FREE, delta: 5000, reason: "grant", request_id: "whop:pay_test50", balance_after: 5300 });
    expect(tenant(FREE)).toMatchObject({ plan: "payg", watch_limit: 5, credits_balance: 5300 });
    // the evaluation key (the rotated-in newest one) no longer expires; the rotated-out key keeps its own end
    expect(rows("api_keys").find((k) => k.id === "k-free-new")!.expires_at).toBeNull();
    expect(rows("api_keys").find((k) => k.id === "k-free-old")!.expires_at).toBe(new Date(NOW + 3600_000).toISOString());
    // one alert per credited payment: tenant, pack, payment id, never the buyer's full email
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.key).toBe("whop_payment_pay_test50");
    for (const s of ["Card payment credited (Whop): $50.00 pack, 5000 credits", `Tenant: ${FREE}`, "Whop payment: pay_test50", "b***@example.com", "Balance now: 5300", "free -> payg"]) expect(h.alerts[0]!.text).toContain(s);
    expect(JSON.stringify(h.alerts)).not.toContain("buyer@example.com");
    expect(h.alerts[0]!.meta).toMatchObject({ tenant_id: FREE, pack: "50", payment_id: "pay_test50", credits: 5000, plan_change: "upgraded" });
  });

  it("a replayed event, and the same payment under another webhook-id, grant nothing more and answer 200 already_processed", async () => {
    const ev = paymentSucceeded(FREE);
    await expectAnswer(await send(ev, { id: "msg_same" }), 200, "credited");
    await expectAnswer(await send(ev, { id: "msg_same" }), 200, "already_processed");
    await expectAnswer(await send(paymentSucceeded(FREE, {}, "msg_other_event")), 200, "already_processed");
    expect(ledger()).toHaveLength(1);
    expect(tenant(FREE).credits_balance).toBe(5300);
    expect(h.alerts.map((a) => a.key)).toEqual(["whop_payment_pay_test50"]);
    expect(h.db.calls.filter((c) => c.table === "rpc:grant_credits")).toHaveLength(3);
  });

  it("the $250 plan grants 27,500 credits; a tax added on top is not counted against the price", async () => {
    await expectAnswer(await send(paymentSucceeded(PAYG, { id: "pay_t250", plan_id: PLAN_250, total: whopMoney("271.88"), tax_amount: whopMoney("21.88"), tax_behavior: "exclusive" })), 200, "credited");
    expect(ledger()[0]).toMatchObject({ tenant_id: PAYG, delta: 27500, request_id: "whop:pay_t250" });
  });

  it("another plan is never changed: builder stays builder with its key's expiry; payg stays payg", async () => {
    await expectAnswer(await send(paymentSucceeded(BUILDER, { id: "pay_b" })), 200, "credited");
    expect(tenant(BUILDER)).toMatchObject({ plan: "builder", watch_limit: 50, credits_balance: 17000 });
    expect(rows("api_keys").find((k) => k.id === "k-builder")!.expires_at).toBe(new Date(NOW + 5 * DAY).toISOString());
    await expectAnswer(await send(paymentSucceeded(PAYG, { id: "pay_p" })), 200, "credited");
    expect(tenant(PAYG)).toMatchObject({ plan: "payg", credits_balance: 5100 });
    expect(h.alerts.map((a) => a.text).join("\n")).toContain("builder, unchanged");
  });

  it("a free tenant's higher watch limit is never lowered by the move to payg", async () => {
    tenant(FREE).watch_limit = 12;
    await expectAnswer(await send(paymentSucceeded(FREE)), 200, "credited");
    expect(tenant(FREE)).toMatchObject({ plan: "payg", watch_limit: 12 });
  });

  it("another tenant's newer key is never touched: only the buyer's own newest key stops expiring", async () => {
    const otherEnd = new Date(NOW + 9 * DAY).toISOString();
    rows("api_keys").push({ id: "k-builder-newest", tenant_id: BUILDER, name: "rotated", environment: "live", expires_at: otherEnd, revoked_at: null, deleted_at: null, created_at: new Date(NOW - 60_000).toISOString() });
    await expectAnswer(await send(paymentSucceeded(FREE)), 200, "credited");
    expect(rows("api_keys").find((k) => k.id === "k-builder-newest")!.expires_at).toBe(otherEnd);
    expect(rows("api_keys").find((k) => k.id === "k-free-new")!.expires_at).toBeNull();
    expect(tenant(FREE)).toMatchObject({ plan: "payg" });
    expect(h.alerts[0]!.text).toContain("key k-free-new no longer expires");
  });

  it("a tenant moved off free between the read and the write is never moved down to payg", async () => {
    tenant(FREE).plan = "builder"; // an operator's change lands after the tenant was read as free
    const r = await upgradeIfFree(client() as never, { id: FREE, plan: "free", watch_limit: 5, deleted_at: null });
    expect(r).toMatchObject({ result: "unchanged" });
    expect(r.line).toContain("no longer free when updated");
    expect(tenant(FREE)).toMatchObject({ plan: "builder", watch_limit: 5 });
  });

  it("another event of the same payment running: the payment answers 409 and grants nothing, then is credited once let go", async () => {
    h.db.tables.rate_limit_buckets = [{ key: "whop:payment:pay_test50", count: 1, reset_at: new Date(NOW + 30_000).toISOString() }];
    await expectAnswer(await send(paymentSucceeded(FREE)), 409, "busy");
    expect(ledger()).toEqual([]);
    expect(h.db.calls.filter((c) => c.table === "rpc:grant_credits")).toEqual([]);
    h.db.tables.rate_limit_buckets[0]!.reset_at = "1970-01-01T00:00:00.000Z";
    await expectAnswer(await send(paymentSucceeded(FREE)), 200, "credited");
    expect(rows("rate_limit_buckets").find((b) => b.key === "whop:payment:pay_test50")!.reset_at).toBe("1970-01-01T00:00:00.000Z");
  });

  it("a repeat of a credited payment that now shows a refund: already_processed, and no 'NOT credited' alert", async () => {
    await expectAnswer(await send(paymentSucceeded(FREE)), 200, "credited");
    h.alerts = [];
    await expectAnswer(await send(paymentSucceeded(FREE, { refunded_amount: whopMoney("50.00") })), 200, "already_processed");
    await expectAnswer(await send(paymentSucceeded(FREE, { total: whopMoney("45.00") })), 200, "already_processed");
    expect(h.alerts).toEqual([]);
    expect(ledger()).toHaveLength(1);
    expect(tenant(FREE).credits_balance).toBe(5300);
  });

  it("a plan move that failed is retried when the payment comes again, without a second grant", async () => {
    h.broken = (w) => w === "tenants.update";
    await expectAnswer(await send(paymentSucceeded(FREE)), 200, "credited");
    expect(tenant(FREE)).toMatchObject({ plan: "free", credits_balance: 5300 });
    expect(h.alerts[0]!.text).toContain("NOT moved to payg");
    h.broken = null;
    await expectAnswer(await send(paymentSucceeded(FREE)), 200, "already_processed");
    expect(tenant(FREE)).toMatchObject({ plan: "payg", credits_balance: 5300 });
    expect(ledger()).toHaveLength(1);
  });
});

describe("the $20 pack (plan §22.3 #5): 2,000 credits for its own plan and nothing for $20 on any other", () => {
  const pay20 = (tenantId: string, data: Record<string, unknown> = {}) => paymentSucceeded(tenantId, { id: "pay_t20", plan_id: PLAN_20, total: whopMoney("20.00"), subtotal: whopMoney("20.00"), usd_total: whopMoney("20.00"), ...data });

  it("plan_PNgCSGmXG38KW grants 2,000 once: a free tenant moves to payg; the replay grants nothing", async () => {
    expect(PLAN_20).toBe("plan_PNgCSGmXG38KW");
    const body = await expectAnswer(await send(pay20(FREE), { id: "msg_t20" }), 200, "credited");
    expect(body.data).toMatchObject({ payment_id: "pay_t20", tenant_id: FREE, credits: 2000, balance: 2300 });
    expect(ledger()).toEqual([expect.objectContaining({ tenant_id: FREE, delta: 2000, reason: "grant", request_id: "whop:pay_t20", balance_after: 2300 })]);
    expect(tenant(FREE)).toMatchObject({ plan: "payg", credits_balance: 2300 });
    expect(h.alerts[0]!.text).toContain("Card payment credited (Whop): $20.00 pack, 2000 credits");
    await expectAnswer(await send(pay20(FREE), { id: "msg_t20" }), 200, "already_processed");
    expect(ledger()).toHaveLength(1);
    expect(tenant(FREE).credits_balance).toBe(2300);
  });

  it("a full refund of the $20 payment takes the 2,000 back; a partial one its share of the $20 price", async () => {
    await expectAnswer(await send(pay20(PAYG)), 200, "credited");
    await expectAnswer(await send(refundEvent("refund.created", { id: "ref_t20a", paymentId: "pay_t20", amount: 5, total: 20 })), 200, "reversed");
    await expectAnswer(await send(refundEvent("refund.created", { id: "ref_t20b", paymentId: "pay_t20", amount: 15, total: 20 })), 200, "reversed");
    expect(ledger().filter((l) => l.reason === "adjustment").map((l) => l.delta)).toEqual([-500, -1500]);
    expect(tenant(PAYG).credits_balance).toBe(100);
  });

  it("$20 paid on the $50 plan, on a plan that is no pack, or the $20 plan paid another amount: nothing granted", async () => {
    await expectAnswer(await send(paymentSucceeded(FREE, { id: "pay_x1", total: whopMoney("20.00") })), 200, "amount_mismatch");
    await expectAnswer(await send(paymentSucceeded(FREE, { id: "pay_x2", plan_id: "plan_AnotherTwenty", total: whopMoney("20.00") })), 200, "ignored_plan");
    await expectAnswer(await send(pay20(FREE, { id: "pay_x3", total: whopMoney("50.00") })), 200, "amount_mismatch");
    expect(ledger()).toEqual([]);
    expect(h.db.calls.filter((c) => c.table === "rpc:grant_credits")).toEqual([]);
    expect(tenant(FREE)).toMatchObject({ plan: "free", credits_balance: 300 });
  });

  it("with WHOP_PLAN_ID_20 unset, a $20 payment from a checkout Resolve opened answers 503 for Whop to retry, alerted by name", async () => {
    await expectAnswer(await send(pay20(FREE), {}, { ...env, WHOP_PLAN_ID_20: "" } as Env), 503);
    expect(ledger()).toEqual([]);
    expect(h.alerts.map((a) => a.key)).toEqual(["whop_config_missing"]);
    expect(h.alerts[0]!.text).toContain("WHOP_PLAN_ID_20");
  });
});

describe("a payment that does not match grants nothing and alerts for manual matching", () => {
  const unmatched = async (ev: unknown, result: string, text: string) => {
    await expectAnswer(await send(ev), 200, result);
    expect(ledger()).toEqual([]);
    expect(h.db.calls.filter((c) => c.table === "rpc:grant_credits")).toEqual([]);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.key).toBe("whop_unmatched_pay_test50");
    expect(h.alerts[0]!.text).toContain("was NOT credited");
    expect(h.alerts[0]!.text).toContain(text);
    expect(h.alerts[0]!.text).toContain("'whop:pay_test50'");
    expect(JSON.stringify(h.alerts)).not.toContain("buyer@example.com");
  };
  it("an amount that is not the pack's price", () => unmatched(paymentSucceeded(FREE, { total: whopMoney("45.00") }), "amount_mismatch", "paid $45.00, the pack costs $50.00"));
  it("another currency", () => unmatched(paymentSucceeded(FREE, { currency: "eur", total: whopMoney("50.00", "eur") }), "amount_mismatch", "currency is eur"));
  it("no tenant in the metadata (a purchase Resolve did not open)", () => unmatched(paymentSucceeded(null), "no_tenant", "no resolve_tenant_id in the metadata"));
  it("a tenant id that does not exist", () => unmatched(paymentSucceeded("55555555-5555-4555-8555-555555555555"), "tenant_missing", "no tenant 55555555-5555-4555-8555-555555555555 exists"));
  it("a deleted tenant", () => unmatched(paymentSucceeded(GONE), "tenant_deleted", `tenant ${GONE} is deleted`));
  it("a payment not in status paid", () => unmatched(paymentSucceeded(FREE, { status: "pending" }), "not_paid", "not paid"));

  it("an unknown plan id grants nothing and alerts (200: nothing a retry could change)", async () => {
    await expectAnswer(await send(paymentSucceeded(FREE, { plan_id: "plan_SomethingElse" })), 200, "ignored_plan");
    expect(ledger()).toEqual([]);
    expect(h.alerts.map((a) => a.key)).toEqual(["whop_unknown_plan_pay_test50"]);
  });
  it("a plan that may be a pack whose plan id is not configured: 503 for Whop to retry, alerted by name, nothing granted", async () => {
    const res = await send(paymentSucceeded(FREE, { plan_id: "plan_NotSetYet" }), {}, { ...env, WHOP_PLAN_ID_250: "" } as Env);
    await expectAnswer(res, 503);
    expect(ledger()).toEqual([]);
    expect(h.alerts.map((a) => a.key)).toEqual(["whop_config_missing"]);
    expect(h.alerts[0]!.text).toContain("WHOP_PLAN_ID_250");
  });
  it("with the plan ids unset, a payment that names no Resolve tenant (a dashboard test event, another product) is answered 200", async () => {
    // every plan id empty (as wrangler.toml shipped before the plans existed). A 503 here would fail every such delivery
    // for 3 days and Whop would disable the webhook before the first real pack is sold.
    const shipped = { ...env, WHOP_PLAN_ID_20: "", WHOP_PLAN_ID_50: "", WHOP_PLAN_ID_250: "" } as Env;
    await expectAnswer(await send(paymentSucceeded(null, { plan_id: "plan_xxxxxxxxxxxxx" }), {}, shipped), 200, "ignored_plan");
    expect(ledger()).toEqual([]);
    expect(h.alerts.map((a) => a.key)).toEqual(["whop_unknown_plan_pay_test50"]);
    for (const s of ["not a configured Resolve credit pack", "WHOP_PLAN_ID_50", "names no Resolve tenant", "'whop:pay_test50'"]) expect(h.alerts[0]!.text).toContain(s);
    // one Resolve opened (its tenant in the metadata) is still refused for Whop to retry once the plan ids are set
    await expectAnswer(await send(paymentSucceeded(FREE, { plan_id: "plan_xxxxxxxxxxxxx" }), {}, shipped), 503);
    expect(ledger()).toEqual([]);
  });
  it("a payment that does not parse as a pinned payment is alerted as not understood, never guessed", async () => {
    await expectAnswer(await send(envelope("payment.succeeded", { id: "pay_legacy", plan: { id: PLAN_50 }, total: 50, currency: "usd" })), 200, "not_understood");
    expect(ledger()).toEqual([]);
    expect(h.alerts[0]!.text).toContain("pinned to api_version_date 2026-09-29");
  });
  it("a database error answers 503 (Whop retries) and grants nothing", async () => {
    h.broken = (w) => w === "rpc:grant_credits";
    await expectAnswer(await send(paymentSucceeded(FREE)), 503);
    expect(ledger()).toEqual([]);
    expect(h.alerts.map((a) => a.key)).toEqual(["whop_db_error"]);
    h.broken = null;
    await expectAnswer(await send(paymentSucceeded(FREE)), 200, "credited");
  });
});

describe("refunds and disputes take back their share once", () => {
  const credited = async (id: string = FREE) => { await expectAnswer(await send(paymentSucceeded(id)), 200, "credited"); h.alerts = []; };
  const reversals = () => ledger().filter((l) => l.reason === "adjustment");

  it("a full refund takes the 5,000 credits back once, under whop-refund:<payment>:<refund>; a repeat changes nothing", async () => {
    await credited();
    const ev = refundEvent("refund.created");
    await expectAnswer(await send(ev), 200, "reversed");
    expect(reversals()).toEqual([expect.objectContaining({ tenant_id: FREE, delta: -5000, request_id: "whop-refund:pay_test50:ref_test1", balance_after: 300 })]);
    await expectAnswer(await send(ev), 200, "already_processed");
    await expectAnswer(await send(refundEvent("refund.updated")), 200, "already_processed");
    expect(reversals()).toHaveLength(1);
    expect(tenant(FREE).credits_balance).toBe(300);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.text).toContain("5000 credits taken back");
    // the payment's hold was let go
    expect(rows("rate_limit_buckets").find((b) => b.key === "whop:payment:pay_test50")!.reset_at).toBe("1970-01-01T00:00:00.000Z");
  });

  it("a refund still pending takes nothing; the same refund once succeeded takes its share", async () => {
    await credited();
    await expectAnswer(await send(refundEvent("refund.created", { status: "pending" })), 200, "refund_not_succeeded");
    expect(reversals()).toEqual([]);
    await expectAnswer(await send(refundEvent("refund.updated", { status: "succeeded" })), 200, "reversed");
    expect(reversals()).toHaveLength(1);
  });

  it("partial refunds take their proportional share, and all of them together never more than the payment granted", async () => {
    await credited();
    await expectAnswer(await send(refundEvent("refund.created", { id: "ref_a", amount: 10 })), 200, "reversed");
    await expectAnswer(await send(refundEvent("refund.created", { id: "ref_b", amount: 15 })), 200, "reversed");
    expect(reversals().map((r) => r.delta)).toEqual([-1000, -1500]);
    await expectAnswer(await send(refundEvent("refund.created", { id: "ref_c", amount: 30 })), 200, "reversed");
    expect(reversals().map((r) => r.delta)).toEqual([-1000, -1500, -2500]);
    await expectAnswer(await send(refundEvent("refund.created", { id: "ref_d", amount: 5 })), 200, "nothing_left");
    expect(reversals()).toHaveLength(3);
    expect(tenant(FREE).credits_balance).toBe(300);
  });

  it("a native-shaped refund (Money amount, payment_id) takes its share against the pack's price", async () => {
    await credited();
    await expectAnswer(await send(nativeRefundEvent("refund.created", { amount: "12.50" })), 200, "reversed");
    expect(reversals()).toEqual([expect.objectContaining({ delta: -1250, request_id: "whop-refund:pay_test50:rf_test1" })]);
    await expectAnswer(await send(nativeRefundEvent("refund.updated", { amount: "12.50" })), 200, "already_processed");
  });

  it("a refund without an amount takes all of it", async () => {
    await credited();
    await expectAnswer(await send(refundEvent("refund.created", { amount: null })), 200, "reversed");
    expect(reversals()[0]!.delta).toBe(-5000);
  });

  it("the balance is lower than the reversal: what the ledger allows is taken, the shortfall alerted, nothing thrown", async () => {
    await credited();
    tenant(FREE).credits_balance = 1200; // the buyer spent 4,100 credits
    const ev = refundEvent("refund.created");
    const body = await expectAnswer(await send(ev), 200, "reversed_with_shortfall");
    expect(body.data).toMatchObject({ credits: 1200, shortfall: 3800 });
    expect(reversals()).toEqual([expect.objectContaining({ delta: -1200, balance_after: 0 })]);
    expect(h.alerts[0]!.text).toContain("SHORTFALL: 3800 credits could not be taken back: the balance was 1200");
    await expectAnswer(await send(ev), 200, "already_processed");
    expect(reversals()).toHaveLength(1);
  });

  it("a zero balance: nothing is written, the shortfall is alerted, and a repeat stays a no-op after a later purchase", async () => {
    await credited();
    tenant(FREE).credits_balance = 0;
    const ev = refundEvent("refund.created");
    await expectAnswer(await send(ev), 200, "shortfall");
    expect(reversals()).toEqual([]);
    expect(h.alerts[0]!.text).toContain("SHORTFALL: 5000");
    tenant(FREE).credits_balance = 9000; // bought more since
    await expectAnswer(await send(ev), 200, "already_processed");
    expect(reversals()).toEqual([]);
    expect(tenant(FREE).credits_balance).toBe(9000);
  });

  it("a charge moving the balance between the read and the write is read again once", async () => {
    await credited();
    // a verdict charges 4,600 credits after the balance was read (5,300) and before the reversal of 5,000 is written
    let once = true;
    h.before = (fn, a) => { if (fn === "grant_credits" && a.p_amount < 0 && once) { once = false; tenant(FREE).credits_balance = 700; } };
    await expectAnswer(await send(refundEvent("refund.created")), 200, "reversed_with_shortfall");
    expect(h.db.calls.filter((c) => c.table === "rpc:grant_credits").length).toBe(3); // the grant, the refused reversal, the one read again
    expect(reversals()).toEqual([expect.objectContaining({ delta: -700, balance_after: 0 })]);
  });

  it("a formal dispute takes all of it; its later updates, and a won ruling, take nothing more (a won one alerts how to give back)", async () => {
    await credited();
    await expectAnswer(await send(disputeEvent("dispute.created")), 200, "reversed");
    expect(reversals()).toEqual([expect.objectContaining({ delta: -5000, request_id: "whop-dispute:pay_test50:dspt_test1" })]);
    await expectAnswer(await send(disputeEvent("dispute.updated", { status: "under_review" })), 200, "already_processed");
    await expectAnswer(await send(disputeEvent("dispute.updated", { status: "lost" })), 200, "already_processed");
    h.alerts = [];
    await expectAnswer(await send(disputeEvent("dispute.updated", { status: "won" })), 200, "dispute_closed");
    expect(reversals()).toHaveLength(1);
    expect(h.alerts[0]!.key).toBe("whop_dispute_won_dspt_test1");
    expect(h.alerts[0]!.text).toContain(`grant_credits('${FREE}', 5000,`);
  });

  it("a won ruling delivered before its dispute.created: the late created event takes nothing", async () => {
    await credited();
    await expectAnswer(await send(disputeEvent("dispute.updated", { status: "won" })), 200, "dispute_closed");
    await expectAnswer(await send(disputeEvent("dispute.created", { status: "needs_response" })), 200, "already_processed");
    expect(reversals()).toEqual([]);
    expect(tenant(FREE).credits_balance).toBe(5300);
  });

  it("a refund after a dispute of the same payment finds nothing left: never more than the payment granted", async () => {
    await credited();
    await expectAnswer(await send(disputeEvent("dispute.created", { status: "needs_response" })), 200, "reversed");
    await expectAnswer(await send(refundEvent("refund.created", { id: "ref_after" })), 200, "nothing_left");
    expect(reversals()).toHaveLength(1);
  });

  it("an inquiry or early alert moves no money: nothing taken, alerted", async () => {
    await credited();
    await expectAnswer(await send(disputeEvent("dispute.created", { inquiry: true, status: "warning_needs_response" })), 200, "dispute_inquiry");
    expect(reversals()).toEqual([]);
    expect(h.alerts[0]!.key).toBe("whop_dispute_inquiry_dspt_test1");
  });

  it("an inquiry in a formal status still moves no money; an early alert status without the flag neither", async () => {
    await credited();
    for (const status of ["needs_response", "under_review", "lost"]) {
      await expectAnswer(await send(disputeEvent("dispute.updated", { inquiry: true, status })), 200, "dispute_inquiry");
    }
    await expectAnswer(await send(disputeEvent("dispute.created", { id: "dspt_warn", inquiry: false, status: "warning_under_review" })), 200, "dispute_inquiry");
    expect(reversals()).toEqual([]);
    expect(tenant(FREE).credits_balance).toBe(5300);
    expect(h.alerts.map((a) => a.key)).toEqual(["whop_dispute_inquiry_dspt_test1", "whop_dispute_inquiry_dspt_test1", "whop_dispute_inquiry_dspt_test1", "whop_dispute_inquiry_dspt_warn"]);
  });

  it("a refund of a payment Resolve never credited takes nothing and alerts", async () => {
    await expectAnswer(await send(refundEvent("refund.created", { paymentId: "pay_unknown" })), 200, "no_grant");
    expect(reversals()).toEqual([]);
    expect(h.alerts[0]!.text).toContain("Resolve granted nothing for that payment");
  });

  it("a refund processed before its payment is credited (the payment answered 503, then retried): nothing is granted", async () => {
    h.broken = (w) => w === "rpc:grant_credits";
    await expectAnswer(await send(paymentSucceeded(FREE)), 503);
    h.broken = null;
    await expectAnswer(await send(refundEvent("refund.created")), 200, "no_grant");
    expect(rows("rate_limit_buckets").find((b) => b.key === "whop:reversed-first:pay_test50")).toBeDefined();
    h.alerts = [];
    // Whop retries the original delivery: the same payload, refunded_amount still null
    await expectAnswer(await send(paymentSucceeded(FREE)), 200, "reversed_first");
    expect(ledger()).toEqual([]);
    expect(tenant(FREE)).toMatchObject({ plan: "free", credits_balance: 300 });
    expect(rows("api_keys").find((k) => k.id === "k-free-new")!.expires_at).not.toBeNull();
    expect(h.alerts.map((a) => a.key)).toEqual(["whop_unmatched_pay_test50"]);
    expect(h.alerts[0]!.text).toContain("was processed before this payment.succeeded");
    expect(h.alerts[0]!.text).toContain("'whop:pay_test50'");
    // and it stays so on every later delivery
    await expectAnswer(await send(paymentSucceeded(FREE)), 200, "reversed_first");
    expect(ledger()).toEqual([]);
  });

  it("a formal dispute delivered before its payment stops the grant the same way", async () => {
    await expectAnswer(await send(disputeEvent("dispute.created", { status: "needs_response" })), 200, "no_grant");
    await expectAnswer(await send(paymentSucceeded(FREE)), 200, "reversed_first");
    expect(tenant(FREE).credits_balance).toBe(300);
    expect(ledger()).toEqual([]);
  });

  it("a refund still pending, or an inquiry, before the payment leaves no marker: the payment is credited", async () => {
    await expectAnswer(await send(refundEvent("refund.created", { status: "pending" })), 200, "refund_not_succeeded");
    await expectAnswer(await send(disputeEvent("dispute.created", { inquiry: true })), 200, "dispute_inquiry");
    await expectAnswer(await send(paymentSucceeded(FREE)), 200, "credited");
    expect(tenant(FREE).credits_balance).toBe(5300);
  });

  it("a refund before its payment whose marker cannot be written is refused for Whop to retry", async () => {
    h.broken = (w, a) => w === "rpc:rate_limit_hit" && String(a?.p_key).startsWith("whop:reversed-first:");
    await expectAnswer(await send(refundEvent("refund.created")), 503);
    h.broken = null;
    await expectAnswer(await send(refundEvent("refund.created")), 200, "no_grant");
    await expectAnswer(await send(paymentSucceeded(FREE)), 200, "reversed_first");
    expect(ledger()).toEqual([]);
  });

  it("two payments of one tenant: each refund takes back its own payment's credits, never capped by the other's", async () => {
    await credited();
    await expectAnswer(await send(paymentSucceeded(FREE, { id: "pay_second" })), 200, "credited");
    expect(tenant(FREE).credits_balance).toBe(10300);
    await expectAnswer(await send(refundEvent("refund.created")), 200, "reversed");
    await expectAnswer(await send(refundEvent("refund.created", { id: "ref_second", paymentId: "pay_second" })), 200, "reversed");
    expect(reversals().map((r) => [r.request_id, r.delta])).toEqual([["whop-refund:pay_test50:ref_test1", -5000], ["whop-refund:pay_second:ref_second", -5000]]);
    expect(tenant(FREE).credits_balance).toBe(300);
  });

  it("the earlier reversals of a payment are found however many older adjustments the tenant has", async () => {
    const old = new Date(NOW - 100 * DAY).toISOString();
    for (let i = 0; i < 1000; i++) ledger().push({ id: 10_000 + i, tenant_id: FREE, delta: -1, reason: "adjustment", request_id: `hand-fix-${i}`, balance_after: 300, created_at: old });
    await credited();
    tenant(FREE).credits_balance = 20000;
    await expectAnswer(await send(disputeEvent("dispute.created")), 200, "reversed");
    await expectAnswer(await send(refundEvent("refund.created", { id: "ref_after" })), 200, "nothing_left");
    expect(reversals().filter((r) => String(r.request_id).startsWith("whop-")).map((r) => [r.request_id, r.delta])).toEqual([["whop-dispute:pay_test50:dspt_test1", -5000]]);
    expect(tenant(FREE).credits_balance).toBe(15000);
  });

  it("another delivery of the same refund writing first (a lapsed hold): the unique request_id answers already_processed", async () => {
    await credited();
    let once = true;
    h.before = (fn, a) => {
      if (fn !== "grant_credits" || a.p_amount >= 0 || !once) return;
      once = false;
      tenant(FREE).credits_balance += a.p_amount;
      ledger().push({ id: 900, tenant_id: FREE, delta: a.p_amount, reason: "adjustment", request_id: a.p_request_id, balance_after: tenant(FREE).credits_balance, created_at: new Date().toISOString() });
    };
    await expectAnswer(await send(refundEvent("refund.created")), 200, "already_processed");
    expect(reversals()).toEqual([expect.objectContaining({ id: 900, delta: -5000 })]);
    expect(tenant(FREE).credits_balance).toBe(300);
  });

  it("with tax added on top, a refund of the pack's price takes all its credits, and a partial one its share, in either shape", async () => {
    const taxed = { id: "pay_t250", plan_id: PLAN_250, total: whopMoney("271.88"), tax_amount: whopMoney("21.88"), tax_behavior: "exclusive" };
    await expectAnswer(await send(paymentSucceeded(PAYG, taxed)), 200, "credited");
    await expectAnswer(await send(refundEvent("refund.created", { id: "ref_legacy", paymentId: "pay_t250", amount: 250, total: 271.88 })), 200, "reversed");
    expect(reversals().map((r) => r.delta)).toEqual([-27500]);
    h.db = seed();
    await expectAnswer(await send(paymentSucceeded(PAYG, taxed)), 200, "credited");
    await expectAnswer(await send(nativeRefundEvent("refund.created", { paymentId: "pay_t250", amount: "250.00" })), 200, "reversed");
    expect(reversals().map((r) => r.delta)).toEqual([-27500]);
    for (const shape of ["legacy", "native"] as const) {
      h.db = seed();
      await expectAnswer(await send(paymentSucceeded(PAYG, taxed)), 200, "credited");
      const ev = shape === "legacy" ? refundEvent("refund.created", { paymentId: "pay_t250", amount: 125, total: 271.88 }) : nativeRefundEvent("refund.created", { paymentId: "pay_t250", amount: "125.00" });
      await expectAnswer(await send(ev), 200, "reversed");
      expect(reversals().map((r) => r.delta), shape).toEqual([-13750]);
    }
  });

  it("another event of the same payment running: 409 for Whop to retry, nothing taken", async () => {
    await credited();
    h.db.tables.rate_limit_buckets = [{ key: "whop:payment:pay_test50", count: 1, reset_at: new Date(NOW + 30_000).toISOString() }];
    await expectAnswer(await send(refundEvent("refund.created")), 409);
    expect(reversals()).toEqual([]);
  });

  it("a deleted tenant: nothing can be taken, the shortfall is alerted", async () => {
    await credited();
    tenant(FREE).deleted_at = "2026-10-01T00:00:00Z";
    await expectAnswer(await send(refundEvent("refund.created")), 200, "shortfall");
    expect(h.alerts[0]!.text).toContain("the tenant is deleted");
  });
});

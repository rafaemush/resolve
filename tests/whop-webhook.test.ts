/**
 * POST /webhooks/whop end to end over the in-memory database with the stand-ins of grant_credits and rate_limit_hit
 * (tests/lib/fake-whop.ts): an unverified request (no, wrong, stale or tampered signature) is refused with 401 and
 * touches nothing; a verified payment of a pack credits its tenant exactly once whatever repeats, and moves a free
 * tenant to payg with its key's expiry cleared while every other plan is left alone; a wrong amount or currency, an
 * unknown plan, a missing or deleted tenant grant nothing and alert; refunds and disputes take back their share once,
 * never more than the payment granted and never below a zero balance (the shortfall is alerted, never thrown); unknown
 * event types are ignored and logged without the body; every answer is no-store; no alert carries the buyer's full
 * email address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { PLAN_250, PLAN_50, WHOP_RPCS, WHOP_SECRET, disputeEvent, envelope, nativeRefundEvent, paymentSucceeded, refundEvent, whopMoney, whopRequest } from "./lib/fake-whop";

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
const env = { WHOP_WEBHOOK_SECRET: WHOP_SECRET, WHOP_PLAN_ID_50: PLAN_50, WHOP_PLAN_ID_250: PLAN_250, WHOP_API_KEY: "whop_api_key_test", WHOP_CHECKOUT_ENABLED: "0" } as unknown as Env;
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

  it("a refund of a payment Resolve never credited takes nothing and alerts", async () => {
    await expectAnswer(await send(refundEvent("refund.created", { paymentId: "pay_unknown" })), 200, "no_grant");
    expect(reversals()).toEqual([]);
    expect(h.alerts[0]!.text).toContain("Resolve granted nothing for that payment");
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

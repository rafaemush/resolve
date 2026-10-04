/**
 * The priced private early reveal (plan "1. Make it buyable", migration 023; src/shadow/reveal.ts): who pays (free and
 * pay as you go; Builder, Growth and Platform included; a free key issued before the cut-over grandfathered), the event
 * cap arithmetic, the locked reveal (no verdict, no proposal, the card pointer and never a USDC address), the push path
 * (one charge_reveals() call per publish, paid reveals delivered first, a failed charge locked as billing_unavailable with
 * one alert and never released free, a verdict that is not RESOLVED never charged, credits.low with the event), the pull
 * paths (GET /v1/shadow/:market_id and GET /v1/shadow/export answer 200 with locked items, release and charge after a
 * top-up, replay free), following a whole event in one call (all or nothing at the cap, idempotent), and the refund rule
 * as the deliveries record it. charge_reveals(), follow_event() and refund_late_reveals() run as their stand-ins
 * (tests/lib/fake-rpcs.ts); the SQL is linted in tests/priced-reveal-migration.test.ts and proven by
 * scripts/selftest/reveal.ts. Also: the rails are load-bearing (evals/reveal.ts red without each, controls green).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { MarketRow } from "../src/ingest/types";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { followEntitlements, FOLLOW_RPCS, REVEAL_RPCS } from "./lib/fake-rpcs";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, tenant: "t_pay", plan: "payg" as string }));
vi.mock("../src/db/supabase", () => ({
  db: () => h.db.client,
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/api/auth", () => ({
  authenticate: async () => ({ ok: true, auth: { keyId: "k1", tenantId: h.tenant, plan: h.plan, strictV0: false, environment: "test", scopes: [], requestsToday: 0, dailyCap: 1000 } }),
  rateLimit: async () => ({ allowed: true }),
  extractApiKey: () => null,
  invalidateKeyCache: async () => undefined,
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })), alertMany: vi.fn(async () => ({ sent: [], deduped: [] })) }));

import { v1 } from "../src/api/v1";
import { publishShadowCommitted, revealItems, shadowCommittedPayload, COMMITTED_QUEUE_SUBREQUESTS, QUEUE_SUBREQUESTS } from "../src/shadow/events";
import {
  billingUnavailable, lockedReveal, revealCharge, revealDueAt, revealPriority, revealRequestId, revealTerms,
  REVEAL_EVENT_CAP_CREDITS, REVEAL_INCLUDED_PLANS, REVEAL_LATE_MINUTES, REVEAL_PRICE_CREDITS, REVEAL_PRICING_FROM, type RevealAnswer,
} from "../src/shadow/reveal";
import { followCap, PLANS } from "../src/shadow/follows";
import { inlineCandidates } from "../src/webhooks/deliver";
import { topUp } from "../src/billing/top-up";
import { noteCrossings } from "../src/billing/events";
import { alert, alertMany } from "../src/ops/alerts";
import { COST } from "../src/ops/budget";
import { __setRailsForMutationTesting } from "../src/resolve/rails";
import { runRevealSuite } from "../evals/reveal";

const BASE = "https://resolve.example.com";
/** Card checkout offered: the locked reveal's top_up is the card rail. A USDC address is configured, and must never show. */
const env = {
  RESOLVE_PUBLIC_URL: BASE, WHOP_CHECKOUT_ENABLED: "1", WHOP_API_KEY: "k", WHOP_PLAN_ID_20: "plan_c", WHOP_PLAN_ID_50: "plan_a", WHOP_PLAN_ID_250: "plan_b",
  USDC_RECEIVING_ADDRESS: `0x${"1".repeat(40)}`, JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "60", SPOTLIGHT_SECRET: "s", SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized",
} as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const M = "22222222-2222-4222-8222-222222222222";
const EVENT = "polymarket:event:60182";
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const CID = `0x${"ab".repeat(32)}`;
const MARKET = { id: M, tenant_id: null, is_test: false, platform: "polymarket", external_id: "551234", option_a: "Yes", option_b: "No", condition_id: CID, meta: { slug: "cpi-above-3", event_id: "60182" }, event_key: EVENT, status: "open", deleted_at: null } as unknown as MarketRow;
const committedOf = (status: "RESOLVED" | "UNRESOLVED") => ({
  preimage_version: "v2", preimage: "p|n0nce", resolution_status: status, winning_outcome: status === "RESOLVED" ? "OPTION_A" : "NONE", confidence_score: 0.95,
  caveats: status === "RESOLVED" ? [] : ["no_anchor"], canonical_sha256: "c".repeat(64), raw_sha256: "d".repeat(64), thresholds_version: "v1", determination_basis: "structured",
});
const commitAt = (iso: string, status: "RESOLVED" | "UNRESOLVED" = "RESOLVED") => ({ id: "c1", commitment_sha256: "e".repeat(64), committed_at: iso, committed: committedOf(status) });
const COMMIT = commitAt(new Date().toISOString());
const answer = (over: Partial<RevealAnswer> = {}): RevealAnswer => ({ tenant_id: "t1", market_id: M, plan: "payg", entitled_full: true, replayed: false, charged: 25, price: 25, balance: 975, reason: "charged", low_credit: false, low_credit_threshold: 500, ...over });
const top = () => topUp(env, BASE);
const NO_USDC = (s: string) => { expect(s).not.toMatch(/0x[0-9a-f]{40}/i); expect(s).not.toMatch(/usdc|payments\/address/i); };

// ---- the pure rules ---------------------------------------------------------------------------------------------------

describe("who pays and how much (pure)", () => {
  it("25 credits per RESOLVED leg, at most 2,000 per event, refunded when the webhook is more than 10 minutes late; Builder, Growth and Platform included", () => {
    expect([REVEAL_PRICE_CREDITS, REVEAL_EVENT_CAP_CREDITS, REVEAL_LATE_MINUTES]).toEqual([25, 2000, 10]);
    expect([...REVEAL_INCLUDED_PLANS]).toEqual(["builder", "growth", "platform"]);
  });
  it("the event cap: the price, or what is left under the cap, never below 0 (80 legs pay, the 81st is free)", () => {
    expect(revealCharge(0)).toBe(25);
    expect(revealCharge(1975)).toBe(25);
    expect(revealCharge(1990)).toBe(10);
    expect(revealCharge(2000)).toBe(0);
    expect(revealCharge(2500)).toBe(0);
    let spent = 0;
    const legs = Array.from({ length: 81 }, () => { const c = revealCharge(spent); spent += c; return c; });
    expect([legs.filter((c) => c === 25).length, legs[80], spent]).toEqual([80, 0, 2000]);
  });
  it("the cut-over: a free key created before it is grandfathered, after it pays; pay as you go always pays; included plans never", () => {
    const before = new Date(Date.parse(REVEAL_PRICING_FROM) - 1).toISOString();
    expect(revealTerms("free", before)).toBe("grandfathered");
    expect(revealTerms("free", REVEAL_PRICING_FROM)).toBe("pays");
    expect(revealTerms("free", null)).toBe("pays");
    expect(revealTerms("payg", before)).toBe("pays");
    for (const p of ["builder", "growth", "platform"] as const) expect(revealTerms(p, null)).toBe("included_plan");
  });
  it("the ledger request id: reveal:<tenant>:<market>, a '<kind>:<id>' charge id under 300 characters", () => {
    const id = revealRequestId(uuid(1), M);
    expect(id).toBe(`reveal:${uuid(1)}:${M}`);
    expect(id).toMatch(/^[a-z_]+:.+/);
    expect(id.length).toBeLessThanOrEqual(300);
  });
  it("delivery priority: paid reveals 3, included plans 2, grandfathered 1, locked 0", () => {
    expect(revealPriority(answer())).toBe(3);
    expect(revealPriority(answer({ reason: "replay", charged: 0, replayed: true }))).toBe(3);
    expect(revealPriority(answer({ reason: "event_cap_reached", charged: 0 }))).toBe(3);
    expect(revealPriority(answer({ reason: "included_plan", plan: "builder", charged: 0 }))).toBe(2);
    expect(revealPriority(answer({ reason: "grandfathered", plan: "free", charged: 0 }))).toBe(1);
    expect(revealPriority(answer({ reason: "not_resolved", charged: 0 }))).toBe(1);
    expect(revealPriority(answer({ reason: "not_resolved", plan: "growth", charged: 0 }))).toBe(2);
    expect(revealPriority(answer({ reason: "insufficient_credits", entitled_full: false, charged: 0 }))).toBe(0);
  });
  it("billing unavailable: an included plan still gets the verdict, everyone else is locked (never released free)", () => {
    expect(billingUnavailable({ tenant_id: "t", market_id: M, plan: "growth" })).toMatchObject({ entitled_full: true, reason: "included_plan", charged: 0 });
    for (const plan of ["free", "payg"] as const) expect(billingUnavailable({ tenant_id: "t", market_id: M, plan })).toMatchObject({ entitled_full: false, reason: "billing_unavailable", charged: 0, price: 25 });
  });
  it("the refund deadline is committed_at + 10 minutes", () => {
    expect(revealDueAt("2026-10-02T12:30:00.000Z")).toBe("2026-10-02T12:40:00.000Z");
  });
});

describe("the locked reveal: the market, the commitment and the hashes; no verdict, no proposal, the card pointer", () => {
  const short = answer({ entitled_full: false, charged: 0, balance: 10, reason: "insufficient_credits" });
  it("lockedReveal: insufficient_credits with the price, the balance and the card top_up; billing_unavailable without a top-up", () => {
    const l = lockedReveal(short, top(), M)!;
    expect(l).toMatchObject({ reason: "insufficient_credits", price_credits: 25, balance: 10, read: `/v1/shadow/${M}`, top_up: { method: "card", checkout: "POST /v1/billing/checkout", page: `${BASE}/pricing#pay-by-card` } });
    expect(l.message).toContain("Nothing was charged");
    NO_USDC(JSON.stringify(l));
    expect(lockedReveal(answer({ entitled_full: false, charged: 0, balance: null, reason: "billing_unavailable" }), top(), M)).toMatchObject({ reason: "billing_unavailable", top_up: null, balance: null });
    expect(lockedReveal(answer(), top(), M)).toBeNull();
  });
  it("the locked shadow.committed: verdict null, venue identifiers kept with no proposal, evidence hashes, never the outcome or the nonce", () => {
    const p = shadowCommittedPayload(MARKET, COMMIT as never, { reason: "insufficient_credits", credits_charged: 0, replayed: false }, lockedReveal(short, top(), M));
    expect(p).toMatchObject({
      market_id: M, market: "polymarket:551234", commitment_sha256: "e".repeat(64), verdict: null,
      evidence: { raw_sha256: "d".repeat(64), canonical_sha256: "c".repeat(64) },
      venue: { platform: "polymarket", condition_id: CID, slug: "cpi-above-3", event_id: "60182", proposed_outcome_label: null },
      locked: { reason: "insufficient_credits", price_credits: 25, balance: 10 },
    });
    const json = JSON.stringify(p);
    expect(json).not.toContain("OPTION_");
    expect(json).not.toContain("n0nce");
    NO_USDC(json.replace(CID, ""));
    // a released one carries the verdict and the proposal
    expect(shadowCommittedPayload(MARKET, COMMIT as never, { reason: "charged", credits_charged: 25, replayed: false }, null)).toMatchObject({ verdict: { winning_outcome: "OPTION_A" }, venue: { proposed_outcome_label: "Yes" }, locked: null });
  });
  it("revealItems: one payload object for followers told the same thing; a charge taken now rides on the delivery with its deadline", () => {
    const items = revealItems(MARKET, COMMIT as never, [answer({ tenant_id: "a" }), answer({ tenant_id: "b" }), answer({ tenant_id: "c", reason: "replay", charged: 0, replayed: true }), short], top());
    expect(items[0]!.payload).toBe(items[1]!.payload);
    expect(items.map((i) => i.revealCharge?.requestId ?? null)).toEqual([revealRequestId("a", M), revealRequestId("b", M), null, null]);
    expect(items[0]!.revealCharge!.dueAt).toBe(revealDueAt(COMMIT.committed_at));
    expect(items.map((i) => i.priority)).toEqual([3, 3, 3, 0]);
  });
});

// ---- the push path ------------------------------------------------------------------------------------------------------

const endpoint = (id: string, tenant: string, events = ["shadow.committed", "shadow.revealed", "credits.low"]): Row => ({ id, tenant_id: tenant, url: `https://hooks.example/${id}`, secret: "whsec_test", active: true, deleted_at: null, consecutive_failures: 0, events });
const tenant = (id: string, plan: string, credits_balance: number, created_at = "2026-10-20T00:00:00.000Z"): Row => ({ id, plan, credits_balance, created_at, deleted_at: null, low_credit_notified_at: null });
const follow = (id: string, t: string, market = M): Row => ({ id, tenant_id: t, market_id: market, created_at: "2026-10-21T00:00:00.000Z", deleted_at: null });
const key = (t: string): Row => ({ id: `k-${t}`, tenant_id: t, revoked_at: null, deleted_at: null, expires_at: null });

/** Five followers: paying (1,000), short (10), Builder, a free key issued before the cut-over, a free key after it (300). */
function pushDb(): FakeDb {
  const ids = ["t_pay", "t_short", "t_builder", "t_old", "t_new"];
  return fakeDb({
    tenants: [tenant("t_pay", "payg", 1000), tenant("t_short", "payg", 10), tenant("t_builder", "builder", 0), tenant("t_old", "free", 300, "2026-09-01T00:00:00.000Z"), tenant("t_new", "free", 300)],
    api_keys: ids.map(key),
    markets: [{ ...MARKET }],
    market_follows: ids.map((t, i) => follow(`f${i}`, t)),
    webhook_endpoints: ids.map((t) => endpoint(`e_${t}`, t)),
    webhook_deliveries: [], credit_ledger: [],
  }, {}, { rpc: { ...REVEAL_RPCS, follow_entitlements: followEntitlements } });
}
const deliveries = () => h.db.tables.webhook_deliveries!;
const shadowRows = () => deliveries().filter((d) => d.event_type === "shadow.committed");
const of = (t: string) => shadowRows().find((d) => d.tenant_id === t)!;
const sentKeys = () => vi.mocked(alertMany).mock.calls.flatMap((c) => c[1].map((i) => i.key));

let posts: string[];
beforeEach(() => {
  posts = [];
  vi.mocked(alert).mockClear(); vi.mocked(alertMany).mockClear();
  vi.stubGlobal("fetch", async (url: string) => { posts.push(String(url)); return new Response("ok", { status: 200 }); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); __setRailsForMutationTesting([]); });

describe("publishShadowCommitted: one charge_reveals() call per publish, paid reveals first", () => {
  it("each follower gets what it is owed: charged, locked, included, grandfathered; one ledger row per charge", async () => {
    h.db = pushDb();
    const r = await publishShadowCommitted(env, MARKET, COMMIT as never);
    expect(r).toMatchObject({ followers: 5, error: null, charged: 50, locked: 1 });
    expect(h.db.calls.filter((c) => c.table === "rpc:charge_reveals")).toHaveLength(1);
    expect(of("t_pay").payload).toMatchObject({ verdict: { winning_outcome: "OPTION_A" }, reveal: { reason: "charged", credits_charged: 25 }, locked: null });
    expect(of("t_new").payload).toMatchObject({ verdict: { winning_outcome: "OPTION_A" }, reveal: { reason: "charged", credits_charged: 25 } });
    expect(of("t_builder").payload).toMatchObject({ verdict: { winning_outcome: "OPTION_A" }, reveal: { reason: "included_plan", credits_charged: 0 } });
    expect(of("t_old").payload).toMatchObject({ verdict: { winning_outcome: "OPTION_A" }, reveal: { reason: "grandfathered", credits_charged: 0 } });
    expect(of("t_short").payload).toMatchObject({ verdict: null, venue: { proposed_outcome_label: null }, locked: { reason: "insufficient_credits", price_credits: 25, balance: 10, top_up: { method: "card" } } });
    NO_USDC(JSON.stringify(of("t_short").payload).replace(CID, ""));
    expect(h.db.tables.credit_ledger!.map((l) => [l.tenant_id, l.delta, l.request_id, l.note])).toEqual([
      ["t_new", -25, revealRequestId("t_new", M), "reveal webhook"], ["t_pay", -25, revealRequestId("t_pay", M), "reveal webhook"],
    ]);
    expect(h.db.tables.tenants!.find((t) => t.id === "t_short")!.credits_balance).toBe(10); // locked: nothing charged
    // the charged deliveries carry their charge and its refund deadline; no other delivery does
    expect(shadowRows().filter((d) => d.reveal_charge_id).map((d) => [d.tenant_id, d.reveal_due_at]).sort()).toEqual([["t_new", revealDueAt(COMMIT.committed_at)], ["t_pay", revealDueAt(COMMIT.committed_at)]]);
  });

  it("paid reveals get the inline attempts; the drain's claim takes the rest highest priority first", async () => {
    h.db = pushDb();
    await publishShadowCommitted(env, MARKET, COMMIT as never);
    expect(posts.sort()).toEqual(["https://hooks.example/e_t_new", "https://hooks.example/e_t_pay"]);
    expect(Object.fromEntries(shadowRows().map((d) => [d.tenant_id, d.priority]))).toEqual({ t_pay: 3, t_new: 3, t_builder: 2, t_old: 1, t_short: 0 });
    const pending = deliveries().filter((d) => d.status === "pending");
    expect(inlineCandidates(pending, 10).map((d) => d.tenant_id).filter((t, i, a) => a.indexOf(t) === i)).toEqual(["t_builder", "t_old", "t_new", "t_short"]);
  });

  it("a crossing of the low-credit threshold: credits.low in the same insert and the operator alert in the one alertMany", async () => {
    h.db = pushDb();
    await publishShadowCommitted(env, MARKET, COMMIT as never);
    const low = deliveries().filter((d) => d.event_type === "credits.low");
    expect(low.map((d) => [d.tenant_id, d.payload.balance, d.payload.request_id])).toEqual([["t_new", 275, revealRequestId("t_new", M)]]);
    expect(low[0]!.payload.top_up).toMatchObject({ method: "card" });
    expect(vi.mocked(alertMany)).toHaveBeenCalledTimes(1);
    expect(sentKeys()).toEqual([`credits_low_t_new_${revealRequestId("t_new", M)}`]);
  });

  it("a verdict that is not RESOLVED: no charge_reveals call, every follower gets it in full, nothing charged", async () => {
    h.db = pushDb();
    const r = await publishShadowCommitted(env, MARKET, commitAt(new Date().toISOString(), "UNRESOLVED") as never);
    expect(r).toMatchObject({ followers: 5, charged: 0, locked: 0 });
    expect(h.db.calls.some((c) => c.table === "rpc:charge_reveals")).toBe(false);
    expect(shadowRows().map((d) => d.payload.reveal.reason)).toEqual(Array(5).fill("not_resolved"));
    expect(shadowRows().every((d) => d.payload.verdict?.resolution_status === "UNRESOLVED" && !d.reveal_charge_id)).toBe(true);
    expect(h.db.tables.credit_ledger).toEqual([]);
  });

  it("charge_reveals fails: included plans get the verdict, the rest a locked billing_unavailable payload, nothing charged, one alert", async () => {
    h.db = pushDb();
    h.db.options.rpc!.charge_reveals = async () => ({ data: null, error: { code: "57014", message: "statement timeout" } });
    const r = await publishShadowCommitted(env, MARKET, COMMIT as never);
    expect(r).toMatchObject({ followers: 5, charged: 0, locked: 4, error: null });
    expect(of("t_builder").payload).toMatchObject({ verdict: { winning_outcome: "OPTION_A" }, reveal: { reason: "included_plan" } });
    for (const t of ["t_pay", "t_short", "t_old", "t_new"]) expect(of(t).payload, t).toMatchObject({ verdict: null, locked: { reason: "billing_unavailable", top_up: null } });
    expect(h.db.tables.credit_ledger).toEqual([]);
    expect(shadowRows().some((d) => d.reveal_charge_id)).toBe(false);
    expect(vi.mocked(alertMany)).toHaveBeenCalledTimes(1);
    expect(sentKeys()).toEqual(["shadow_reveal_billing_unavailable"]);
    expect(vi.mocked(alertMany).mock.calls[0]![1][0]!.text).toContain("statement timeout");
  });

  it("a follower without an endpoint for shadow.committed is not charged at publish (its first read is)", async () => {
    h.db = pushDb();
    h.db.tables.webhook_endpoints = h.db.tables.webhook_endpoints!.map((e) => (e.tenant_id === "t_pay" ? { ...e, events: ["market.resolved"] } : e));
    const r = await publishShadowCommitted(env, MARKET, COMMIT as never);
    expect(r.followers).toBe(5);
    expect(h.db.tables.credit_ledger!.map((l) => l.tenant_id)).toEqual(["t_new"]);
  });

  it("a later commit of the same market is a replay: delivered free, priority 3, no second charge", async () => {
    h.db = pushDb();
    await publishShadowCommitted(env, MARKET, COMMIT as never);
    await publishShadowCommitted(env, MARKET, { ...COMMIT, id: "c2", commitment_sha256: "f".repeat(64) } as never);
    expect(h.db.tables.credit_ledger).toHaveLength(2);
    const second = shadowRows().filter((d) => d.payload.commitment_sha256 === "f".repeat(64) && d.tenant_id === "t_pay")[0]!;
    expect([second.payload.reveal, second.priority, second.reveal_charge_id ?? null]).toEqual([{ reason: "replay", credits_charged: 0, replayed: true }, 3, null]);
  });

  it(`subrequests before the inline attempt: the follows, the endpoints, one charge, one insert (COMMITTED_QUEUE_SUBREQUESTS = 4 + one alert)`, async () => {
    expect(COMMITTED_QUEUE_SUBREQUESTS).toBe(4 * COST.db + COST.alert);
    expect(QUEUE_SUBREQUESTS).toBe(3 * COST.db + COST.alert); // shadow.revealed is not priced
    h.db = pushDb();
    await publishShadowCommitted(env, MARKET, COMMIT as never);
    const firstClaim = h.db.calls.findIndex((c) => c.table === "webhook_deliveries" && c.action === "update");
    expect(h.db.calls.slice(0, firstClaim)).toEqual([
      { table: "rpc:follow_entitlements", action: "rpc" }, { table: "webhook_endpoints", action: "select" },
      { table: "rpc:charge_reveals", action: "rpc" }, { table: "webhook_deliveries", action: "insert" },
    ]);
    expect(vi.mocked(alertMany).mock.calls.length).toBeLessThanOrEqual(1);
  });
});

// ---- the pull paths -----------------------------------------------------------------------------------------------------

const call = async (method: string, path: string, body?: unknown) => {
  const init: RequestInit = { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }) };
  const res = await v1.request(path, init, env, ctx);
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as Record<string, any> };
};
const commitRow = (id: string, market: string, createdAt: string, status: "RESOLVED" | "UNRESOLVED" = "RESOLVED"): Row => ({ id, market_id: market, kind: "commit", commitment_sha256: id.padEnd(64, "0").slice(0, 64), nonce: "n0nce", created_at: createdAt, channel: "telegram", telegram_date: createdAt, payload: { committed: committedOf(status) } });

function pullDb(balance: number, plan = "payg"): FakeDb {
  return fakeDb({
    tenants: [tenant("t_pay", plan, balance)],
    api_keys: [key("t_pay")],
    markets: [{ ...MARKET }, { ...MARKET, id: uuid(2), external_id: "551235", event_key: "polymarket:event:2" }],
    market_follows: [follow("f1", "t_pay"), follow("f2", "t_pay", uuid(2))],
    bot_posts: [commitRow("a1", M, "2026-10-21T12:30:00.000Z")],
    credit_ledger: [], webhook_endpoints: [], webhook_deliveries: [], api_request_log: [],
  }, {}, { rpc: { ...REVEAL_RPCS, follow_entitlements: followEntitlements } });
}

describe("GET /v1/shadow/:market_id: 200 with a locked verdict at a short balance; released and charged after a top-up; a replay free", () => {
  beforeEach(() => { h.tenant = "t_pay"; h.plan = "payg"; });

  it("short balance: 200, the commitment and hashes, verdict null, the locked object with the card pointer; nothing charged", async () => {
    h.db = pullDb(10);
    const r = await call("GET", `/shadow/${M}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ credits_charged: 0, balance: 10, reveal: { reason: "insufficient_credits" }, locked: { reason: "insufficient_credits", price_credits: 25, balance: 10, top_up: { method: "card", checkout: "POST /v1/billing/checkout" } } });
    expect(r.body.data.latest).toMatchObject({ commitment_sha256: expect.any(String), verdict: null, locked: true, evidence: { raw_sha256: "d".repeat(64) } });
    expect(JSON.stringify(r.body)).not.toContain("OPTION_");
    NO_USDC(JSON.stringify(r.body));
    expect(h.db.tables.credit_ledger).toEqual([]);
  });

  it("after a top-up the next read releases the verdict and charges 25 (note 'reveal read'); the read after that is a free replay", async () => {
    h.db = pullDb(10);
    await call("GET", `/shadow/${M}`);
    h.db.tables.tenants![0]!.credits_balance = 2000;
    const paid = await call("GET", `/shadow/${M}`);
    expect(paid.body.data).toMatchObject({ credits_charged: 25, balance: 1975, reveal: { reason: "charged", credits_charged: 25 }, locked: null, latest: { verdict: { winning_outcome: "OPTION_A" }, locked: false } });
    expect(h.db.tables.credit_ledger!.map((l) => [l.request_id, l.delta, l.note])).toEqual([[revealRequestId("t_pay", M), -25, "reveal read"]]);
    const again = await call("GET", `/shadow/${M}`);
    expect(again.body.data).toMatchObject({ credits_charged: 0, reveal: { reason: "replay", replayed: true }, latest: { verdict: { winning_outcome: "OPTION_A" } } });
    expect(h.db.tables.credit_ledger).toHaveLength(1);
  });

  it("one charge per tenant and market covers every commit; a commit that is not RESOLVED is shown in full even when locked", async () => {
    h.db = pullDb(10);
    h.db.tables.bot_posts!.push(commitRow("b2", M, "2026-10-21T13:00:00.000Z", "UNRESOLVED"));
    const r = await call("GET", `/shadow/${M}`);
    const [newer, older] = r.body.data.commits;
    expect([newer.verdict?.resolution_status, newer.locked]).toEqual(["UNRESOLVED", false]);
    expect([older.verdict, older.locked]).toEqual([null, true]);
  });

  it("a market with no RESOLVED commit is not priced: no charge_reveals call", async () => {
    h.db = pullDb(0);
    h.db.tables.bot_posts = [commitRow("c3", M, "2026-10-21T12:30:00.000Z", "UNRESOLVED")];
    const r = await call("GET", `/shadow/${M}`);
    expect(r.body.data).toMatchObject({ reveal: null, locked: null, credits_charged: 0, latest: { verdict: { resolution_status: "UNRESOLVED" } } });
    expect(h.db.calls.some((c) => c.table === "rpc:charge_reveals")).toBe(false);
  });

  it("an included plan reads it free; billing that fails locks a paying plan's read (200, billing_unavailable) and alerts", async () => {
    h.db = pullDb(0, "growth");
    expect((await call("GET", `/shadow/${M}`)).body.data).toMatchObject({ reveal: { reason: "included_plan", credits_charged: 0 }, latest: { verdict: { winning_outcome: "OPTION_A" } } });
    h.db = pullDb(1000);
    h.db.options.rpc!.charge_reveals = async () => ({ data: null, error: { code: "57014", message: "statement timeout" } });
    const r = await call("GET", `/shadow/${M}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ locked: { reason: "billing_unavailable" }, latest: { verdict: null } });
    expect(vi.mocked(alert).mock.calls.map((c) => c[1])).toContain("shadow_reveal_billing_unavailable");
  });
});

describe("GET /v1/shadow/export: locked rows hide committed_status and committed_outcome; one charge_reveals call", () => {
  const view = (id: string, eventKey: string, status = "RESOLVED"): Row => ({
    market_id: id, platform: "polymarket", external_id: `ext-${id.slice(0, 4)}`, event_key: eventKey, venue_slug: "s", status: "open", n_commits: 1,
    latest_committed_at: "2026-10-21T12:30:00.000Z", latest_commitment_sha256: "e".repeat(64), committed_status: status, committed_outcome: status === "RESOLVED" ? "OPTION_A" : "NONE",
    evidence_raw_sha256: "a".repeat(64), evidence_canonical_sha256: "b".repeat(64), official_outcome: null, official_at: null, official_at_source: null, agreement: null, lead_seconds: null, reconciled_at: null,
  });
  beforeEach(() => { h.tenant = "t_pay"; h.plan = "payg"; });

  it("30 credits for two RESOLVED legs of two events: one released and charged, the other locked; the top-up pointer; then a replay", async () => {
    h.db = pullDb(30);
    h.db.tables.market_follows = h.db.tables.market_follows!.map((f) => ({ ...f, markets: { platform: "polymarket", status: "open", deleted_at: null } }));
    h.db.tables.v_venue_report = [view(M, EVENT), view(uuid(2), "polymarket:event:2")];
    const r = await call("GET", "/shadow/export");
    expect(r.status).toBe(200);
    const rows = r.body.data.rows as Row[];
    const shown = rows.filter((x) => x.committed_status === "RESOLVED"), hidden = rows.filter((x) => x.committed_status === null);
    expect([shown.length, hidden.length]).toEqual([1, 1]);
    expect(hidden[0]).toMatchObject({ committed_outcome: null, reveal: "insufficient_credits", commitment_sha256: "e".repeat(64), evidence_raw_sha256: "a".repeat(64) });
    expect(shown[0]).toMatchObject({ committed_outcome: "OPTION_A", reveal: "charged" });
    expect(r.body.data).toMatchObject({ credits_charged: 25, locked_rows: 1, balance: 5, top_up: { method: "card" } });
    NO_USDC(JSON.stringify(r.body));
    expect(h.db.calls.filter((c) => c.table === "rpc:charge_reveals")).toHaveLength(1);
    const csv = await v1.request("/shadow/export?format=csv", { method: "GET" }, env, ctx);
    expect([csv.headers.get("x-resolve-credits-charged"), csv.headers.get("x-resolve-locked")]).toEqual(["0", "1"]);
    const text = await csv.text();
    expect(text.split("\r\n").filter((l) => l.includes(",OPTION_A,")).length).toBe(1); // the locked row's outcome never reaches the CSV
    expect(h.db.tables.credit_ledger).toHaveLength(1);
  });

  it("the event cap: 81 RESOLVED legs of one event cost 2,000 credits; the 81st is free (event_cap_reached) and shown", async () => {
    const legs = Array.from({ length: 81 }, (_, i) => uuid(100 + i));
    h.db = pullDb(5000, "payg");
    h.db.tables.markets = legs.map((id, i) => ({ ...MARKET, id, external_id: `leg-${i}`, event_key: EVENT }));
    h.db.tables.market_follows = legs.map((id, i) => ({ ...follow(`g${i}`, "t_pay", id), created_at: new Date(Date.parse("2026-10-21T00:00:00Z") + i).toISOString(), markets: { platform: "polymarket", status: "open", deleted_at: null } }));
    h.db.tables.v_venue_report = legs.map((id) => view(id, EVENT));
    const r = await call("GET", "/shadow/export");
    expect(r.body.data).toMatchObject({ credits_charged: 2000, locked_rows: 0, balance: 3000 });
    const reasons = (r.body.data.rows as Row[]).map((x) => x.reveal);
    expect([reasons.filter((x) => x === "charged").length, reasons.filter((x) => x === "event_cap_reached").length]).toEqual([80, 1]);
    expect((r.body.data.rows as Row[]).every((x) => x.committed_status === "RESOLVED")).toBe(true);
  });
});

// ---- following a whole event --------------------------------------------------------------------------------------------

describe("POST /v1/markets/:id/follow {\"scope\":\"event\"}: every open public leg in one transaction, all or nothing", () => {
  const OFFICIAL = "official:us_unemployment_rate:2026-09";
  const leg = (n: number, over: Row = {}): Row => ({ ...MARKET, id: uuid(n), platform: n % 2 ? "polymarket" : "limitless", external_id: `leg-${n}`, event_key: OFFICIAL, ...over });
  function eventDb(plan: string): FakeDb {
    return fakeDb({
      tenants: [tenant("t_pay", plan, 1000)], api_keys: [key("t_pay")],
      markets: [leg(1), leg(2), leg(3), leg(4, { status: "resolved" }), leg(5, { is_test: true }), leg(6, { tenant_id: "t_other" }), leg(7, { deleted_at: "2026-10-01T00:00:00Z" }), { ...MARKET, id: uuid(9), event_key: "polymarket:event:9" }],
      market_follows: [], webhook_endpoints: [endpoint("e1", "t_pay")], api_request_log: [],
    }, {}, { rpc: { ...REVEAL_RPCS, ...FOLLOW_RPCS } });
  }
  beforeEach(() => { h.tenant = "t_pay"; });

  it("follows the three open public legs (on both venues) and says how many; again: 200, none followed, three already", async () => {
    h.db = eventDb("payg");
    const a = await call("POST", `/markets/${uuid(1)}/follow`, { scope: "event" });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ scope: "event", event_key: OFFICIAL, legs: 3, followed: 3, already_following: 0, follows_counted: 3, follow_limit: 500, endpoints_subscribed: 1, reveal_price: { terms: "pays", credits_per_resolved_leg: 25, event_cap_credits: 2000 } });
    expect(h.db.tables.market_follows!.map((f) => f.market_id).sort()).toEqual([uuid(1), uuid(2), uuid(3)]);
    const b = await call("POST", `/markets/${uuid(2)}/follow`, { scope: "event" });
    expect(b.status).toBe(200);
    expect(b.body.data).toMatchObject({ legs: 3, followed: 0, already_following: 3 });
    expect(h.db.tables.market_follows).toHaveLength(3);
  });

  it("all or nothing against the cap: a free key with 48 open follows cannot follow a 3-leg event (403, nothing written); 47 can", async () => {
    h.db = eventDb("free");
    for (let i = 0; i < 48; i++) {
      h.db.tables.markets!.push({ ...MARKET, id: uuid(500 + i), event_key: `x:${i}` });
      h.db.tables.market_follows!.push(follow(`o${i}`, "t_pay", uuid(500 + i)));
    }
    const r = await call("POST", `/markets/${uuid(1)}/follow`, { scope: "event" });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ follow_limit: 50, follows_counted: 48, legs: 3, already_following: 0, event_key: OFFICIAL });
    expect(r.body.error.message).toContain("Nothing was followed");
    expect(h.db.tables.market_follows).toHaveLength(48);
    h.db.tables.market_follows!.pop();
    expect((await call("POST", `/markets/${uuid(1)}/follow`, { scope: "event" })).status).toBe(201);
    expect(h.db.tables.market_follows).toHaveLength(50);
  });

  it("without a body, or with scope market, the one market as before; a body that is not {scope} is a 400 before anything is written", async () => {
    h.db = eventDb("payg");
    const one = await call("POST", `/markets/${uuid(1)}/follow`);
    expect([one.status, one.body.data.market_id, one.body.data.scope]).toEqual([201, uuid(1), undefined]);
    expect((await call("POST", `/markets/${uuid(2)}/follow`, { scope: "market" })).body.data.market_id).toBe(uuid(2));
    expect(h.db.tables.market_follows).toHaveLength(2);
    for (const bad of [{ scope: "world" }, { scope: "event", extra: 1 }, "not json"]) {
      const r = await call("POST", `/markets/${uuid(3)}/follow`, bad);
      expect([r.status, r.body.error.code], JSON.stringify(bad)).toEqual([400, "validation_error"]);
    }
    expect(h.db.tables.market_follows).toHaveLength(2);
  });

  it("a settled market is refused for the event scope too (400); the follow answer states an included plan's price as 0", async () => {
    h.db = eventDb("builder");
    expect((await call("POST", `/markets/${uuid(4)}/follow`, { scope: "event" })).status).toBe(400);
    expect((await call("POST", `/markets/${uuid(1)}/follow`)).body.data.reveal_price).toMatchObject({ terms: "included_plan", credits_per_resolved_leg: 0 });
  });

  it("follow caps: an evaluation key 50, pay as you go 500, Builder 50, Growth 500, Platform unlimited", () => {
    expect(Object.fromEntries(PLANS.map((p) => [p, followCap(p)]))).toEqual({ free: 50, payg: 500, builder: 50, growth: 500, platform: null });
  });
});

// ---- the refund rule ------------------------------------------------------------------------------------------------------

describe("the refund rule: a charged reveal not delivered within 10 minutes of committed_at is refunded once; a read's charge never", () => {
  const ELEVEN_MIN_AGO = () => new Date(Date.now() - 11 * 60_000).toISOString();
  const refund = () => h.db.client.rpc("refund_late_reveals", { p_late_minutes: REVEAL_LATE_MINUTES });
  const refunds = () => h.db.tables.credit_ledger!.filter((l) => l.reason === "refund");
  async function charged(): Promise<Row[]> {
    h.db = pushDb();
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 })); // the inline attempts fail: rows stay pending
    await publishShadowCommitted(env, MARKET, commitAt(ELEVEN_MIN_AGO()) as never);
    return shadowRows().filter((d) => d.tenant_id === "t_pay");
  }

  it("every delivery dead-lettered: refunded once; the next run refunds nothing", async () => {
    for (const d of await charged()) d.status = "dlq";
    expect((await refund()).data).toMatchObject({ refunded: 2 }); // t_pay and t_new
    expect(refunds().map((l) => l.request_id).sort()).toEqual([revealRequestId("t_new", M), revealRequestId("t_pay", M)].sort());
    expect(h.db.tables.tenants!.find((t) => t.id === "t_pay")!.credits_balance).toBe(1000);
    expect((await refund()).data).toMatchObject({ refunded: 0 });
    expect(refunds()).toHaveLength(2);
  });

  it("the first successful delivery more than 10 minutes after committed_at: refunded; delivered in time: not", async () => {
    const [d] = await charged();
    Object.assign(d!, { status: "delivered", delivered_at: new Date(Date.parse(d!.reveal_due_at) + 60_000).toISOString() });
    const other = shadowRows().find((x) => x.tenant_id === "t_new")!;
    Object.assign(other, { status: "delivered", delivered_at: new Date(Date.parse(other.reveal_due_at) - 60_000).toISOString() });
    await refund();
    expect(refunds().map((l) => l.request_id)).toEqual([revealRequestId("t_pay", M)]);
  });

  it("still retrying at the deadline: refunded (it can only be late or dead-lettered); before the deadline: nothing yet", async () => {
    h.db = pushDb();
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    await publishShadowCommitted(env, MARKET, commitAt(new Date().toISOString()) as never);
    expect((await refund()).data).toMatchObject({ refunded: 0 });
    for (const d of shadowRows()) if (d.reveal_due_at) d.reveal_due_at = new Date(Date.now() - 1000).toISOString();
    expect((await refund()).data).toMatchObject({ refunded: 2 });
  });

  it("a charge taken by a read (GET /v1/shadow) is never refunded", async () => {
    h.tenant = "t_pay"; h.plan = "payg";
    h.db = pullDb(1000);
    await call("GET", `/shadow/${M}`);
    h.db.tables.credit_ledger![0]!.created_at = new Date(Date.now() - 60 * 60_000).toISOString();
    expect((await refund()).data).toMatchObject({ refunded: 0 });
    expect(refunds()).toEqual([]);
  });
});

// ---- credits.low after a read's charge ---------------------------------------------------------------------------------------

describe("noteCrossings: credits.low for a crossing the reveal charge already claimed", () => {
  const crossing = { tenantId: "t_new", plan: "free", balance: 275, threshold: 500, requestId: revealRequestId("t_new", M) };
  it("queues credits.low (card top_up) and tells the operator once, in one alertMany", async () => {
    h.db = fakeDb({ webhook_endpoints: [endpoint("e1", "t_new")], webhook_deliveries: [] });
    await noteCrossings(env, [crossing], BASE);
    expect(h.db.tables.webhook_deliveries!.map((d) => [d.event_type, d.payload.balance, d.payload.top_up.method])).toEqual([["credits.low", 275, "card"]]);
    expect(sentKeys()).toEqual([`credits_low_t_new_${crossing.requestId}`]);
  });
  it("an event that cannot be queued gives the claim back and the crossing reaches the operator inside the failure alert", async () => {
    const released: unknown[] = [];
    h.db = fakeDb({ webhook_endpoints: [endpoint("e1", "t_new")] }, {}, { rpc: { release_low_credit_notice: async (_db, a) => { released.push(a.p_tenant); return { data: null, error: null }; } } });
    const from = h.db.client.from;
    h.db.client.from = ((t: string) => (t === "webhook_deliveries" ? { insert: () => ({ select: async () => ({ data: null, error: { message: "timeout" } }) }) } : from(t))) as never;
    await noteCrossings(env, [crossing], BASE);
    expect(released).toEqual(["t_new"]);
    expect(sentKeys()).toEqual(["low_credit_event_failed_t_new"]);
    expect(vi.mocked(alertMany).mock.calls[0]![1][0]!.text).toContain("Credits low: first paid use (free plan)");
  });
});

// ---- the rails --------------------------------------------------------------------------------------------------------------

describe("the rails are load-bearing: evals/reveal.ts is green with them and red without each (controls stay green)", () => {
  it("reveal_lock and reveal_charge", async () => {
    const on = await runRevealSuite({ quiet: true });
    expect([on.grader_fail, on.harness_error, on.cases > 0]).toEqual([0, 0, true]);
    for (const [rail, group] of [["reveal_lock", "lock"], ["reveal_charge", "charge"]] as const) {
      __setRailsForMutationTesting([rail]);
      const off = await runRevealSuite({ groups: [group], quiet: true });
      __setRailsForMutationTesting([]);
      expect(off.grader_fail, rail).toBeGreaterThan(0);
      expect(off.harness_error, rail).toBe(0);
      expect(off.outcomes.filter((o) => o.control && o.result !== "pass"), rail).toEqual([]);
    }
  });
});

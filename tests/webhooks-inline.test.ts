/**
 * Inline first delivery attempt (plan §18 (a)): the publisher queues the rows, claims them exactly as
 * claim_webhook_deliveries() does (status 'delivering' + 60 s lease, only while 'pending'), and attempts them at once;
 * the 5-minute drain stays the retry path and can never deliver a row the inline path claimed, or the reverse. Also the
 * waitUntil / short-await split and the follower fan-out of shadow.committed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { MarketRow } from "../src/ingest/types";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", () => ({
  db: () => h.db.client,
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })), alertMany: vi.fn(async () => ({ sent: [], deduped: [] })) }));

import { attemptInline, byEndpoint, claimPatch, deliverInline, drainWebhooks, inlineCandidates, inlineSubrequests, publishEvent, settleWithin, DELIVERY_COST, DRAIN_MAX, INLINE_MAX, LEASE_SECONDS } from "../src/webhooks/deliver";
import { publishShadowCommitted } from "../src/shadow/events";
import { alert, alertMany } from "../src/ops/alerts";
import { Budget, COST } from "../src/ops/budget";

const env = {} as Env;
const endpoint = (id: string, tenant: string, events: string[] = ["market.resolved", "shadow.committed"]): Row => ({ id, tenant_id: tenant, url: `https://hooks.example/${id}`, secret: "whsec_test", active: true, deleted_at: null, consecutive_failures: 0, events });
/** claim_webhook_deliveries(): due pending rows, oldest first, leased as 'delivering' (migration 009). */
const claim = async (db: FakeDb, a: Record<string, any>) => {
  const due = db.tables.webhook_deliveries!.filter((d) => d.status === "pending" && String(d.next_attempt_at ?? "") <= new Date().toISOString()).slice(0, a.p_max);
  for (const d of due) Object.assign(d, { status: "delivering", lease_until: new Date(Date.now() + 60_000).toISOString() });
  return { data: structuredClone(due), error: null };
};
const newDb = (endpoints: Row[], deliveries: Row[] = []) => fakeDb({ webhook_endpoints: endpoints, webhook_deliveries: deliveries }, {}, { rpc: { claim_webhook_deliveries: claim } });
const rows = () => h.db.tables.webhook_deliveries!;

let posts: string[];
let status: (url: string) => number;
beforeEach(() => {
  posts = []; status = () => 200;
  vi.mocked(alert).mockClear(); vi.mocked(alertMany).mockClear();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    posts.push(String(url));
    expect(JSON.parse(String(init.body))).toHaveProperty("data"); // the signed envelope
    return new Response("ok", { status: status(String(url)) });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("pure parts", () => {
  it("claimPatch is claim_webhook_deliveries()'s claim: 'delivering' with a 60 s lease", () => {
    const now = Date.parse("2026-10-01T12:00:00.000Z");
    expect(claimPatch(now)).toEqual({ status: "delivering", lease_until: "2026-10-01T12:01:00.000Z" });
    expect(LEASE_SECONDS).toBe(60);
  });
  it("inlineCandidates: still-pending rows in queue order, at most max", () => {
    const r = (id: string, created: string, st = "pending") => ({ id, created_at: created, status: st });
    const q = [r("c", "2026-10-01T00:00:02Z"), r("a", "2026-10-01T00:00:01Z"), r("x", "2026-10-01T00:00:00Z", "delivering"), r("b", "2026-10-01T00:00:01Z")];
    expect(inlineCandidates(q, 5).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(inlineCandidates(q, 2).map((x) => x.id)).toEqual(["a", "b"]);
    expect(inlineCandidates(q, 0)).toEqual([]);
  });
  it("byEndpoint keeps one endpoint's rows together, in order", () => {
    const q = [{ id: "1", endpoint_id: "e1" }, { id: "2", endpoint_id: "e2" }, { id: "3", endpoint_id: "e1" }];
    expect(byEndpoint(q).map((g) => g.map((x) => x.id))).toEqual([["1", "3"], ["2"]]);
  });
  it("the inline budget: claim + INLINE_MAX deliveries + one alert", () => {
    expect(inlineSubrequests(INLINE_MAX)).toBe(COST.db + INLINE_MAX * DELIVERY_COST + COST.alert);
    expect(inlineSubrequests(INLINE_MAX)).toBe(14);
  });
  it("settleWithin: the promise's settlement or the timeout, whichever is first", async () => {
    expect(await settleWithin(Promise.resolve(1), 1000)).toBe("settled");
    expect(await settleWithin(Promise.reject(new Error("x")), 1000)).toBe("settled");
    expect(await settleWithin(new Promise(() => undefined), 5)).toBe("timed_out");
  });
});

describe("publishEvent: queue, claim, first attempt now; the drain never delivers twice", () => {
  it("delivers inline and leaves nothing for the drain", async () => {
    h.db = newDb([endpoint("e1", "t1")]);
    expect(await publishEvent(env, "t1", "market.resolved", { x: 1 })).toEqual({ queued: 1 });
    expect(posts).toEqual(["https://hooks.example/e1"]);
    expect(rows()[0]).toMatchObject({ status: "delivered", attempt: 1, lease_until: null });
    const d = await drainWebhooks(env, DRAIN_MAX);
    expect(d).toMatchObject({ claimed: 0, delivered: 0 });
    expect(posts).toHaveLength(1);
  });

  it("a failed inline attempt is the drain's retry at the next backoff step, not a second immediate try", async () => {
    status = () => 503;
    h.db = newDb([endpoint("e1", "t1")]);
    await publishEvent(env, "t1", "market.resolved", { x: 1 });
    expect(rows()[0]).toMatchObject({ status: "pending", attempt: 1, last_error: "HTTP 503", lease_until: null });
    expect(Date.parse(rows()[0]!.next_attempt_at) - Date.now()).toBeGreaterThan(55_000); // 60 s backoff
    expect((await drainWebhooks(env, DRAIN_MAX)).claimed).toBe(0); // not due yet
    rows()[0]!.next_attempt_at = new Date(Date.now() - 1000).toISOString();
    status = () => 200;
    expect(await drainWebhooks(env, DRAIN_MAX)).toMatchObject({ claimed: 1, delivered: 1 });
    expect(rows()[0]).toMatchObject({ status: "delivered", attempt: 2 });
  });

  it("a row the drain claimed first is left to it: the inline claim takes only 'pending' rows", async () => {
    h.db = newDb([endpoint("e1", "t1")]);
    const queued = [{ id: "d1", endpoint_id: "e1", tenant_id: "t1", event_id: "ev1", event_type: "market.resolved", payload: {}, status: "pending", attempt: 0, created_at: "2026-10-01T00:00:00Z" }];
    h.db.tables.webhook_deliveries = [{ ...queued[0]!, status: "delivering", lease_until: new Date(Date.now() + 60_000).toISOString() }]; // the drain's claim won
    const r = await attemptInline(env, queued, new Budget(inlineSubrequests(INLINE_MAX)));
    expect(r).toMatchObject({ queued: 1, attempted: 0, delivered: 0, left_for_drain: 1 });
    expect(posts).toEqual([]);
    expect(rows()[0]!.status).toBe("delivering");
  });

  it("while an inline attempt holds its claim, the drain cannot claim the row", async () => {
    h.db = newDb([endpoint("e1", "t1")]);
    let releasePost!: () => void;
    vi.stubGlobal("fetch", (url: string) => { posts.push(String(url)); return new Promise<Response>((r) => { releasePost = () => r(new Response("ok")); }); });
    const inline = publishEvent(env, "t1", "market.resolved", { x: 1 });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(rows()[0]).toMatchObject({ status: "delivering", lease_until: expect.any(String) });
    expect((await drainWebhooks(env, DRAIN_MAX)).claimed).toBe(0);
    releasePost();
    await inline;
    expect(posts).toHaveLength(1);
    expect(rows()[0]!.status).toBe("delivered");
  });

  it("attempts at most INLINE_MAX rows inside its budget; the rest stay pending for the drain", async () => {
    const eps = Array.from({ length: 4 }, (_, i) => endpoint(`e${i}`, `t${i}`));
    h.db = newDb(eps);
    const before = h.db.calls.length;
    await publishEvent(env, eps.map((e) => String(e.tenant_id)), "shadow.committed", { m: 1 });
    expect(posts).toHaveLength(INLINE_MAX);
    expect(rows().map((r) => r.status).sort()).toEqual(["delivered", "delivered", "pending", "pending"]);
    const used = h.db.calls.length - before + posts.length;
    expect(used).toBeLessThanOrEqual(2 * COST.db + inlineSubrequests(INLINE_MAX)); // queueing (2) + inline
    const d = await drainWebhooks(env, DRAIN_MAX);
    expect(d).toMatchObject({ claimed: 2, delivered: 2 });
    expect(new Set(posts).size).toBe(4); // every endpoint exactly once
  });

  it("a budget too small for one delivery attempts nothing and spends nothing", async () => {
    h.db = newDb([endpoint("e1", "t1")]);
    const queued = await (await import("../src/webhooks/deliver")).enqueueEvent(env, "t1", "market.resolved", {});
    const budget = new Budget(COST.db + COST.alert + DELIVERY_COST - 1);
    const r = await attemptInline(env, queued, budget);
    expect(r).toMatchObject({ attempted: 0, left_for_drain: 1 });
    expect(budget.used).toBe(0);
    expect(rows()[0]!.status).toBe("pending");
  });

  it("a failed inline claim alerts and leaves the rows pending for the drain", async () => {
    h.db = newDb([endpoint("e1", "t1")]);
    const from = h.db.client.from;
    h.db.client.from = ((t: string) => {
      const q = from(t);
      if (t !== "webhook_deliveries") return q;
      return new Proxy(q, { get: (o, k) => (k === "update" ? () => { const f: any = { in: () => f, eq: () => f, select: async () => ({ data: null, error: { message: "canceling statement due to statement timeout" } }) }; return f; } : Reflect.get(o, k)) });
    }) as never;
    await publishEvent(env, "t1", "market.resolved", {});
    expect(posts).toEqual([]);
    expect(rows()[0]!.status).toBe("pending");
    expect(vi.mocked(alertMany).mock.calls[0]![1]!.map((i) => i.key)).toEqual(["webhook_inline_errors"]);
  });

  it("with waitUntil the attempt runs under it; without, it is awaited", async () => {
    h.db = newDb([endpoint("e1", "t1")]);
    const pending: Promise<unknown>[] = [];
    await publishEvent(env, "t1", "market.resolved", {}, { waitUntil: (p) => pending.push(p) });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(rows()[0]!.status).toBe("delivered");
    await deliverInline(env, []); // nothing queued: nothing scheduled
    expect(pending).toHaveLength(1);
  });
});

describe("publishShadowCommitted: followers of a public shadow market get the committed verdict", () => {
  const MARKET = { id: "m1", tenant_id: null, is_test: false, platform: "polymarket", external_id: "551234" } as unknown as MarketRow;
  const COMMIT = { id: "c1", commitment_sha256: "e".repeat(64), committed_at: "2026-10-02T00:00:00.000Z", committed: { preimage_version: "v2", preimage: "p|n0nce", resolution_status: "RESOLVED", winning_outcome: "OPTION_A", confidence_score: 0.95, caveats: [], canonical_sha256: "c".repeat(64), raw_sha256: "d".repeat(64), thresholds_version: "v1", determination_basis: "structured" } } as const;

  it("one row per subscribed endpoint of every active follower of a live tenant; delivered inline", async () => {
    h.db = newDb([endpoint("e1", "t1"), endpoint("e2", "t2", ["market.resolved"]), endpoint("e3", "t3")]);
    h.db.tables.market_follows = [
      { tenant_id: "t1", market_id: "m1", deleted_at: null, tenants: { deleted_at: null } },
      { tenant_id: "t2", market_id: "m1", deleted_at: null, tenants: { deleted_at: null } }, // no endpoint subscribed to shadow.committed
      { tenant_id: "t3", market_id: "m1", deleted_at: "2026-10-01T00:00:00Z", tenants: { deleted_at: null } }, // unfollowed
      { tenant_id: "t4", market_id: "m1", deleted_at: null, tenants: { deleted_at: "2026-10-01T00:00:00Z" } }, // tenant deleted
      { tenant_id: "t1", market_id: "m2", deleted_at: null, tenants: { deleted_at: null } },
    ];
    const r = await publishShadowCommitted(env, MARKET, COMMIT as never);
    expect(r).toMatchObject({ followers: 2, error: null });
    expect(rows().map((x) => [x.endpoint_id, x.event_type, x.status])).toEqual([["e1", "shadow.committed", "delivered"]]);
    expect(rows()[0]!.payload).toMatchObject({ market: "polymarket:551234", commitment_sha256: "e".repeat(64), verdict: { winning_outcome: "OPTION_A" } });
    expect(JSON.stringify(rows()[0]!.payload)).not.toContain("n0nce");
    expect(posts).toEqual(["https://hooks.example/e1"]);
  });

  it("test and tenant markets are skipped without a read", async () => {
    h.db = newDb([endpoint("e1", "t1")]);
    await publishShadowCommitted(env, { ...MARKET, is_test: true } as MarketRow, COMMIT as never);
    await publishShadowCommitted(env, { ...MARKET, tenant_id: "t9" } as MarketRow, COMMIT as never);
    expect(h.db.calls).toEqual([]);
  });

  it("followers that could not be read: nothing queued, alerted (the verdict stays readable at GET /v1/shadow)", async () => {
    h.db = newDb([endpoint("e1", "t1")]);
    const from = h.db.client.from;
    h.db.client.from = ((t: string) => (t === "market_follows" ? { select: () => { const q: any = { eq: () => q, is: () => q, then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "permission denied for table market_follows" } }).then(ok) }; return q; } } : from(t))) as never;
    const r = await publishShadowCommitted(env, MARKET, COMMIT as never);
    expect(r.error).toContain("permission denied");
    expect(rows()).toEqual([]);
    expect(vi.mocked(alert).mock.calls.map((c) => c[1])).toEqual(["shadow_followers_unreadable"]);
  });
});

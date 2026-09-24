/**
 * Webhook drain (plan §16.4 P0 step 7, P3 step 4 DLQ alert): a delivery moving to dlq alerts per endpoint
 * (webhook_dlq_<endpoint_id>, dedup 6 h) in one alertMany() per run, a claim or bookkeeping failure alerts, an
 * endpoint that could not be read is not called dead, the drain claims only what its fixed budget can finish, and a
 * row whose claiming run died ('delivering' long after its lease) is requeued, delivered and alerted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, failEndpointRead: false, failEndpointList: false }));
vi.mock("../src/db/supabase", () => ({
  db: () => ({
    ...h.db.client,
    from: (t: string) => {
      const q = h.db.client.from(t);
      if (t !== "webhook_endpoints" || !(h.failEndpointRead || h.failEndpointList)) return q;
      const failed = { data: null, error: { message: "canceling statement due to statement timeout" } };
      return new Proxy(q, {
        get: (o, k) => {
          if (h.failEndpointRead && k === "maybeSingle") return () => Promise.resolve(failed);
          if (h.failEndpointList && k === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(failed).then(ok);
          return Reflect.get(o, k);
        },
      });
    },
  }),
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })), alertMany: vi.fn(async () => ({ sent: [], deduped: [] })) }));

import { drainWebhooks, dlqAlerts, drainSubrequests, enqueueEvent, DRAIN_MAX, MAX_ATTEMPTS, DLQ_DEDUP_MINUTES, STALE_DELIVERING_MINUTES } from "../src/webhooks/deliver";
import { alert, alertMany } from "../src/ops/alerts";
import { Budget, COST } from "../src/ops/budget";

const env = {} as Env;
const endpoint = (id: string, over: Row = {}): Row => ({ id, url: `https://hooks.example/${id}`, secret: "whsec_test", active: true, deleted_at: null, consecutive_failures: 0, ...over });
const delivery = (id: string, endpointId: string, attempt: number): Row => ({ id, endpoint_id: endpointId, tenant_id: "t1", event_id: `ev-${id}`, event_type: "market.resolved", payload: { x: 1 }, status: "pending", attempt, next_attempt_at: "2026-01-01T00:00:00.000Z" });
/** claim_webhook_deliveries(): due pending rows, oldest first, leased as 'delivering'. */
const claim = async (db: FakeDb, a: Record<string, any>) => {
  const due = db.tables.webhook_deliveries!.filter((d) => d.status === "pending").slice(0, a.p_max);
  for (const d of due) d.status = "delivering";
  return { data: structuredClone(due), error: null };
};
const items = () => vi.mocked(alertMany).mock.calls.flatMap((c) => c[1]!.map((i) => [i.key, i.dedupMinutes]));

describe("dlqAlerts (pure)", () => {
  it("one alert per endpoint, keyed webhook_dlq_<endpoint_id>, dedup 360", () => {
    const a = dlqAlerts([
      { endpoint: "e1", tenant: "t1", delivery: "d1", reason: "7 attempts failed, last: HTTP 500" },
      { endpoint: "e1", tenant: "t1", delivery: "d2", reason: "7 attempts failed, last: HTTP 500" },
      { endpoint: "e2", tenant: "t2", delivery: "d3", reason: "endpoint inactive or deleted" },
    ]);
    expect(a.map((i) => [i.key, i.dedupMinutes])).toEqual([["webhook_dlq_e1", DLQ_DEDUP_MINUTES], ["webhook_dlq_e2", DLQ_DEDUP_MINUTES]]);
    expect(a[0]!.text).toContain("2 webhook deliveries to endpoint e1");
    expect(a[0]!.meta).toMatchObject({ endpoint_id: "e1", deliveries: ["d1", "d2"] });
    expect(DLQ_DEDUP_MINUTES).toBe(360);
  });
  it("no DLQ, no alert", () => expect(dlqAlerts([])).toEqual([]));
});

describe("drainWebhooks", () => {
  let posts: string[];
  let status: (url: string) => number;
  beforeEach(() => {
    posts = []; status = () => 200; h.failEndpointRead = false; h.failEndpointList = false;
    vi.mocked(alertMany).mockClear();
    vi.stubGlobal("fetch", async (url: string) => { posts.push(String(url)); return new Response("ok", { status: status(String(url)) }); });
  });
  afterEach(() => vi.unstubAllGlobals());
  const newDb = (endpoints: Row[], deliveries: Row[]) => fakeDb({ webhook_endpoints: endpoints, webhook_deliveries: deliveries }, {}, { rpc: { claim_webhook_deliveries: claim } });

  it("the last failed attempt moves to dlq and alerts once per endpoint in one alertMany", async () => {
    status = () => 500;
    h.db = newDb([endpoint("e1"), endpoint("e2")], [delivery("d1", "e1", MAX_ATTEMPTS - 1), delivery("d2", "e1", MAX_ATTEMPTS - 1), delivery("d3", "e2", MAX_ATTEMPTS - 1), delivery("d4", "e2", 0)]);
    const r = await drainWebhooks(env, DRAIN_MAX);
    expect(r).toMatchObject({ claimed: 4, dlq: 3, failed: 1, delivered: 0, errors: 0, alerts: ["webhook_dlq_e1", "webhook_dlq_e2"] });
    expect(vi.mocked(alertMany)).toHaveBeenCalledTimes(1);
    expect(items()).toEqual([["webhook_dlq_e1", 360], ["webhook_dlq_e2", 360]]);
    expect(h.db.tables.webhook_deliveries!.map((d) => [d.id, d.status])).toEqual([["d1", "dlq"], ["d2", "dlq"], ["d3", "dlq"], ["d4", "pending"]]);
  });

  it("an inactive endpoint DLQs its delivery and alerts; a healthy run alerts nothing", async () => {
    h.db = newDb([endpoint("e1", { active: false }), endpoint("e2")], [delivery("d1", "e1", 0), delivery("d2", "e2", 0)]);
    const r = await drainWebhooks(env, DRAIN_MAX);
    expect(r).toMatchObject({ dlq: 1, delivered: 1, alerts: ["webhook_dlq_e1"] });
    expect(posts).toEqual(["https://hooks.example/e2"]);
    vi.mocked(alertMany).mockClear();
    h.db = newDb([endpoint("e2")], [delivery("d9", "e2", 0)]);
    expect(await drainWebhooks(env, DRAIN_MAX)).toMatchObject({ delivered: 1, alerts: [] });
    expect(vi.mocked(alertMany)).not.toHaveBeenCalled();
  });

  it("an endpoint that could not be read is not dead: the row goes back to pending at the same attempt, and it alerts", async () => {
    h.failEndpointRead = true;
    h.db = newDb([endpoint("e1")], [delivery("d1", "e1", 2)]);
    const r = await drainWebhooks(env, DRAIN_MAX);
    expect(r).toMatchObject({ claimed: 1, dlq: 0, errors: 1, alerts: ["webhook_drain_errors"] });
    expect(h.db.tables.webhook_deliveries![0]).toMatchObject({ status: "pending", attempt: 2, lease_until: null });
    expect(posts).toEqual([]);
  });

  it("a failed claim alerts webhook_claim_failed", async () => {
    h.db = fakeDb({ webhook_endpoints: [], webhook_deliveries: [] }, {}, { rpc: { claim_webhook_deliveries: async () => ({ data: null, error: { code: "57014", message: "statement timeout" } }) } });
    const r = await drainWebhooks(env, DRAIN_MAX);
    expect(r.claim_error).toContain("statement timeout");
    expect(items()).toEqual([["webhook_claim_failed", 60]]);
  });

  it("claims only what the budget can finish and stays inside it", async () => {
    status = () => 500;
    const eps = Array.from({ length: 8 }, (_, i) => endpoint(`e${i}`));
    h.db = newDb(eps, eps.map((e, i) => delivery(`d${i}`, e.id as string, MAX_ATTEMPTS - 1)));
    const r = await drainWebhooks(env, DRAIN_MAX);
    expect(r.claimed).toBe(DRAIN_MAX);
    expect(h.db.tables.webhook_deliveries!.filter((d) => d.status === "delivering")).toHaveLength(0); // nothing claimed is left stuck
    const used = h.db.calls.length + posts.length + vi.mocked(alertMany).mock.calls.length * COST.alert;
    expect(used).toBeLessThanOrEqual(drainSubrequests(DRAIN_MAX));
    expect(items()).toHaveLength(DRAIN_MAX); // five endpoints DLQ'd, five keys, one alertMany
  });

  it("a smaller budget claims fewer rows, never more than it can finish", async () => {
    const seen: number[] = [];
    h.db = fakeDb({ webhook_endpoints: [endpoint("e1")], webhook_deliveries: Array.from({ length: 6 }, (_, i) => delivery(`d${i}`, "e1", 0)) }, {}, { rpc: { claim_webhook_deliveries: async (db, a) => { seen.push(a.p_max); return claim(db, a); } } });
    const r = await drainWebhooks(env, 10, new Budget(2 * COST.db + COST.alert + 2 * 4));
    expect(seen).toEqual([2]);
    expect(r).toMatchObject({ claimed: 2, delivered: 2 });
  });
});

describe("drainWebhooks: a delivery whose claiming run died", () => {
  let posts: string[];
  beforeEach(() => {
    posts = []; h.failEndpointRead = false; h.failEndpointList = false;
    vi.mocked(alertMany).mockClear();
    vi.stubGlobal("fetch", async (url: string) => { posts.push(String(url)); return new Response("ok", { status: 200 }); });
  });
  afterEach(() => vi.unstubAllGlobals());
  const leased = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  it("is requeued and delivered in the same run, and alerted; a live lease is left alone", async () => {
    h.db = fakeDb({ webhook_endpoints: [endpoint("e1")], webhook_deliveries: [
      { ...delivery("dead", "e1", 1), status: "delivering", lease_until: leased(STALE_DELIVERING_MINUTES + 1) },
      { ...delivery("live", "e1", 0), status: "delivering", lease_until: leased(-1) }, // claimed seconds ago by a run still going
    ] }, {}, { rpc: { claim_webhook_deliveries: claim } });
    const r = await drainWebhooks(env, DRAIN_MAX);
    expect(r).toMatchObject({ requeued: 1, claimed: 1, delivered: 1, errors: 0, alerts: ["webhook_stuck_delivering"] });
    expect(posts).toEqual(["https://hooks.example/e1"]);
    expect(h.db.tables.webhook_deliveries!.map((d) => [d.id, d.status, d.attempt])).toEqual([["dead", "delivered", 2], ["live", "delivering", 0]]);
    const [item] = vi.mocked(alertMany).mock.calls[0]![1]!;
    expect(item).toMatchObject({ key: "webhook_stuck_delivering", dedupMinutes: 60, meta: { deliveries: ["dead"] } });
    const used = h.db.calls.length + posts.length + vi.mocked(alertMany).mock.calls.length * COST.alert;
    expect(used).toBeLessThanOrEqual(drainSubrequests(DRAIN_MAX));
  });

  it("a lease that expired less than the margin ago is not requeued (the old Worker's run may still be delivering it)", async () => {
    h.db = fakeDb({ webhook_endpoints: [endpoint("e1")], webhook_deliveries: [{ ...delivery("recent", "e1", 0), status: "delivering", lease_until: leased(STALE_DELIVERING_MINUTES - 1) }] }, {}, { rpc: { claim_webhook_deliveries: claim } });
    const r = await drainWebhooks(env, DRAIN_MAX);
    expect(r).toMatchObject({ requeued: 0, claimed: 0, alerts: [] });
    expect(h.db.tables.webhook_deliveries![0]!.status).toBe("delivering");
  });

  it("a sweep the database refuses is a drain error, alerted", async () => {
    h.db = fakeDb({ webhook_endpoints: [], webhook_deliveries: [] }, {}, { rpc: { claim_webhook_deliveries: claim } });
    const client = h.db.client;
    h.db = { ...h.db, client: { ...client, from: (t: string) => {
      const q = client.from(t);
      if (t !== "webhook_deliveries") return q;
      return new Proxy(q, { get: (o, k) => (k === "update" ? () => { const f: any = { eq: () => f, lt: () => f, select: () => Promise.resolve({ data: null, error: { message: "permission denied for table webhook_deliveries" } }) }; return f; } : Reflect.get(o, k)) });
    } } } as FakeDb;
    const r = await drainWebhooks(env, DRAIN_MAX);
    expect(r).toMatchObject({ requeued: 0, errors: 1, alerts: ["webhook_drain_errors"] });
    expect(vi.mocked(alertMany).mock.calls[0]![1]![0]!.text).toContain("stale 'delivering' sweep: permission denied");
  });
});

describe("enqueueEvent", () => {
  beforeEach(() => { h.failEndpointRead = false; h.failEndpointList = false; vi.mocked(alert).mockClear(); });
  it("queues one delivery per subscribed endpoint", async () => {
    h.db = fakeDb({ webhook_endpoints: [endpoint("e1", { tenant_id: "t1", events: ["market.resolved"] }), endpoint("e2", { tenant_id: "t1", events: ["market.error"] })], webhook_deliveries: [] });
    expect(await enqueueEvent(env, "t1", "market.resolved", { x: 1 })).toBe(1);
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
  });
  it("could not read the endpoints: the dropped event is alerted, not treated as no subscriber", async () => {
    h.failEndpointList = true;
    h.db = fakeDb({ webhook_endpoints: [endpoint("e1", { tenant_id: "t1", events: ["market.resolved"] })], webhook_deliveries: [] });
    expect(await enqueueEvent(env, "t1", "market.resolved", { x: 1 })).toBe(0);
    expect(vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes])).toEqual([["webhook_enqueue_failed", 60]]);
  });
});

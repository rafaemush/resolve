/**
 * POST /v1/resolve when the verdict cannot be recorded (money path): the runtime throws ResolutionNotRecordedError
 * after begin_resolution charged the tenant. The route refunds the charge (alerting refund_failed_<id> when the refund
 * itself fails) and answers 503; before, the throw reached app.onError, the tenant kept the charge and every replay of
 * the Idempotency-Key answered 202 "still in flight" forever. A replay of a stub marked failed answers 503, not 202.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", () => ({
  db: () => h.db.client,
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/api/auth", () => ({
  authenticate: async () => ({ ok: true, auth: { keyId: "k1", tenantId: "t1", plan: "payg", strictV0: false, environment: "test", scopes: [], requestsToday: 0, dailyCap: 1000 } }),
  rateLimit: async () => ({ allowed: true }),
  extractApiKey: () => null,
  invalidateKeyCache: async () => undefined,
}));
vi.mock("../src/markets/register", () => ({ registerMarket: async () => ({ marketId: "m1", status: "open", reasons: [], watches: [] }) }));
vi.mock("../src/ingest/watch", () => ({ runWatch: vi.fn() }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));
vi.mock("../src/resolve/runtime", async () => {
  const { JevUnavailableError } = await vi.importActual<typeof import("../src/resolve")>("../src/resolve");
  class ResolutionNotRecordedError extends Error {}
  return {
    JevUnavailableError, ResolutionNotRecordedError,
    // What the real runtime does when the verdict row is refused: accounting and alert (not modelled), stub marked failed, throw.
    resolveWithRuntime: vi.fn(async (_env: unknown, _cfg: unknown, o: { requestId: string }) => {
      const stub = h.db.tables.resolutions!.find((r) => r.id === o.requestId);
      if (stub) stub.status_row = "failed";
      throw new ResolutionNotRecordedError(`request ${o.requestId}: resolutions update: violates check constraint`);
    }),
  };
});

import { v1 } from "../src/api/v1";
import { alert } from "../src/ops/alerts";
import { runWatch } from "../src/ingest/watch";
import { resolveWithRuntime } from "../src/resolve/runtime";
import { MarketRegistration } from "../src/resolve/schema";
import { sha256Hex } from "../src/resolve/text";

const market = MarketRegistration.parse({
  external_id: "t-1", condition: "Will PR #4821 in openai/openai-python be merged before 2026-10-01 00:00 UTC?", event_statement: "PR #4821 in openai/openai-python is merged",
  option_a: "Yes, merged before the deadline", option_b: "No, not merged before the deadline", positive_option: "OPTION_A", anchors: ["openai/openai-python", "#4821"],
  sources: [{ kind: "web_fetch", ref: "https://github.com/openai/openai-python" }], open_at: "2026-09-01T00:00:00Z", deadline_utc: "2026-10-01T00:00:00Z",
});
const body = JSON.stringify({ market, evidence: { source_kind: "web_fetch", source_url: "https://github.com/openai/openai-python/releases/tag/v1.52.0",
  text: "Release notes for openai/openai-python. Pull request #4821 (add retries to the streaming client) was merged by the maintainers on 2026-09-20 and shipped in v1.52.0. The change is live on PyPI and the changelog lists #4821 under Fixed." } });
// Dead placeholders that satisfy parseConfig; nothing here reaches a network (db and the runtime are stubbed).
const env = { JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "60", SPOTLIGHT_SECRET: "eval-spotlight-v1", SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized", INTERNAL_HMAC_SECRET: "x", ADMIN_API_KEY: "x", EVAL_REPORT_KEY: "x", JEV_PAID_ROUTES_ENABLED: "1" } as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const post = (idem: string) => v1.request("/resolve", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idem }, body }, env, ctx);

let refunds: string[];
function newDb(refund: "ok" | "fails") {
  refunds = [];
  h.db = fakeDb({ markets: [{ id: "m1", tenant_id: "t1", ...market }], resolutions: [], api_request_log: [] }, {}, {
    rpc: {
      // INSERT-first stub + charge, keyed like the real begin_resolution (sha256(tenant|key)).
      begin_resolution: async (db, a) => {
        const id = await sha256Hex(`${a.p_tenant}|${a.p_idempotency_key}`);
        db.tables.resolutions!.push({ id, tenant_id: a.p_tenant, status_row: "pending", credits_charged: a.p_amount, credits_refunded: 0 });
        return { data: [{ request_id: id, replayed: false, ok: true, balance: 95, charged: a.p_amount }], error: null };
      },
      refund_credits: async (db, a) => {
        refunds.push(a.p_request_id);
        if (refund === "fails") return { data: null, error: { code: "57014", message: "statement timeout" } };
        const row = db.tables.resolutions!.find((r) => r.id === a.p_request_id)!;
        row.credits_refunded = row.credits_charged;
        return { data: row.credits_charged, error: null };
      },
    },
  });
}

describe("POST /v1/resolve: a verdict that could not be recorded", () => {
  beforeEach(() => vi.mocked(alert).mockClear());

  it("refunds the charge and answers 503; a replay of the key answers 503 too, never 202 'in flight'", async () => {
    newDb("ok");
    const res = await post("idem-1");
    const id = await sha256Hex("t1|idem-1");
    expect(res.status).toBe(503);
    const j = (await res.json()) as { error: { code: string; message: string }; error_reason: string; credits_refunded: number };
    expect(j).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE" }, error_reason: "VERDICT_NOT_RECORDED" });
    expect(j.credits_refunded).toBe(5); // the web-evidence (Jev) price
    expect(refunds).toEqual([id]);
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
    // the key's plan goes to the runtime, which refuses web evidence to the free plan (tests/runtime-alerts.test.ts)
    expect(vi.mocked(resolveWithRuntime).mock.calls.at(-1)![2]).toMatchObject({ mode: "tenant", tenantId: "t1", tenantPlan: "payg" });

    const replay = await post("idem-1");
    expect(replay.status).toBe(503);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    const r = (await replay.json()) as { error: { message: string }; error_reason: string };
    expect(r.error_reason).toBe("VERDICT_NOT_RECORDED");
    expect(r.error.message).toContain("new Idempotency-Key");
  });

  it("a refund that fails is alerted per request and the answer says nothing was refunded", async () => {
    newDb("fails");
    const res = await post("idem-2");
    const id = await sha256Hex("t1|idem-2");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { credits_refunded: number }).credits_refunded).toBe(0);
    expect(vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes])).toEqual([[`refund_failed_${id}`, 1440]]);
  });
});

/**
 * POST /v1/resolve with fetch:true runs a watch outside the pg_net schedule. It takes the watch's lease first
 * (lease_watch_now, migration 019, emulated here: free or expired -> now + 120 s, live -> null), so it can never overlap
 * a dispatched run or another fetch of the same watch.
 */
describe("POST /v1/resolve fetch:true: one run of a watch at a time", () => {
  const M = "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const W = "5b0f3c2e-8f1a-4c7e-9d2b-1a2b3c4d5e6f";
  let leaseCalls: string[];
  let leaseAtRun: Array<string | null>;
  const fetchNow = () => v1.request("/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ market_id: M, fetch: true }) }, env, ctx);
  const watchRow = () => h.db.tables.watches![0]!;
  function fetchDb(leaseUntil: string | null, leaseRpc: "ok" | "fails" = "ok") {
    leaseCalls = []; leaseAtRun = [];
    h.db = fakeDb({ markets: [{ id: M, tenant_id: "t1", ...market }], watches: [{ id: W, market_id: M, active: true, lease_until: leaseUntil }], evidence: [], api_request_log: [] }, {}, {
      rpc: {
        lease_watch_now: async (db, a) => {
          leaseCalls.push(a.p_watch);
          if (leaseRpc === "fails") return { data: null, error: { code: "57014", message: "statement timeout" } };
          const w = db.tables.watches!.find((r) => r.id === a.p_watch);
          if (!w || (w.lease_until && Date.parse(w.lease_until) >= Date.now())) return { data: null, error: null };
          w.lease_until = new Date(Date.now() + 120_000).toISOString();
          return { data: w.lease_until, error: null };
        },
      },
    });
    // runWatch is stubbed: it records the lease it ran under and, like a run still in flight, has not released it yet
    vi.mocked(runWatch).mockReset().mockImplementation(async (_env, _cfg, id) => {
      leaseAtRun.push((h.db.tables.watches!.find((r) => r.id === id)?.lease_until as string | null) ?? null);
      return { watch_id: id, outcome: "no_op", rows_written: 0, detail: "unchanged", recorded: true };
    });
  }

  it("a watch leased by a dispatched run in flight answers 409 and never runs the watch", async () => {
    const live = new Date(Date.now() + 60_000).toISOString();
    fetchDb(live);
    const res = await fetchNow();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "conflict", message: expect.stringContaining("in progress") });
    expect(leaseCalls).toEqual([W]);
    expect(vi.mocked(runWatch)).not.toHaveBeenCalled();
    expect(watchRow().lease_until).toBe(live);
  });

  it("a free watch is leased before it runs, marked tenant_fetch; a second fetch while it runs answers 409", async () => {
    fetchDb(null);
    const first = await fetchNow();
    expect(first.status).toBe(404); // ran; no evidence stored yet for the market
    // with the request's public origin, which the charge's credits.low pointers use (never a relative page)
    expect(vi.mocked(runWatch).mock.calls.map((c) => [c[2], c[3]?.dispatch, c[3]?.base])).toEqual([[W, "tenant_fetch", "http://localhost"]]);
    expect(leaseAtRun).toHaveLength(1);
    expect(Date.parse(leaseAtRun[0]!)).toBeGreaterThan(Date.now());
    const second = await fetchNow();
    expect(second.status).toBe(409);
    expect(vi.mocked(runWatch)).toHaveBeenCalledTimes(1);
  });

  it("an expired lease is taken over, as select_due_watches() would", async () => {
    fetchDb(new Date(Date.now() - 1000).toISOString());
    expect((await fetchNow()).status).toBe(404);
    expect(vi.mocked(runWatch)).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the lease cannot be taken: 503, and the watch does not run", async () => {
    fetchDb(null, "fails");
    const res = await fetchNow();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("the fetch did not run");
    expect(vi.mocked(runWatch)).not.toHaveBeenCalled();
  });
});

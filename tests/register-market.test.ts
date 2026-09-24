/**
 * Registration through the routes (POST /v1/markets, POST /internal/markets) with register_market (migration 019)
 * emulated by tests/lib/fake-register.ts: the tenant's watch_limit counts this market's watches and never blocks an
 * idempotent re-registration; the Base watch cap answers 409; a policy refusal writes nothing and requests nothing; a
 * check that could not be made answers 503 with Retry-After and writes nothing; an inline /v1/resolve market (no
 * watches) skips the policy because nothing is ever fetched for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, Config } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { registerMarketStandIn } from "./lib/fake-register";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", async (orig) => ({ db: () => h.db.client, rpc: (await orig<typeof import("../src/db/supabase")>()).rpc }));
vi.mock("../src/api/auth", () => ({
  authenticate: async () => ({ ok: true, auth: { keyId: "k1", tenantId: "t1", plan: "free", strictV0: false, environment: "test", scopes: [], requestsToday: 0, dailyCap: 1000 } }),
  rateLimit: async () => ({ allowed: true }),
  extractApiKey: () => null,
  invalidateKeyCache: async () => undefined,
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { v1 } from "../src/api/v1";
import { internal } from "../src/api/internal";
import { registerMarket } from "../src/markets/register";

const env = { JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "60", SPOTLIGHT_SECRET: "eval-spotlight-v1", SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized", INTERNAL_HMAC_SECRET: "x", ADMIN_API_KEY: "admin-test", EVAL_REPORT_KEY: "x", SOLANA_FALLBACK_HTTP_URL: "https://solana-rpc.test.invalid/", BASE_FALLBACK_HTTP_URL: "https://base-rpc.test.invalid/" } as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const ADDR = `0x${"b".repeat(40)}`;

const market = (id: string, sources: unknown[], extra: Record<string, unknown> = {}) => ({
  external_id: id, condition: "Resolves Yes if the watched source shows the event before the deadline.", event_statement: "The watched event happened",
  option_a: "Yes", option_b: "No", positive_option: "OPTION_A", anchors: ["event"], sources, open_at: "2026-09-01T00:00:00Z", deadline_utc: "2026-12-31T00:00:00Z", ...extra,
});
const gh = (n: number) => ({ kind: "github_api", ref: `repos/acme/widget/pulls/${n}` });
const postV1 = (body: unknown) => v1.request("/markets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env, ctx);
const postInternal = (body: unknown) => internal.request("/markets", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admin-test" }, body: JSON.stringify(body) }, env);
const read = async (res: Response) => (await res.json()) as { ok: boolean; data?: Record<string, any>; error?: { code: string; message: string }; [k: string]: unknown };

let fetches: string[];
function stubFetch(answer: (url: string, method: string | undefined) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let method: string | undefined;
    try { method = (JSON.parse(String(init?.body ?? "")) as { method?: string }).method; } catch { /* not JSON-RPC */ }
    fetches.push(method ? `${url} ${method}` : url);
    return answer(url, method);
  }));
}
const rpcResult = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });

beforeEach(() => {
  fetches = [];
  const existing: Row = { id: "m0", tenant_id: "t1", platform: "custom", external_id: "old", status: "open", meta: {} };
  h.db = fakeDb({
    tenants: [{ id: "t1", watch_limit: 2, deleted_at: null }],
    markets: [existing],
    watches: [{ id: "w0", market_id: "m0", source_kind: "github_api", active: true, deleted_at: null }],
    app_config: [], api_request_log: [],
  }, {}, { rpc: { register_market: registerMarketStandIn } });
  stubFetch(() => new Response(null, { status: 404 }));
});
afterEach(() => vi.unstubAllGlobals());

const tenantMarkets = () => h.db.tables.markets!.filter((m) => m.tenant_id === "t1").length;

describe("POST /v1/markets: watch_limit inside register_market", () => {
  it("refuses a market whose watches would take the tenant past its limit, naming the counts, and writes nothing", async () => {
    const res = await postV1(market("two", [gh(1), gh(2)]));
    expect(res.status).toBe(403);
    expect(await read(res)).toMatchObject({ ok: false, error: { code: "validation_error", message: expect.stringContaining("watch limit (2)") }, watch_limit: 2, active_watches: 1, requested_watches: 2 });
    expect(tenantMarkets()).toBe(1);
    expect(h.db.tables.watches).toHaveLength(1);
  });

  it("registers a market that fits, then answers a re-registration of it at the limit with the same market", async () => {
    const first = await postV1(market("one", [gh(1)]));
    expect(first.status).toBe(201);
    const a = await read(first);
    expect(a.data).toMatchObject({ status: "open", reasons: [], watches: [{ source_kind: "github_api" }] });
    expect(h.db.tables.watches!.filter((w) => w.active)).toHaveLength(2);
    const again = await postV1(market("one", [gh(1)]));
    expect(again.status).toBe(201);
    expect((await read(again)).data).toMatchObject({ market_id: a.data!.market_id, watches: [{ source_kind: "github_api" }] });
    expect(tenantMarkets()).toBe(2);
    expect(h.db.tables.watches).toHaveLength(2);
  });
});

describe("registration refusals", () => {
  it("a policy refusal is a 400 before any upstream request and any write", async () => {
    const res = await postV1(market("ssrf", [{ kind: "web_fetch", ref: "http://169.254.169.254/latest/meta-data/" }]));
    expect(res.status).toBe(400);
    expect((await read(res)).error).toMatchObject({ code: "validation_error", message: expect.stringContaining("is not https") });
    expect(fetches).toEqual([]);
    expect(h.db.calls.filter((c) => c.table === "markets" || c.table.startsWith("rpc:"))).toEqual([{ table: "markets", action: "select" }]);
  });

  it("a GitHub resolver whose source is on another repo is a 400", async () => {
    const res = await postV1(market("cross", [{ kind: "github_api", ref: "repos/acme/other/pulls/42" }], { resolver: { kind: "github_pr_merged", repo: "acme/widget", pr: 42 } }));
    expect(res.status).toBe(400);
    expect((await read(res)).error!.message).toContain("is on acme/other");
  });

  it("web_render is a 400 until Browser Rendering ships", async () => {
    const res = await postV1(market("render", [{ kind: "web_render", ref: "https://status.acme-widget.example/" }]));
    expect(res.status).toBe(400);
    expect((await read(res)).error!.message).toContain("Browser Rendering");
    expect(fetches).toEqual([]);
  });

  it("a Solana account the RPC could not confirm is a 503 with Retry-After, and nothing is stored", async () => {
    stubFetch(() => new Response("upstream down", { status: 503 }));
    const res = await postV1(market("sol", [{ kind: "solana_log", ref: `solana:${ACCOUNT}` }]));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await read(res)).error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", message: expect.stringContaining("could not verify") });
    expect(fetches).toEqual(["https://solana-rpc.test.invalid/ getAccountInfo"]);
    expect(tenantMarkets()).toBe(1);
  });

  it("a robots.txt answering 503 is 'could not verify': 503, nothing stored, and the same registration succeeds once robots.txt answers", async () => {
    // Stored as unsupported_source, the market would be answered as-is to every retry of its external_id: one robots
    // outage would block it for good.
    stubFetch(() => new Response("maintenance", { status: 503 }));
    const down = await postV1(market("robots", [{ kind: "web_fetch", ref: "https://status.acme-widget.example/v2" }]));
    expect(down.status).toBe(503);
    expect(down.headers.get("retry-after")).toBe("60");
    expect((await read(down)).error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", message: expect.stringContaining("could not verify robots.txt") });
    expect(tenantMarkets()).toBe(1);
    stubFetch(() => new Response("not found", { status: 404 }));
    const up = await postV1(market("robots", [{ kind: "web_fetch", ref: "https://status.acme-widget.example/v2" }]));
    expect(up.status).toBe(201);
    expect((await read(up)).data).toMatchObject({ status: "open", watches: [{ source_kind: "web_fetch" }] });
  });

  it("a robots.txt rule that disallows the page registers the market as unsupported_source, without watches", async () => {
    stubFetch(() => new Response("User-agent: *\nDisallow: /v2\n", { status: 200 }));
    const res = await postV1(market("robots-rule", [{ kind: "web_fetch", ref: "https://status.acme-widget.example/v2" }]));
    expect(res.status).toBe(201);
    expect((await read(res)).data).toMatchObject({ status: "unsupported_source", reasons: [expect.stringContaining("disallows /v2")], watches: [] });
  });
});

describe("POST /internal/markets: the service-wide Base watch cap", () => {
  it("answers 409 when active base_log watches plus this market's exceed max_base_watches, and registers within it", async () => {
    h.db.tables.app_config = [{ key: "max_base_watches", value: "1" }];
    h.db.tables.watches!.push({ id: "wb", market_id: "m0", source_kind: "base_log", active: true, deleted_at: null });
    stubFetch((_url, method) => method === "eth_getBlockByNumber" ? rpcResult({ number: "0x1000", timestamp: "0x68000000" }) : rpcResult("0x6080"));
    const over = await postInternal({ market: market("base-1", [{ kind: "base_log", ref: `base:${ADDR}` }]) });
    expect(over.status).toBe(409);
    expect(await read(over)).toMatchObject({ error: { code: "conflict", message: expect.stringContaining("Base watch capacity") }, max_base_watches: 1, active_base_watches: 1, requested_base_watches: 1 });
    expect(h.db.tables.markets!.some((m) => m.external_id === "base-1")).toBe(false);
    h.db.tables.app_config = [{ key: "max_base_watches", value: "2" }];
    const ok = await postInternal({ market: market("base-1", [{ kind: "base_log", ref: `base:${ADDR}` }]) });
    expect(ok.status).toBe(201);
    expect((await read(ok)).data).toMatchObject({ status: "open", existing: false, watches: [{ source_kind: "base_log" }] });
  });
});

describe("registerMarket without watches (the inline /v1/resolve market)", () => {
  it("stores the market only, with no policy and no upstream request: nothing is ever fetched for it", async () => {
    const r = await registerMarket(env, { botUa: "ResolveBot/1.0" } as Config, market("inline", [{ kind: "web_fetch", ref: "http://intranet/status" }]), "t1", { createWatches: false });
    expect(r).toMatchObject({ status: "open", existing: false, watches: [] });
    expect(fetches).toEqual([]);
    expect(h.db.tables.watches).toHaveLength(1);
  });

  it("an answer off register_market's contract is an error, never a guessed success", async () => {
    h.db.options.rpc = { register_market: async () => ({ data: { outcome: "created", market_id: "m9" }, error: null }) };
    await expect(registerMarket(env, { botUa: "ResolveBot/1.0" } as Config, market("x", [gh(1)]), null)).rejects.toThrow(/off contract/);
  });
});

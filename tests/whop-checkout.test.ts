/**
 * Opening a card checkout (src/api/billing.ts, the /pricing form in src/api/site.ts): while WHOP_CHECKOUT_ENABLED is
 * not "1" the form is hidden and both routes answer 503; a missing secret or plan id refuses and alerts once, by name;
 * the routes require a valid key and send Whop the tenant id only (metadata resolve_tenant_id) for the pack's plan;
 * the form answers a 303 to Whop's checkout and its page may post there (form-action); the key never appears in an
 * alert, a log line, a table, the Whop request (URL, headers, body, metadata) or any answer; every answer is no-store;
 * /docs and /terms explain paying by card; no page names the model or its vendor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { PLAN_250, PLAN_50, WHOP_RPCS, WHOP_SECRET } from "./lib/fake-whop";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  alerts: [] as Array<{ key: string; text: string; meta: Record<string, unknown> }>,
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
import { SITE_CSP } from "../src/api/site";
import { sha256Hex } from "../src/resolve/text";

/** PostgREST's embed of tenants(plan, strict_v0, deleted_at) on the api_keys read of src/api/auth.ts. */
function embedTenants(q: any): any {
  const add = (row: Row | null) => {
    if (!row) return row;
    const t = (h.db.tables.tenants ?? []).find((x) => x.id === row.tenant_id);
    return { ...row, tenants: t ? { plan: t.plan, strict_v0: false, deleted_at: t.deleted_at ?? null } : null };
  };
  const attach = (r: { data: any; error: any }) => ({ ...r, data: Array.isArray(r.data) ? r.data.map(add) : add(r.data) });
  return new Proxy(q, {
    get(o, k) {
      if (k === "then") return (ok: any, no: any) => o.then(attach).then(ok, no);
      if (k === "single" || k === "maybeSingle") return async () => attach(await o[k]());
      const v = Reflect.get(o, k);
      return typeof v === "function" ? (...args: unknown[]) => { const out = v.apply(o, args); return out === o ? embedTenants(o) : out; } : v;
    },
  });
}
function client(): FakeDb["client"] {
  const base = h.db.client;
  return {
    rpc: base.rpc,
    from: (t: string) => new Proxy(base.from(t), {
      get(o: any, k) {
        if (k !== "select") return Reflect.get(o, k);
        return (...args: any[]) => { const out = o.select(...args); return t === "api_keys" && String(args[0] ?? "").includes("tenants(") ? embedTenants(out) : out; };
      },
    }) as any,
  } as FakeDb["client"];
}

const NOW = Date.parse("2026-09-30T12:00:00Z");
const TENANT = "11111111-1111-4111-8111-111111111111";
const KEY = `rsl_test_${"a1b2c3d4e5f6g7h8".repeat(2)}`;
const KEY_BODY = KEY.slice("rsl_test_".length);
const WHOP_API_KEY = "whop_secret_api_key_for_tests_0001";
const base = { RESOLVE_PUBLIC_URL: "https://resolve.example.com", PUBLIC_CHANNEL_URL: "https://t.me/resolve_feed", CREDITS_PER_USDC: "100" };
const on = { ...base, WHOP_CHECKOUT_ENABLED: "1", WHOP_API_KEY, WHOP_WEBHOOK_SECRET: WHOP_SECRET, WHOP_PLAN_ID_50: PLAN_50, WHOP_PLAN_ID_250: PLAN_250 } as unknown as Env;
const off = { ...on, WHOP_CHECKOUT_ENABLED: "0" } as unknown as Env;
const pending: Array<Promise<unknown>> = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const NAMES = /jev|typesafe/i;

let whopCalls: Array<{ url: string; init: RequestInit }> = [];
/** Whop's answer to a checkout request (by default: a configuration for the plan asked for). */
let whopAnswer: (init: RequestInit) => Response;
let logs: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];

beforeEach(async () => {
  h.db = fakeDb({
    tenants: [{ id: TENANT, display_name: "Ada (web form)", plan: "free", credits_balance: 300, watch_limit: 5, deleted_at: null }],
    api_keys: [{ id: "k1", tenant_id: TENANT, key_hash: await sha256Hex(KEY), key_prefix: KEY.slice(0, 12) + "...", name: "request-key", environment: "test", scopes: [], daily_cap: 1000, expires_at: new Date(NOW + 20 * 86_400_000).toISOString(), revoked_at: null, deleted_at: null }],
    app_config: [{ key: "payg_tiers", value: '[{"min_usdc":1000,"credits_per_usdc":120},{"min_usdc":250,"credits_per_usdc":110},{"min_usdc":0,"credits_per_usdc":100}]' }],
  }, {}, { rpc: WHOP_RPCS });
  h.alerts = [];
  whopCalls = [];
  logs = [];
  pending.length = 0;
  whopAnswer = (init) => {
    const asked = JSON.parse(String(init.body)) as { plan_id: string; metadata: unknown };
    return new Response(JSON.stringify({ id: "ch_TestCheckout1", purchase_url: "https://whop.com/checkout/ch_TestCheckout1/", mode: "payment", plan: { id: asked.plan_id }, metadata: asked.metadata }), { status: 200, headers: { "content-type": "application/json" } });
  };
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
  vi.stubGlobal("caches", { default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined), delete: vi.fn(async () => true) } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.whop.com/") && !url.startsWith("https://sandbox-api.whop.com/")) throw new Error(`unexpected fetch ${url}`);
    whopCalls.push({ url, init: init ?? {} });
    return whopAnswer(init ?? {});
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const s of spies) s.mockRestore(); });

const apiCheckout = (body: unknown, e: Env = on, key: string | null = KEY) => app.request("/v1/billing/checkout", { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) }, e, ctx);
const formCheckout = (fields: Record<string, string>, e: Env = on) => app.request("/billing/checkout", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.9" }, body: new URLSearchParams(fields).toString() }, e, ctx);
const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** The key, or its random part, anywhere it must never be. */
async function expectKeyNowhere(...answers: string[]) {
  await Promise.all(pending);
  const whop = whopCalls.map((c) => JSON.stringify({ url: c.url, headers: c.init.headers, body: c.init.body }));
  for (const s of [JSON.stringify(h.alerts), JSON.stringify(h.db.tables), ...logs, ...whop, ...answers]) {
    expect(s).not.toContain(KEY);
    expect(s).not.toContain(KEY_BODY);
  }
}

describe("switched off: no form, and both routes refuse", () => {
  it("/pricing shows no card form, keeps the site policy, and nothing is asked of Whop", async () => {
    const res = await app.request("/pricing", {}, off, ctx);
    const html = await res.text();
    expect(html).not.toContain('action="/billing/checkout"');
    expect(html).not.toContain("Pay by card");
    expect(res.headers.get("content-security-policy")).toBe(SITE_CSP);
    expect(whopCalls).toEqual([]);
  });
  it("POST /v1/billing/checkout: 503 card checkout not yet available, no-store, nothing asked of Whop", async () => {
    const res = await apiCheckout({ pack: "50" }, off);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as any).error.message).toBe("Card checkout is not yet available.");
    expect(whopCalls).toEqual([]);
    expect(h.alerts).toEqual([]);
  });
  it("POST /billing/checkout: 503 page, no-store, the key never read or echoed", async () => {
    const res = await formCheckout({ key: KEY, pack: "50" }, off);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(text(html)).toContain("Card checkout is not yet available.");
    expect(h.db.calls).toEqual([]);
    await expectKeyNowhere(html);
  });
  it("unset (the wrangler.toml default) is off too", async () => {
    const res = await apiCheckout({ pack: "50" }, { ...on, WHOP_CHECKOUT_ENABLED: undefined } as unknown as Env);
    expect(res.status).toBe(503);
  });
});

describe("switched on without its secret or plan ids: refused clearly, alerted once by name, never a checkout", () => {
  for (const [label, e, name] of [["no WHOP_API_KEY", { ...on, WHOP_API_KEY: "" }, "WHOP_API_KEY"], ["no WHOP_PLAN_ID_250", { ...on, WHOP_PLAN_ID_250: "" }, "WHOP_PLAN_ID_250"], ["a malformed WHOP_PLAN_ID_50", { ...on, WHOP_PLAN_ID_50: "prod_x" }, "WHOP_PLAN_ID_50 (not a plan_ id)"]] as const) {
    it(label, async () => {
      const res = await apiCheckout({ pack: "50" }, e as unknown as Env);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(whopCalls).toEqual([]);
      expect(h.alerts.map((a) => a.key)).toEqual(["whop_config_missing"]);
      expect(h.alerts[0]!.text).toContain(name);
      expect(JSON.stringify(h.alerts)).not.toContain(WHOP_API_KEY);
      const page = await app.request("/pricing", {}, e as unknown as Env, ctx);
      expect(await page.text()).not.toContain('action="/billing/checkout"');
    });
  }
});

describe("the API route: a valid key opens a checkout for its own tenant", () => {
  it("sends Whop the pack's plan and the tenant id only, pinned and idempotent, and answers the checkout URL, no-store", async () => {
    const res = await apiCheckout({ pack: "50" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const answer = await res.text();
    expect(JSON.parse(answer).data).toMatchObject({ checkout_url: "https://whop.com/checkout/ch_TestCheckout1/", checkout_id: "ch_TestCheckout1", pack: "50", price: "50.00", currency: "usd", credits: 5000, merchant_of_record: "Whop" });
    expect(whopCalls).toHaveLength(1);
    const call = whopCalls[0]!;
    expect(call.url).toBe("https://api.whop.com/api/v1/checkout_configurations");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${WHOP_API_KEY}`);
    expect(headers["api-version-date"]).toBe("2026-09-29");
    expect(headers["idempotency-key"]).toMatch(/^resolve-checkout:req_[0-9a-f]{32}$/);
    expect(JSON.parse(String(call.init.body))).toEqual({ plan_id: PLAN_50, mode: "payment", metadata: { resolve_tenant_id: TENANT }, redirect_url: "https://resolve.example.com/billing/done" });
    await expectKeyNowhere(answer);
  });
  it("the $250 pack uses its own plan; a number is accepted for the pack", async () => {
    whopAnswer = () => new Response(JSON.stringify({ id: "ch_T250", purchase_url: "https://whop.com/checkout/ch_T250/", plan: { id: PLAN_250 } }), { status: 200 });
    const res = await apiCheckout({ pack: 250 });
    expect(res.status).toBe(200);
    expect(JSON.parse(String(whopCalls[0]!.init.body)).plan_id).toBe(PLAN_250);
  });
  it("requires a valid key: none, malformed, unknown or revoked answer 401 no-store and nothing is asked of Whop", async () => {
    for (const key of [null, "rsl_test_short", `rsl_test_${"z".repeat(32)}`]) {
      const res = await apiCheckout({ pack: "50" }, on, key);
      expect(res.status, String(key)).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    h.db.tables.api_keys![0]!.revoked_at = "2026-09-29T00:00:00Z";
    expect((await apiCheckout({ pack: "50" })).status).toBe(401);
    expect(whopCalls).toEqual([]);
  });
  it("an unknown pack is a 400", async () => {
    for (const pack of ["1000", "5", 50.5, null]) {
      const res = await apiCheckout({ pack });
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(whopCalls).toEqual([]);
  });
  it("Whop failing, or answering another plan or another host, is a 503 that says nothing was charged; alerted without the key", async () => {
    const bad = [
      () => new Response(JSON.stringify({ error: { message: "Invalid API key", type: "auth" } }), { status: 401 }),
      () => new Response(JSON.stringify({ id: "ch_x", purchase_url: "https://whop.com/checkout/ch_x/", plan: { id: "plan_Other" } }), { status: 200 }),
      () => new Response(JSON.stringify({ id: "ch_x", purchase_url: "https://evil.example/checkout/ch_x/" }), { status: 200 }),
      () => new Response("not json", { status: 200 }),
    ];
    for (const b of bad) {
      whopAnswer = b;
      h.alerts = [];
      const res = await apiCheckout({ pack: "50" });
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error.message).toContain("Nothing was charged");
      expect(h.alerts.map((a) => a.key)).toEqual(["whop_checkout_failed"]);
      expect(h.alerts[0]!.text).toContain(TENANT);
      expect(JSON.stringify(h.alerts)).not.toContain(WHOP_API_KEY);
    }
    await expectKeyNowhere();
  });
  it("the sandbox switch points the call at Whop's sandbox", async () => {
    whopAnswer = () => new Response(JSON.stringify({ id: "ch_S", purchase_url: "https://sandbox.whop.com/checkout/ch_S/", plan: { id: PLAN_50 } }), { status: 200 });
    const res = await apiCheckout({ pack: "50" }, { ...on, WHOP_SANDBOX: "1" } as unknown as Env);
    expect(res.status).toBe(200);
    expect(whopCalls[0]!.url).toBe("https://sandbox-api.whop.com/api/v1/checkout_configurations");
  });
});

describe("the /pricing form", () => {
  it("is shown when switched on and configured, posts to this site, may be redirected to Whop, and fills in no key", async () => {
    const res = await app.request("/pricing", {}, on, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form method="post" action="/billing/checkout" autocomplete="off">');
    expect(html).toContain('<input name="key" type="password"');
    expect(html).not.toMatch(/name="key"[^>]*value=/);
    expect(html).toContain('<option value="50">$50: 5,000 credits</option>');
    expect(html).toContain('<option value="250">$250: 27,500 credits</option>');
    expect(html).toContain("curl -X POST https://resolve.example.com/v1/billing/checkout");
    expect(res.headers.get("content-security-policy")).toBe(SITE_CSP.replace("form-action 'self'", "form-action 'self' https://whop.com https://*.whop.com"));
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const t = text(html);
    for (const s of ["Resolve developer data API", "merchant of record", "non-refundable prepayment for API services", "do not expire while the account is open", "refunded or charged back, the credits it bought are removed", "cannot be withdrawn", "cannot be moved to another account"]) expect(t).toContain(s);
    expect(t).not.toMatch(/lifetime|wallet|bet\b|betting|scrap/i);
    expect(html).not.toMatch(NAMES);
    expect(html).not.toMatch(/<script/i);
  });
  it("a valid key and pack: 303 to Whop's checkout, no-store, no referrer, the key nowhere", async () => {
    const res = await formCheckout({ key: KEY, pack: "250" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://whop.com/checkout/ch_TestCheckout1/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(JSON.parse(String(whopCalls[0]!.init.body))).toMatchObject({ plan_id: PLAN_250, metadata: { resolve_tenant_id: TENANT } });
    await expectKeyNowhere(res.headers.get("location") ?? "", await res.text());
  });
  it("a key that is not accepted: 401 page with the reason, the form again with no key in it, nothing asked of Whop", async () => {
    const wrong = `rsl_test_${"q".repeat(32)}`;
    const res = await formCheckout({ key: wrong, pack: "50" });
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(text(html)).toContain("Unknown or revoked API key.");
    expect(html).not.toContain(wrong);
    expect(html).toContain('action="/billing/checkout"');
    expect(whopCalls).toEqual([]);
  });
  it("an expired key is refused like any API call", async () => {
    h.db.tables.api_keys![0]!.expires_at = new Date(NOW - 1000).toISOString();
    const res = await formCheckout({ key: KEY, pack: "50" });
    expect(res.status).toBe(401);
    expect(text(await res.text())).toContain("API key expired");
    expect(whopCalls).toEqual([]);
  });
  it("no pack, or not the form: 400, the key never read", async () => {
    const res = await formCheckout({ key: KEY, pack: "1000" });
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = await app.request("/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: KEY, pack: "50" }) }, on, ctx);
    expect(json.status).toBe(400);
    expect(json.headers.get("cache-control")).toBe("no-store");
    expect(whopCalls).toEqual([]);
    await expectKeyNowhere(await res.text(), await json.text());
  });
  it("the key's per-minute limit: 429 page, nothing asked of Whop, the key nowhere; the API route is limited the same way", async () => {
    const asked: string[][] = [];
    h.db.options.rpc = { ...WHOP_RPCS, check_gates: async (_db, a) => { asked.push(a.p_keys); return { data: { buckets: [{ key: "key:k1:min", allowed: false, remaining: 0, reset_at: new Date(NOW + 30_000).toISOString() }] }, error: null }; } };
    const res = await formCheckout({ key: KEY, pack: "50" });
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(text(html)).toContain("Too many requests for this key in the last minute.");
    expect(asked).toEqual([["key:k1:min"]]);
    expect(whopCalls).toEqual([]);
    const api = await apiCheckout({ pack: "50" });
    expect(api.status).toBe(429);
    expect(api.headers.get("cache-control")).toBe("no-store");
    expect(whopCalls).toEqual([]);
    await expectKeyNowhere(html, await api.text());
  });
  it("Whop failing: 503 page, nothing charged, no redirect", async () => {
    whopAnswer = () => new Response("{}", { status: 500 });
    const res = await formCheckout({ key: KEY, pack: "50" });
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(text(await res.text())).toContain("Nothing was charged");
  });
});

describe("the pages around the checkout", () => {
  it("/billing/done reads nothing and trusts no query parameter", async () => {
    const res = await app.request("/billing/done?payment=pay_x&status=succeeded", {}, on, ctx);
    expect(res.status).toBe(200);
    const t = text(await res.text());
    expect(t).toContain("only Whop's confirmation adds credits");
    expect(t).not.toContain("pay_x");
    expect(h.db.calls).toEqual([]);
  });
  it("/docs explains paying by card (and says when it is not open yet); /terms says what a refund or chargeback does", async () => {
    const docs = text(await (await app.request("/docs", {}, on, ctx)).text());
    for (const s of ["7. Pay by card", "developer data API", "merchant of record", "$50 (5,000 credits) and $250 (27,500 credits)", "non-refundable prepayment for API services", "do not expire while the account is open", "refunded or charged back, the credits it bought are removed", "Your key is never sent to Whop"]) expect(docs).toContain(s);
    expect(docs).not.toContain("Card checkout is not open yet");
    expect(text(await (await app.request("/docs", {}, off, ctx)).text())).toContain("Card checkout is not open yet");
    const terms = text(await (await app.request("/terms", {}, off, ctx)).text());
    expect(terms).toContain("Whop processes the payment as the merchant of record and handles any card dispute");
    expect(terms).toContain("Credits do not expire while the account is open");
    for (const p of ["/docs", "/terms", "/billing/done", "/pricing"]) expect(await (await app.request(p, {}, on, ctx)).text()).not.toMatch(NAMES);
  });
});

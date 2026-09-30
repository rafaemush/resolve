/**
 * POST /v1/request-key issues an evaluation key on the spot (plan §21.4 C, src/api/evaluation-key.ts), end to end over
 * the in-memory database with the stand-ins of rate_limit_hit, grant_credits and log_touch (tests/lib/fake-request-key.ts):
 * a stranger's key authenticates on GET /v1/account with 300 credits granted exactly once; one key per address per 30
 * days (the cleaned address, deleted tenants included), one request per address at a time (a hold let go when the
 * request ends before its tenant), 3 keys a day per network; the daily cap and every database error or odd answer fall
 * back to the stored lead, the operator alert and one neutral answer;
 * the key is never in the alert, the lead, the touch, a table or a log line; the per-IP limit still applies; no answer
 * is cached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { REQUEST_KEY_RPCS } from "./lib/fake-request-key";
import { PLAN_20, PLAN_250, PLAN_50 } from "./lib/fake-whop";

type Broken = "error" | "throw" | "odd" | null;
const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  alerts: [] as Array<{ key: string; text: string; meta: Record<string, unknown> }>,
  /**
   * A forced database failure: "<table>.<select|insert|update>" or "rpc:<fn>" (with its args) -> how it fails, or null.
   * "odd" is an answer that is not an error and not the shape asked for: an rpc answers 0, a select one object instead
   * of rows, an insert no row.
   */
  broken: null as null | ((what: string, args?: Record<string, any>) => "error" | "throw" | "odd" | null),
  /** Every insert as the code sent it, before the column defaults below are filled in. */
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  /** When set, each address-bucket rpc waits until this many have arrived: requests that all passed the lookup. */
  meet: null as null | { want: number; waiting: Array<() => void> },
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
import { AUTO_KEYS_PER_NETWORK_PER_DAY, autoKeyDailyCap, emailKey, ipSubject } from "../src/api/evaluation-key";
import { SITE_CSP } from "../src/api/site";
import { sha256Hex } from "../src/resolve/text";
import { grantRequestId } from "../scripts/lib/test-key";

// ---- the database as PostgREST shows it -----------------------------------------------------------------------------

/** Column defaults Postgres fills on insert (migration 001). */
const DEFAULTS: Record<string, Row> = {
  tenants: { plan: "free", credits_balance: 0, watch_limit: 5, strict_v0: false, wallet_address: null, contact: null, meta: {}, low_credit_notified_at: null, deleted_at: null },
  api_keys: { name: "default", environment: "live", scopes: [], daily_cap: 1000, requests_today: 0, expires_at: null, revoked_at: null, deleted_at: null },
};
const DOWN = { code: "08006", message: "connection failure" };

/** A query whose every step chains and whose result is a database error, a thrown socket error, or an odd answer. */
function failing(how: "error" | "throw" | "odd", action: string): unknown {
  const odd = { data: action === "select" ? { id: "odd" } : null, error: null };
  const settle = () => (how === "throw" ? Promise.reject(new Error("socket hang up")) : Promise.resolve(how === "odd" ? odd : { data: null, error: DOWN }));
  const p: any = new Proxy(() => undefined, {
    get: (_o, k) => (k === "then" ? (ok: any, no: any) => settle().then(ok, no) : k === "single" || k === "maybeSingle" ? settle : () => p),
  });
  return p;
}

/** PostgREST's embed of tenants(plan, strict_v0, deleted_at) on an api_keys read (src/api/auth.ts lookup). */
function embedTenants(q: any): any {
  const add = (row: Row | null) => {
    if (!row) return row;
    const t = (h.db.tables.tenants ?? []).find((x) => x.id === row.tenant_id);
    return { ...row, tenants: t ? { plan: t.plan, strict_v0: t.strict_v0, deleted_at: t.deleted_at ?? null } : null };
  };
  const attach = (r: { data: any; error: any }) => ({ ...r, data: Array.isArray(r.data) ? r.data.map(add) : add(r.data) });
  const p: any = new Proxy(q, {
    get(o, k) {
      if (k === "then") return (ok: any, no: any) => o.then(attach).then(ok, no);
      if (k === "single" || k === "maybeSingle") return async () => attach(await o[k]());
      const v = Reflect.get(o, k);
      return typeof v === "function" ? (...args: unknown[]) => { const out = v.apply(o, args); return out === o ? p : out; } : v;
    },
  });
  return p;
}

function client(): FakeDb["client"] {
  const base = h.db.client;
  return {
    rpc: async (fn: string, args: Record<string, any>) => {
      const m = h.meet;
      if (m && fn === "rate_limit_hit" && String(args.p_key).startsWith("request_key:email:")) {
        if (m.waiting.length + 1 < m.want) await new Promise<void>((go) => m.waiting.push(go));
        else for (const go of m.waiting.splice(0)) go();
      }
      const b: Broken = h.broken?.(`rpc:${fn}`, args) ?? null;
      if (b === "throw") throw new Error("socket hang up");
      if (b === "error") { h.db.calls.push({ table: `rpc:${fn}`, action: "rpc" }); return { data: null, error: DOWN }; }
      if (b === "odd") { h.db.calls.push({ table: `rpc:${fn}`, action: "rpc" }); return { data: 0, error: null }; }
      return base.rpc(fn, args);
    },
    from: (t: string) => new Proxy(base.from(t), {
      get(o: any, k) {
        if (k !== "insert" && k !== "select" && k !== "update") return Reflect.get(o, k);
        return (...args: any[]) => {
          const b: Broken = h.broken?.(`${t}.${String(k)}`) ?? null;
          if (b) { h.db.calls.push({ table: t, action: String(k) }); return failing(b, String(k)); }
          if (k === "insert") for (const r of [args[0]].flat()) h.inserts.push({ table: t, row: structuredClone(r) });
          if (k === "insert") args[0] = Array.isArray(args[0]) ? args[0].map((r: Row) => ({ ...DEFAULTS[t], ...r })) : { ...DEFAULTS[t], ...args[0] };
          const out = o[k](...args);
          return t === "api_keys" && k === "select" && String(args[0] ?? "").includes("tenants(") ? embedTenants(out) : out;
        };
      },
    }) as any,
  } as FakeDb["client"];
}

// ---- requests -------------------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-09-30T12:00:00Z");
const DAY = 86_400_000;
const KEY = /rsl_test_[a-z0-9]{32}/g;
const NAMES = /jev|typesafe/i;
const env = { PUBLIC_CHANNEL_URL: "https://t.me/resolve_feed", RESOLVE_PUBLIC_URL: "https://resolve.example.com" } as unknown as Env;
const pending: Array<Promise<unknown>> = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;

const good = { name: "Ada Lovelace", email: "ada@example.com", company: "Example Bots", purpose: "Settle CPI markets for our bot", venue: "Polymarket" };
const form = (o: Record<string, string>, ip = "203.0.113.9") => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip }, body: new URLSearchParams(o).toString() });
const jsonReq = (o: unknown, ip = "203.0.113.9") => ({ method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(o) });
const post = (init: RequestInit, e: Env = env) => app.request("/v1/request-key", init, e, ctx);
const keysIn = (s: string) => s.match(KEY) ?? [];
const rows = (t: string) => h.db.tables[t] ?? [];

let logs: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];
let cachePut: ReturnType<typeof vi.fn>;
beforeEach(() => {
  h.db = fakeDb({}, {}, { rpc: REQUEST_KEY_RPCS });
  h.alerts = [];
  h.broken = null;
  h.inserts = [];
  h.meet = null;
  logs = [];
  pending.length = 0;
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
  const store = new Map<string, Response>();
  cachePut = vi.fn(async (req: Request, res: Response) => { store.set(req.url, res); });
  vi.stubGlobal("caches", { default: { match: vi.fn(async (req: Request) => store.get(req.url)?.clone()), put: cachePut, delete: vi.fn(async (req: Request) => store.delete(req.url)) } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const s of spies) s.mockRestore(); });

/** The one answer every request without a key gets, whatever the reason (never says which). */
async function neutralAnswer(): Promise<{ html: string; json: unknown }> {
  const saved = h.db;
  h.db = fakeDb({}, {}, { rpc: REQUEST_KEY_RPCS });
  const html = await (await post(form({ ...good, website: "bot" }))).text();
  const json = ((await (await post(jsonReq({ ...good, website: "bot" }))).json()) as { data: unknown }).data;
  h.db = saved;
  return { html, json };
}

describe("a stranger gets a working evaluation key from the form", () => {
  it("form: the key is shown exactly once, never cached, and authenticates on GET /v1/account with 300 credits, the free plan and 5 watches", async () => {
    const res = await post(form(good));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe(SITE_CSP);
    const html = await res.text();
    expect(keysIn(html)).toHaveLength(1);
    const key = keysIn(html)[0]!;
    expect(cachePut).not.toHaveBeenCalled();

    const account = await app.request("/v1/account", { headers: { authorization: `Bearer ${key}` } }, env, ctx);
    expect(account.status).toBe(200);
    const body = (await account.json()) as { data: { tenant: Row; key: Row } };
    expect(body.data.tenant).toMatchObject({ plan: "free", credits_balance: 300, watch_limit: 5 });
    expect(body.data.key).toMatchObject({ environment: "test", daily_cap: 1000 });

    // the stored key: its hash, test environment, 30 days from issue; the tenant is new, on the free plan, for this address
    expect(rows("api_keys")).toHaveLength(1);
    expect(rows("api_keys")[0]).toMatchObject({ key_hash: await sha256Hex(key), key_prefix: key.slice(0, 12) + "...", environment: "test", name: "request-key", expires_at: new Date(NOW + 30 * DAY).toISOString(), revoked_at: null });
    expect(rows("tenants")).toHaveLength(1);
    expect(rows("tenants")[0]).toMatchObject({ plan: "free", watch_limit: 5, contact: "ada@example.com", display_name: "Example Bots (web form)", meta: { source: "request-key", lead_id: rows("leads")[0]!.id } });

    // and an expired key no longer authenticates
    vi.setSystemTime(NOW + 30 * DAY + 1000);
    const late = await app.request("/v1/account", { headers: { authorization: `Bearer ${key}` } }, env, ctx);
    expect(late.status).toBe(401);
    expect(await late.json()).toMatchObject({ error: { code: "key_expired" } });
  });

  it("JSON: data.key once with its terms; the ledger shows exactly one 300-credit grant, keyed once per tenant like scripts/issue-test-key.ts", async () => {
    const res = await post(jsonReq(good));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(keysIn(text)).toHaveLength(1);
    const { data } = JSON.parse(text) as { data: Record<string, unknown> };
    const tenantId = rows("tenants")[0]!.id as string;
    expect(data).toMatchObject({ received: true, key_issued: true, environment: "test", plan: "free", credits: 300, watch_limit: 5, expires_at: new Date(NOW + 30 * DAY).toISOString(), docs: "https://resolve.example.com/docs" });
    expect(data.key).toMatch(/^rsl_test_[a-z0-9]{32}$/);
    expect(data.key_id).toBe(rows("api_keys")[0]!.id);
    // the next call, as on the key page: the free list of first prints
    expect(data.next).toBe("GET /v1/prints (free): every official series, its latest first print and its next scheduled release");

    expect(rows("credit_ledger")).toHaveLength(1);
    expect(rows("credit_ledger")[0]).toMatchObject({ tenant_id: tenantId, delta: 300, reason: "grant", request_id: grantRequestId(tenantId), balance_after: 300 });
    expect(h.db.calls.filter((c) => c.table === "rpc:grant_credits")).toHaveLength(1);
    // the request_id makes it once per tenant: the script (or a replay) granting again is refused and moves nothing
    const again = await h.db.client.rpc("grant_credits", { p_tenant: tenantId, p_amount: 300, p_note: "replay", p_request_id: grantRequestId(tenantId) });
    expect(again.error?.code).toBe("23505");
    expect(rows("credit_ledger")).toHaveLength(1);
    expect(rows("tenants")[0]!.credits_balance).toBe(300);
  });

  it("the key page says what the key can do (structured verdicts, 300 credits, 30 days, 5 watches), links /docs, and names no model or vendor", async () => {
    const res = await post(form(good));
    const html = await res.text();
    const text = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const s of ["Your test key", "only time it is shown", "Structured verdicts only", "300 credits, valid 30 days: until 2026-10-30 12:00 UTC", "Up to 5 watches"]) expect(text).toContain(s);
    expect(html).toContain('href="/docs"');
    // the next call is the free list of first prints (GET /v1/prints), in the OpenAPI document
    expect(html).toContain("curl https://resolve.example.com/v1/prints -H \"Authorization: Bearer $RESOLVE_KEY\"");
    expect(html).not.toContain("/v1/account -H");
    expect(html).not.toMatch(NAMES);
    expect(JSON.stringify([...res.headers])).not.toMatch(NAMES);
    expect(html).not.toMatch(/<script/i);
  });

  it("while card checkout is offered, the key page links paying by card and the JSON answer carries pay_by_card; otherwise neither", async () => {
    expect(((await (await post(jsonReq(good))).json()) as any).data).not.toHaveProperty("pay_by_card");
    const card = { ...env, WHOP_CHECKOUT_ENABLED: "1", WHOP_API_KEY: "whop_api_key_test", WHOP_PLAN_ID_20: PLAN_20, WHOP_PLAN_ID_50: PLAN_50, WHOP_PLAN_ID_250: PLAN_250 } as unknown as Env;
    const html = await (await post(form({ ...good, email: "grace@example.com" }), card)).text();
    expect(html).toContain('<a href="/pricing#pay-by-card">pay by card</a> for a credit pack with this key');
    const { data } = (await (await post(jsonReq({ ...good, email: "linus@example.com" }, "198.51.100.4"), card)).json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ key_issued: true, pay_by_card: "https://resolve.example.com/pricing#pay-by-card" });
    expect(html).not.toMatch(/usdc|payments\/address/i);
  });

  it("the tenant and the key are inserted with their terms spelled out, not left to the column defaults", async () => {
    expect(((await (await post(jsonReq(good))).json()) as any).data.key_issued).toBe(true);
    expect(h.inserts.find((i) => i.table === "tenants")!.row).toMatchObject({ plan: "free", watch_limit: 5, contact: "ada@example.com" });
    expect(h.inserts.find((i) => i.table === "api_keys")!.row).toMatchObject({ environment: "test", daily_cap: 1000, name: "request-key", expires_at: new Date(NOW + 30 * DAY).toISOString() });
  });

  it("never reuses a tenant: a company named like an existing tenant gets a new tenant, and the existing one is untouched", async () => {
    h.db.tables.tenants = [{ id: "t-existing", display_name: "Example Bots", plan: "builder", credits_balance: 9000, watch_limit: 50, strict_v0: false, contact: null, meta: {}, deleted_at: null, created_at: new Date(NOW - DAY).toISOString() }];
    const { data } = (await (await post(jsonReq(good))).json()) as { data: Record<string, unknown> };
    expect(data.key_issued).toBe(true);
    expect(rows("tenants")).toHaveLength(2);
    expect(rows("tenants")[0]).toMatchObject({ id: "t-existing", plan: "builder", credits_balance: 9000 });
    expect(rows("api_keys")[0]!.tenant_id).not.toBe("t-existing");
  });
});

describe("the key is never stored or sent anywhere but the answer", () => {
  for (const [label, init] of [["form", () => form(good)], ["JSON", () => jsonReq(good)]] as const) {
    it(`${label}: not in the alert text or meta, the lead row, the touch row, any table, or any log line`, async () => {
      const res = await post(init());
      const key = keysIn(await res.text())[0]!;
      expect(key).toBeTruthy();
      await Promise.all(pending);
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0]!.text).toContain(`Key: issued on the spot: tenant ${rows("tenants")[0]!.id}, key id ${rows("api_keys")[0]!.id}, 300 credits, expires 2026-10-30 12:00 UTC`);
      expect(h.alerts[0]!.meta).toMatchObject({ key_result: "issued", key_id: rows("api_keys")[0]!.id });
      const body = key.slice("rsl_test_".length);
      const everywhere = [JSON.stringify(h.alerts), JSON.stringify(rows("leads")), JSON.stringify(rows("gtm_touches")), JSON.stringify(h.db.tables), ...logs];
      for (const s of everywhere) { expect(s).not.toContain(key); expect(s).not.toContain(body); }
      expect(rows("gtm_touches")[0]!.summary).toContain("evaluation key issued on the spot");
      expect(rows("leads")[0]).toMatchObject({ contact: "ada@example.com", status: "prospect", channel: "form" });
    });
  }
});

describe("one key per email address per 30 days", () => {
  it("a second request from the same address (any case, a +tag) issues nothing and gets the neutral answer", async () => {
    const neutral = await neutralAnswer();
    expect(keysIn(await (await post(form(good))).text())).toHaveLength(1);
    for (const email of ["ada@example.com", "ADA@Example.COM", "ada+resolve@example.com"]) {
      const res = await post(form({ ...good, email }, "198.51.100.20"));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe(neutral.html);
    }
    const j = (await (await post(jsonReq(good, "198.51.100.21"))).json()) as { data: unknown };
    expect(j.data).toEqual(neutral.json);
    expect(rows("api_keys")).toHaveLength(1);
    expect(rows("tenants")).toHaveLength(1);
    expect(rows("credit_ledger")).toHaveLength(1);
    // today's behaviour otherwise: each request is a lead, a touch and an alert that says why no key was issued
    expect(rows("leads")).toHaveLength(5);
    expect(h.alerts).toHaveLength(5);
    for (const a of h.alerts.slice(1)) expect(a.text).toContain(`Key: not issued: tenant ${rows("tenants")[0]!.id} was created for this address 2026-09-30 12:00 UTC, within 30 days`);
  });

  it("gmail: dots and googlemail.com reach the same mailbox, so they count as the same address", async () => {
    expect((await (await post(jsonReq({ ...good, email: "ada.lovelace@gmail.com" }))).json() as any).data.key_issued).toBe(true);
    expect((await (await post(jsonReq({ ...good, email: "AdaLovelace+x@googlemail.com" }))).json() as any).data.key_issued).toBe(false);
    expect(rows("api_keys")).toHaveLength(1);
  });

  it("two requests at once for one address issue one key between them", async () => {
    // both pass the address lookup before either creates its tenant: the address bucket decides
    h.meet = { want: 2, waiting: [] };
    const [a, b] = await Promise.all([post(jsonReq(good)), post(jsonReq(good, "198.51.100.30"))]);
    const issued = [await a.json(), await b.json()].filter((x: any) => x.data.key_issued);
    expect(issued).toHaveLength(1);
    expect(rows("api_keys")).toHaveLength(1);
    // the other one was stopped by the address bucket (both passed the lookup), and its alert says so
    expect(h.alerts.map((x) => x.meta.key_result).sort()).toEqual(["address_held", "issued"]);
    expect(h.alerts.find((x) => x.meta.key_result === "address_held")!.text).toContain("Key: not issued: another request for this address holds it until 2026-10-01 12:00 UTC (one running at the same moment");
  });

  it("the same form sent twice, one after the other: one key, and the second alert tells the operator the requester may not have seen it", async () => {
    const neutral = await neutralAnswer();
    expect(keysIn(await (await post(form(good))).text())).toHaveLength(1);
    vi.setSystemTime(NOW + 4000);
    expect(await (await post(form(good))).text()).toBe(neutral.html);
    expect(rows("api_keys")).toHaveLength(1);
    expect(h.alerts[1]!.text).toContain(`Key: not issued: tenant ${rows("tenants")[0]!.id} was created for this address 2026-09-30 12:00 UTC, within 30 days (4 s ago: most likely the same form sent twice, so the requester may never have seen the key; issue one by hand)`);
    expect(h.alerts[1]!.meta).toMatchObject({ key_result: "known_address", tenant_id: rows("tenants")[0]!.id });
    // a day later it is an ordinary repeat
    vi.setSystemTime(NOW + DAY);
    await post(form(good, "198.51.100.31"));
    expect(h.alerts[2]!.text).not.toContain("sent twice");
  });

  it("a tenant created for the address in the last 30 days refuses even when it was deleted since", async () => {
    h.db.tables.tenants = [{ id: "t-gone", display_name: "Gone (web form)", plan: "free", credits_balance: 0, contact: "ada@example.com", deleted_at: new Date(NOW - DAY).toISOString(), created_at: new Date(NOW - 5 * DAY).toISOString() }];
    expect(((await (await post(jsonReq(good))).json()) as any).data.key_issued).toBe(false);
    expect(rows("api_keys")).toHaveLength(0);
    expect(rows("tenants")).toHaveLength(1);
    expect(h.alerts[0]!.text).toContain("Key: not issued: tenant t-gone was created for this address 2026-09-25 12:00 UTC, within 30 days; answer by email");
  });

  it("the 30-day rule stores and looks up the cleaned address: a variant two days later, once the address bucket has lapsed, gets no key", async () => {
    const pairs = [["ada@example.com", "ADA@Example.com"], ["ada@example.com", "ada+two@example.com"], ["Ada+first@Example.com", "ada@example.com"], ["Ada.Lovelace@gmail.com", "adalovelace+x@googlemail.com"]];
    for (const [first, later] of pairs) {
      h.db = fakeDb({}, {}, { rpc: REQUEST_KEY_RPCS });
      h.alerts = [];
      vi.setSystemTime(NOW);
      expect(((await (await post(jsonReq({ ...good, email: first }))).json()) as any).data.key_issued, first).toBe(true);
      expect(rows("tenants")[0]!.contact).toBe(emailKey(first!));
      vi.setSystemTime(NOW + 2 * DAY);
      expect(((await (await post(jsonReq({ ...good, email: later }, "198.51.100.60"))).json()) as any).data.key_issued, `${first} then ${later}`).toBe(false);
      expect(rows("api_keys")).toHaveLength(1);
      expect(h.alerts[1]!.text).toContain(`Key: not issued: tenant ${rows("tenants")[0]!.id} was created for this address`);
    }
  });

  it("the per-address bucket alone refuses (a request for the address is being handled, its tenant not yet visible)", async () => {
    h.db.tables.rate_limit_buckets = [{ key: `request_key:email:${await sha256Hex("ada@example.com")}`, count: 1, reset_at: new Date(NOW + 3600_000).toISOString() }];
    const { data } = (await (await post(jsonReq(good))).json()) as { data: Record<string, unknown> };
    expect(data.key_issued).toBe(false);
    expect(rows("tenants")).toHaveLength(0);
    // the bucket holds a hash, never the address
    expect(JSON.stringify(rows("rate_limit_buckets"))).not.toContain("ada@");
  });

  it("an address whose key was issued 29 days ago gets none; 31 days ago, a new one", async () => {
    const seed = (daysAgo: number) => [{ id: "t-old", display_name: "Old (web form)", plan: "free", credits_balance: 0, contact: "ada@example.com", deleted_at: null, created_at: new Date(NOW - daysAgo * DAY).toISOString() }];
    h.db.tables.tenants = seed(29);
    expect(((await (await post(jsonReq(good))).json()) as any).data.key_issued).toBe(false);
    h.db = fakeDb({ tenants: seed(31) }, {}, { rpc: REQUEST_KEY_RPCS });
    expect(((await (await post(jsonReq(good))).json()) as any).data.key_issued).toBe(true);
  });
});

describe("the address hold is let go when a request ends before its tenant", () => {
  it("stopped by the daily cap: the address gets a key once the cap resets, and the alert says the cap, not an earlier key", async () => {
    const capped = { ...env, REQUEST_KEY_DAILY_CAP: "1" } as Env;
    vi.setSystemTime(Date.parse("2026-09-30T23:00:00Z"));
    expect(((await (await post(jsonReq({ ...good, email: "first@example.com" }), capped)).json()) as any).data.key_issued).toBe(true);
    vi.setSystemTime(Date.parse("2026-09-30T23:30:00Z"));
    expect(((await (await post(jsonReq(good, "198.51.100.70"), capped)).json()) as any).data.key_issued).toBe(false);
    expect(h.alerts[1]!.text).toContain("Key: not issued: today's cap of 1 keys issued on the spot is reached; answer by email");
    vi.setSystemTime(Date.parse("2026-10-01T00:10:00Z"));
    expect(((await (await post(jsonReq(good, "198.51.100.71"), capped)).json()) as any).data.key_issued).toBe(true);
    expect(rows("api_keys")).toHaveLength(2);
    expect(rows("tenants").map((t) => t.contact)).toEqual(["first@example.com", "ada@example.com"]);
  });

  it("stopped by a database error before its tenant: a retry 2 minutes later gets the key", async () => {
    h.broken = (what) => (what === "tenants.insert" ? "error" : null);
    expect(((await (await post(jsonReq(good))).json()) as any).data.key_issued).toBe(false);
    expect(h.alerts[0]!.text).toContain("Key: not issued: database error at tenant insert: connection failure; answer by email");
    h.broken = null;
    vi.setSystemTime(NOW + 120_000);
    expect(((await (await post(jsonReq(good))).json()) as any).data.key_issued).toBe(true);
    expect(rows("api_keys")).toHaveLength(1);
  });

  it("a release that fails is said in the alert, and the hold lapses after its day: 23 h later still held, 25 h later a key", async () => {
    h.broken = (what) => (what === "tenants.insert" || what === "rate_limit_buckets.update" ? "error" : null);
    expect(((await (await post(jsonReq(good))).json()) as any).data.key_issued).toBe(false);
    expect(h.alerts[0]!.text).toContain("Key: not issued: database error at tenant insert: connection failure; the address stays held until 2026-10-01T12:00:00.000Z (its release failed: connection failure); answer by email");
    h.broken = null;
    vi.setSystemTime(NOW + 23 * 3600_000);
    expect(((await (await post(jsonReq(good))).json()) as any).data.key_issued).toBe(false);
    expect(h.alerts[1]!.text).toContain("Key: not issued: another request for this address holds it until 2026-10-01 12:00 UTC");
    vi.setSystemTime(NOW + 25 * 3600_000);
    expect(((await (await post(jsonReq(good))).json()) as any).data.key_issued).toBe(true);
  });
});

describe("keys per network per day", () => {
  it("one network gets 3 keys a UTC day with fresh addresses, then the neutral answer, spending none of the day's cap; the next day 3 more", async () => {
    const neutral = await neutralAnswer();
    const start = Date.parse("2026-09-30T06:00:00Z");
    let issued = 0;
    for (let hour = 0; hour < 6; hour++) {
      vi.setSystemTime(start + hour * 3600_000);
      for (let i = 0; i < 5; i++) {
        const html = await (await post(form({ ...good, email: `bot${hour}-${i}@catchall.example` }, "203.0.113.66"))).text();
        if (keysIn(html).length) issued++;
        else expect(html).toBe(neutral.html);
      }
    }
    expect(issued).toBe(3);
    expect(h.alerts[3]!.text).toContain("Key: not issued: 3 keys were already issued on the spot to this network today; answer by email");
    // the day's count holds the 3 keys only, and each refused address was let go
    expect(rows("rate_limit_buckets").find((b) => b.key === "request_key:issued:2026-09-30")!.count).toBe(3);
    const holds = rows("rate_limit_buckets").filter((b) => String(b.key).startsWith("request_key:email:"));
    expect(holds.map((b) => b.count).sort()).toEqual([...Array(27).fill(0), 1, 1, 1]);
    // another network still gets a key the same day
    expect(((await (await post(jsonReq({ ...good, email: "real@person.example" }, "198.51.100.99"))).json()) as any).data.key_issued).toBe(true);
    // the next UTC day, the first network again
    vi.setSystemTime(Date.parse("2026-10-01T06:00:00Z"));
    expect(((await (await post(jsonReq({ ...good, email: "next@catchall.example" }, "203.0.113.66"))).json()) as any).data.key_issued).toBe(true);
  });

  it("IPv6: one /64 is one network", async () => {
    const ips = ["2001:db8:1:2::a", "2001:db8:1:2:ffff::b", "2001:DB8:1:2:3:4:5:6", "2001:db8:1:2::c"];
    const got = [];
    for (const [i, ip] of ips.entries()) got.push(((await (await post(jsonReq({ ...good, email: `v6-${i}@example.com` }, ip))).json()) as any).data.key_issued);
    expect(got).toEqual([true, true, true, false]);
    expect(((await (await post(jsonReq({ ...good, email: "v6-other@example.com" }, "2001:db8:1:3::1"))).json()) as any).data.key_issued).toBe(true);
  });

  it("ipSubject", () => {
    expect(ipSubject("203.0.113.9")).toBe("203.0.113.9");
    expect(ipSubject("2001:db8:1:2::a")).toBe("2001:0db8:0001:0002::/64");
    expect(ipSubject(" 2001:DB8:1:2:3:4:5:6 ")).toBe("2001:0db8:0001:0002::/64");
    expect(ipSubject("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(ipSubject("fe80:1:2:3::")).toBe("fe80:0001:0002:0003::/64");
    expect(ipSubject("::1")).toBe("0000:0000:0000:0000::/64");
    expect(ipSubject("::ffff:192.0.2.1")).toBe("0000:0000:0000:0000::/64");
  });

  it("docs/pricing.md states the network's number the code uses", () => {
    expect(readFileSync(resolve(import.meta.dirname, "../docs/pricing.md"), "utf8")).toContain(`${AUTO_KEYS_PER_NETWORK_PER_DAY} keys a day per network`);
  });
});

describe("the daily cap", () => {
  it("past REQUEST_KEY_DAILY_CAP keys in a UTC day the form falls back: lead stored, operator alerted, the neutral answer; the next day issues again", async () => {
    const capped = { ...env, REQUEST_KEY_DAILY_CAP: "2" } as Env;
    const neutral = await neutralAnswer();
    const issuedFor = async (email: string) => keysIn(await (await post(form({ ...good, email }), capped)).text()).length;
    expect(await issuedFor("a@example.com")).toBe(1);
    expect(await issuedFor("b@example.com")).toBe(1);
    const res = await post(form({ ...good, email: "c@example.com" }), capped);
    expect(await res.text()).toBe(neutral.html);
    expect(rows("api_keys")).toHaveLength(2);
    expect(rows("leads")).toHaveLength(3);
    expect(h.alerts[2]!.text).toContain("Key: not issued: today's cap of 2 keys issued on the spot is reached");
    vi.setSystemTime(NOW + DAY);
    expect(await issuedFor("d@example.com")).toBe(1);
  });

  it("the default is 25 a day", async () => {
    h.db.tables.rate_limit_buckets = [{ key: "request_key:issued:2026-09-30", count: 25, reset_at: new Date(NOW + 3600_000).toISOString() }];
    expect(((await (await post(jsonReq(good))).json()) as any).data.key_issued).toBe(false);
    expect(h.alerts[0]!.text).toContain("today's cap of 25 keys");
    h.db.tables.rate_limit_buckets = [{ key: "request_key:issued:2026-09-30", count: 24, reset_at: new Date(NOW + 3600_000).toISOString() }];
    expect(((await (await post(jsonReq({ ...good, email: "b@example.com" }))).json()) as any).data.key_issued).toBe(true);
  });

  it("REQUEST_KEY_DAILY_CAP 0 or invalid: no key and no database step beyond today's (lead, touch, alert)", async () => {
    for (const REQUEST_KEY_DAILY_CAP of ["0", "abc", "-1", "2.5", "1e3", "5000"]) {
      h.db = fakeDb({}, {}, { rpc: REQUEST_KEY_RPCS });
      h.alerts = [];
      const { data } = (await (await post(jsonReq(good), { ...env, REQUEST_KEY_DAILY_CAP } as Env)).json()) as { data: Record<string, unknown> };
      expect(data.key_issued, REQUEST_KEY_DAILY_CAP).toBe(false);
      expect(rows("tenants")).toHaveLength(0);
      expect(rows("leads")).toHaveLength(1);
      expect(h.db.calls.map((c) => c.table)).toEqual(["rpc:rate_limit_hit", "rpc:rate_limit_hit", "leads", "rpc:log_touch"]);
      expect(h.alerts[0]!.text).toContain(REQUEST_KEY_DAILY_CAP === "0" ? "not issued (REQUEST_KEY_DAILY_CAP is 0)" : "not issued (REQUEST_KEY_DAILY_CAP is not a whole number from 0 to 1000)");
    }
  });

  it("autoKeyDailyCap", () => {
    expect(autoKeyDailyCap(undefined)).toEqual({ cap: 25, invalid: false });
    expect(autoKeyDailyCap(" ")).toEqual({ cap: 25, invalid: false });
    expect(autoKeyDailyCap("7")).toEqual({ cap: 7, invalid: false });
    expect(autoKeyDailyCap("1000")).toEqual({ cap: 1000, invalid: false });
    for (const bad of ["1001", "-3", "3.0", "ten", "0x10"]) expect(autoKeyDailyCap(bad)).toEqual({ cap: 0, invalid: true });
  });
});

describe("a database error issues nothing", () => {
  const bucket = (prefix: string) => (a?: Record<string, any>) => String(a?.p_key).startsWith(prefix);
  /**
   * `released`: the request held the address and stopped before a tenant existed, so the hold is let go (true), or a
   * tenant exists and the hold stays (false); undefined when the address was never held.
   */
  const STEPS: Array<{ step: string; at: string; how: "error" | "throw" | "odd"; match?: (a?: Record<string, any>) => boolean; tenantMade: boolean; detail?: string; released?: boolean }> = [
    { step: "address lookup", at: "tenants.select", how: "error", tenantMade: false },
    { step: "address lookup", at: "tenants.select", how: "throw", tenantMade: false },
    // one object instead of rows (as .single() would answer) is not "no earlier tenant"
    { step: "address lookup", at: "tenants.select", how: "odd", tenantMade: false, detail: "no rows array" },
    { step: "address bucket", at: "rpc:rate_limit_hit", how: "error", match: bucket("request_key:email:"), tenantMade: false },
    { step: "address bucket", at: "rpc:rate_limit_hit", how: "throw", match: bucket("request_key:email:"), tenantMade: false },
    { step: "address bucket", at: "rpc:rate_limit_hit", how: "odd", match: bucket("request_key:email:"), tenantMade: false, detail: "unexpected answer" },
    { step: "network bucket", at: "rpc:rate_limit_hit", how: "error", match: bucket("request_key:net:"), tenantMade: false, released: true },
    { step: "network bucket", at: "rpc:rate_limit_hit", how: "odd", match: bucket("request_key:net:"), tenantMade: false, detail: "unexpected answer", released: true },
    { step: "daily cap bucket", at: "rpc:rate_limit_hit", how: "error", match: bucket("request_key:issued:"), tenantMade: false, released: true },
    // an odd answer from the day's bucket is a database error, not "the cap is reached"
    { step: "daily cap bucket", at: "rpc:rate_limit_hit", how: "odd", match: bucket("request_key:issued:"), tenantMade: false, detail: "unexpected answer", released: true },
    { step: "tenant insert", at: "tenants.insert", how: "error", tenantMade: false, released: true },
    { step: "tenant insert", at: "tenants.insert", how: "throw", tenantMade: false, released: true },
    { step: "tenant insert", at: "tenants.insert", how: "odd", tenantMade: false, detail: "no row returned", released: true },
    { step: "grant_credits", at: "rpc:grant_credits", how: "error", tenantMade: true, released: false },
    { step: "grant_credits", at: "rpc:grant_credits", how: "throw", tenantMade: true, released: false },
    { step: "grant_credits", at: "rpc:grant_credits", how: "odd", tenantMade: true, detail: "balance after the grant is 0, expected 300", released: false },
    { step: "key insert", at: "api_keys.insert", how: "error", tenantMade: true, released: false },
    { step: "key insert", at: "api_keys.insert", how: "throw", tenantMade: true, released: false },
    { step: "key insert", at: "api_keys.insert", how: "odd", tenantMade: true, detail: "no row returned", released: false },
  ];
  for (const s of STEPS) {
    it(`${s.step} (${s.how}): no key, the lead stored, the neutral answer, an operator alert naming the step`, async () => {
      const neutral = await neutralAnswer();
      h.broken = (what, args) => (what === s.at && (!s.match || s.match(args)) ? s.how : null);
      const res = await post(form(good));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toBe(neutral.html);
      expect(keysIn(html)).toHaveLength(0);
      expect(rows("api_keys")).toHaveLength(0);
      expect(rows("leads")).toHaveLength(1);
      expect(h.alerts).toHaveLength(1);
      // the alert names the step and what it answered: each check is its own rail, not a later step's accident
      const detail = s.detail ?? (s.how === "error" ? "connection failure" : "socket hang up");
      expect(h.alerts[0]!.text).toContain(`Key: not issued: database error at ${s.step}: ${detail}`);
      expect(h.alerts[0]!.text).not.toMatch(/rsl_test_[a-z0-9]{8}/);
      expect(h.alerts[0]!.text).not.toContain("held until");
      expect(rows("tenants")).toHaveLength(s.tenantMade ? 1 : 0);
      if (s.tenantMade) expect(h.alerts[0]!.text).toContain(`tenant ${rows("tenants")[0]!.id} was created without a key`);
      for (const l of logs) expect(l).not.toMatch(/rsl_test_[a-z0-9]{8}/);
      const holdKey = `request_key:email:${await sha256Hex("ada@example.com")}`;
      const hold = rows("rate_limit_buckets").find((b) => b.key === holdKey);
      if (s.released === undefined) expect(hold).toBeUndefined();
      else expect(hold).toMatchObject(s.released ? { count: 0, reset_at: "1970-01-01T00:00:00.000Z" } : { count: 1 });
    });
  }
});

describe("the lead comes first", () => {
  it("a lead that cannot be stored answers 503 as before, and nothing is issued or alerted", async () => {
    h.broken = (what) => (what === "leads.insert" ? "error" : null);
    const res = await post(jsonReq(good));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(keysIn(await res.text())).toHaveLength(0);
    expect(rows("tenants")).toHaveLength(0);
    expect(rows("api_keys")).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
  });
});

describe("the form's limits and caching stay", () => {
  it("the per-IP limit still applies: the sixth request from one address in an hour answers 429 and issues nothing", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await post(jsonReq({ ...good, email: `u${i}@example.com` }));
      expect(res.status).toBe(200);
      // a key for the first 3 (the network's day), then the neutral answer
      expect(((await res.json()) as { data: Record<string, unknown> }).data.key_issued).toBe(i < 3);
    }
    const res = await post(jsonReq({ ...good, email: "u5@example.com" }));
    expect(res.status).toBe(429);
    expect(keysIn(await res.text())).toHaveLength(0);
    expect(rows("api_keys")).toHaveLength(3);
    expect(rows("leads")).toHaveLength(5);
    // another address is not limited by it
    expect(((await (await post(jsonReq({ ...good, email: "u6@example.com" }, "198.51.100.40"))).json()) as any).data.key_issued).toBe(true);
  });

  it("no answer is cached: no-store on the key, the neutral answer and a validation error, and the Cache API is never written", async () => {
    const answers = [await post(form(good)), await post(jsonReq(good, "198.51.100.50")), await post(jsonReq({ ...good, email: "nope" })), await post(form({ ...good, website: "bot" }))];
    for (const r of answers) expect(r.headers.get("cache-control")).toBe("no-store");
    expect(cachePut).not.toHaveBeenCalled();
  });
});

describe("emailKey", () => {
  it("lower case, a +tag dropped, gmail dots dropped and googlemail.com read as gmail.com; other domains keep their dots", () => {
    expect(emailKey(" Ada@Example.com ")).toBe("ada@example.com");
    expect(emailKey("ada+resolve@example.com")).toBe("ada@example.com");
    expect(emailKey("a.d.a@gmail.com")).toBe("ada@gmail.com");
    expect(emailKey("A.da+x@GoogleMail.com")).toBe("ada@gmail.com");
    expect(emailKey("a.da@example.com")).toBe("a.da@example.com");
    expect(emailKey("+x@example.com")).toBe("+x@example.com");
  });
});

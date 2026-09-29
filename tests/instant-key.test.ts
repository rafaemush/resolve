/**
 * POST /v1/request-key issues an evaluation key on the spot (plan §21.4 C, src/api/evaluation-key.ts), end to end over
 * the in-memory database with the stand-ins of rate_limit_hit, grant_credits and log_touch (tests/lib/fake-request-key.ts):
 * a stranger's key authenticates on GET /v1/account with 300 credits granted exactly once; one key per address per 30
 * days; the daily cap and every database error fall back to the stored lead, the operator alert and one neutral answer;
 * the key is never in the alert, the lead, the touch, a table or a log line; the per-IP limit still applies; no answer
 * is cached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { REQUEST_KEY_RPCS } from "./lib/fake-request-key";

type Broken = "error" | "throw" | "odd" | null;
const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  alerts: [] as Array<{ key: string; text: string; meta: Record<string, unknown> }>,
  /** A forced database failure: "<table>.<select|insert>" or "rpc:<fn>" (with its args) -> how it fails, or null. */
  broken: null as null | ((what: string, args?: Record<string, any>) => "error" | "throw" | "odd" | null),
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
import { autoKeyDailyCap, emailKey } from "../src/api/evaluation-key";
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

/** A query whose every step chains and whose result is a database error, or a thrown socket error. */
function failing(how: "error" | "throw"): unknown {
  const settle = () => (how === "throw" ? Promise.reject(new Error("socket hang up")) : Promise.resolve({ data: null, error: DOWN }));
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
      const b: Broken = h.broken?.(`rpc:${fn}`, args) ?? null;
      if (b === "throw") throw new Error("socket hang up");
      if (b === "error") { h.db.calls.push({ table: `rpc:${fn}`, action: "rpc" }); return { data: null, error: DOWN }; }
      if (b === "odd") { h.db.calls.push({ table: `rpc:${fn}`, action: "rpc" }); return { data: 0, error: null }; }
      return base.rpc(fn, args);
    },
    from: (t: string) => new Proxy(base.from(t), {
      get(o: any, k) {
        if (k !== "insert" && k !== "select") return Reflect.get(o, k);
        return (...args: any[]) => {
          const b: Broken = h.broken?.(`${t}.${String(k)}`) ?? null;
          if (b === "error" || b === "throw") return failing(b);
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
    expect(html).toContain("curl https://resolve.example.com/v1/account -H \"Authorization: Bearer $RESOLVE_KEY\"");
    expect(html).not.toMatch(NAMES);
    expect(JSON.stringify([...res.headers])).not.toMatch(NAMES);
    expect(html).not.toMatch(/<script/i);
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
    for (const a of h.alerts.slice(1)) expect(a.text).toContain("Key: not issued: this address had a key in the last 30 days");
  });

  it("gmail: dots and googlemail.com reach the same mailbox, so they count as the same address", async () => {
    expect((await (await post(jsonReq({ ...good, email: "ada.lovelace@gmail.com" }))).json() as any).data.key_issued).toBe(true);
    expect((await (await post(jsonReq({ ...good, email: "AdaLovelace+x@googlemail.com" }))).json() as any).data.key_issued).toBe(false);
    expect(rows("api_keys")).toHaveLength(1);
  });

  it("two requests at once for one address issue one key between them", async () => {
    const [a, b] = await Promise.all([post(jsonReq(good)), post(jsonReq(good, "198.51.100.30"))]);
    const issued = [await a.json(), await b.json()].filter((x: any) => x.data.key_issued);
    expect(issued).toHaveLength(1);
    expect(rows("api_keys")).toHaveLength(1);
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
  const STEPS: Array<{ step: string; at: string; how: "error" | "throw" | "odd"; match?: (a?: Record<string, any>) => boolean; tenantMade: boolean }> = [
    { step: "address lookup", at: "tenants.select", how: "error", tenantMade: false },
    { step: "address lookup", at: "tenants.select", how: "throw", tenantMade: false },
    { step: "address bucket", at: "rpc:rate_limit_hit", how: "error", match: (a) => String(a?.p_key).startsWith("request_key:email:"), tenantMade: false },
    { step: "address bucket", at: "rpc:rate_limit_hit", how: "throw", match: (a) => String(a?.p_key).startsWith("request_key:email:"), tenantMade: false },
    { step: "daily cap bucket", at: "rpc:rate_limit_hit", how: "error", match: (a) => String(a?.p_key).startsWith("request_key:issued:"), tenantMade: false },
    { step: "tenant insert", at: "tenants.insert", how: "error", tenantMade: false },
    { step: "tenant insert", at: "tenants.insert", how: "throw", tenantMade: false },
    { step: "grant_credits", at: "rpc:grant_credits", how: "error", tenantMade: true },
    { step: "grant_credits", at: "rpc:grant_credits", how: "throw", tenantMade: true },
    { step: "grant_credits", at: "rpc:grant_credits", how: "odd", tenantMade: true },
    { step: "key insert", at: "api_keys.insert", how: "error", tenantMade: true },
    { step: "key insert", at: "api_keys.insert", how: "throw", tenantMade: true },
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
      const detail = s.how === "error" ? "connection failure" : s.how === "throw" ? "socket hang up" : "balance after the grant is 0, expected 300";
      expect(h.alerts[0]!.text).toContain(`Key: not issued: database error at ${s.step}: ${detail}`);
      expect(h.alerts[0]!.text).not.toMatch(/rsl_test_[a-z0-9]{8}/);
      expect(rows("tenants")).toHaveLength(s.tenantMade ? 1 : 0);
      if (s.tenantMade) expect(h.alerts[0]!.text).toContain(`tenant ${rows("tenants")[0]!.id} was created without a key`);
      for (const l of logs) expect(l).not.toMatch(/rsl_test_[a-z0-9]{8}/);
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
      const { data } = (await (await post(jsonReq({ ...good, email: `u${i}@example.com` }))).json()) as { data: Record<string, unknown> };
      expect(data.key_issued).toBe(true);
    }
    const res = await post(jsonReq({ ...good, email: "u5@example.com" }));
    expect(res.status).toBe(429);
    expect(keysIn(await res.text())).toHaveLength(0);
    expect(rows("api_keys")).toHaveLength(5);
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

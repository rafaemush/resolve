/**
 * First prints (src/api/prints.ts, plan §22.3 item 6): GET /v1/prints lists every series with its latest recorded
 * period and next scheduled release for 0 credits; GET /v1/prints/{series}/{period} answers the stored first print for
 * 1 credit, charged once per request through migration 022's charge_read() (the stand-in in tests/lib/fake-money.ts;
 * scripts/selftest/prints.ts proves the SQL), a replay of the same Idempotency-Key for the same print free, a short
 * balance a 402 that points to the card rail only, and a release not recorded yet {status: "scheduled"} for 0 credits.
 * Through the whole app (src/index.ts), so the v1 key middleware and its per-key rate limit are the ones that run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { chargeRead } from "./lib/fake-money";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb, plan: "free" as string, limited: false, failFrom: null as string | null,
  selects: [] as Array<[string, string]>, rateCalls: [] as unknown[],
}));
/** A query whose every step answers the same error (the store unreachable). */
const failing = (message: string): unknown => {
  const q: Record<string, unknown> = {};
  const answer = { data: null, error: { code: "08006", message } };
  for (const m of ["select", "eq", "in", "order", "limit", "is"]) q[m] = () => q;
  q.maybeSingle = async () => answer;
  q.single = async () => answer;
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve(answer).then(ok);
  return q;
};
vi.mock("../src/db/supabase", () => ({
  db: () => ({
    ...h.db.client,
    from: (t: string) => {
      if (h.failFrom === t) return failing("connection refused");
      const q = h.db.client.from(t);
      const select = q.select.bind(q);
      q.select = ((cols?: string, opts?: { count?: string; head?: boolean }) => { h.selects.push([t, cols ?? "*"]); return select(cols, opts); }) as typeof q.select;
      return q;
    },
  }),
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/api/auth", () => ({
  authenticate: async () => ({ ok: true, auth: { keyId: "k1", tenantId: "t1", plan: h.plan, strictV0: false, environment: "test", scopes: [], requestsToday: 0, dailyCap: 1000, expiresAt: null } }),
  rateLimit: async (_c: unknown, _auth: unknown, opts: unknown) => {
    h.rateCalls.push(opts);
    return h.limited
      ? { allowed: false, response: new Response(JSON.stringify({ ok: false, error: { code: "rate_limited", message: "Rate limit for this API key reached" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } }) }
      : { allowed: true };
  },
  authenticateKey: async () => ({ ok: false, response: new Response(null, { status: 401 }) }),
  extractApiKey: () => null,
  invalidateKeyCache: async () => undefined,
  perKeyRpm: () => 60,
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })), alertMany: vi.fn(async () => ({ sent: [], deduped: [] })) }));
vi.mock("../src/billing/events", () => ({ noteCharge: vi.fn(async () => ({ crossed: false, queued: 0 })) }));

import { app } from "../src/index";
import { noteCharge } from "../src/billing/events";
import { KNOWN_RELEASES, OFFICIAL_SERIES, missingAfterMs, type OfficialSeriesId } from "../src/resolve/official";
import { chargeRequestId, isSeries, listSeries, nextRelease, observedBeforeRelease, scheduledAnswer, shapePrint, LIST_READ_CAP, PRINT_COLUMNS, PRINT_PRICE_CREDITS, VERIFY_HINT, type PrintRow } from "../src/api/prints";

const NAMES = /jev|typesafe/i;
const env = { RESOLVE_PUBLIC_URL: "https://resolve.example.com" } as Env;
const cardEnv = { ...env, WHOP_CHECKOUT_ENABLED: "1", WHOP_API_KEY: "whop_test_key", WHOP_PLAN_ID_20: "plan_c", WHOP_PLAN_ID_50: "plan_a", WHOP_PLAN_ID_250: "plan_b" } as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const EMPSIT = KNOWN_RELEASES["us_unemployment_rate:2026-09"]!;
const RELEASE = Date.parse(EMPSIT.release_at);
const AFTER = RELEASE + 3600_000;
const CORROBORATION = { status: "agree", source_url: "https://api.bls.gov/publicAPI/v2/timeseries/data/LNS14000000", value: 4.3, value_text: "4.3", detail: "operator re-read of the API row after a revision query", checked_at: "2026-10-02T12:31:02Z", recheck_id: 7, rechecked_at: "2026-10-02T13:00:00Z" };
const PRINT: Row = {
  series: "us_unemployment_rate", period: "2026-09", value: "4.3", value_text: "4.3",
  deciding_text: "THE EMPLOYMENT SITUATION -- SEPTEMBER 2026 ... The unemployment rate was 4.3 percent in September.",
  source_url: "https://www.bls.gov/news.release/empsit.nr0.htm", raw_sha256: "ab".repeat(32), observed_at: "2026-10-02T12:30:41.123+00:00",
  corroboration: CORROBORATION, meta: { doc_period: "2026-09", fetch_ms: 812, contest: { secret_count: 1 } },
};

function newDb(o: { balance?: number; prints?: Row[]; deleted?: boolean } = {}): FakeDb {
  return fakeDb({
    tenants: [{ id: "t1", plan: "free", credits_balance: o.balance ?? 300, deleted_at: o.deleted ? "2026-10-01T00:00:00Z" : null }],
    official_observations: o.prints ?? [PRINT],
    credit_ledger: [],
  }, {}, { rpc: { charge_read: chargeRead } });
}
const get = (path: string, headers: Record<string, string> = {}, e: Env = env) => app.request(path, { headers: { authorization: `Bearer rsl_test_${"a".repeat(32)}`, ...headers } }, e, ctx);
const body = async (res: Response) => (await res.json()) as { ok: boolean; data: Record<string, any>; error?: { code: string; message: string }; [k: string]: unknown };
const charges = () => (h.db.tables.credit_ledger ?? []).filter((l) => l.reason === "charge");
const chargeCalls = () => h.db.calls.filter((c) => c.table === "rpc:charge_read");

beforeEach(() => {
  h.plan = "free"; h.limited = false; h.failFrom = null; h.selects = []; h.rateCalls = [];
  vi.mocked(noteCharge).mockClear();
  vi.useFakeTimers({ now: AFTER, toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("GET /v1/prints: every series, its latest print and its next release, free", () => {
  it("lists OFFICIAL_SERIES in order with the latest recorded period (by period, not by read order) and the next scheduled release", async () => {
    h.db = newDb({ prints: [
      { series: "us_unemployment_rate", period: "2026-09", observed_at: "2026-10-02T12:30:41Z" },
      { series: "us_unemployment_rate", period: "2026-08", observed_at: "2026-10-03T00:00:00Z" },
      { series: "fomc_upper_bound", period: "2026-09-16", observed_at: "2026-09-16T18:00:12Z" },
    ] });
    const res = await get("/v1/prints");
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.data.count).toBe(Object.keys(OFFICIAL_SERIES).length);
    expect(b.data.series.map((s: { series: string }) => s.series)).toEqual(Object.keys(OFFICIAL_SERIES));
    const u = b.data.series.find((s: { series: string }) => s.series === "us_unemployment_rate");
    expect(u.latest).toEqual({ period: "2026-09", observed_at: "2026-10-02T12:30:41.000Z", read: "/v1/prints/us_unemployment_rate/2026-09" });
    expect(u).toMatchObject({ label: OFFICIAL_SERIES.us_unemployment_rate.label, unit: "percent, as published (1 decimal)", period_format: "YYYY-MM" });
    // the next release is the soonest one in the registry after now, whatever it is
    const next = Object.entries(KNOWN_RELEASES).filter(([k, r]) => k.startsWith("us_unemployment_rate:") && Date.parse(r.release_at) > AFTER).sort((x, y) => x[1].release_at.localeCompare(y[1].release_at))[0]!;
    expect(u.next_release).toEqual({ period: next[0].split(":")[1], release_at: next[1].release_at, read: `/v1/prints/us_unemployment_rate/${next[0].split(":")[1]}` });
    expect(b.data.series.find((s: { series: string }) => s.series === "ecb_dfr").latest).toBeNull();
    expect(b.data).toMatchObject({ credits_charged: 0, price_credits: { list: 0, print: 1 } });
    expect(chargeCalls()).toHaveLength(0);
    expect(charges()).toHaveLength(0);
    expect(h.selects).toContainEqual(["official_observations", "series, period, observed_at"]);
    expect(JSON.stringify(b)).not.toMatch(NAMES);
  });

  it("the store unreadable is a 503, never a list with every latest print missing", async () => {
    h.db = newDb();
    h.failFrom = "official_observations";
    const res = await get("/v1/prints");
    expect(res.status).toBe(503);
    expect((await body(res)).error!.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("pure: listSeries and nextRelease read the registry; the read is capped", () => {
    expect(LIST_READ_CAP).toBe(1000);
    const out = listSeries(Date.parse("2026-10-01T00:00:00Z"), []);
    expect(out.every((s) => s.latest === null)).toBe(true);
    expect(out.find((s) => s.series === "us_unemployment_rate")!.next_release).toMatchObject({ period: "2026-09", release_at: EMPSIT.release_at });
    expect(nextRelease("us_unemployment_rate", RELEASE)!.period).not.toBe("2026-09");
    const elections = out.filter((s) => OFFICIAL_SERIES[s.series as OfficialSeriesId].decides === "election");
    expect(elections.length).toBeGreaterThan(0);
    for (const e of elections) expect(e.unit).toBe("valid votes in the authority's count");
  });
});

describe("GET /v1/prints/{series}/{period}: the first print, 1 credit once per request", () => {
  it("answers the stored row's fields, the corroboration status only, the verify hint; charges 1 credit with one ledger row", async () => {
    h.db = newDb();
    const res = await get("/v1/prints/us_unemployment_rate/2026-09");
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.data).toEqual({
      series: "us_unemployment_rate", period: "2026-09", status: "recorded", value: 4.3, value_text: "4.3", deciding_text: PRINT.deciding_text,
      observed_at: "2026-10-02T12:30:41.123Z", release_at: EMPSIT.release_at, source_url: PRINT.source_url, raw_sha256: PRINT.raw_sha256,
      corroboration: { status: "agree" }, verify: VERIFY_HINT, credits_charged: 1, balance: 299, replayed: false,
    });
    // never the corroboration jsonb (operator text, re-check ids) nor meta (an election's whole count travels there)
    const json = JSON.stringify(b);
    for (const leak of [CORROBORATION.detail, "recheck_id", "rechecked_at", "secret_count", "fetch_ms", "doc_period"]) expect(json).not.toContain(leak);
    expect(h.selects).toContainEqual(["official_observations", PRINT_COLUMNS.join(", ")]);
    expect(PRINT_COLUMNS).not.toContain("meta");
    expect(charges()).toHaveLength(1);
    expect(charges()[0]).toMatchObject({ tenant_id: "t1", delta: -1, balance_after: 299, note: "read" });
    expect(charges()[0]!.request_id).toMatch(/^print:us_unemployment_rate:2026-09:req_[0-9a-f]{32}$/);
    expect(h.db.tables.tenants![0]!.credits_balance).toBe(299);
    // credits.low is claimed after a charge that stands, as on POST /v1/resolve
    expect(vi.mocked(noteCharge)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(noteCharge).mock.calls[0]!.slice(1)).toEqual(["t1", charges()[0]!.request_id, { plan: "free", base: "https://resolve.example.com" }]);
    expect(res.headers.get("x-idempotent-replay")).toBeNull();
    expect(json).not.toMatch(NAMES);
  });

  it("each request without an Idempotency-Key is charged; the same key for the same print replays free; the same key for another print is a new read", async () => {
    h.db = newDb({ prints: [PRINT, { ...PRINT, series: "us_nonfarm_payrolls_change", value: "22", value_text: "22" }] });
    await get("/v1/prints/us_unemployment_rate/2026-09");
    await get("/v1/prints/us_unemployment_rate/2026-09");
    expect(charges()).toHaveLength(2);
    const k = { "idempotency-key": "print-demo-1" };
    const first = await body(await get("/v1/prints/us_unemployment_rate/2026-09", k));
    expect(first.data).toMatchObject({ credits_charged: 1, balance: 297, replayed: false });
    const res = await get("/v1/prints/us_unemployment_rate/2026-09", k);
    const again = await body(res);
    expect(again.data).toMatchObject({ value_text: "4.3", credits_charged: 0, balance: 297, replayed: true });
    expect(res.headers.get("x-idempotent-replay")).toBe("true");
    expect(charges()).toHaveLength(3);
    expect(vi.mocked(noteCharge)).toHaveBeenCalledTimes(3);
    const other = await body(await get("/v1/prints/us_nonfarm_payrolls_change/2026-09", k));
    expect(other.data).toMatchObject({ value_text: "22", credits_charged: 1, balance: 296, replayed: false });
    expect(charges()).toHaveLength(4);
  });

  it("the charge id binds tenant, print and key: another tenant's key or another print never replays it", async () => {
    const base = { tenantId: "t1", series: "us_unemployment_rate", period: "2026-09", idempotencyKey: "k", requestId: "req_1" };
    const id = await chargeRequestId(base);
    expect(id).toMatch(/^print:us_unemployment_rate:2026-09:[0-9a-f]{64}$/);
    expect(await chargeRequestId({ ...base, requestId: "req_2" })).toBe(id);
    for (const o of [{ tenantId: "t2" }, { period: "2026-08" }, { series: "us_cpi_u_nsa_yoy" }, { idempotencyKey: "k2" }]) expect(await chargeRequestId({ ...base, ...o })).not.toBe(id);
    expect(await chargeRequestId({ ...base, idempotencyKey: null })).toBe("print:us_unemployment_rate:2026-09:req_1");
  });

  it("a short balance is a 402 with nothing written; the top-up names the card rail when it is offered and never the USDC address", async () => {
    for (const [e, hint, top] of [
      [env, "Card checkout is not available right now: contact support (https://resolve.example.com/terms#contact) to add credits.", { method: "contact_support", page: "https://resolve.example.com/terms#contact" }],
      [cardEnv, 'Top up by card: POST /v1/billing/checkout with {"pack": "20" | "50" | "250"} answers a checkout_url, or use the form at https://resolve.example.com/pricing#pay-by-card.', { method: "card", checkout: "POST /v1/billing/checkout", page: "https://resolve.example.com/pricing#pay-by-card" }],
    ] as const) {
      h.db = newDb({ balance: 0 });
      const res = await get("/v1/prints/us_unemployment_rate/2026-09", {}, { ...e, USDC_RECEIVING_ADDRESS: `0x${"1".repeat(40)}` } as Env);
      expect(res.status).toBe(402);
      const b = await body(res);
      expect(b.error!.code).toBe("insufficient_credits");
      expect(b.error!.message).toBe(`A first print costs 1 credit; balance is 0. ${hint}`);
      expect(b).toMatchObject({ balance: 0, price_credits: 1, top_up: top });
      const json = JSON.stringify(b);
      expect(json).not.toMatch(/payments\/address|usdc|0x1111/i);
      expect(json).not.toContain(PRINT.deciding_text);
      expect(charges()).toHaveLength(0);
      expect(h.db.tables.tenants![0]!.credits_balance).toBe(0);
      expect(vi.mocked(noteCharge)).not.toHaveBeenCalled();
    }
  });

  it("a replay still answers at a zero balance: the charge stands", async () => {
    h.db = newDb({ balance: 1 });
    const k = { "idempotency-key": "last-credit" };
    expect((await body(await get("/v1/prints/us_unemployment_rate/2026-09", k))).data).toMatchObject({ credits_charged: 1, balance: 0 });
    const res = await get("/v1/prints/us_unemployment_rate/2026-09", k);
    expect(res.status).toBe(200);
    expect((await body(res)).data).toMatchObject({ credits_charged: 0, balance: 0, replayed: true });
    expect((await get("/v1/prints/us_unemployment_rate/2026-09")).status).toBe(402);
  });

  it("billing unreachable or a malformed charge answer is a 503: nothing served, nothing charged", async () => {
    h.db = fakeDb({ tenants: [{ id: "t1", credits_balance: 300 }], official_observations: [PRINT] }, {}, { rpc: { charge_read: async () => ({ data: null, error: { code: "08006", message: "connection refused" } }) } });
    let res = await get("/v1/prints/us_unemployment_rate/2026-09");
    expect(res.status).toBe(503);
    let b = await body(res);
    expect(b).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE" }, error_reason: "BILLING_UNAVAILABLE" });
    expect(JSON.stringify(b)).not.toContain(PRINT.deciding_text);
    h.db = fakeDb({ tenants: [{ id: "t1", credits_balance: 300 }], official_observations: [PRINT] }, {}, { rpc: { charge_read: async () => ({ data: [{ ok: true }], error: null }) } });
    res = await get("/v1/prints/us_unemployment_rate/2026-09");
    expect(res.status).toBe(503);
    b = await body(res);
    expect(JSON.stringify(b)).not.toContain(PRINT.deciding_text);
    expect(vi.mocked(noteCharge)).not.toHaveBeenCalled();
  });

  it("the store unreadable is a 503 before any charge", async () => {
    h.db = newDb();
    h.failFrom = "official_observations";
    expect((await get("/v1/prints/us_unemployment_rate/2026-09")).status).toBe(503);
    expect(chargeCalls()).toHaveLength(0);
  });

  it("HEAD (curl -I, an uptime monitor) is refused with 405 before anything is read or charged: its answer would carry no print", async () => {
    h.db = newDb();
    for (const headers of [{}, { "idempotency-key": "head-1" }] as Array<Record<string, string>>) {
      const res = await app.request("/v1/prints/us_unemployment_rate/2026-09", { method: "HEAD", headers: { authorization: `Bearer rsl_test_${"a".repeat(32)}`, ...headers } }, env, ctx);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      expect(await res.text()).toBe("");
    }
    expect(chargeCalls()).toHaveLength(0);
    expect(charges()).toHaveLength(0);
    expect(h.db.tables.tenants![0]!.credits_balance).toBe(300);
    expect(h.selects.filter(([t]) => t === "official_observations")).toHaveLength(0);
    expect(vi.mocked(noteCharge)).not.toHaveBeenCalled();
    // the free list answers HEAD as any GET route does; GET of the print still serves and charges
    expect((await app.request("/v1/prints", { method: "HEAD", headers: { authorization: `Bearer rsl_test_${"a".repeat(32)}` } }, env, ctx)).status).toBe(200);
    expect((await get("/v1/prints/us_unemployment_rate/2026-09")).status).toBe(200);
    expect(charges()).toHaveLength(1);
  });

  it("a stored row observed before its scheduled release is not a first print: scheduled until the release, then 404; never charged or listed", async () => {
    const early = { ...PRINT, observed_at: "2026-10-02T11:00:00+00:00" };
    h.db = newDb({ prints: [early] });
    vi.setSystemTime(RELEASE - 3600_000);
    let res = await get("/v1/prints/us_unemployment_rate/2026-09");
    expect(res.status).toBe(200);
    let b = await body(res);
    expect(b.data).toMatchObject({ status: "scheduled", release_at: EMPSIT.release_at, credits_charged: 0, balance: 300 });
    expect(JSON.stringify(b)).not.toContain(PRINT.deciding_text);
    vi.setSystemTime(RELEASE + 60_000);
    res = await get("/v1/prints/us_unemployment_rate/2026-09");
    expect(res.status).toBe(404);
    b = await body(res);
    expect(b.error!.message).toBe(`the stored observation of us_unemployment_rate 2026-09 (2026-10-02T11:00:00.000Z) predates its scheduled release ${EMPSIT.release_at}, so it is not served as the first print. Nothing was charged.`);
    expect(JSON.stringify(b)).not.toContain(PRINT.deciding_text);
    expect(chargeCalls()).toHaveLength(0);
    expect(charges()).toHaveLength(0);
    const list = await body(await get("/v1/prints"));
    expect(list.data.series.find((x: { series: string }) => x.series === "us_unemployment_rate").latest).toBeNull();
    // observed at the release itself, it is the first print; a period the registry does not schedule has no release time to hold it to
    expect(observedBeforeRelease({ series: "us_unemployment_rate", period: "2026-09", observed_at: EMPSIT.release_at })).toBe(false);
    expect(observedBeforeRelease({ series: "us_unemployment_rate", period: "2031-01", observed_at: "2000-01-01T00:00:00Z" })).toBe(false);
  });
});

describe("a release not recorded yet: scheduled, 0 credits; unknown: 404, 0 credits", () => {
  it("before the release: status scheduled with release_at and the balance, no charge call", async () => {
    vi.setSystemTime(RELEASE - 60_000);
    h.db = newDb({ prints: [] });
    const res = await get("/v1/prints/us_unemployment_rate/2026-09");
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.data).toMatchObject({ series: "us_unemployment_rate", period: "2026-09", status: "scheduled", release_at: EMPSIT.release_at, credits_charged: 0, balance: 300 });
    expect(b.data.note).toContain("Not released yet");
    expect(chargeCalls()).toHaveLength(0);
    expect(charges()).toHaveLength(0);
  });

  it("after the release, while the rail has not recorded it: still scheduled for as long as the rail waits (6 h), then 404", async () => {
    h.db = newDb({ prints: [] });
    vi.setSystemTime(RELEASE + 60_000);
    let b = await body(await get("/v1/prints/us_unemployment_rate/2026-09"));
    expect(b.data).toMatchObject({ status: "scheduled", release_at: EMPSIT.release_at, credits_charged: 0 });
    expect(b.data.note).toContain("has not recorded the first print yet");
    vi.setSystemTime(RELEASE + missingAfterMs("us_unemployment_rate"));
    const res = await get("/v1/prints/us_unemployment_rate/2026-09");
    expect(res.status).toBe(404);
    b = await body(res);
    expect(b.error!.message).toContain(`was scheduled for ${EMPSIT.release_at}`);
    expect(chargeCalls()).toHaveLength(0);
  });

  it("an unknown series, a period outside the series' format, or a period nobody scheduled: 404, nothing read or charged", async () => {
    h.db = newDb({ prints: [] });
    for (const [path, says] of [
      ["/v1/prints/boj_policy_rate/2026-10-30", "unknown series"],
      ["/v1/prints/__proto__/2026-09", "unknown series"],
      ["/v1/prints/us_unemployment_rate/2026-9", "its periods are YYYY-MM"],
      ["/v1/prints/fomc_upper_bound/2026-10", "its periods are YYYY-MM-DD"],
      ["/v1/prints/kr_gdp_advance_yoy/2026-09", "its periods are YYYY-Qn"],
    ] as const) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect((await body(res)).error!.message, path).toContain(says);
    }
    expect(h.selects.filter(([t]) => t === "official_observations")).toHaveLength(0);
    const res = await get("/v1/prints/us_unemployment_rate/2031-01");
    expect(res.status).toBe(404);
    expect((await body(res)).error!.message).toContain("no release of it is scheduled");
    expect(chargeCalls()).toHaveLength(0);
    expect(isSeries("constructor")).toBe(false);
  });

  it("pure: scheduledAnswer holds from before the release to missingAfterMs after it; elections wait 72 h", () => {
    const known = { release_at: "2026-10-04T20:00:00Z", fallback_until: null, basis: "t" };
    const at = Date.parse(known.release_at);
    expect(scheduledAnswer("br_pres_r1_first_ac", "2026-10-04", at + 71 * 3600_000, known)).toMatchObject({ status: "scheduled" });
    expect(scheduledAnswer("br_pres_r1_first_ac", "2026-10-04", at + 72 * 3600_000, known)).toBeNull();
    expect(scheduledAnswer("us_unemployment_rate", "2031-01", 0)).toBeNull();
  });
});

describe("the v1 key middleware applies: the per-key rate limit, and free keys may read", () => {
  it("a key over its per-key rate limit gets the 429 of every /v1 route: nothing read, nothing charged", async () => {
    h.db = newDb();
    h.limited = true;
    for (const p of ["/v1/prints", "/v1/prints/us_unemployment_rate/2026-09"]) {
      const res = await get(p);
      expect(res.status, p).toBe(429);
    }
    expect(h.rateCalls).toEqual([{ jev: false, jevRpmLimit: 1 }, { jev: false, jevRpmLimit: 1 }]);
    expect(h.selects.filter(([t]) => t === "official_observations")).toHaveLength(0);
    expect(chargeCalls()).toHaveLength(0);
  });

  it("every plan reads prints, the free test key included (structured data: no model)", async () => {
    for (const plan of ["free", "payg", "builder", "growth", "platform"]) {
      h.plan = plan;
      h.db = newDb();
      const res = await get("/v1/prints/us_unemployment_rate/2026-09");
      expect(res.status, plan).toBe(200);
    }
  });

  it("pure: shapePrint answers a corroboration it cannot read as null, and value as a number", () => {
    const row = { ...PRINT, corroboration: { status: "probably", detail: "x" } } as unknown as PrintRow;
    expect(shapePrint(row)).toMatchObject({ corroboration: null, value: 4.3 });
    expect(shapePrint({ ...row, corroboration: null } as PrintRow).corroboration).toBeNull();
    expect(PRINT_PRICE_CREDITS).toBe(1);
  });
});

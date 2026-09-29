/**
 * The official_release watch path with its I/O edges replaced: an in-memory stand-in for PostgREST and the two
 * migration-016 RPCs (same semantics: first print wins, one live fetch lease), a stubbed fetch serving the bodies
 * saved on 2026-09-24, an injected clock for the burst, the real resolver behind a mocked runtime, mocked alerts.
 * Pages marked SYNTHETIC are saved bodies with the month or a value edited, to stand for a release not yet made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, Config } from "../src/env";
import { officialFixture as fx } from "../evals/lib/official-fixtures";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state = {
    watch: {} as Row, evidence: [] as Row[], resolutions: [] as Row[], loopRuns: [] as Row[],
    obs: new Map<string, Row>(), slots: new Map<string, number>(), extends: [] as number[], hideObsFromSelect: false, nowMs: undefined as number | undefined, rpcCalls: [] as string[], seq: 0, obsReads: [] as string[],
    appConfig: new Map<string, string>(),
  };
  const now = () => state.nowMs ?? Date.now();
  class Q implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
    action: "select" | "insert" | "update" | "upsert" = "select";
    payload: Row | undefined;
    filters: Array<[string, unknown]> = [];
    constructor(private table: string) {}
    select() { return this; }
    insert(p: Row) { this.action = "insert"; this.payload = p; return this; }
    update(p: Row) { this.action = "update"; this.payload = p; return this; }
    upsert(p: Row) { this.action = "upsert"; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.filters.push([c, v]); return this; }
    in(c: string, v: unknown[]) { this.filters.push([c, v]); return this; }
    gte() { return this; }
    or() { return this; }
    order() { return this; }
    limit() { return this; }
    single() { return Promise.resolve(this.exec()); }
    maybeSingle() { return Promise.resolve(this.exec()); }
    then<A, B>(ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, no?: ((e: unknown) => B | PromiseLike<B>) | null) { return Promise.resolve(this.exec()).then(ok, no); }
    exec(): { data: unknown; error: unknown; count?: number } {
      const t = this.table;
      if (t === "watches" && this.action === "select") return { data: structuredClone(state.watch), error: null };
      if (t === "watches" && this.action === "update") { Object.assign(state.watch, structuredClone(this.payload)); return { data: null, error: null }; }
      if (t === "loop_runs") { state.loopRuns.push(this.payload!); return { data: null, error: null }; }
      if (t === "app_config" && this.action === "upsert") { state.appConfig.set(String(this.payload!.key), String(this.payload!.value)); return { data: null, error: null }; }
      if (t === "app_config" && this.action === "select") {
        const key = String(Object.fromEntries(this.filters).key);
        return { data: state.appConfig.has(key) ? { value: state.appConfig.get(key) } : null, error: null };
      }
      if (t === "official_observations") {
        const f = Object.fromEntries(this.filters) as { series: string | string[]; period: string };
        state.obsReads.push(Array.isArray(f.series) ? f.series.join(",") : f.series);
        if (Array.isArray(f.series)) return { data: state.hideObsFromSelect ? [] : f.series.filter((s) => state.obs.has(`${s}|${f.period}`)).map((s) => ({ series: s })), error: null };
        return { data: state.hideObsFromSelect ? null : (state.obs.get(`${f.series}|${f.period}`) ?? null), error: null };
      }
      if (t === "evidence" && this.action === "insert") {
        const p = this.payload!;
        if (state.evidence.some((e) => e.market_id === p.market_id && e.raw_sha256 === p.raw_sha256)) return { data: null, error: { code: "23505", message: "duplicate key" } };
        const row = { id: `ev${++state.seq}`, ...p };
        state.evidence.push(row);
        return { data: { id: row.id }, error: null };
      }
      if (t === "evidence") return { data: null, error: null };
      throw new Error(`fake client: unexpected ${this.action} on ${t}`);
    }
  }
  const rpc = async (_c: unknown, fn: string, a: Row): Promise<unknown> => {
    state.rpcCalls.push(fn);
    const k = `${a.p_series}|${a.p_period}`;
    if (fn === "claim_official_fetch") {
      const until = state.slots.get(k);
      if (until !== undefined && until > now()) return false;
      state.slots.set(k, now() + Number(a.p_seconds) * 1000);
      return true;
    }
    if (fn === "extend_official_fetch") {
      state.extends.push(Number(a.p_seconds));
      const until = Math.max(state.slots.get(k) ?? 0, now() + Number(a.p_seconds) * 1000);
      state.slots.set(k, until);
      return new Date(until).toISOString();
    }
    if (fn === "record_official_observation") {
      const existing = state.obs.get(k);
      if (existing) return { ...existing, inserted: false, revision_differs: Number(existing.value) !== Number(a.p_value) };
      const row = { series: a.p_series, period: a.p_period, value: a.p_value, value_text: a.p_value_text, deciding_text: a.p_deciding_text, source_url: a.p_source_url, raw_sha256: a.p_raw_sha256, observed_at: new Date(now()).toISOString(), corroboration: a.p_corroboration, meta: a.p_meta };
      state.obs.set(k, row);
      return { ...row, inserted: true, revision_differs: false };
    }
    throw new Error(`rpc ${fn} not expected`);
  };
  return { state, rpc, client: { from: (t: string) => new Q(t) } };
});

vi.mock("../src/db/supabase", () => ({ db: () => h.client, rpc: h.rpc }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));
vi.mock("../src/bot/commit", () => ({ commitVerdict: vi.fn(async () => ({ committed: true, posted: false, reason: "recorded without channel" })) }));
vi.mock("../src/webhooks/deliver", () => ({ enqueueEvent: vi.fn() }));
vi.mock("../src/resolve/runtime", async () => {
  const real = await vi.importActual<typeof import("../src/resolve")>("../src/resolve");
  const th = await vi.importActual<typeof import("../src/resolve/thresholds")>("../src/resolve/thresholds");
  return {
    JevUnavailableError: class extends Error {},
    resolveWithRuntime: vi.fn(async (_e: unknown, _c: unknown, o: { marketId: string; market: never; evidence: never; evidenceId: string | null }) => {
      const result = await real.resolveMarket({ marketId: o.marketId, market: o.market, evidence: o.evidence, thresholds: th.DEFAULT_THRESHOLDS, spotlightSecret: "t", model: "jev-1.13.0" }, { jev: async () => { throw new Error("Jev must never be called for official_release"); } });
      const id = `res${h.state.resolutions.length + 1}`;
      h.state.resolutions.push({ id, market_id: o.marketId, evidence_id: o.evidenceId, status_row: "complete", verdict: result.verdict });
      return { resolutionId: id, jevCalls: 0, jevCostUsd: 0, result };
    }),
  };
});

import { runWatch } from "../src/ingest/watch";
import { fetchOfficial, officialIdleNextPoll, inReleaseMinute, BURST_MAX_REQUESTS, BURST_WINDOW_MS } from "../src/ingest/official-watch";
import { fetchPrimary, officialGet, budget, OFFICIAL_UA, __resetElectionMemo } from "../src/ingest/official";
import { buildElectionLeg, eqRegistryFromSnapshot, type ElectionEventInput } from "../src/markets/election-legs";
import { parseEqResults } from "../src/ingest/election-parse";
import { eqAs2026, eqText, type EqBody } from "../evals/lib/eq-synthetic";
import { TSE_CONFIG_URL, EQ_RESULTS_URL } from "../src/resolve/official";
import { alert } from "../src/ops/alerts";
import type { MarketRow, WatchRow } from "../src/ingest/types";
import { buildLegRegistration } from "../src/markets/official-legs";
import { decideOfficial } from "../src/resolve/official";

const WATCH_ID = "33333333-3333-4333-8333-333333333333";
const MARKET_ID = "44444444-4444-4444-8444-444444444444";
const MIN = 60_000;

type Group = Parameters<typeof buildLegRegistration>[0]["group"];
function market(group: Group, label: string, deadline = "2026-10-15T03:59:00Z", open_at = "2026-09-15T00:00:00Z"): MarketRow {
  const r = buildLegRegistration({ platform: "limitless", external_id: `leg-${label}`, group, label, open_at, deadline_utc: deadline, criteria: "test" });
  if (!r.ok) throw new Error(r.reason);
  return { ...r.market, id: MARKET_ID, tenant_id: null, status: "open", official_outcome: null, official_resolved_at: null, official_source_url: null };
}
const cpiGroup = (release_at: string): Group => ({ series: "us_cpi_u_nsa_yoy", period: "2026-09", release_at, title: "September Inflation US - Annual" });
function setWatch(m: MarketRow) {
  const r = m.resolver as { series: string; period: string };
  h.state.watch = {
    id: WATCH_ID, market_id: MARKET_ID, source_kind: "official_release", source_ref: { ref: `official:${r.series}:${r.period}`, series: r.series, period: r.period }, poll_interval_s: 60,
    next_poll_at: new Date(Date.now() + MIN).toISOString(), etag: null, cursor: {}, coverage: [], last_evidence_hash: null, last_canonical_hash: null, last_http_status: null,
    consecutive_errors: 0, backlog: false, active: true, markets: m,
  };
}
const watchRow = () => h.state.watch as unknown as WatchRow;

// Upstream: the saved August CPI page, a SYNTHETIC September page (the August body with its header month edited),
// and the saved BLS API body (it has no 2026-M09 index, so corroboration is unavailable).
const CPI_AUG = fx("bls_cpi_nr0.html");
const CPI_SEP = CPI_AUG.replace("CONSUMER PRICE INDEX - AUGUST 2026", "CONSUMER PRICE INDEX - SEPTEMBER 2026");
let calls: Array<{ url: string; ua: string | null }> = [];
function serve(router: (url: string, n: number) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, ua: (init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? null });
    return router(url, calls.filter((c) => c.url === url).length);
  });
}
const ok = (body: string, type = "text/html") => new Response(body, { status: 200, headers: { "content-type": type } });
const cpiRouter = (sepFromAttempt: number) => (url: string, n: number) => {
  if (url === "https://www.bls.gov/news.release/cpi.nr0.htm") return ok(n >= sepFromAttempt ? CPI_SEP : CPI_AUG);
  if (url === "https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0") return ok(fx("bls_v1_cpi.json"), "application/json");
  return new Response("not found", { status: 404 });
};

let put: ReturnType<typeof vi.fn>;
const env = () => ({ RAW: { put } }) as unknown as Env;
const cfg = { botUa: "ResolveBot/test" } as Config;
const alertKeys = () => vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes]);
/** A clock the burst's sleeps advance, so 25 s of polling runs instantly. */
function clock(startIso: string) {
  let t = Date.parse(startIso);
  const sleeps: number[] = [];
  h.state.nowMs = t;
  return { deps: { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; h.state.nowMs = t; } }, sleeps, now: () => t };
}

beforeEach(() => {
  Object.assign(h.state, { evidence: [], resolutions: [], loopRuns: [], obs: new Map(), slots: new Map(), extends: [], hideObsFromSelect: false, nowMs: undefined, rpcCalls: [], seq: 0, obsReads: [], appConfig: new Map() });
  __resetElectionMemo();
  put = vi.fn(async () => ({}));
  vi.mocked(alert).mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("schedule", () => {
  it("polls at the release minute, then every minute for 10 minutes, every 5 to 6 h, then every 15; observed legs every 6 h", () => {
    const rel = Date.parse("2026-10-14T12:30:00Z");
    const s = { releaseAtMs: rel, fallbackEndMs: Date.parse("2026-11-10T13:30:00Z") };
    expect(officialIdleNextPoll(rel - 3 * 3600_000, s, "before")).toBe("2026-10-14T12:30:00.000Z");
    expect(officialIdleNextPoll(rel + 5_000, s, "awaiting")).toBe("2026-10-14T12:31:00.000Z");
    expect(officialIdleNextPoll(rel + 11 * MIN + 5_000, s, "awaiting")).toBe("2026-10-14T12:46:00.000Z");
    expect(officialIdleNextPoll(rel + 7 * 3600_000, s, "awaiting")).toBe("2026-10-14T19:45:00.000Z");
    expect(officialIdleNextPoll(rel + 5_000, s, "observed")).toBe("2026-10-14T18:30:05.000Z");
    // (10) after the market's fallback window (the next CPI release, Nov 10) the watch drops to daily polls
    expect(officialIdleNextPoll(Date.parse("2026-11-10T14:00:10Z"), s, "missing")).toBe("2026-11-11T14:00:00.000Z");
    expect(officialIdleNextPoll(Date.parse("2026-11-10T14:00:10Z"), s, "awaiting")).toBe("2026-11-11T14:00:00.000Z");
    expect([inReleaseMinute(rel, rel), inReleaseMinute(rel + 59_999, rel), inReleaseMinute(rel + MIN, rel), inReleaseMinute(rel - 1, rel)]).toEqual([true, true, false, false]);
  });
});

describe("fetchOfficial", () => {
  it("(a) before release_at: no upstream request and no database call; next poll at the release minute", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    const c = clock("2026-10-14T09:00:00Z");
    serve(cpiRouter(1));
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(out).toMatchObject({ notModified: true, nextPollAt: "2026-10-14T12:30:00.000Z" });
    expect(out.note).toMatch(/^awaiting_release/);
    expect(calls).toHaveLength(0);
    expect(h.state.rpcCalls).toHaveLength(0);
  });

  it("(c) the release-minute burst polls every 3 s and stops at the first observation", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    const c = clock("2026-10-14T12:29:57Z"); // dispatched 3 s early: waits for release_at, never fetches before it
    serve(cpiRouter(3));
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(c.sleeps).toEqual([3000, 3000, 3000]);
    expect(calls.map((x) => x.url)).toEqual([
      "https://www.bls.gov/news.release/cpi.nr0.htm", "https://www.bls.gov/news.release/cpi.nr0.htm", "https://www.bls.gov/news.release/cpi.nr0.htm",
      "https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0",
    ]);
    expect(calls.every((x) => x.ua === OFFICIAL_UA)).toBe(true);
    const doc = out.evidence!.structured as Record<string, unknown>;
    expect(doc).toMatchObject({ kind: "official_observation", series: "us_cpi_u_nsa_yoy", period: "2026-09", value_text: "3.4", observed_at: "2026-10-14T12:30:06.000Z" });
    expect((doc.corroboration as Row).status).toBe("unavailable"); // the saved API body has no 2026-M09 yet: not a disagreement
    expect(put).toHaveBeenCalledWith(`raw/${doc.raw_sha256 as string}`, expect.any(Uint8Array), expect.anything());
    expect(h.state.obs.get("us_cpi_u_nsa_yoy|2026-09")).toBeDefined();
  });

  it("(c) a burst that never sees the target stops at 10 requests inside 25 s and records nothing", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    const c = clock("2026-10-14T12:30:00.200Z");
    serve(cpiRouter(99));
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(out).toMatchObject({ notModified: true, nextPollAt: "2026-10-14T12:31:00.000Z" });
    expect(out.note).toContain("document is about 2026-08");
    expect(calls.length).toBeLessThanOrEqual(BURST_MAX_REQUESTS);
    expect(c.now() - Date.parse("2026-10-14T12:30:00.200Z")).toBeLessThanOrEqual(BURST_WINDOW_MS);
    expect(h.state.obs.size).toBe(0);
  });

  it("(b) only the fetch-slot holder requests the source; the others wait for the stored first print", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.3%");
    setWatch(m);
    const c = clock("2026-10-14T12:30:01Z");
    h.state.slots.set("bls_cpi_release|2026-09", c.now() + 30_000); // the CPI release's one slot, shared by its four series
    serve(cpiRouter(1));
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(out).toMatchObject({ notModified: true, note: "awaiting_observation: another leg of this event holds the fetch lease", nextPollAt: "2026-10-14T12:31:00.000Z" });
    expect(calls).toHaveLength(0);
  });

  it("(b) a stored first print is read, never refetched", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.3%");
    setWatch(m);
    h.state.obs.set("us_cpi_u_nsa_yoy|2026-09", { series: "us_cpi_u_nsa_yoy", period: "2026-09", value: 3.4, value_text: "3.4", deciding_text: "CONSUMER PRICE INDEX - SEPTEMBER 2026: Over the last 12 months, the all items index increased 3.4 percent before seasonal adjustment.", source_url: "https://www.bls.gov/news.release/cpi.nr0.htm", raw_sha256: "b".repeat(64), observed_at: "2026-10-14T12:30:04.123456+00:00", corroboration: null, meta: {} });
    const c = clock("2026-10-14T12:31:00Z");
    serve(cpiRouter(1));
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(calls).toHaveLength(0);
    expect(h.state.rpcCalls).toHaveLength(0);
    expect(out.evidence!.structured).toMatchObject({ value_text: "3.4", observed_at: "2026-10-14T12:30:04.123Z" });
    expect(out.nextPollAt).toBe("2026-10-14T18:31:00.000Z");
  });

  it("a revision offered after the first print is alerted and ignored (first print wins)", async () => {
    const m = market({ series: "us_ppi_fd_nsa_yoy", period: "2026-08", release_at: "2026-09-10T12:30:00Z", title: "PPI" }, "5.4%");
    setWatch(m);
    // the first print is stored, but this leg's read raced it (null), so it fetched a later page offering 5.6
    h.state.obs.set("us_ppi_fd_nsa_yoy|2026-08", { series: "us_ppi_fd_nsa_yoy", period: "2026-08", value: 5.4, value_text: "5.4", deciding_text: "PRODUCER PRICE INDEXES - AUGUST 2026: On an unadjusted basis, the index for final demand increased 5.4 percent for the 12 months ended in August.", source_url: "https://www.bls.gov/news.release/ppi.nr0.htm", raw_sha256: "c".repeat(64), observed_at: "2026-09-10T12:30:02.000Z", corroboration: null, meta: {} });
    h.state.hideObsFromSelect = true;
    const revised = fx("bls_ppi_nr0.html").replace("demand increased 5.4 percent for the 12 months", "demand increased 5.6 percent for the 12 months"); // SYNTHETIC revision
    const c = clock("2026-09-10T13:00:00Z");
    serve((url) => url.includes("ppi.nr0") ? ok(revised) : ok(fx("bls_v1_ppi.json"), "application/json"));
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(out.evidence!.structured).toMatchObject({ value_text: "5.4" });
    expect(alertKeys()).toContainEqual(["official_revision_us_ppi_fd_nsa_yoy_2026-08", 1440]);
  });

  it("a disagreeing corroboration is recorded, alerted, and holds the leg (sources_disagree)", async () => {
    const m = market({ series: "fomc_upper_bound", period: "2026-09-16", release_at: "2026-09-16T18:00:00Z", prior_level: 3.75, title: "Fed Decision in September?" }, "25 bps increase");
    setWatch(m);
    const fredDisagree = fx("fred_dfedtaru.csv").replace("2026-09-17,4.00", "2026-09-17,3.75"); // SYNTHETIC disagreement
    serve((url) => url.includes("press_monetary.xml") ? ok(fx("fed_press_monetary.xml"), "text/xml") : url.includes("monetary20260916a.htm") ? ok(fx("fed_monetary20260916a.html")) : url.includes("fred.stlouisfed.org") ? ok(fredDisagree, "text/csv") : new Response("", { status: 404 }));
    const c = clock("2026-09-16T18:05:00Z");
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(out.evidence!.structured).toMatchObject({ value_text: "3-3/4 to 4", corroboration: { status: "disagree", value_text: "3.75" } });
    expect(alertKeys()).toContainEqual(["official_disagree_fomc_upper_bound_2026-09-16", 1440]);
  });

  it("(d) not observed by release_at + 6 h: one release_not_observed document per leg and an alert", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    const c = clock("2026-10-14T18:31:00Z");
    serve(cpiRouter(99)); // a shutdown: the page still names August
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(out.evidence!.structured).toMatchObject({ kind: "official_missing", series: "us_cpi_u_nsa_yoy", period: "2026-09" });
    expect(out.nextPollAt).toBe("2026-10-14T18:46:00.000Z");
    expect(alertKeys()).toContainEqual(["official_missing_us_cpi_u_nsa_yoy_2026-09", 720]);
    expect(h.state.obs.size).toBe(0); // never an older period
  });

  it("non-200 is never evidence: 403 with Retry-After is a typed error, alerted per series", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    serve(() => new Response("<html>Access Denied</html>", { status: 403, headers: { "retry-after": "120" } }));
    const c = clock("2026-10-14T12:45:00Z");
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(out.evidence).toBeUndefined();
    expect(out).toMatchObject({ deferSeconds: 120 });
    expect(out.error).toContain("HTTP 403");
    expect(alertKeys()).toContainEqual(["official_upstream_us_cpi_u_nsa_yoy_2026-09", 60]);
  });

  it("a retryable 503 alerts per series outside the burst (the fetch lease rotates, so no leg builds a streak)", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    serve(() => new Response("upstream busy", { status: 503 }));
    const out = await fetchOfficial(env(), watchRow(), m, clock("2026-10-14T12:40:00Z").deps);
    expect(out).toMatchObject({ httpStatus: 503 });
    expect(out.evidence).toBeUndefined();
    expect(alertKeys()).toContainEqual(["official_upstream_us_cpi_u_nsa_yoy_2026-09", 60]);
  });

  it("inside the burst a 503 is retried every 3 s and only the observation that follows counts", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    serve((url, n) => url.includes("cpi.nr0") ? (n < 3 ? new Response("busy", { status: 503 }) : ok(CPI_SEP)) : ok(fx("bls_v1_cpi.json"), "application/json"));
    const c = clock("2026-10-14T12:30:00.500Z");
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(c.sleeps).toEqual([3000, 3000]);
    expect(out.evidence!.structured).toMatchObject({ period: "2026-09", value_text: "3.4" });
    expect(alertKeys()).toEqual([]);
  });

  it("(8) a Retry-After extends the event's fetch lease, so every leg of the ladder backs off", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    serve(() => new Response("slow down", { status: 429, headers: { "retry-after": "600" } }));
    const c = clock("2026-10-14T12:45:00Z");
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(out).toMatchObject({ deferSeconds: 600 });
    expect(h.state.extends).toEqual([600]);
    // another leg polling a minute later cannot claim the slot: no upstream request
    calls = [];
    h.state.nowMs = c.now() + 60_000;
    const other = await fetchOfficial(env(), watchRow(), m, { now: () => c.now() + 60_000, sleep: c.deps.sleep });
    expect(other.note).toBe("awaiting_observation: another leg of this event holds the fetch lease");
    expect(calls).toHaveLength(0);
  });

  it("(9) with an ExecutionContext every holder capture runs in waitUntil, also outside the release minute", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      await gate; // the upstream is slow: the poll must not wait for it
      return url.includes("cpi.nr0") ? ok(CPI_SEP) : ok(fx("bls_v1_cpi.json"), "application/json");
    });
    const pending: Array<Promise<unknown>> = [];
    const c = clock("2026-10-14T12:45:00Z");
    const out = await fetchOfficial(env(), watchRow(), m, { ...c.deps, waitUntil: (p) => pending.push(p) });
    expect(out).toMatchObject({ notModified: true, nextPollAt: "2026-10-14T12:46:00.000Z" });
    expect(out.note).toMatch(/^the capture continues in waitUntil/);
    expect(pending).toHaveLength(1);
    expect(h.state.obs.size).toBe(0);
    release();
    await Promise.all(pending);
    expect(h.state.obs.get("us_cpi_u_nsa_yoy|2026-09")).toMatchObject({ value_text: "3.4" });
  });

  it("(9) without one, a capture outside the release minute is capped at 12 s including corroboration", async () => {
    const m = market({ series: "fomc_upper_bound", period: "2026-09-16", release_at: "2026-09-16T18:00:00Z", prior_level: 3.75, title: "Fed" }, "25 bps increase");
    setWatch(m);
    const c = clock("2026-09-16T18:20:00Z");
    const started: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      started.push(c.now());
      await c.deps.sleep(7000); // every upstream answer takes 7 s (the fake clock; a real one would abort at the deadline)
      return url.includes("press_monetary") ? ok(fx("fed_press_monetary.xml"), "text/xml") : url.includes("monetary20260916a") ? ok(fx("fed_monetary20260916a.html")) : ok(fx("fred_dfedtaru.csv"), "text/csv");
    });
    const t0 = c.now();
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(out.evidence).toBeDefined();
    // feed at 0 s, statement at 7 s; the corroboration would start at 14 s, past the 12 s cap, so it is never requested
    expect(started.map((t) => t - t0)).toEqual([0, 7000]);
    const obs = [...h.state.obs.values()][0]!;
    expect(obs.corroboration).toMatchObject({ status: "unavailable" });
    expect(String((obs.corroboration as { detail: string }).detail)).toContain("time budget exhausted");
  });

  it("(10) never observed: after the fallback window and a week of daily polls the watch stops, with one alert", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    serve(cpiRouter(99));
    const out = await fetchOfficial(env(), watchRow(), m, clock("2026-11-17T14:00:00Z").deps);
    expect(out.stop).toMatch(/never observed/);
    expect(out.evidence!.structured).toMatchObject({ kind: "official_missing" });
    expect(alertKeys()).toContainEqual(["official_stopped_us_cpi_u_nsa_yoy_2026-09", 14_400]);
    const daily = await fetchOfficial(env(), watchRow(), m, clock("2026-11-12T09:00:00Z").deps);
    expect(daily.stop).toBeUndefined();
    expect(daily.nextPollAt).toBe("2026-11-13T09:00:00.000Z");
  });

  it("(2) a document that contradicts the registered prior_level is alerted", async () => {
    const bok = market({ series: "bok_base_rate", period: "2026-10-22", release_at: "2026-10-22T01:00:00Z", prior_level: 3.0, title: "BoK" }, "50+ bps cut", "2026-10-22T00:00:00Z");
    setWatch(bok);
    h.state.obs.set("bok_base_rate|2026-10-22", { series: "bok_base_rate", period: "2026-10-22", value: 2.25, value_text: "2.25", deciding_text: "(October 22, 2026) The Monetary Policy Board of the Bank of Korea decided today to lower the Base Rate by 25 basis points from 2.50% to 2.25%", source_url: "https://www.bok.or.kr/eng/bbs/E0000627/news.rss?menuNo=400022", raw_sha256: "9".repeat(64), observed_at: "2026-10-22T01:30:05+00:00", corroboration: null, meta: { direction: "down", stated_prior: "2.50", stated_step_bps: 25 } });
    const out = await fetchOfficial(env(), watchRow(), bok, clock("2026-10-22T01:31:00Z").deps);
    expect(out.evidence).toBeDefined();
    expect(alertKeys()).toContainEqual(["official_prior_mismatch_bok_base_rate_2026-10-22", 1440]);
  });

  it("schema drift (a 200 that no longer parses) is an error and a schema alert, never an observation", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    serve(() => ok("<html><body>We are redesigning bls.gov</body></html>"));
    const out = await fetchOfficial(env(), watchRow(), m, clock("2026-10-14T12:45:00Z").deps);
    expect(out.error).toContain("schema drift");
    expect(alertKeys()).toContainEqual(["official_schema_us_cpi_u_nsa_yoy", 360]);
  });
});

describe("host allowlist", () => {
  it("refuses a host outside the series' allowlist without requesting it", async () => {
    serve(() => ok("x"));
    const g = await officialGet("us_cpi_u_nsa_yoy", "https://cpi-mirror.example/cpi.htm", budget(() => Date.now(), 8000, 1), "text/html");
    expect(g).toMatchObject({ ok: false, retryable: false });
    expect(calls).toHaveLength(0);
    expect((await officialGet("us_cpi_u_nsa_yoy", "http://www.bls.gov/news.release/cpi.nr0.htm", budget(() => Date.now(), 8000, 1), "text/html")).ok).toBe(false); // https only
  });
  const moved = (location: string, status = 302) => new Response(null, { status, headers: { location } });
  it("(7) a redirect off the allowlist is refused before it is requested (redirect: manual)", async () => {
    serve((url) => (url.startsWith("https://www.bls.gov/") ? moved("https://parked.example/cpi") : ok(CPI_SEP)));
    const res = await fetchPrimary("us_cpi_u_nsa_yoy", "2026-09", budget(() => Date.now(), 8000, 4));
    expect(res).toMatchObject({ kind: "error", retryable: false });
    expect((res as { error: string }).error).toContain("redirected off the us_cpi_u_nsa_yoy allowlist");
    expect(calls.map((c) => c.url)).toEqual(["https://www.bls.gov/news.release/cpi.nr0.htm"]);
  });
  it("(7) an https downgrade is refused; an allowlisted https hop is followed and counted", async () => {
    serve((url) => (url === "https://www.bls.gov/news.release/cpi.nr0.htm" ? moved("http://www.bls.gov/news.release/cpi.nr0.htm", 301) : ok(CPI_SEP)));
    expect((await fetchPrimary("us_cpi_u_nsa_yoy", "2026-09", budget(() => Date.now(), 8000, 4))).kind).toBe("error");
    expect(calls).toHaveLength(1);
    serve((url) => (url === "https://www.bls.gov/news.release/cpi.nr0.htm" ? moved("/news.release/cpi.nr0.htm?x=1") : ok(CPI_SEP)));
    const b = budget(() => Date.now(), 8000, 4);
    const res = await fetchPrimary("us_cpi_u_nsa_yoy", "2026-09", b);
    expect(res).toMatchObject({ kind: "observed", obs: { source_url: "https://www.bls.gov/news.release/cpi.nr0.htm?x=1", period: "2026-09" } });
    expect(b.used).toBe(2);
  });
  it("(7) at most 3 redirect hops", async () => {
    serve((url, n) => moved(`https://www.bls.gov/hop${calls.length}`));
    const res = await fetchPrimary("us_cpi_u_nsa_yoy", "2026-09", budget(() => Date.now(), 8000, 10));
    expect((res as { error: string }).error).toContain("more than 3 redirects");
    expect(calls).toHaveLength(4);
  });
});

describe("runWatch with an official_release source", () => {
  // Only Date is faked: the dispatch minute is fixed, so "inside the release minute" never straddles a boundary.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-14T12:30:05Z") }); });
  afterEach(() => { vi.useRealTimers(); });

  it("before release: a no_op that schedules the release minute and fetches nothing", async () => {
    const release = "2026-11-10T13:30:00.000Z"; // the October CPI: not in the registry, so the market's own release_at
    const m = market({ series: "us_cpi_u_nsa_yoy", period: "2026-10", release_at: release, title: "CPI Oct" }, "3.4%", "2026-11-11T03:59:00Z");
    setWatch(m);
    serve(cpiRouter(1));
    const s = await runWatch(env(), cfg, WATCH_ID);
    expect(s).toMatchObject({ outcome: "no_op" });
    expect(s.detail).toMatch(/^awaiting_release/);
    expect(h.state.watch.next_poll_at).toBe(release);
    expect(calls).toHaveLength(0);
  });

  it("a stored first print resolves the leg once (structured, never Jev); the next poll is a no_op six hours out", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%", "2026-10-14T11:00:00Z"); // deadline + grace passed at 12:00: no post-deadline duplicate
    setWatch(m);
    h.state.obs.set("us_cpi_u_nsa_yoy|2026-09", { series: "us_cpi_u_nsa_yoy", period: "2026-09", value: 3.4, value_text: "3.4", deciding_text: "CONSUMER PRICE INDEX - SEPTEMBER 2026: Over the last 12 months, the all items index increased 3.4 percent before seasonal adjustment.", source_url: "https://www.bls.gov/news.release/cpi.nr0.htm", raw_sha256: "d".repeat(64), observed_at: "2026-10-14T12:30:03+00:00", corroboration: { status: "agree", source_url: "https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0", value: 3.4, value_text: "3.4", detail: "t", checked_at: "2026-10-14T12:30:04Z" }, meta: { direction: null } });
    serve(cpiRouter(1));
    const s1 = await runWatch(env(), cfg, WATCH_ID);
    expect(s1.outcome).toBe("success");
    expect(h.state.resolutions).toHaveLength(1);
    expect(h.state.resolutions[0]!.verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A", determination_basis: "structured", caveats: ["first_print"] });
    expect(h.state.evidence[0]).toMatchObject({ source_kind: "official_release", observed_at: "2026-10-14T12:30:03.000Z" });
    const s2 = await runWatch(env(), cfg, WATCH_ID);
    expect(s2.outcome).toBe("no_op");
    expect(h.state.resolutions).toHaveLength(1);
    expect(Date.parse(String(h.state.watch.next_poll_at)) - Date.now()).toBeGreaterThan(5.9 * 3600_000);
    expect(calls).toHaveLength(0);
  });

  it("(3) an awaiting_release verdict never saves the change hash: the leg re-checks instead of freezing", async () => {
    // an event outside the registry, and a first print this very market captured before its own release_at
    const m = market({ series: "us_cpi_u_nsa_yoy", period: "2026-08", release_at: "2026-09-11T12:30:00Z", title: "CPI Aug" }, "3.4%", "2026-09-12T03:59:00Z", "2026-08-01T00:00:00Z");
    setWatch(m);
    h.state.obs.set("us_cpi_u_nsa_yoy|2026-08", { series: "us_cpi_u_nsa_yoy", period: "2026-08", value: 3.4, value_text: "3.4", deciding_text: "CONSUMER PRICE INDEX - AUGUST 2026: Over the last 12 months, the all items index increased 3.4 percent before seasonal adjustment.", source_url: "https://www.bls.gov/news.release/cpi.nr0.htm", raw_sha256: "7".repeat(64), observed_at: "2026-09-11T12:29:00+00:00", corroboration: null, meta: { captured_by_market: MARKET_ID } });
    const s1 = await runWatch(env(), cfg, WATCH_ID);
    expect(h.state.resolutions[0]!.verdict).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["awaiting_release"] });
    expect(s1.detail).toMatch(/awaiting_release: change .* kept pending/);
    expect(h.state.watch.last_canonical_hash).toBeNull();
    expect(Date.parse(String(h.state.watch.next_poll_at)) - Date.now()).toBe(900_000);
    const s2 = await runWatch(env(), cfg, WATCH_ID);
    expect(s2.outcome).toBe("success"); // re-resolved, not a no_op on a saved hash
    expect(h.state.resolutions).toHaveLength(2);
    // the same first print captured by ANOTHER market is the release itself: this leg resolves
    h.state.obs.get("us_cpi_u_nsa_yoy|2026-08")!.meta = { captured_by_market: "another-market" };
    await runWatch(env(), cfg, WATCH_ID);
    expect(h.state.resolutions[2]!.verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A" });
  });

  it("(10) a never-observed event: the marker resolves once, then the watch is deactivated (not polled forever)", async () => {
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z")); // CPI Sep fallback ended Nov 10 13:30Z; a week of daily polls since
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    serve(cpiRouter(99));
    const s1 = await runWatch(env(), cfg, WATCH_ID);
    expect(s1.outcome).toBe("success");
    expect(h.state.resolutions[0]!.verdict).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["release_not_observed"] });
    expect(h.state.watch.active).toBe(true);
    const s2 = await runWatch(env(), cfg, WATCH_ID);
    expect(s2.outcome).toBe("no_op");
    expect(s2.detail).toContain("watch stopped");
    expect(h.state.watch.active).toBe(false);
    expect(alertKeys().filter(([k]) => k === "official_stopped_us_cpi_u_nsa_yoy_2026-09")).toHaveLength(2); // deduped by alert() itself (14,400 min)
  });

  it("(6) an audited corroboration re-check changes the projection, so legs held at sources_disagree re-resolve", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%");
    setWatch(m);
    const row = { series: "us_cpi_u_nsa_yoy", period: "2026-09", value: 3.4, value_text: "3.4", deciding_text: "CONSUMER PRICE INDEX - SEPTEMBER 2026: Over the last 12 months, the all items index increased 3.4 percent before seasonal adjustment.", source_url: "https://www.bls.gov/news.release/cpi.nr0.htm", raw_sha256: "8".repeat(64), observed_at: "2026-10-14T12:30:03+00:00", meta: {},
      corroboration: { status: "disagree", source_url: "https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0", value: 3.5, value_text: "3.5", detail: "t", checked_at: "2026-10-14T12:30:04Z" } };
    h.state.obs.set("us_cpi_u_nsa_yoy|2026-09", row);
    await runWatch(env(), cfg, WATCH_ID);
    expect(h.state.resolutions[0]!.verdict).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["sources_disagree"] });
    expect((await runWatch(env(), cfg, WATCH_ID)).outcome).toBe("no_op");
    // what recheck_official_corroboration writes (the history row is the database's; the value is never touched)
    row.corroboration = { status: "agree", source_url: "https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0", value: 3.4, value_text: "3.4", detail: "BLS API re-read after its correction", checked_at: "2026-10-14T13:10:00Z" };
    expect((await runWatch(env(), cfg, WATCH_ID)).outcome).toBe("success");
    expect(h.state.resolutions[1]!.verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A" });
  });

  it("in the release minute with an ExecutionContext, the burst runs in waitUntil and the legs resolve from its first print", async () => {
    const m = market(cpiGroup("2026-10-14T12:30:00Z"), "3.4%"); // dispatched at 12:30:05, inside the release minute
    setWatch(m);
    serve(cpiRouter(1));
    const pending: Array<Promise<unknown>> = [];
    const s = await runWatch(env(), cfg, WATCH_ID, { waitUntil: (p) => pending.push(p) });
    expect(s.outcome).toBe("no_op");
    expect(s.detail).toMatch(/waitUntil/);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(h.state.obs.get("us_cpi_u_nsa_yoy|2026-09")).toMatchObject({ value_text: "3.4" });
    expect(h.state.resolutions).toHaveLength(0);
    const s2 = await runWatch(env(), cfg, WATCH_ID);
    expect(s2.outcome).toBe("success");
    expect(h.state.resolutions[0]!.verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A" });
  });
});

// ---- the BLS fetch groups: one page, several series (2026-09-27) --------------------------------------------------------

// SYNTHETIC September pages: the saved August releases with their month edited (header, Table A's last column, the
// summary sentences), standing for releases not yet made.
const CPI_SEP_FULL = CPI_AUG
  .replace("CONSUMER PRICE INDEX - AUGUST 2026", "CONSUMER PRICE INDEX - SEPTEMBER 2026")
  .replace('id="cpi_pressa.h.2.8">Aug.<br />2026', 'id="cpi_pressa.h.2.8">Sep.<br />2026')
  .replace("ended<br />Aug. 2026", "ended<br />Sep. 2026")
  .replace("seasonally adjusted basis in August", "seasonally adjusted basis in September");
const EMPSIT_AUG = fx("bls_empsit_nr0_excerpt.html");
const EMPSIT_SEP = EMPSIT_AUG.replace("THE EMPLOYMENT SITUATION - AUGUST 2026", "THE EMPLOYMENT SITUATION - SEPTEMBER 2026").split("in August").join("in September");
const API_BODY: Record<string, string> = {
  CUUR0000SA0: "bls_v1_cpi.json", CUSR0000SA0: "bls_v1_cpi_sa.json", CUSR0000SA0L1E: "bls_v1_core_sa.json", CUUR0000SA0L1E: "bls_v1_core_nsa.json",
  LNS14000000: "bls_v1_unrate.json", CES0000000001: "bls_v1_payrolls.json",
};
const blsRouter = (pages: Record<string, string>) => (url: string) => {
  for (const [part, body] of Object.entries(pages)) if (url === `https://www.bls.gov/news.release/${part}`) return ok(body);
  const id = /\/timeseries\/data\/([A-Z0-9]+)$/.exec(url)?.[1];
  if (id && API_BODY[id]) return ok(fx(API_BODY[id]), "application/json");
  return new Response("not found", { status: 404 });
};
const sepGroup = (series: Group["series"], title: string, release_at: string): Group => ({ series, period: "2026-09", release_at, title });
const CPI_REL = "2026-10-14T12:30:00Z", EMPSIT_REL = "2026-10-02T12:30:00Z";
const legOf = (series: Group["series"], label: string, release_at: string) => market(sepGroup(series, "t", release_at), label, "2026-10-15T03:59:00Z", "2026-09-04T00:00:00Z");
const payLeg = (label: string) => {
  const r = buildLegRegistration({ platform: "polymarket", external_id: `leg-${label}`, group: sepGroup("us_nonfarm_payrolls_change", "How many jobs added in September?", EMPSIT_REL), label, open_at: "2026-09-04T16:37:33Z", deadline_utc: "2026-10-03T03:59:00Z", criteria: "Ties go to the higher range bracket." });
  if (!r.ok) throw new Error(r.reason);
  return { ...r.market, id: MARKET_ID, tenant_id: null, status: "open", official_outcome: null, official_resolved_at: null, official_source_url: null } as MarketRow;
};

describe("BLS fetch groups: one fetch slot and one page fetch per release", () => {
  it("the CPI release minute: the holder fetches cpi.nr0.htm once and records all four series from it, each with its own corroboration", async () => {
    const m = legOf("us_cpi_u_nsa_yoy", "3.4%", CPI_REL);
    setWatch(m);
    const c = clock("2026-10-14T12:30:02Z");
    serve(blsRouter({ "cpi.nr0.htm": CPI_SEP_FULL }));
    const pending: Array<Promise<unknown>> = [];
    const out = await fetchOfficial(env(), watchRow(), m, { ...c.deps, waitUntil: (p) => pending.push(p) });
    expect(out.note).toMatch(/release minute: the capture burst continues in waitUntil/);
    await Promise.all(pending);
    expect(calls.filter((x) => x.url.endsWith("cpi.nr0.htm"))).toHaveLength(1);
    expect(calls.filter((x) => x.url.includes("api.bls.gov")).map((x) => x.url.split("/").pop()).sort()).toEqual(["CUSR0000SA0", "CUSR0000SA0L1E", "CUUR0000SA0", "CUUR0000SA0L1E"]);
    expect(h.state.slots.has("bls_cpi_release|2026-09")).toBe(true);
    expect([...h.state.slots.keys()]).toEqual(["bls_cpi_release|2026-09"]);
    const rows = Object.fromEntries([...h.state.obs.entries()].map(([k, r]) => [k, r.value_text]));
    expect(rows).toEqual({ "us_cpi_u_nsa_yoy|2026-09": "3.4", "us_cpi_u_sa_mom|2026-09": "0.4", "us_core_cpi_nsa_yoy|2026-09": "2.4", "us_core_cpi_sa_mom|2026-09": "0.3" });
    const mom = h.state.obs.get("us_cpi_u_sa_mom|2026-09")!;
    expect(mom.deciding_text).toBe("CONSUMER PRICE INDEX - SEPTEMBER 2026: Table A, All items, Seasonally adjusted changes from preceding month, Sep. 2026: 0.4");
    expect(mom.meta).toMatchObject({ captured_by_market: MARKET_ID, sibling_of: "us_cpi_u_nsa_yoy", doc_period: "2026-09" });
    expect((mom.corroboration as Row).status).toBe("unavailable"); // the saved API bodies end in August: not a disagreement
    expect(put).toHaveBeenCalledTimes(1); // one upstream body, one R2 object
    // a leg of a sibling ladder resolves from its stored row on its next poll, with no upstream request
    calls = [];
    const momLeg = legOf("us_cpi_u_sa_mom", "0.4%", CPI_REL);
    setWatch(momLeg);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-14T12:31:00Z") });
    try {
      const s = await runWatch(env(), cfg, WATCH_ID);
      expect(s.outcome).toBe("success");
    } finally { vi.useRealTimers(); }
    expect(calls).toHaveLength(0);
    expect(h.state.resolutions.at(-1)!.verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A" });
  });

  it("a release without a 1-month change (Table A '-', as after the 2025 lapse): the 1-month legs stay pending, the 12-month numbers of the same page are recorded", async () => {
    const lapse = CPI_SEP_FULL
      .replace('headers="cpi_pressa.r.1 cpi_pressa.h.1.2 cpi_pressa.h.2.8"><span class="datavalue">0.4</span>', 'headers="cpi_pressa.r.1 cpi_pressa.h.1.2 cpi_pressa.h.2.8"><span class="datavalue">-</span>')
      .replace('headers="cpi_pressa.r.1.3 cpi_pressa.h.1.2 cpi_pressa.h.2.8"><span class="datavalue">0.3</span>', 'headers="cpi_pressa.r.1.3 cpi_pressa.h.1.2 cpi_pressa.h.2.8"><span class="datavalue">-</span>'); // SYNTHETIC
    const m = legOf("us_cpi_u_sa_mom", "0.4%", CPI_REL);
    setWatch(m);
    const c = clock("2026-10-14T12:40:00Z");
    serve(blsRouter({ "cpi.nr0.htm": lapse }));
    const pending: Array<Promise<unknown>> = [];
    await fetchOfficial(env(), watchRow(), m, { ...c.deps, waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    expect(Object.fromEntries([...h.state.obs.entries()].map(([k, r]) => [k, r.value_text]))).toEqual({ "us_cpi_u_nsa_yoy|2026-09": "3.4", "us_core_cpi_nsa_yoy|2026-09": "2.4" });
    expect(calls.filter((x) => x.url.endsWith("cpi.nr0.htm"))).toHaveLength(1);
    expect(put).toHaveBeenCalledTimes(1);
    // six hours on, the 1-month legs are release_not_observed: never 0.0, never another month
    h.state.slots.clear();
    const late = await fetchOfficial(env(), watchRow(), m, clock("2026-10-14T18:31:00Z").deps);
    expect(late.evidence!.structured).toMatchObject({ kind: "official_missing", series: "us_cpi_u_sa_mom", period: "2026-09" });
  });

  it("a leg of one CPI series cannot fetch while a leg of another holds the release's slot", async () => {
    const m = legOf("us_core_cpi_sa_mom", "0.3%", CPI_REL);
    setWatch(m);
    const c = clock("2026-10-14T12:30:01Z");
    h.state.slots.set("bls_cpi_release|2026-09", c.now() + 30_000);
    serve(blsRouter({ "cpi.nr0.htm": CPI_SEP_FULL }));
    const out = await fetchOfficial(env(), watchRow(), m, c.deps);
    expect(out.note).toBe("awaiting_observation: another leg of this event holds the fetch lease");
    expect(calls).toHaveLength(0);
  });

  it("the Employment Situation: a sibling already stored is skipped (no second record, no corroboration request for it)", async () => {
    const m = payLeg("150k to 200k");
    setWatch(m);
    h.state.obs.set("us_unemployment_rate|2026-09", { series: "us_unemployment_rate", period: "2026-09", value: 4.1, value_text: "4.1", deciding_text: "THE EMPLOYMENT SITUATION - SEPTEMBER 2026: ...", source_url: "https://www.bls.gov/news.release/empsit.nr0.htm", raw_sha256: "d".repeat(64), observed_at: "2026-10-02T12:30:01.000Z", corroboration: null, meta: {} });
    const c = clock("2026-10-02T12:30:03Z");
    serve(blsRouter({ "empsit.nr0.htm": EMPSIT_SEP }));
    const pending: Array<Promise<unknown>> = [];
    await fetchOfficial(env(), watchRow(), m, { ...c.deps, waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    expect(h.state.obs.get("us_nonfarm_payrolls_change|2026-09")).toMatchObject({ value: 162, value_text: "162" });
    expect(calls.map((x) => x.url.split("/").pop())).toEqual(["empsit.nr0.htm", "CES0000000001"]); // no LNS14000000: the rate was stored
    expect(h.state.obsReads).toContain("us_unemployment_rate");
    expect([...h.state.slots.keys()]).toEqual(["bls_empsit_release|2026-09"]);
  });

  it("the Employment Situation: both numbers from one fetch; the payroll corroboration is unavailable until the API's latest month is September", async () => {
    const m = legOf("us_unemployment_rate", "4.1%", EMPSIT_REL);
    setWatch(m);
    const c = clock("2026-10-02T12:30:00.300Z");
    serve(blsRouter({ "empsit.nr0.htm": EMPSIT_SEP }));
    const pending: Array<Promise<unknown>> = [];
    await fetchOfficial(env(), watchRow(), m, { ...c.deps, waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    expect(calls.filter((x) => x.url.endsWith("empsit.nr0.htm"))).toHaveLength(1);
    expect(h.state.obs.get("us_unemployment_rate|2026-09")).toMatchObject({ value_text: "4.1" });
    const pay = h.state.obs.get("us_nonfarm_payrolls_change|2026-09")!;
    expect(pay).toMatchObject({ value: 162, value_text: "162" });
    expect(pay.deciding_text).toBe("THE EMPLOYMENT SITUATION - SEPTEMBER 2026: Total nonfarm payroll employment increased by 162,000 in September, and the unemployment rate was unchanged at 4.1 percent, the U.S. Bureau of Labor Statistics reported today.");
    expect((pay.corroboration as Row).status).toBe("unavailable");
  });

  it("without an ExecutionContext only the holder's own series is recorded (the others fetch on their own turn at the slot)", async () => {
    const m = legOf("us_unemployment_rate", "4.1%", EMPSIT_REL);
    setWatch(m);
    serve(blsRouter({ "empsit.nr0.htm": EMPSIT_SEP }));
    const out = await fetchOfficial(env(), watchRow(), m, clock("2026-10-02T12:40:00Z").deps);
    expect(out.evidence!.structured).toMatchObject({ series: "us_unemployment_rate", value_text: "4.1" });
    expect([...h.state.obs.keys()]).toEqual(["us_unemployment_rate|2026-09"]);
  });

  it("a delayed Employment Situation (the August summary still up after 12:30Z on Oct 2) is pending, then release_not_observed, never August's numbers", async () => {
    const m = payLeg("150k to 200k");
    setWatch(m);
    serve(blsRouter({ "empsit.nr0.htm": EMPSIT_AUG }));
    const early = await fetchOfficial(env(), watchRow(), m, clock("2026-10-02T12:45:00Z").deps);
    expect(early).toMatchObject({ notModified: true });
    expect(early.note).toContain("document is about 2026-08");
    h.state.slots.clear();
    const late = await fetchOfficial(env(), watchRow(), m, clock("2026-10-02T18:31:00Z").deps);
    expect(late.evidence!.structured).toMatchObject({ kind: "official_missing", series: "us_nonfarm_payrolls_change", period: "2026-09" });
    expect(h.state.obs.size).toBe(0);
  });

  it("first print: a payroll revision read later is alerted and ignored; the stored -23 still decides", async () => {
    const jul: Group = { series: "us_nonfarm_payrolls_change", period: "2026-07", release_at: "2026-08-07T12:30:00Z", title: "How many jobs added in July?" };
    const r = buildLegRegistration({ platform: "polymarket", external_id: "leg-jul", group: jul, label: "-50k to 0", open_at: "2026-06-01T00:00:00Z", deadline_utc: "2026-08-08T03:59:00Z", criteria: "higher range bracket" });
    if (!r.ok) throw new Error(r.reason);
    const m = { ...r.market, id: MARKET_ID, tenant_id: null, status: "open", official_outcome: null, official_resolved_at: null, official_source_url: null } as MarketRow;
    setWatch(m);
    h.state.obs.set("us_nonfarm_payrolls_change|2026-07", { series: "us_nonfarm_payrolls_change", period: "2026-07", value: -23, value_text: "-23", deciding_text: "THE EMPLOYMENT SITUATION - JULY 2026: Both nonfarm payroll employment (-23,000) and the unemployment rate (4.1 percent) changed little in July, the U.S. Bureau of Labor Statistics reported today.", source_url: "https://www.bls.gov/news.release/empsit.nr0.htm", raw_sha256: "e".repeat(64), observed_at: "2026-08-07T12:30:03.000Z", corroboration: null, meta: {} });
    h.state.hideObsFromSelect = true; // this leg's read raced the first print, so it fetched a later (SYNTHETIC reissued) page offering +21
    const reissued = fx("bls_empsit_202607_excerpt.html").split("-23,000").join("+21,000");
    serve(blsRouter({ "empsit.nr0.htm": reissued }));
    const out = await fetchOfficial(env(), watchRow(), m, clock("2026-08-07T13:00:00Z").deps);
    expect(out.evidence!.structured).toMatchObject({ value_text: "-23" });
    expect(alertKeys()).toContainEqual(["official_revision_us_nonfarm_payrolls_change_2026-07", 1440]);
  });
});

describe("BLS fetch groups: what the holder's page may and may not record for its siblings", () => {
  it("a page about another month records nothing for the target, not even a sibling it states (the 2025 lapse: October never published, November's 1-month cells '-')", async () => {
    const nov25 = fx("bls_cpi_202511_excerpt.html");
    serve(blsRouter({ "cpi.nr0.htm": nov25 }));
    // pure: the target October 2025 gets no sibling from the November page; the November target gets the two 12-month numbers
    const oct = await fetchPrimary("us_cpi_u_sa_mom", "2025-10", budget(() => Date.now(), 8000, 4));
    expect(oct).toMatchObject({ kind: "pending" });
    expect("siblings" in oct ? oct.siblings : undefined).toBeUndefined();
    const nov = await fetchPrimary("us_cpi_u_sa_mom", "2025-11", budget(() => Date.now(), 8000, 4));
    expect(nov.kind === "pending" ? nov.siblings?.map((x) => [x.series, x.period, x.value_text]) : null).toEqual([["us_cpi_u_nsa_yoy", "2025-11", "2.7"], ["us_core_cpi_nsa_yoy", "2025-11", "2.6"]]);
    // through the watch, in waitUntil: an October 2025 leg's capture stores no row at all
    const m = market({ series: "us_cpi_u_sa_mom", period: "2025-10", release_at: "2025-11-13T13:30:00Z", title: "October 2025 Inflation US - Monthly" }, "0.3%", "2025-11-14T04:59:00Z", "2025-10-01T00:00:00Z");
    setWatch(m);
    const pending: Array<Promise<unknown>> = [];
    await fetchOfficial(env(), watchRow(), m, { ...clock("2025-12-18T13:31:00Z").deps, waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    expect(h.state.obs.size).toBe(0);
    expect(put).not.toHaveBeenCalled();
    expect(calls.filter((x) => x.url.includes("api.bls.gov"))).toHaveLength(0);
  });

  it("the holder's own part of the page drifts: the siblings the page states are still recorded, and the drift is alerted", async () => {
    // SYNTHETIC: Table A's core row relabelled, so both core series drift while the headline text and row still parse
    const drifted = CPI_SEP_FULL.replace('id="cpi_pressa.r.1.3"><p class="sub1">All items less food and energy</p>', 'id="cpi_pressa.r.1.3"><p class="sub1">All items less food and energy (new basket)</p>');
    expect(drifted).not.toBe(CPI_SEP_FULL);
    const m = legOf("us_core_cpi_sa_mom", "0.3%", CPI_REL);
    setWatch(m);
    serve(blsRouter({ "cpi.nr0.htm": drifted }));
    const pending: Array<Promise<unknown>> = [];
    await fetchOfficial(env(), watchRow(), m, { ...clock("2026-10-14T12:30:02Z").deps, waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    expect(calls.filter((x) => x.url.endsWith("cpi.nr0.htm"))).toHaveLength(1); // drift is not retried in the burst
    expect(Object.fromEntries([...h.state.obs.entries()].map(([k, r]) => [k, r.value_text]))).toEqual({ "us_cpi_u_nsa_yoy|2026-09": "3.4", "us_cpi_u_sa_mom|2026-09": "0.4" });
    expect(h.state.obs.get("us_cpi_u_sa_mom|2026-09")!.meta).toMatchObject({ sibling_of: "us_core_cpi_sa_mom", captured_by_market: MARKET_ID });
    expect(put).toHaveBeenCalledTimes(1);
    expect(alertKeys()).toContainEqual(["official_schema_us_core_cpi_sa_mom", 360]);
    // without an ExecutionContext nothing is recorded from a drifted holder (only the holder's own series ever is)
    h.state.obs.clear(); h.state.slots.clear();
    await fetchOfficial(env(), watchRow(), m, clock("2026-10-14T12:40:00Z").deps);
    expect(h.state.obs.size).toBe(0);
  });
});

describe("a first print first seen after the market's fallback", () => {
  it("payrolls: a September summary that first appears on Nov 9 (after 00:00 ET Nov 6, the October data's date) is recorded but decides nothing", async () => {
    const m = payLeg("150k to 200k");
    setWatch(m);
    serve(blsRouter({ "empsit.nr0.htm": EMPSIT_SEP }));
    const out = await fetchOfficial(env(), watchRow(), m, clock("2026-11-09T14:00:00Z").deps);
    expect(out.evidence!.structured).toMatchObject({ kind: "official_observation", series: "us_nonfarm_payrolls_change", period: "2026-09", value_text: "162", observed_at: "2026-11-09T14:00:00.000Z" });
    expect(out.stop).toMatch(/fallback window has passed/);
    expect(decideOfficial(m, out.evidence!)).toMatchObject({ status: "UNRESOLVED", outcome: "NONE", caveats: ["released_after_fallback"] });
    // the same page seen before the fallback resolves the leg
    h.state.obs.clear(); h.state.slots.clear();
    const inTime = await fetchOfficial(env(), watchRow(), m, clock("2026-11-05T20:00:00Z").deps);
    expect(decideOfficial(m, inTime.evidence!)).toMatchObject({ status: "RESOLVED", outcome: "OPTION_A" });
  });
});


// ---- election captures -------------------------------------------------------------------------------------------------

function electionMarket(ev: ElectionEventInput, label: string, reg: Parameters<typeof buildElectionLeg>[2] = {}): MarketRow {
  const b = buildElectionLeg(ev, { external_id: `leg-${ev.series}-${label}`, label, open_at: "2026-09-01T00:00:00Z", deadline_utc: "2027-06-30T23:59:00Z" }, reg);
  if (!b.ok) throw new Error(b.reason);
  return { ...b.market, id: MARKET_ID, tenant_id: null, status: "open", official_outcome: null, official_resolved_at: null, official_source_url: null };
}
const TIE = "If the reported value falls exactly between two brackets, this market will resolve to the higher bracket.";
const tseTurnout = () => electionMarket({ series: "br_pres_r1_turnout", period: "2026-10-04", release_at: "2026-10-04T20:00:00Z", title: "Brazil turnout", criteria: TIE, labels: ["75-80%"] }, "75-80%");
// SYNTHETIC: the Élections Québec 2022 archive (final, every riding) as a file of the 2026 election: stamped after the
// 2026 polls closed and brought to the 127 ridings of the 2026 map by two invented ridings (evals/lib/eq-synthetic.ts)
const eq2026 = (): EqBody => eqAs2026(fx("eq_gen2022_resultats.json"));
const EQ_2026 = eqText(eq2026());
/** SYNTHETIC: the same file without the 3 ridings the PQ won in 2022; its statistics still state 127 ridings, all final. */
const EQ_2026_CUT = (() => { const d = eq2026(); d.circonscriptions = d.circonscriptions.filter((r) => ![370, 858, 842].includes(r.numeroCirconscription)); return eqText(d); })();
/** SYNTHETIC: one vote moved from St-Hilaire (CAQ) to Robin (PQ) in Taschereau: every total unchanged, the counts differ. */
function eqMoved(body: string): string {
  const edit = (id: number, from: number, to: number) => (b: string) => {
    const at = b.indexOf(`"numeroCandidat": ${id},`);
    const end = b.indexOf(`"nbVoteTotal": ${from}`, at);
    if (at < 0 || end < 0) throw new Error(`candidate ${id}`);
    return b.slice(0, end) + `"nbVoteTotal": ${to}` + b.slice(end + `"nbVoteTotal": ${from}`.length);
  };
  return edit(2311, 7537, 7536)(edit(2467, 7757, 7758)(body));
}
function eqSeatsCaq(): MarketRow {
  const p = parseEqResults(EQ_2026);
  if (!p.ok) throw new Error(p.detail);
  const eq = eqRegistryFromSnapshot(p.snap, EQ_RESULTS_URL, "2026-09-27T22:51:18Z");
  return electionMarket({ series: "qc_seats_caq", period: "2026-10-05", release_at: "2026-10-06T00:00:00Z", title: "CAQ seats", criteria: "Seats won by the CAQ.", labels: ["80+"], party: "Coalition Avenir Québec" }, "80+", { eq });
}
const CONFIRM_KEY = "official_confirm:eq_general:2026-10-05";
const EQ_INCOMPLETE_ALERT = ["official_eq_incomplete_2026-10-05", 60];

describe("election captures", () => {
  it("TSE: an official configuration that still lists no President first round 6 h after polls close keeps the legs pending and alerts the operator", async () => {
    const m = tseTurnout();
    setWatch(m);
    serve((url) => (url === TSE_CONFIG_URL ? ok(fx("tse_2022_config_ele-c_20221004T163421Z.json"), "application/json") : new Response("", { status: 404 })));
    // 5 h after polls close (20:00Z): pending, nothing alerted yet
    const early = await fetchOfficial(env(), watchRow(), m, clock("2026-10-05T01:00:00Z").deps);
    expect(early).toMatchObject({ notModified: true });
    expect(early.note).toContain("lists no President first-round election dated 04/10/2026");
    expect(alertKeys()).toEqual([]);
    // 6 h 5 min after: still pending (never a guess from the 2022 pleito), and the operator hears it once per 6 h
    __resetElectionMemo();
    const late = await fetchOfficial(env(), watchRow(), m, clock("2026-10-05T02:05:00Z").deps);
    expect(late).toMatchObject({ notModified: true });
    expect(late.evidence).toBeUndefined();
    expect(alertKeys()).toEqual([["official_tse_config_2026-10-04", 360]]);
    expect(String(vi.mocked(alert).mock.calls[0]![2])).toContain("still lists no President first-round election dated 2026-10-04, 6 h after polls closed");
    expect(calls.map((x) => x.url)).toEqual([TSE_CONFIG_URL, TSE_CONFIG_URL]); // the configuration only: no result URL is guessed
    expect(h.state.obs.size).toBe(0);
  });

  it("TSE: the simulation configuration (f=s) without the election day never raises that alert", async () => {
    const m = tseTurnout();
    setWatch(m);
    serve((url) => (url === TSE_CONFIG_URL ? ok(fx("tse_sim2026_config_ele-c.json"), "application/json") : new Response("", { status: 404 })));
    const out = await fetchOfficial(env(), watchRow(), m, clock("2026-10-05T03:00:00Z").deps);
    expect(out).toMatchObject({ notModified: true });
    expect(alertKeys()).toEqual([]);
  });

  it("Élections Québec: a final count is recorded only when a read at least 10 min after the first shows the same counts; the first read is kept in the database, not the isolate", async () => {
    const m = eqSeatsCaq();
    setWatch(m);
    serve((url) => (url === EQ_RESULTS_URL ? ok(EQ_2026, "application/json") : new Response("", { status: 404 })));
    const first = await fetchOfficial(env(), watchRow(), m, clock("2026-10-06T03:40:00Z").deps);
    expect(first).toMatchObject({ notModified: true });
    expect(first.note).toContain("first read of this final count");
    expect(h.state.obs.size).toBe(0);
    expect(JSON.parse(h.state.appConfig.get(CONFIRM_KEY)!)).toMatchObject({ first_read_at: "2026-10-06T03:40:00.000Z", as_of: "2026-10-05T23:30:00.000-04:00" });
    // 5 min later, another isolate (module state reset): the same counts, but not yet 10 min after the first read
    __resetElectionMemo();
    const second = await fetchOfficial(env(), watchRow(), m, clock("2026-10-06T03:45:00Z").deps);
    expect(second.note).toContain("was first read at 2026-10-06T03:40:00.000Z");
    expect(h.state.obs.size).toBe(0);
    // 10 min after the first read: the same counts again, so the first print is recorded, naming the first read
    __resetElectionMemo();
    const third = await fetchOfficial(env(), watchRow(), m, clock("2026-10-06T03:50:00Z").deps);
    expect(third.evidence!.structured).toMatchObject({ kind: "official_observation", series: "qc_seats_caq", period: "2026-10-05" });
    expect(h.state.obs.get("qc_seats_caq|2026-10-05")!.meta).toMatchObject({ first_final_read_at: "2026-10-06T03:40:00.000Z", counts_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(calls.filter((x) => x.url === EQ_RESULTS_URL)).toHaveLength(3);
  });

  it("Élections Québec: counts that change between two final reads start the 10 min again", async () => {
    const m = eqSeatsCaq();
    setWatch(m);
    let body = EQ_2026;
    serve((url) => (url === EQ_RESULTS_URL ? ok(body, "application/json") : new Response("", { status: 404 })));
    await fetchOfficial(env(), watchRow(), m, clock("2026-10-06T03:40:00Z").deps);
    body = eqMoved(EQ_2026);
    const moved = await fetchOfficial(env(), watchRow(), m, clock("2026-10-06T03:45:00Z").deps);
    expect(moved.note).toContain("the counts differ from the read kept at 2026-10-06T03:40:00.000Z");
    expect(JSON.parse(h.state.appConfig.get(CONFIRM_KEY)!).first_read_at).toBe("2026-10-06T03:45:00.000Z");
    // 11 min after the first read but 6 after the change: still pending
    const early = await fetchOfficial(env(), watchRow(), m, clock("2026-10-06T03:51:00Z").deps);
    expect(early.note).toContain("was first read at 2026-10-06T03:45:00.000Z");
    expect(h.state.obs.size).toBe(0);
    const done = await fetchOfficial(env(), watchRow(), m, clock("2026-10-06T03:55:00Z").deps);
    expect(done.evidence).toBeDefined();
    expect(h.state.obs.get("qc_seats_caq|2026-10-05")!.meta).toMatchObject({ first_final_read_at: "2026-10-06T03:45:00.000Z" });
  });

  it("Élections Québec: a final-flagged file that is not every riding of the election once is pending with an alert, never an observation awaiting its confirming read", async () => {
    const read = async (body: string) => {
      serve((url) => (url === EQ_RESULTS_URL ? ok(body, "application/json") : new Response("", { status: 404 })));
      return fetchPrimary("qc_seats_pq", "2026-10-05", budget(() => Date.parse("2026-10-06T03:40:00Z"), 10_000, 2));
    };
    // control: the whole file is observed and carries the counts a second read must confirm
    const whole = await read(EQ_2026);
    expect(whole).toMatchObject({ kind: "observed", confirm: { as_of: "2026-10-05T23:30:00.000-04:00", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    // the 3 ridings the PQ won are missing: the finality flags and the statistics (127 ridings, all with results) say nothing of it
    const cut = await read(EQ_2026_CUT);
    expect(cut).toMatchObject({ kind: "pending", alert: { key: EQ_INCOMPLETE_ALERT[0], dedupMinutes: EQ_INCOMPLETE_ALERT[1] } });
    expect(cut).not.toHaveProperty("confirm");
    expect(cut).not.toHaveProperty("obs");
    expect((cut as { detail: string }).detail).toContain("the file lists 124 of its 127 ridings");
    // a riding number carried by two ridings (127 entries, 126 ridings)
    const twice = eq2026();
    twice.circonscriptions.find((r) => r.numeroCirconscription === 842)!.numeroCirconscription = 370;
    const dup = await read(eqText(twice));
    expect(dup).toMatchObject({ kind: "pending", alert: { key: EQ_INCOMPLETE_ALERT[0] } });
    expect((dup as { detail: string }).detail).toContain("riding 370 is listed more than once");
    // a file consistent with itself that states 125 ridings (the 2022 archive stamped after the 2026 polls closed): the
    // riding count is the rail's own for the election (127), never the file's
    const other = await read(eqText(eqAs2026(fx("eq_gen2022_resultats.json"), 125)));
    expect(other).toMatchObject({ kind: "pending", alert: { key: EQ_INCOMPLETE_ALERT[0] } });
    expect((other as { detail: string }).detail).toContain("the file states 125 ridings; the election has 127");
  });

  it("Élections Québec: two identical truncated reads 10 min apart never lock a first print, and a truncated read neither starts nor confirms one", async () => {
    const m = eqSeatsCaq();
    setWatch(m);
    let body = EQ_2026_CUT;
    serve((url) => (url === EQ_RESULTS_URL ? ok(body, "application/json") : new Response("", { status: 404 })));
    const first = await fetchOfficial(env(), watchRow(), m, clock("2026-10-06T03:40:00Z").deps);
    expect(first).toMatchObject({ notModified: true });
    expect(first.note).toContain("flagged final but is not every riding of the 2026-10-05 election once");
    expect(h.state.appConfig.has(CONFIRM_KEY)).toBe(false); // never the first candidate
    expect(alertKeys()).toEqual([EQ_INCOMPLETE_ALERT]);
    const again = await fetchOfficial(env(), watchRow(), m, clock("2026-10-06T03:50:00Z").deps);
    expect(again).toMatchObject({ notModified: true });
    expect(again.evidence).toBeUndefined();
    expect(h.state.appConfig.has(CONFIRM_KEY)).toBe(false);
    expect(h.state.obs.size).toBe(0);
    // the whole file arrives: its first read starts the wait
    body = EQ_2026;
    const whole = await fetchOfficial(env(), watchRow(), m, clock("2026-10-06T03:55:00Z").deps);
    expect(whole.note).toContain("first read of this final count");
    expect(JSON.parse(h.state.appConfig.get(CONFIRM_KEY)!).first_read_at).toBe("2026-10-06T03:55:00.000Z");
    // 11 min later a truncated read: it confirms nothing and leaves the kept read alone
    body = EQ_2026_CUT;
    const cut = await fetchOfficial(env(), watchRow(), m, clock("2026-10-06T04:06:00Z").deps);
    expect(cut.evidence).toBeUndefined();
    expect(h.state.obs.size).toBe(0);
    expect(JSON.parse(h.state.appConfig.get(CONFIRM_KEY)!).first_read_at).toBe("2026-10-06T03:55:00.000Z");
    // the whole file again, the same counts as the kept read: recorded
    body = EQ_2026;
    const done = await fetchOfficial(env(), watchRow(), m, clock("2026-10-06T04:11:00Z").deps);
    expect(done.evidence!.structured).toMatchObject({ kind: "official_observation", series: "qc_seats_caq", period: "2026-10-05" });
    expect(h.state.obs.get("qc_seats_caq|2026-10-05")!.meta).toMatchObject({ first_final_read_at: "2026-10-06T03:55:00.000Z" });
    expect(decideOfficial(m, done.evidence!)).toMatchObject({ status: "RESOLVED", outcome: "OPTION_A" });
  });
});

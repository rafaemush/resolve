/**
 * POST /internal/official/probe: which official sources and election hosts answer the Worker. fetch is stubbed with
 * the bodies saved in evals/fixtures/official/ (never fetched by tests); the database and alerts are mocked only to
 * prove the probe never touches them. Date is fixed (only Date: timers stay real) because the BLS release-day hold
 * depends on the day.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { officialFixture as fx } from "../evals/lib/official-fixtures";

vi.mock("../src/db/supabase", () => ({
  db: vi.fn(() => { throw new Error("the probe must not open the database"); }),
  rpc: vi.fn(async () => { throw new Error("the probe must not call an RPC"); }),
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { internal } from "../src/api/internal";
import { db, rpc } from "../src/db/supabase";
import { alert } from "../src/ops/alerts";
import { OFFICIAL_UA, blsApiUrl, BLS_API, URLS } from "../src/ingest/official";
import {
  ELECTION_PROBES, PROBE_GROUPS, PROBE_MAX_SUBREQUESTS, blsApiHoldOn, clean, etDay, plannedRequests, probePlan, probeRefusal, runOfficialProbe,
  seriesOfGroup, type ProbeReport,
} from "../src/ingest/official-probe";
import { latestOrdinaryCopomMeeting } from "../src/ingest/official-parse";
import { OFFICIAL_SERIES, type OfficialSeriesId } from "../src/resolve/official";

/** Not a BLS release day in ET (the Employment Situation is 2026-10-02). */
const NOW = "2026-09-28T12:00:00Z";
const env = { ADMIN_API_KEY: "admin-test-key" } as unknown as Env;
const post = (body: unknown, key: string | null = "admin-test-key") =>
  internal.request("/official/probe", { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }, env);
const report = async (res: Response) => ((await res.json()) as { data: ProbeReport & { colo: string | null } }).data;

const ok = (body: string, type: string) => new Response(body, { status: 200, headers: { "content-type": type, server: "test-origin" } });
const BLS_API_FIXTURE: Record<string, string> = {
  CUUR0000SA0: "bls_v1_cpi.json", WPUFD4: "bls_v1_ppi.json", CUSR0000SA0: "bls_v1_cpi_sa.json", CUUR0000SA0L1E: "bls_v1_core_nsa.json",
  CUSR0000SA0L1E: "bls_v1_core_sa.json", LNS14000000: "bls_v1_unrate.json", CES0000000001: "bls_v1_payrolls.json",
};
/** Every URL the rail requests, answered with its saved body; election hosts with a small page. */
function upstream(url: string): Response {
  if (url === OFFICIAL_SERIES.us_cpi_u_nsa_yoy.primaryUrl) return ok(fx("bls_cpi_nr0.html"), "text/html");
  if (url === OFFICIAL_SERIES.us_unemployment_rate.primaryUrl) return ok(fx("bls_empsit_nr0_excerpt.html"), "text/html");
  if (url === URLS.ppiText) return ok(fx("bls_ppi_nr0.html"), "text/html");
  for (const [id, f] of Object.entries(BLS_API_FIXTURE)) if (url === blsApiUrl(id)) return ok(fx(f), "application/json");
  if (url === URLS.fedRss) return ok(fx("fed_press_monetary.xml"), "text/xml");
  if (url === "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm") return ok(fx("fed_monetary20260916a.html"), "text/html");
  if (url === URLS.fred) return ok(fx("fred_dfedtaru.csv"), "application/csv");
  if (/^https:\/\/www\.ecb\.europa\.eu\/press\/govcdec\/mopo\/\d{4}\/html\/index_include\.en\.html$/.test(url)) return ok(fx("ecb_mopo_2026_include.html"), "text/html");
  if (url === "https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.mp260910~314e508016.en.html") return ok(fx("ecb_mp260910.html"), "text/html");
  if (url === URLS.ecbDfr) return ok(fx("ecb_dfr.csv"), "text/csv");
  if (url === URLS.boeRss) return ok(fx("boe_rss_news.xml"), "text/xml");
  if (url.startsWith("https://www.bankofengland.co.uk/boeapps/database/")) return ok(fx("boe_iadb_iudbedr.csv"), "application/csv");
  if (url === URLS.bokRss) return ok(fx("bok_rss_mpd.xml"), "application/xml");
  if (url === URLS.bokPressRss) return ok(fx("bok_rss_press.xml"), "application/xml");
  if (url.startsWith("https://ecos.bok.or.kr/api/StatisticSearch/sample/json/en/1/10/722Y001/")) return ok(fx("ecos_722Y001_20260824_20260902.json"), "application/json");
  if (url.startsWith("https://ecos.bok.or.kr/api/StatisticSearch/sample/json/en/1/10/200Y102/")) return ok(fx("ecos_200Y102_10211.json"), "application/json");
  if (url === URLS.bcbHistory) return ok(fx("bcb_historicotaxasjuros.json"), "application/json");
  if (ELECTION_PROBES.some((p) => p.url === url)) return ok("<html>results</html>", "text/html");
  return new Response("not found", { status: 404 });
}

let calls: Array<{ url: string; ua: string | null; redirect: string | undefined }> = [];
function serve(router: (url: string) => Response | Promise<Response> = upstream) {
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, ua: (init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? null, redirect: init?.redirect });
    return router(url);
  });
}

/** One call per group (the route refuses a body without group or series); calls accumulate across them. */
async function everyGroup(): Promise<ProbeReport[]> {
  const out: ProbeReport[] = [];
  for (const group of PROBE_GROUPS) {
    const res = await post({ group });
    expect(res.status, group).toBe(200);
    out.push(await report(res));
  }
  return out;
}
/** The per-group reports read as one (no host is shared between groups). */
const merged = (rs: ProbeReport[]) => ({
  series_results: rs.flatMap((r) => r.series_results),
  requests: rs.flatMap((r) => r.requests),
  hosts: Object.assign({}, ...rs.map((r) => r.hosts)) as ProbeReport["hosts"],
});

beforeEach(() => {
  vi.mocked(alert).mockClear(); vi.mocked(db).mockClear(); vi.mocked(rpc).mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("POST /internal/official/probe", () => {
  it("requires the admin key and requests nothing without it", async () => {
    serve();
    expect((await post({ group: "bls" }, null)).status).toBe(403);
    expect((await post({ group: "bls" }, "wrong")).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("validates the body: a known group or series ids, exactly one of them, and never a URL", async () => {
    serve();
    for (const bad of [{ group: "fx" }, { series: ["us_gdp"] }, { group: "bls", series: ["us_unemployment_rate"] }, { url: "http://169.254.169.254/" }, { series: [] }, "{not json"]) {
      const res = await post(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    // an empty body (or one without group or series) is refused: all groups in one call are over the CPU limit
    for (const empty of [undefined, {}, { corroboration: false }]) {
      const res = await post(empty);
      expect(res.status, JSON.stringify(empty)).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string }; groups: string[] };
      expect(body.error.code).toBe("validation_error");
      expect(body.error.message).toContain("give group (bls | central_banks | elections) or series");
      expect(body.groups).toEqual([...PROBE_GROUPS]);
    }
    expect(calls).toHaveLength(0);
  });

  it("probes every series, the corroborations and the election hosts with the bot UA, within the cap, writing and alerting nothing", async () => {
    serve();
    const rs = await everyGroup();
    expect(rs.map((r) => r.groups)).toEqual([["bls"], ["central_banks"], ["elections"]]);
    expect(rs.flatMap((r) => r.series)).toEqual(Object.keys(OFFICIAL_SERIES));
    // central_banks plans one request more than it makes: the ECB's previous-year index, needed only in January
    expect(rs.map((r) => r.subrequests)).toEqual([{ cap: PROBE_MAX_SUBREQUESTS, planned: 10, used: 10 }, { cap: PROBE_MAX_SUBREQUESTS, planned: 14, used: 13 }, { cap: PROBE_MAX_SUBREQUESTS, planned: 3, used: 3 }]);
    expect(rs.every((r) => r.bls_api_hold === null)).toBe(true);
    expect(calls).toHaveLength(26);
    expect(calls.every((c) => c.ua === OFFICIAL_UA && c.redirect === "manual")).toBe(true);
    const r = merged(rs);
    // every primary parsed a value from the saved documents
    for (const s of r.series_results) expect(s.primary.ok, `${s.series}: ${s.primary.detail}`).toBe(true);
    const by = Object.fromEntries(r.series_results.map((s) => [s.series, s]));
    expect(by.us_cpi_u_nsa_yoy).toMatchObject({ group: "bls", period: "2026-08" });
    expect(by.fomc_upper_bound).toMatchObject({ group: "central_banks", period: "2026-09-16" });
    expect(by.ecb_dfr!.period).toBe("2026-09-10");
    expect(by.bcb_selic_target!.corroboration.status).toBe("single_source");
    // the BoE period is the item's pubDate, which the detail leads with (the operator checks it against the MPC date)
    expect(by.boe_bank_rate!.primary.detail).toMatch(/^pubDate [A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4}/);
    // the rail's fetchCorroboration ran for every other series (a real status, never the reachability fallback)
    for (const s of r.series_results.filter((x) => x.series !== "bcb_selic_target")) expect(["agree", "disagree", "unavailable", "inconclusive", "single_source"], s.series).toContain(s.corroboration.status);
    // one CPI page read for four series; per-request fields
    const cpi = r.requests.filter((q) => q.path === "/news.release/cpi.nr0.htm");
    expect(cpi).toHaveLength(1);
    expect(cpi[0]).toMatchObject({ role: "primary", host: "www.bls.gov", status: 200, content_type: "text/html", server: "test-origin", content_length: null, redirects: 0, error: null });
    expect(cpi[0]!.bytes).toBeGreaterThan(50_000);
    expect(cpi[0]!.parsed!.map((p) => [p.series, p.ok])).toEqual([["us_cpi_u_nsa_yoy", true], ["us_cpi_u_sa_mom", true], ["us_core_cpi_nsa_yoy", true], ["us_core_cpi_sa_mom", true]]);
    // a request's query string is shown as "?…"
    expect(r.requests.find((q) => q.host === "fred.stlouisfed.org")!.path).toBe("/graph/fredgraph.csv?…");
    expect(Object.keys(r.hosts).sort()).toEqual(["api.bls.gov", "data-api.ecb.europa.eu", "ecos.bok.or.kr", "fred.stlouisfed.org", "resultados.tse.jus.br", "www.bankofengland.co.uk", "www.bcb.gov.br", "www.bls.gov", "www.bok.or.kr", "www.ecb.europa.eu", "www.electionsquebec.qc.ca", "www.federalreserve.gov"]);
    expect(Object.values(r.hosts).every((h) => h.answered_200)).toBe(true);
    expect(r.requests.filter((q) => q.role === "election").map((q) => [q.host, q.status])).toEqual([["resultados.tse.jus.br", 200], ["resultados.tse.jus.br", 200], ["www.electionsquebec.qc.ca", 200]]);
    // no database, no alert
    expect(vi.mocked(db)).not.toHaveBeenCalled();
    expect(vi.mocked(rpc)).not.toHaveBeenCalled();
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
  });

  it("one host refusing or failing never stops the others; a refused primary still gets a reachability corroboration", async () => {
    serve((url) => {
      if (url.startsWith("https://www.bls.gov/")) return new Response("Access Denied", { status: 403, headers: { "content-type": "text/html", server: "AkamaiGHost", "content-length": "13" } });
      if (url.startsWith("https://www.federalreserve.gov/")) throw new TypeError("network connection lost");
      if (url.startsWith("https://www.electionsquebec.qc.ca/")) return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
      return upstream(url);
    });
    const r = merged(await everyGroup());
    expect(r.hosts["www.bls.gov"]).toEqual({ requests: 3, statuses: [403, 403, 403], answered_200: false });
    expect(r.hosts["www.federalreserve.gov"]).toEqual({ requests: 1, statuses: [null], answered_200: false });
    expect(r.hosts["www.electionsquebec.qc.ca"]!.statuses).toEqual([429]);
    const cpi = r.requests.find((q) => q.path === "/news.release/cpi.nr0.htm")!;
    // the dropped body's size is its Content-Length (a short "Access Denied", not a challenge page)
    expect(cpi).toMatchObject({ status: 403, server: "AkamaiGHost", bytes: null, content_length: 13, parsed: null });
    expect(cpi.hops[0]).toMatchObject({ status: 403, bytes: null, content_length: 13 });
    expect(cpi.error).toBe("HTTP 403 from www.bls.gov/news.release/cpi.nr0.htm");
    const by = Object.fromEntries(r.series_results.map((s) => [s.series, s]));
    // BLS API still asked (the rail's corroboration URL), reported as reachability only with its latest row
    expect(by.us_cpi_u_nsa_yoy!.primary.ok).toBe(false);
    expect(by.us_cpi_u_nsa_yoy!.corroboration.status).toBe("reachability_only");
    expect(by.us_cpi_u_nsa_yoy!.corroboration.value_text).toMatch(/^\d+\.\d+$/);
    expect(r.hosts["api.bls.gov"]).toMatchObject({ requests: 7, answered_200: true });
    expect(by.fomc_upper_bound!.primary.detail).toContain("network connection lost");
    expect(by.fomc_upper_bound!.corroboration.status).toBe("reachability_only");
    // the other central banks are unaffected
    for (const s of ["ecb_dfr", "boe_bank_rate", "bok_base_rate", "kr_gdp_advance_yoy", "bcb_selic_target"] as OfficialSeriesId[]) expect(by[s]!.primary.ok, s).toBe(true);
    expect(r.requests.filter((q) => q.host === "resultados.tse.jus.br").every((q) => q.status === 200)).toBe(true);
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
  });

  it("no query string reaches the report on any failure path: upstream refusal, fetch throwing, redirect off the allowlist", async () => {
    serve((url) => {
      // an off-allowlist redirect whose Location carries a credential
      if (url === URLS.fred) return new Response(null, { status: 302, headers: { location: "https://login.example/challenge?token=SUPERSECRET123" } });
      // an allowlisted redirect to a URL with a query, which then fails
      if (url === blsApiUrl(BLS_API.us_cpi_u_nsa_yoy.id)) return new Response(null, { status: 302, headers: { location: "https://api.bls.gov/login?sig=abc123&next=%2F" } });
      if (url.startsWith("https://api.bls.gov/login")) return new Response("gone", { status: 410, headers: { "content-length": "4" } });
      // a 403 from the BoE IADB URL (its whole query names the series and the dates)
      if (url.startsWith("https://www.bankofengland.co.uk/boeapps/database/")) return new Response("<html>challenge</html>", { status: 403, headers: { "content-type": "text/html", "content-length": "5120" } });
      // fetch throwing with the URL in its message
      if (url === URLS.ecbDfr) throw new TypeError(`connect ECONNREFUSED for ${url}`);
      // a primary refused (its feed URL has a query)
      if (url === URLS.bokRss) return new Response("denied", { status: 403 });
      return upstream(url);
    });
    const rs = [await report(await post({ group: "bls" })), await report(await post({ group: "central_banks" }))];
    const text = JSON.stringify(rs);
    expect(text).not.toContain("SUPERSECRET");
    expect(text).not.toContain("token=");
    expect(text).not.toMatch(/\?id=|Datefrom=|SeriesCodes=|menuNo=|lastNObservations=|format=csvdata|sig=/);
    expect(text).not.toMatch(/\?[^…]/);
    // the failures are still reported, each URL as host + path
    const r = merged(rs);
    const by = Object.fromEntries(r.series_results.map((s) => [s.series, s]));
    expect(by.fomc_upper_bound!.corroboration).toMatchObject({ status: "unavailable" });
    expect(by.fomc_upper_bound!.corroboration.detail).toBe("FRED: fred.stlouisfed.org/graph/fredgraph.csv?… redirected off the fomc_upper_bound allowlist (https only) to login.example/challenge?…; not requested");
    const fred = r.requests.find((q) => q.host === "fred.stlouisfed.org")!;
    expect(fred.error).toBe(by.fomc_upper_bound!.corroboration.detail);
    expect(fred.hops[0]!.location).toBe("login.example/challenge?…");
    expect(by.boe_bank_rate!.corroboration.detail).toBe("BoE IADB: HTTP 403 from www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?…");
    expect(r.requests.find((q) => q.path.startsWith("/boeapps/"))).toMatchObject({ status: 403, bytes: null, content_length: 5120 });
    expect(by.ecb_dfr!.corroboration.detail).toContain("ECB data API: fetch data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV?… failed: TypeError: connect ECONNREFUSED for data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV?…");
    expect(by.bok_base_rate!.primary.detail).toBe("HTTP 403 from www.bok.or.kr/eng/bbs/E0000627/news.rss?…");
    expect(by.us_cpi_u_nsa_yoy!.corroboration.detail).toBe("BLS API: HTTP 410 from api.bls.gov/login?…");
    expect(calls.some((c) => c.url.includes("login.example"))).toBe(false);
  });

  it("groups and series narrow the probe; corroboration false skips the corroborating requests", async () => {
    serve();
    const bls = await report(await post({ group: "bls" }));
    expect(bls.series).toEqual(seriesOfGroup("bls"));
    expect(bls.subrequests.used).toBe(10);
    expect(calls.every((c) => new URL(c.url).hostname.endsWith("bls.gov"))).toBe(true);

    serve();
    const cb = await report(await post({ group: "central_banks", corroboration: false }));
    expect(cb.series).toEqual(seriesOfGroup("central_banks"));
    expect(cb.subrequests.used).toBe(8); // fomc 2, ecb 2, boe, bok, gdp, bcb 1 each
    expect(cb.series_results.every((s) => s.corroboration.status === "skipped" || s.corroboration.status === "single_source")).toBe(true);

    serve();
    const el = await report(await post({ group: "elections" }));
    expect(el.series).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual(ELECTION_PROBES.map((p) => p.url));

    serve();
    const one = await report(await post({ series: ["us_unemployment_rate"] }));
    expect(one.series).toEqual(["us_unemployment_rate"]);
    expect(calls.map((c) => c.url)).toEqual([OFFICIAL_SERIES.us_unemployment_rate.primaryUrl, blsApiUrl(BLS_API.us_unemployment_rate.id)]);
  });

  it("an election redirect is followed only on the probe's own hosts", async () => {
    serve((url) => {
      if (url === "https://www.electionsquebec.qc.ca/") return new Response(null, { status: 301, headers: { location: "/fr/", "content-length": "162" } });
      if (url === "https://www.electionsquebec.qc.ca/fr/") return ok("<html>accueil</html>", "text/html");
      if (url === "https://resultados.tse.jus.br/") return new Response(null, { status: 302, headers: { location: "https://evil.example/steal?token=x" } });
      return upstream(url);
    });
    const r = await report(await post({ group: "elections" }));
    const eq = r.requests.find((q) => q.host === "www.electionsquebec.qc.ca")!;
    expect(eq).toMatchObject({ status: 200, redirects: 1, error: null });
    expect(eq.hops.map((h) => [h.path, h.status, h.content_length ?? null])).toEqual([["/", 301, 162], ["/fr/", 200, null]]);
    const tse = r.requests.find((q) => q.path === "/" && q.host === "resultados.tse.jus.br")!;
    expect(tse.error).toContain("evil.example is not an https host on the election probe list");
    expect(tse.hops[0]!.location).toBe("evil.example/steal?…");
    expect(JSON.stringify(r)).not.toContain("token=");
    expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });
});

describe("BLS release day", () => {
  it("the ET day of any scheduled BLS release holds the BLS API; other days and central-bank days do not", () => {
    expect(etDay(Date.parse("2026-10-02T03:59:00Z"))).toBe("2026-10-01");
    expect(etDay(Date.parse("2026-10-02T04:00:00Z"))).toBe("2026-10-02");
    expect(etDay(Date.parse("2026-11-06T04:30:00Z"))).toBe("2026-11-05"); // EST from Nov 1
    expect(blsApiHoldOn(Date.parse("2026-10-01T23:00:00Z"))).toBeNull(); // Oct 1, 19:00 ET
    expect(blsApiHoldOn(Date.parse("2026-10-02T04:30:00Z"))).toContain("us_unemployment_rate:2026-09"); // Oct 2, 00:30 ET
    expect(blsApiHoldOn(Date.parse("2026-10-03T03:30:00Z"))).toContain("BLS release day 2026-10-02 (ET)"); // Oct 2, 23:30 ET
    expect(blsApiHoldOn(Date.parse("2026-10-14T20:00:00Z"))).toContain("us_cpi_u_nsa_yoy:2026-09");
    expect(blsApiHoldOn(Date.parse("2026-10-15T13:00:00Z"))).toContain("us_ppi_fd_nsa_yoy:2026-09");
    expect(blsApiHoldOn(Date.parse("2026-10-28T19:00:00Z"))).toBeNull(); // the FOMC day
  });

  it("on that day the probe never requests the BLS API, even for reachability, and plans without it", async () => {
    vi.setSystemTime(new Date("2026-10-02T11:00:00Z")); // 07:00 ET, before the Employment Situation
    serve();
    const r = await report(await post({ group: "bls" }));
    expect(r.bls_api_hold).toContain("BLS release day 2026-10-02 (ET)");
    expect(r.subrequests).toEqual({ cap: PROBE_MAX_SUBREQUESTS, planned: 3, used: 3 });
    expect(calls.some((c) => c.url.startsWith("https://api.bls.gov/"))).toBe(false);
    for (const s of r.series_results) {
      expect(s.primary.ok, s.series).toBe(true);
      expect(s.corroboration.status, s.series).toBe("skipped");
      expect(s.corroboration.detail).toContain("left to the rail");
    }

    serve((url) => (url.startsWith("https://www.bls.gov/") ? new Response("denied", { status: 403 }) : upstream(url)));
    const refused = await report(await post({ series: ["us_unemployment_rate"], corroboration: true }));
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["www.bls.gov"]);
    expect(refused.series_results[0]!.corroboration.status).toBe("skipped");

    // the central banks are unaffected
    serve();
    const cb = await report(await post({ group: "central_banks" }));
    expect(cb.subrequests.used).toBe(13);
    expect(cb.series_results.filter((s) => s.corroboration.status === "skipped")).toEqual([]);
  });
});

describe("ECB discovery", () => {
  const JAN = Date.parse("2027-01-10T12:00:00Z");
  const paths = () => calls.map((c) => new URL(c.url).pathname);

  it("from 1 January to the first meeting the previous year's index is read once (a 404, or no decision named)", async () => {
    for (const [what, current] of [["404", () => new Response("not found", { status: 404 })], ["empty", () => ok("<html><body>no entries yet</body></html>", "text/html")]] as const) {
      serve((url) => (url.includes("/mopo/2027/") ? current() : upstream(url)));
      const plan = probePlan({ series: ["ecb_dfr"] }, JAN);
      expect(plannedRequests(plan)).toBe(4);
      const r = await runOfficialProbe(plan, { now: () => JAN });
      expect(paths(), what).toEqual([
        "/press/govcdec/mopo/2027/html/index_include.en.html", "/press/govcdec/mopo/2026/html/index_include.en.html",
        "/press/pr/date/2026/html/ecb.mp260910~314e508016.en.html", "/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV",
      ]);
      expect(r.series_results[0], what).toMatchObject({ series: "ecb_dfr", period: "2026-09-10", primary: { ok: true } });
      expect(r.series_results[0]!.corroboration.status, what).not.toBe("reachability_only");
      expect(r.subrequests.used).toBe(4);
    }
  });

  it("drift or a refusal of the current year's index is reported, never skipped past", async () => {
    serve((url) => (url.includes("/mopo/2027/") ? ok('<dl><dt isoDate="2027-01-05">renamed markup</dt></dl>', "text/html") : upstream(url)));
    const drift = await runOfficialProbe(probePlan({ series: ["ecb_dfr"] }, JAN), { now: () => JAN });
    expect(paths()).toEqual(["/press/govcdec/mopo/2027/html/index_include.en.html", "/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV"]);
    expect(drift.series_results[0]!.primary).toMatchObject({ ok: false });
    expect(drift.series_results[0]!.primary.detail).toContain("no dated entries");

    serve((url) => (url.includes("/mopo/2027/") ? new Response("denied", { status: 403 }) : upstream(url)));
    const refused = await runOfficialProbe(probePlan({ series: ["ecb_dfr"] }, JAN), { now: () => JAN });
    expect(paths()).toEqual(["/press/govcdec/mopo/2027/html/index_include.en.html", "/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV"]);
    expect(refused.series_results[0]!.primary.detail).toBe("HTTP 403 from www.ecb.europa.eu/press/govcdec/mopo/2027/html/index_include.en.html");
  });
});

describe("latest-period discovery", () => {
  it("the latest ordinary Copom meeting, and null for a body without rows", () => {
    expect(latestOrdinaryCopomMeeting(fx("bcb_historicotaxasjuros.json"))).toBe("2026-09-16");
    for (const bad of ["null", "{}", "[]", "not json", '{"conteudo":"x"}']) expect(latestOrdinaryCopomMeeting(bad), bad).toBeNull();
  });
});

describe("clean", () => {
  it("shows every URL in a text as host + path, its query as ?…, then redacts", () => {
    expect(clean("HTTP 403 from https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=01/Jun/2026&Dateto=now"))
      .toBe("HTTP 403 from www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?…");
    expect(clean("https://a.example/b redirected off the x allowlist (https only) to https://login.example/c?token=S,T;U; not requested"))
      .toBe("a.example/b redirected off the x allowlist (https only) to login.example/c?…; not requested");
    expect(clean("more than 3 redirects from https://a.example/b?hop=1.")).toBe("more than 3 redirects from a.example/b?….");
    expect(clean("(see https://a.example/b?x=1)")).toBe("(see a.example/b?…)");
    expect(clean("to ftp://x.example/?sig=abc; not requested")).toBe("to x.example/?…; not requested");
    expect(clean("https://user:pw@a.example/p#frag")).toBe("a.example/p");
    expect(clean("fetch https://[broken/x?token=1 failed")).toBe("fetch (url) failed");
    expect(clean("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: Bearer [redacted]");
  });
});

describe("subrequest cap", () => {
  it("the full plan fits the cap; the probe stops at the cap and reports the rest as not requested", async () => {
    expect(plannedRequests(probePlan({}))).toBeLessThanOrEqual(PROBE_MAX_SUBREQUESTS);
    serve();
    const r = await runOfficialProbe(probePlan({}), { maxSubrequests: 5 });
    expect(calls).toHaveLength(5);
    expect(r.subrequests).toMatchObject({ cap: 5, used: 5 });
    expect(r.requests.filter((q) => q.error === "request budget exhausted").length).toBeGreaterThan(0);
    expect(r.series_results).toHaveLength(Object.keys(OFFICIAL_SERIES).length);
  });

  it("a plan that could need more than the cap is refused before anything is requested", () => {
    expect(probeRefusal(probePlan({}))).toBeNull();
    expect(probeRefusal(probePlan({ group: "bls" }))).toBeNull();
    expect(probeRefusal(probePlan({ group: "bls" }), 9)).toBe("this probe needs up to 10 requests before redirects (cap 9): narrow it with group (bls | central_banks | elections) or fewer series");
    expect(probeRefusal(probePlan({ group: "bls", corroboration: false }), 9)).toBeNull();
    expect(probeRefusal(probePlan({}), 26)).toContain("needs up to 27 requests");
  });

  it("redirect hops count: an upstream that redirects every request never takes the call past the cap", async () => {
    let n = 0;
    serve((url) => {
      const u = new URL(url);
      return new Response(null, { status: 302, headers: { location: `${u.origin}${u.pathname}?hop=${++n}` } });
    });
    const res = await post({ group: "central_banks" });
    expect(res.status).toBe(200);
    const r = await report(res);
    expect(calls.length).toBeLessThanOrEqual(PROBE_MAX_SUBREQUESTS);
    expect(r.subrequests.used).toBe(calls.length);
    expect(r.requests.some((q) => q.error === "request budget exhausted")).toBe(true);
    expect(r.requests.some((q) => q.error?.startsWith("more than 3 redirects from "))).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/hop=|\?[^…]/);
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
  });
});

/**
 * POST /internal/official/probe: which official sources and election hosts answer the Worker. fetch is stubbed with
 * the bodies saved in evals/fixtures/official/ (never fetched by tests); the database and alerts are mocked only to
 * prove the probe never touches them.
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
import { ELECTION_PROBES, PROBE_MAX_SUBREQUESTS, plannedRequests, probePlan, runOfficialProbe, seriesOfGroup, type ProbeReport } from "../src/ingest/official-probe";
import { latestOrdinaryCopomMeeting } from "../src/ingest/official-parse";
import { OFFICIAL_SERIES, type OfficialSeriesId } from "../src/resolve/official";

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

beforeEach(() => { vi.mocked(alert).mockClear(); vi.mocked(db).mockClear(); vi.mocked(rpc).mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("POST /internal/official/probe", () => {
  it("requires the admin key and requests nothing without it", async () => {
    serve();
    expect((await post({ group: "bls" }, null)).status).toBe(403);
    expect((await post({ group: "bls" }, "wrong")).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("validates the body: a known group or series ids, not both, and never a URL", async () => {
    serve();
    for (const bad of [{ group: "fx" }, { series: ["us_gdp"] }, { group: "bls", series: ["us_unemployment_rate"] }, { url: "http://169.254.169.254/" }, { series: [] }, "{not json"]) {
      const res = await post(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("probes every series, the corroborations and the election hosts with the bot UA, within the cap, writing and alerting nothing", async () => {
    serve();
    const res = await post(undefined);
    expect(res.status).toBe(200);
    const r = await report(res);
    expect(r.groups).toEqual(["bls", "central_banks", "elections"]);
    expect(r.series).toEqual(Object.keys(OFFICIAL_SERIES));
    expect(r.subrequests).toEqual({ cap: PROBE_MAX_SUBREQUESTS, planned: 26, used: 26 });
    expect(calls).toHaveLength(26);
    expect(calls.every((c) => c.ua === OFFICIAL_UA && c.redirect === "manual")).toBe(true);
    // every primary parsed a value from the saved documents
    for (const s of r.series_results) expect(s.primary.ok, `${s.series}: ${s.primary.detail}`).toBe(true);
    const by = Object.fromEntries(r.series_results.map((s) => [s.series, s]));
    expect(by.us_cpi_u_nsa_yoy).toMatchObject({ group: "bls", period: "2026-08" });
    expect(by.fomc_upper_bound).toMatchObject({ group: "central_banks", period: "2026-09-16" });
    expect(by.ecb_dfr!.period).toBe("2026-09-10");
    expect(by.bcb_selic_target!.corroboration.status).toBe("single_source");
    // the rail's fetchCorroboration ran for every other series (a real status, never the reachability fallback)
    for (const s of r.series_results.filter((x) => x.series !== "bcb_selic_target")) expect(["agree", "disagree", "unavailable", "inconclusive", "single_source"], s.series).toContain(s.corroboration.status);
    // one CPI page read for four series; per-request fields
    const cpi = r.requests.filter((q) => q.path === "/news.release/cpi.nr0.htm");
    expect(cpi).toHaveLength(1);
    expect(cpi[0]).toMatchObject({ role: "primary", host: "www.bls.gov", status: 200, content_type: "text/html", server: "test-origin", redirects: 0, error: null });
    expect(cpi[0]!.bytes).toBeGreaterThan(50_000);
    expect(cpi[0]!.parsed!.map((p) => [p.series, p.ok])).toEqual([["us_cpi_u_nsa_yoy", true], ["us_cpi_u_sa_mom", true], ["us_core_cpi_nsa_yoy", true], ["us_core_cpi_sa_mom", true]]);
    // no query string is echoed
    expect(r.requests.find((q) => q.host === "fred.stlouisfed.org")!.path).toBe("/graph/fredgraph.csv?…");
    expect(JSON.stringify(r)).not.toContain("DFEDTARU&");
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
      if (url.startsWith("https://www.bls.gov/")) return new Response("Access Denied", { status: 403, headers: { "content-type": "text/html", server: "AkamaiGHost" } });
      if (url.startsWith("https://www.federalreserve.gov/")) throw new TypeError("network connection lost");
      if (url.startsWith("https://www.electionsquebec.qc.ca/")) return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
      return upstream(url);
    });
    const res = await post({});
    expect(res.status).toBe(200);
    const r = await report(res);
    expect(r.hosts["www.bls.gov"]).toEqual({ requests: 3, statuses: [403, 403, 403], answered_200: false });
    expect(r.hosts["www.federalreserve.gov"]).toEqual({ requests: 1, statuses: [null], answered_200: false });
    expect(r.hosts["www.electionsquebec.qc.ca"]!.statuses).toEqual([429]);
    const cpi = r.requests.find((q) => q.path === "/news.release/cpi.nr0.htm")!;
    expect(cpi).toMatchObject({ status: 403, server: "AkamaiGHost", parsed: null });
    expect(cpi.error).toContain("HTTP 403");
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
      if (url === "https://www.electionsquebec.qc.ca/") return new Response(null, { status: 301, headers: { location: "/fr/" } });
      if (url === "https://www.electionsquebec.qc.ca/fr/") return ok("<html>accueil</html>", "text/html");
      if (url === "https://resultados.tse.jus.br/") return new Response(null, { status: 302, headers: { location: "https://evil.example/steal?token=x" } });
      return upstream(url);
    });
    const r = await report(await post({ group: "elections" }));
    const eq = r.requests.find((q) => q.host === "www.electionsquebec.qc.ca")!;
    expect(eq).toMatchObject({ status: 200, redirects: 1, error: null });
    expect(eq.hops.map((h) => [h.path, h.status])).toEqual([["/", 301], ["/fr/", 200]]);
    const tse = r.requests.find((q) => q.path === "/" && q.host === "resultados.tse.jus.br")!;
    expect(tse.error).toContain("evil.example is not an https host on the election probe list");
    expect(tse.hops[0]!.location).toBe("evil.example/steal?…");
    expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });
});

describe("latest-period discovery", () => {
  it("the latest ordinary Copom meeting, and null for a body without rows", () => {
    expect(latestOrdinaryCopomMeeting(fx("bcb_historicotaxasjuros.json"))).toBe("2026-09-16");
    for (const bad of ["null", "{}", "[]", "not json", '{"conteudo":"x"}']) expect(latestOrdinaryCopomMeeting(bad), bad).toBeNull();
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

  it("redirect hops count: an upstream that redirects every request never takes the call past the cap", async () => {
    let n = 0;
    serve((url) => {
      const u = new URL(url);
      return new Response(null, { status: 302, headers: { location: `${u.origin}${u.pathname}?hop=${++n}` } });
    });
    const res = await post({});
    expect(res.status).toBe(200);
    const r = await report(res);
    expect(calls.length).toBeLessThanOrEqual(PROBE_MAX_SUBREQUESTS);
    expect(r.subrequests.used).toBe(calls.length);
    expect(r.requests.some((q) => q.error === "request budget exhausted")).toBe(true);
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
  });
});

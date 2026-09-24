/**
 * official_release decisions: decimal arithmetic, the markets' rounding rules, buckets, the three gates, and the
 * router guarantee that an official_release market never reaches Jev.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveMarket, planRoute } from "../src/resolve";
import { DEFAULT_THRESHOLDS } from "../src/resolve/thresholds";
import { __setRailsForMutationTesting } from "../src/resolve/rails";
import type { EvidenceInput, MarketRegistration } from "../src/resolve/schema";
import {
  yoyTenths, percentTenths, changeHundredthsBp, roundedChangeBps, bucketContains, bucketProblem, sameAtPrecision, firstPrintFor,
  officialEvidence, namesPeriod, type OfficialObservationDoc, type OfficialCorroboration, type OfficialSeriesId,
} from "../src/resolve/official";
import { buildLegRegistration, parseBucketLabel } from "../src/markets/official-legs";

afterEach(() => __setRailsForMutationTesting([]));

const GROUPS = {
  cpi: { series: "us_cpi_u_nsa_yoy", period: "2026-09", release_at: "2026-10-14T12:30:00Z", title: "September Inflation US - Annual" },
  fed: { series: "fomc_upper_bound", period: "2026-10-28", release_at: "2026-10-28T18:00:00Z", prior_level: 4.0, title: "Fed Decision in October?" },
  boe: { series: "boe_bank_rate", period: "2026-11-05", release_at: "2026-11-05T12:00:00Z", prior_level: 3.75, title: "Bank of England decision in November?" },
  bok: { series: "bok_base_rate", period: "2026-10-22", release_at: "2026-10-22T01:00:00Z", prior_level: 3.0, title: "Bank of Korea decision in October?" },
  bcb: { series: "bcb_selic_target", period: "2026-11-04", release_at: "2026-11-04T21:30:00Z", prior_level: 13.75, title: "Bank of Brazil decision in November?" },
} as const;

function leg(g: keyof typeof GROUPS, label: string): MarketRegistration {
  const r = buildLegRegistration({ platform: "limitless", external_id: `test-${g}-${label}`, group: { ...GROUPS[g] }, label, open_at: "2026-09-15T00:00:00Z", deadline_utc: "2026-10-15T03:59:00Z", criteria: "test criteria" });
  if (!r.ok) throw new Error(r.reason);
  return r.market;
}
const corr = (status: OfficialCorroboration["status"], value_text: string | null = null): OfficialCorroboration => ({ status, source_url: "https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0", value: value_text === null ? null : Number(value_text), value_text, detail: "test", checked_at: "2026-10-14T12:30:04.000Z" });
function doc(series: OfficialSeriesId, over: Partial<OfficialObservationDoc>): OfficialObservationDoc {
  return {
    kind: "official_observation", series, period: "2026-09", value: 3.4, value_text: "3.4",
    deciding_text: "CONSUMER PRICE INDEX - SEPTEMBER 2026: Over the last 12 months, the all items index increased 3.4 percent before seasonal adjustment.",
    source_url: "https://www.bls.gov/news.release/cpi.nr0.htm", raw_sha256: "a".repeat(64), observed_at: "2026-10-14T12:30:03.000Z", direction: null, corroboration: corr("agree", "3.4"), ...over,
  };
}
async function decide(market: MarketRegistration, ev: EvidenceInput) {
  let jevCalls = 0;
  const r = await resolveMarket({ marketId: "m", market, evidence: ev, thresholds: DEFAULT_THRESHOLDS, spotlightSecret: "eval-spotlight-v1", model: "jev-1.13.0", now: new Date("2026-10-14T12:31:00Z") }, { jev: async () => { jevCalls++; throw new Error("jev must not be called for official_release"); } });
  expect(jevCalls).toBe(0);
  return r;
}
const evOf = (d: Parameters<typeof officialEvidence>[0]) => officialEvidence(d, "2026-10-14T12:31:00.000Z").evidence;

describe("decimal arithmetic and rounding", () => {
  it("12-month change from index strings, half away from zero, with near-tie detection", () => {
    expect(yoyTenths("334.980", "323.976")).toEqual({ tenths: 34, nearTie: false });
    expect(yoyTenths("103.450", "100.000")).toEqual({ tenths: 35, nearTie: true }); // exactly 3.45
    expect(yoyTenths("103.4496", "100.000")).toEqual({ tenths: 34, nearTie: true }); // 3.4496: within 0.0005 of 3.45
    expect(yoyTenths("103.4400", "100.000")).toEqual({ tenths: 34, nearTie: false });
    expect(yoyTenths("99.800", "100.000")).toEqual({ tenths: -2, nearTie: false });
    expect(yoyTenths("-", "100")).toBeUndefined();
  });
  it("published percents and levels", () => {
    expect([percentTenths("3.4"), percentTenths("-0.2"), percentTenths("3.45"), percentTenths("-0.25"), percentTenths(3.4)]).toEqual([34, -2, 35, -3, 34]);
    expect([changeHundredthsBp("3.75", 4), changeHundredthsBp("13.75", 14), changeHundredthsBp(4.125, 4), changeHundredthsBp("3.00", 3)]).toEqual([-2500, -2500, 1250, 0]);
    expect(sameAtPrecision("fomc_upper_bound", 4, "4.00")).toBe(true);
    expect(sameAtPrecision("us_cpi_u_nsa_yoy", "3.4", "3.5")).toBe(false);
  });
  it("the two basis-point rules from the market texts", () => {
    const away = (bps: number) => roundedChangeBps(bps * 100, "bps_away_from_zero_25");
    const near = (bps: number) => roundedChangeBps(bps * 100, "bps_nearest_25_min_25");
    // Fed: a change off the grid is rounded up (away from zero) to the next 25
    expect([away(0), away(10), away(-10), away(25), away(30), away(-30), away(50), away(51)]).toEqual([0, 25, -25, 25, 50, -50, 50, 75]);
    // BoK/ECB/BCB/BoE: below 25 counts as 25; otherwise nearest 25, ties away from zero
    expect([near(0), near(10), near(-10), near(30), near(37), near(37.5), near(-37.5), near(62.5), near(60)]).toEqual([0, 25, -25, 25, 25, 50, -50, 75, 50]);
  });
});

describe("buckets", () => {
  it("contain values on the decided grid with their inclusivity", () => {
    const b = (label: string, d: "percent" | "rate_change_bps") => parseBucketLabel(label, d)!;
    expect(bucketContains(b("≤2.9%", "percent"), "percent", 29)).toBe(true);
    expect(bucketContains(b("≤2.9%", "percent"), "percent", 30)).toBe(false);
    expect(bucketContains(b("<2.0%", "percent"), "percent", 20)).toBe(false);
    expect(bucketContains(b("2.0–2.4%", "percent"), "percent", 24)).toBe(true);
    expect(bucketContains(b("2.0–2.4%", "percent"), "percent", 25)).toBe(false);
    expect(bucketContains(b("5.0%+", "percent"), "percent", 50)).toBe(true);
    expect(bucketContains(b("50+ bps decrease", "rate_change_bps"), "rate_change_bps", -75)).toBe(true);
    expect(bucketContains(b("50+ bps decrease", "rate_change_bps"), "rate_change_bps", -25)).toBe(false);
    expect(bucketContains(b("No change", "rate_change_bps"), "rate_change_bps", 0)).toBe(true);
  });
  it("refuse empty, off-grid and unreachable buckets", () => {
    expect(bucketProblem({ label: "x", lo_inclusive: true, hi_inclusive: true }, "percent")).toMatch(/neither lo nor hi/);
    expect(bucketProblem({ label: "x", lo: 2.0, hi: 2.0, lo_inclusive: false, hi_inclusive: true }, "percent")).toMatch(/empty/);
    expect(bucketProblem({ label: "x", lo: 2.05, hi: 2.4, lo_inclusive: true, hi_inclusive: true }, "percent")).toMatch(/multiple of 0.1/);
    expect(bucketProblem({ label: "x", lo: 1, hi: 24, lo_inclusive: true, hi_inclusive: true }, "rate_change_bps")).toMatch(/no multiple of 25/);
    expect(bucketProblem({ label: "x", lo: -25, hi: -25, lo_inclusive: true, hi_inclusive: true }, "rate_change_bps")).toBeNull();
  });
});

describe("decideOfficial through resolveMarket (never Jev)", () => {
  it("CPI 3.4 with agreeing API: the 3.4% leg is Yes, the 3.3% leg a positive No", async () => {
    const yes = await decide(leg("cpi", "3.4%"), evOf(doc("us_cpi_u_nsa_yoy", {})));
    expect(yes.route).toBe("structured");
    expect(yes.verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A", determination_basis: "structured", confidence_score: 0.99, caveats: ["first_print"] });
    const no = await decide(leg("cpi", "3.3%"), evOf(doc("us_cpi_u_nsa_yoy", {})));
    expect(no.verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_B" });
    const edge = await decide(leg("cpi", "≥4.0%"), evOf(doc("us_cpi_u_nsa_yoy", { value: 4.0, value_text: "4.0", corroboration: corr("agree", "4.0") })));
    expect(edge.verdict.winning_outcome).toBe("OPTION_A");
  });
  it("gate 1: observed before release_at, or a release naming the previous month, is awaiting_release", async () => {
    const early = await decide(leg("cpi", "3.4%"), evOf(doc("us_cpi_u_nsa_yoy", { observed_at: "2026-10-14T12:29:00.000Z" })));
    expect(early.verdict).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["awaiting_release"] });
    const stale = await decide(leg("cpi", "3.4%"), evOf(doc("us_cpi_u_nsa_yoy", { period: "2026-08", deciding_text: "CONSUMER PRICE INDEX - AUGUST 2026: Over the last 12 months, the all items index increased 3.4 percent before seasonal adjustment." })));
    expect(stale.verdict).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["awaiting_release"] });
    __setRailsForMutationTesting(["official_release_gate"]);
    expect((await decide(leg("cpi", "3.4%"), evOf(doc("us_cpi_u_nsa_yoy", { period: "2026-08" })))).verdict.resolution_status).toBe("RESOLVED");
  });
  it("gate 2: a disagreeing second source holds every leg; unavailable or near-tie corroboration resolves with a caveat", async () => {
    const d = await decide(leg("cpi", "3.4%"), evOf(doc("us_cpi_u_nsa_yoy", { corroboration: corr("agree", "3.5") })));
    expect(d.verdict).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["sources_disagree"] });
    const u = await decide(leg("cpi", "3.4%"), evOf(doc("us_cpi_u_nsa_yoy", { corroboration: corr("unavailable") })));
    expect(u.verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A", caveats: ["first_print", "corroboration_unavailable"] });
    const t = await decide(leg("cpi", "3.4%"), evOf(doc("us_cpi_u_nsa_yoy", { corroboration: corr("inconclusive", "3.5") })));
    expect(t.verdict).toMatchObject({ resolution_status: "RESOLVED", caveats: ["first_print", "corroboration_unavailable"] });
    const n = await decide(leg("cpi", "3.4%"), evOf(doc("us_cpi_u_nsa_yoy", { corroboration: null })));
    expect(n.verdict.caveats).toContain("corroboration_unavailable");
  });
  it("Fed: '3-3/4 to 4' against a prior upper bound of 4.00 is No change (the -25 leg is a positive No)", async () => {
    const d = (over: Partial<OfficialObservationDoc>) => doc("fomc_upper_bound", { period: "2026-10-28", value: 4, value_text: "3-3/4 to 4", direction: "unchanged", deciding_text: "October 28, 2026: The Committee decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent", source_url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm", observed_at: "2026-10-28T18:00:04.000Z", corroboration: corr("unavailable"), ...over });
    expect((await decide(leg("fed", "No change"), evOf(d({})))).verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A" });
    expect((await decide(leg("fed", "25 bps decrease"), evOf(d({})))).verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_B" });
    // a cut to 3-1/2 to 3-3/4 (upper 3.75) is the -25 leg
    const cut = d({ value: 3.75, value_text: "3-1/2 to 3-3/4", direction: "down", deciding_text: "October 28, 2026: The Committee decided to lower the target range for the federal funds rate by 1/4 percentage point to 3-1/2 to 3-3/4 percent" });
    expect((await decide(leg("fed", "25 bps decrease"), evOf(cut))).verdict.winning_outcome).toBe("OPTION_A");
    // a 10 bp move is rounded away from zero to 25 by the Fed market's rule
    const odd = d({ value: 4.1, value_text: "4.1", direction: "up", deciding_text: "October 28, 2026: The Committee decided to raise the target range for the federal funds rate to 3.85 to 4.1 percent" });
    expect((await decide(leg("fed", "25 bps increase"), evOf(odd))).verdict.winning_outcome).toBe("OPTION_A");
  });
  it("BoE 'maintained at 3.75%' is the No change leg; a direction contradicting prior_level holds the leg", async () => {
    const d = doc("boe_bank_rate", { period: "2026-11-05", value: 3.75, value_text: "3.75", direction: "unchanged", deciding_text: "Bank rate maintained at 3.75% - November 2026 Monetary Policy Summary and Minutes", source_url: "https://www.bankofengland.co.uk/rss/news", observed_at: "2026-11-05T12:00:05.000Z", corroboration: corr("unavailable") });
    expect((await decide(leg("boe", "No change"), evOf(d))).verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A" });
    const wrongPrior = { ...leg("boe", "No change") };
    wrongPrior.resolver = { ...(wrongPrior.resolver as Extract<MarketRegistration["resolver"], { kind: "official_release" }>), prior_level: 4.0 };
    expect((await decide(wrongPrior, evOf(d))).verdict).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["prior_level_mismatch"] });
  });
  it("BCB single source resolves with its caveat; a missing release is release_not_observed", async () => {
    const d = doc("bcb_selic_target", { period: "2026-11-04", value: 13.5, value_text: "13.5", direction: "down", deciding_text: "Copom meeting 282 of 2026-11-04 (ordinary): MetaSelic 13.5%", source_url: "https://www.bcb.gov.br/api/servico/sitebcb/historicotaxasjuros", observed_at: "2026-11-04T21:31:00.000Z", corroboration: { ...corr("single_source"), source_url: null } });
    expect((await decide(leg("bcb", "25 bps decrease"), evOf(d))).verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A", caveats: ["first_print", "single_source"] });
    const miss = await decide(leg("cpi", "3.4%"), evOf({ kind: "official_missing", series: "us_cpi_u_nsa_yoy", period: "2026-09", release_at: "2026-10-14T12:30:00Z", source_url: "https://www.bls.gov/news.release/cpi.nr0.htm", detail: "not observed by release_at + 6 h" }));
    expect(miss.verdict).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["release_not_observed"] });
  });
  it("web evidence for an official market is an ERROR, never a Jev call; a foreign host fails the source rule", async () => {
    const web = await decide(leg("cpi", "3.4%"), { source_kind: "web_fetch", source_url: "https://www.bls.gov/news.release/cpi.nr0.htm", text: "us_cpi_u_nsa_yoy CPI rose 3.4 percent over the last 12 months, before seasonal adjustment, for September 2026.", fetched_at: "2026-10-14T12:31:00Z" });
    expect(web.verdict.resolution_status).toBe("ERROR");
    expect(web.verdict.error_code).toBe("SOURCE_MISMATCH");
    const foreign = evOf(doc("us_cpi_u_nsa_yoy", { source_url: "https://inflation-news.example/cpi" }));
    expect((await decide(leg("cpi", "3.4%"), foreign)).verdict).toMatchObject({ resolution_status: "ERROR", error_reason: "SOURCE_REF_MISMATCH" });
  });
  it("planRoute prices official legs as structured", async () => {
    const p = await planRoute({ marketId: "m", market: leg("cpi", "3.4%"), evidence: evOf(doc("us_cpi_u_nsa_yoy", {})), thresholds: DEFAULT_THRESHOLDS, spotlightSecret: "s", model: "jev-1.13.0", now: new Date("2026-10-14T12:31:00Z") });
    expect(p.route).toBe("structured");
  });
});

describe("first print lock", () => {
  it("the stored first print decides; a revised later read is ignored unless the rail is off", () => {
    const first = doc("kr_gdp_advance_yoy", { period: "2026-Q1", value: 3.6, value_text: "3.6" });
    const revised = doc("kr_gdp_advance_yoy", { period: "2026-Q1", value: 3.8, value_text: "3.8", corroboration: null });
    expect(firstPrintFor(first, revised).value_text).toBe("3.6");
    expect(firstPrintFor(first, null).value_text).toBe("3.6");
    __setRailsForMutationTesting(["first_print_lock"]);
    expect(firstPrintFor(first, revised).value_text).toBe("3.8");
  });
  it("names the target period in the forms the documents use", () => {
    expect(namesPeriod("us_cpi_u_nsa_yoy", "2026-09", "CONSUMER PRICE INDEX - SEPTEMBER 2026: ...")).toBe(true);
    expect(namesPeriod("fomc_upper_bound", "2026-10-28", "October 28, 2026: The Committee ...")).toBe(true);
    expect(namesPeriod("ecb_dfr", "2026-10-29", "29 October 2026: the interest rates ...")).toBe(true);
    expect(namesPeriod("kr_gdp_advance_yoy", "2026-Q3", "Real Gross Domestic Product: Third Quarter of 2026 (Advance Estimate)")).toBe(true);
    expect(namesPeriod("kr_gdp_advance_yoy", "2026-Q3", "ECOS 200Y102 2026Q3 = 3.1")).toBe(true);
    expect(namesPeriod("bok_base_rate", "2026-10-22", "(August 27, 2026) The Monetary Policy Board ...")).toBe(false);
  });
});

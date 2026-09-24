/**
 * Findings of the independent review of 4258e3b, one describe per item. Each test failed before its fix.
 */
import { afterEach, describe, expect, it } from "vitest";
import { officialFixture as fx } from "../evals/lib/official-fixtures";
import { parseBokGdpRss, parseBokDecisionRss, parseFomcStatement, parseBcbHistory, parseEcbRelease, type DocObservation } from "../src/ingest/official-parse";
import { resolveMarket } from "../src/resolve";
import { DEFAULT_THRESHOLDS } from "../src/resolve/thresholds";
import { __setRailsForMutationTesting } from "../src/resolve/rails";
import { officialEvidence, type OfficialObservationDoc, type OfficialCorroboration, type OfficialSeriesId } from "../src/resolve/official";
import { buildLegRegistration, parseBucketLabel, type LegGroup } from "../src/markets/official-legs";
import { validateRegistration } from "../src/markets/register";
import type { MarketRegistration } from "../src/resolve/schema";

afterEach(() => __setRailsForMutationTesting([]));

const obsOf = (p: ReturnType<typeof parseBokGdpRss>) => { if (!p.ok) throw new Error(`${p.reason}: ${p.detail}`); return p.obs; };
const leg = (g: LegGroup, label: string, open = "2026-06-01T00:00:00Z", deadline = "2026-12-31T00:00:00Z"): MarketRegistration => {
  const r = buildLegRegistration({ platform: "limitless", external_id: `rev-${g.series}-${label}`, group: g, label, open_at: open, deadline_utc: deadline, criteria: "review test" });
  if (!r.ok) throw new Error(r.reason);
  return r.market;
};
const corr = (status: OfficialCorroboration["status"], value_text: string | null): OfficialCorroboration => ({ status, source_url: "https://ecos.bok.or.kr/x", value: value_text === null ? null : Number(value_text), value_text, detail: "review", checked_at: "2026-10-26T23:00:05.000Z" });
function docFrom(series: OfficialSeriesId, o: DocObservation, over: Partial<OfficialObservationDoc> = {}): OfficialObservationDoc {
  return {
    kind: "official_observation", series, period: o.period, value: o.value, value_text: o.value_text, deciding_text: o.deciding_text, source_url: "https://www.bok.or.kr/eng/bbs/E0000627/news.rss?menuNo=400022",
    raw_sha256: "e".repeat(64), observed_at: "2026-10-22T01:00:05.000Z", direction: o.direction, corroboration: null,
    stated_prior: typeof o.meta.stated_prior === "string" ? o.meta.stated_prior : null,
    stated_step_bps: typeof o.meta.stated_step_bps === "number" ? o.meta.stated_step_bps : null,
    ...over,
  };
}
async function verdict(m: MarketRegistration, doc: OfficialObservationDoc, ownCapture = true) {
  const { evidence } = officialEvidence(doc, doc.observed_at, { ownCapture });
  const r = await resolveMarket({ marketId: "m", market: m, evidence, thresholds: DEFAULT_THRESHOLDS, spotlightSecret: "s", model: "jev-1.13.0" }, { jev: async () => { throw new Error("no jev"); } });
  return r.verdict;
}

// ---- 1 (HIGH): Korea GDP must be read from the GDP paragraph only ----------------------------------------------------
const gdpFeed = (desc: string) =>
  `<rss><channel><item><title>Real Gross Domestic Product: Third Quarter of 2026 (Advance Estimate)</title><description><![CDATA[${desc.replace(/</g, "&lt;").replace(/>/g, "&gt;")}]]></description></item></channel></rss>`;
const GDI = "◈ Real gross domestic income (GDI) increased by 3.6 percent compared to the previous quarter―in year-on-year terms it increased by 15.6 percent. ※ Refer to the attached file for details.";
const gdp = (clause: string) => `<p>◈ Real gross domestic product (chained volume measure of GDP) increased by 0.6 percent in the third quarter of 2026 compared to the previous quarter―${clause}</p><p>${GDI}</p>`;

describe("1. GDP YoY comes only from the GDP paragraph", () => {
  it("the real advance estimates still read 3.7 (Q2) and 3.6 (Q1), never the GDI's 15.6 / 12.3", () => {
    expect(obsOf(parseBokGdpRss(fx("bok_rss_press.xml"), "2026-Q2")).value_text).toBe("3.7");
    expect(obsOf(parseBokGdpRss(fx("bok_rss_press.xml"), "2026-Q1")).value_text).toBe("3.6");
    expect(obsOf(parseBokGdpRss(gdpFeed(gdp("in year-on-year terms it increased by 3.1 percent.")), "2026-Q3")).value_text).toBe("3.1");
  });
  for (const clause of [
    "in year-on-year terms it grew 3.7 percent.",
    "in year-on-year terms it was flat.",
    "it recorded 3.7 percent growth in year-on-year terms.",
    "in year-on-year terms, it increased by 3.7 percent.",
  ]) {
    it(`reworded GDP clause "${clause}" is schema drift, never the GDI's 15.6`, () => {
      expect(parseBokGdpRss(gdpFeed(gdp(clause)), "2026-Q3")).toMatchObject({ ok: false, reason: "schema_drift" });
    });
  }
  it("two year-on-year figures inside the GDP paragraph, or no GDP paragraph at all, are drift", () => {
    expect(parseBokGdpRss(gdpFeed(gdp("in year-on-year terms it increased by 3.1 percent (in year-on-year terms it increased by 3.3 percent on the old base).")), "2026-Q3")).toMatchObject({ ok: false, reason: "schema_drift" });
    expect(parseBokGdpRss(gdpFeed(`<p>${GDI}</p>`), "2026-Q3")).toMatchObject({ ok: false, reason: "schema_drift" });
  });
});

// ---- 2 (MEDIUM): the level or step the document states must match prior_level ------------------------------------------
const BOK_OCT: LegGroup = { series: "bok_base_rate", period: "2026-10-22", release_at: "2026-10-22T01:00:00Z", prior_level: 3.0, title: "Bank of Korea decision in October?" };
const bokFeed = (sentence: string) =>
  `<rss><channel><item><title>★Monetary Policy Decision &amp;amp; Opening Remarks to the Press Conference(October 22, 2026)</title><description><![CDATA[&lt;p&gt;${sentence}&lt;/p&gt;]]></description></item></channel></rss>`;

describe("2. a document's own starting level or step must agree with prior_level", () => {
  it("BoK prior 3.00 but the release says 'lower ... by 25 basis points from 2.50% to 2.25%': prior_level_mismatch, not '50+ bps cut'", async () => {
    const o = obsOf(parseBokDecisionRss(bokFeed("The Monetary Policy Board of the Bank of Korea decided today to lower the Base Rate by 25 basis points from 2.50% to 2.25%."), "2026-10-22"));
    const v = await verdict(leg(BOK_OCT, "50+ bps cut"), docFrom("bok_base_rate", o));
    expect(v).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["prior_level_mismatch"] });
  });
  it("BoK from 3.00% to 2.75% with prior 3.00 resolves (the 25 bps cut leg is Yes)", async () => {
    const o = obsOf(parseBokDecisionRss(bokFeed("The Monetary Policy Board of the Bank of Korea decided today to lower the Base Rate by 25 basis points from 3.00% to 2.75%."), "2026-10-22"));
    expect((await verdict(leg(BOK_OCT, "25 bps cut"), docFrom("bok_base_rate", o))).winning_outcome).toBe("OPTION_A");
  });
  it("Fed: a stated 1/2 point step that is not the change against prior_level holds the leg", async () => {
    const page = `<div id="article"><p class="article__time">October 28, 2026</p><p>The Committee decided to raise the target range for the federal funds rate by 1/2 percentage point to 4 to 4-1/4 percent.</p></div>`;
    const o = obsOf(parseFomcStatement(page));
    const fed: LegGroup = { series: "fomc_upper_bound", period: "2026-10-28", release_at: "2026-10-28T18:00:00Z", prior_level: 4.0, title: "Fed" };
    const v = await verdict(leg(fed, "25 bps increase"), docFrom("fomc_upper_bound", o, { observed_at: "2026-10-28T18:00:05.000Z", source_url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm" }));
    expect(v).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["prior_level_mismatch"] });
  });
  it("BCB: the previous meeting's level (14.00) is not the registered prior (13.75)", async () => {
    const o = obsOf(parseBcbHistory(fx("bcb_historicotaxasjuros.json"), "2026-09-16"));
    const bcb: LegGroup = { series: "bcb_selic_target", period: "2026-09-16", release_at: "2026-09-16T21:30:00Z", prior_level: 13.75, title: "BCB" };
    const v = await verdict(leg(bcb, "No Change"), docFrom("bcb_selic_target", o, { observed_at: "2026-09-24T13:22:00.000Z", source_url: "https://www.bcb.gov.br/api/servico/sitebcb/historicotaxasjuros" }));
    expect(v).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["prior_level_mismatch"] });
  });
  it("ECB: the stated 25 bp step is read and checked", async () => {
    const o = obsOf(parseEcbRelease(fx("ecb_mp260910.html")));
    expect(o.meta.stated_step_bps).toBe(25);
    const ecb: LegGroup = { series: "ecb_dfr", period: "2026-09-10", release_at: "2026-09-10T12:15:00Z", prior_level: 2.0, title: "ECB" };
    const v = await verdict(leg(ecb, "50+ bps increase"), docFrom("ecb_dfr", o, { observed_at: "2026-09-24T13:17:24.000Z", source_url: "https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.mp260910~314e508016.en.html" }));
    expect(v).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["prior_level_mismatch"] });
  });
});

// ---- 3 (MEDIUM): release_at belongs to (series, period) ------------------------------------------------------------------
describe("3. release_at is a property of the event, not of the registration", () => {
  it("a known event refuses a release_at that differs from the scheduled one", () => {
    const g: LegGroup = { series: "us_cpi_u_nsa_yoy", period: "2026-09", release_at: "2026-10-14T12:00:00Z", title: "CPI" };
    expect(() => validateRegistration(leg(g, "3.4%", "2026-09-15T00:00:00Z", "2026-10-15T03:59:00Z"))).toThrow(/scheduled release 2026-10-14T12:30:00Z/);
    expect(() => validateRegistration(leg({ ...g, release_at: "2026-10-14T12:30:00.000Z" }, "3.4%", "2026-09-15T00:00:00Z", "2026-10-15T03:59:00Z"))).not.toThrow();
  });
  it("an unknown event: another market's first print of the right period is not frozen by this market's later release_at", async () => {
    const g: LegGroup = { series: "us_cpi_u_nsa_yoy", period: "2026-08", release_at: "2026-09-11T13:00:00Z", title: "CPI Aug" };
    const cpiAug: OfficialObservationDoc = {
      kind: "official_observation", series: "us_cpi_u_nsa_yoy", period: "2026-08", value: 3.4, value_text: "3.4",
      deciding_text: "CONSUMER PRICE INDEX - AUGUST 2026: Over the last 12 months, the all items index increased 3.4 percent before seasonal adjustment.",
      source_url: "https://www.bls.gov/news.release/cpi.nr0.htm", raw_sha256: "f".repeat(64), observed_at: "2026-09-11T12:30:04.000Z", direction: null, corroboration: null, stated_prior: null, stated_step_bps: null,
    };
    expect((await verdict(leg(g, "3.4%"), cpiAug, false))).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A" });
    expect((await verdict(leg(g, "3.4%"), cpiAug, true))).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["awaiting_release"] });
  });
  it("a known event checks the scheduled release time whoever captured the first print", async () => {
    const g: LegGroup = { series: "us_cpi_u_nsa_yoy", period: "2026-09", release_at: "2026-10-14T12:30:00Z", title: "CPI" };
    const early: OfficialObservationDoc = {
      kind: "official_observation", series: "us_cpi_u_nsa_yoy", period: "2026-09", value: 3.4, value_text: "3.4",
      deciding_text: "CONSUMER PRICE INDEX - SEPTEMBER 2026: Over the last 12 months, the all items index increased 3.4 percent before seasonal adjustment.",
      source_url: "https://www.bls.gov/news.release/cpi.nr0.htm", raw_sha256: "f".repeat(64), observed_at: "2026-10-14T12:29:00.000Z", direction: null, corroboration: null, stated_prior: null, stated_step_bps: null,
    };
    expect(await verdict(leg(g, "3.4%", "2026-09-15T00:00:00Z", "2026-10-15T03:59:00Z"), early, false)).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["awaiting_release"] });
  });
});

// ---- 5 (LOW): cases for mutants that survived ------------------------------------------------------------------------------
const GDP_Q3: LegGroup = { series: "kr_gdp_advance_yoy", period: "2026-Q3", release_at: "2026-10-26T23:00:00Z", title: "Korea GDP Q3" };
const gdpDoc = (value_text: string, c: OfficialCorroboration | null): OfficialObservationDoc => ({
  kind: "official_observation", series: "kr_gdp_advance_yoy", period: "2026-Q3", value: Number(value_text), value_text,
  deciding_text: "Real Gross Domestic Product: Third Quarter of 2026 (Advance Estimate): in year-on-year terms it increased by 3.0 percent",
  source_url: "https://www.bok.or.kr/eng/bbs/E0000634/news.rss?menuNo=400069", raw_sha256: "a".repeat(64), observed_at: "2026-10-26T23:00:05.000Z", direction: null, corroboration: c, stated_prior: null, stated_step_bps: null,
});
describe("5. surviving mutants", () => {
  it("an exclusive lower bound ('>3.0%') excludes 3.0 and includes 3.1", async () => {
    expect(parseBucketLabel(">3.0%", "percent")).toMatchObject({ lo: 3, lo_inclusive: false });
    expect((await verdict(leg(GDP_Q3, ">3.0%"), gdpDoc("3.0", null))).winning_outcome).toBe("OPTION_B");
    expect((await verdict(leg(GDP_Q3, ">3.0%"), gdpDoc("3.1", null))).winning_outcome).toBe("OPTION_A");
  });
  it("corroboration status 'disagree' holds the leg even when the recorded values are equal, or the value is null", async () => {
    expect(await verdict(leg(GDP_Q3, "3.0–3.4%"), gdpDoc("3.0", corr("disagree", "3.0")))).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["sources_disagree"] });
    expect(await verdict(leg(GDP_Q3, "3.0–3.4%"), gdpDoc("3.0", corr("disagree", null)))).toMatchObject({ resolution_status: "UNRESOLVED", caveats: ["sources_disagree"] });
  });
  it("BoK 'raise ... from 3.00% to 2.75%' contradicts itself: schema drift", () => {
    expect(parseBokDecisionRss(bokFeed("The Monetary Policy Board of the Bank of Korea decided today to raise the Base Rate by 25 basis points from 3.00% to 2.75%."), "2026-10-22")).toMatchObject({ ok: false, reason: "schema_drift" });
  });
});

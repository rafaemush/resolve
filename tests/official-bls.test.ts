/**
 * The five BLS series added 2026-09-27: US CPI 1-month (seasonally adjusted), core CPI 12-month (unadjusted) and
 * 1-month, the unemployment rate and the nonfarm payroll change. Parsers against the saved release excerpts
 * (evals/fixtures/official/, byte-exact) and against small SYNTHETIC pages built here from the same markup; the BLS
 * API corroboration (near ties, level rounding, later vintages); the thousands unit, its buckets and registration.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { officialFixture as fx } from "../evals/lib/official-fixtures";
import { parseBlsCpiTableA, parseEmpsitRelease, parseBlsApi, blsApiMom, blsApiYoy, blsApiLevelChange, previousMonth, type DocParse } from "../src/ingest/official-parse";
import { blsCorroboration, blsApiUrl, parseBlsSeries } from "../src/ingest/official";
import {
  OFFICIAL_SERIES, KNOWN_RELEASES, bucketContains, bucketProblem, decidedUnits, decideOfficial, fetchGroupOf, fetchSlotOf, fallbackEndMs, hostAllowed, namesPeriod,
  officialEvidence, sameAtPrecision, thousandsOf, roundingFits, type OfficialResolver, type OfficialSeriesId,
} from "../src/resolve/official";
import { OfficialSeries } from "../src/resolve/schema";
import { buildLegRegistration, parseBucketLabel, type LegGroup } from "../src/markets/official-legs";
import { validateRegistration } from "../src/markets/register";
import type { MarketRegistration } from "../src/resolve/schema";

const obs = (p: DocParse) => { if (!p.ok) throw new Error(`${p.reason}: ${p.detail}`); return p.obs; };
const NEW: OfficialSeriesId[] = ["us_cpi_u_sa_mom", "us_core_cpi_nsa_yoy", "us_core_cpi_sa_mom", "us_unemployment_rate", "us_nonfarm_payrolls_change"];

// ---- SYNTHETIC pages in the releases' own markup ----------------------------------------------------------------------

interface TableSpec { header?: string; summary?: string; months?: string[]; nsa?: string; caption?: string; all?: string[]; core?: string[]; allLabel?: string }
/** A CPI release reduced to its first <PRE> and Table A; the last month column is the reference month. */
function cpiPage(o: TableSpec = {}): string {
  const months = o.months ?? ["Aug.<br />2026", "Sep.<br />2026"];
  const row = (id: string, label: string, v: string[]) => `<tr>\n<th headers="cpi_pressa.h.1.1" id="${id}"><p class="sub0">${label}</p></th>\n${months.map((_, i) => `<td headers="${id} cpi_pressa.h.1.2 cpi_pressa.h.2.${i + 2}"><span class="datavalue">${v[i]}</span></td>`).join("\n")}\n<td headers="${id} cpi_pressa.h.1.9"><span class="datavalue">${v[months.length]}</span></td>\n</tr>`;
  return `<html><body><PRE>
Transmission of material in this news release is embargoed until       USDL-26-0000
8:30 a.m. (ET) Wednesday, October 14, 2026

               ${o.header ?? "CONSUMER PRICE INDEX - SEPTEMBER 2026"}

${o.summary ?? "The Consumer Price Index for All Urban Consumers (CPI-U) increased 0.2 percent on a seasonally adjusted basis in September after rising 0.4 percent in August."}
</PRE>
<table class="regular" id="cpi_pressa">
<caption><span class="tableTitle">${o.caption ?? "Table A. Percent changes in CPI for All Urban Consumers (CPI-U): U.S. city average"}<br /><br /></span></caption>
<thead>
<tr>
<th class="stubhead" id="cpi_pressa.h.1.1" rowspan="2"></th>
<th class="stubhead" colspan="${months.length}" id="cpi_pressa.h.1.2">Seasonally adjusted changes from preceding month</th>
<th class="stubhead" id="cpi_pressa.h.1.9" rowspan="2">Un-<br />adjusted<br />12-mos.<br />ended<br />${o.nsa ?? "Sep. 2026"}</th>
</tr>
<tr>
${months.map((m, i) => `<th class="stubhead" headers="cpi_pressa.h.1.2" id="cpi_pressa.h.2.${i + 2}">${m}</th>`).join("\n")}
</tr>
</thead>
<tbody>
${row("cpi_pressa.r.1", o.allLabel ?? "All items", o.all ?? ["0.4", "0.2", "3.1"])}
${row("cpi_pressa.r.1.3", "All items less food and energy", o.core ?? ["0.3", "0.3", "2.5"])}
</tbody>
</table></body></html>`;
}

/**
 * An Employment Situation summary reduced to its <PRE>: an optional boxed note, the lead (its byline sentence added
 * unless it has one or byline is false), household and establishment first paragraphs.
 */
function empsitPage(o: { header?: string; box?: string; lead: string; byline?: boolean; household?: string; establishment?: string }): string {
  const byline = o.byline === false || /reported today/.test(o.lead) ? "" : " The U.S. Bureau of Labor Statistics reported today.";
  return `<html><body><pre>
Transmission of material in this news release is embargoed until                       USDL-26-0000
8:30 a.m. (ET) Friday, October 2, 2026


                            ${o.header ?? "THE EMPLOYMENT SITUATION - SEPTEMBER 2026"}

${o.box ? `\n${o.box}\n` : ""}
${o.lead}${byline}

This news release presents statistics from two monthly surveys. The household survey measures
labor force status.

Household Survey Data

${o.household ?? ""}

Establishment Survey Data

${o.establishment ?? ""}

The change in total nonfarm payroll employment for July was revised down by 30,000, from +21,000
to -9,000, and the change for August was revised up by 12,000, from +162,000 to +174,000.
</pre></body></html>`;
}

describe("CPI Table A (the CPI release, cpi.nr0.htm): 1-month SA and 12-month NSA, headline and core", () => {
  it("August 2026 (the saved release): 0.4 headline 1-month, 0.3 core 1-month, 2.4 core 12-month, each tied to AUGUST 2026", () => {
    const page = fx("bls_cpi_nr0.html");
    expect(obs(parseBlsCpiTableA(page, "all_items", "sa_1m"))).toMatchObject({ period: "2026-08", value: 0.4, value_text: "0.4", deciding_text: "CONSUMER PRICE INDEX - AUGUST 2026: Table A, All items, Seasonally adjusted changes from preceding month, Aug. 2026: 0.4" });
    expect(obs(parseBlsCpiTableA(page, "core", "sa_1m"))).toMatchObject({ period: "2026-08", value_text: "0.3" });
    const yoy = obs(parseBlsCpiTableA(page, "core", "nsa_12m"));
    expect(yoy).toMatchObject({ period: "2026-08", value_text: "2.4", deciding_text: "CONSUMER PRICE INDEX - AUGUST 2026: Table A, All items less food and energy, Un- adjusted 12-mos. ended Aug. 2026: 2.4" });
    expect(namesPeriod("us_core_cpi_nsa_yoy", "2026-08", yoy.deciding_text)).toBe(true);
    // the headline 12-month cell equals the sentence the headline series reads
    expect(obs(parseBlsCpiTableA(page, "all_items", "nsa_12m")).value_text).toBe("3.4");
  });
  it("June 2026 'decreased 0.4 percent' is -0.4 and core 'was unchanged in June' is 0.0; May 2024's reversed word order passes the cross-check", () => {
    const jun = fx("bls_cpi_202606_excerpt.html");
    expect(obs(parseBlsCpiTableA(jun, "all_items", "sa_1m"))).toMatchObject({ period: "2026-06", value: -0.4, value_text: "-0.4" });
    expect(obs(parseBlsCpiTableA(jun, "core", "sa_1m"))).toMatchObject({ period: "2026-06", value_text: "0.0" });
    expect(obs(parseBlsCpiTableA(fx("bls_cpi_202405_excerpt.html"), "all_items", "sa_1m"))).toMatchObject({ period: "2024-05", value_text: "0.0" });
    expect(obs(parseBlsCpiTableA(fx("bls_cpi_202509_excerpt.html"), "all_items", "sa_1m"))).toMatchObject({ period: "2025-09", value_text: "0.3" });
  });
  it("November 2025 (after the 2025 lapse): a '-' cell is not published, never 0 and never the 2-month change; the 12-month cell still reads", () => {
    const nov = fx("bls_cpi_202511_excerpt.html");
    expect(nov).toContain("over the 2 months");
    expect(parseBlsCpiTableA(nov, "all_items", "sa_1m")).toMatchObject({ ok: false, reason: "not_published" });
    expect(parseBlsCpiTableA(nov, "core", "sa_1m")).toMatchObject({ ok: false, reason: "not_published" });
    expect(obs(parseBlsCpiTableA(nov, "core", "nsa_12m"))).toMatchObject({ period: "2025-11", value_text: "2.6" });
  });
  it("reads the header month's column, never an earlier month's (SYNTHETIC September page)", () => {
    expect(obs(parseBlsCpiTableA(cpiPage(), "all_items", "sa_1m"))).toMatchObject({ period: "2026-09", value_text: "0.2" });
    expect(obs(parseBlsCpiTableA(cpiPage(), "core", "nsa_12m"))).toMatchObject({ period: "2026-09", value_text: "2.5" });
    expect(obs(parseBlsCpiTableA(cpiPage({ months: ["Aug.<br />2026", "Sept.<br />2026"] }), "core", "sa_1m")).value_text).toBe("0.3");
  });
  it("schema drift, never a guess: month mismatch, column order, row label, caption, cell format, missing table", () => {
    const drift = (html: string, row: "all_items" | "core" = "all_items", col: "sa_1m" | "nsa_12m" = "sa_1m") => expect(parseBlsCpiTableA(html, row, col)).toMatchObject({ ok: false, reason: "schema_drift" });
    drift(cpiPage({ months: ["Jul.<br />2026", "Aug.<br />2026"] })); // the header says September, the table's last month is August
    drift(cpiPage({ nsa: "Aug. 2026" }), "core", "nsa_12m");
    // September is not the last column (no summary sentence, so only the column-order rule can refuse it)
    drift(cpiPage({ months: ["Sep.<br />2026", "Aug.<br />2026"], summary: "No summary sentence." }));
    drift(cpiPage({ allLabel: "All items (new basket)" }));
    drift(cpiPage({ caption: "Table A. Percent changes in CPI for Urban Wage Earners (CPI-W)" }));
    drift(cpiPage({ all: ["0.4", "0.25", "3.1"] }));
    drift(cpiPage({ all: ["0.4", "n.a.", "3.1"] }));
    drift("<html><PRE>CONSUMER PRICE INDEX - SEPTEMBER 2026</PRE><p>no table</p></html>");
    drift("<html>Access Denied</html>");
  });
  it("a summary sentence that ties a different 1-month value (or month) to the release contradicts Table A: drift; a 2-month sentence is ignored", () => {
    const drift = (summary: string) => expect(parseBlsCpiTableA(cpiPage({ summary }), "all_items", "sa_1m")).toMatchObject({ ok: false, reason: "schema_drift" });
    drift("The Consumer Price Index for All Urban Consumers (CPI-U) increased 0.3 percent on a seasonally adjusted basis in September after rising 0.4 percent in August.");
    drift("The Consumer Price Index for All Urban Consumers (CPI-U) increased 0.2 percent on a seasonally adjusted basis in August.");
    expect(obs(parseBlsCpiTableA(cpiPage({ summary: "The Consumer Price Index for All Urban Consumers (CPI-U) increased 0.6 percent on a seasonally adjusted basis over the 2 months from July 2026 to September 2026." }), "all_items", "sa_1m")).value_text).toBe("0.2");
    expect(obs(parseBlsCpiTableA(cpiPage({ summary: "The index for all items less food and energy rose 0.3 percent in September." }), "core", "sa_1m")).value_text).toBe("0.3");
    expect(parseBlsCpiTableA(cpiPage({ summary: "The index for all items less food and energy rose 0.4 percent in September." }), "core", "sa_1m")).toMatchObject({ ok: false, reason: "schema_drift" });
  });
});

describe("Employment Situation summary (empsit.nr0.htm): unemployment rate and payroll change of the header month", () => {
  it("August 2026 (saved): +162,000 ('increased by' in the lead, 'rose by' in the section) and 4.1 percent; the June/July revisions are not read", () => {
    const page = fx("bls_empsit_nr0_excerpt.html");
    expect(page).toContain("from -23,000 to +21,000");
    const pay = obs(parseEmpsitRelease(page, "payrolls_change"));
    expect(pay).toMatchObject({ period: "2026-08", value: 162, value_text: "162", meta: { unit: "thousands", readings: "lead + Establishment Survey Data" } });
    expect(pay.deciding_text).toBe("THE EMPLOYMENT SITUATION - AUGUST 2026: Total nonfarm payroll employment increased by 162,000 in August, and the unemployment rate was unchanged at 4.1 percent, the U.S. Bureau of Labor Statistics reported today.");
    expect(obs(parseEmpsitRelease(page, "unemployment_rate"))).toMatchObject({ period: "2026-08", value: 4.1, value_text: "4.1", meta: { readings: "lead + Household Survey Data" } });
    expect(namesPeriod("us_nonfarm_payrolls_change", "2026-08", pay.deciding_text)).toBe(true);
  });
  it("July 2026: 'changed little in July (-23,000)' and 'Both nonfarm payroll employment (-23,000) and the unemployment rate (4.1 percent)'", () => {
    const page = fx("bls_empsit_202607_excerpt.html");
    expect(obs(parseEmpsitRelease(page, "payrolls_change"))).toMatchObject({ period: "2026-07", value: -23, value_text: "-23" });
    expect(obs(parseEmpsitRelease(page, "unemployment_rate"))).toMatchObject({ period: "2026-07", value_text: "4.1" });
  });
  it("February 2026: the '--' header, a boxed note, 'edged down by 92,000' is -92, and 'following an increase in January (+126,000)' is not read", () => {
    const page = fx("bls_empsit_202602_excerpt.html");
    expect(page).toContain("THE EMPLOYMENT SITUATION -- FEBRUARY 2026");
    expect(obs(parseEmpsitRelease(page, "payrolls_change"))).toMatchObject({ period: "2026-02", value: -92 });
    expect(obs(parseEmpsitRelease(page, "unemployment_rate"))).toMatchObject({ period: "2026-02", value_text: "4.4" });
  });
  it("SYNTHETIC wordings: 'rose to', 'edged up by 0.1 percentage point to', 'declined by', a parenthetical prior month", () => {
    const p = empsitPage({
      lead: "Total nonfarm payroll employment declined by 41,000 in September, and the unemployment rate rose to 4.3 percent, the U.S. Bureau of Labor Statistics reported today.",
      household: "The unemployment rate edged up by 0.1 percentage point to 4.3 percent in September.",
      establishment: "Total nonfarm payroll employment declined by 41,000 in September, following a gain in August (+174,000).",
    });
    expect(obs(parseEmpsitRelease(p, "payrolls_change"))).toMatchObject({ period: "2026-09", value: -41 });
    expect(obs(parseEmpsitRelease(p, "unemployment_rate"))).toMatchObject({ period: "2026-09", value_text: "4.3" });
    const signed = (lead: string) => parseEmpsitRelease(empsitPage({ lead }), "payrolls_change");
    expect(obs(signed("Total nonfarm payroll employment edged down in September (-32,000), and the unemployment rate held at 4.1 percent."))).toMatchObject({ value: -32 });
    expect(obs(signed("Both total nonfarm payroll employment (+22,000) and the unemployment rate (4.3 percent) changed little in September."))).toMatchObject({ value: 22 });
    expect(signed("Total nonfarm payroll employment edged down in September (+32,000).")).toMatchObject({ ok: false, reason: "schema_drift" }); // verb and sign disagree
    expect(signed("Total nonfarm payroll employment rose by +32,000 in September.")).toMatchObject({ ok: false, reason: "schema_drift" });
  });
  it("drift, never a guess: only a prior month named, readings that disagree, millions, a zero without a sign rule, an unknown wording", () => {
    const drift = (lead: string, establishment = "", household = "") => {
      const page = empsitPage({ lead, establishment, household });
      return [parseEmpsitRelease(page, "payrolls_change"), parseEmpsitRelease(page, "unemployment_rate")];
    };
    // the September header, but the only payroll sentence is about August
    expect(drift("Total nonfarm payroll employment rose by 140,000 in August, and the unemployment rate was unchanged at 4.1 percent in September.")[0]).toMatchObject({ ok: false, reason: "schema_drift" });
    expect(drift("Total nonfarm payroll employment rose by 50,000 in September.", "Total nonfarm payroll employment rose by 55,000 in September.")[0]).toMatchObject({ ok: false, reason: "schema_drift" });
    expect(drift("Total nonfarm payroll employment declined by 1.2 million in September.")[0]).toMatchObject({ ok: false, reason: "schema_drift" });
    expect(drift("Total nonfarm payroll employment was unchanged in September (0).")[0]).toMatchObject({ ok: false, reason: "schema_drift" });
    expect(drift("Payrolls grew strongly in September.")[0]).toMatchObject({ ok: false, reason: "schema_drift" });
    const [, rate] = drift("The unemployment rate was unchanged at 4.1 percent in September.", "", "The unemployment rate was 4.2 percent.");
    expect(rate).toMatchObject({ ok: true }); // an unrecognised sentence is not a reading
    const [, twoRates] = drift("The unemployment rate was unchanged at 4.1 percent in September.", "", "The unemployment rate rose to 4.2 percent.");
    expect(twoRates).toMatchObject({ ok: false, reason: "schema_drift" }); // a reading without the month that states another value
    expect(parseEmpsitRelease("<html>Access Denied</html>", "payrolls_change")).toMatchObject({ ok: false, reason: "schema_drift" });
  });
  it("the unemployment rate is tied to its own month, never to a sentence that merely mentions the header month (SYNTHETIC)", () => {
    const rate = (lead: string, household = "") => parseEmpsitRelease(empsitPage({ lead, household }), "unemployment_rate");
    const DRIFT = { ok: false, reason: "schema_drift" };
    // the only rate sentence is about August (or names no month): never September's first print
    expect(rate("Employment changed little.", "In August, the unemployment rate rose to 4.3 percent.")).toMatchObject(DRIFT);
    expect(rate("Employment changed little.", "The unemployment rate rose to 4.3 percent.")).toMatchObject(DRIFT);
    // "4.1 percent in August" is August's even when the sentence goes on to name September
    expect(rate("Employment changed little.", "The unemployment rate was unchanged at 4.1 percent in August and rose to 4.3 percent in September.")).toMatchObject(DRIFT);
    expect(rate("The unemployment rate was unchanged at 4.1 percent in August, the most recent month available before September.")).toMatchObject(DRIFT);
    // September of another year is another month
    expect(rate("Employment changed little.", "The unemployment rate rose to 4.4 percent in September 2025.")).toMatchObject(DRIFT);
    // tied to September, the rest of the sentence may name other months
    expect(obs(rate("Employment changed little.", "The unemployment rate rose to 4.3 percent in September, following 4.1 percent in August."))).toMatchObject({ period: "2026-09", value_text: "4.3" });
    expect(obs(rate("Employment changed little.", "The unemployment rate rose to 4.3 percent in September 2026."))).toMatchObject({ value_text: "4.3" });
  });
  it("only TOTAL nonfarm payroll employment is read: a private or government count is never the total (SYNTHETIC)", () => {
    const pay = (lead: string, establishment = "") => parseEmpsitRelease(empsitPage({ lead, establishment }), "payrolls_change");
    const DRIFT = { ok: false, reason: "schema_drift" };
    expect(pay("Private nonfarm payroll employment rose in September (+30,000), and the unemployment rate was unchanged at 4.1 percent in September.")).toMatchObject(DRIFT);
    expect(pay("Government nonfarm payroll employment edged down in September (-12,000), and the unemployment rate held at 4.1 percent.")).toMatchObject(DRIFT);
    expect(pay("Total nonfarm payroll employment was little changed in September.", "Private nonfarm payroll employment changed little in September (+12,000).")).toMatchObject(DRIFT);
    expect(pay("Private nonfarm payroll employment changed little (+12,000) in September.")).toMatchObject(DRIFT);
    // beside a Total sentence, a private count is simply not a reading
    expect(obs(pay("Private nonfarm payroll employment rose in September (+30,000).", "Total nonfarm payroll employment changed little in September (-10,000)."))).toMatchObject({ value: -10, meta: { readings: "Establishment Survey Data" } });
  });
  it("the lead is found by its byline, not its position; a count for the header month of another year is another month (SYNTHETIC)", () => {
    const box = "| This release was delayed. Total nonfarm payroll employment rose by 119,000 in September 2025, as first reported. |";
    const p = empsitPage({ box, lead: "Total nonfarm payroll employment rose by 22,000 in September, and the unemployment rate changed little at 4.3 percent, the U.S. Bureau of Labor Statistics reported today." });
    expect(obs(parseEmpsitRelease(p, "payrolls_change"))).toMatchObject({ period: "2026-09", value: 22, meta: { readings: "lead" } });
    expect(obs(parseEmpsitRelease(p, "unemployment_rate"))).toMatchObject({ value_text: "4.3" });
    expect(parseEmpsitRelease(empsitPage({ lead: "Employment was little changed.", establishment: "Total nonfarm payroll employment rose by 119,000 in September 2025." }), "payrolls_change")).toMatchObject({ ok: false, reason: "schema_drift" });
    expect(obs(parseEmpsitRelease(empsitPage({ lead: "Total nonfarm payroll employment rose by 22,000 in September 2026." }), "payrolls_change")).value).toBe(22);
    // no paragraph with the byline: no lead, drift (never the first paragraph by position)
    expect(parseEmpsitRelease(empsitPage({ lead: "Total nonfarm payroll employment rose by 22,000 in September.", byline: false }), "payrolls_change")).toMatchObject({ ok: false, reason: "schema_drift", detail: expect.stringContaining("lead paragraph") });
  });
  it("a page still about August is August: the adapter, not the parser, calls it pending", () => {
    const p = empsitPage({ header: "THE EMPLOYMENT SITUATION - AUGUST 2026", lead: "Total nonfarm payroll employment increased by 162,000 in August, and the unemployment rate was unchanged at 4.1 percent." });
    expect(obs(parseEmpsitRelease(p, "payrolls_change")).period).toBe("2026-08");
  });
});

describe("BLS API v1: the latest month, 1-month changes, level differences", () => {
  const api = (f: string, id: string) => { const p = parseBlsApi(fx(f), id); if (!p.ok) throw new Error(p.detail); return p; };
  it("reproduces the release's 1-month and 12-month changes and the payroll change of the latest month", () => {
    const sa = api("bls_v1_cpi_sa.json", "CUSR0000SA0");
    expect(sa.latest).toBe("2026-08");
    expect(blsApiMom(sa.index, "2026-08")).toMatchObject({ tenths: 4, nearTie: false, current: "334.131", base: "332.813" });
    expect(blsApiMom(sa.index, "2026-06")).toMatchObject({ tenths: -4 });
    expect(blsApiMom(api("bls_v1_core_sa.json", "CUSR0000SA0L1E").index, "2026-08")).toMatchObject({ tenths: 3, current: "337.765", base: "336.789" });
    expect(blsApiYoy(api("bls_v1_core_nsa.json", "CUUR0000SA0L1E").index, "2026-08")).toMatchObject({ tenths: 24, current: "338.041", base: "329.970" });
    expect(blsApiMom(sa.index, "2025-11")).toBeUndefined(); // October 2025 is "-" (the lapse)
    const ces = api("bls_v1_payrolls.json", "CES0000000001");
    expect(ces.latest).toBe("2026-08");
    expect(blsApiLevelChange(ces.index, "2026-08")).toEqual({ change: 162, current: "159075", base: "158913" });
    expect(blsApiLevelChange(ces.index, "2026-02")).toMatchObject({ change: -156 }); // first print was -92: a later vintage
    expect([previousMonth("2026-01"), previousMonth("2026-10")]).toEqual(["2025-12", "2026-09"]);
  });
});

describe("corroboration from the BLS API (blsCorroboration, pure)", () => {
  const at = "2026-10-14T12:30:05.000Z";
  const corr = (series: Parameters<typeof blsCorroboration>[0]["series"], value_text: string, target: string, body: string) =>
    blsCorroboration({ series, value: Number(value_text), value_text }, target, body, blsApiUrl("X"), at);
  it("agree, disagree and unavailable at the published precision", () => {
    expect(corr("us_cpi_u_sa_mom", "0.4", "2026-08", fx("bls_v1_cpi_sa.json"))).toMatchObject({ status: "agree", value_text: "0.4" });
    expect(corr("us_cpi_u_sa_mom", "0.3", "2026-08", fx("bls_v1_cpi_sa.json"))).toMatchObject({ status: "disagree", value_text: "0.4" });
    expect(corr("us_cpi_u_sa_mom", "0.2", "2026-09", fx("bls_v1_cpi_sa.json"))).toMatchObject({ status: "unavailable" });
    expect(corr("us_core_cpi_nsa_yoy", "2.4", "2026-08", fx("bls_v1_core_nsa.json"))).toMatchObject({ status: "agree" });
    expect(corr("us_unemployment_rate", "4.1", "2026-08", fx("bls_v1_unrate.json"))).toMatchObject({ status: "agree", value_text: "4.1" });
    expect(corr("us_unemployment_rate", "4.1", "2025-10", fx("bls_v1_unrate.json"))).toMatchObject({ status: "unavailable" }); // "-" in the lapse
    expect(corr("us_unemployment_rate", "4.2", "2026-08", fx("bls_v1_unrate.json"))).toMatchObject({ status: "disagree", value_text: "4.1" }); // the API is the text's only independent check
    expect(corr("us_cpi_u_sa_mom", "0.4", "2026-08", '{"status":"REQUEST_NOT_PROCESSED","message":["daily threshold"]}')).toMatchObject({ status: "unavailable" });
  });
  it("a near tie is inconclusive when the release printed either side of it, and a disagreement when it printed neither", () => {
    const tie35 = fx("bls_v1_cpi_sa.json").replace('"334.131"', '"333.978"'); // SYNTHETIC: 0.35004 percent
    expect(corr("us_cpi_u_sa_mom", "0.4", "2026-08", tie35)).toMatchObject({ status: "inconclusive" });
    expect(corr("us_cpi_u_sa_mom", "0.3", "2026-08", tie35)).toMatchObject({ status: "inconclusive" });
    expect(corr("us_cpi_u_sa_mom", "0.5", "2026-08", tie35)).toMatchObject({ status: "disagree" });
  });
  it("payrolls: the level difference only while the month is the API's latest; one thousand off is level rounding", () => {
    const ces = fx("bls_v1_payrolls.json");
    expect(corr("us_nonfarm_payrolls_change", "162", "2026-08", ces)).toMatchObject({ status: "agree", value: 162 });
    expect(corr("us_nonfarm_payrolls_change", "163", "2026-08", ces)).toMatchObject({ status: "inconclusive" });
    expect(corr("us_nonfarm_payrolls_change", "150", "2026-08", ces)).toMatchObject({ status: "disagree" });
    expect(corr("us_nonfarm_payrolls_change", "-92", "2026-02", ces)).toMatchObject({ status: "single_source", value: null });
    expect(corr("us_nonfarm_payrolls_change", "50", "2026-09", ces)).toMatchObject({ status: "unavailable" });
  });
});

describe("registry, units and buckets of the new series", () => {
  it("every new series is in the schema enum, on www.bls.gov and api.bls.gov only, monthly, with the September 2026 release observed on the BLS schedules", () => {
    for (const s of NEW) {
      expect(OfficialSeries.options).toContain(s);
      expect(OFFICIAL_SERIES[s]).toMatchObject({ period: "month", corroboration: "when_available" });
      expect(hostAllowed(s, "https://www.bls.gov/news.release/empsit.nr0.htm")).toBe(true);
      expect(hostAllowed(s, "https://api.bls.gov/publicAPI/v1/timeseries/data/LNS14000000")).toBe(true);
      expect(hostAllowed(s, "https://data.bls.gov/x")).toBe(false);
      expect(hostAllowed(s, "http://www.bls.gov/news.release/cpi.nr0.htm")).toBe(false);
      expect(KNOWN_RELEASES[`${s}:2026-09`], s).toBeDefined();
    }
    for (const s of ["us_cpi_u_sa_mom", "us_core_cpi_nsa_yoy", "us_core_cpi_sa_mom"] as const) expect(KNOWN_RELEASES[`${s}:2026-09`]).toMatchObject({ release_at: "2026-10-14T12:30:00Z", fallback_until: "2026-11-10T13:30:00Z" });
    // "by the date" the October data is scheduled (Nov 6, EST): from 00:00 ET that day, never 08:30
    for (const s of ["us_unemployment_rate", "us_nonfarm_payrolls_change"] as const) {
      expect(KNOWN_RELEASES[`${s}:2026-09`]).toMatchObject({ release_at: "2026-10-02T12:30:00Z", fallback_until: "2026-11-06T05:00:00Z" });
      expect(fallbackEndMs({ series: s, period: "2026-09", release_at: "2026-10-02T12:30:00Z" })).toBe(Date.parse("2026-11-06T05:00:00Z"));
    }
    expect(OFFICIAL_SERIES.us_nonfarm_payrolls_change).toMatchObject({ decides: "change_thousands", rounding: "thousands_as_printed" });
  });
  it("one fetch slot per page: the CPI release serves four series, the Employment Situation two; slot names are never series ids", () => {
    expect(fetchSlotOf("us_cpi_u_nsa_yoy")).toBe("bls_cpi_release");
    expect(fetchGroupOf("us_core_cpi_sa_mom")).toEqual(["us_core_cpi_sa_mom", "us_cpi_u_nsa_yoy", "us_cpi_u_sa_mom", "us_core_cpi_nsa_yoy"]);
    expect(fetchGroupOf("us_unemployment_rate")).toEqual(["us_unemployment_rate", "us_nonfarm_payrolls_change"]);
    expect(fetchGroupOf("us_ppi_fd_nsa_yoy")).toEqual(["us_ppi_fd_nsa_yoy"]);
    expect(fetchSlotOf("fomc_upper_bound")).toBe("fomc_upper_bound");
    for (const s of OfficialSeries.options) {
      expect(OfficialSeries.options as readonly string[]).not.toContain(OFFICIAL_SERIES[s].fetchGroup ?? "-");
      expect(fetchSlotOf(s)).toMatch(/^[a-z0-9_]{2,64}$/); // migration 016's CHECK on official_fetch_slots.series
    }
    // every series of a group has a parser for the group's page
    for (const s of fetchGroupOf("us_cpi_u_nsa_yoy")) expect(parseBlsSeries(s, fx("bls_cpi_nr0.html"))).toMatchObject({ ok: true });
  });
  it("thousands: exact integers, compared exactly, half-open ladder buckets from the labels", () => {
    expect([thousandsOf("162"), thousandsOf("-23"), thousandsOf(162), thousandsOf("16.5"), thousandsOf("162,000"), thousandsOf(1.5)]).toEqual([162, -23, 162, undefined, undefined, undefined]);
    expect(sameAtPrecision("us_nonfarm_payrolls_change", "162", 162)).toBe(true);
    expect(sameAtPrecision("us_nonfarm_payrolls_change", "162", "163")).toBe(false);
    expect([roundingFits("change_thousands", "thousands_as_printed"), roundingFits("change_thousands", "pct_1dp"), roundingFits("percent", "thousands_as_printed")]).toEqual([true, false, false]);
    const b = (l: string) => parseBucketLabel(l, "change_thousands")!;
    expect(b("<-50k")).toEqual({ label: "<-50k", hi: -50, hi_inclusive: false, lo_inclusive: true });
    expect(b("-50k to 0")).toEqual({ label: "-50k to 0", lo: -50, hi: 0, lo_inclusive: true, hi_inclusive: false });
    expect(b("200k+")).toEqual({ label: "200k+", lo: 200, lo_inclusive: true, hi_inclusive: true });
    // every integer lands in exactly one leg of the ladder; a boundary goes to the higher bracket
    const ladder = ["<-50k", "-50k to 0", "0 to 50k", "50k to 100k", "100k to 150k", "150k to 200k", "200k+"].map(b);
    for (const u of [-51, -50, -1, 0, 49, 50, 99, 100, 149, 150, 199, 200, 5000, -5000]) {
      const hits = ladder.filter((x) => bucketContains(x, "change_thousands", u)).map((x) => x.label);
      expect(hits, String(u)).toHaveLength(1);
    }
    expect(ladder.find((x) => bucketContains(x, "change_thousands", 50))!.label).toBe("50k to 100k");
    expect(ladder.find((x) => bucketContains(x, "change_thousands", -50))!.label).toBe("-50k to 0");
    expect(ladder.find((x) => bucketContains(x, "change_thousands", 0))!.label).toBe("0 to 50k");
    for (const x of ladder) expect(bucketProblem(x, "change_thousands")).toBeNull();
    expect(bucketProblem({ label: "x", lo: 1.5, hi: 2, lo_inclusive: true, hi_inclusive: false }, "change_thousands")).toMatch(/whole number of thousands/);
    expect([parseBucketLabel("0 to 50", "change_thousands"), parseBucketLabel("50k to 0", "change_thousands"), parseBucketLabel("about 100k", "change_thousands")]).toEqual([null, null, null]);
    // a bound without "k" must be zero: a mixed or unit-less label is never guessed
    expect([parseBucketLabel("50 to 100k", "change_thousands"), parseBucketLabel("<-50", "change_thousands"), parseBucketLabel("200+", "change_thousands"), parseBucketLabel("≥150", "change_thousands")]).toEqual([null, null, null, null]);
    const r = { series: "us_nonfarm_payrolls_change", period: "2026-09", release_at: "2026-10-02T12:30:00Z", bucket: b("0 to 50k"), rounding: "thousands_as_printed" } as OfficialResolver;
    expect(decidedUnits(r, { value: -23, value_text: "-23" })).toEqual({ units: -23, shown: "-23k" });
    expect(decidedUnits(r, { value: 16.5, value_text: "16.5" })).toMatchObject({ error: expect.stringContaining("whole thousands") });
  });
  it("percent series keep the 0.1 grid: the Polymarket CPI and unemployment labels parse, a negative print is in the ≤0.0% leg", () => {
    const p = (l: string) => parseBucketLabel(l, "percent")!;
    expect(bucketContains(p("≤0.0%"), "percent", -4)).toBe(true);
    expect(bucketContains(p("0.6%+"), "percent", 7)).toBe(true);
    expect(bucketContains(p("≥4.6%"), "percent", 46)).toBe(true);
  });
});

describe("registration of the new legs", () => {
  const TIE = " A value exactly on the boundary between two brackets settles in the higher bracket."; // paraphrased, as in evals/official.ts
  const group = (series: OfficialSeriesId, release_at: string): LegGroup => ({ series, period: "2026-09", release_at, title: "t" });
  const leg = (series: OfficialSeriesId, label: string, criteria = `criteria.${TIE}`, release_at = KNOWN_RELEASES[`${series}:2026-09`]!.release_at) =>
    buildLegRegistration({ platform: "polymarket", external_id: `x-${series}-${label}`, group: group(series, release_at), label, open_at: "2026-09-04T16:35:35Z", deadline_utc: "2026-10-03T03:59:00Z", criteria });
  const refusal = (input: unknown) => { try { validateRegistration(input); return null; } catch (e) { return String(e); } };
  it("every new series registers with its rounding; the platform deadline may precede the release", () => {
    for (const [s, label] of [["us_cpi_u_sa_mom", "≤0.0%"], ["us_core_cpi_nsa_yoy", "2.4%"], ["us_core_cpi_sa_mom", "0.6%+"], ["us_unemployment_rate", "4.1%"], ["us_nonfarm_payrolls_change", "<-50k"]] as const) {
      const r = leg(s, label);
      if (!r.ok) throw new Error(r.reason);
      expect(validateRegistration(r.market).resolver).toMatchObject({ series: s, rounding: OFFICIAL_SERIES[s].rounding });
    }
    const early = buildLegRegistration({ platform: "polymarket", external_id: "4217156", group: group("us_unemployment_rate", "2026-10-02T12:30:00Z"), label: "4.1%", open_at: "2026-09-04T16:35:35Z", deadline_utc: "2026-10-02T08:30:00Z", criteria: "c" });
    if (!early.ok) throw new Error(early.reason);
    expect(refusal(early.market)).toBeNull();
  });
  it("a thousands ladder is refused when its text does not settle a boundary value in the higher bracket", () => {
    const r = leg("us_nonfarm_payrolls_change", "50k to 100k", "criteria without a tie rule");
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("exactly on a boundary") });
  });
  it("the release time, rounding and prior level are checked against the series", () => {
    const r = leg("us_nonfarm_payrolls_change", "200k+");
    if (!r.ok) throw new Error(r.reason);
    const m = r.market;
    const withR = (over: Record<string, unknown>) => ({ ...m, resolver: { ...(m.resolver as object), ...over } });
    expect(refusal(withR({ release_at: "2026-10-02T08:30:00Z" }))).toContain("differs from the scheduled release");
    expect(refusal(withR({ rounding: "pct_1dp" }))).toContain("does not fit us_nonfarm_payrolls_change");
    expect(refusal(withR({ prior_level: 162 }))).toContain("prior_level must be absent");
    expect(refusal(withR({ bucket: { label: "x", lo: 0.5, lo_inclusive: true, hi_inclusive: true } }))).toContain("whole number of thousands");
    const cpi = leg("us_cpi_u_sa_mom", "0.2%");
    if (!cpi.ok) throw new Error(cpi.reason);
    expect(refusal({ ...cpi.market, resolver: { ...(cpi.market.resolver as object), rounding: "thousands_as_printed" } })).toContain("does not fit us_cpi_u_sa_mom");
  });
  // The leg file copies platform market texts, so it lives in the gitignored private/ folder (founder machine only).
  const LEG_FILE = resolve(import.meta.dirname, "../private/shadow-markets/official-release-bls-2026-09-27.json");
  it.skipIf(!existsSync(LEG_FILE))("every leg of the private BLS leg file passes registration, names its event's scheduled release and covers its ladder", () => {
    const file = JSON.parse(readFileSync(LEG_FILE, "utf8")) as { entries: Array<{ market: MarketRegistration }>; skipped: unknown[] };
    expect(file.entries).toHaveLength(42);
    expect(file.skipped).toEqual([]);
    const perSeries = new Map<string, number>();
    for (const e of file.entries) {
      const reg = validateRegistration(e.market);
      const r = reg.resolver as OfficialResolver;
      expect(Date.parse(r.release_at), `${reg.external_id}`).toBe(Date.parse(KNOWN_RELEASES[`${r.series}:${r.period}`]!.release_at));
      perSeries.set(r.series, (perSeries.get(r.series) ?? 0) + 1);
    }
    expect(Object.fromEntries(perSeries)).toEqual({ us_cpi_u_sa_mom: 9, us_core_cpi_nsa_yoy: 10, us_core_cpi_sa_mom: 7, us_unemployment_rate: 9, us_nonfarm_payrolls_change: 7 });
  });
});

describe("a first print first seen at or after the market's fallback decides nothing (released_after_fallback)", () => {
  const legOf = (series: OfficialSeriesId, label: string) => {
    const k = KNOWN_RELEASES[`${series}:2026-09`]!;
    const r = buildLegRegistration({ platform: "polymarket", external_id: `fb-${series}`, group: { series, period: "2026-09", release_at: k.release_at, title: "t" }, label, open_at: "2026-09-04T00:00:00Z", deadline_utc: "2026-10-15T03:59:00Z", criteria: "A value exactly on the boundary between two brackets settles in the higher bracket." });
    if (!r.ok) throw new Error(r.reason);
    return r.market;
  };
  // SYNTHETIC September prints, observed at the given time
  const decide = (series: OfficialSeriesId, label: string, value_text: string, deciding_text: string, observed_at: string) => {
    const { evidence } = officialEvidence({ kind: "official_observation", series, period: "2026-09", value: Number(value_text), value_text, deciding_text, source_url: OFFICIAL_SERIES[series].primaryUrl, raw_sha256: "a".repeat(64), observed_at, direction: null, corroboration: null }, observed_at);
    return decideOfficial(legOf(series, label), evidence);
  };
  const PAY = "THE EMPLOYMENT SITUATION - SEPTEMBER 2026: Total nonfarm payroll employment rose by 22,000 in September.";
  const LATE = { status: "UNRESOLVED", outcome: "NONE", caveats: ["released_after_fallback"] };
  it("payrolls and the unemployment rate: 'by the date' of the October data (Nov 6) is read from 00:00 ET that day", () => {
    expect(decide("us_nonfarm_payrolls_change", "0 to 50k", "22", PAY, "2026-10-20T14:00:00Z")).toMatchObject({ status: "RESOLVED", outcome: "OPTION_A" }); // delayed, still inside the window
    expect(decide("us_nonfarm_payrolls_change", "0 to 50k", "22", PAY, "2026-11-06T04:59:59Z")).toMatchObject({ status: "RESOLVED", outcome: "OPTION_A" });
    expect(decide("us_nonfarm_payrolls_change", "0 to 50k", "22", PAY, "2026-11-06T05:00:00Z")).toMatchObject(LATE);
    expect(decide("us_nonfarm_payrolls_change", "0 to 50k", "22", PAY, "2026-11-06T13:29:00Z")).toMatchObject(LATE); // on the date itself: ambiguous, so no verdict
    expect(decide("us_nonfarm_payrolls_change", "150k to 200k", "22", PAY, "2026-11-09T14:00:00Z")).toMatchObject(LATE); // never a positive No either
    expect(decide("us_unemployment_rate", "4.3%", "4.3", "THE EMPLOYMENT SITUATION - SEPTEMBER 2026: The unemployment rate rose to 4.3 percent in September.", "2026-11-12T14:00:00Z")).toMatchObject(LATE);
  });
  it("the CPI series (the live headline one too): from the next CPI release time, Nov 10 08:30 ET", () => {
    const text = "CONSUMER PRICE INDEX - SEPTEMBER 2026: Table A, All items, Seasonally adjusted changes from preceding month, Sep. 2026: 0.2";
    expect(decide("us_cpi_u_sa_mom", "0.2%", "0.2", text, "2026-11-10T13:29:59Z")).toMatchObject({ status: "RESOLVED", outcome: "OPTION_A" });
    expect(decide("us_cpi_u_sa_mom", "0.2%", "0.2", text, "2026-11-10T13:30:00Z")).toMatchObject(LATE);
    expect(decide("us_cpi_u_nsa_yoy", "3.4%", "3.4", "CONSUMER PRICE INDEX - SEPTEMBER 2026: Over the last 12 months, the all items index increased 3.4 percent before seasonal adjustment.", "2026-11-11T14:00:00Z")).toMatchObject(LATE);
  });
});

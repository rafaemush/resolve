/**
 * Frozen official_release cases: real response bodies saved on 2026-09-24 (evals/fixtures/official/, provenance.json)
 * are parsed at run time by the production parsers, turned into the rail's document, and resolved by the production
 * resolver with a Jev caller that fails the case if it is ever called. Grader = equality only.
 *   npx tsx evals/official.ts            run the frozen cases (exit 1 on any failure)
 *   npx tsx evals/official.ts --build    freeze the authored cases to evals/official-cases/cases.jsonl + manifest.sha256
 *   npx tsx evals/official.ts --check    fail if the frozen files differ from the authored cases (CI guard)
 * Groups: release_gate (rail official_release_gate), first_print (rail first_print_lock). evals/mutate.ts switches each
 * rail off and requires its group to go red while the same group with every rail on stays green; the control cases
 * inside each group resolve the same way with the rail on or off, so a red can only come from the removed rail.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { MarketRegistration, type MarketRegistration as Reg } from "../src/resolve/schema";
import { resolveMarket } from "../src/resolve";
import { DEFAULT_THRESHOLDS } from "../src/resolve/thresholds";
import {
  firstPrintFor, officialEvidence, sameAtPrecision, reading, type OfficialCorroboration, type OfficialObservationDoc, type OfficialSeriesId,
} from "../src/resolve/official";
import {
  parseBlsRelease, parseBlsApi, blsApiYoy, parseFomcStatement, fredValueOn, parseEcbRelease, parseEcbDfrCsv, parseBoeRss, iadbValueOn,
  parseBokDecisionRss, parseBokGdpRss, parseEcosRows, parseBcbHistory, type DocObservation,
} from "../src/ingest/official-parse";
import { buildLegRegistration, type LegGroup } from "../src/markets/official-legs";
import { officialFixture, officialFixtureBytes, OFFICIAL_FIXTURE_DIR } from "./lib/official-fixtures";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const DIR = resolve(process.cwd(), "evals/official-cases");
const CASES_FILE = resolve(DIR, "cases.jsonl");
const MANIFEST = resolve(DIR, "manifest.sha256");

export type OfficialGroup = "release_gate" | "first_print";
type Parser = "bls_cpi_text" | "bls_ppi_text" | "bls_api_yoy" | "fed_statement" | "ecb_release" | "boe_rss" | "bok_decision_rss" | "bok_gdp_rss" | "ecos_quarter" | "bcb_latest_row" | "bcb_history" | "sgs432_row";
type CorrParser = "bls_api_yoy" | "fred" | "ecb_dfr" | "iadb" | "ecos_daily" | "ecos_quarter" | "single_source";
/**
 * own_capture: this market's own watch made the observation (default). For events outside KNOWN_RELEASES the
 * release-time part of gate 1 applies only to such observations (src/resolve/official.ts).
 */
interface Read { fixture: string; parser: Parser; select?: string; observed_at: string; own_capture?: boolean; corroboration?: { fixture?: string; parser: CorrParser; select?: string } }
interface Expect { status: "RESOLVED" | "UNRESOLVED" | "ERROR"; outcome: "OPTION_A" | "OPTION_B" | "NONE"; caveats_include?: readonly string[]; error_reason?: string }
export interface OfficialCase { id: string; group: OfficialGroup; control: boolean; title: string; market: Reg; stored?: Read; fetched: Read; expect: Expect }

// ---- authored cases ------------------------------------------------------------------------------------------------

const YES = { status: "RESOLVED", outcome: "OPTION_A", caveats_include: ["first_print"] } as const;
const NO = { status: "RESOLVED", outcome: "OPTION_B", caveats_include: ["first_print"] } as const;
const AWAIT = { status: "UNRESOLVED", outcome: "NONE", caveats_include: ["awaiting_release"] } as const;

function leg(group: LegGroup, label: string, open_at: string, deadline_utc: string, platform: "limitless" | "polymarket" = "limitless"): Reg {
  const r = buildLegRegistration({ platform, external_id: `eval-${group.series}-${group.period}-${label}`, group, label, open_at, deadline_utc, criteria: `Frozen eval leg for ${group.title}.` });
  if (!r.ok) throw new Error(r.reason);
  return r.market;
}
// Target events (Limitless ladders, research 2026-09-24) and past events the saved bodies are about.
const CPI_SEP: LegGroup = { series: "us_cpi_u_nsa_yoy", period: "2026-09", release_at: "2026-10-14T12:30:00Z", title: "September Inflation US - Annual" };
const CPI_AUG: LegGroup = { series: "us_cpi_u_nsa_yoy", period: "2026-08", release_at: "2026-09-11T12:30:00Z", title: "August Inflation US - Annual (past event)" };
const PPI_AUG: LegGroup = { series: "us_ppi_fd_nsa_yoy", period: "2026-08", release_at: "2026-09-10T12:30:00Z", title: "PPI YoY - August 2026 (past event)" };
const FED_OCT: LegGroup = { series: "fomc_upper_bound", period: "2026-10-28", release_at: "2026-10-28T18:00:00Z", prior_level: 4.0, title: "Fed Decision in October?" };
const FED_SEP: LegGroup = { series: "fomc_upper_bound", period: "2026-09-16", release_at: "2026-09-16T18:00:00Z", prior_level: 3.75, title: "Fed Decision in September? (past event)" };
const ECB_OCT: LegGroup = { series: "ecb_dfr", period: "2026-10-29", release_at: "2026-10-29T13:15:00Z", prior_level: 2.5, title: "ECB Interest Rates: October 2026" };
const ECB_SEP: LegGroup = { series: "ecb_dfr", period: "2026-09-10", release_at: "2026-09-10T12:15:00Z", prior_level: 2.25, title: "ECB Interest Rates: September 2026 (past event)" };
const BOE_NOV: LegGroup = { series: "boe_bank_rate", period: "2026-11-05", release_at: "2026-11-05T12:00:00Z", prior_level: 3.75, title: "Bank of England decision in November?" };
const BOE_SEP: LegGroup = { series: "boe_bank_rate", period: "2026-09-17", release_at: "2026-09-17T11:00:00Z", prior_level: 3.75, title: "Bank of England decision in September? (past event)" };
const BOK_OCT: LegGroup = { series: "bok_base_rate", period: "2026-10-22", release_at: "2026-10-22T01:00:00Z", prior_level: 3.0, title: "Bank of Korea decision in October?" };
const BOK_AUG: LegGroup = { series: "bok_base_rate", period: "2026-08-27", release_at: "2026-08-27T01:00:00Z", prior_level: 2.75, title: "Bank of Korea decision in August? (past event)" };
const BOK_JUL: LegGroup = { series: "bok_base_rate", period: "2026-07-16", release_at: "2026-07-16T01:00:00Z", prior_level: 2.5, title: "Bank of Korea decision in July? (past event)" };
const BOK_MAY: LegGroup = { series: "bok_base_rate", period: "2026-05-28", release_at: "2026-05-28T01:00:00Z", prior_level: 2.5, title: "Bank of Korea decision in May? (past event)" };
const GDP_Q3: LegGroup = { series: "kr_gdp_advance_yoy", period: "2026-Q3", release_at: "2026-10-26T23:00:00Z", title: "South Korea GDP growth (YoY) in Q3 2026?" };
const GDP_Q2: LegGroup = { series: "kr_gdp_advance_yoy", period: "2026-Q2", release_at: "2026-07-22T23:00:00Z", title: "South Korea GDP growth (YoY) in Q2 2026? (past event)" };
const GDP_Q1: LegGroup = { series: "kr_gdp_advance_yoy", period: "2026-Q1", release_at: "2026-04-22T23:00:00Z", title: "South Korea GDP growth (YoY) in Q1 2026? (past event, finer ladder)" };
const BCB_NOV: LegGroup = { series: "bcb_selic_target", period: "2026-11-04", release_at: "2026-11-04T21:30:00Z", prior_level: 13.75, title: "Bank of Brazil decision in November?" };
const BCB_SEP: LegGroup = { series: "bcb_selic_target", period: "2026-09-16", release_at: "2026-09-16T21:30:00Z", prior_level: 14.0, title: "Bank of Brazil decision in September? (past event)" };

// When each saved body was fetched (provenance.json); a past event read then is at or after its release.
const AT = {
  cpi: "2026-09-24T13:15:14Z", ppi: "2026-09-24T13:15:35Z", blsApiCpi: "2026-09-24T13:14:54Z", blsApiPpi: "2026-09-24T13:14:56Z", fed: "2026-09-24T13:16:32Z",
  ecb: "2026-09-24T13:17:24Z", boe: "2026-09-24T13:22:52Z", bok: "2026-09-24T13:21:22Z", press: "2026-09-24T13:26:16Z", ecosGdp: "2026-09-24T13:20:35Z",
  bcb: "2026-09-24T13:22:00Z", sgs: "2026-09-24T13:21:56Z",
};
const cpiText = (observed_at: string, corr = true): Read => ({ fixture: "bls_cpi_nr0.html", parser: "bls_cpi_text", observed_at, ...(corr ? { corroboration: { fixture: "bls_v1_cpi.json", parser: "bls_api_yoy" as const, select: "2026-08" } } : {}) });
const ppiText = (observed_at: string): Read => ({ fixture: "bls_ppi_nr0.html", parser: "bls_ppi_text", observed_at, corroboration: { fixture: "bls_v1_ppi.json", parser: "bls_api_yoy", select: "2026-08" } });
const fedSep = (observed_at: string): Read => ({ fixture: "fed_monetary20260916a.html", parser: "fed_statement", observed_at, corroboration: { fixture: "fred_dfedtaru.csv", parser: "fred", select: "2026-09-17" } });
const ecbSep = (observed_at: string): Read => ({ fixture: "ecb_mp260910.html", parser: "ecb_release", observed_at, corroboration: { fixture: "ecb_dfr.csv", parser: "ecb_dfr", select: "2026-09-16" } });
const boeSep = (observed_at: string): Read => ({ fixture: "boe_rss_news.xml", parser: "boe_rss", select: "September 2026", observed_at, corroboration: { fixture: "boe_iadb_iudbedr.csv", parser: "iadb", select: "2026-09-17" } });
const bokAug = (observed_at: string): Read => ({ fixture: "bok_rss_mpd.xml", parser: "bok_decision_rss", select: "2026-08-27", observed_at, corroboration: { fixture: "ecos_722Y001_20260824_20260902.json", parser: "ecos_daily", select: "20260827" } });
const gdpQ2 = (observed_at: string): Read => ({ fixture: "bok_rss_press.xml", parser: "bok_gdp_rss", select: "2026-Q2", observed_at, corroboration: { fixture: "ecos_200Y102_10211.json", parser: "ecos_quarter", select: "2026Q2" } });
const gdpQ1First: Read = { fixture: "bok_rss_press.xml", parser: "bok_gdp_rss", select: "2026-Q1", observed_at: "2026-04-22T23:00:40Z" };
const gdpQ1Revised: Read = { fixture: "ecos_200Y102_10211.json", parser: "ecos_quarter", select: "2026Q1", observed_at: AT.ecosGdp };

export function authorCases(): OfficialCase[] {
  const target = { open: "2026-09-15T08:56:56.799Z" };
  return [
    // --- release_gate: observations the gate must refuse (red when the rail is off) ---------------------------
    { id: "OFF-G01", group: "release_gate", control: false, title: "CPI: the August release read at 12:29Z on Oct 14, one minute before the September release, never resolves the September 3.4% leg", market: leg(CPI_SEP, "3.4%", target.open, "2026-10-15T03:59:00Z"), fetched: cpiText("2026-10-14T12:29:00Z"), expect: AWAIT },
    { id: "OFF-G02", group: "release_gate", control: false, title: "CPI: after 12:30Z the page still names AUGUST 2026 (a delayed release): never resolved from the older period", market: leg(CPI_SEP, "3.4%", target.open, "2026-10-15T03:59:00Z"), fetched: cpiText("2026-10-14T12:35:00Z"), expect: AWAIT },
    { id: "OFF-G03", group: "release_gate", control: false, title: "FOMC: the September 16 statement read after the October 28 release time is not the October decision", market: leg(FED_OCT, "No change", "2026-06-17T19:03:23Z", "2026-10-28T23:59:00Z"), fetched: fedSep("2026-10-28T18:00:05Z"), expect: AWAIT },
    { id: "OFF-G04", group: "release_gate", control: false, title: "ECB: the September 10 decisions release is not the October 29 decision", market: leg(ECB_OCT, "No change", "2026-09-10T15:00:00Z", "2026-10-29T11:59:00Z"), fetched: ecbSep("2026-10-29T13:15:05Z"), expect: AWAIT },
    { id: "OFF-G05", group: "release_gate", control: false, title: "BoE: 'Bank rate maintained at 3.75% - September 2026' does not name November 2026", market: leg(BOE_NOV, "No change", "2026-09-18T00:00:00Z", "2026-11-05T23:59:00Z"), fetched: boeSep("2026-11-05T12:00:05Z"), expect: AWAIT },
    { id: "OFF-G06", group: "release_gate", control: false, title: "BoK: the August 27 decision item is not the October 22 decision", market: leg(BOK_OCT, "No Change", "2026-08-28T00:00:00Z", "2026-10-22T00:00:00Z"), fetched: bokAug("2026-10-22T01:00:05Z"), expect: AWAIT },
    { id: "OFF-G07", group: "release_gate", control: false, title: "Korea GDP: the Q2 advance estimate is not Q3", market: leg(GDP_Q3, "3.5–3.9%", "2026-07-24T00:00:00Z", "2026-10-27T00:00:00Z"), fetched: gdpQ2("2026-10-26T23:00:05Z"), expect: AWAIT },
    { id: "OFF-G09", group: "release_gate", control: false, title: "BoK: on July 16 the newest item may still be May 28 ('unchanged at 2.50%', consistent with the 2.50 prior); it is not the July decision, which raised to 2.75%", market: leg(BOK_JUL, "No Change", "2026-05-29T00:00:00Z", "2026-07-16T00:00:00Z"), fetched: { fixture: "bok_rss_mpd.xml", parser: "bok_decision_rss", select: "2026-05-28", observed_at: "2026-07-16T01:00:05Z" }, expect: AWAIT },
    { id: "OFF-G10", group: "release_gate", control: false, title: "CPI August 2026: the right document, captured by this market's own watch at 12:29Z, a minute before its scheduled release, never resolves", market: leg(CPI_AUG, "3.4%", "2026-08-01T00:00:00Z", "2026-09-12T03:59:00Z"), fetched: { ...cpiText("2026-09-11T12:29:00Z"), own_capture: true }, expect: AWAIT },
    { id: "OFF-G08", group: "release_gate", control: false, title: "BCB: the latest Copom row read on Sep 24 (meeting 281, 13.75) is not the November 4 meeting", market: leg(BCB_NOV, "No Change", "2026-09-17T00:00:00Z", "2026-11-04T11:59:00Z"), fetched: { fixture: "bcb_historicotaxasjuros.json", parser: "bcb_latest_row", observed_at: AT.bcb, corroboration: { parser: "single_source" } }, expect: AWAIT },
    // --- release_gate controls: the same parsers on their own events resolve with the rail on or off -------------
    { id: "OFF-C01", group: "release_gate", control: true, title: "CPI August 2026 (3.4, API agrees): the 3.4% leg is Yes", market: leg(CPI_AUG, "3.4%", "2026-08-01T00:00:00Z", "2026-09-12T03:59:00Z"), fetched: cpiText(AT.cpi), expect: YES },
    { id: "OFF-C02", group: "release_gate", control: true, title: "CPI August 2026: the 3.3% leg is a positive No", market: leg(CPI_AUG, "3.3%", "2026-08-01T00:00:00Z", "2026-09-12T03:59:00Z"), fetched: cpiText(AT.cpi), expect: NO },
    { id: "OFF-C03", group: "release_gate", control: true, title: "PPI August 2026 (5.4, API agrees): the 5.4% leg is Yes", market: leg(PPI_AUG, "5.4%", "2026-08-01T00:00:00Z", "2026-09-11T03:59:00Z"), fetched: ppiText(AT.ppi), expect: YES },
    { id: "OFF-C04", group: "release_gate", control: true, title: "PPI August 2026: the ≤5.0% leg is a positive No", market: leg(PPI_AUG, "≤5.0%", "2026-08-01T00:00:00Z", "2026-09-11T03:59:00Z"), fetched: ppiText(AT.ppi), expect: NO },
    { id: "OFF-C05", group: "release_gate", control: true, title: "FOMC September 16 ('3-3/4 to 4' vs prior 3.75; FRED 09-17 = 4.00): the 25 bps increase leg is Yes", market: leg(FED_SEP, "25 bps increase", "2026-07-30T00:00:00Z", "2026-09-16T23:59:00Z"), fetched: fedSep(AT.fed), expect: YES },
    { id: "OFF-C06", group: "release_gate", control: true, title: "FOMC September 16: the No change leg is a positive No", market: leg(FED_SEP, "No change", "2026-07-30T00:00:00Z", "2026-09-16T23:59:00Z"), fetched: fedSep(AT.fed), expect: NO },
    { id: "OFF-C07", group: "release_gate", control: true, title: "ECB September 10 (DFR 2.50 vs prior 2.25; data API 09-16 = 2.5): the 25 bps increase leg is Yes", market: leg(ECB_SEP, "25 bps increase", "2026-07-24T00:00:00Z", "2026-09-10T11:59:00Z"), fetched: ecbSep(AT.ecb), expect: YES },
    { id: "OFF-C08", group: "release_gate", control: true, title: "BoE September 17 ('maintained at 3.75%'; IADB = 3.75): the No change leg is Yes", market: leg(BOE_SEP, "No change", "2026-08-01T00:00:00Z", "2026-09-17T23:59:00Z"), fetched: boeSep(AT.boe), expect: YES },
    { id: "OFF-C09", group: "release_gate", control: true, title: "BoK August 27 (2.75% -> 3.00%; ECOS 20260827 = 3): the 25 bps hike leg is Yes", market: leg(BOK_AUG, "25 bps hike", "2026-07-17T00:00:00Z", "2026-08-27T00:00:00Z"), fetched: bokAug(AT.bok), expect: YES },
    { id: "OFF-C15", group: "release_gate", control: true, title: "CPI August 2026 (not a registered event): another market's capture of the right document resolves this leg, whatever this market's release_at", market: leg({ ...CPI_AUG, release_at: "2026-09-11T13:00:00Z" }, "3.4%", "2026-08-01T00:00:00Z", "2026-09-12T03:59:00Z"), fetched: { ...cpiText("2026-09-11T12:30:04Z"), own_capture: false }, expect: YES },
    { id: "OFF-C14", group: "release_gate", control: true, title: "BoK July 16 (2.50% -> 2.75%): the 25 bps hike leg is Yes", market: leg(BOK_JUL, "25 bps hike", "2026-05-29T00:00:00Z", "2026-07-16T00:00:00Z"), fetched: { fixture: "bok_rss_mpd.xml", parser: "bok_decision_rss", select: "2026-07-16", observed_at: AT.bok }, expect: { ...YES, caveats_include: ["first_print", "corroboration_unavailable"] } },
    { id: "OFF-C10", group: "release_gate", control: true, title: "BoK May 28 ('unchanged at 2.50%'): the No Change leg is Yes, corroboration unavailable", market: leg(BOK_MAY, "No Change", "2026-04-11T00:00:00Z", "2026-05-28T00:00:00Z"), fetched: { fixture: "bok_rss_mpd.xml", parser: "bok_decision_rss", select: "2026-05-28", observed_at: AT.bok }, expect: { ...YES, caveats_include: ["first_print", "corroboration_unavailable"] } },
    { id: "OFF-C11", group: "release_gate", control: true, title: "Korea GDP Q2 advance 3.7 (ECOS 2026Q2 = 3.7): the 3.5–3.9% leg is Yes", market: leg(GDP_Q2, "3.5–3.9%", "2026-04-24T00:00:00Z", "2026-07-23T00:00:00Z"), fetched: gdpQ2(AT.press), expect: YES },
    { id: "OFF-C12", group: "release_gate", control: true, title: "BCB meeting 281 of Sep 16 (13.75 vs prior 14.00): the 25 bps decrease leg is Yes, single source", market: leg(BCB_SEP, "25 bps decrease", "2026-08-06T00:00:00Z", "2026-09-16T11:59:00Z"), fetched: { fixture: "bcb_historicotaxasjuros.json", parser: "bcb_history", select: "2026-09-16", observed_at: AT.bcb, corroboration: { parser: "single_source" } }, expect: { ...YES, caveats_include: ["first_print", "single_source"] } },
    { id: "OFF-C13", group: "release_gate", control: true, title: "BCB: the SGS 432 row forward-filled to 04/11/2026 (13.75) never counts: api.bcb.gov.br is not the Copom history source", market: leg(BCB_NOV, "No Change", "2026-09-17T00:00:00Z", "2026-11-04T11:59:00Z"), fetched: { fixture: "bcb_sgs432_ultimos3.json", parser: "sgs432_row", select: "04/11/2026", observed_at: "2026-11-04T21:31:00Z" }, expect: { status: "ERROR", outcome: "NONE", error_reason: "SOURCE_REF_MISMATCH" } },

    // --- first_print: a later, revised read must never replace the stored first print --------------------------
    { id: "OFF-F01", group: "first_print", control: false, title: "Korea GDP Q1 2026: advance first print 3.6, ECOS now 3.8 (revised): the 3.6% leg stays Yes", market: leg(GDP_Q1, "3.6%", "2026-01-24T00:00:00Z", "2026-04-23T00:00:00Z"), stored: gdpQ1First, fetched: gdpQ1Revised, expect: { ...YES, caveats_include: ["first_print"] } },
    { id: "OFF-F02", group: "first_print", control: false, title: "Korea GDP Q1 2026: the 3.8% leg stays a positive No although the latest vintage says 3.8", market: leg(GDP_Q1, "3.8%", "2026-01-24T00:00:00Z", "2026-04-23T00:00:00Z"), stored: gdpQ1First, fetched: gdpQ1Revised, expect: NO },
    { id: "OFF-F03", group: "first_print", control: false, title: "Korea GDP Q1 2026: the ≥3.7% leg stays No", market: leg(GDP_Q1, "≥3.7%", "2026-01-24T00:00:00Z", "2026-04-23T00:00:00Z"), stored: gdpQ1First, fetched: gdpQ1Revised, expect: NO },
    // --- first_print controls: the lock is invisible when the later read agrees or no first print exists --------
    { id: "OFF-FC1", group: "first_print", control: true, title: "Korea GDP Q1 2026 on the real 3.5–3.9% bucket: Yes whichever vintage is read", market: leg(GDP_Q1, "3.5–3.9%", "2026-01-24T00:00:00Z", "2026-04-23T00:00:00Z"), stored: gdpQ1First, fetched: gdpQ1Revised, expect: YES },
    { id: "OFF-FC2", group: "first_print", control: true, title: "CPI August 2026: the API's 3.4 agrees with the stored 3.4", market: leg(CPI_AUG, "3.4%", "2026-08-01T00:00:00Z", "2026-09-12T03:59:00Z"), stored: cpiText(AT.cpi), fetched: { fixture: "bls_v1_cpi.json", parser: "bls_api_yoy", select: "2026-08", observed_at: AT.blsApiCpi }, expect: YES },
    { id: "OFF-FC3", group: "first_print", control: true, title: "PPI August 2026: the API's 5.4 agrees with the stored 5.4", market: leg(PPI_AUG, "5.4%", "2026-08-01T00:00:00Z", "2026-09-11T03:59:00Z"), stored: ppiText(AT.ppi), fetched: { fixture: "bls_v1_ppi.json", parser: "bls_api_yoy", select: "2026-08", observed_at: AT.blsApiPpi }, expect: YES },
    { id: "OFF-FC4", group: "first_print", control: true, title: "Korea GDP Q2: no stored first print yet, the first read decides", market: leg(GDP_Q2, "3.5–3.9%", "2026-04-24T00:00:00Z", "2026-07-23T00:00:00Z"), fetched: gdpQ2(AT.press), expect: YES },
  ];
}

// ---- building the rail's document from a saved body ---------------------------------------------------------------

const PROVENANCE = JSON.parse(readFileSync(resolve(OFFICIAL_FIXTURE_DIR, "provenance.json"), "utf8")) as { files: Record<string, { url: string }> };
const urlOf = (fixture: string) => { const u = PROVENANCE.files[fixture]?.url; if (!u) throw new Error(`no url for ${fixture}`); return u; };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function parse(read: Read): DocObservation {
  const body = officialFixture(read.fixture);
  const need = (p: { ok: true; obs: DocObservation } | { ok: false; reason: string; detail: string }) => { if (!p.ok) throw new Error(`${read.fixture} ${read.parser}: ${p.reason} ${p.detail}`); return p.obs; };
  switch (read.parser) {
    case "bls_cpi_text": return need(parseBlsRelease(body, "cpi"));
    case "bls_ppi_text": return need(parseBlsRelease(body, "ppi"));
    case "fed_statement": return need(parseFomcStatement(body));
    case "ecb_release": return need(parseEcbRelease(body));
    case "boe_rss": return need(parseBoeRss(body, read.select!));
    case "bok_decision_rss": return need(parseBokDecisionRss(body, read.select!));
    case "bok_gdp_rss": return need(parseBokGdpRss(body, read.select!));
    case "bcb_history": return need(parseBcbHistory(body, read.select!));
    case "bls_api_yoy": {
      const id = read.fixture.includes("cpi") ? "CUUR0000SA0" : "WPUFD4";
      const p = parseBlsApi(body, id);
      const y = p.ok ? blsApiYoy(p.index, read.select!) : undefined;
      if (!y) throw new Error(`${read.fixture}: no ${read.select}`);
      const [yy, mm] = read.select!.split("-");
      const month = MONTHS[Number(mm) - 1];
      const v = (y.tenths / 10).toFixed(1);
      return { period: read.select!, value: Number(v), value_text: v, deciding_text: `BLS API v1 ${id}: ${month} ${yy} index ${y.current} over ${month} ${Number(yy) - 1} index ${y.base} = ${v} percent`, direction: null, meta: {} };
    }
    case "ecos_quarter": {
      const p = parseEcosRows(body);
      const row = p.ok ? p.rows.find((r) => r.time === read.select) : undefined;
      if (!row) throw new Error(`${read.fixture}: no ${read.select}`);
      return { period: `${row.time.slice(0, 4)}-${row.time.slice(4)}`, value: Number(row.value), value_text: row.value, deciding_text: `ECOS 200Y102 item 10211 (${row.item}, percent change over previous year) ${row.time} = ${row.value}`, direction: null, meta: {} };
    }
    case "bcb_latest_row": {
      // what a reader that takes the newest row instead of the meeting's row sees
      const rows = (JSON.parse(body) as { conteudo: Array<{ DataReuniaoCopom: string }> }).conteudo;
      const latest = rows.map((r) => new Date(Date.parse(r.DataReuniaoCopom) - 3 * 3600_000).toISOString().slice(0, 10)).sort().pop()!;
      return parse({ ...read, parser: "bcb_history", select: latest });
    }
    case "sgs432_row": {
      // SGS 432 forward-fills future dates with the current target: the row exists before the meeting happens
      const row = (JSON.parse(body) as Array<{ data: string; valor: string }>).find((r) => r.data === read.select);
      if (!row) throw new Error(`${read.fixture}: no ${read.select}`);
      const [d, m, y] = row.data.split("/");
      return { period: `${y}-${m}-${d}`, value: Number(row.valor), value_text: row.valor, deciding_text: `SGS 432 ${row.data} = ${row.valor}`, direction: null, meta: {} };
    }
    default: { const never: never = read.parser; throw new Error(`unhandled parser ${String(never)}`); }
  }
}

function corroborate(series: OfficialSeriesId, obs: DocObservation, spec: Read["corroboration"], at: string): OfficialCorroboration | null {
  if (!spec) return null;
  if (spec.parser === "single_source") return { status: "single_source", source_url: null, value: null, value_text: null, detail: "SGS 432 forward-fills; the Copom history row is the only source", checked_at: at };
  const body = officialFixture(spec.fixture!);
  let v: string | undefined;
  switch (spec.parser) {
    case "bls_api_yoy": { const p = parseBlsApi(body, spec.fixture!.includes("cpi") ? "CUUR0000SA0" : "WPUFD4"); const y = p.ok ? blsApiYoy(p.index, spec.select!) : undefined; v = y ? (y.tenths / 10).toFixed(1) : undefined; break; }
    case "fred": v = fredValueOn(body, spec.select!); break;
    case "ecb_dfr": v = parseEcbDfrCsv(body).find((r) => r.date === spec.select)?.value; break;
    case "iadb": v = iadbValueOn(body, spec.select!); break;
    case "ecos_daily": case "ecos_quarter": { const p = parseEcosRows(body); v = p.ok ? p.rows.find((r) => r.time === spec.select)?.value : undefined; break; }
    default: { const never: never = spec.parser; throw new Error(`unhandled corroboration ${String(never)}`); }
  }
  if (v === undefined) throw new Error(`${spec.fixture}: no corroboration row ${spec.select}`);
  return { status: sameAtPrecision(series, reading(obs), v) ? "agree" : "disagree", source_url: urlOf(spec.fixture!), value: Number(v), value_text: v, detail: `${spec.parser} ${spec.select} = ${v}`, checked_at: at };
}

function docOf(series: OfficialSeriesId, read: Read): OfficialObservationDoc {
  const obs = parse(read);
  return {
    kind: "official_observation", series, period: obs.period, value: obs.value, value_text: obs.value_text, deciding_text: obs.deciding_text,
    source_url: urlOf(read.fixture), raw_sha256: sha(officialFixtureBytes(read.fixture)), observed_at: new Date(read.observed_at).toISOString(),
    direction: obs.direction, corroboration: corroborate(series, obs, read.corroboration, new Date(read.observed_at).toISOString()),
    stated_prior: typeof obs.meta.stated_prior === "string" ? obs.meta.stated_prior : null,
    stated_step_bps: typeof obs.meta.stated_step_bps === "number" ? obs.meta.stated_step_bps : null,
  };
}

// ---- frozen file + manifest ------------------------------------------------------------------------------------------

export function renderCases(): { body: string; manifest: string } {
  const ids = new Set<string>();
  const lines = authorCases().map((k) => {
    if (ids.has(k.id)) throw new Error(`duplicate case id ${k.id}`);
    ids.add(k.id);
    const m = MarketRegistration.safeParse(k.market);
    if (!m.success) throw new Error(`${k.id}: market invalid: ${m.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
    return JSON.stringify({ ...k, market: m.data });
  });
  const body = lines.join("\n") + "\n";
  return { body, manifest: `${sha(body)}  cases.jsonl\n` };
}

export function loadOfficialCases(): { cases: OfficialCase[]; suite: string } {
  const [h] = readFileSync(MANIFEST, "utf8").trim().split("  ");
  const body = readFileSync(CASES_FILE, "utf8");
  if (sha(body) !== h) throw new Error("evals/official-cases/cases.jsonl does not match its manifest — run npx tsx evals/official.ts --build and commit");
  return { cases: body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as OfficialCase), suite: h! };
}

// ---- runner --------------------------------------------------------------------------------------------------------------

export interface OfficialOutcome { id: string; group: string; control: boolean; result: "pass" | "grader_fail" | "harness_error"; failures: string[] }
export interface OfficialSummary { suite_sha256: string; cases: number; passed: number; grader_fail: number; harness_error: number; skipped: number; false_resolved: number; outcomes: OfficialOutcome[]; label?: string }

async function runCase(k: OfficialCase): Promise<{ failures: string[]; falseResolved: boolean }> {
  const r = k.market.resolver;
  if (r?.kind !== "official_release") throw new Error("case market has no official_release resolver");
  const fetched = docOf(r.series, k.fetched);
  const doc = k.stored ? firstPrintFor(docOf(r.series, k.stored), fetched) : fetched;
  const { evidence } = officialEvidence(doc, new Date(k.fetched.observed_at).toISOString(), { ownCapture: k.fetched.own_capture ?? true });
  let jevCalls = 0;
  const res = await resolveMarket({ marketId: k.id, market: k.market, evidence, thresholds: DEFAULT_THRESHOLDS, spotlightSecret: "eval-spotlight-v1", model: "jev-1.13.0", now: new Date(k.fetched.observed_at) }, { jev: async () => { jevCalls++; throw new Error("official_release reached Jev"); } });
  const v = res.verdict;
  const f: string[] = [];
  if (v.resolution_status !== k.expect.status) f.push(`status ${v.resolution_status} != ${k.expect.status}`);
  if (v.winning_outcome !== k.expect.outcome) f.push(`outcome ${v.winning_outcome} != ${k.expect.outcome}`);
  for (const c of k.expect.caveats_include ?? []) if (!v.caveats.includes(c)) f.push(`caveat ${c} missing (have ${v.caveats.join(",") || "none"})`);
  if (k.expect.error_reason !== undefined && v.error_reason !== k.expect.error_reason) f.push(`error_reason ${v.error_reason} != ${k.expect.error_reason}`);
  if (jevCalls !== 0) f.push(`jev_calls ${jevCalls} != 0`);
  const falseResolved = v.resolution_status === "RESOLVED" && (k.expect.status !== "RESOLVED" || v.winning_outcome !== k.expect.outcome);
  return { failures: f, falseResolved };
}

export async function runOfficialSuite(opts: { groups?: string[] | null; quiet?: boolean; label?: string } = {}): Promise<OfficialSummary> {
  const { cases: all, suite } = loadOfficialCases();
  const cases = opts.groups ? all.filter((k) => opts.groups!.includes(k.group)) : all;
  const outcomes: OfficialOutcome[] = [];
  let falseResolved = 0;
  for (const k of cases) {
    try {
      const r = await runCase(k);
      if (r.falseResolved) falseResolved++;
      outcomes.push({ id: k.id, group: k.group, control: k.control, result: r.failures.length ? "grader_fail" : "pass", failures: r.failures });
    } catch (e) {
      outcomes.push({ id: k.id, group: k.group, control: k.control, result: "harness_error", failures: [`exception: ${String(e).slice(0, 200)}`] });
    }
  }
  const s: OfficialSummary = {
    suite_sha256: suite, cases: outcomes.length, passed: outcomes.filter((o) => o.result === "pass").length,
    grader_fail: outcomes.filter((o) => o.result === "grader_fail").length, harness_error: outcomes.filter((o) => o.result === "harness_error").length,
    skipped: 0, false_resolved: falseResolved, outcomes, label: opts.label,
  };
  if (!opts.quiet) {
    for (const o of outcomes) if (o.result !== "pass") console.log(`${o.result.toUpperCase().padEnd(13)} ${o.id.padEnd(8)} ${o.failures.join("; ")}`);
    console.log(`${opts.label ? `[${opts.label}] ` : ""}official: cases=${s.cases} passed=${s.passed} grader_fail=${s.grader_fail} harness_error=${s.harness_error} false_resolved=${s.false_resolved} suite ${suite.slice(0, 16)}`);
  }
  return s;
}

async function main() {
  const a = process.argv.slice(2);
  if (a.includes("--build") || a.includes("--check")) {
    const { body, manifest } = renderCases();
    if (a.includes("--check")) {
      const drift = [[CASES_FILE, body], [MANIFEST, manifest]].filter(([p, want]) => !existsSync(p!) || readFileSync(p!, "utf8") !== want).map(([p]) => p);
      for (const p of drift) console.log(`DRIFT ${p}`);
      if (drift.length) { console.log("frozen official cases differ from the authored cases — run npx tsx evals/official.ts --build and commit"); process.exit(1); }
      console.log(`checked ${body.trim().split("\n").length} official cases`);
      return;
    }
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CASES_FILE, body);
    writeFileSync(MANIFEST, manifest);
    console.log(`froze ${body.trim().split("\n").length} official cases; suite ${manifest.slice(0, 16)}`);
    return;
  }
  const s = await runOfficialSuite();
  process.exit(s.grader_fail || s.harness_error || s.false_resolved ? 1 : 0);
}
if (process.argv[1] && process.argv[1].endsWith("official.ts")) main().catch((e) => { console.error(String(e)); process.exit(1); });

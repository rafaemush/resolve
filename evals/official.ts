/**
 * Frozen official_release cases: real response bodies saved on 2026-09-24 and 2026-09-27 (evals/fixtures/official/,
 * provenance.json; archived BLS releases as byte-exact excerpts) are parsed at run time by the production parsers,
 * turned into the rail's document, and resolved by the production resolver with a Jev caller that fails the case if
 * it is ever called. Grader = equality only. A case marked SYNTHETIC edits a saved body before parsing (Read.edits,
 * every edit must apply). A body the production parser calls not published becomes the rail's release_not_observed
 * document, as the watch records it 6 h after the release.
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
  OFFICIAL_SERIES, firstPrintFor, officialEvidence, sameAtPrecision, reading, releaseAtOf, type OfficialCorroboration, type OfficialDoc, type OfficialResolver, type OfficialSeriesId,
} from "../src/resolve/official";
import {
  parseBlsRelease, parseBlsCpiTableA, parseEmpsitRelease, parseBlsApi, blsApiYoy, blsApiMom, blsApiLevelChange, previousMonth, parseFomcStatement,
  fredValueOn, parseEcbRelease, parseEcbDfrCsv, parseBoeRss, iadbValueOn, parseBokDecisionRss, parseBokGdpRss, parseEcosRows, parseBcbHistory,
  type CpiTableColumn, type CpiTableRow, type DocObservation, type DocParse, type EmpsitNumber,
} from "../src/ingest/official-parse";
import { BLS_API, blsCorroboration } from "../src/ingest/official";
import { buildLegRegistration, type LegGroup } from "../src/markets/official-legs";
import { parseTseConfig, parseTseResult, parseEqResults } from "../src/ingest/election-parse";
import { eqFileRefusal, snapshotForSeries, type ElectionSeriesId, type ElectionSnapshot } from "../src/resolve/election";
import { buildElectionLeg, tseRegistryFromSnapshot, eqRegistryFromSnapshot, type ElectionEventInput, type Registries } from "../src/markets/election-legs";
import { officialFixture, officialFixtureBytes, officialFixtureFetchedAt, OFFICIAL_FIXTURE_DIR } from "./lib/official-fixtures";
import { eqApply, eqChangesBody, eqParse, QC_TOP_TIE_RIDINGS, type EqOps } from "./lib/eq-synthetic";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const DIR = resolve(process.cwd(), "evals/official-cases");
const CASES_FILE = resolve(DIR, "cases.jsonl");
const MANIFEST = resolve(DIR, "manifest.sha256");

/**
 * Election groups (src/resolve/election.ts): election_final (rail election_final_count), election_margin (rail
 * election_safety_margin, and each of its margins alone: election_qc_riding_lead, election_qc_party_votes,
 * election_br_turnout_agree, election_sub_judice; evals/mutate.ts 16-20; and rail election_qc_leader_settled, 22: the
 * Québec seat-margin legs abstain while the party with the most seats is not settled), election_complete (rail
 * election_qc_complete_file, 21: a Québec snapshot that is not every riding of the election once decides nothing; and
 * rail election_qc_capture_integrity, 23: the capture records no Québec file that does not add up, Read.capture),
 * election_mapping (leg building: a label must map to exactly one authority entry; no rail, every case is a control).
 * Election cases read TSE 2022 first-round files (Wayback captures), the TSE 2026 simulation (EA20 layout) and the
 * Élections Québec 2022 archive with the production parsers.
 */
export type OfficialGroup = "release_gate" | "first_print" | "election_final" | "election_margin" | "election_complete" | "election_mapping";
type Parser = "tse_result" | "eq_result" | "bls_cpi_text" | "bls_ppi_text" | "bls_api_yoy" | "fed_statement" | "ecb_release" | "boe_rss" | "bok_decision_rss" | "bok_gdp_rss" | "ecos_quarter" | "bcb_latest_row" | "bcb_history" | "sgs432_row"
  | "bls_cpi_table" | "bls_empsit_text" | "bls_api_mom" | "bls_api_level" | "bls_api_change";
/** bls_api_yoy and bls_api run the production corroboration (src/ingest/official.ts blsCorroboration) on the saved body. */
type CorrParser = "bls_api_yoy" | "bls_api" | "fred" | "ecb_dfr" | "iadb" | "ecos_daily" | "ecos_quarter" | "single_source";
/** SYNTHETIC [from, to] replacements applied to a saved body before it is parsed; every "from" must occur. */
type Edits = Array<[string, string]>;
/**
 * own_capture: this market's own watch made the observation (default). For events outside KNOWN_RELEASES the
 * release-time part of gate 1 applies only to such observations (src/resolve/official.ts).
 */
/** tse_result: select is the election day looked up in the saved configuration `config`; eq_result: select is the election day. */
/** url (election reads only): the URL the saved body is attributed to, when not its provenance URL (a SYNTHETIC relocation). */
/** eq (eq_result reads only): SYNTHETIC operations on the body's JSON, applied after `edits` (evals/lib/eq-synthetic.ts); each must apply. */
/**
 * capture (eq_result reads only): the read first goes through the capture's gate on the whole file (eqFileRefusal, as
 * src/ingest/official.ts applies it before any series keeps its part); a read it refuses is never stored, so the leg's
 * document is the release_not_observed one the watch records once polls closed 72 h ago.
 */
interface Read { fixture: string; parser: Parser; url?: string; select?: string; observed_at: string; own_capture?: boolean; edits?: Edits; eq?: EqOps; capture?: true; config?: string; config_edits?: Edits; corroboration?: { fixture?: string; parser: CorrParser; select?: string; edits?: Edits } }
/** detail_includes: text the structured resolver's own account of the decision must contain (the seat ranges a SYNTHETIC case claims; never on a control, whose ranges close when a margin rail is off). */
interface Expect { status: "RESOLVED" | "UNRESOLVED" | "ERROR"; outcome: "OPTION_A" | "OPTION_B" | "NONE"; caveats_include?: readonly string[]; error_reason?: string; detail_includes?: readonly string[] }
export interface ResolveCase { id: string; group: OfficialGroup; control: boolean; title: string; market: Reg; stored?: Read; fetched: Read; expect: Expect }
/** A leg built at run time from an authority registry saved as a fixture: refused (reason substring) or mapped (subject id). */
interface BuildSpec { event: ElectionEventInput; label: string; registry: { authority: "tse" | "eq"; fixture: string; config?: string } | null }
export interface BuildCase { id: string; group: OfficialGroup; control: boolean; title: string; build: BuildSpec; expect: { refused_includes?: string; subject_id?: string } }
export type OfficialCase = ResolveCase | BuildCase;

// ---- authored cases ------------------------------------------------------------------------------------------------

const YES = { status: "RESOLVED", outcome: "OPTION_A", caveats_include: ["first_print"] } as const;
const NO = { status: "RESOLVED", outcome: "OPTION_B", caveats_include: ["first_print"] } as const;
const AWAIT = { status: "UNRESOLVED", outcome: "NONE", caveats_include: ["awaiting_release"] } as const;

function leg(group: LegGroup, label: string, open_at: string, deadline_utc: string, platform: "limitless" | "polymarket" = "limitless"): Reg {
  // a thousands ladder is read half-open only when its text settles a boundary value in the higher bracket (paraphrased here)
  const tie = OFFICIAL_SERIES[group.series].decides === "change_thousands" ? " A value exactly on the boundary between two brackets settles in the higher bracket." : "";
  const r = buildLegRegistration({ platform, external_id: `eval-${group.series}-${group.period}-${label}`, group, label, open_at, deadline_utc, criteria: `Frozen eval leg for ${group.title}.${tie}` });
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

// BLS CPI siblings (Table A of the CPI release) and the Employment Situation (research and fixtures of 2026-09-27).
// Release times are the embargo lines of the saved releases and the BLS schedules (observed); Polymarket-only ladders.
const bls = (series: LegGroup["series"], period: string, release_at: string, title: string): LegGroup => ({ series, period, release_at, title });
const MOM_SEP = bls("us_cpi_u_sa_mom", "2026-09", "2026-10-14T12:30:00Z", "September Inflation US - Monthly");
const MOM_AUG = bls("us_cpi_u_sa_mom", "2026-08", "2026-09-11T12:30:00Z", "August Inflation US - Monthly (past event)");
const MOM_JUL = bls("us_cpi_u_sa_mom", "2026-07", "2026-08-12T12:30:00Z", "July Inflation US - Monthly (past event)");
const MOM_JUN = bls("us_cpi_u_sa_mom", "2026-06", "2026-07-14T12:30:00Z", "June Inflation US - Monthly (past event)");
const MOM_NOV25 = bls("us_cpi_u_sa_mom", "2025-11", "2025-12-18T13:30:00Z", "November 2025 Inflation US - Monthly (past event, after the 2025 lapse)");
// release_at: the pre-lapse schedule (UNVERIFIED); BLS published the September 2025 release on Oct 24, 2025 (observed)
const MOM_SEP25 = bls("us_cpi_u_sa_mom", "2025-09", "2025-10-15T12:30:00Z", "September 2025 Inflation US - Monthly (past event, published late)");
const MOM_MAY24 = bls("us_cpi_u_sa_mom", "2024-05", "2024-06-12T12:30:00Z", "May 2024 Inflation US - Monthly (past event)");
const CYOY_SEP = bls("us_core_cpi_nsa_yoy", "2026-09", "2026-10-14T12:30:00Z", "Core CPI YoY - September 2026");
const CYOY_AUG = bls("us_core_cpi_nsa_yoy", "2026-08", "2026-09-11T12:30:00Z", "Core CPI YoY - August 2026 (past event)");
const CYOY_NOV25 = bls("us_core_cpi_nsa_yoy", "2025-11", "2025-12-18T13:30:00Z", "Core CPI YoY - November 2025 (past event, after the 2025 lapse)");
const CMOM_SEP = bls("us_core_cpi_sa_mom", "2026-09", "2026-10-14T12:30:00Z", "Core CPI MoM - September 2026");
const CMOM_AUG = bls("us_core_cpi_sa_mom", "2026-08", "2026-09-11T12:30:00Z", "Core CPI MoM - August 2026 (past event)");
const CMOM_JUN = bls("us_core_cpi_sa_mom", "2026-06", "2026-07-14T12:30:00Z", "Core CPI MoM - June 2026 (past event)");
const UNR_SEP = bls("us_unemployment_rate", "2026-09", "2026-10-02T12:30:00Z", "September Unemployment Rate");
const UNR_AUG = bls("us_unemployment_rate", "2026-08", "2026-09-04T12:30:00Z", "August Unemployment Rate (past event)");
const UNR_JUL = bls("us_unemployment_rate", "2026-07", "2026-08-07T12:30:00Z", "July Unemployment Rate (past event)");
const UNR_FEB = bls("us_unemployment_rate", "2026-02", "2026-03-06T13:30:00Z", "February Unemployment Rate (past event)");
const PAY_SEP = bls("us_nonfarm_payrolls_change", "2026-09", "2026-10-02T12:30:00Z", "How many jobs added in September?");
const PAY_AUG = bls("us_nonfarm_payrolls_change", "2026-08", "2026-09-04T12:30:00Z", "How many jobs added in August? (past event)");
const PAY_JUL = bls("us_nonfarm_payrolls_change", "2026-07", "2026-08-07T12:30:00Z", "How many jobs added in July? (past event)");
const PAY_FEB = bls("us_nonfarm_payrolls_change", "2026-02", "2026-03-06T13:30:00Z", "How many jobs added in February? (past event)");

const AT27 = {
  cpi202606: "2026-09-27T18:47:43Z", cpi202511: "2026-09-27T18:47:55Z", cpi202509: "2026-09-27T18:48:08Z", cpi202405: "2026-09-27T18:51:15Z",
  empsit: "2026-09-27T18:45:52Z", empsit202607: "2026-09-27T18:46:28Z", empsit202602: "2026-09-27T18:48:59Z",
  apiCpiSa: "2026-09-27T18:48:16Z", apiCoreSa: "2026-09-27T18:48:21Z", apiCoreNsa: "2026-09-27T18:48:26Z", apiUnrate: "2026-09-27T18:47:12Z", apiPayrolls: "2026-09-27T18:47:12Z",
};
type Corr = NonNullable<Read["corroboration"]>;
const api = (fixture: string, select: string, edits?: Edits): Corr => ({ fixture, parser: "bls_api", select, ...(edits ? { edits } : {}) });
const table = (fixture: string, select: string, observed_at: string, corroboration?: Corr, edits?: Edits): Read => ({ fixture, parser: "bls_cpi_table", select, observed_at, ...(edits ? { edits } : {}), ...(corroboration ? { corroboration } : {}) });
const empsit = (fixture: string, select: "unemployment_rate" | "payrolls_change", observed_at: string, corroboration?: Corr, edits?: Edits): Read => ({ fixture, parser: "bls_empsit_text", select, observed_at, ...(edits ? { edits } : {}), ...(corroboration ? { corroboration } : {}) });
const CPI_AUG_PAGE = "bls_cpi_nr0.html";
const EMPSIT_AUG = "bls_empsit_nr0_excerpt.html";
const PM_OPEN = { cpi: "2026-09-11T15:28:51Z", empsit: "2026-09-04T16:35:35Z" };
const WITH_CORR = ["first_print", "corroboration_unavailable"] as const;
const LATE = { status: "UNRESOLVED", outcome: "NONE", caveats_include: ["released_after_fallback"] } as const;
// SYNTHETIC September releases: the saved August pages with their month edited (header, Table A's last month and
// 12-month columns, the headline 1-month sentence; the summary's "in August"), standing for releases not yet made.
const SEP_CPI: Edits = [
  ["CONSUMER PRICE INDEX - AUGUST 2026", "CONSUMER PRICE INDEX - SEPTEMBER 2026"], ['id="cpi_pressa.h.2.8">Aug.<br />2026', 'id="cpi_pressa.h.2.8">Sep.<br />2026'],
  ["ended<br />Aug. 2026", "ended<br />Sep. 2026"], ["seasonally adjusted basis in August", "seasonally adjusted basis in September"],
];
const SEP_EMPSIT: Edits = [["THE EMPLOYMENT SITUATION - AUGUST 2026", "THE EMPLOYMENT SITUATION - SEPTEMBER 2026"], ["in August", "in September"]];

/** The five BLS series of 2026-09-27: correct buckets, wrong period refused, prior months never read, delays pending, ties. */
function blsCases(): OfficialCase[] {
  const pm = "polymarket" as const;
  const past = { open: "2026-06-01T00:00:00Z", cpiDeadline: "2026-09-12T03:59:00Z", empDeadline: "2026-09-05T03:59:00Z" };
  return [
    // --- release_gate: a September leg never reads the August release, whenever and however it is read -----------------
    { id: "OFF-G11", group: "release_gate", control: false, title: "CPI 1-month: after 12:30Z on Oct 14 the page still names AUGUST 2026 (a delayed release): Table A's August 0.4 never resolves the September 0.4% leg", market: leg(MOM_SEP, "0.4%", PM_OPEN.cpi, "2026-10-15T03:59:00Z", pm), fetched: table(CPI_AUG_PAGE, "all_items:sa_1m", "2026-10-14T12:35:00Z", api("bls_v1_cpi_sa.json", "2026-09")), expect: AWAIT },
    { id: "OFF-G12", group: "release_gate", control: false, title: "Core CPI 12-month: the August release read at 12:29Z on Oct 14, a minute before the September release, never resolves the 2.4% leg", market: leg(CYOY_SEP, "2.4%", PM_OPEN.cpi, "2026-10-15T03:59:00Z", pm), fetched: table(CPI_AUG_PAGE, "core:nsa_12m", "2026-10-14T12:29:00Z"), expect: AWAIT },
    { id: "OFF-G13", group: "release_gate", control: false, title: "Core CPI 1-month: the August column (0.3) is not September's, even read after the release time", market: leg(CMOM_SEP, "0.3%", PM_OPEN.cpi, "2026-10-15T03:59:00Z", pm), fetched: table(CPI_AUG_PAGE, "core:sa_1m", "2026-10-14T12:31:00Z"), expect: AWAIT },
    { id: "OFF-G14", group: "release_gate", control: false, title: "Unemployment: a lapse in appropriations leaves the AUGUST 2026 summary up after 12:30Z on Oct 2: its 4.1 percent never resolves the September legs", market: leg(UNR_SEP, "4.1%", PM_OPEN.empsit, "2026-10-02T08:30:00Z", pm), fetched: empsit(EMPSIT_AUG, "unemployment_rate", "2026-10-02T12:31:00Z", api("bls_v1_unrate.json", "2026-09")), expect: AWAIT },
    { id: "OFF-G15", group: "release_gate", control: false, title: "Payrolls: the August summary (+162,000) read at 12:30:05Z on Oct 2 is not the September print", market: leg(PAY_SEP, "150k to 200k", "2026-09-04T16:37:33Z", "2026-10-03T03:59:00Z", pm), fetched: empsit(EMPSIT_AUG, "payrolls_change", "2026-10-02T12:30:05Z"), expect: AWAIT },
    { id: "OFF-G16", group: "release_gate", control: false, title: "Payrolls August 2026 (not a registered event): the right summary, captured by this market's own watch at 12:29Z, a minute before its scheduled release, never resolves", market: leg(PAY_AUG, "150k to 200k", past.open, past.empDeadline, pm), fetched: { ...empsit(EMPSIT_AUG, "payrolls_change", "2026-09-04T12:29:00Z"), own_capture: true }, expect: AWAIT },
    { id: "OFF-G17", group: "release_gate", control: false, title: "CPI 1-month July 2026: the August release's Table A still prints July (0.1) in an earlier column; the rail reads only the header month, so the July legs wait", market: leg(MOM_JUL, "0.1%", past.open, "2026-08-13T03:59:00Z", pm), fetched: table(CPI_AUG_PAGE, "all_items:sa_1m", AT.cpi), expect: AWAIT },
    { id: "OFF-G18", group: "release_gate", control: false, title: "Payrolls July 2026: the August summary revises July from -23,000 to +21,000; a July leg never reads that revision (nor August's +162,000)", market: leg(PAY_JUL, "0 to 50k", past.open, "2026-08-08T03:59:00Z", pm), fetched: empsit(EMPSIT_AUG, "payrolls_change", AT27.empsit), expect: AWAIT },
    // --- release_gate controls: the same parsers on their own releases, identical with the rail on or off ----------------
    { id: "OFF-C16", group: "release_gate", control: true, title: "CPI 1-month August 2026: Table A 0.4 (the API's 334.131/332.813 agrees): the 0.4% leg is Yes", market: leg(MOM_AUG, "0.4%", past.open, past.cpiDeadline, pm), fetched: table(CPI_AUG_PAGE, "all_items:sa_1m", AT.cpi, api("bls_v1_cpi_sa.json", "2026-08")), expect: YES },
    { id: "OFF-C17", group: "release_gate", control: true, title: "CPI 1-month August 2026: the 0.3% leg is a positive No", market: leg(MOM_AUG, "0.3%", past.open, past.cpiDeadline, pm), fetched: table(CPI_AUG_PAGE, "all_items:sa_1m", AT.cpi, api("bls_v1_cpi_sa.json", "2026-08")), expect: NO },
    { id: "OFF-C18", group: "release_gate", control: true, title: "CPI 1-month near-tie, SYNTHETIC API index 333.978: the recomputed change 0.35004 could print 0.3 or 0.4 and the release printed 0.4: inconclusive, the published 0.4 decides", market: leg(MOM_AUG, "0.4%", past.open, past.cpiDeadline, pm), fetched: table(CPI_AUG_PAGE, "all_items:sa_1m", AT.cpi, api("bls_v1_cpi_sa.json", "2026-08", [['"334.131"', '"333.978"']])), expect: { ...YES, caveats_include: WITH_CORR } },
    { id: "OFF-C19", group: "release_gate", control: true, title: "CPI 1-month near-tie, SYNTHETIC API index 333.645: the change 0.24999 could print 0.2 or 0.3, never the release's 0.4: sources disagree, no RESOLVED", market: leg(MOM_AUG, "0.4%", past.open, past.cpiDeadline, pm), fetched: table(CPI_AUG_PAGE, "all_items:sa_1m", AT.cpi, api("bls_v1_cpi_sa.json", "2026-08", [['"334.131"', '"333.645"']])), expect: { status: "UNRESOLVED", outcome: "NONE", caveats_include: ["sources_disagree"] } },
    { id: "OFF-C20", group: "release_gate", control: true, title: "CPI 1-month June 2026: 'decreased 0.4 percent' / Table A -0.4 (API agrees): the ≤0.0% leg is Yes", market: leg(MOM_JUN, "≤0.0%", past.open, "2026-07-15T03:59:00Z", pm), fetched: table("bls_cpi_202606_excerpt.html", "all_items:sa_1m", AT27.cpi202606, api("bls_v1_cpi_sa.json", "2026-06")), expect: YES },
    { id: "OFF-C21", group: "release_gate", control: true, title: "CPI 1-month May 2024: 'was unchanged in May on a seasonally adjusted basis' (the other word order) and Table A 0.0: the ≤0.0% leg is Yes", market: leg(MOM_MAY24, "≤0.0%", "2024-05-01T00:00:00Z", "2024-06-13T03:59:00Z", pm), fetched: table("bls_cpi_202405_excerpt.html", "all_items:sa_1m", AT27.cpi202405), expect: { ...YES, caveats_include: WITH_CORR } },
    { id: "OFF-C22", group: "release_gate", control: true, title: "CPI 1-month November 2025 (after the 2025 lapse): Table A prints '-' and the text gives a 2-month 0.2; the legs stay pending (release_not_observed), never 0.0 or 0.2", market: leg(MOM_NOV25, "0.2%", "2025-11-01T00:00:00Z", "2025-12-19T04:59:00Z", pm), fetched: table("bls_cpi_202511_excerpt.html", "all_items:sa_1m", AT27.cpi202511), expect: { status: "UNRESOLVED", outcome: "NONE", caveats_include: ["release_not_observed"] } },
    { id: "OFF-C23", group: "release_gate", control: true, title: "CPI 1-month September 2025, published late (Oct 24, 2025): the late release names its own month and resolves (0.3)", market: leg(MOM_SEP25, "0.3%", "2025-09-01T00:00:00Z", "2025-10-25T03:59:00Z", pm), fetched: table("bls_cpi_202509_excerpt.html", "all_items:sa_1m", "2025-10-24T12:30:04Z"), expect: { ...YES, caveats_include: WITH_CORR } },
    { id: "OFF-C24", group: "release_gate", control: true, title: "Core CPI 12-month August 2026: Table A 2.4 before seasonal adjustment (API 338.041/329.970 agrees): the 2.4% leg is Yes", market: leg(CYOY_AUG, "2.4%", past.open, past.cpiDeadline, pm), fetched: table(CPI_AUG_PAGE, "core:nsa_12m", AT.cpi, api("bls_v1_core_nsa.json", "2026-08")), expect: YES },
    { id: "OFF-C25", group: "release_gate", control: true, title: "Core CPI 12-month August 2026: the ≥2.9% leg is a positive No", market: leg(CYOY_AUG, "≥2.9%", past.open, past.cpiDeadline, pm), fetched: table(CPI_AUG_PAGE, "core:nsa_12m", AT.cpi, api("bls_v1_core_nsa.json", "2026-08")), expect: NO },
    { id: "OFF-C26", group: "release_gate", control: true, title: "Core CPI 12-month November 2025: printed (2.6) although the 1-month cells are '-' (API agrees): the 2.6% leg is Yes", market: leg(CYOY_NOV25, "2.6%", "2025-11-01T00:00:00Z", "2025-12-19T04:59:00Z", pm), fetched: table("bls_cpi_202511_excerpt.html", "core:nsa_12m", AT27.cpi202511, api("bls_v1_core_nsa.json", "2025-11")), expect: YES },
    { id: "OFF-C27", group: "release_gate", control: true, title: "Core CPI 12-month near-tie, SYNTHETIC API index 338.054: 2.44992 could print 2.4 or 2.5 and the release printed 2.4: inconclusive, the published 2.4 decides", market: leg(CYOY_AUG, "2.4%", past.open, past.cpiDeadline, pm), fetched: table(CPI_AUG_PAGE, "core:nsa_12m", AT.cpi, api("bls_v1_core_nsa.json", "2026-08", [['"338.041"', '"338.054"']])), expect: { ...YES, caveats_include: WITH_CORR } },
    { id: "OFF-C28", group: "release_gate", control: true, title: "Core CPI 1-month August 2026: Table A 0.3 (API 337.765/336.789 agrees): the 0.3% leg is Yes", market: leg(CMOM_AUG, "0.3%", past.open, past.cpiDeadline, pm), fetched: table(CPI_AUG_PAGE, "core:sa_1m", AT.cpi, api("bls_v1_core_sa.json", "2026-08")), expect: YES },
    { id: "OFF-C29", group: "release_gate", control: true, title: "Core CPI 1-month August 2026: the 0.6%+ leg is a positive No", market: leg(CMOM_AUG, "0.6%+", past.open, past.cpiDeadline, pm), fetched: table(CPI_AUG_PAGE, "core:sa_1m", AT.cpi, api("bls_v1_core_sa.json", "2026-08")), expect: NO },
    { id: "OFF-C30", group: "release_gate", control: true, title: "Core CPI 1-month June 2026: 'was unchanged in June' and Table A 0.0 (API agrees): the ≤0.0% leg is Yes", market: leg(CMOM_JUN, "≤0.0%", past.open, "2026-07-15T03:59:00Z", pm), fetched: table("bls_cpi_202606_excerpt.html", "core:sa_1m", AT27.cpi202606, api("bls_v1_core_sa.json", "2026-06")), expect: YES },
    { id: "OFF-C31", group: "release_gate", control: true, title: "Unemployment August 2026: 'was unchanged at 4.1 percent' in the lead and the household section (LNS14000000 agrees): the 4.1% leg is Yes", market: leg(UNR_AUG, "4.1%", past.open, past.empDeadline, pm), fetched: empsit(EMPSIT_AUG, "unemployment_rate", AT27.empsit, api("bls_v1_unrate.json", "2026-08")), expect: YES },
    { id: "OFF-C32", group: "release_gate", control: true, title: "Unemployment August 2026: the ≤3.8% leg is a positive No", market: leg(UNR_AUG, "≤3.8%", past.open, past.empDeadline, pm), fetched: empsit(EMPSIT_AUG, "unemployment_rate", AT27.empsit, api("bls_v1_unrate.json", "2026-08")), expect: NO },
    { id: "OFF-C33", group: "release_gate", control: true, title: "Unemployment August 2026 on a leg whose platform deadline (08:30Z) is 4 h before the 12:30Z release: the release still decides, Yes", market: leg(UNR_AUG, "4.1%", past.open, "2026-09-04T08:30:00Z", pm), fetched: empsit(EMPSIT_AUG, "unemployment_rate", "2026-09-04T12:30:03Z", api("bls_v1_unrate.json", "2026-08")), expect: YES },
    { id: "OFF-C34", group: "release_gate", control: true, title: "Unemployment July 2026: '(4.1 percent)' and ', at 4.1 percent,' (API agrees): the 4.1% leg is Yes", market: leg(UNR_JUL, "4.1%", past.open, "2026-08-07T08:30:00Z", pm), fetched: empsit("bls_empsit_202607_excerpt.html", "unemployment_rate", AT27.empsit202607, api("bls_v1_unrate.json", "2026-07")), expect: YES },
    { id: "OFF-C35", group: "release_gate", control: true, title: "Unemployment February 2026: the 'SITUATION -- FEBRUARY 2026' header and a boxed note (API 4.4 agrees): the 4.4% leg is Yes", market: leg(UNR_FEB, "4.4%", "2026-01-01T00:00:00Z", "2026-03-06T09:30:00Z", pm), fetched: empsit("bls_empsit_202602_excerpt.html", "unemployment_rate", AT27.empsit202602, api("bls_v1_unrate.json", "2026-02")), expect: YES },
    { id: "OFF-C36", group: "release_gate", control: true, title: "Payrolls August 2026: +162,000 ('increased by' and 'rose by'; the June and July revisions in the same text are not read; CES levels 159075-158913 agree): 150k to 200k is Yes", market: leg(PAY_AUG, "150k to 200k", past.open, past.empDeadline, pm), fetched: empsit(EMPSIT_AUG, "payrolls_change", AT27.empsit, api("bls_v1_payrolls.json", "2026-08")), expect: YES },
    { id: "OFF-C37", group: "release_gate", control: true, title: "Payrolls August 2026: the 200k+ leg is a positive No", market: leg(PAY_AUG, "200k+", past.open, past.empDeadline, pm), fetched: empsit(EMPSIT_AUG, "payrolls_change", AT27.empsit, api("bls_v1_payrolls.json", "2026-08")), expect: NO },
    { id: "OFF-C38", group: "release_gate", control: true, title: "Payrolls July 2026: 'changed little in July (-23,000)'; the API's latest month is August, so its levels are a later vintage: single source; -50k to 0 is Yes", market: leg(PAY_JUL, "-50k to 0", past.open, "2026-08-08T03:59:00Z", pm), fetched: empsit("bls_empsit_202607_excerpt.html", "payrolls_change", AT27.empsit202607, api("bls_v1_payrolls.json", "2026-07")), expect: { ...YES, caveats_include: ["first_print", "single_source"] } },
    { id: "OFF-C39", group: "release_gate", control: true, title: "Payrolls February 2026: 'edged down by 92,000' is -92: the <-50k leg is Yes", market: leg(PAY_FEB, "<-50k", "2026-01-01T00:00:00Z", "2026-03-07T04:59:00Z", pm), fetched: empsit("bls_empsit_202602_excerpt.html", "payrolls_change", AT27.empsit202602, api("bls_v1_payrolls.json", "2026-02")), expect: { ...YES, caveats_include: ["first_print", "single_source"] } },
    { id: "OFF-C40", group: "release_gate", control: true, title: "Payrolls exactly on a boundary, SYNTHETIC +150,000 (CES level edited to match): the higher bracket, 150k to 200k, is Yes", market: leg(PAY_AUG, "150k to 200k", past.open, past.empDeadline, pm), fetched: empsit(EMPSIT_AUG, "payrolls_change", AT27.empsit, api("bls_v1_payrolls.json", "2026-08", [['"159075"', '"159063"']]), [["162,000", "150,000"]]), expect: YES },
    { id: "OFF-C41", group: "release_gate", control: true, title: "Payrolls exactly on a boundary, SYNTHETIC +150,000: the lower bracket, 100k to 150k, is a positive No", market: leg(PAY_AUG, "100k to 150k", past.open, past.empDeadline, pm), fetched: empsit(EMPSIT_AUG, "payrolls_change", AT27.empsit, api("bls_v1_payrolls.json", "2026-08", [['"159075"', '"159063"']]), [["162,000", "150,000"]]), expect: NO },
    { id: "OFF-C42", group: "release_gate", control: true, title: "Payrolls, SYNTHETIC CES level 159076: the levels differ by 163, one thousand from the printed 162 (level rounding): inconclusive, the release decides", market: leg(PAY_AUG, "150k to 200k", past.open, past.empDeadline, pm), fetched: empsit(EMPSIT_AUG, "payrolls_change", AT27.empsit, api("bls_v1_payrolls.json", "2026-08", [['"159075"', '"159076"']])), expect: { ...YES, caveats_include: WITH_CORR } },
    { id: "OFF-C43", group: "release_gate", control: true, title: "Payrolls, SYNTHETIC CES level 159100: the levels differ by 187 against the printed 162: sources disagree, no RESOLVED", market: leg(PAY_AUG, "150k to 200k", past.open, past.empDeadline, pm), fetched: empsit(EMPSIT_AUG, "payrolls_change", AT27.empsit, api("bls_v1_payrolls.json", "2026-08", [['"159075"', '"159100"']])), expect: { status: "UNRESOLVED", outcome: "NONE", caveats_include: ["sources_disagree"] } },
    // --- release_gate: a first print first seen at or after the market's fallback decides nothing (the texts then settle
    // on an earlier period, which the rail never decides from) --------------------------------------------------------------
    { id: "OFF-G19", group: "release_gate", control: false, title: "Payrolls: a SYNTHETIC September summary (+162,000) first seen Nov 9, after the fallback (no September data by the date of the October release, Nov 6): no verdict", market: leg(PAY_SEP, "150k to 200k", "2026-09-04T16:37:33Z", "2026-10-03T03:59:00Z", pm), fetched: empsit(EMPSIT_AUG, "payrolls_change", "2026-11-09T14:00:00Z", undefined, SEP_EMPSIT), expect: LATE },
    { id: "OFF-G20", group: "release_gate", control: false, title: "Unemployment: the SYNTHETIC September summary first seen at 12:00Z on Nov 6, the October release's date ('by the date' is read from 00:00 ET): no verdict", market: leg(UNR_SEP, "4.1%", PM_OPEN.empsit, "2026-10-02T08:30:00Z", pm), fetched: empsit(EMPSIT_AUG, "unemployment_rate", "2026-11-06T12:00:00Z", undefined, SEP_EMPSIT), expect: LATE },
    { id: "OFF-G21", group: "release_gate", control: false, title: "Core CPI 1-month: a SYNTHETIC September release first seen at 13:30Z on Nov 10, the next CPI release time: no verdict", market: leg(CMOM_SEP, "0.3%", PM_OPEN.cpi, "2026-10-15T03:59:00Z", pm), fetched: table(CPI_AUG_PAGE, "core:sa_1m", "2026-11-10T13:30:00Z", undefined, SEP_CPI), expect: LATE },
    { id: "OFF-G22", group: "release_gate", control: false, title: "CPI 12-month (the headline series): a SYNTHETIC September release first seen Nov 11, after the next CPI release: no verdict", market: leg(CPI_SEP, "3.4%", "2026-09-15T08:56:56.799Z", "2026-10-15T03:59:00Z"), fetched: { fixture: CPI_AUG_PAGE, parser: "bls_cpi_text", observed_at: "2026-11-11T14:00:00Z", edits: SEP_CPI.slice(0, 1) }, expect: LATE },
    { id: "OFF-C44", group: "release_gate", control: true, title: "Payrolls: the SYNTHETIC September summary first seen at 23:00Z on Nov 5 (18:00 ET, the eve of the October release date): a delayed print inside the window resolves, 150k to 200k is Yes", market: leg(PAY_SEP, "150k to 200k", "2026-09-04T16:37:33Z", "2026-10-03T03:59:00Z", pm), fetched: empsit(EMPSIT_AUG, "payrolls_change", "2026-11-05T23:00:00Z", undefined, SEP_EMPSIT), expect: { ...YES, caveats_include: WITH_CORR } },
    { id: "OFF-C45", group: "release_gate", control: true, title: "Unemployment August 2026, SYNTHETIC LNS14000000 August value 4.2 against the printed 4.1: sources disagree, no RESOLVED", market: leg(UNR_AUG, "4.1%", past.open, past.empDeadline, pm), fetched: empsit(EMPSIT_AUG, "unemployment_rate", AT27.empsit, api("bls_v1_unrate.json", "2026-08", [['"periodName":"August","latest":"true","value":"4.1"', '"periodName":"August","latest":"true","value":"4.2"']])), expect: { status: "UNRESOLVED", outcome: "NONE", caveats_include: ["sources_disagree"] } },

    // --- first_print: a later vintage never replaces the first print of payrolls or the unemployment rate --------------
    { id: "OFF-F04", group: "first_print", control: false, title: "Payrolls February 2026: first print -92 (Mar 6); today's CES levels differ by -156: the finer -100k to -50k leg stays Yes", market: leg(PAY_FEB, "-100k to -50k", "2026-01-01T00:00:00Z", "2026-03-07T04:59:00Z", pm), stored: empsit("bls_empsit_202602_excerpt.html", "payrolls_change", "2026-03-06T13:30:04Z"), fetched: { fixture: "bls_v1_payrolls.json", parser: "bls_api_change", select: "2026-02", observed_at: AT27.apiPayrolls }, expect: YES },
    { id: "OFF-F05", group: "first_print", control: false, title: "Payrolls July 2026: first print -23 (Aug 7); revised to +21 a month later: the -50k to 0 leg stays Yes", market: leg(PAY_JUL, "-50k to 0", past.open, "2026-08-08T03:59:00Z", pm), stored: empsit("bls_empsit_202607_excerpt.html", "payrolls_change", "2026-08-07T12:30:03Z"), fetched: { fixture: "bls_v1_payrolls.json", parser: "bls_api_change", select: "2026-07", observed_at: AT27.apiPayrolls }, expect: YES },
    { id: "OFF-F06", group: "first_print", control: false, title: "Payrolls July 2026: the 0 to 50k leg stays a positive No although the revised levels differ by +21", market: leg(PAY_JUL, "0 to 50k", past.open, "2026-08-08T03:59:00Z", pm), stored: empsit("bls_empsit_202607_excerpt.html", "payrolls_change", "2026-08-07T12:30:03Z"), fetched: { fixture: "bls_v1_payrolls.json", parser: "bls_api_change", select: "2026-07", observed_at: AT27.apiPayrolls }, expect: NO },
    { id: "OFF-F07", group: "first_print", control: false, title: "Unemployment August 2026: first print 4.1; a SYNTHETIC later vintage of LNS14000000 says 4.2: the 4.1% leg stays Yes", market: leg(UNR_AUG, "4.1%", past.open, past.empDeadline, pm), stored: empsit(EMPSIT_AUG, "unemployment_rate", "2026-09-04T12:30:02Z", api("bls_v1_unrate.json", "2026-08")), fetched: { fixture: "bls_v1_unrate.json", parser: "bls_api_level", select: "2026-08", observed_at: AT27.apiUnrate, edits: [['"periodName":"August","latest":"true","value":"4.1"', '"periodName":"August","latest":"true","value":"4.2"']] }, expect: YES },
    // --- first_print controls ---------------------------------------------------------------------------------------------
    { id: "OFF-FC5", group: "first_print", control: true, title: "Payrolls February 2026 on the real <-50k leg: Yes with -92 or -156", market: leg(PAY_FEB, "<-50k", "2026-01-01T00:00:00Z", "2026-03-07T04:59:00Z", pm), stored: empsit("bls_empsit_202602_excerpt.html", "payrolls_change", "2026-03-06T13:30:04Z"), fetched: { fixture: "bls_v1_payrolls.json", parser: "bls_api_change", select: "2026-02", observed_at: AT27.apiPayrolls }, expect: { ...YES, caveats_include: WITH_CORR } },
    { id: "OFF-FC6", group: "first_print", control: true, title: "Core CPI 12-month August 2026: the API's 2.4 (not seasonally adjusted, never revised) agrees with the stored 2.4", market: leg(CYOY_AUG, "2.4%", past.open, past.cpiDeadline, pm), stored: table(CPI_AUG_PAGE, "core:nsa_12m", AT.cpi, api("bls_v1_core_nsa.json", "2026-08")), fetched: { fixture: "bls_v1_core_nsa.json", parser: "bls_api_yoy", select: "2026-08", observed_at: AT27.apiCoreNsa }, expect: YES },
    { id: "OFF-FC7", group: "first_print", control: true, title: "Unemployment August 2026: the API's 4.1 agrees with the stored 4.1", market: leg(UNR_AUG, "4.1%", past.open, past.empDeadline, pm), stored: empsit(EMPSIT_AUG, "unemployment_rate", "2026-09-04T12:30:02Z", api("bls_v1_unrate.json", "2026-08")), fetched: { fixture: "bls_v1_unrate.json", parser: "bls_api_level", select: "2026-08", observed_at: AT27.apiUnrate }, expect: YES },
  ];
}

// ---- election cases (src/resolve/election.ts) ------------------------------------------------------------------------

const EL = {
  br2022: { first: "tse_2022_br_c0001_e000544_r_20221002T210340Z.json", mdS: "tse_2022_br_c0001_e000544_r_20221003T155646Z.json", final: "tse_2022_br_c0001_e000544_r_20221004T163422Z.json" },
  ac2022: "tse_2022_ac_c0001_e000544_r_20221007T210406Z.json", mg2022: "tse_2022_mg_c0001_e000544_r_20221013T152145Z.json",
  sp2022: "tse_2022_sp_c0001_e000544_r_20221003T011620Z.json", sim2026: "tse_sim2026_br_c0001_e021270_u.json", eq2022: "eq_gen2022_resultats.json",
};
const TSE_DAY_2022 = "2022-10-02", EQ_DAY_2022 = "2022-10-03";
/** 2022 polls closed 17:00 Brasília (20:00Z) and 20:00 EDT in Quebec (00:00Z the next day). */
const TSE_CLOSE_2022 = "2022-10-02T20:00:00Z", EQ_CLOSE_2022 = "2022-10-04T00:00:00Z";
/** Paraphrase of the platform rule on brackets (the leg builder refuses a percent ladder whose text does not settle ties). */
const TIE_TEXT = "A value exactly between two brackets resolves to the higher bracket.";

function tseRegistryOf(fixture: string, day: string): Registries["tse"] {
  const p = parseTseResult(officialFixture(fixture), day);
  if (!p.ok) throw new Error(`${fixture}: ${p.detail}`);
  return tseRegistryFromSnapshot(p.snap, urlOf(fixture), officialFixtureFetchedAt(fixture));
}
function eqRegistryOf(fixture: string, edits?: Edits): Registries["eq"] {
  const p = parseEqResults(bodyOf({ fixture, edits }));
  if (!p.ok) throw new Error(`${fixture}: ${p.detail}`);
  return eqRegistryFromSnapshot(p.snap, urlOf(fixture), officialFixtureFetchedAt(fixture));
}
const authorityOf = (s: ElectionSeriesId) => (s.startsWith("qc_") ? "eq" : "tse");
function mapEv(series: ElectionSeriesId, labels: string[], extra: Partial<ElectionEventInput> = {}): ElectionEventInput {
  const tse = authorityOf(series) === "tse";
  return { series, period: tse ? TSE_DAY_2022 : EQ_DAY_2022, release_at: tse ? TSE_CLOSE_2022 : EQ_CLOSE_2022, title: `Eval: ${series} (2022 count)`, criteria: `Paraphrased eval rules. ${TIE_TEXT}`, labels, ...extra };
}
/** An election leg built by the production leg builder (src/markets/election-legs.ts) against the authority's own registry. */
function electionLeg(series: ElectionSeriesId, label: string, reg: Registries, opts: { labels?: string[]; party?: string; unit?: string; day?: { period: string; release_at: string } } = {}): Reg {
  const ev = mapEv(series, opts.labels ?? [label], { ...(opts.party ? { party: opts.party } : {}), ...(opts.unit ? { unit: opts.unit } : {}), ...(opts.day ?? {}) });
  const b = buildElectionLeg(ev, { external_id: `eval-${series}-${label}`.replace(/[^A-Za-z0-9-]+/g, "-").slice(0, 80), label, open_at: "2022-09-01T00:00:00Z", deadline_utc: "2027-06-30T23:59:00Z" }, reg);
  if (!b.ok) throw new Error(`electionLeg ${series} "${label}": ${b.reason}`);
  return b.market;
}
const tseRead = (fixture: string, edits?: Edits): Read => ({ fixture, parser: "tse_result", select: TSE_DAY_2022, observed_at: officialFixtureFetchedAt(fixture), ...(edits ? { edits } : {}) });
const eqRead = (fixture: string, edits?: Edits, eq?: EqOps): Read => ({ fixture, parser: "eq_result", select: EQ_DAY_2022, observed_at: officialFixtureFetchedAt(fixture), ...(edits ? { edits } : {}), ...(eq ? { eq } : {}) });
/** The 2022 Élections Québec archive as the production parser reads it (the SYNTHETIC helpers check their inputs against it). */
const EQ2022 = (() => { const p = parseEqResults(officialFixture(EL.eq2022)); if (!p.ok) throw new Error(p.detail); return p.snap; })();
/**
 * SYNTHETIC Québec: candidate `id`, who has `from` votes in the 2022 archive, set to `to` (an EqOps.votes pair: its
 * riding's valid votes and votes cast, the file's and its party's total move with it, so the file stays consistent).
 */
function eqSet(id: string, from: number, to: number): [string, number] {
  const c = EQ2022.ridings.flatMap((r) => r.candidates).filter((x) => x.id === id);
  if (c.length !== 1 || Number(c[0]!.votes) !== from) throw new Error(`candidate ${id}: ${c.length} in ${EL.eq2022}${c[0] ? ` with ${c[0].votes} votes, not ${from}` : ""}`);
  return [id, to];
}
/** SYNTHETIC: two candidates of one riding trade vote counts (their riding's and the file's totals unchanged, their parties' restated). */
function eqSwap(a: [string, number], b: [string, number]): Array<[string, number]> { return [eqSet(a[0], a[1], b[1]), eqSet(b[0], b[1], a[1])]; }
/** SYNTHETIC Québec edit of one file-wide statistic of the 2022 archive (the text `"key": value,` is unique in the saved body). */
function eqStat(key: "nbVoteValide" | "nbVoteExerce" | "nbBureauVote" | "nbBureauVoteRempli", by: number): [string, string] {
  const body = officialFixture(EL.eq2022);
  const v = eqParse(body).statistiques[key];
  const from = `"${key}": ${v},`;
  if (body.split(from).length !== 2) throw new Error(`${from} is not exactly once in ${EL.eq2022}`);
  return [from, `"${key}": ${v + by},`];
}
/** SYNTHETIC Québec edit of one party's total in the 2022 archive's statistics, nothing else changed. */
function eqPartyTotal(party: number, by: number): [string, string] {
  const body = officialFixture(EL.eq2022);
  const p = eqParse(body).statistiques.partisPolitiques.filter((x) => x.numeroPartiPolitique === party);
  const from = p.length === 1 ? `"nbVoteTotal": ${p[0]!.nbVoteTotal},` : "";
  if (!from || body.split(from).length !== 2) throw new Error(`party ${party}: its total is not exactly once in ${EL.eq2022}`);
  return [from, `"nbVoteTotal": ${p[0]!.nbVoteTotal + by},`];
}
const EL_YES = { status: "RESOLVED", outcome: "OPTION_A", caveats_include: ["first_print", "single_source"] } as const;
const EL_NO = { status: "RESOLVED", outcome: "OPTION_B", caveats_include: ["first_print", "single_source"] } as const;
const PENDING = (c: string) => ({ status: "UNRESOLVED", outcome: "NONE", caveats_include: [c] }) as const;
const NOT_FINAL = PENDING("count_not_final");
/**
 * SYNTHETIC Taschereau 2022 (34,691 votes cast; 1% is 346.91): Robin (PQ) brought to 346 votes behind Grandmont (QS),
 * inside the riding-lead margin, or to 347 behind, just outside it; the votes come from St-Hilaire (CAQ), so the
 * riding's valid votes are unchanged. TASCH_LEAD_EXACT: 9 fewer votes leave St-Hilaire, so 34,700 are cast and Robin
 * 347 behind is exactly 1% of them (inside the margin, which only a lead of MORE than 1% clears); TASCH_LEAD_348: the
 * same 34,700 cast with Robin 348 behind, just outside.
 */
const tasch = (robin: number, stHilaire: number): EqOps => ({ votes: [eqSet("2467", 7757, robin), eqSet("2311", 7537, stHilaire)] });
const TASCH_LEAD_346 = tasch(13242, 2052), TASCH_LEAD_347 = tasch(13241, 2053), TASCH_LEAD_EXACT = tasch(13241, 2062), TASCH_LEAD_348 = tasch(13240, 2063);
/**
 * SYNTHETIC 2022 Québec seat tie: in Rosemont, Taschereau, Maurice-Richard and Jean-Lesage the QS and PQ candidates
 * trade vote counts, so QS and PQ both hold 7 seats (every lead stays above 1% of the votes cast) and PQ's valid votes
 * (618,745) end 18,091 ahead of QS's (600,654), less than 1% of the 4,112,821 valid votes: 3rd place is not settled.
 */
const QC_SEAT_TIE_VOTES: Array<[string, number]> = [
  ...eqSwap(["2229", 13311], ["2436", 7527]), ...eqSwap(["2505", 13588], ["2467", 7757]),
  ...eqSwap(["2378", 10903], ["2793", 4612]), ...eqSwap(["2504", 11390], ["2374", 3337]),
];
const QC_SEAT_TIE: EqOps = { votes: QC_SEAT_TIE_VOTES };
/** The 3 ridings the PQ won in 2022: Camille-Laurin (370), Îles-de-la-Madeleine (858) and Matane-Matapédia (842). */
const PQ_RIDINGS_2022 = ["370", "858", "842"];
/**
 * SYNTHETIC 2022 Québec seat tie (QC_SEAT_TIE: QS and PQ at 7 seats) with the PQ's valid votes brought ahead of QS's by
 * about `pct`% of the file's valid votes (QC_PARTY_VOTES is 1%), or by exactly 1% (pct "1 exactly"): votes are added to
 * the PQ's candidates in the 3 ridings it won in 2022 (each still wins, by more), and for the exact case up to 98 to the
 * CAQ's candidate with the widest lead in the file, so the valid votes are a multiple of 100. Returns the operations and
 * the gap it reaches, checked exactly.
 */
function qcPartyGap(pct: 0.95 | 1.05 | "1 exactly"): { ops: EqOps; gap: string; pct: string } {
  const at = (ops: EqOps) => { const p = parseEqResults(eqApply(officialFixture(EL.eq2022), ops)); if (!p.ok) throw new Error(p.detail); return p.snap; };
  const votesOf = (snap: typeof EQ2022, party: string) => snap.ridings.flatMap((r) => r.candidates).filter((c) => c.party === party).reduce((a, c) => a + Number(c.votes), 0);
  const base = at(QC_SEAT_TIE);
  const d0 = votesOf(base, "8") - votesOf(base, "40"), V0 = Number(base.valid);
  const f = pct === "1 exactly" ? 0.01 : pct / 100;
  // PQ + a, valid + a + b: exactly 1% needs 100 (d0 + a) = V0 + a + b
  const a = pct === "1 exactly" ? Math.ceil((V0 - 100 * d0) / 99) : Math.round((f * V0 - d0) / (1 - f));
  const b = pct === "1 exactly" ? 100 * (d0 + a) - (V0 + a) : 0;
  if (a <= 0 || b < 0 || b > 98) throw new Error(`qcPartyGap ${pct}: a=${a} b=${b}`);
  const pq = PQ_RIDINGS_2022.map((id) => { const c = EQ2022.ridings.find((r) => r.id === id)!.candidates.filter((x) => x.party === "8"); if (c.length !== 1) throw new Error(`riding ${id}: ${c.length} PQ candidates`); return c[0]!; });
  const lead = (r: typeof EQ2022.ridings[number]) => { const v = r.candidates.map((c) => Number(c.votes)).sort((x, y) => y - x); return v[0]! - v[1]!; };
  const caqSafe = [...EQ2022.ridings].filter((r) => [...r.candidates].sort((x, y) => Number(y.votes) - Number(x.votes))[0]!.party === "27").sort((x, y) => lead(y) - lead(x))[0]!;
  const caq = caqSafe.candidates.find((c) => c.party === "27")!;
  const add: Array<[string, number]> = pq.map((c, i) => eqSet(c.id, Number(c.votes), Number(c.votes) + Math.floor(a / 3) + (i === 0 ? a % 3 : 0)));
  const ops: EqOps = { votes: [...QC_SEAT_TIE_VOTES, ...add, ...(b ? [eqSet(caq.id, Number(caq.votes), Number(caq.votes) + b)] : [])] };
  const s = at(ops), d = votesOf(s, "8") - votesOf(s, "40"), V = Number(s.valid);
  const ok = pct === "1 exactly" ? d * 100 === V : pct === 0.95 ? d * 100 < V && d * 1000 > 9 * V && Math.abs(d / V - 0.0095) < 0.00005 : d * 100 > V && Math.abs(d / V - 0.0105) < 0.00005;
  if (!ok) throw new Error(`qcPartyGap ${pct}: the PQ leads QS by ${d} of ${V} valid votes`);
  return { ops, gap: `${d.toLocaleString("en-US")} of ${V.toLocaleString("en-US")} valid votes`, pct: `${(100 * d / V).toFixed(4)}%` };
}
/**
 * SYNTHETIC TSE edit (2022 simplified layout): the named candidates' vote counts (vap, by ballot number) set, with the
 * file's valid votes (vv), nominal votes counted (vvc), total votes (tv) and turnout (c) moved by the net change, so the
 * file still adds up (tseIntegrity). Each edit spans the saved text from the ballot number to its vote count, or is one
 * top-level field, each exactly once in the file.
 */
function tseVotes(fixture: string, set: Array<[string, number]>): Edits {
  const body = officialFixture(fixture);
  const once = (needle: string | RegExp): RegExpExecArray => {
    const re = typeof needle === "string" ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : new RegExp(needle.source, "g");
    const m = [...body.matchAll(re)];
    if (m.length !== 1) throw new Error(`${fixture}: ${String(needle)} is found ${m.length} times`);
    return m[0] as RegExpExecArray;
  };
  const edits: Edits = [];
  let net = 0;
  for (const [n, to] of set) {
    const start = once(`"n" : "${n}",`).index!;
    const m = /"vap" : "(\d+)"/.exec(body.slice(start));
    if (!m) throw new Error(`${fixture}: candidate ${n} has no vap`);
    const from = body.slice(start, start + m.index + m[0].length);
    net += to - Number(m[1]);
    edits.push([from, from.replace(/"vap" : "\d+"$/, `"vap" : "${to}"`)]);
  }
  if (net !== 0) {
    for (const k of ["vv", "vvc", "tv", "c"]) {
      const m = once(new RegExp(`"${k}" : "(\\d+)"`));
      edits.push([m[0], `"${k}" : "${Number(m[1]) + net}"`]);
    }
  }
  return edits;
}
/** A TSE file's candidate by ballot number, as the production parser reads it. */
function tseVotesOf(fixture: string, n: string): number {
  const p = parseTseResult(officialFixture(fixture), TSE_DAY_2022);
  if (!p.ok) throw new Error(p.detail);
  const c = p.snap.candidates.filter((x) => x.id === n);
  if (c.length !== 1) throw new Error(`${fixture}: candidate ${n} ${c.length} times`);
  return Number(c[0]!.votes);
}
/**
 * SYNTHETIC Acre final count with Lula at 202,000 and Bolsonaro `gap` votes ahead, Constituinte Eymael's count moved so
 * the valid votes are 441,000 (0.1 percentage point of them, BR_RANK_GAP, is 441 votes); every total restated.
 */
function acGap(gap: number): Edits {
  const f = EL.ac2022, V = 441_000, lula = 202_000;
  const others = 440_917 - tseVotesOf(f, "22") - tseVotesOf(f, "13") - tseVotesOf(f, "27");
  const eymael = V - lula - (lula + gap) - others;
  if (eymael < 0) throw new Error(`acGap ${gap}: Eymael ${eymael}`);
  return tseVotes(f, [["13", lula], ["22", lula + gap], ["27", eymael]]);
}
/** SYNTHETIC 2022 national final with Lula `gap` votes ahead of Bolsonaro, their sum (and every total) unchanged; `gap` must be odd (the sum is). */
function brLead(gap: number): Edits {
  const f = EL.br2022.final, sum = tseVotesOf(f, "13") + tseVotesOf(f, "22");
  if ((sum + gap) % 2) throw new Error(`brLead ${gap}: parity`);
  return tseVotes(f, [["13", (sum + gap) / 2], ["22", (sum - gap) / 2]]);
}
/** SYNTHETIC 2022 national final: Ciro Gomes's 3,599,287 votes annulled sub judice (vv and vansj moved with them). */
const CIRO_SUB_JUDICE: Edits = [
  ['"dvt" : "Válido", "vap" : "3599287"', '"dvt" : "Anulado sub judice", "vap" : "3599287"'],
  ['"vv" : "118229719"', '"vv" : "114630432"'], ['"vansj" : "0"', '"vansj" : "3599287"'],
];
/** SYNTHETIC 2022 national final: voters of installed sections cut to 152,694,286, so turnout over them is 81.00% while turnout over the 156,454,011 eligible stays 79.05%. */
const ESI_81: Edits = [['"esi" : "156453354"', '"esi" : "152694286"']];
/** SYNTHETIC: Acre's two leaders brought within 96 votes (0.02 pp of 440,917 valid votes); their sum and every total unchanged. */
const AC_NEAR_TIE: Edits = [['"vap" : "275582"', '"vap" : "202350"'], ['"vap" : "129022"', '"vap" : "202254"']];
/** SYNTHETIC: Taschereau (730 on the 2022 map) under the 2026 code of the qc_riding_751 event, so the rail's own riding copy is what the leg reads. */
const TASCH_AS_751: Edits = [['"numeroCirconscription": 730,', '"numeroCirconscription": 751,']];
/**
 * SYNTHETIC 2022 Québec near-tie for the most seats: in 33 ridings the CAQ won by more than 1% of the votes cast, the
 * CAQ's and the PLQ's candidates trade parties. The CAQ then holds 55 seats outright and 57 with Beauce-Nord and Fabre
 * (both inside the 1% margin), the PLQ 54 and 55 with Fabre: which of the two has the most seats is not settled.
 */
const QC_TOP_TIE: EqOps = { trade: [{ parties: ["27", "6"], ridings: QC_TOP_TIE_RIDINGS }] };
/** SYNTHETIC 2022 Québec: the CAQ's and the PQ's candidates trade parties in every riding, so the PQ holds the CAQ's 88 to 90 seats and the CAQ the PQ's 3. */
const QC_PQ_LEADS: EqOps = { trade: [{ parties: ["27", "8"], ridings: "all" }] };
/** SYNTHETIC: both of the above: the PQ (55 to 57 seats) and the PLQ (54 to 55) are not settled for the most seats. */
const QC_PQ_TOP_TIE: EqOps = { trade: [{ parties: ["27", "8"], ridings: "all" }, { parties: ["8", "6"], ridings: QC_TOP_TIE_RIDINGS }] };
/** SYNTHETIC attribution: the Quebec general election of 2018-10-01, a day the rail's registry has no riding count for (polls closed 20:00 EDT). */
const EQ_2018 = { period: "2018-10-01", release_at: "2018-10-02T00:00:00Z" };
/** The Québec seat-margin event's legs, with the party named as the 2022 registry names it. */
const PQ = "Parti québécois";
const SEAT_MARGIN_LABELS = [`${PQ} <10`, `${PQ} 10-19`, `${PQ} 20-29`, `${PQ} 30-39`, `${PQ} 40+`, "Another Party Wins"];
function eqRidingCode(name: string): string {
  const p = parseEqResults(officialFixture(EL.eq2022));
  if (!p.ok) throw new Error(p.detail);
  const r = p.snap.ridings.filter((x) => x.name === name);
  if (r.length !== 1) throw new Error(`riding ${name}: ${r.length}`);
  return r[0]!.id;
}

/**
 * Election legs on the 2022 counts (TSE first round of 2022-10-02, Wayback captures of the official files; Élections
 * Québec 2022 archive) and the TSE 2026 simulation, each built by the production leg builder against the authority's
 * registry: final vs not-final counts, near ties, bucket edges and label mapping.
 */
function electionCases(): OfficialCase[] {
  const br: Registries = { tse: tseRegistryOf(EL.br2022.final, TSE_DAY_2022) };
  const ac: Registries = { tse: tseRegistryOf(EL.ac2022, TSE_DAY_2022) };
  const mg: Registries = { tse: tseRegistryOf(EL.mg2022, TSE_DAY_2022) };
  const sp: Registries = { tse: tseRegistryOf(EL.sp2022, TSE_DAY_2022) };
  const eq: Registries = { eq: eqRegistryOf(EL.eq2022) };
  const named = ["Lula", "Jair Bolsonaro", "Simone Tebet", "Ciro Gomes"];
  const tasch = eqRidingCode("Taschereau");
  const taschWinner = (() => {
    const p = parseEqResults(officialFixture(EL.eq2022));
    if (!p.ok) throw new Error(p.detail);
    const r = p.snap.ridings.find((x) => x.id === tasch)!;
    return [...r.candidates].sort((a, b) => Number(b.votes) - Number(a.votes))[0]!;
  })();
  const L = electionLeg;
  const sim = L("br_pres_r1_winner", "Lula", br, { labels: named });
  const g95 = qcPartyGap(0.95), g100 = qcPartyGap("1 exactly"), g105 = qcPartyGap(1.05);
  const pqThird = L("qc_third_place", "Parti québécois", eq, { labels: ["Parti québécois", "Québec solidaire"] });
  const acFirst = L("br_pres_r1_first_ac", "Jair Bolsonaro", ac, { labels: named });
  const tasch751 = L("qc_riding_751", taschWinner.name, { eq: eqRegistryOf(EL.eq2022, TASCH_AS_751) });
  const lastOf842 = EQ2022.ridings.find((r) => r.id === "842")!.candidates.at(-1)!.id;
  const simMarket: Reg = { ...sim, resolver: { ...(sim.resolver as Extract<Reg["resolver"], { kind: "official_release" }>), period: "2026-10-04", release_at: "2026-10-04T20:00:00Z" }, sources: [{ kind: "official_release", ref: "official:br_pres_r1_winner:2026-10-04" }] };
  return [
    // --- election_final: only the authority's own final count decides (red when election_final_count is off) -------
    { id: "EL-F01", group: "election_final", control: false, title: "TSE 2022 national file at 1.99% of sections (17:55 BRT, Bolsonaro 48.8% ahead): the national-winner leg for Bolsonaro stays pending", market: L("br_pres_r1_winner", "Jair Bolsonaro", br, { labels: named }), fetched: tseRead(EL.br2022.first), expect: NOT_FINAL },
    { id: "EL-F02", group: "election_final", control: false, title: "TSE 2022 national file at 99.99% (md=S, tf=n, 10 sections left): Lula's 1st place is mathematically settled but not totalized; pending", market: L("br_pres_r1_winner", "Lula", br, { labels: named }), fetched: tseRead(EL.br2022.mdS), expect: NOT_FINAL },
    { id: "EL-F03", group: "election_final", control: false, title: "TSE 2022 São Paulo file at 99.9% of sections (tf=n): Bolsonaro's 1st place in the state is not final; pending", market: L("br_pres_r1_first_sp", "Jair Bolsonaro", sp, { labels: named }), fetched: tseRead(EL.sp2022), expect: NOT_FINAL },
    { id: "EL-F04", group: "election_final", control: false, title: "TSE 2022 national 1.99% file: Lula's 4th-place leg (No once final) stays pending, never No from a partial count", market: L("br_pres_r1_fourth", "Lula", br, { labels: named }), fetched: tseRead(EL.br2022.first), expect: NOT_FINAL },
    { id: "EL-FC1", group: "election_final", control: true, title: "TSE 2022 national final count (tf=s, 04/10 10:27 BRT): Lula 1st nationally, Yes", market: L("br_pres_r1_winner", "Lula", br, { labels: named }), fetched: tseRead(EL.br2022.final), expect: EL_YES },
    { id: "EL-FC2", group: "election_final", control: true, title: "TSE 2022 national final count: Bolsonaro's national-winner leg is No", market: L("br_pres_r1_winner", "Jair Bolsonaro", br, { labels: named }), fetched: tseRead(EL.br2022.final), expect: EL_NO },
    { id: "EL-FC3", group: "election_final", control: true, title: "TSE 2022 Acre final count: Bolsonaro 1st in Acre (62.5% of valid votes), Yes", market: L("br_pres_r1_first_ac", "Jair Bolsonaro", ac, { labels: named }), fetched: tseRead(EL.ac2022), expect: EL_YES },
    { id: "EL-FC4", group: "election_final", control: true, title: "TSE 2022 Minas Gerais final count: Lula 1st in the state (48.3% vs 43.6%), Yes", market: L("br_pres_r1_first_mg", "Lula", mg, { labels: named }), fetched: tseRead(EL.mg2022), expect: EL_YES },
    { id: "EL-FC5", group: "election_final", control: true, title: "TSE 2022 national final count: Simone Tebet 3rd (4.16% vs Ciro 3.04%), Yes", market: L("br_pres_r1_third", "Simone Tebet", br, { labels: named }), fetched: tseRead(EL.br2022.final), expect: EL_YES },
    { id: "EL-FC6", group: "election_final", control: true, title: "TSE 2022 national final count: Ciro Gomes 4th, Yes", market: L("br_pres_r1_fourth", "Ciro Gomes", br, { labels: named }), fetched: tseRead(EL.br2022.final), expect: EL_YES },
    { id: "EL-FC7", group: "election_final", control: true, title: "TSE 2022 national final count: turnout 79.05% (over eligible voters and over installed sections alike) is in 75-80%, Yes", market: L("br_pres_r1_turnout", "75-80%", br), fetched: tseRead(EL.br2022.final), expect: EL_YES },
    { id: "EL-FC8", group: "election_final", control: true, title: "TSE 2026 SIMULATION file from resultados-sim.tse.jus.br: not the series' host, never evidence", market: simMarket, fetched: { fixture: EL.sim2026, parser: "tse_result", select: "2026-10-04", observed_at: officialFixtureFetchedAt(EL.sim2026) }, expect: { status: "ERROR", outcome: "NONE", error_reason: "SOURCE_REF_MISMATCH" } },
    { id: "EL-FC10", group: "election_final", control: true, title: "SYNTHETIC: the 2026 simulation bytes (f=s, final flags, stamped 24/09/2026) served at the official host and read after polls close: never a result", market: simMarket, fetched: { fixture: EL.sim2026, parser: "tse_result", select: "2026-10-04", observed_at: "2026-10-05T12:00:00Z", url: "https://resultados.tse.jus.br/oficial/ele2026/21270/dados/br/br-c0001-e021270-u.json" }, expect: AWAIT },
    { id: "EL-FC9", group: "election_final", control: true, title: `Élections Québec 2022 final file (every riding final): ${taschWinner.name} wins Taschereau, Yes`, market: L("qc_riding_751", taschWinner.name, eq, { unit: tasch }), fetched: eqRead(EL.eq2022), expect: EL_YES },
    // --- election_margin: a decisive number inside the safety margin stays pending (red when election_safety_margin is off)
    { id: "EL-M01", group: "election_margin", control: false, title: "SYNTHETIC Acre final count with the leaders 96 votes apart (0.02 pp): Bolsonaro's 1st-place leg abstains (near_tie)", market: L("br_pres_r1_first_ac", "Jair Bolsonaro", ac, { labels: named }), fetched: tseRead(EL.ac2022, AC_NEAR_TIE), expect: PENDING("near_tie") },
    { id: "EL-M02", group: "election_margin", control: false, title: "TSE 2022 national final: Lula's margin 5.2332 pp is 0.017 pp from the 5.25% bucket edge: the 'Lula 5.25%+' leg abstains", market: L("br_pres_r1_margin", "Lula 5.25%+", br), fetched: tseRead(EL.br2022.final), expect: PENDING("near_bucket_edge") },
    { id: "EL-M03", group: "election_margin", control: false, title: "TSE 2022 national final: Lula's 48.4312% of valid votes is 0.019 pp from the 48.45% edge: the '45-48.45%' share leg abstains", market: L("br_pres_r1_share_lula", "45-48.45%", br), fetched: tseRead(EL.br2022.final), expect: PENDING("near_bucket_edge") },
    { id: "EL-M04", group: "election_margin", control: false, title: "SYNTHETIC Taschereau 2022: Grandmont leads by 346 votes, not more than 1% of the 34,691 cast (346.91): his riding-winner leg stays pending", market: L("qc_riding_751", taschWinner.name, eq, { unit: tasch }), fetched: eqRead(EL.eq2022, undefined, TASCH_LEAD_346), expect: PENDING("recount_range") },
    { id: "EL-M05", group: "election_margin", control: false, title: "Élections Québec 2022 final: CAQ holds 88 seats outright and 90 with Beauce-Nord (lead 0.59%) and Fabre (0.88%), both inside the 1% margin: the CAQ '90+' seats leg stays pending", market: L("qc_seats_caq", "90+", eq, { party: "Coalition Avenir Québec" }), fetched: eqRead(EL.eq2022), expect: PENDING("recount_range") },
    { id: "EL-M06", group: "election_margin", control: false, title: "SYNTHETIC 2022 Québec seat tie: QS and PQ both hold 7 seats and their valid votes are 0.44% apart (under 1%): the PQ 3rd-place leg stays pending", market: L("qc_third_place", "Parti québécois", eq, { labels: ["Parti québécois", "Québec solidaire"] }), fetched: eqRead(EL.eq2022, undefined, QC_SEAT_TIE), expect: PENDING("recount_range") },
    { id: "EL-M07", group: "election_margin", control: false, title: "SYNTHETIC 2022 national final with the voters of installed sections cut: turnout 79.05% of eligible voters but 81.00% of installed-section voters: the 75-80% leg stays pending", market: L("br_pres_r1_turnout", "75-80%", br), fetched: tseRead(EL.br2022.final, ESI_81), expect: PENDING("turnout_definitions_disagree") },
    { id: "EL-M08", group: "election_margin", control: false, title: "SYNTHETIC 2022 national final with Ciro Gomes annulled sub judice: he finishes 4th if his votes are validated and far below 4th if they stay annulled: his 4th-place leg stays pending", market: L("br_pres_r1_fourth", "Ciro Gomes", br, { labels: [...named, "Soraya Thronicke", "Felipe d'Avila"] }), fetched: tseRead(EL.br2022.final, CIRO_SUB_JUDICE), expect: PENDING("sub_judice_votes") },
    { id: "EL-M09", group: "election_margin", control: false, title: "SYNTHETIC 2022 national final with Ciro Gomes annulled sub judice: Lula's share is 49.95% of valid votes while Ciro's votes stay annulled and 48.43% once they are validated: the '49%+' share leg stays pending", market: L("br_pres_r1_share_lula", "49%+", br), fetched: tseRead(EL.br2022.final, CIRO_SUB_JUDICE), expect: PENDING("sub_judice_votes") },
    { id: "EL-M10", group: "election_margin", control: false, title: "Élections Québec 2022 final: Beauce-Nord (PCQ 202 votes, 0.59% of the votes cast, behind the CAQ) is the one riding inside the 1% margin the PCQ could win, so its seats are 0 or 1: the PCQ '1+' seats leg stays pending", market: L("qc_seats_pcq", "1+", eq, { party: "Parti conservateur du Québec" }), fetched: eqRead(EL.eq2022), expect: PENDING("recount_range") },
    { id: "EL-MC3", group: "election_margin", control: true, title: "SYNTHETIC Taschereau 2022: Grandmont leads by 347 votes, more than 1% of the votes cast: his riding-winner leg is Yes", market: L("qc_riding_751", taschWinner.name, eq, { unit: tasch }), fetched: eqRead(EL.eq2022, undefined, TASCH_LEAD_347), expect: EL_YES },
    { id: "EL-MC4", group: "election_margin", control: true, title: "Élections Québec 2022 final: CAQ's 88 to 90 seats are all in '80+': Yes", market: L("qc_seats_caq", "80+", eq, { party: "Coalition Avenir Québec" }), fetched: eqRead(EL.eq2022), expect: EL_YES },
    { id: "EL-MC5", group: "election_margin", control: true, title: "SYNTHETIC 2022 Québec seat tie (QS and PQ at 7): PLQ's 21 or 22 seats are 2nd outright, Yes", market: L("qc_second_place", "Parti libéral du Québec", eq, { labels: ["Parti libéral du Québec", "Parti québécois"] }), fetched: eqRead(EL.eq2022, undefined, QC_SEAT_TIE), expect: EL_YES },
    { id: "EL-MC6", group: "election_margin", control: true, title: "SYNTHETIC 2022 national final with Ciro Gomes annulled sub judice: Simone Tebet is 3rd whether or not his votes are validated, Yes", market: L("br_pres_r1_third", "Simone Tebet", br, { labels: named }), fetched: tseRead(EL.br2022.final, CIRO_SUB_JUDICE), expect: EL_YES },
    { id: "EL-MC1", group: "election_margin", control: true, title: "TSE 2022 national final: Lula's margin 5.23 pp is in 5-7.5%, far from both edges, Yes", market: L("br_pres_r1_margin", "Lula 5-7.5%", br), fetched: tseRead(EL.br2022.final), expect: EL_YES },
    { id: "EL-MC2", group: "election_margin", control: true, title: "TSE 2022 national final: Lula's share 48.43% is in 45-50%, Yes", market: L("br_pres_r1_share_lula", "45-50%", br), fetched: tseRead(EL.br2022.final), expect: EL_YES },
    // --- election_margin, each margin at its boundary (SYNTHETIC): just inside, exactly on and just outside, so a margin
    // halved or shaved by 10%, or a strict comparison made non-strict (or the reverse), turns a case red -----------------
    { id: "EL-M13", group: "election_margin", control: false, title: `SYNTHETIC 2022 Québec seat tie (QS and PQ at 7 seats) with the PQ ${g95.gap} (${g95.pct}) ahead of QS, inside the 1% tie-break margin (QC_PARTY_VOTES): the PQ 3rd-place leg stays pending`, market: pqThird, fetched: eqRead(EL.eq2022, undefined, g95.ops), expect: { ...PENDING("recount_range"), detail_includes: ["40:7, 8:7"] } },
    { id: "EL-M14", group: "election_margin", control: false, title: `SYNTHETIC 2022 Québec seat tie (QS and PQ at 7 seats) with the PQ exactly 1% of the valid votes ahead of QS (${g100.gap}): a tie is broken by valid votes only when the parties are MORE than 1% apart, so the PQ 3rd-place leg stays pending`, market: pqThird, fetched: eqRead(EL.eq2022, undefined, g100.ops), expect: { ...PENDING("recount_range"), detail_includes: ["40:7, 8:7"] } },
    { id: "EL-MC16", group: "election_margin", control: true, title: `SYNTHETIC 2022 Québec seat tie (QS and PQ at 7 seats) with the PQ ${g105.gap} (${g105.pct}) ahead of QS, just outside the 1% margin: the PQ is 3rd, Yes`, market: pqThird, fetched: eqRead(EL.eq2022, undefined, g105.ops), expect: EL_YES },
    { id: "EL-M15", group: "election_margin", control: false, title: "SYNTHETIC Acre final count (441,000 valid votes) with Bolsonaro 419 votes (0.095 pp) ahead of Lula, inside the 0.1 pp rank gap (BR_RANK_GAP): his 1st-place leg abstains (near_tie)", market: acFirst, fetched: tseRead(EL.ac2022, acGap(419)), expect: PENDING("near_tie") },
    { id: "EL-M16", group: "election_margin", control: false, title: "SYNTHETIC Acre final count (441,000 valid votes) with Bolsonaro 441 votes ahead of Lula, exactly 0.1 pp: a gap counts only when MORE than 0.1 pp, so his 1st-place leg abstains (near_tie)", market: acFirst, fetched: tseRead(EL.ac2022, acGap(441)), expect: PENDING("near_tie") },
    { id: "EL-MC17", group: "election_margin", control: true, title: "SYNTHETIC Acre final count (441,000 valid votes) with Bolsonaro 463 votes (0.105 pp) ahead of Lula, just outside the rank gap: Bolsonaro 1st in Acre, Yes", market: acFirst, fetched: tseRead(EL.ac2022, acGap(463)), expect: EL_YES },
    { id: "EL-M17", group: "election_margin", control: false, title: "SYNTHETIC 2022 national final with Lula 112,319 votes (0.0950 pp of the 118,229,719 valid votes) ahead of Bolsonaro, inside the 0.1 pp rank gap: the margin-of-victory leg 'Lula <2.5%' abstains (near_tie), never Yes", market: L("br_pres_r1_margin", "Lula <2.5%", br), fetched: tseRead(EL.br2022.final, brLead(112_319)), expect: PENDING("near_tie") },
    { id: "EL-MC18", group: "election_margin", control: true, title: "SYNTHETIC 2022 national final with Lula 124,141 votes (0.1050 pp) ahead of Bolsonaro, just outside the rank gap and far from the 2.5% edge: 'Lula <2.5%' is Yes", market: L("br_pres_r1_margin", "Lula <2.5%", br), fetched: tseRead(EL.br2022.final, brLead(124_141)), expect: EL_YES },
    { id: "EL-M20", group: "election_margin", control: false, title: "SYNTHETIC Taschereau 2022 with 34,700 votes cast: Grandmont leads by 347, exactly 1% of the votes cast; a lead counts only when MORE than 1% (QC_RIDING_LEAD), so his riding-winner leg stays pending", market: L("qc_riding_751", taschWinner.name, eq, { unit: tasch }), fetched: eqRead(EL.eq2022, undefined, TASCH_LEAD_EXACT), expect: PENDING("recount_range") },
    { id: "EL-MC19", group: "election_margin", control: true, title: "SYNTHETIC Taschereau 2022 with 34,700 votes cast: Grandmont leads by 348, just over 1% of the votes cast: his riding-winner leg is Yes", market: L("qc_riding_751", taschWinner.name, eq, { unit: tasch }), fetched: eqRead(EL.eq2022, undefined, TASCH_LEAD_348), expect: EL_YES },
    // --- election_margin, the two readings of a Brazilian rank event (over all candidates and over the named ones): each
    // is exercised alone, so deciding from one reading, or dropping the rank gap from one reading, turns a case red ------
    { id: "EL-MC20", group: "election_margin", control: true, title: "TSE 2022 national final, a 4th-place event that names Lula, Bolsonaro, Tebet and Soraya Thronicke but not Ciro Gomes (4th of all): Soraya is 4th of the named candidates and 5th of all, so the readings differ and her leg abstains (unlisted_candidate_in_contention), never Yes", market: L("br_pres_r1_fourth", "Soraya Thronicke", br, { labels: ["Lula", "Jair Bolsonaro", "Simone Tebet", "Soraya Thronicke"] }), fetched: tseRead(EL.br2022.final), expect: PENDING("unlisted_candidate_in_contention") },
    { id: "EL-MC21", group: "election_margin", control: true, title: "TSE 2022 national final, a 3rd-place event that names only Tebet, Ciro Gomes and Soraya Thronicke: Tebet is 3rd of all candidates (Lula and Bolsonaro, not named, ahead) but 1st of the named ones, so her leg abstains (unlisted_candidate_in_contention), never Yes", market: L("br_pres_r1_third", "Simone Tebet", br, { labels: ["Simone Tebet", "Ciro Gomes", "Soraya Thronicke"] }), fetched: tseRead(EL.br2022.final), expect: PENDING("unlisted_candidate_in_contention") },
    { id: "EL-M18", group: "election_margin", control: false, title: "SYNTHETIC Acre final count with Lula, whom the event does not name, 96 votes (0.02 pp) behind Bolsonaro: Bolsonaro is clearly 1st of the named candidates but within the rank gap of 1st of all, so his 1st-place leg abstains (near_tie), never Yes", market: L("br_pres_r1_first_ac", "Jair Bolsonaro", ac, { labels: ["Jair Bolsonaro", "Simone Tebet", "Ciro Gomes"] }), fetched: tseRead(EL.ac2022, AC_NEAR_TIE), expect: PENDING("near_tie") },
    { id: "EL-M19", group: "election_margin", control: false, title: "SYNTHETIC Acre final count with Lula, whom the event does not name, clearly 1st (250,000) and Bolsonaro 50 votes (0.011 pp) behind the named Tebet: of the named candidates Bolsonaro's place is within the rank gap, so his 1st-place leg abstains (near_tie), never No", market: L("br_pres_r1_first_ac", "Jair Bolsonaro", ac, { labels: ["Jair Bolsonaro", "Simone Tebet"] }), fetched: tseRead(EL.ac2022, tseVotes(EL.ac2022, [["13", 250_000], ["22", 87_338], ["15", 87_388]])), expect: PENDING("near_tie") },
    // --- election_margin, the Québec seat-margin, PQ-majority and PVQ-seat events: a leader that is not settled is never
    // answered No (red when election_qc_leader_settled is off, and when the riding-lead margin is) ------------------------
    { id: "EL-M11", group: "election_margin", control: false, title: "SYNTHETIC 2022 Québec near-tie for the most seats (CAQ 55 to 57, PLQ 54 to 55 once Beauce-Nord and Fabre can go either way): 'Another Party Wins' stays pending, never No", market: L("qc_seat_margin", "Another Party Wins", eq, { party: PQ, labels: SEAT_MARGIN_LABELS }), fetched: eqRead(EL.eq2022, undefined, QC_TOP_TIE), expect: { ...PENDING("recount_range"), detail_includes: ["27:55-57, 6:54-55"] } },
    { id: "EL-M12", group: "election_margin", control: false, title: "SYNTHETIC 2022 Québec with the PQ in the CAQ's place and the same near-tie (PQ 55 to 57, PLQ 54 to 55): the PQ is not settled as the party with the most seats, so its '<10' margin leg stays pending, never No", market: L("qc_seat_margin", `${PQ} <10`, eq, { party: PQ, labels: SEAT_MARGIN_LABELS }), fetched: eqRead(EL.eq2022, undefined, QC_PQ_TOP_TIE), expect: { ...PENDING("recount_range"), detail_includes: ["8:55-57, 6:54-55"] } },
    { id: "EL-MC7", group: "election_margin", control: true, title: "Élections Québec 2022 final: the CAQ's 88 to 90 seats are the most outright (PLQ 21 to 22, PQ 3): 'Another Party Wins' is Yes", market: L("qc_seat_margin", "Another Party Wins", eq, { party: PQ, labels: SEAT_MARGIN_LABELS }), fetched: eqRead(EL.eq2022), expect: EL_YES },
    { id: "EL-MC8", group: "election_margin", control: true, title: "Élections Québec 2022 final: the PQ's 3 seats are never the most: its '<10' seat-margin leg is No", market: L("qc_seat_margin", `${PQ} <10`, eq, { party: PQ, labels: SEAT_MARGIN_LABELS }), fetched: eqRead(EL.eq2022), expect: EL_NO },
    { id: "EL-MC9", group: "election_margin", control: true, title: "Élections Québec 2022 final: the PQ's 3 seats are not a majority (the event's bucket is fixed at 64 seats or more): No", market: L("qc_pq_majority", "", eq, { party: PQ }), fetched: eqRead(EL.eq2022), expect: EL_NO },
    { id: "EL-MC10", group: "election_margin", control: true, title: "Élections Québec 2022 final: the PVQ led in no riding and is within 1% of the leader in none: 'wins at least one seat' is No", market: L("qc_pvq_seat", "", eq, { party: "Parti vert du Québec" }), fetched: eqRead(EL.eq2022), expect: EL_NO },
    { id: "EL-MC11", group: "election_margin", control: true, title: "SYNTHETIC 2022 Québec near-tie between the CAQ and the PLQ: the PQ's 3 seats are still never the most, so its '<10' seat-margin leg is No", market: L("qc_seat_margin", `${PQ} <10`, eq, { party: PQ, labels: SEAT_MARGIN_LABELS }), fetched: eqRead(EL.eq2022, undefined, QC_TOP_TIE), expect: EL_NO },
    { id: "EL-MC12", group: "election_margin", control: true, title: "SYNTHETIC 2022 Québec with the PQ in the CAQ's place (88 to 90 seats, PLQ 21 to 22): its margin is 66 to 69 seats, all in '40+': Yes", market: L("qc_seat_margin", `${PQ} 40+`, eq, { party: PQ, labels: SEAT_MARGIN_LABELS }), fetched: eqRead(EL.eq2022, undefined, QC_PQ_LEADS), expect: EL_YES },
    { id: "EL-MC13", group: "election_margin", control: true, title: "SYNTHETIC 2022 Québec with the PQ in the CAQ's place: its '30-39' seat-margin leg is No", market: L("qc_seat_margin", `${PQ} 30-39`, eq, { party: PQ, labels: SEAT_MARGIN_LABELS }), fetched: eqRead(EL.eq2022, undefined, QC_PQ_LEADS), expect: EL_NO },
    { id: "EL-MC14", group: "election_margin", control: true, title: "SYNTHETIC 2022 Québec with the PQ in the CAQ's place: the PQ has the most seats outright, so 'Another Party Wins' is No", market: L("qc_seat_margin", "Another Party Wins", eq, { party: PQ, labels: SEAT_MARGIN_LABELS }), fetched: eqRead(EL.eq2022, undefined, QC_PQ_LEADS), expect: EL_NO },
    { id: "EL-MC15", group: "election_margin", control: true, title: "SYNTHETIC 2022 Québec with the PQ in the CAQ's place: 88 to 90 seats are all 64 or more: the PQ-majority leg is Yes", market: L("qc_pq_majority", "", eq, { party: PQ }), fetched: eqRead(EL.eq2022, undefined, QC_PQ_LEADS), expect: EL_YES },
    // --- election_complete: a Québec snapshot that is not every riding of the election once decides nothing (red when
    // election_qc_complete_file is off) -----------------------------------------------------------------------------------
    { id: "EL-K01", group: "election_complete", control: false, title: "SYNTHETIC 2022 Québec file without the 3 ridings the PQ won (its statistics still state 125 ridings, all final): the PQ '<3' seats leg stays pending, never Yes from the 122 ridings present", market: L("qc_seats_pq", "<3", eq, { party: PQ }), fetched: eqRead(EL.eq2022, undefined, { drop: PQ_RIDINGS_2022 }), expect: PENDING("totals_inconsistent") },
    { id: "EL-K02", group: "election_complete", control: false, title: "SYNTHETIC 2022 Québec file without Matane-Matapédia and with its statistics restated to 124 ridings (consistent with itself): the 2022 election had 125, so the PQ '<3' seats leg stays pending, never Yes", market: L("qc_seats_pq", "<3", eq, { party: PQ }), fetched: eqRead(EL.eq2022, undefined, { dropRestated: ["842"] }), expect: PENDING("totals_inconsistent") },
    { id: "EL-K03", group: "election_complete", control: false, title: "SYNTHETIC 2022 Québec file with Matane-Matapédia numbered 370 like Camille-Laurin (125 entries, 124 ridings): the CAQ '80+' seats leg stays pending", market: L("qc_seats_caq", "80+", eq, { party: "Coalition Avenir Québec" }), fetched: eqRead(EL.eq2022, [['"numeroCirconscription": 842,', '"numeroCirconscription": 370,']]), expect: PENDING("totals_inconsistent") },
    { id: "EL-K04", group: "election_complete", control: false, title: `SYNTHETIC stored riding copy holding Taschereau and Matane-Matapédia: a riding copy is one riding, so ${taschWinner.name}'s Taschereau leg stays pending`, market: L("qc_riding_751", taschWinner.name, eq, { unit: tasch }), fetched: eqRead(EL.eq2022, undefined, { copy: [tasch, "842"] }), expect: PENDING("totals_inconsistent") },
    { id: "EL-K05", group: "election_complete", control: false, title: "SYNTHETIC 2022 Québec file without the 3 ridings the PQ won: 'Another Party Wins' stays pending too (nothing is read from a file with ridings missing)", market: L("qc_seat_margin", "Another Party Wins", eq, { party: PQ, labels: SEAT_MARGIN_LABELS }), fetched: eqRead(EL.eq2022, undefined, { drop: PQ_RIDINGS_2022 }), expect: PENDING("totals_inconsistent") },
    { id: "EL-K06", group: "election_complete", control: false, title: `SYNTHETIC stored riding copy holding Matane-Matapédia alone: not the leg's riding, so ${taschWinner.name}'s Taschereau leg stays pending`, market: L("qc_riding_751", taschWinner.name, eq, { unit: tasch }), fetched: eqRead(EL.eq2022, undefined, { copy: ["842"] }), expect: PENDING("totals_inconsistent") },
    { id: "EL-K07", group: "election_complete", control: false, title: "SYNTHETIC attribution of the 2022 archive to the election of 2018-10-01, a day the rail has no riding count for: the file cannot be checked for missing ridings, so the CAQ '80+' seats leg stays pending", market: L("qc_seats_caq", "80+", eq, { party: "Coalition Avenir Québec", day: EQ_2018 }), fetched: { ...eqRead(EL.eq2022), select: EQ_2018.period }, expect: PENDING("totals_inconsistent") },
    { id: "EL-KC1", group: "election_complete", control: true, title: "Élections Québec 2022 final, every one of the 125 ridings: the PQ won 3 seats, so its '<3' seats leg is No", market: L("qc_seats_pq", "<3", eq, { party: PQ }), fetched: eqRead(EL.eq2022), expect: EL_NO },
    { id: "EL-KC2", group: "election_complete", control: true, title: "Élections Québec 2022 final, every one of the 125 ridings: the PQ's 3 seats are in '3-9': Yes", market: L("qc_seats_pq", "3-9", eq, { party: PQ }), fetched: eqRead(EL.eq2022), expect: EL_YES },
    { id: "EL-KC3", group: "election_complete", control: true, title: `SYNTHETIC 2022 Québec file with Taschereau under its 2026 code 751: the rail's own riding copy (that one riding) decides, ${taschWinner.name} wins, Yes`, market: L("qc_riding_751", taschWinner.name, { eq: eqRegistryOf(EL.eq2022, TASCH_AS_751) }), fetched: eqRead(EL.eq2022, TASCH_AS_751), expect: EL_YES },
    // --- election_complete, the capture's gate on the whole file (red when election_qc_capture_integrity is off): a riding
    // event keeps a one-riding copy, on which whole-file sums cannot be compared, so a file that does not add up is never
    // recorded; the resolver still checks the whole file a seat leg keeps --------------------------------------------------
    { id: "EL-K08", group: "election_complete", control: false, title: `SYNTHETIC 2022 Québec file with Taschereau under 751 whose statistics state 1,000 more valid votes and votes cast than its ridings add up to: the capture records no read of it, so ${taschWinner.name}'s Taschereau leg is never decided from its one-riding copy (release_not_observed)`, market: tasch751, fetched: { ...eqRead(EL.eq2022, [...TASCH_AS_751, eqStat("nbVoteValide", 1000), eqStat("nbVoteExerce", 1000)]), capture: true }, expect: PENDING("release_not_observed") },
    { id: "EL-K09", group: "election_complete", control: false, title: `SYNTHETIC 2022 Québec file with Taschereau under 751 and Matane-Matapédia's candidate list truncated (its last candidate removed, its valid votes unchanged): the capture records no read of it, so ${taschWinner.name}'s Taschereau leg stays pending (release_not_observed)`, market: tasch751, fetched: { ...eqRead(EL.eq2022, TASCH_AS_751, { unlist: [lastOf842] }), capture: true }, expect: PENDING("release_not_observed") },
    { id: "EL-K10", group: "election_complete", control: false, title: `SYNTHETIC 2022 Québec file with Taschereau under 751 whose statistics give the PQ 1,000 more votes than its candidates have: the capture records no read of it, so ${taschWinner.name}'s Taschereau leg stays pending (release_not_observed)`, market: tasch751, fetched: { ...eqRead(EL.eq2022, [...TASCH_AS_751, eqPartyTotal(8, 1000)]), capture: true }, expect: PENDING("release_not_observed") },
    { id: "EL-K11", group: "election_complete", control: false, title: `SYNTHETIC 2022 Québec file with Taschereau under 751 whose statistics count one polling station more (all reported) than its ridings: the capture records no read of it, so ${taschWinner.name}'s Taschereau leg stays pending (release_not_observed)`, market: tasch751, fetched: { ...eqRead(EL.eq2022, [...TASCH_AS_751, eqStat("nbBureauVote", 1), eqStat("nbBureauVoteRempli", 1)]), capture: true }, expect: PENDING("release_not_observed") },
    { id: "EL-KC4", group: "election_complete", control: true, title: `SYNTHETIC 2022 Québec file with Taschereau under 751, read through the capture's gate: the whole file adds up, so it is recorded and ${taschWinner.name} wins, Yes`, market: tasch751, fetched: { ...eqRead(EL.eq2022, TASCH_AS_751), capture: true }, expect: EL_YES },
    { id: "EL-KC5", group: "election_complete", control: true, title: "SYNTHETIC 2022 Québec file whose statistics give the PQ 1,000 more votes than its candidates have: a seat leg keeps the whole file, so the PQ '3-9' seats leg stays pending (totals_inconsistent)", market: L("qc_seats_pq", "3-9", eq, { party: PQ }), fetched: eqRead(EL.eq2022, [eqPartyTotal(8, 1000)]), expect: PENDING("totals_inconsistent") },
    { id: "EL-KC6", group: "election_complete", control: true, title: "SYNTHETIC 2022 Québec file whose statistics count one polling station more (all reported) than its ridings: the PQ '3-9' seats leg stays pending (totals_inconsistent)", market: L("qc_seats_pq", "3-9", eq, { party: PQ }), fetched: eqRead(EL.eq2022, [eqStat("nbBureauVote", 1), eqStat("nbBureauVoteRempli", 1)]), expect: PENDING("totals_inconsistent") },
    // --- election_mapping: a label must map to exactly one authority entry (every case a control) -------------------
    { id: "EL-B01", group: "election_mapping", control: true, title: "'Lula' maps to TSE ballot number 13 in the 2022 registry", build: { event: mapEv("br_pres_r1_winner", named), label: "Lula", registry: { authority: "tse", fixture: EL.br2022.final } }, expect: { subject_id: "13" } },
    { id: "EL-B02", group: "election_mapping", control: true, title: "'Tarcísio de Freitas' (not a 2022 presidential candidate) matches no TSE candidate: refused", build: { event: mapEv("br_pres_r1_third", ["Tarcísio de Freitas", "Lula"]), label: "Tarcísio de Freitas", registry: { authority: "tse", fixture: EL.br2022.final } }, expect: { refused_includes: "matches no" } },
    { id: "EL-B03", group: "election_mapping", control: true, title: "No TSE registry (every TSE host answered 403): a candidate leg is refused, never registered by label", build: { event: mapEv("br_pres_r1_winner", named), label: "Lula", registry: null }, expect: { refused_includes: "no TSE candidate registry" } },
    { id: "EL-B04", group: "election_mapping", control: true, title: "Quebec riding leg naming a person who is not a candidate in that riding: refused", build: { event: mapEv("qc_riding_751", ["Vincent Marissal"], { unit: tasch }), label: "Vincent Marissal", registry: { authority: "eq", fixture: EL.eq2022 } }, expect: { refused_includes: "matches no" } },
    { id: "EL-B05", group: "election_mapping", control: true, title: "'Parti' matches more than one Élections Québec party: ambiguous, refused", build: { event: mapEv("qc_second_place", ["Parti"]), label: "Parti", registry: { authority: "eq", fixture: EL.eq2022 } }, expect: { refused_includes: "ambiguous" } },
    { id: "EL-B06", group: "election_mapping", control: true, title: "A seat-margin event that also lists a bucket for the CAQ: 'Another Party Wins' would mean neither the PQ nor the CAQ, which the rail does not read: refused", build: { event: mapEv("qc_seat_margin", [...SEAT_MARGIN_LABELS, "Coalition Avenir Québec 10-19"], { party: PQ }), label: "Another Party Wins", registry: { authority: "eq", fixture: EL.eq2022 } }, expect: { refused_includes: "means a party the event does not list" } },
    { id: "EL-B07", group: "election_mapping", control: true, title: "The same event: the PQ's own '<10' bucket is refused with it (the event, not only one leg)", build: { event: mapEv("qc_seat_margin", [...SEAT_MARGIN_LABELS, "Coalition Avenir Québec 10-19"], { party: PQ }), label: `${PQ} <10`, registry: { authority: "eq", fixture: EL.eq2022 } }, expect: { refused_includes: "the event is refused" } },
    { id: "EL-B08", group: "election_mapping", control: true, title: "A seat-margin event listing only the PQ's buckets and 'Another Party Wins': the leg maps to party 8", build: { event: mapEv("qc_seat_margin", SEAT_MARGIN_LABELS, { party: PQ }), label: "Another Party Wins", registry: { authority: "eq", fixture: EL.eq2022 } }, expect: { subject_id: "8" } },
  ];
}

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
    ...blsCases(),
    ...electionCases(),
  ];
}

// ---- building the rail's document from a saved body ---------------------------------------------------------------

const PROVENANCE = JSON.parse(readFileSync(resolve(OFFICIAL_FIXTURE_DIR, "provenance.json"), "utf8")) as { files: Record<string, { url: string }> };
const urlOf = (fixture: string) => { const u = PROVENANCE.files[fixture]?.url; if (!u) throw new Error(`no url for ${fixture}`); return u; };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** The BLS API v1 series each saved API body holds. */
const API_IDS: Record<string, string> = {
  "bls_v1_cpi.json": "CUUR0000SA0", "bls_v1_ppi.json": "WPUFD4", "bls_v1_cpi_sa.json": "CUSR0000SA0", "bls_v1_core_sa.json": "CUSR0000SA0L1E",
  "bls_v1_core_nsa.json": "CUUR0000SA0L1E", "bls_v1_unrate.json": "LNS14000000", "bls_v1_payrolls.json": "CES0000000001",
};
const apiId = (fixture: string) => { const id = API_IDS[fixture]; if (!id) throw new Error(`no BLS API series id for ${fixture}`); return id; };
const monthLabel = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

/** A saved body with its SYNTHETIC edits and operations applied (one that does not apply is a harness error, never a silent no-op). */
function bodyOf(read: Pick<Read, "fixture" | "edits" | "eq">): string {
  let body = officialFixture(read.fixture);
  for (const [from, to] of read.edits ?? []) {
    if (!body.includes(from)) throw new Error(`${read.fixture}: edit "${from.slice(0, 60)}" does not apply`);
    body = body.split(from).join(to);
  }
  return read.eq && eqChangesBody(read.eq) ? eqApply(body, read.eq, read.fixture) : body;
}
const bytesOf = (read: Read) => (read.edits?.length || eqChangesBody(read.eq) ? new TextEncoder().encode(bodyOf(read)) : officialFixtureBytes(read.fixture));

/** The parsed document, or { missing } when the production parser says the number is not published (never a value). */
function parse(read: Read): DocObservation | { missing: string } {
  const body = bodyOf(read);
  const need = (p: { ok: true; obs: DocObservation } | { ok: false; reason: string; detail: string }) => { if (!p.ok) throw new Error(`${read.fixture} ${read.parser}: ${p.reason} ${p.detail}`); return p.obs; };
  const orMissing = (p: DocParse) => (!p.ok && p.reason === "not_published" ? { missing: p.detail } : need(p));
  switch (read.parser) {
    case "bls_cpi_text": return need(parseBlsRelease(body, "cpi"));
    case "bls_cpi_table": { const [row, col] = read.select!.split(":") as [CpiTableRow, CpiTableColumn]; return orMissing(parseBlsCpiTableA(body, row, col)); }
    case "bls_empsit_text": return orMissing(parseEmpsitRelease(body, read.select as EmpsitNumber));
    case "bls_api_mom": case "bls_api_level": case "bls_api_change": {
      // what a reader of the API's current vintage sees (the rail records only the release; these stand for a later read)
      const id = apiId(read.fixture);
      const p = parseBlsApi(body, id);
      if (!p.ok) throw new Error(`${read.fixture}: ${p.detail}`);
      const per = read.select!, prev = previousMonth(per);
      if (read.parser === "bls_api_level") {
        const v = p.index.get(per);
        if (!v) throw new Error(`${read.fixture}: no ${per}`);
        return { period: per, value: Number(v), value_text: v, deciding_text: `BLS API v1 ${id}: ${monthLabel(per)} = ${v} percent`, direction: null, meta: {} };
      }
      if (read.parser === "bls_api_change") {
        const c = blsApiLevelChange(p.index, per);
        if (!c) throw new Error(`${read.fixture}: no ${per} change`);
        return { period: per, value: c.change, value_text: String(c.change), deciding_text: `BLS API v1 ${id}: ${monthLabel(per)} level ${c.current} minus ${monthLabel(prev)} level ${c.base} = ${c.change} thousand`, direction: null, meta: {} };
      }
      const m = blsApiMom(p.index, per);
      if (!m) throw new Error(`${read.fixture}: no ${per}`);
      const v = (m.tenths / 10).toFixed(1);
      return { period: per, value: Number(v), value_text: v, deciding_text: `BLS API v1 ${id}: ${monthLabel(per)} index ${m.current} over ${monthLabel(prev)} index ${m.base} = ${v} percent`, direction: null, meta: {} };
    }
    case "bls_ppi_text": return need(parseBlsRelease(body, "ppi"));
    case "fed_statement": return need(parseFomcStatement(body));
    case "ecb_release": return need(parseEcbRelease(body));
    case "boe_rss": return need(parseBoeRss(body, read.select!));
    case "bok_decision_rss": return need(parseBokDecisionRss(body, read.select!));
    case "bok_gdp_rss": return need(parseBokGdpRss(body, read.select!));
    case "bcb_history": return need(parseBcbHistory(body, read.select!));
    case "bls_api_yoy": {
      const id = apiId(read.fixture);
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
      return parse({ ...read, parser: "bcb_history", select: latest }) as DocObservation;
    }
    case "sgs432_row": {
      // SGS 432 forward-fills future dates with the current target: the row exists before the meeting happens
      const row = (JSON.parse(body) as Array<{ data: string; valor: string }>).find((r) => r.data === read.select);
      if (!row) throw new Error(`${read.fixture}: no ${read.select}`);
      const [d, m, y] = row.data.split("/");
      return { period: `${y}-${m}-${d}`, value: Number(row.valor), value_text: row.valor, deciding_text: `SGS 432 ${row.data} = ${row.valor}`, direction: null, meta: {} };
    }
    case "tse_result": case "eq_result": throw new Error(`${read.parser} is read by electionDoc`);
    default: { const never: never = read.parser; throw new Error(`unhandled parser ${String(never)}`); }
  }
}

/** An election read as the rail stores it: the production parser's snapshot, the part the series keeps, and a deciding text naming the day. */
function electionDoc(r: OfficialResolver, read: Read): OfficialDoc {
  const body = bodyOf(read);
  const p = read.parser === "tse_result" ? parseTseResult(body, read.select!) : parseEqResults(body);
  if (!p.ok) throw new Error(`${read.fixture} ${read.parser}: ${p.reason} ${p.detail}`);
  const snap = p.snap as ElectionSnapshot;
  if ((read.eq || read.capture) && snap.authority !== "eq") throw new Error(`${read.fixture}: eq operations and the capture gate apply to an Élections Québec read`);
  if (read.capture && snap.authority === "eq") {
    const refused = eqFileRefusal(snap, read.select!);
    if (refused) return { kind: "official_missing", series: r.series, period: r.period, release_at: new Date(releaseAtOf(r)).toISOString(), source_url: read.url ?? urlOf(read.fixture), detail: `not observed by release_at + 72 h: the capture refused every read of the file (${refused.kind}: ${refused.problems.join("; ")})`.slice(0, 500) };
  }
  // what the rail stores: its own part of the snapshot, or (SYNTHETIC, EqOps.copy) a copy holding the named ridings
  let contest = snapshotForSeries(r.series as ElectionSeriesId, snap);
  if (read.eq?.copy && snap.authority === "eq") {
    const kept = read.eq.copy.map((id) => { const x = snap.ridings.filter((y) => y.id === id); if (x.length !== 1) throw new Error(`${read.fixture}: copy: riding ${id} is listed ${x.length} times`); return x[0]!; });
    contest = { ...snap, ridings: kept };
  }
  const valid = snap.authority === "tse" ? snap.votes.valid : snap.valid;
  const deciding = snap.authority === "tse"
    ? `TSE President first-round count for ${snap.scope}, election day ${snap.election_day} (election ${snap.election_id}, environment ${snap.environment}): tf=${snap.flags.tf} dv=${snap.flags.dv}; ${snap.sections.totalized} of ${snap.sections.total} sections totalized; ${snap.votes.valid} valid votes.`
    : `Élections Québec general election results for election day ${read.select}: ${snap.ridings_with_result} of ${snap.ridings_total} ridings; updated ${snap.as_of}; ${snap.valid} valid votes.`;
  const at = new Date(read.observed_at).toISOString();
  return {
    kind: "official_observation", series: r.series, period: read.select!, value: Number(valid), value_text: valid, deciding_text: deciding,
    source_url: read.url ?? urlOf(read.fixture), raw_sha256: sha(bytesOf(read)), observed_at: at, direction: null,
    corroboration: { status: "single_source", source_url: null, value: null, value_text: null, detail: "no second source publishes the count on election night", checked_at: at },
    stated_prior: null, stated_step_bps: null, contest,
  };
}

function corroborate(series: OfficialSeriesId, obs: DocObservation, spec: Read["corroboration"], at: string): OfficialCorroboration | null {
  if (!spec) return null;
  if (spec.parser === "single_source") return { status: "single_source", source_url: null, value: null, value_text: null, detail: "SGS 432 forward-fills; the Copom history row is the only source", checked_at: at };
  const body = bodyOf({ fixture: spec.fixture!, edits: spec.edits });
  let v: string | undefined;
  switch (spec.parser) {
    case "bls_api_yoy": case "bls_api": {
      if (!(series in BLS_API)) throw new Error(`${series} has no BLS API corroboration`);
      if (apiId(spec.fixture!) !== BLS_API[series as keyof typeof BLS_API].id) throw new Error(`${spec.fixture} is not ${BLS_API[series as keyof typeof BLS_API].id}`);
      return blsCorroboration({ series: series as keyof typeof BLS_API, value: obs.value, value_text: obs.value_text }, spec.select!, body, urlOf(spec.fixture!), at);
    }
    case "fred": v = fredValueOn(body, spec.select!); break;
    case "ecb_dfr": v = parseEcbDfrCsv(body).find((r) => r.date === spec.select)?.value; break;
    case "iadb": v = iadbValueOn(body, spec.select!); break;
    case "ecos_daily": case "ecos_quarter": { const p = parseEcosRows(body); v = p.ok ? p.rows.find((r) => r.time === spec.select)?.value : undefined; break; }
    default: { const never: never = spec.parser; throw new Error(`unhandled corroboration ${String(never)}`); }
  }
  if (v === undefined) throw new Error(`${spec.fixture}: no corroboration row ${spec.select}`);
  return { status: sameAtPrecision(series, reading(obs), v) ? "agree" : "disagree", source_url: urlOf(spec.fixture!), value: Number(v), value_text: v, detail: `${spec.parser} ${spec.select} = ${v}`, checked_at: at };
}

function docOf(r: OfficialResolver, read: Read): OfficialDoc {
  if (read.parser === "tse_result" || read.parser === "eq_result") return electionDoc(r, read);
  const series = r.series;
  const obs = parse(read);
  if ("missing" in obs) {
    return { kind: "official_missing", series, period: r.period, release_at: new Date(releaseAtOf(r)).toISOString(), source_url: urlOf(read.fixture), detail: `not observed by release_at + 6 h: ${obs.missing}`.slice(0, 500) };
  }
  return {
    kind: "official_observation", series, period: obs.period, value: obs.value, value_text: obs.value_text, deciding_text: obs.deciding_text,
    source_url: urlOf(read.fixture), raw_sha256: sha(bytesOf(read)), observed_at: new Date(read.observed_at).toISOString(),
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
    if ("build" in k) return JSON.stringify(k);
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

/** A leg built from the authority's registry: refused with the expected reason, or mapped to the expected id. */
function runBuild(k: BuildCase): { failures: string[]; falseResolved: boolean } {
  const reg: Registries = { tseUnavailable: "every TSE host answered 403 (eval)" };
  const spec = k.build.registry;
  if (spec?.authority === "tse") reg.tse = tseRegistryOf(spec.fixture, k.build.event.period);
  if (spec?.authority === "eq") reg.eq = eqRegistryOf(spec.fixture);
  const b = buildElectionLeg(k.build.event, { external_id: k.id, label: k.build.label, open_at: "2022-09-01T00:00:00Z", deadline_utc: "2027-06-30T23:59:00Z" }, reg);
  const f: string[] = [];
  const subjectOf = (m: Reg) => (m.resolver as { election?: { subject?: { id: string } } }).election?.subject?.id;
  if (k.expect.refused_includes !== undefined) {
    if (b.ok) f.push(`registered (subject ${subjectOf(b.market)}), expected refused: ${k.expect.refused_includes}`);
    else if (!b.reason.includes(k.expect.refused_includes)) f.push(`refused for "${b.reason.slice(0, 120)}", expected "${k.expect.refused_includes}"`);
  }
  if (k.expect.subject_id !== undefined) {
    if (!b.ok) f.push(`refused (${b.reason.slice(0, 120)}), expected subject ${k.expect.subject_id}`);
    else if (subjectOf(b.market) !== k.expect.subject_id) f.push(`subject ${subjectOf(b.market)} != ${k.expect.subject_id}`);
  }
  return { failures: f, falseResolved: b.ok && k.expect.refused_includes !== undefined };
}

async function runCase(k: OfficialCase): Promise<{ failures: string[]; falseResolved: boolean }> {
  if ("build" in k) return runBuild(k);
  const r = k.market.resolver;
  if (r?.kind !== "official_release") throw new Error("case market has no official_release resolver");
  const fetched = docOf(r, k.fetched);
  let doc: OfficialDoc = fetched;
  if (k.stored) {
    const stored = docOf(r, k.stored);
    if (stored.kind !== "official_observation" || fetched.kind !== "official_observation") throw new Error("a first_print case needs two observations");
    doc = firstPrintFor(stored, fetched);
  }
  const { evidence } = officialEvidence(doc, new Date(k.fetched.observed_at).toISOString(), { ownCapture: k.fetched.own_capture ?? true });
  let jevCalls = 0;
  const res = await resolveMarket({ marketId: k.id, market: k.market, evidence, thresholds: DEFAULT_THRESHOLDS, spotlightSecret: "eval-spotlight-v1", model: "jev-1.13.0", now: new Date(k.fetched.observed_at) }, { jev: async () => { jevCalls++; throw new Error("official_release reached Jev"); } });
  const v = res.verdict;
  const f: string[] = [];
  if (v.resolution_status !== k.expect.status) f.push(`status ${v.resolution_status} != ${k.expect.status}`);
  if (v.winning_outcome !== k.expect.outcome) f.push(`outcome ${v.winning_outcome} != ${k.expect.outcome}`);
  for (const c of k.expect.caveats_include ?? []) if (!v.caveats.includes(c)) f.push(`caveat ${c} missing (have ${v.caveats.join(",") || "none"})`);
  if (k.expect.error_reason !== undefined && v.error_reason !== k.expect.error_reason) f.push(`error_reason ${v.error_reason} != ${k.expect.error_reason}`);
  const detail = v.checks.find((c) => c.name === "structured_resolver")?.detail ?? "";
  for (const d of k.expect.detail_includes ?? []) if (!detail.includes(d)) f.push(`detail lacks "${d}" (${detail.slice(0, 300)})`);
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

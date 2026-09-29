/**
 * The official release calendar the event registry (KNOWN_RELEASES, src/resolve/official.ts) is extended from: every
 * scheduled publication of the rail's non-election series from October 2026 on, as far as each publisher had posted it
 * when it was read (2026-09-29, on the publishers' own schedule pages; the page quotes stay in the research file).
 * date_status / time_status VERIFIED: the page states that date / time for the row. UNVERIFIED: assumed, the row's note
 * says why, and every basis text generated from the row says so. A family's rows are consecutive scheduled
 * publications (tests/release-calendar.test.ts chains each next_release_at to the following row), so the row before a
 * meeting is the meeting before it (previousInCalendar, for prior_level).
 * calendarReleases turns rows into registry entries with each family's fallback convention and generates nothing where
 * that convention needs a next date the calendar lacks. Dates are public facts. Pure: no I/O.
 */
import type { KnownRelease, OfficialSeriesId } from "./official";

export type CalendarFamily = "bls_empsit" | "bls_cpi" | "bls_ppi" | "fomc" | "ecb" | "boe" | "bcb_copom" | "bok_rate" | "bok_gdp";
export type CalendarStatus = "VERIFIED" | "UNVERIFIED";

export interface CalendarRow {
  family: CalendarFamily;
  /** The rail's period: the reference month (BLS), the decision day (central banks) or the quarter (GDP). */
  period: string;
  /** The publication as the page states it, in local time. */
  release_local: string;
  /** The publication in UTC; null where the publisher states no time (BoK). */
  release_at: string | null;
  /** The family's next scheduled publication in UTC; null where the page does not list it yet (or states no time). */
  next_release_at: string | null;
  date_status: CalendarStatus;
  time_status: CalendarStatus;
  /** The publisher's page the date was read on, and when. */
  source_url: string;
  read_at: string;
  /** Why the time is UNVERIFIED, or another fact from the page that qualifies the row. */
  note?: string;
}

export const CALENDAR_COMPILED_AT = "2026-09-29T18:57:57Z";

const FOMC_2027 = "no Federal Reserve page gives a 2027 time (the Board's calendar feed ends in December 2026): 2:00 p.m. ET assumed; each 2027 date is tentative until confirmed at the meeting before it";
const ECB_CEST = "the ECB's standing text says 14:15 CET but Frankfurt is on CEST that day: 14:15 local (12:15Z) assumed, a literal CET reading is 13:15Z";
const COPOM = "the Comunicado sets 18:30 BRT as the earliest time the statement is published, not a fixed time";
const BOK_RATE = "the Bank publishes no announcement time (the decision is announced right after the main meeting, which usually starts at 9 a.m. KST)";
const BOK_GDP = "the calendar shows 8:00 without a time zone, read as KST";

export const RELEASE_CALENDAR: readonly CalendarRow[] = [
  { family: "bls_empsit", period: "2026-09", release_local: "2026-10-02 08:30 ET", release_at: "2026-10-02T12:30:00Z", next_release_at: "2026-11-06T13:30:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bls.gov/schedule/news_release/empsit.htm", read_at: "2026-09-29T18:43Z" },
  { family: "bls_empsit", period: "2026-10", release_local: "2026-11-06 08:30 ET", release_at: "2026-11-06T13:30:00Z", next_release_at: "2026-12-04T13:30:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bls.gov/schedule/news_release/empsit.htm", read_at: "2026-09-29T18:43Z" },
  { family: "bls_empsit", period: "2026-11", release_local: "2026-12-04 08:30 ET", release_at: "2026-12-04T13:30:00Z", next_release_at: null, date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bls.gov/schedule/news_release/empsit.htm", read_at: "2026-09-29T18:43Z" },
  { family: "bls_cpi", period: "2026-09", release_local: "2026-10-14 08:30 ET", release_at: "2026-10-14T12:30:00Z", next_release_at: "2026-11-10T13:30:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bls.gov/schedule/news_release/cpi.htm", read_at: "2026-09-29T18:43Z" },
  { family: "bls_cpi", period: "2026-10", release_local: "2026-11-10 08:30 ET", release_at: "2026-11-10T13:30:00Z", next_release_at: "2026-12-10T13:30:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bls.gov/schedule/news_release/cpi.htm", read_at: "2026-09-29T18:43Z" },
  { family: "bls_cpi", period: "2026-11", release_local: "2026-12-10 08:30 ET", release_at: "2026-12-10T13:30:00Z", next_release_at: null, date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bls.gov/schedule/news_release/cpi.htm", read_at: "2026-09-29T18:43Z" },
  { family: "bls_ppi", period: "2026-09", release_local: "2026-10-15 08:30 ET", release_at: "2026-10-15T12:30:00Z", next_release_at: "2026-11-13T13:30:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bls.gov/schedule/news_release/ppi.htm", read_at: "2026-09-29T18:43Z" },
  { family: "bls_ppi", period: "2026-10", release_local: "2026-11-13 08:30 ET", release_at: "2026-11-13T13:30:00Z", next_release_at: "2026-12-15T13:30:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bls.gov/schedule/news_release/ppi.htm", read_at: "2026-09-29T18:43Z" },
  { family: "bls_ppi", period: "2026-11", release_local: "2026-12-15 08:30 ET", release_at: "2026-12-15T13:30:00Z", next_release_at: null, date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bls.gov/schedule/news_release/ppi.htm", read_at: "2026-09-29T18:43Z" },
  { family: "fomc", period: "2026-10-28", release_local: "2026-10-28 14:00 ET", release_at: "2026-10-28T18:00:00Z", next_release_at: "2026-12-09T19:00:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", read_at: "2026-09-29T18:41:30Z" },
  { family: "fomc", period: "2026-12-09", release_local: "2026-12-09 14:00 ET", release_at: "2026-12-09T19:00:00Z", next_release_at: "2027-01-27T19:00:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", read_at: "2026-09-29T18:41:30Z" },
  { family: "fomc", period: "2027-01-27", release_local: "2027-01-27 14:00 ET", release_at: "2027-01-27T19:00:00Z", next_release_at: "2027-03-17T18:00:00Z", date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", read_at: "2026-09-29T18:41:30Z", note: FOMC_2027 },
  { family: "fomc", period: "2027-03-17", release_local: "2027-03-17 14:00 ET", release_at: "2027-03-17T18:00:00Z", next_release_at: "2027-04-28T18:00:00Z", date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", read_at: "2026-09-29T18:41:30Z", note: FOMC_2027 },
  { family: "fomc", period: "2027-04-28", release_local: "2027-04-28 14:00 ET", release_at: "2027-04-28T18:00:00Z", next_release_at: "2027-06-09T18:00:00Z", date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", read_at: "2026-09-29T18:41:30Z", note: FOMC_2027 },
  { family: "fomc", period: "2027-06-09", release_local: "2027-06-09 14:00 ET", release_at: "2027-06-09T18:00:00Z", next_release_at: "2027-07-28T18:00:00Z", date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", read_at: "2026-09-29T18:41:30Z", note: FOMC_2027 },
  { family: "ecb", period: "2026-10-29", release_local: "2026-10-29 14:15 CET", release_at: "2026-10-29T13:15:00Z", next_release_at: "2026-12-17T13:15:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html", read_at: "2026-09-29T18:41:30Z" },
  { family: "ecb", period: "2026-12-17", release_local: "2026-12-17 14:15 CET", release_at: "2026-12-17T13:15:00Z", next_release_at: "2027-02-04T13:15:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html", read_at: "2026-09-29T18:41:30Z" },
  { family: "ecb", period: "2027-02-04", release_local: "2027-02-04 14:15 CET", release_at: "2027-02-04T13:15:00Z", next_release_at: "2027-03-18T13:15:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html", read_at: "2026-09-29T18:41:30Z" },
  { family: "ecb", period: "2027-03-18", release_local: "2027-03-18 14:15 CET", release_at: "2027-03-18T13:15:00Z", next_release_at: "2027-04-29T12:15:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html", read_at: "2026-09-29T18:41:30Z" },
  { family: "ecb", period: "2027-04-29", release_local: "2027-04-29 14:15 CEST", release_at: "2027-04-29T12:15:00Z", next_release_at: "2027-06-10T12:15:00Z", date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html", read_at: "2026-09-29T18:41:30Z", note: ECB_CEST },
  { family: "ecb", period: "2027-06-10", release_local: "2027-06-10 14:15 CEST", release_at: "2027-06-10T12:15:00Z", next_release_at: "2027-07-22T12:15:00Z", date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html", read_at: "2026-09-29T18:41:30Z", note: ECB_CEST },
  { family: "boe", period: "2026-11-05", release_local: "2026-11-05 12:00 GMT", release_at: "2026-11-05T12:00:00Z", next_release_at: "2026-12-17T12:00:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates", read_at: "2026-09-29T18:41:30Z" },
  { family: "boe", period: "2026-12-17", release_local: "2026-12-17 12:00 GMT", release_at: "2026-12-17T12:00:00Z", next_release_at: "2027-02-04T12:00:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates", read_at: "2026-09-29T18:41:30Z" },
  { family: "boe", period: "2027-02-04", release_local: "2027-02-04 12:00 GMT", release_at: "2027-02-04T12:00:00Z", next_release_at: "2027-03-18T12:00:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates", read_at: "2026-09-29T18:41:30Z" },
  { family: "boe", period: "2027-03-18", release_local: "2027-03-18 12:00 GMT", release_at: "2027-03-18T12:00:00Z", next_release_at: "2027-04-29T11:00:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates", read_at: "2026-09-29T18:41:30Z" },
  { family: "boe", period: "2027-04-29", release_local: "2027-04-29 12:00 BST", release_at: "2027-04-29T11:00:00Z", next_release_at: "2027-06-17T11:00:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates", read_at: "2026-09-29T18:41:30Z" },
  { family: "boe", period: "2027-06-17", release_local: "2027-06-17 12:00 BST", release_at: "2027-06-17T11:00:00Z", next_release_at: "2027-07-29T11:00:00Z", date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates", read_at: "2026-09-29T18:41:30Z" },
  { family: "bok_rate", period: "2026-10-22", release_local: "2026-10-22 KST, time of day not published", release_at: null, next_release_at: null, date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.bok.or.kr/eng/main/contents.do?menuNo=400020", read_at: "2026-09-29T18:46:03Z", note: BOK_RATE },
  { family: "bok_rate", period: "2026-11-26", release_local: "2026-11-26 KST, time of day not published", release_at: null, next_release_at: null, date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.bok.or.kr/eng/main/contents.do?menuNo=400020", read_at: "2026-09-29T18:46:03Z", note: BOK_RATE },
  { family: "bok_gdp", period: "2026-Q3", release_local: "2026-10-27 08:00 KST", release_at: "2026-10-26T23:00:00Z", next_release_at: null, date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://www.bok.or.kr/eng/stats/statsPublictSchdul/listCldr.do?menuNo=400359&year=2026", read_at: "2026-09-29T18:47:02Z", note: BOK_GDP },
  { family: "bcb_copom", period: "2026-11-04", release_local: "2026-11-04 18:30 BRT", release_at: "2026-11-04T21:30:00Z", next_release_at: "2026-12-09T21:30:00Z", date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.bcb.gov.br/api/conteudo/app/normativos/exibeoutrasnormas?p1=COMUNICADO&p2=43383", read_at: "2026-09-29T18:51:22Z", note: COPOM },
  { family: "bcb_copom", period: "2026-12-09", release_local: "2026-12-09 18:30 BRT", release_at: "2026-12-09T21:30:00Z", next_release_at: "2027-01-27T21:30:00Z", date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.bcb.gov.br/api/conteudo/app/normativos/exibeoutrasnormas?p1=COMUNICADO&p2=43383", read_at: "2026-09-29T18:51:22Z", note: COPOM },
  { family: "bcb_copom", period: "2027-01-27", release_local: "2027-01-27 18:30 BRT", release_at: "2027-01-27T21:30:00Z", next_release_at: "2027-03-17T21:30:00Z", date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.bcb.gov.br/api/conteudo/app/normativos/exibeoutrasnormas?p1=COMUNICADO&p2=45452", read_at: "2026-09-29T18:51:20Z", note: COPOM },
  { family: "bcb_copom", period: "2027-03-17", release_local: "2027-03-17 18:30 BRT", release_at: "2027-03-17T21:30:00Z", next_release_at: "2027-04-28T21:30:00Z", date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.bcb.gov.br/api/conteudo/app/normativos/exibeoutrasnormas?p1=COMUNICADO&p2=45452", read_at: "2026-09-29T18:51:20Z", note: COPOM },
  { family: "bcb_copom", period: "2027-04-28", release_local: "2027-04-28 18:30 BRT", release_at: "2027-04-28T21:30:00Z", next_release_at: "2027-06-16T21:30:00Z", date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.bcb.gov.br/api/conteudo/app/normativos/exibeoutrasnormas?p1=COMUNICADO&p2=45452", read_at: "2026-09-29T18:51:20Z", note: COPOM },
  { family: "bcb_copom", period: "2027-06-16", release_local: "2027-06-16 18:30 BRT", release_at: "2027-06-16T21:30:00Z", next_release_at: "2027-08-04T21:30:00Z", date_status: "VERIFIED", time_status: "UNVERIFIED", source_url: "https://www.bcb.gov.br/api/conteudo/app/normativos/exibeoutrasnormas?p1=COMUNICADO&p2=45452", read_at: "2026-09-29T18:51:20Z", note: COPOM },
];

/** Where a family's posted schedule ended when it was read: the registry holds nothing past it, by design. */
export const CALENDAR_GAPS: Partial<Record<CalendarFamily, string>> = {
  bls_empsit: "BLS had posted no 2027 schedule (bls.gov/schedule/2027 answered 404); the Employment Situation schedule ends at reference month 2026-11",
  bls_cpi: "BLS had posted no 2027 schedule; the CPI schedule ends at reference month 2026-11",
  bls_ppi: "BLS had posted no 2027 schedule; the PPI schedule ends at reference month 2026-11",
  bok_rate: "the BoK had posted no 2027 meeting dates (they are released near the end of the year)",
  bok_gdp: "the BoK's 2027 statistical calendar showed no data",
};

/** The registry series each family schedules: one publication, so one release_at and one fallback for all of them. */
export const CALENDAR_FAMILY_SERIES: Record<CalendarFamily, readonly OfficialSeriesId[]> = {
  bls_empsit: ["us_unemployment_rate", "us_nonfarm_payrolls_change"],
  bls_cpi: ["us_cpi_u_nsa_yoy", "us_cpi_u_sa_mom", "us_core_cpi_nsa_yoy", "us_core_cpi_sa_mom"],
  bls_ppi: ["us_ppi_fd_nsa_yoy"],
  fomc: ["fomc_upper_bound"],
  ecb: ["ecb_dfr"],
  boe: ["boe_bank_rate"],
  bcb_copom: ["bcb_selic_target"],
  bok_rate: ["bok_base_rate"],
  bok_gdp: ["kr_gdp_advance_yoy"],
};

const FAMILY_NAME: Record<CalendarFamily, string> = {
  bls_empsit: "BLS Employment Situation", bls_cpi: "BLS CPI release", bls_ppi: "BLS PPI release", fomc: "FOMC statement", ecb: "ECB monetary policy decision",
  boe: "BoE MPC decision", bcb_copom: "Copom decision", bok_rate: "BoK Base Rate decision", bok_gdp: "BoK real GDP advance estimate",
};

/**
 * Each family's fallback, as the hand-written registry entries read the market texts (src/resolve/official.ts).
 * et_day_start: "by the date" of the next release, from 00:00 America/New_York that day (Employment Situation).
 * next_release: the next release or statement time (CPI, PPI, FOMC, ECB). bok_next_meeting: the next meeting at the
 * same 10:00 KST (BoK). none: the texts name no fallback (BoE, Copom, Korea GDP); the 45-day cap alone applies.
 */
type FallbackRule = "et_day_start" | "next_release" | "bok_next_meeting" | "none";
const FALLBACK_RULE: Record<CalendarFamily, FallbackRule> = {
  bls_empsit: "et_day_start", bls_cpi: "next_release", bls_ppi: "next_release", fomc: "next_release", ecb: "next_release",
  bok_rate: "bok_next_meeting", boe: "none", bcb_copom: "none", bok_gdp: "none",
};

/** The BoK states no announcement time: the registry reads its decisions at 10:00 KST (01:00Z), UNVERIFIED. */
const BOK_DECISION_UTC = "T01:00:00Z";

const FAMILY_OF = new Map<OfficialSeriesId, CalendarFamily>(
  (Object.entries(CALENDAR_FAMILY_SERIES) as Array<[CalendarFamily, readonly OfficialSeriesId[]]>).flatMap(([f, ss]) => ss.map((s): [OfficialSeriesId, CalendarFamily] => [s, f])),
);

// ---- US Eastern time --------------------------------------------------------------------------------------------

/** Day of the month of the n-th Sunday of (year, month0). */
const nthSunday = (year: number, month0: number, n: number) => 1 + ((7 - new Date(Date.UTC(year, month0, 1)).getUTCDay()) % 7) + 7 * (n - 1);

/**
 * Hours America/New_York is behind UTC at the instant: 4 (EDT) from 2:00 EST on the second Sunday of March to 2:00 EDT
 * on the first Sunday of November (the US rule since 2007), else 5 (EST).
 */
export function easternOffsetHours(ms: number): 4 | 5 {
  const y = new Date(ms).getUTCFullYear();
  const start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7), end = Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
  return ms >= start && ms < end ? 4 : 5;
}

const isoZ = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

/** 00:00 America/New_York on the ET date of the instant, in UTC: 05:00Z on an EST date, 04:00Z on an EDT date. */
export function etDayStartUtc(iso: string): string {
  const ms = Date.parse(iso);
  const day = Date.parse(`${new Date(ms - easternOffsetHours(ms) * 3600_000).toISOString().slice(0, 10)}T00:00:00Z`);
  // midnight is EDT exactly when EDT is in force at 04:00Z that date (never inside a 2:00 local switch)
  return isoZ(day + easternOffsetHours(day + 4 * 3600_000) * 3600_000);
}

// ---- registry entries ---------------------------------------------------------------------------------------------

export interface CalendarSkip { key: string; reason: string }

/** " (time UNVERIFIED)" and the like for a row, or "". */
function flags(row: Pick<CalendarRow, "date_status" | "time_status">): string {
  const f = [row.date_status !== "VERIFIED" ? "date UNVERIFIED" : "", row.time_status !== "VERIFIED" ? "time UNVERIFIED" : ""].filter(Boolean);
  return f.length ? ` (${f.join(", ")})` : "";
}

/** The status of a next release: its own row's flags when the calendar lists it, else UNVERIFIED (beyond the calendar). */
function nextFlags(rows: readonly CalendarRow[], row: CalendarRow): string {
  const next = rows.find((r) => r.family === row.family && r.release_at !== null && r.release_at === row.next_release_at);
  return next ? flags(next) : " (beyond this calendar: UNVERIFIED)";
}

function entryOf(rows: readonly CalendarRow[], row: CalendarRow, following: CalendarRow | undefined): KnownRelease | { reason: string } {
  const name = FAMILY_NAME[row.family];
  const bok = row.family === "bok_rate";
  const release_at = row.release_at ?? (bok ? `${row.period}${BOK_DECISION_UTC}` : null);
  if (!release_at) return { reason: `${name} ${row.period}: the page states no release time` };
  const missingNext = `the fallback is the next ${name}, which the calendar does not list (${CALENDAR_GAPS[row.family] ?? "not posted when read"}): no entry rather than a guessed fallback`;
  let fallback_until: string | null;
  let fallback: string;
  const rule = FALLBACK_RULE[row.family];
  switch (rule) {
    case "none":
      fallback_until = null;
      fallback = "no fallback, as the hand-written entry reads the market texts (they name none): the 45-day cap applies";
      break;
    case "next_release":
      if (!row.next_release_at) return { reason: `${name} ${row.period}: ${missingNext}` };
      fallback_until = row.next_release_at;
      fallback = `fallback at the next ${name}, ${row.next_release_at}${nextFlags(rows, row)}, as the hand-written entry reads the market texts`;
      break;
    case "et_day_start":
      if (!row.next_release_at) return { reason: `${name} ${row.period}: ${missingNext}` };
      fallback_until = etDayStartUtc(row.next_release_at);
      fallback = `next release ${row.next_release_at}${nextFlags(rows, row)}; fallback 'by the date' of that release, read conservatively as 00:00 ET that day, ${fallback_until}, as the hand-written entry reads the market texts`;
      break;
    case "bok_next_meeting":
      if (!following) return { reason: `${name} ${row.period}: ${missingNext}` };
      fallback_until = `${following.period}${BOK_DECISION_UTC}`;
      fallback = `fallback at the next meeting, ${following.period} 10:00 KST${flags(following)}, as the hand-written entry reads the market texts`;
      break;
    default: { const never: never = rule; throw new Error(`unhandled fallback rule ${String(never)}`); }
  }
  const at = row.release_at ? `${row.release_local} = ${release_at}` : `${row.release_local}: ${release_at} = 10:00 KST assumed as in the hand-written entry`;
  const basis = `${name} ${row.period}: ${at}${flags(row)}; ${fallback}${row.note ? `; ${row.note}` : ""}. Release calendar: ${row.source_url} read ${row.read_at}`;
  return { release_at, fallback_until, basis };
}

/**
 * Registry entries for every (series, period) of the calendar: release_at from the row (BoK: 10:00 KST on the meeting
 * day), fallback_until by the family's rule, basis naming the page, its read time and every UNVERIFIED flag. An event
 * whose rule needs a next date the calendar lacks (the last BLS month posted, the last BoK meeting posted) is skipped
 * with the reason, never given a guessed fallback.
 */
export function calendarReleases(rows: readonly CalendarRow[] = RELEASE_CALENDAR): { releases: Record<string, KnownRelease>; skipped: CalendarSkip[] } {
  const releases: Record<string, KnownRelease> = {};
  const skipped: CalendarSkip[] = [];
  rows.forEach((row, i) => {
    const e = entryOf(rows, row, rows.slice(i + 1).find((r) => r.family === row.family));
    for (const s of CALENDAR_FAMILY_SERIES[row.family]) {
      const key = `${s}:${row.period}`;
      if ("reason" in e) skipped.push({ key, reason: e.reason });
      else releases[key] = e;
    }
  });
  return { releases, skipped };
}

/**
 * The scheduled meeting before `period` of `series`, in calendar order: the row before it in its family, or the
 * family's last row when `period` is the day of that row's next_release_at. A reason when the calendar does not reach
 * back to it (`period` is the family's first row) or does not list `period` at all.
 */
export function previousInCalendar(series: OfficialSeriesId, period: string, rows: readonly CalendarRow[] = RELEASE_CALENDAR): { period: string; row: CalendarRow } | { reason: string } {
  const family = FAMILY_OF.get(series);
  if (!family) return { reason: `${series} is not in the release calendar` };
  const fam = rows.filter((r) => r.family === family);
  const i = fam.findIndex((r) => r.period === period);
  if (i > 0) return { period: fam[i - 1]!.period, row: fam[i - 1]! };
  if (i === 0) return { reason: `${series}:${period} is the first ${FAMILY_NAME[family]} in the release calendar (read ${CALENDAR_COMPILED_AT.slice(0, 10)}), which does not list the one before it` };
  const last = fam[fam.length - 1];
  if (last?.next_release_at?.slice(0, 10) === period) return { period: last.period, row: last };
  return { reason: `${series}:${period} is not in the release calendar` };
}

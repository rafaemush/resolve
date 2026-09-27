/**
 * official_release adapters: one primary and one corroboration source per series (research 2026-09-24). Each
 * fetch goes only to the series' allowlisted hosts (src/resolve/official.ts), identifies itself with the bot UA,
 * times out at 8 s (less when the caller's time budget is shorter) and treats anything but a 200 from an allowlisted
 * URL as a typed error with httpStatus + deferSeconds: a non-200 body is never parsed, so it can never be evidence.
 * A document that is readable but still about an earlier period is "pending", never an observation.
 */
import { OFFICIAL_SERIES, fetchGroupOf, hostAllowed, sameAtPrecision, reading, thousandsOf, percentTenths, type OfficialCorroboration, type OfficialSeriesId } from "../resolve/official";
import { sha256Hex } from "../resolve/text";
import { discardBody, retryAfterSeconds } from "./http";
import { RESOLVE_BOT_UA } from "../ops/ua";
import {
  parseBlsRelease, parseBlsCpiTableA, parseEmpsitRelease, parseBlsApi, blsApiYoy, blsApiMom, blsApiLevelChange, findFomcStatement,
  parseFomcStatement, fredValueOn, findEcbDecision, parseEcbRelease, parseEcbDfrCsv, parseBoeRss, iadbValueOn, parseBokDecisionRss,
  parseBokGdpRss, parseEcosRows, parseBcbHistory, bytesInclude, usDayLabel, type DocObservation, type DocParse,
} from "./official-parse";

/** The official-release fetcher sends ResolveBot's one UA (src/ops/ua.ts). */
export const OFFICIAL_UA = RESOLVE_BOT_UA;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY = 2 * 1024 * 1024; // the BoK decision feed is ~0.9 MB
/** Redirects are followed by hand, each Location checked (https, series allowlist) before it is requested. */
export const MAX_REDIRECTS = 3;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** BLS public API v1, one series per request (no key: 25 queries a day). */
export const blsApiUrl = (seriesId: string) => `https://api.bls.gov/publicAPI/v1/timeseries/data/${seriesId}`;

export const URLS = {
  cpiText: "https://www.bls.gov/news.release/cpi.nr0.htm",
  ppiText: "https://www.bls.gov/news.release/ppi.nr0.htm",
  cpiApi: blsApiUrl("CUUR0000SA0"),
  ppiApi: blsApiUrl("WPUFD4"),
  fedRss: "https://www.federalreserve.gov/feeds/press_monetary.xml",
  fred: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARU",
  ecbIndex: (year: string) => `https://www.ecb.europa.eu/press/govcdec/mopo/${year}/html/index_include.en.html`,
  ecbDfr: "https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV?format=csvdata&lastNObservations=5",
  boeRss: "https://www.bankofengland.co.uk/rss/news",
  boeIadb: (from: string) => `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=${from}&Dateto=now&SeriesCodes=IUDBEDR&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`,
  bokRss: "https://www.bok.or.kr/eng/bbs/E0000627/news.rss?menuNo=400022",
  bokPressRss: "https://www.bok.or.kr/eng/bbs/E0000634/news.rss?menuNo=400069",
  // ECOS "sample" key: public, capped at 10 rows per request; every request below asks for exactly one row.
  ecosBaseRate: (ymd: string) => `https://ecos.bok.or.kr/api/StatisticSearch/sample/json/en/1/10/722Y001/D/${ymd}/${ymd}/0101000`,
  ecosGdp: (q: string) => `https://ecos.bok.or.kr/api/StatisticSearch/sample/json/en/1/10/200Y102/Q/${q}/${q}/10211`,
  bcbHistory: "https://www.bcb.gov.br/api/servico/sitebcb/historicotaxasjuros",
} as const;

/**
 * Time and request allowance shared by every fetch of one capture. Every request's timeout is clamped to the
 * deadline and recorded, so no request can outlive it (tests assert this; pg_net and waitUntil both stop at 30 s).
 */
export interface Budget {
  deadlineMs: number; requests: number; used: number; now: () => number; timeouts: number[];
  /** Called once per HTTP exchange officialGet makes (redirect hops included). Only the admin probe sets it. */
  trace?: (t: FetchTrace) => void;
}
/**
 * One HTTP exchange of officialGet as the admin probe reports it (POST /internal/official/probe): status null when
 * fetch threw; bytes only for a body that was read (a 200), null for a discarded one. content_length: the
 * Content-Length header of a discarded body (a 3xx or non-200), when it sent one, so a several-KB challenge page can be
 * told from a short "Access Denied" without reading it.
 */
export interface FetchTrace { url: string; status: number | null; content_type: string | null; server: string | null; bytes: number | null; ms: number; content_length?: number; location?: string; error?: string }
/** The Content-Length header as a whole number of bytes, else undefined (absent or unreadable). */
export function contentLength(h: Headers): number | undefined {
  const v = h.get("content-length")?.trim();
  if (!v || !/^\d{1,15}$/.test(v)) return undefined;
  return Number(v);
}
export function budget(now: () => number, ms: number, requests: number, deadlineMs?: number): Budget {
  return { deadlineMs: deadlineMs ?? now() + ms, requests, used: 0, now, timeouts: [] };
}

/** text is decoded on first read only: a burst can answer "not yet" from the bytes of a large feed (bytesInclude). */
type Got = { ok: true; url: string; bytes: Uint8Array; readonly text: string }
  | { ok: false; error: string; httpStatus?: number; deferSeconds?: number; retryable: boolean };

/**
 * One GET under the series' host allowlist (https only). Refused hosts are never requested: redirects are followed by
 * hand (at most MAX_REDIRECTS hops, each a counted request) and every Location is checked before it is fetched.
 */
export async function officialGet(series: OfficialSeriesId, url: string, b: Budget, accept: string): Promise<Got> {
  let current = url;
  let res: Response;
  let t0 = 0;
  // discarded: the body was dropped unread (a 3xx or non-200), so its Content-Length is the only size there is
  const trace = (r: Response | null, extra: { bytes?: number; discarded?: boolean; location?: string; error?: string } = {}) => {
    if (!b.trace) return;
    const cl = r && extra.discarded ? contentLength(r.headers) : undefined;
    b.trace({
      url: current, status: r?.status ?? null, content_type: r?.headers.get("content-type") ?? null, server: r?.headers.get("server") ?? null,
      bytes: extra.bytes ?? null, ms: Date.now() - t0, ...(cl !== undefined ? { content_length: cl } : {}),
      ...(extra.location !== undefined ? { location: extra.location } : {}), ...(extra.error !== undefined ? { error: extra.error } : {}),
    });
  };
  for (let hop = 0; ; hop++) {
    if (!hostAllowed(series, current)) return { ok: false, error: `refused: ${current} is not an https URL on the ${series} host allowlist`, retryable: false };
    if (b.requests <= 0) return { ok: false, error: "request budget exhausted", retryable: false };
    const remaining = b.deadlineMs - b.now();
    if (remaining < 500) return { ok: false, error: "time budget exhausted", retryable: false };
    const timeout = Math.min(FETCH_TIMEOUT_MS, remaining);
    b.requests--; b.used++; b.timeouts.push(timeout);
    t0 = Date.now();
    try {
      res = await fetch(current, { headers: { "User-Agent": OFFICIAL_UA, Accept: accept, "Cache-Control": "no-cache" }, redirect: "manual", signal: AbortSignal.timeout(timeout) });
    } catch (e) { trace(null, { error: String(e).slice(0, 120) }); return { ok: false, error: `fetch ${current} failed: ${String(e).slice(0, 120)}`, retryable: true }; }
    if (res.status < 300 || res.status > 399) break;
    const location = res.headers.get("location");
    await discardBody(res);
    trace(res, location ? { discarded: true, location } : { discarded: true });
    const moved = { httpStatus: res.status };
    if (!location) return { ok: false, error: `HTTP ${res.status} from ${current} without a Location`, retryable: false, ...moved };
    let next: string;
    try { next = new URL(location, current).href; } catch { return { ok: false, error: `HTTP ${res.status} from ${current} with an unreadable Location`, retryable: false, ...moved }; }
    if (!hostAllowed(series, next)) return { ok: false, error: `${current} redirected off the ${series} allowlist (https only) to ${next}; not requested`, retryable: false, ...moved };
    if (hop >= MAX_REDIRECTS) return { ok: false, error: `more than ${MAX_REDIRECTS} redirects from ${url}`, retryable: false, ...moved };
    current = next;
  }
  const deferSeconds = retryAfterSeconds(res.headers, Date.now());
  const answered = { httpStatus: res.status, ...(deferSeconds !== undefined ? { deferSeconds } : {}) };
  if (res.status !== 200) {
    await discardBody(res);
    trace(res, { discarded: true });
    // 404 and 5xx right at a release are "not there yet" (a CDN edge behind the feed); 403/429 mean back off.
    return { ok: false, error: `HTTP ${res.status} from ${current}`, retryable: res.status === 404 || res.status >= 500, ...answered };
  }
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await res.arrayBuffer()); }
  catch (e) { trace(res, { error: `body: ${String(e).slice(0, 120)}` }); throw e; }
  trace(res, { bytes: bytes.byteLength });
  if (bytes.byteLength > MAX_BODY) return { ok: false, error: `${current} answered ${bytes.byteLength} bytes (cap ${MAX_BODY})`, retryable: false, ...answered };
  let text: string | undefined;
  return { ok: true, url: current, bytes, get text() { return (text ??= new TextDecoder().decode(bytes)); } };
}

export interface FetchedObservation extends DocObservation {
  series: OfficialSeriesId;
  source_url: string;
  raw: Uint8Array;
  raw_sha256: string;
  fetched_at: string;
}

export type PrimaryResult =
  /**
   * siblings: the other series of the fetch group that the same document states for the same period (recorded by the
   * slot holder from these bytes, so the page is fetched once per release); siblingNotes: why a sibling was not read.
   */
  | { kind: "observed"; obs: FetchedObservation; siblings?: FetchedObservation[]; siblingNotes?: string[] }
  /** siblings: as above, when the page is out but does not state this series' number (a "-" cell after a lapse). */
  | { kind: "pending"; detail: string; siblings?: FetchedObservation[]; siblingNotes?: string[] }
  /** siblings: as above, when this series' part of the page no longer parses (drift) but the others' parts do. */
  | { kind: "error"; error: string; httpStatus?: number; deferSeconds?: number; retryable: boolean; drift: boolean; siblings?: FetchedObservation[]; siblingNotes?: string[] };

const failed = (g: Extract<Got, { ok: false }>): PrimaryResult => ({ kind: "error", error: g.error, httpStatus: g.httpStatus, deferSeconds: g.deferSeconds, retryable: g.retryable, drift: false });
const notFound = (p: { reason: "not_published" | "schema_drift"; detail: string }): PrimaryResult =>
  p.reason === "not_published" ? { kind: "pending", detail: p.detail } : { kind: "error", error: `schema drift: ${p.detail}`, retryable: false, drift: true };

async function settle(series: OfficialSeriesId, target: string, p: DocParse, g: Extract<Got, { ok: true }>, b: Budget): Promise<PrimaryResult> {
  if (!p.ok) return notFound(p);
  // The adapter's own gate: a document about another period is not the target's first print (it is the
  // previous release still being served, or a later one after the target's window).
  if (p.obs.period !== target) return { kind: "pending", detail: `the ${series} document is about ${p.obs.period}, not ${target}` };
  return { kind: "observed", obs: { ...p.obs, series, source_url: g.url, raw: g.bytes, raw_sha256: await sha256Hex(g.bytes), fetched_at: new Date(b.now()).toISOString() } };
}

/** "2026-11-05" -> "November 2026" */
const monthYear = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

/** How each series read from a BLS release page is parsed (null: not a BLS release series). */
export function parseBlsSeries(series: OfficialSeriesId, html: string): DocParse | null {
  switch (series) {
    case "us_cpi_u_nsa_yoy": return parseBlsRelease(html, "cpi");
    case "us_ppi_fd_nsa_yoy": return parseBlsRelease(html, "ppi");
    case "us_cpi_u_sa_mom": return parseBlsCpiTableA(html, "all_items", "sa_1m");
    case "us_core_cpi_nsa_yoy": return parseBlsCpiTableA(html, "core", "nsa_12m");
    case "us_core_cpi_sa_mom": return parseBlsCpiTableA(html, "core", "sa_1m");
    case "us_unemployment_rate": return parseEmpsitRelease(html, "unemployment_rate");
    case "us_nonfarm_payrolls_change": return parseEmpsitRelease(html, "payrolls_change");
    default: return null;
  }
}

/** The other series of the fetch group read from the same bytes: only those the document states for the target period. */
function siblingsOf(series: OfficialSeriesId, target: string, g: Extract<Got, { ok: true }>, raw_sha256: string, fetched_at: string): { siblings: FetchedObservation[]; siblingNotes: string[] } {
  const siblings: FetchedObservation[] = [];
  const siblingNotes: string[] = [];
  for (const s of fetchGroupOf(series).slice(1)) {
    const p = parseBlsSeries(s, g.text);
    if (!p) { siblingNotes.push(`${s}: no parser for this document`); continue; }
    if (!p.ok) { siblingNotes.push(`${s}: ${p.reason} ${p.detail}`.slice(0, 300)); continue; }
    if (p.obs.period !== target) { siblingNotes.push(`${s}: the document is about ${p.obs.period}, not ${target}`); continue; }
    siblings.push({ ...p.obs, series: s, source_url: g.url, raw: g.bytes, raw_sha256, fetched_at });
  }
  return { siblings, siblingNotes };
}

/** One attempt at the primary source of `series` for the target period. Requests are counted in `b`. */
export async function fetchPrimary(series: OfficialSeriesId, target: string, b: Budget): Promise<PrimaryResult> {
  switch (series) {
    case "us_ppi_fd_nsa_yoy": {
      const g = await officialGet(series, URLS.ppiText, b, "text/html");
      return g.ok ? settle(series, target, parseBlsRelease(g.text, "ppi"), g, b) : failed(g);
    }
    // One page per fetch group (the CPI release; the Employment Situation summary): the holder records every series it states.
    case "us_cpi_u_nsa_yoy":
    case "us_cpi_u_sa_mom":
    case "us_core_cpi_nsa_yoy":
    case "us_core_cpi_sa_mom":
    case "us_unemployment_rate":
    case "us_nonfarm_payrolls_change": {
      const g = await officialGet(series, OFFICIAL_SERIES[series].primaryUrl, b, "text/html");
      if (!g.ok) return failed(g);
      const own = parseBlsSeries(series, g.text)!;
      const res = await settle(series, target, own, g, b);
      if (res.kind === "observed") return { ...res, ...siblingsOf(series, target, g, res.obs.raw_sha256, res.obs.fetched_at) };
      // the page is out without this number (Table A's "-"), or this series' part of it drifted (each series has its
      // own parser and checks): the others it states for the target are still first prints. A page about another
      // period (the usual not-yet read, up to 10 per burst) is not parsed again.
      if (!own.ok && (res.kind === "pending" || res.kind === "error")) {
        const sib = siblingsOf(series, target, g, await sha256Hex(g.bytes), new Date(b.now()).toISOString());
        if (sib.siblings.length) return { ...res, ...sib };
      }
      return res;
    }
    case "fomc_upper_bound": {
      const rss = await officialGet(series, URLS.fedRss, b, "application/rss+xml, text/xml");
      if (!rss.ok) return failed(rss);
      const f = findFomcStatement(rss.text, target);
      if (!f.ok) return notFound(f);
      const st = await officialGet(series, f.url, b, "text/html");
      return st.ok ? settle(series, target, parseFomcStatement(st.text), st, b) : failed(st);
    }
    case "ecb_dfr": {
      const idx = await officialGet(series, URLS.ecbIndex(target.slice(0, 4)), b, "text/html");
      if (!idx.ok) return failed(idx);
      const f = findEcbDecision(idx.text, target);
      if (!f.ok) return notFound(f);
      const rel = await officialGet(series, f.url, b, "text/html");
      return rel.ok ? settle(series, target, parseEcbRelease(rel.text), rel, b) : failed(rel);
    }
    case "boe_bank_rate": {
      const g = await officialGet(series, URLS.boeRss, b, "application/rss+xml, text/xml");
      return g.ok ? settle(series, target, parseBoeRss(g.text, monthYear(target)), g, b) : failed(g);
    }
    case "bok_base_rate": {
      const g = await officialGet(series, URLS.bokRss, b, "application/rss+xml, application/xml");
      if (!g.ok) return failed(g);
      // 0.9 MB, read up to ten times in a burst: a feed with items that never mentions the date is "not yet" undecoded
      const label = usDayLabel(target);
      if (bytesInclude(g.bytes, "<item>") && !bytesInclude(g.bytes, label)) return { kind: "pending", detail: `the BoK decision feed does not mention ${label} yet` };
      return settle(series, target, parseBokDecisionRss(g.text, target), g, b);
    }
    case "kr_gdp_advance_yoy": {
      const g = await officialGet(series, URLS.bokPressRss, b, "application/rss+xml, application/xml");
      return g.ok ? settle(series, target, parseBokGdpRss(g.text, target), g, b) : failed(g);
    }
    case "bcb_selic_target": {
      const g = await officialGet(series, URLS.bcbHistory, b, "application/json");
      return g.ok ? settle(series, target, parseBcbHistory(g.text, target), g, b) : failed(g);
    }
    default: { const never: never = series; throw new Error(`no adapter for ${String(never)}`); }
  }
}

const addDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * The BLS API v1 series that corroborates each BLS series: an index whose 12-month (yoy) or 1-month (mom) change is
 * recomputed, a level compared as published (the unemployment rate), or the difference of two employment levels in
 * thousands (change: valid only while the target month is the API's latest, i.e. still the first print).
 */
type BlsApiSeries = "us_cpi_u_nsa_yoy" | "us_ppi_fd_nsa_yoy" | "us_cpi_u_sa_mom" | "us_core_cpi_nsa_yoy" | "us_core_cpi_sa_mom" | "us_unemployment_rate" | "us_nonfarm_payrolls_change";
export const BLS_API: Record<BlsApiSeries, { id: string; how: "yoy" | "mom" | "level" | "change" }> = {
  us_cpi_u_nsa_yoy: { id: "CUUR0000SA0", how: "yoy" },
  us_ppi_fd_nsa_yoy: { id: "WPUFD4", how: "yoy" },
  us_cpi_u_sa_mom: { id: "CUSR0000SA0", how: "mom" },
  us_core_cpi_nsa_yoy: { id: "CUUR0000SA0L1E", how: "yoy" },
  us_core_cpi_sa_mom: { id: "CUSR0000SA0L1E", how: "mom" },
  us_unemployment_rate: { id: "LNS14000000", how: "level" },
  us_nonfarm_payrolls_change: { id: "CES0000000001", how: "change" },
};

/**
 * Pure: the corroboration a BLS API v1 body gives the release's number (tests and evals call it on saved bodies).
 * A missing month is "unavailable". A recomputed change within 0.0005 of a rounding boundary is "inconclusive" when
 * the release printed either side of it, else "disagree"; a payroll level difference one thousand from the release is
 * "inconclusive" (level rounding); a payroll month that is no longer the API's latest is "single_source".
 */
export function blsCorroboration(obs: { series: BlsApiSeries; value: number; value_text: string }, target: string, body: string, url: string, checked_at: string): OfficialCorroboration {
  const { id, how } = BLS_API[obs.series];
  const unavailable = (detail: string): OfficialCorroboration => ({ status: "unavailable", source_url: url, value: null, value_text: null, detail: detail.slice(0, 500), checked_at });
  const said = (status: OfficialCorroboration["status"], valueText: string, detail: string): OfficialCorroboration => ({ status, source_url: url, value: Number(valueText), value_text: valueText, detail: detail.slice(0, 500), checked_at });
  const compare = (valueText: string, detail: string) => said(sameAtPrecision(obs.series, reading(obs), valueText) ? "agree" : "disagree", valueText, detail);
  const p = parseBlsApi(body, id);
  if (!p.ok) return unavailable(`BLS API: ${p.detail}`);
  if (how === "level") {
    const v = p.index.get(target);
    return v ? compare(v, `${id} ${target} = ${v}`) : unavailable(`BLS API ${id} has no ${target} value yet`);
  }
  if (how === "change") {
    // The level difference is the first print only while the target is still the API's latest month: the next
    // release revises it (February 2026 printed -92 thousand; the levels now differ by -156).
    if (!p.index.has(target)) return unavailable(`BLS API ${id} has no ${target} level yet`);
    if (p.latest !== target) return { status: "single_source", source_url: url, value: null, value_text: null, detail: `${id}: the latest month is ${p.latest ?? "unknown"}, so the ${target} levels are a later vintage, not the first print; the release is the only source`, checked_at };
    const c = blsApiLevelChange(p.index, target);
    const first = thousandsOf(reading(obs));
    if (!c || first === undefined) return unavailable(`BLS API ${id} has no whole-thousand levels for ${target} and the month before`);
    const vt = String(c.change);
    const detail = `${id} ${target} ${c.current} - ${c.base} = ${vt} thousand`;
    // BLS may difference unrounded levels: one thousand apart is level rounding, not a disagreement
    if (Math.abs(c.change - first) === 1) return said("inconclusive", vt, `${detail}; one thousand from the release's ${first} (level rounding)`);
    return compare(vt, detail);
  }
  const y = how === "mom" ? blsApiMom(p.index, target) : blsApiYoy(p.index, target);
  if (!y) return unavailable(`BLS API ${id} has no ${target} index (or its base month) yet`);
  const vt = (y.tenths / 10).toFixed(1);
  if (y.nearTie) {
    const printed = percentTenths(reading(obs));
    const sides = [y.tenths, y.alt!].map((t) => (t / 10).toFixed(1)).join(" or ");
    const tie = `${id} ${y.current}/${y.base}: the unrounded change is within 0.0005 of the rounding boundary (${sides})`;
    return printed === y.tenths || printed === y.alt ? said("inconclusive", vt, tie) : said("disagree", vt, `${tie}, and the release printed ${obs.value_text}: neither`);
  }
  return compare(vt, `${id} ${target} ${y.current} over ${y.base}${how === "mom" ? " (1-month, seasonally adjusted: the same vintage only on release day)" : ""}`);
}

/**
 * The corroboration source, called once after the primary observed the target. It never throws and never blocks a
 * verdict by being absent: an error, a missing row or a lagging series is "unavailable" (not a disagreement).
 * Only a present value that differs at the published precision is "disagree".
 */
export async function fetchCorroboration(obs: FetchedObservation, target: string, b: Budget): Promise<OfficialCorroboration> {
  const series = obs.series;
  const checked_at = new Date(b.now()).toISOString();
  const unavailable = (detail: string, source_url: string | null = null): OfficialCorroboration => ({ status: "unavailable", source_url, value: null, value_text: null, detail: detail.slice(0, 500), checked_at });
  const compare = (source_url: string, valueText: string, detail: string): OfficialCorroboration => ({
    status: sameAtPrecision(series, reading(obs), valueText) ? "agree" : "disagree",
    source_url, value: Number(valueText), value_text: valueText, detail: detail.slice(0, 500), checked_at,
  });
  switch (series) {
    case "us_cpi_u_nsa_yoy":
    case "us_ppi_fd_nsa_yoy":
    case "us_cpi_u_sa_mom":
    case "us_core_cpi_nsa_yoy":
    case "us_core_cpi_sa_mom":
    case "us_unemployment_rate":
    case "us_nonfarm_payrolls_change": {
      // BLS v1 without a key allows 25 queries a day (possibly per shared egress IP): called once per (series,
      // period), only after the release named the target month (a CPI release day: 4; an Employment Situation: 2).
      const url = blsApiUrl(BLS_API[series].id);
      const g = await officialGet(series, url, b, "application/json");
      if (!g.ok) return unavailable(`BLS API: ${g.error}`, url);
      return blsCorroboration({ ...obs, series }, target, g.text, url, checked_at);
    }
    case "fomc_upper_bound": {
      const day = addDay(target); // DFEDTARU is dated by the effective date, the day after the decision
      const g = await officialGet(series, URLS.fred, b, "text/csv");
      if (!g.ok) return unavailable(`FRED: ${g.error}`, URLS.fred);
      const v = fredValueOn(g.text, day);
      return v ? compare(URLS.fred, v, `DFEDTARU ${day} = ${v}`) : unavailable(`FRED DFEDTARU has no row for ${day} yet`, URLS.fred);
    }
    case "ecb_dfr": {
      const g = await officialGet(series, URLS.ecbDfr, b, "text/csv");
      if (!g.ok) return unavailable(`ECB data API: ${g.error}`, URLS.ecbDfr);
      const rows = parseEcbDfrCsv(g.text);
      if (!rows.length) return unavailable("ECB DFR CSV has no rows", URLS.ecbDfr);
      const eff = typeof obs.meta.effective_from === "string" ? obs.meta.effective_from : null;
      if (obs.direction !== "unchanged") {
        // a change is keyed by its effective date; until that row exists the series says nothing about this decision
        const row = eff ? rows.find((r) => r.date === eff) : undefined;
        return row ? compare(URLS.ecbDfr, row.value, `DFR row ${row.date} = ${row.value}`) : unavailable(`ECB DFR has no change row dated ${eff ?? "(no effective date in the release)"} yet`, URLS.ecbDfr);
      }
      const last = rows.filter((r) => r.date <= target).pop();
      return last ? compare(URLS.ecbDfr, last.value, `DFR in force since ${last.date} = ${last.value} (no change announced)`) : unavailable("ECB DFR has no row before the decision", URLS.ecbDfr);
    }
    case "boe_bank_rate": {
      const url = URLS.boeIadb(`01/${MONTHS[Number(target.slice(5, 7)) - 1]!.slice(0, 3)}/${target.slice(0, 4)}`);
      const g = await officialGet(series, url, b, "text/csv");
      if (!g.ok) return unavailable(`BoE IADB: ${g.error}`, url);
      const v = iadbValueOn(g.text, target);
      return v ? compare(url, v, `IUDBEDR ${target} = ${v}`) : unavailable(`BoE IADB has no IUDBEDR row for ${target} yet`, url);
    }
    case "bok_base_rate": {
      const ymd = target.replace(/-/g, "");
      const url = URLS.ecosBaseRate(ymd);
      const g = await officialGet(series, url, b, "application/json");
      if (!g.ok) return unavailable(`ECOS: ${g.error}`, url);
      const p = parseEcosRows(g.text);
      if (!p.ok) return unavailable(p.detail, url);
      const row = p.rows.find((r) => r.time === ymd);
      return row ? compare(url, row.value, `ECOS 722Y001 ${ymd} = ${row.value}`) : unavailable(`ECOS 722Y001 has no ${ymd} row yet (it lags about two days)`, url);
    }
    case "kr_gdp_advance_yoy": {
      const q = target.replace("-", "");
      const url = URLS.ecosGdp(q);
      const g = await officialGet(series, url, b, "application/json");
      if (!g.ok) return unavailable(`ECOS: ${g.error}`, url);
      const p = parseEcosRows(g.text);
      if (!p.ok) return unavailable(p.detail, url);
      const row = p.rows.find((r) => r.time === q);
      return row ? compare(url, row.value, `ECOS 200Y102/10211 ${q} = ${row.value} (latest vintage; corroborates only on release day)`) : unavailable(`ECOS 200Y102 has no ${q} row yet`, url);
    }
    case "bcb_selic_target":
      return { status: "single_source", source_url: null, value: null, value_text: null, detail: "SGS 432 forward-fills future dates with the current target, so it cannot corroborate a decision; the Copom history row is the only source", checked_at };
    default: { const never: never = series; throw new Error(`no corroboration for ${String(never)}`); }
  }
}

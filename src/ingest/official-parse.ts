/**
 * Pure parsers for the official_release sources (no I/O; tests/official-parse.test.ts runs every one against the
 * bodies saved on 2026-09-24 in evals/fixtures/official/). Each document parser returns what the DOCUMENT says
 * (its own period, value, the exact deciding sentence); whether that is the market's target is the adapter's and
 * the resolver's question, never the parser's.
 * CPU: Workers Free allows 10 ms per invocation. Feeds are walked item by item with indexOf and only the matching
 * item is decoded; HTML pages are narrowed to one block (<PRE>, #article, <main>) before any regex runs.
 */
import { parseDecimal, yoyTenths } from "../resolve/official";

export type Direction = "up" | "down" | "unchanged";

export interface DocObservation {
  /** What the document is about: YYYY-MM, YYYY-Qn or the decision day YYYY-MM-DD. */
  period: string;
  value: number;
  /** As published ("3.4", "3-3/4 to 4", "2.50"). */
  value_text: string;
  /** The exact sentence or title the value comes from, prefixed with the document's own period line. */
  deciding_text: string;
  direction: Direction | null;
  meta: Record<string, string | number | null>;
}

export type DocParse =
  | { ok: true; obs: DocObservation }
  | { ok: false; reason: "not_published" | "schema_drift"; detail: string };

const drift = (detail: string): DocParse => ({ ok: false, reason: "schema_drift", detail });
const notYet = (detail: string): DocParse => ({ ok: false, reason: "not_published", detail });

// ---- text helpers -----------------------------------------------------------------------------------------------

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

export function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
export const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ");
export const squash = (s: string) => s.replace(/\s+/g, " ").trim();
/** HTML fragment -> one line of text. */
export const textOf = (html: string) => squash(decodeEntities(stripTags(html)));
const compact = (s: string) => s.replace(/\s+/g, "").toLowerCase();

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ORDINALS = ["First", "Second", "Third", "Fourth"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "September" | "Sep" | "Sept." -> 9; 0 when not a month. */
export function monthNumber(name: string): number {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (n.length < 3) return 0;
  const i = MONTHS.findIndex((m) => m === n || (n.length <= 4 && m.startsWith(n)));
  return i + 1;
}
const isoDay = (y: string | number, m: number, d: string | number) => `${y}-${pad2(m)}-${pad2(Number(d))}`;
/** "2026-10-28" -> ["2026", "October", "28"] */
function dayParts(date: string): [string, string, string] {
  const [y, m, d] = date.split("-");
  return [y!, MONTH_NAMES[Number(m) - 1] ?? "", String(Number(d))];
}

/**
 * Whether raw bytes contain an ASCII string, without decoding them: lets a burst answer "not yet" for a 0.9 MB feed
 * that does not mention the target date at all (decoding it costs ~0.4 ms of the 10 ms CPU budget, per read).
 */
export function bytesInclude(hay: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  if (!n.length) return true;
  const first = n[0]!;
  for (let i = hay.indexOf(first); i >= 0 && i <= hay.length - n.length; i = hay.indexOf(first, i + 1)) {
    let j = 1;
    while (j < n.length && hay[i + j] === n[j]) j++;
    if (j === n.length) return true;
  }
  return false;
}

/** "2026-10-22" -> "October 22, 2026", the form the BoK decision titles and the Fed date line use. */
export function usDayLabel(date: string): string {
  const [y, mo, d] = dayParts(date);
  return `${mo} ${d}, ${y}`;
}

/** Walk <item> elements without building a DOM. */
function* rssItems(xml: string): Generator<string> {
  let i = xml.indexOf("<item>");
  while (i >= 0) {
    const end = xml.indexOf("</item>", i);
    if (end < 0) return;
    yield xml.slice(i, end);
    i = xml.indexOf("<item>", end);
  }
}
/** The text content of the first <name>…</name> in an item (CDATA unwrapped, entities NOT decoded). */
function rssTag(item: string, name: string): string | null {
  const a = item.indexOf(`<${name}`);
  if (a < 0) return null;
  const s = item.indexOf(">", a);
  const e = item.indexOf(`</${name}>`, s);
  if (s < 0 || e < 0) return null;
  const t = item.slice(s + 1, e).trim();
  return t.startsWith("<![CDATA[") && t.endsWith("]]>") ? t.slice(9, -3) : t;
}

const UP = new Set(["increased", "rose", "advanced", "moved up", "climbed", "edged up", "inched up", "jumped", "grew", "expanded", "raise", "raised", "increase", "hike", "hiked"]);
const DOWN = new Set(["decreased", "fell", "declined", "moved down", "edged down", "inched down", "dropped", "contracted", "shrank", "lower", "lowered", "reduce", "reduced", "decrease", "cut"]);
const FLAT = new Set(["was unchanged", "were unchanged", "remained unchanged", "unchanged", "maintain", "maintained", "keep", "kept", "hold", "held", "leave", "remain unchanged", "stay unchanged"]);
function directionOf(verb: string): Direction | null {
  const v = verb.toLowerCase().replace(/\s+/g, " ").trim();
  return UP.has(v) ? "up" : DOWN.has(v) ? "down" : FLAT.has(v) ? "unchanged" : null;
}
/** A 12-month change stated as verb + magnitude -> signed value text ("3.4", "-0.2", "0.0"). */
function signedPercent(verb: string, magnitude: string | undefined): { value_text: string; direction: Direction } | null {
  const dir = directionOf(verb);
  if (!dir) return null;
  if (dir === "unchanged") return magnitude === undefined || Number(magnitude) === 0 ? { value_text: "0.0", direction: dir } : null;
  if (magnitude === undefined || !parseDecimal(magnitude)) return null;
  return { value_text: dir === "down" && Number(magnitude) !== 0 ? `-${magnitude}` : magnitude, direction: dir };
}

// ---- BLS news release text (CPI, PPI) --------------------------------------------------------------------------

const BLS_VERBS = "increased|decreased|rose|fell|declined|advanced|moved up|moved down|edged up|edged down|inched up|inched down|climbed|dropped|jumped|was unchanged|were unchanged";
const CPI_HEADER = /CONSUMER PRICE INDEX\s*[-–—]\s*([A-Z]+)\s+(\d{4})/;
const PPI_HEADER = /PRODUCER PRICE INDEXES\s*[-–—]\s*([A-Z]+)\s+(\d{4})/;
const CPI_SENTENCE = new RegExp(`Over the (?:last|past) 12 months,? the all items index (${BLS_VERBS})(?: (\\d+(?:\\.\\d+)?) percent)? before seasonal adjustment\\.`, "i");
const PPI_SENTENCE = new RegExp(`On an unadjusted basis,? (?:the index for )?final demand (?:prices )?(${BLS_VERBS})(?: (\\d+(?:\\.\\d+)?) percent)? for the 12 months ended in ([A-Z][a-z]+)\\.`, "i");
const EMBARGO = /embargoed until\b.{0,80}?(\d{1,2}:\d{2}\s*[ap]\.m\.\s*\(ET\)\s*[A-Za-z]+,\s*[A-Za-z]+\.?\s+\d{1,2},\s*\d{4})/i;

/**
 * The first <PRE> block of www.bls.gov/news.release/{cpi,ppi}.nr0.htm: the header names the reference month
 * ("CONSUMER PRICE INDEX - AUGUST 2026") and one sentence states the unadjusted 12-month change.
 */
export function parseBlsRelease(html: string, kind: "cpi" | "ppi"): DocParse {
  const start = html.search(/<pre\b/i);
  if (start < 0) return drift("BLS release has no <PRE> block");
  const rel = html.slice(start, start + 20000).search(/<\/pre>/i);
  const block = textOf(html.slice(start, rel < 0 ? start + 20000 : start + rel));
  const h = (kind === "cpi" ? CPI_HEADER : PPI_HEADER).exec(block);
  if (!h) return drift(`BLS ${kind} release header not found`);
  const month = monthNumber(h[1]!);
  if (!month) return drift(`BLS ${kind} header month "${h[1]}" unreadable`);
  const m = (kind === "cpi" ? CPI_SENTENCE : PPI_SENTENCE).exec(block);
  if (!m) return drift(`BLS ${kind} 12-month unadjusted sentence not found`);
  if (kind === "ppi" && monthNumber(m[3]!) !== month) return drift(`PPI sentence names ${m[3]}, header names ${h[1]}`);
  const v = signedPercent(m[1]!, m[2]);
  if (!v) return drift(`BLS ${kind} sentence verb/magnitude unreadable: ${m[0].slice(0, 120)}`);
  const embargo = EMBARGO.exec(block);
  return { ok: true, obs: {
    period: `${h[2]}-${pad2(month)}`, value: Number(v.value_text), value_text: v.value_text, deciding_text: `${h[0]}: ${m[0]}`, direction: null,
    meta: { embargoed_until: embargo ? squash(embargo[1]!) : null },
  } };
}

/** BLS public API v1 (unregistered): index levels by "YYYY-MM" as published strings. */
export function parseBlsApi(json: string, seriesId: string): { ok: true; index: Map<string, string> } | { ok: false; detail: string } {
  let j: { status?: string; message?: unknown; Results?: { series?: Array<{ seriesID?: string; data?: Array<{ year?: string; period?: string; value?: string }> }> } };
  try { j = JSON.parse(json); } catch { return { ok: false, detail: "BLS API body is not JSON" }; }
  if (j.status !== "REQUEST_SUCCEEDED") return { ok: false, detail: `BLS API status ${String(j.status)} ${JSON.stringify(j.message ?? "").slice(0, 160)}` };
  const s = j.Results?.series?.[0];
  if (!s || s.seriesID !== seriesId || !Array.isArray(s.data)) return { ok: false, detail: `BLS API has no series ${seriesId}` };
  const index = new Map<string, string>();
  for (const row of s.data) {
    if (!row.year || !/^M(0[1-9]|1[0-2])$/.test(row.period ?? "") || !row.value || !parseDecimal(row.value)) continue; // "-" = unavailable (2025 lapse)
    index.set(`${row.year}-${row.period!.slice(1)}`, row.value);
  }
  return { ok: true, index };
}

/** (I[period] / I[period - 12 months] - 1) * 100 from the API's index strings; undefined when either is missing. */
export function blsApiYoy(index: Map<string, string>, period: string): { tenths: number; nearTie: boolean; current: string; base: string } | undefined {
  const [y, m] = period.split("-");
  const current = index.get(period), base = index.get(`${Number(y) - 1}-${m}`);
  if (!current || !base) return undefined;
  const r = yoyTenths(current, base);
  return r ? { ...r, current, base } : undefined;
}

// ---- Federal Reserve ----------------------------------------------------------------------------------------------

/** The FOMC statement for a decision day in the monetary press RSS (monetaryYYYYMMDDa.htm). */
export function findFomcStatement(rss: string, decisionDate: string): { ok: true; url: string; pubDate: string | null } | Extract<DocParse, { ok: false }> {
  const want = `/monetary${decisionDate.replace(/-/g, "")}a.htm`;
  let n = 0;
  for (const it of rssItems(rss)) {
    n++;
    const title = squash(decodeEntities(rssTag(it, "title") ?? ""));
    const link = (rssTag(it, "link") ?? "").trim();
    if (/^Federal Reserve issues FOMC statement$/i.test(title) && link.endsWith(want)) return { ok: true, url: link, pubDate: rssTag(it, "pubDate") };
  }
  return n ? { ok: false, reason: "not_published", detail: `no FOMC statement for ${decisionDate} among ${n} feed items` } : { ok: false, reason: "schema_drift", detail: "Fed monetary feed has no items" };
}

/** "3-3/4" -> 3.75, "4" -> 4, "1/4" -> 0.25. */
export function parseFraction(s: string): number | undefined {
  const m = /^(?:(\d+)-)?(\d+)(?:\/(\d+))?$/.exec(s.trim());
  if (!m) return undefined;
  if (m[3] === undefined) return m[1] === undefined ? Number(m[2]) : undefined;
  const den = Number(m[3]);
  if (!den) return undefined;
  return (m[1] === undefined ? 0 : Number(m[1])) + Number(m[2]) / den;
}

const FRAC = String.raw`(?:\d+-)?\d+(?:\/\d+)?`;
const FOMC_SENTENCE = new RegExp(String.raw`The Committee decided to (raise|lower|maintain|increase|decrease|reduce|cut|keep|hold) the target range for the federal funds rate(?: by (${FRAC}) percentage points?)? (?:to|at) (${FRAC}) to (${FRAC}) percent`, "i");
const FOMC_DATE = /<p class="article__time">\s*([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s*<\/p>/;

/** The statement page: the date line of #article and the target-range sentence (hyphenated fractions). */
export function parseFomcStatement(html: string): DocParse {
  const i = html.indexOf('id="article"');
  if (i < 0) return drift("Fed statement page has no #article");
  const slice = html.slice(i, i + 20000);
  const d = FOMC_DATE.exec(slice);
  if (!d || !monthNumber(d[1]!)) return drift("Fed statement date line not found");
  const m = FOMC_SENTENCE.exec(textOf(slice));
  if (!m) return drift("Fed target-range sentence not found");
  const lo = parseFraction(m[3]!), hi = parseFraction(m[4]!);
  const dir = directionOf(m[1]!);
  if (lo === undefined || hi === undefined || hi <= lo || !dir) return drift(`Fed target range unreadable: ${m[0].slice(0, 160)}`);
  const step = m[2] === undefined ? undefined : parseFraction(m[2]);
  if (m[2] !== undefined && step === undefined) return drift(`Fed step "${m[2]}" unreadable`);
  return { ok: true, obs: {
    period: isoDay(d[3]!, monthNumber(d[1]!), d[2]!), value: hi, value_text: `${m[3]} to ${m[4]}`, deciding_text: `${d[1]} ${d[2]}, ${d[3]}: ${m[0]}`, direction: dir,
    // the stated step is checked against prior_level (src/resolve/official.ts priorLevelProblem)
    meta: { lower_bound: lo, upper_bound: hi, step: m[2] ?? null, stated_step_bps: step === undefined ? null : Math.round(step * 100) },
  } };
}

/** FRED fredgraph.csv: the value on one observation_date (a string as published), else undefined. */
export function fredValueOn(csv: string, date: string): string | undefined {
  const i = csv.indexOf(`\n${date},`);
  if (i < 0) return undefined;
  const end = csv.indexOf("\n", i + 1);
  const v = csv.slice(i + 1, end < 0 ? undefined : end).split(",")[1]?.trim() ?? "";
  return parseDecimal(v) ? v : undefined;
}

// ---- ECB ------------------------------------------------------------------------------------------------------------

const ECB_ENTRY = /<dt isoDate="(\d{4}-\d{2}-\d{2})">[\s\S]*?<\/dt>\s*<dd>\s*<div class="title">\s*<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
const ECB_RELEASE_PATH = /^\/press\/pr\/date\/\d{4}\/html\/ecb\.mp\d{6}~[0-9a-f]+\.en\.html$/;

/** The "Monetary policy decisions" release dated the decision day in /press/govcdec/mopo/<year>/html/index_include.en.html. */
export function findEcbDecision(html: string, decisionDate: string): { ok: true; url: string } | Extract<DocParse, { ok: false }> {
  let n = 0;
  for (const m of html.matchAll(ECB_ENTRY)) {
    n++;
    if (m[1] === decisionDate && squash(decodeEntities(m[3]!)) === "Monetary policy decisions" && ECB_RELEASE_PATH.test(m[2]!)) return { ok: true, url: `https://www.ecb.europa.eu${m[2]}` };
  }
  return n ? { ok: false, reason: "not_published", detail: `no "Monetary policy decisions" release dated ${decisionDate} among ${n} entries` } : { ok: false, reason: "schema_drift", detail: "ECB monetary policy index has no dated entries" };
}

const ECB_STEP = /decided to (raise|lower|reduce|cut|increase|decrease) the three key ECB interest rates by (\d+) basis points/i;
const ECB_PUBDATE = /<p class="ecb-publicationDate">\s*(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})/;
const ECB_SENTENCE = /the interest rates? on the (.{10,200}?) will (?:be )?(increased|decreased|reduced|lowered|raised|cut|remain unchanged|stay unchanged|unchanged)(?: to| at)? (\d+(?:\.\d+)?)\s?%,? (\d+(?:\.\d+)?)\s?% and (\d+(?:\.\d+)?)\s?%(?: respectively)?(?:,? with effect from (\d{1,2} [A-Z][a-z]+ \d{4}))?/i;

/** The release's publication date and the deposit facility rate, located by name in the three-rate sentence. */
export function parseEcbRelease(html: string): DocParse {
  const a = html.indexOf("<main");
  const b = a < 0 ? -1 : html.indexOf("</main>", a);
  if (a < 0 || b < 0) return drift("ECB release has no <main>");
  const slice = html.slice(a, b);
  const d = ECB_PUBDATE.exec(slice);
  if (!d || !monthNumber(d[2]!)) return drift("ECB publication date not found");
  const text = textOf(slice);
  const m = ECB_SENTENCE.exec(text);
  if (!m) return drift("ECB key-rates sentence not found");
  const names = m[1]!.split(/,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.replace(/^the\s+/i, "").trim().toLowerCase()).filter(Boolean);
  const idx = names.findIndex((x) => x.startsWith("deposit facility"));
  if (names.length !== 3 || idx < 0) return drift(`ECB rate names unreadable: ${m[1]}`);
  const valueText = [m[3], m[4], m[5]][idx]!;
  const dir = directionOf(m[2]!);
  if (!dir) return drift(`ECB verb unreadable: ${m[2]}`);
  const st = ECB_STEP.exec(text);
  if (st && directionOf(st[1]!) !== dir) return drift(`ECB step sentence (${st[1]}) contradicts the rates sentence (${m[2]})`);
  let effective: string | null = null;
  if (m[6]) { const e = /^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(m[6]); if (e && monthNumber(e[2]!)) effective = isoDay(e[3]!, monthNumber(e[2]!), e[1]!); }
  return { ok: true, obs: {
    period: isoDay(d[3]!, monthNumber(d[2]!), d[1]!), value: Number(valueText), value_text: valueText, deciding_text: `${d[1]} ${d[2]} ${d[3]}: ${m[0]}`, direction: dir,
    meta: { effective_from: effective, rates_in_order: names.join(" | "), stated_step_bps: st ? Number(st[2]) : null },
  } };
}

/** Minimal RFC 4180 line split (quoted fields may hold commas). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** data-api.ecb.europa.eu DFR "date of changes" CSV: [{ date (effective date), value }]. */
export function parseEcbDfrCsv(csv: string): Array<{ date: string; value: string }> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const head = splitCsvLine(lines[0] ?? "");
  const iT = head.indexOf("TIME_PERIOD"), iV = head.indexOf("OBS_VALUE");
  if (iT < 0 || iV < 0) return [];
  const rows: Array<{ date: string; value: string }> = [];
  for (const l of lines.slice(1)) {
    const c = splitCsvLine(l);
    if (/^\d{4}-\d{2}-\d{2}$/.test(c[iT] ?? "") && parseDecimal(c[iV] ?? "")) rows.push({ date: c[iT]!, value: c[iV]! });
  }
  return rows.sort((x, y) => x.date.localeCompare(y.date));
}

// ---- Bank of England -------------------------------------------------------------------------------------------------

const BOE_TITLE = /^Bank rate (maintained|held|kept|unchanged|increased|raised|reduced|cut|lowered|decreased)(?: at| to)? (\d+(?:\.\d+)?)%\s*[-–—]\s*([A-Z][a-z]+) (\d{4}) Monetary Policy Summary/i;
const RSS_DATE = /^[A-Za-z]{3},\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/;

/** www.bankofengland.co.uk/rss/news: the "Bank Rate <verb> <x>% - <Month YYYY> Monetary Policy Summary" item. */
export function parseBoeRss(xml: string, monthYear: string): DocParse {
  let n = 0;
  for (const it of rssItems(xml)) {
    n++;
    const title = squash(decodeEntities(rssTag(it, "title") ?? ""));
    const m = BOE_TITLE.exec(title);
    if (!m || `${m[3]} ${m[4]}`.toLowerCase() !== monthYear.toLowerCase()) continue;
    const dir = directionOf(m[1]!);
    const pd = RSS_DATE.exec((rssTag(it, "pubDate") ?? "").trim());
    if (!dir || !pd || !monthNumber(pd[2]!)) return drift(`BoE item unreadable: ${title.slice(0, 120)}`);
    return { ok: true, obs: {
      period: isoDay(pd[3]!, monthNumber(pd[2]!), pd[1]!), value: Number(m[2]), value_text: m[2]!, deciding_text: title, direction: dir,
      meta: { pub_date: (rssTag(it, "pubDate") ?? "").trim(), link: (rssTag(it, "link") ?? "").trim() },
    } };
  }
  return n ? notYet(`no "${monthYear} Monetary Policy Summary" Bank Rate item among ${n} feed items`) : drift("BoE news feed has no items");
}

/** IADB IUDBEDR CSV ("05 Nov 2026,3.75"): the Bank Rate on one day as published, else undefined. */
export function iadbValueOn(csv: string, date: string): string | undefined {
  const [y, m, d] = date.split("-");
  const label = `${d} ${MONTH_NAMES[Number(m) - 1]!.slice(0, 3)} ${y}`;
  const i = csv.indexOf(`\n${label},`);
  if (i < 0) return undefined;
  const end = csv.indexOf("\n", i + 1);
  const v = csv.slice(i + 1, end < 0 ? undefined : end).split(",")[1]?.trim() ?? "";
  return parseDecimal(v) ? v : undefined;
}

// ---- Bank of Korea ----------------------------------------------------------------------------------------------------

const BOK_SENTENCE = /The Monetary Policy Board of the Bank of Korea decided today to (raise|lower|cut|reduce|leave|keep|hold|maintain) the Base Rate (?:by (\d+) basis points? )?(?:from (\d+(?:\.\d+)?)% to (\d+(?:\.\d+)?)%|(?:unchanged )?at (\d+(?:\.\d+)?)%)/i;

/**
 * The BoK "Monetary Policy Decision" RSS (~0.9 MB, 100 items): the item titled "…(October 22, 2026)", then the
 * decision sentence of its description (entity-encoded HTML inside CDATA). Only that item is decoded.
 */
export function parseBokDecisionRss(xml: string, decisionDate: string): DocParse {
  const [y, mo, d] = dayParts(decisionDate);
  const label = `${mo} ${d}, ${y}`;
  const key = compact(`(${label})`);
  // Burst attempts re-read this 0.9 MB feed: a feed with items that never mentions the date skips the item walk.
  if (xml.indexOf("<item>") >= 0 && xml.indexOf(label) < 0) return notYet(`no item mentions ${label} yet`);
  let n = 0;
  for (const it of rssItems(xml)) {
    n++;
    const title = rssTag(it, "title") ?? "";
    const ct = compact(decodeEntities(title));
    if (!ct.includes("monetarypolicydecision") || !ct.includes(key)) continue;
    const text = squash(decodeEntities(stripTags(decodeEntities(rssTag(it, "description") ?? ""))));
    const m = BOK_SENTENCE.exec(text);
    if (!m) return drift(`BoK decision sentence not found in the (${label}) item`);
    const dir = directionOf(m[1]!);
    const valueText = m[4] ?? m[5];
    if (!dir || !valueText) return drift(`BoK decision unreadable: ${m[0].slice(0, 160)}`);
    if (m[3] && m[4]) {
      const moved = Math.sign(Number(m[4]) - Number(m[3]));
      if ((dir === "up" && moved <= 0) || (dir === "down" && moved >= 0)) return drift(`BoK verb ${m[1]} contradicts ${m[3]}% -> ${m[4]}%`);
      if (m[2] && Math.abs(Math.round((Number(m[4]) - Number(m[3])) * 100)) !== Number(m[2])) return drift(`BoK step ${m[2]} bp contradicts ${m[3]}% -> ${m[4]}%`);
    }
    return { ok: true, obs: {
      period: decisionDate, value: Number(valueText), value_text: valueText, deciding_text: `(${label}) ${m[0]}`, direction: dir,
      // the stated starting level and step are checked against prior_level (src/resolve/official.ts priorLevelProblem)
      meta: { from_level: m[3] ?? null, step_bps: m[2] ? Number(m[2]) : null, stated_prior: m[3] ?? null, stated_step_bps: m[2] ? Number(m[2]) : null, pub_date: (rssTag(it, "pubDate") ?? "").trim() },
    } };
  }
  return n ? notYet(`no Monetary Policy Decision item dated (${label}) among ${n} feed items`) : drift("BoK decision feed has no items");
}

const GDP_SENTENCE = /in year-on-year terms it (?:(increased|decreased|rose|fell|grew|expanded|contracted|declined|shrank) by (\d+(?:\.\d+)?) ?(?:percent|%)|(was unchanged|remained unchanged))/gi;

/**
 * The GDP paragraph of an advance-estimate description: from "Real gross domestic product" to "Real gross domestic
 * income" or the next "◈", whichever comes first. The GDI paragraph that follows uses the same year-on-year wording
 * (Q2 2026: GDP 3.7, GDI 15.6), so nothing outside this paragraph may ever be read as the GDP figure.
 */
export function gdpParagraph(text: string): string | null {
  const start = text.search(/Real gross domestic product\b/i);
  if (start < 0) return null;
  const rest = text.slice(start + "Real gross domestic product".length);
  const ends = [rest.search(/Real gross domestic income\b/i), rest.indexOf("◈")].filter((i) => i >= 0);
  return text.slice(start, start + "Real gross domestic product".length + (ends.length ? Math.min(...ends) : rest.length));
}

/**
 * The BoK press-release RSS item "Real Gross Domestic Product: Third Quarter of 2026 (Advance Estimate)". The GDP
 * paragraph must hold exactly one year-on-year statement in a recognised form; a reworded or doubled clause is schema
 * drift (alerted), never a value.
 */
export function parseBokGdpRss(xml: string, quarter: string): DocParse {
  const q = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!q) return drift(`quarter ${quarter} unreadable`);
  const want = compact(`Real Gross Domestic Product: ${ORDINALS[Number(q[2]) - 1]} Quarter of ${q[1]} (Advance Estimate)`);
  let n = 0;
  for (const it of rssItems(xml)) {
    n++;
    const title = squash(decodeEntities(decodeEntities(rssTag(it, "title") ?? "")));
    if (compact(title) !== want) continue;
    const text = squash(decodeEntities(stripTags(decodeEntities(rssTag(it, "description") ?? ""))));
    const para = gdpParagraph(text);
    if (!para) return drift(`no "Real gross domestic product" paragraph in "${title}"`);
    const matches = [...para.matchAll(GDP_SENTENCE)];
    const mentions = (para.match(/year-on-year/gi) ?? []).length;
    if (matches.length !== 1 || mentions !== 1) return drift(`the GDP paragraph of "${title}" holds ${matches.length} readable year-on-year statement(s) and ${mentions} mention(s), expected exactly one: ${para.slice(0, 200)}`);
    const m = matches[0]!;
    const v = m[3] ? { value_text: "0.0", direction: "unchanged" as Direction } : signedPercent(m[1]!, m[2]);
    if (!v) return drift(`GDP sentence unreadable: ${m[0]}`);
    return { ok: true, obs: {
      period: quarter, value: Number(v.value_text), value_text: v.value_text, deciding_text: `${title}: ${m[0]}`, direction: null,
      meta: { pub_date: (rssTag(it, "pubDate") ?? "").trim() },
    } };
  }
  return n ? notYet(`no "${title4(q)}" advance-estimate item among ${n} feed items`) : drift("BoK press feed has no items");
}
const title4 = (q: RegExpExecArray) => `${ORDINALS[Number(q[2]) - 1]} Quarter of ${q[1]}`;

/** ECOS StatisticSearch JSON rows; an INFO-200 answer ("no data") is an empty list, any other RESULT is an error. */
export function parseEcosRows(json: string): { ok: true; rows: Array<{ time: string; value: string; item: string | null }> } | { ok: false; detail: string } {
  let j: { StatisticSearch?: { row?: Array<{ TIME?: string; DATA_VALUE?: string; ITEM_NAME1?: string }> }; RESULT?: { CODE?: string; MESSAGE?: string } };
  try { j = JSON.parse(json); } catch { return { ok: false, detail: "ECOS body is not JSON" }; }
  if (j.RESULT) return j.RESULT.CODE === "INFO-200" ? { ok: true, rows: [] } : { ok: false, detail: `ECOS ${j.RESULT.CODE ?? "?"}: ${String(j.RESULT.MESSAGE ?? "").slice(0, 120)}` };
  const rows = (j.StatisticSearch?.row ?? []).filter((r) => r.TIME && r.DATA_VALUE && parseDecimal(r.DATA_VALUE)).map((r) => ({ time: r.TIME!, value: r.DATA_VALUE!, item: r.ITEM_NAME1 ?? null }));
  return { ok: true, rows };
}

// ---- Banco Central do Brasil --------------------------------------------------------------------------------------------

interface CopomRow { NumeroReuniaoCopom?: number; ReuniaoExtraordinaria?: boolean; DataReuniaoCopom?: string; DataInicioVigencia?: string | null; MetaSelic?: number }

/** DataReuniaoCopom is midnight Brasília time written in UTC ("2026-09-16T03:00:00Z"): the meeting's BRT date. */
function brtDate(isoTs: string | undefined): string | null {
  const t = isoTs ? Date.parse(isoTs) : NaN;
  return Number.isFinite(t) ? new Date(t - 3 * 3600_000).toISOString().slice(0, 10) : null;
}

/**
 * www.bcb.gov.br/api/servico/sitebcb/historicotaxasjuros: the ORDINARY Copom row whose meeting date is the target.
 * The latest SGS 432 value is never read: that series forward-fills future dates with the current target.
 */
export function parseBcbHistory(json: string, meetingDate: string): DocParse {
  // A burst re-reads this 100 KB body up to ten times in one invocation (10 ms CPU on Workers Free); JSON.parse costs
  // ~1 ms. A body with the expected shape that never mentions the meeting's date cannot hold its row: answer from
  // one indexOf. Anything else goes through the full parse, so schema drift is still reported as drift.
  if (json.trimStart().startsWith('{"conteudo":[{') && json.indexOf(meetingDate) < 0) {
    return notYet(`no Copom row mentions ${meetingDate} yet`);
  }
  let j: { conteudo?: CopomRow[] };
  try { j = JSON.parse(json); } catch { return drift("BCB history body is not JSON"); }
  const rows = Array.isArray(j.conteudo) ? j.conteudo : null;
  if (!rows || !rows.length) return drift("BCB history has no rows");
  const ordinary = rows.filter((r) => r && r.ReuniaoExtraordinaria === false && brtDate(r.DataReuniaoCopom));
  const hits = ordinary.filter((r) => brtDate(r.DataReuniaoCopom) === meetingDate);
  if (hits.length > 1) return drift(`${hits.length} ordinary Copom rows dated ${meetingDate}`);
  if (!hits.length) {
    const latest = ordinary.map((r) => brtDate(r.DataReuniaoCopom)!).sort().pop();
    return notYet(`no ordinary Copom row dated ${meetingDate} (latest meeting ${latest ?? "?"})`);
  }
  const r = hits[0]!;
  if (typeof r.MetaSelic !== "number" || !Number.isFinite(r.MetaSelic)) return drift(`Copom row ${meetingDate} has no MetaSelic`);
  const prev = ordinary.filter((x) => brtDate(x.DataReuniaoCopom)! < meetingDate).sort((a, b) => brtDate(b.DataReuniaoCopom)!.localeCompare(brtDate(a.DataReuniaoCopom)!))[0];
  const prevLevel = typeof prev?.MetaSelic === "number" ? prev.MetaSelic : null;
  const direction: Direction | null = prevLevel === null ? null : r.MetaSelic > prevLevel ? "up" : r.MetaSelic < prevLevel ? "down" : "unchanged";
  const valueText = String(r.MetaSelic);
  return { ok: true, obs: {
    period: meetingDate, value: r.MetaSelic, value_text: valueText,
    deciding_text: `Copom meeting ${r.NumeroReuniaoCopom ?? "?"} of ${meetingDate} (ordinary): MetaSelic ${valueText}% in force from ${brtDate(r.DataInicioVigencia ?? undefined) ?? "?"}${prev ? `; previous meeting ${prev.NumeroReuniaoCopom ?? "?"} (${brtDate(prev.DataReuniaoCopom)}): ${prevLevel}%` : ""}`,
    // the previous meeting's target is the level this decision moved from: checked against prior_level
    direction, meta: { meeting_number: r.NumeroReuniaoCopom ?? null, previous_level: prevLevel, stated_prior: prevLevel === null ? null : String(prevLevel) },
  } };
}

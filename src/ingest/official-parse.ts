/**
 * Pure parsers for the official_release sources (no I/O; tests/official-parse.test.ts and tests/official-bls.test.ts
 * run every one against the bodies saved on 2026-09-24 and 2026-09-27 in evals/fixtures/official/). Each document
 * parser returns what the DOCUMENT says (its own period, value, the exact deciding sentence); whether that is the
 * market's target is the adapter's and the resolver's question, never the parser's.
 * CPU: Workers Free allows 10 ms per invocation. Feeds are walked item by item with indexOf and only the matching
 * item is decoded; HTML pages are narrowed to one block (<PRE>, #article, <main>) before any regex runs.
 */
import { parseDecimal, percentTenths, yoyTenths } from "../resolve/official";

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

/**
 * BLS public API v1 (unregistered): values by "YYYY-MM" as published strings, and the month the API flags as its
 * latest (latest: "true"), which says whether a later release has already superseded a month's first print.
 */
export function parseBlsApi(json: string, seriesId: string): { ok: true; index: Map<string, string>; latest: string | null } | { ok: false; detail: string } {
  let j: { status?: string; message?: unknown; Results?: { series?: Array<{ seriesID?: string; data?: Array<{ year?: string; period?: string; value?: string }> }> } };
  try { j = JSON.parse(json); } catch { return { ok: false, detail: "BLS API body is not JSON" }; }
  if (j.status !== "REQUEST_SUCCEEDED") return { ok: false, detail: `BLS API status ${String(j.status)} ${JSON.stringify(j.message ?? "").slice(0, 160)}` };
  const s = j.Results?.series?.[0];
  if (!s || s.seriesID !== seriesId || !Array.isArray(s.data)) return { ok: false, detail: `BLS API has no series ${seriesId}` };
  const index = new Map<string, string>();
  let latest: string | null = null;
  for (const row of s.data as Array<{ year?: string; period?: string; value?: string; latest?: unknown }>) {
    if (!row.year || !/^M(0[1-9]|1[0-2])$/.test(row.period ?? "")) continue;
    const key = `${row.year}-${row.period!.slice(1)}`;
    if (row.latest === "true" || row.latest === true) latest = key;
    if (!row.value || !parseDecimal(row.value)) continue; // "-" = unavailable (2025 lapse)
    index.set(key, row.value);
  }
  return { ok: true, index, latest };
}

/** "2026-01" -> "2025-12" */
export function previousMonth(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
}

/** (I[period] / I[period - 1 month] - 1) * 100 from the API's index strings; undefined when either is missing. */
export function blsApiMom(index: Map<string, string>, period: string): { tenths: number; nearTie: boolean; alt?: number; current: string; base: string } | undefined {
  const current = index.get(period), base = index.get(previousMonth(period));
  if (!current || !base) return undefined;
  const r = yoyTenths(current, base);
  return r ? { ...r, current, base } : undefined;
}

/** L[period] - L[period - 1 month] for a level published in whole thousands (CES); undefined when either is missing or fractional. */
export function blsApiLevelChange(index: Map<string, string>, period: string): { change: number; current: string; base: string } | undefined {
  const current = index.get(period), base = index.get(previousMonth(period));
  const a = current === undefined ? undefined : parseDecimal(current), b = base === undefined ? undefined : parseDecimal(base);
  if (!a || !b || a.scale !== 0 || b.scale !== 0) return undefined;
  return { change: Number(a.n - b.n), current: current!, base: base! };
}

/** (I[period] / I[period - 12 months] - 1) * 100 from the API's index strings; undefined when either is missing. */
export function blsApiYoy(index: Map<string, string>, period: string): { tenths: number; nearTie: boolean; alt?: number; current: string; base: string } | undefined {
  const [y, m] = period.split("-");
  const current = index.get(period), base = index.get(`${Number(y) - 1}-${m}`);
  if (!current || !base) return undefined;
  const r = yoyTenths(current, base);
  return r ? { ...r, current, base } : undefined;
}

// ---- BLS CPI Table A: 1-month SA and 12-month NSA changes of all items and of all items less food and energy ----------

export type CpiTableRow = "all_items" | "core";
export type CpiTableColumn = "sa_1m" | "nsa_12m";
const CPI_ROWS: Record<CpiTableRow, { id: string; label: string }> = {
  all_items: { id: "cpi_pressa.r.1", label: "All items" },
  core: { id: "cpi_pressa.r.1.3", label: "All items less food and energy" },
};
const CPI_TABLE_A_CAPTION = "Table A. Percent changes in CPI for All Urban Consumers (CPI-U): U.S. city average";
const CPI_SA_GROUP = "Seasonally adjusted changes from preceding month";
const TABLE_MONTH = /^([A-Z][a-z]{2,8})\.? (\d{4})$/;
const TABLE_NSA_12M = /^Un- ?adjusted 12-mos\. ended ([A-Z][a-z]{2,8})\.? (\d{4})$/;
const TABLE_CELL = /^-?\d{1,3}\.\d$/;
/** What BLS prints in a cell it has no value for (the 2025 lapse left October 2025 as "-"). */
const TABLE_NO_VALUE = new Set(["-", "–", "—", "(NA)", "NA", "N/A"]);
// The summary sentences a 1-month cell is cross-checked against when they tie a value to "in <Month>" (both word
// orders of the headline; "over the 2 months" never matches). A sentence that is absent is not required.
const CPI_HEADLINE_MOM = [
  new RegExp(`\\(CPI-U\\) (${BLS_VERBS})(?: (\\d+\\.\\d) percent)? on a seasonally adjusted basis in ([A-Z][a-z]+)\\b`),
  new RegExp(`\\(CPI-U\\) (${BLS_VERBS})(?: (\\d+\\.\\d) percent)? in ([A-Z][a-z]+) on a seasonally adjusted basis\\b`),
];
const CPI_CORE_MOM = [new RegExp(`The index for all items less food and energy (${BLS_VERBS})(?: (\\d+\\.\\d) percent)? in ([A-Z][a-z]+)\\b`)];

interface Cell { headers: string[]; text: string }
function tableCells(rowHtml: string): Cell[] {
  const out: Cell[] = [];
  for (const m of rowHtml.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)) {
    const h = /\bheaders="([^"]*)"/.exec(m[1]!);
    out.push({ headers: h ? h[1]!.trim().split(/\s+/) : [], text: textOf(m[2]!) });
  }
  return out;
}

/**
 * One cell of Table A of www.bls.gov/news.release/cpi.nr0.htm, the release the headline 12-month change is read
 * from. The reference month is the release header's ("CONSUMER PRICE INDEX - AUGUST 2026"); the row is found by its
 * id AND its exact label, the column by its header text (never by position): the seasonally adjusted month column
 * must name the header month and be the group's last, the 12-month column must say "ended <header month>". A "-"
 * cell is not published (never 0); anything else unexpected is schema drift.
 */
export function parseBlsCpiTableA(html: string, row: CpiTableRow, column: CpiTableColumn): DocParse {
  const start = html.search(/<pre\b/i);
  if (start < 0) return drift("BLS CPI release has no <PRE> block");
  const rel = html.slice(start, start + 20000).search(/<\/pre>/i);
  const block = textOf(html.slice(start, rel < 0 ? start + 20000 : start + rel));
  const h = CPI_HEADER.exec(block);
  if (!h) return drift("BLS cpi release header not found");
  const month = monthNumber(h[1]!), year = h[2]!;
  if (!month) return drift(`BLS cpi header month "${h[1]}" unreadable`);
  const id = html.indexOf('id="cpi_pressa"', start);
  const t0 = id < 0 ? -1 : html.lastIndexOf("<table", id);
  const t1 = t0 < 0 ? -1 : html.indexOf("</table>", t0);
  if (t0 < 0 || t1 < 0 || t1 - t0 > 60000) return drift("BLS CPI Table A (id cpi_pressa) not found");
  const table = html.slice(t0, t1);
  const cap = /<caption>([\s\S]*?)<\/caption>/.exec(table);
  if (!cap || !textOf(cap[1]!).startsWith(CPI_TABLE_A_CAPTION)) return drift(`BLS CPI Table A caption is not "${CPI_TABLE_A_CAPTION}"`);
  const body = table.indexOf("<tbody");
  if (body < 0) return drift("BLS CPI Table A has no <tbody>");
  const heads: Array<{ id: string; headers: string[]; text: string }> = [];
  for (const m of table.slice(0, body).matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)) {
    const i = /\bid="([^"]+)"/.exec(m[1]!), hh = /\bheaders="([^"]*)"/.exec(m[1]!);
    if (i) heads.push({ id: i[1]!, headers: hh ? hh[1]!.trim().split(/\s+/) : [], text: textOf(m[2]!) });
  }
  const sameMonth = (mon: string, yr: string) => monthNumber(mon) === month && yr === year;
  const want = `${MONTH_NAMES[month - 1]} ${year}`;
  let colIds: string[];
  let colText: string;
  if (column === "sa_1m") {
    const group = heads.filter((x) => x.text === CPI_SA_GROUP);
    if (group.length !== 1) return drift(`BLS CPI Table A has ${group.length} "${CPI_SA_GROUP}" column groups`);
    const months = heads.filter((x) => x.headers.includes(group[0]!.id));
    const parsed = months.map((x) => ({ x, m: TABLE_MONTH.exec(x.text) }));
    if (!months.length || parsed.some((p) => !p.m)) return drift(`BLS CPI Table A month headers unreadable: ${months.map((x) => x.text).join(" | ").slice(0, 160)}`);
    const hits = parsed.filter((p) => sameMonth(p.m![1]!, p.m![2]!));
    if (hits.length !== 1) return drift(`BLS CPI Table A has ${hits.length} seasonally adjusted columns for ${want} (header month); columns: ${months.map((x) => x.text).join(" | ").slice(0, 160)}`);
    if (hits[0]!.x !== months[months.length - 1]) return drift(`BLS CPI Table A: the ${want} column is not the last seasonally adjusted month`);
    colIds = [group[0]!.id, hits[0]!.x.id];
    colText = `${CPI_SA_GROUP}, ${hits[0]!.x.text}`;
  } else {
    const nsa = heads.filter((x) => /^Un-/.test(x.text));
    if (nsa.length !== 1) return drift(`BLS CPI Table A has ${nsa.length} unadjusted 12-month columns`);
    const m = TABLE_NSA_12M.exec(nsa[0]!.text);
    if (!m) return drift(`BLS CPI Table A 12-month header unreadable: "${nsa[0]!.text.slice(0, 80)}"`);
    if (!sameMonth(m[1]!, m[2]!)) return drift(`BLS CPI Table A 12-month column is for ${m[1]} ${m[2]}, the header names ${want}`);
    colIds = [nsa[0]!.id];
    colText = nsa[0]!.text;
  }
  const spec = CPI_ROWS[row];
  const r0 = table.indexOf(`id="${spec.id}"`, body);
  const th0 = r0 < 0 ? -1 : table.lastIndexOf("<th", r0);
  const thEnd = th0 < 0 ? -1 : table.indexOf("</th>", r0);
  const trEnd = thEnd < 0 ? -1 : table.indexOf("</tr>", thEnd);
  if (th0 < 0 || thEnd < 0 || trEnd < 0) return drift(`BLS CPI Table A row ${spec.id} not found`);
  const label = textOf(table.slice(table.indexOf(">", th0) + 1, thEnd));
  if (label !== spec.label) return drift(`BLS CPI Table A row ${spec.id} is "${label.slice(0, 80)}", expected "${spec.label}"`);
  const cells = tableCells(table.slice(thEnd, trEnd)).filter((c) => c.headers.includes(spec.id) && colIds.every((x) => c.headers.includes(x)));
  if (cells.length !== 1) return drift(`BLS CPI Table A has ${cells.length} cells for ${spec.label} / ${colText}`);
  const v = cells[0]!.text;
  if (TABLE_NO_VALUE.has(v)) return notYet(`BLS CPI Table A prints "${v}" for ${spec.label}, ${colText}: no value published for ${want}`);
  if (!TABLE_CELL.test(v)) return drift(`BLS CPI Table A cell for ${spec.label}, ${colText} is "${v.slice(0, 40)}"`);
  if (column === "sa_1m") {
    for (const re of row === "all_items" ? CPI_HEADLINE_MOM : CPI_CORE_MOM) {
      const s = re.exec(block);
      if (!s) continue;
      const said = signedPercent(s[1]!, s[2]);
      if (!said || monthNumber(s[3]!) !== month || percentTenths(said.value_text) !== percentTenths(v)) {
        return drift(`BLS CPI summary sentence "${s[0].slice(0, 140)}" does not match Table A ${spec.label}, ${colText} = ${v}`);
      }
      break;
    }
  }
  return { ok: true, obs: {
    period: `${year}-${pad2(month)}`, value: Number(v), value_text: v, deciding_text: `${h[0]}: Table A, ${spec.label}, ${colText}: ${v}`, direction: null,
    meta: { table: "cpi_pressa", row: spec.id, column: colIds.join(" "), embargoed_until: (() => { const e = EMBARGO.exec(block); return e ? squash(e[1]!) : null; })() },
  } };
}

// ---- BLS Employment Situation summary text: the unemployment rate and the nonfarm payroll change -------------------

export type EmpsitNumber = "unemployment_rate" | "payrolls_change";
const EMPSIT_HEADER = /THE EMPLOYMENT SITUATION\s*(?:-{1,2}|[–—])\s*([A-Z]+)\s+(\d{4})/;
const RATE_PATTERNS = [
  /\b[Tt]he unemployment rate (?:was unchanged|changed little|was little changed|was essentially unchanged|held steady|held|remained|stayed) at (\d{1,2}\.\d) percent/g,
  /\b[Tt]he unemployment rate (?:rose|increased|edged up|ticked up|moved up|jumped|declined|decreased|fell|edged down|ticked down|moved down|dropped)(?: by \d\.\d percentage points?)? to (\d{1,2}\.\d) percent/g,
  /\b[Tt]he unemployment rate, at (\d{1,2}\.\d) percent,/g,
  /\b[Tt]he unemployment rate \((\d{1,2}\.\d) percent\)/g,
];
const PAYROLL_UP = "increased|rose|edged up|grew|advanced|climbed|jumped|expanded";
const PAYROLL_DOWN = "decreased|declined|fell|edged down|dropped|contracted";
const COUNT = String.raw`\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)? million`;
const SIGNED = String.raw`[+\-−]?\d{1,3}(?:,\d{3})+`;
const LITTLE = "changed little|was little changed|was essentially unchanged|was unchanged|showed little change";
const MONTH_WORD = "([A-Z][a-z]+)";
/**
 * verb: the sign comes from the verb (the count must be unsigned); checkVerb: the count carries its sign, which must
 * match the verb. Every pattern names TOTAL nonfarm payroll employment ("Total ...", or "Both [total] nonfarm ... and the
 * unemployment rate"): a qualified count ("Private nonfarm payroll employment ...", "Government ...") is never read.
 */
const PAYROLL_PATTERNS: Array<{ re: RegExp; month: number; count: number; verb?: number; checkVerb?: number }> = [
  { re: new RegExp(String.raw`\b[Tt]otal nonfarm payroll employment (${PAYROLL_UP}|${PAYROLL_DOWN}) by (${COUNT}) in ${MONTH_WORD}\b`, "g"), verb: 1, count: 2, month: 3 },
  { re: new RegExp(String.raw`\b[Tt]otal nonfarm payroll employment (${PAYROLL_UP}|${PAYROLL_DOWN}) in ${MONTH_WORD} \((${SIGNED})\)`, "g"), checkVerb: 1, month: 2, count: 3 },
  { re: new RegExp(String.raw`\b[Tt]otal nonfarm payroll employment (?:${LITTLE}) in ${MONTH_WORD} \((${SIGNED})\)`, "g"), month: 1, count: 2 },
  { re: new RegExp(String.raw`\b[Tt]otal nonfarm payroll employment (?:${LITTLE}) \((${SIGNED})\) in ${MONTH_WORD}\b`, "g"), count: 1, month: 2 },
  { re: new RegExp(String.raw`\bBoth (?:total )?nonfarm payroll employment \((${SIGNED})\) and the unemployment rate \(\d{1,2}\.\d percent\) (?:changed little|were little changed|showed little change) in ${MONTH_WORD}\b`, "g"), count: 1, month: 2 },
];
/** The lead paragraph is found by what it says, never by its position (a boxed note may sit between it and the header). */
const EMPSIT_LEAD = /\bBureau of Labor Statistics reported today\b/;
/** A year right after a month word ("September 2025", "September, 2025"). */
const YEAR_AFTER = /^,? (\d{4})\b/;
/** A rate tied to its month by the words right after it ("4.1 percent in August"). */
const RATE_TIED = /^ in ([A-Z][a-z]+)\b(?:,? (\d{4})\b)?/;
const MONTH_NAMES_RE = new RegExp(String.raw`\b(${MONTH_NAMES.join("|")})\b(?:,? (\d{4})\b)?`, "g");

/** The sentence around a match: from the previous sentence end to the next ("U.S." is not an end). */
function sentenceAt(text: string, at: number): string {
  const ends = [...text.matchAll(/(?<!\b[A-Z])\.(?=\s+[A-Z(]|\s*$)/g)].map((m) => m.index!);
  const before = ends.filter((e) => e < at).pop();
  const after = ends.find((e) => e >= at);
  return squash(text.slice(before === undefined ? 0 : before + 1, after === undefined ? text.length : after + 1));
}

/** A payroll count as printed ("162,000", "-23,000", "+126,000") -> whole thousands, or a reason it is not one. */
function payrollThousands(s: string, sign: 1 | -1 | null): number | string {
  if (/million/.test(s)) return `"${s}" is rounded to a tenth of a million, not the change in thousands`;
  const neg = /^[\-−]/.test(s), pos = /^\+/.test(s);
  if (sign !== null && (neg || pos)) return `"${s}" is signed after a verb that already gives the sign`;
  const digits = s.replace(/^[+\-−]/, "").replace(/,/g, "");
  if (!/^\d+000$/.test(digits)) return `"${s}" is not a whole number of thousands`;
  const k = Number(digits.slice(0, -3));
  return (sign ?? (neg ? -1 : 1)) * k || 0;
}

/**
 * The first <PRE> of www.bls.gov/news.release/empsit.nr0.htm ("Employment Situation Summary"). The header names the
 * reference month ("THE EMPLOYMENT SITUATION - AUGUST 2026", "--" in some releases). A number is read only from the
 * lead paragraph (the one saying "... the U.S. Bureau of Labor Statistics reported today", wherever it sits) and the
 * first paragraph of its section (Household or Establishment Survey Data), and only when it is tied to the header
 * month: a payroll count by the month its pattern names, a rate by "X percent in <Month>" or else by a sentence that
 * names the header month and no other. A month with another year ("September 2025") is another month. Never from the
 * revisions of earlier months ("The change in total nonfarm payroll employment for June was revised ..."), a
 * parenthetical prior month or a qualified count ("Private nonfarm ..."). Every reading found must agree; none, a
 * disagreement or a count in millions is schema drift, never a guess.
 */
export function parseEmpsitRelease(html: string, which: EmpsitNumber): DocParse {
  const start = html.search(/<pre\b/i);
  if (start < 0) return drift("BLS Employment Situation release has no <PRE> block");
  const rel = html.slice(start, start + 60000).search(/<\/pre>/i);
  const raw = decodeEntities(stripTags(html.slice(start, rel < 0 ? start + 60000 : start + rel))).replace(/\r/g, "");
  const h = EMPSIT_HEADER.exec(raw);
  if (!h) return drift("BLS Employment Situation header not found");
  const month = monthNumber(h[1]!);
  if (!month) return drift(`BLS Employment Situation header month "${h[1]}" unreadable`);
  const monthName = MONTH_NAMES[month - 1]!;
  const year = h[2]!;
  const header = squash(h[0]);
  const paras = raw.slice(h.index + h[0].length).split(/\n[ \t|]*\n/).map(squash).filter(Boolean);
  const lead = paras.find((p) => EMPSIT_LEAD.test(p));
  if (!lead) return drift("BLS Employment Situation lead paragraph (\"... the U.S. Bureau of Labor Statistics reported today\") not found");
  const heading = which === "unemployment_rate" ? "Household Survey Data" : "Establishment Survey Data";
  const hi = paras.indexOf(heading);
  const section = hi >= 0 ? paras[hi + 1] ?? "" : "";
  // the header month, with no year or the header's year
  const isHeaderMonth = (mon: number, yr: string | null | undefined) => mon === month && (!yr || yr === year);
  const monthsIn = (s: string) => [...s.matchAll(MONTH_NAMES_RE)].map((x) => ({ mon: monthNumber(x[1]!), yr: x[2] }));
  const readings: Array<{ value: number; value_text: string; sentence: string; where: string }> = [];
  const others: string[] = [];
  for (const [where, para] of [["lead", lead], [heading, section]] as const) {
    if (!para) continue;
    if (which === "unemployment_rate") {
      for (const re of RATE_PATTERNS) {
        for (const m of para.matchAll(re)) {
          const sentence = sentenceAt(para, m.index!);
          // "4.1 percent in August" binds the rate to August whatever else the sentence names; without such a tie the
          // sentence must name the header month and no other month ("unchanged at 4.1 percent, ... in August" is August's)
          const tied = RATE_TIED.exec(para.slice(m.index! + m[0].length));
          const tiedMonth = tied ? monthNumber(tied[1]!) : 0;
          const named = monthsIn(sentence);
          const bound = tiedMonth ? isHeaderMonth(tiedMonth, tied![2]) : named.length > 0 && named.every((x) => isHeaderMonth(x.mon, x.yr));
          if (!bound) { others.push(sentence); continue; }
          readings.push({ value: Number(m[1]), value_text: m[1]!, sentence, where });
        }
      }
    } else {
      for (const p of PAYROLL_PATTERNS) {
        for (const m of para.matchAll(p.re)) {
          const sentence = sentenceAt(para, m.index!);
          const yr = YEAR_AFTER.exec(para.slice(m.index! + m[0].length))?.[1];
          if (!isHeaderMonth(monthNumber(m[p.month]!), yr)) { others.push(sentence); continue; }
          const down = (i: number) => new RegExp(`^(?:${PAYROLL_DOWN})$`).test(m[i]!);
          const sign = p.verb === undefined ? null : down(p.verb) ? -1 : 1;
          const k = payrollThousands(m[p.count]!, sign);
          if (typeof k === "string") return drift(`BLS Employment Situation payroll change unreadable: ${k} in "${sentence.slice(0, 160)}"`);
          if (p.checkVerb !== undefined && k !== 0 && (k < 0) !== down(p.checkVerb)) return drift(`BLS Employment Situation: "${m[p.checkVerb]}" contradicts the signed count ${m[p.count]} in "${sentence.slice(0, 160)}"`);
          readings.push({ value: k, value_text: String(k), sentence, where });
        }
      }
    }
  }
  const what = which === "unemployment_rate" ? "unemployment rate" : "nonfarm payroll change";
  if (!readings.length) return drift(`BLS Employment Situation: no ${what} sentence for ${monthName} in the lead or the ${heading} paragraph${others.length ? ` (only: ${others[0]!.slice(0, 120)})` : ""}`);
  const values = new Set(readings.map((r) => r.value));
  if (values.size !== 1) return drift(`BLS Employment Situation: the ${what} readings disagree (${readings.map((r) => `${r.where} ${r.value_text}`).join(", ")})`);
  if (which === "unemployment_rate" && others.some((s) => RATE_PATTERNS.some((re) => [...s.matchAll(re)].some((m) => m[1] !== readings[0]!.value_text)))) {
    return drift(`BLS Employment Situation: an unemployment rate sentence without ${monthName} states another value`);
  }
  const r = readings[0]!;
  const embargo = EMBARGO.exec(squash(raw.slice(0, h.index)));
  return { ok: true, obs: {
    period: `${h[2]}-${pad2(month)}`, value: r.value, value_text: r.value_text, deciding_text: `${header}: ${r.sentence}`, direction: null,
    meta: { unit: which === "payrolls_change" ? "thousands" : "percent", readings: readings.map((x) => x.where).join(" + "), embargoed_until: embargo ? squash(embargo[1]!) : null },
  } };
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
 * The latest ORDINARY Copom meeting date (BRT) in the history body, or null (not JSON, no rows). The admin probe
 * (src/ingest/official-probe.ts) reads the live document at this date with parseBcbHistory; the rail never calls it.
 */
export function latestOrdinaryCopomMeeting(json: string): string | null {
  let j: { conteudo?: CopomRow[] } | null;
  try { j = JSON.parse(json); } catch { return null; }
  if (!j || !Array.isArray(j.conteudo)) return null;
  const days = j.conteudo.filter((r) => r && r.ReuniaoExtraordinaria === false).map((r) => brtDate(r.DataReuniaoCopom)).filter((d): d is string => d !== null);
  return days.sort().pop() ?? null;
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

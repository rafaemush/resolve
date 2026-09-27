/**
 * Admin probe of the official_release sources (and the next election hosts) FROM THE WORKER: public Base RPCs answered
 * a laptop but refused Worker egress, and the rail had never fetched live from the Worker before its first release.
 * POST /internal/official/probe (src/api/internal.ts) runs it; runbook: docs/runbooks/official-probe.md.
 *
 * For each series it makes the rail's own requests for the LATEST PUBLISHED period: the same URLs (URLS,
 * OFFICIAL_SERIES.primaryUrl, blsApiUrl) through officialGet (the series allowlist, ResolveBot's UA, 8 s timeouts,
 * redirects checked by hand), then runs the rail's parsers on what came back. The latest period is read from the
 * document itself (a BLS page states its month; a feed or index lists its decisions and the newest one the parser
 * accepts is taken). When the primary observed a value, the corroboration is fetchCorroboration itself (the rail's
 * function, with its agree / disagree / unavailable answer); when it did not, the corroboration URL is still requested
 * once for reachability and its latest row reported. Election hosts are fixed constants below: nothing the caller
 * sends becomes a URL, and a redirect is followed only to a host on the same list.
 *
 * No database, no R2, no alert, no Telegram: the report is the only output. One failure never stops the others.
 * Subrequests: at most PROBE_MAX_SUBREQUESTS per call (redirect hops count), shared by every request of the call.
 * Every error and detail string in the report goes through clean(): a URL in it (the rail's own, or a redirect target
 * the upstream chose) is shown as host + path with its query as "?…", then redact() strips anything credential-shaped.
 * On the ET day of a scheduled BLS release (KNOWN_RELEASES) the BLS API v1 is not requested at all (blsApiHoldOn).
 */
import { KNOWN_RELEASES, OFFICIAL_SERIES, type CorroborationStatus, type OfficialSeriesId } from "../resolve/official";
import type { z } from "zod";
import {
  officialGet, fetchCorroboration, parseBlsSeries, budget, blsApiUrl, contentLength, BLS_API, URLS, OFFICIAL_UA, MAX_REDIRECTS,
  type Budget, type FetchTrace, type FetchedObservation,
} from "./official";
import {
  findFomcStatement, parseFomcStatement, findEcbDecision, parseEcbRelease, parseBoeRss, parseBokDecisionRss, parseBokGdpRss,
  parseBcbHistory, latestOrdinaryCopomMeeting, parseBlsApi, parseEcbDfrCsv, parseEcosRows, monthNumber, type DocObservation, type DocParse,
} from "./official-parse";
import { discardBody } from "./http";
import { redact } from "../ops/redact";

export const PROBE_GROUPS = ["bls", "central_banks", "elections"] as const;
export type ProbeGroup = (typeof PROBE_GROUPS)[number];

/** Subrequests one probe call may make, redirect hops included (Workers Free: 50 per invocation). */
export const PROBE_MAX_SUBREQUESTS = 40;
/** Wall clock for the whole call: every request's 8 s timeout is clamped to what is left of it. */
export const PROBE_DEADLINE_MS = 40_000;
/** Probe units run at once (a Worker holds at most 6 connections open; the rest would queue and inflate ms). */
const CONCURRENCY = 3;
/** Election bodies are counted, never parsed or kept; reading stops here. */
const ELECTION_BODY_CAP = 2 * 1024 * 1024;

/**
 * The election hosts the next rails would read. Constants only (SSRF-safe): the caller can choose the group, never a URL.
 * The TSE config path is the one the public results app requested in 2022 and 2024 (unverified for 2026: a 404 from
 * it still shows that the host answers the Worker).
 */
export const ELECTION_PROBES: ReadonlyArray<{ label: string; url: string }> = [
  { label: "TSE results site root", url: "https://resultados.tse.jus.br/" },
  { label: "TSE results app election config", url: "https://resultados.tse.jus.br/oficial/comum/config/ele-c.json" },
  { label: "Elections Quebec site root", url: "https://www.electionsquebec.qc.ca/" },
];
const ELECTION_HOSTS: ReadonlySet<string> = new Set(ELECTION_PROBES.map((p) => new URL(p.url).hostname));

const ALL_SERIES = Object.keys(OFFICIAL_SERIES) as OfficialSeriesId[];
const isBls = (s: OfficialSeriesId) => OFFICIAL_SERIES[s].hosts.includes("www.bls.gov");

/** The series a group covers: bls = every series read from www.bls.gov; central_banks = the rest; elections = none. */
export function seriesOfGroup(g: ProbeGroup): OfficialSeriesId[] {
  return g === "elections" ? [] : ALL_SERIES.filter((s) => (g === "bls") === isBls(s));
}

// ---- report shape -------------------------------------------------------------------------------------------------

/** bytes: a body that was read; content_length: the header of one that was dropped unread (a 3xx or non-200), when sent. */
export interface ProbeHop { host: string; path: string; status: number | null; content_type: string | null; server: string | null; bytes: number | null; content_length?: number; ms: number; location?: string; error?: string }
/** What the rail's parser read from one response: ok = it extracted a value (or, for a feed, found the document). */
export interface Readout { series: OfficialSeriesId; ok: boolean; period: string | null; value_text: string | null; detail: string | null }
export interface ProbeRequest {
  role: "primary" | "corroboration" | "election";
  label: string;
  series: OfficialSeriesId[];
  /** The URL requested first; path only (a query string is shown as "?…"). */
  host: string;
  path: string;
  /** From the last exchange (after redirects); ms is the sum over all of them. */
  status: number | null;
  bytes: number | null;
  /** The last exchange's Content-Length header when its body was dropped unread (a challenge page is several KB). */
  content_length: number | null;
  content_type: string | null;
  server: string | null;
  ms: number | null;
  redirects: number;
  hops: ProbeHop[];
  error: string | null;
  parsed: Readout[] | null;
}
export interface SeriesProbe {
  series: OfficialSeriesId;
  group: Exclude<ProbeGroup, "elections">;
  /** The latest period the primary document stated (null: none read). */
  period: string | null;
  primary: { ok: boolean; value_text: string | null; detail: string | null };
  corroboration: { status: z.infer<typeof CorroborationStatus> | "reachability_only" | "skipped" | "error"; value_text: string | null; detail: string | null };
}
export interface HostSummary { requests: number; statuses: Array<number | null>; answered_200: boolean }
export interface ProbeReport {
  groups: ProbeGroup[];
  series: OfficialSeriesId[];
  corroboration: boolean;
  /** Why the BLS API v1 was not requested (a BLS release day, ET), or null. */
  bls_api_hold: string | null;
  user_agent: string;
  subrequests: { cap: number; planned: number; used: number };
  duration_ms: number;
  hosts: Record<string, HostSummary>;
  series_results: SeriesProbe[];
  requests: ProbeRequest[];
}

/** blsApiHold: why the BLS API v1 is not requested by this plan (blsApiHoldOn), or null. */
export interface ProbePlan { groups: ProbeGroup[]; series: OfficialSeriesId[]; elections: boolean; corroboration: boolean; blsApiHold: string | null }

/**
 * body.series, else body.group, else everything. The series keep the registry's order. The route refuses a body with
 * neither (one group per call stays under the Workers Free CPU limit); the full plan is what the subrequest cap is
 * sized for. nowMs decides the BLS release-day hold.
 */
export function probePlan(body: { group?: ProbeGroup; series?: OfficialSeriesId[]; corroboration?: boolean }, nowMs: number = Date.now()): ProbePlan {
  const corroboration = body.corroboration ?? true;
  const blsApiHold = blsApiHoldOn(nowMs);
  if (body.series?.length) {
    const want = new Set(body.series);
    const series = ALL_SERIES.filter((s) => want.has(s));
    return { groups: [...new Set(series.map((s) => (isBls(s) ? "bls" : "central_banks") as ProbeGroup))], series, elections: false, corroboration, blsApiHold };
  }
  const groups: ProbeGroup[] = body.group ? [body.group] : [...PROBE_GROUPS];
  return { groups, series: groups.flatMap(seriesOfGroup), elections: groups.includes("elections"), corroboration, blsApiHold };
}

/** The America/New_York calendar day (YYYY-MM-DD) of an instant: BLS schedules its releases at 08:30 ET. */
export function etDay(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Why the probe must not request the BLS API v1 at nowMs, or null. Without a key it allows 25 queries a day, possibly
 * per shared Cloudflare egress IP, and on the ET day of a scheduled BLS release (any BLS series in KNOWN_RELEASES:
 * the quota is shared by all of them) those queries are the rail's corroboration: the probe leaves them alone.
 */
export function blsApiHoldOn(nowMs: number): string | null {
  const today = etDay(nowMs);
  const due = Object.entries(KNOWN_RELEASES).filter(([key, r]) => {
    const s = key.split(":")[0] as OfficialSeriesId;
    return s in OFFICIAL_SERIES && isBls(s) && etDay(Date.parse(r.release_at)) === today;
  });
  if (!due.length) return null;
  const at = [...new Set(due.map(([, r]) => r.release_at))].join(", ");
  return `BLS release day ${today} (ET): ${due.map(([k]) => k).join(", ")} scheduled ${at}; the BLS API v1's 25 key-less queries a day are left to the rail, so it was not requested`;
}

/** Why the route refuses the plan (more requests than the cap before redirects), or null. cap exists for tests. */
export function probeRefusal(plan: ProbePlan, cap: number = PROBE_MAX_SUBREQUESTS): string | null {
  const planned = plannedRequests(plan);
  return planned > cap ? `this probe needs up to ${planned} requests before redirects (cap ${cap}): narrow it with group (${PROBE_GROUPS.join(" | ")}) or fewer series` : null;
}

// ---- units ----------------------------------------------------------------------------------------------------------

interface UnitOut { requests: ProbeRequest[]; results: SeriesProbe[] }
interface Unit { cost: number; series: OfficialSeriesId[]; run: (b: Budget) => Promise<UnitOut> }
type Got = Awaited<ReturnType<typeof officialGet>>;

/**
 * Primary requests of the central banks that need more than one: the FOMC feed then the statement; the ECB index, the
 * previous year's index when the current one names no decision yet (1 January to the first meeting), then the release.
 */
const PRIMARY_REQUESTS: Partial<Record<OfficialSeriesId, number>> = { fomc_upper_bound: 2, ecb_dfr: 3 };
const corroborates = (s: OfficialSeriesId) => OFFICIAL_SERIES[s].corroboration === "when_available";

/**
 * The probe units of a plan with the most requests each can make before redirects: one per BLS document, per other
 * series, per election URL, plus the corroborations (none from the BLS API on a BLS release day).
 */
export function probeUnits(plan: ProbePlan): Unit[] {
  const units: Unit[] = [];
  const docs = new Map<string, OfficialSeriesId[]>();
  for (const s of plan.series.filter(isBls)) {
    const url = OFFICIAL_SERIES[s].primaryUrl;
    docs.set(url, [...(docs.get(url) ?? []), s]);
  }
  for (const [url, list] of docs) {
    units.push({ cost: 1 + (plan.corroboration && !plan.blsApiHold ? list.filter(corroborates).length : 0), series: list, run: (b) => blsDocUnit(b, url, list, plan) });
  }
  for (const s of plan.series.filter((x) => !isBls(x))) {
    units.push({ cost: (PRIMARY_REQUESTS[s] ?? 1) + (plan.corroboration && corroborates(s) ? 1 : 0), series: [s], run: (b) => centralBankUnit(b, s, plan) });
  }
  if (plan.elections) for (const p of ELECTION_PROBES) units.push({ cost: 1, series: [], run: async (b) => ({ requests: [await electionGet(b, p)], results: [] }) });
  return units;
}

export function plannedRequests(plan: ProbePlan): number { return probeUnits(plan).reduce((n, u) => n + u.cost, 0); }

/**
 * Run the plan. Never throws: a unit that throws is reported as its series' error. maxSubrequests exists for tests;
 * the route always passes PROBE_MAX_SUBREQUESTS.
 */
export async function runOfficialProbe(plan: ProbePlan, opts: { maxSubrequests?: number; now?: () => number } = {}): Promise<ProbeReport> {
  const now = opts.now ?? Date.now;
  const cap = opts.maxSubrequests ?? PROBE_MAX_SUBREQUESTS;
  const t0 = Date.now();
  const b = budget(now, PROBE_DEADLINE_MS, cap);
  const units = probeUnits(plan);
  const outs = await pool(units.map((u) => async (): Promise<UnitOut> => {
    try { return await u.run(b); }
    catch (e) {
      const detail = clean(`probe threw: ${String(e).slice(0, 200)}`);
      return { requests: [], results: u.series.map((s) => ({ series: s, group: isBls(s) ? "bls" : "central_banks", period: null, primary: { ok: false, value_text: null, detail }, corroboration: { status: "error", value_text: null, detail } })) };
    }
  }), CONCURRENCY);
  const requests = outs.flatMap((o) => o.requests);
  const byName = new Map(outs.flatMap((o) => o.results).map((r) => [r.series, r]));
  return {
    groups: plan.groups, series: plan.series, corroboration: plan.corroboration, bls_api_hold: plan.blsApiHold, user_agent: OFFICIAL_UA,
    subrequests: { cap, planned: units.reduce((n, u) => n + u.cost, 0), used: b.used },
    duration_ms: Date.now() - t0,
    hosts: hostSummary(requests),
    series_results: plan.series.map((s) => byName.get(s)!).filter(Boolean),
    requests,
  };
}

async function pool<T>(tasks: Array<() => Promise<T>>, n: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (next < tasks.length) { const k = next++; out[k] = await tasks[k]!(); }
  }));
  return out;
}

function hostSummary(requests: ProbeRequest[]): Record<string, HostSummary> {
  const out: Record<string, HostSummary> = {};
  for (const r of requests) {
    for (const h of r.hops) {
      const s = (out[h.host] ??= { requests: 0, statuses: [], answered_200: false });
      s.requests++; s.statuses.push(h.status);
      if (h.status === 200) s.answered_200 = true;
    }
  }
  return out;
}

// ---- requests -------------------------------------------------------------------------------------------------------

/** host and path of a URL; the query is never echoed (shown as "?…"). */
function where(url: string): { host: string; path: string } {
  try { const u = new URL(url); return { host: u.hostname, path: u.pathname + (u.search ? "?…" : "") }; }
  catch { return { host: "(unparseable)", path: "" }; }
}

/** A URL inside a text (any scheme). Trailing punctuation the message put after it is peeled off in clean(). */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/**
 * Every error and detail string the report carries: officialGet and fetchCorroboration name the URL they requested
 * ("HTTP 403 from <url>", "<url> redirected off the allowlist to <Location>"), and a redirect target is the upstream's
 * choice (a login page with ?token=…). Each URL becomes host + path with its query as "?…", then redact() runs.
 */
export function clean(text: string): string {
  const shown = text.replace(URL_IN_TEXT, (m) => {
    const tail = /[.,;:)\]]+$/.exec(m)?.[0] ?? "";
    const w = where(m.slice(0, m.length - tail.length));
    return (w.host === "(unparseable)" ? "(url)" : `${w.host}${w.path}`) + tail;
  });
  return redact(shown);
}

/** A Location header as host + path (resolved against the URL that sent it); never throws. */
function locationOf(location: string, base: string): string {
  let href: string;
  try { href = new URL(location, base).href; } catch { return "(unreadable)"; }
  const l = where(href);
  return l.host + l.path;
}

const hopOf = (t: FetchTrace): ProbeHop => ({
  ...where(t.url), status: t.status, content_type: t.content_type, server: t.server, bytes: t.bytes,
  ...(t.content_length !== undefined ? { content_length: t.content_length } : {}), ms: t.ms,
  ...(t.location !== undefined ? { location: locationOf(t.location, t.url) } : {}),
  ...(t.error !== undefined ? { error: clean(t.error) } : {}),
});

function request(role: ProbeRequest["role"], label: string, series: OfficialSeriesId[], url: string, traces: FetchTrace[], error: string | null): ProbeRequest {
  const hops = traces.map(hopOf);
  const last = hops.at(-1);
  return {
    role, label, series, ...where(url),
    status: last?.status ?? null, bytes: last?.bytes ?? null, content_length: last?.content_length ?? null, content_type: last?.content_type ?? null, server: last?.server ?? null,
    ms: hops.length ? hops.reduce((n, h) => n + h.ms, 0) : null,
    redirects: hops.filter((h) => h.status !== null && h.status >= 300 && h.status <= 399).length,
    hops, error: error === null ? null : clean(error), parsed: null,
  };
}

/** The budget of one logical request: the call's shared counters, with this request's own trace sink. */
function traced(parent: Budget, sink: FetchTrace[]): Budget {
  return {
    deadlineMs: parent.deadlineMs, now: parent.now, timeouts: parent.timeouts,
    get requests() { return parent.requests; }, set requests(v: number) { parent.requests = v; },
    get used() { return parent.used; }, set used(v: number) { parent.used = v; },
    trace: (t) => sink.push(t),
  };
}

/** officialGet with its exchanges recorded; never throws. */
async function probeGet(b: Budget, series: OfficialSeriesId, url: string, accept: string, role: ProbeRequest["role"], label: string, list: OfficialSeriesId[]): Promise<{ got: Got | null; req: ProbeRequest }> {
  const sink: FetchTrace[] = [];
  let got: Got | null = null;
  let error: string | null = null;
  try { got = await officialGet(series, url, traced(b, sink), accept); if (!got.ok) error = got.error; }
  catch (e) { error = `threw: ${String(e).slice(0, 200)}`; }
  return { got, req: request(role, label, list, url, sink, error) };
}

/**
 * What the parser read. A feed item's pubDate leads the detail (BoE, BoK): for the BoE it is the period itself, and the
 * operator compares it with the scheduled decision day (the rail answers pending unless the two are equal).
 */
const readout = (series: OfficialSeriesId, p: DocParse): Readout => {
  if (!p.ok) return { series, ok: false, period: null, value_text: null, detail: clean(`${p.reason}: ${p.detail}`).slice(0, 300) };
  const pub = typeof p.obs.meta?.pub_date === "string" && p.obs.meta.pub_date ? `pubDate ${p.obs.meta.pub_date}; ` : "";
  return { series, ok: true, period: p.obs.period, value_text: p.obs.value_text, detail: clean(`${pub}${p.obs.deciding_text}`).slice(0, 300) };
};
const failedRead = (series: OfficialSeriesId, detail: string): Readout => ({ series, ok: false, period: null, value_text: null, detail: clean(detail).slice(0, 300) });

const asObs = (series: OfficialSeriesId, o: DocObservation, g: Extract<Got, { ok: true }>, b: Budget): FetchedObservation =>
  ({ ...o, series, source_url: g.url, raw: g.bytes, raw_sha256: "(probe: not stored)", fetched_at: new Date(b.now()).toISOString() });

/**
 * The first candidate (newest first) the parser gives a definite answer for: a value, or schema drift (which must be
 * reported, never skipped past). null when there are no candidates.
 */
function firstDecisive<T extends { ok: boolean; reason?: string }>(candidates: string[], parse: (c: string) => T): { target: string; r: T } | null {
  let last: { target: string; r: T } | null = null;
  for (const c of candidates) {
    last = { target: c, r: parse(c) };
    if (last.r.ok || last.r.reason === "schema_drift") return last;
  }
  return last;
}
const newestFirst = (xs: string[]) => [...new Set(xs)].sort().reverse();

// ---- corroboration --------------------------------------------------------------------------------------------------

/**
 * With an observation: the rail's fetchCorroboration for (series, period). Without one: the corroboration URL the rail
 * would request, fetched once for reachability, with the latest row its parser reads.
 */
async function corroborate(b: Budget, s: OfficialSeriesId, obs: FetchedObservation | null, plan: ProbePlan): Promise<{ req: ProbeRequest | null; summary: SeriesProbe["corroboration"] }> {
  if (!plan.corroboration) return { req: null, summary: { status: "skipped", value_text: null, detail: "corroboration: false" } };
  if (!corroborates(s)) return { req: null, summary: { status: "single_source", value_text: null, detail: "no corroborating source for this series (by design); nothing requested" } };
  if (plan.blsApiHold && s in BLS_API) return { req: null, summary: { status: "skipped", value_text: null, detail: plan.blsApiHold } };
  if (obs) {
    const sink: FetchTrace[] = [];
    try {
      const c = await fetchCorroboration(obs, obs.period, traced(b, sink));
      const url = sink[0]?.url ?? c.source_url;
      const req = url ? request("corroboration", `${s} corroboration`, [s], url, sink, sink.at(-1)?.status === 200 ? null : c.detail) : null;
      if (req) req.parsed = [{ series: s, ok: c.value_text !== null, period: obs.period, value_text: c.value_text, detail: clean(`${c.status}: ${c.detail}`).slice(0, 300) }];
      return { req, summary: { status: c.status, value_text: c.value_text, detail: clean(c.detail) } };
    } catch (e) {
      const detail = clean(`threw: ${String(e).slice(0, 200)}`);
      return { req: sink.length ? request("corroboration", `${s} corroboration`, [s], sink[0]!.url, sink, detail) : null, summary: { status: "error", value_text: null, detail } };
    }
  }
  const reach = reachability(s, b.now());
  if (!reach) return { req: null, summary: { status: "skipped", value_text: null, detail: "no corroboration URL without a target period" } };
  const { got, req } = await probeGet(b, s, reach.url, reach.accept, "corroboration", `${s} corroboration (reachability only: the primary gave no observation)`, [s]);
  let r: Readout;
  try { r = got?.ok ? reach.read(got.text) : failedRead(s, req.error ?? "not fetched"); }
  catch (e) { r = failedRead(s, `parser threw: ${String(e)}`); }
  if (got?.ok) req.parsed = [r];
  return { req, summary: { status: "reachability_only", value_text: r.value_text, detail: r.ok ? `latest row ${r.period} = ${r.value_text} (not compared: no primary observation)` : r.detail } };
}

const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ymdOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The last line of a two-column CSV whose second field is a number (FRED, IADB): its first field and value. */
function lastCsvRow(csv: string): { period: string; value: string } | null {
  const lines = csv.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i > 0; i--) {
    const [d, v] = lines[i]!.split(",").map((x) => x.trim());
    if (d && v && /^[+-]?\d+(?:\.\d+)?$/.test(v)) return { period: d, value: v };
  }
  return null;
}

function reachability(s: OfficialSeriesId, nowMs: number): { url: string; accept: string; read: (text: string) => Readout } | null {
  const row = (period: string | null, value: string | null, what: string): Readout =>
    period && value ? { series: s, ok: true, period, value_text: value, detail: what } : failedRead(s, `${what}: no readable row`);
  if (s in BLS_API) {
    const id = BLS_API[s as keyof typeof BLS_API].id;
    return { url: blsApiUrl(id), accept: "application/json", read: (t) => { const p = parseBlsApi(t, id); return p.ok ? row(p.latest, p.latest ? p.index.get(p.latest) ?? null : null, `BLS API ${id}`) : failedRead(s, `BLS API: ${p.detail}`); } };
  }
  switch (s) {
    case "fomc_upper_bound": return { url: URLS.fred, accept: "text/csv", read: (t) => { const r = lastCsvRow(t); return row(r?.period ?? null, r?.value ?? null, "FRED DFEDTARU"); } };
    case "ecb_dfr": return { url: URLS.ecbDfr, accept: "text/csv", read: (t) => { const r = parseEcbDfrCsv(t).at(-1); return row(r?.date ?? null, r?.value ?? null, "ECB DFR"); } };
    case "boe_bank_rate": {
      const d = new Date(nowMs); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 3);
      return { url: URLS.boeIadb(`01/${MON3[d.getUTCMonth()]}/${d.getUTCFullYear()}`), accept: "text/csv", read: (t) => { const r = lastCsvRow(t); return row(r?.period ?? null, r?.value ?? null, "BoE IADB IUDBEDR"); } };
    }
    case "bok_base_rate": {
      const ymd = ymdOf(nowMs - 5 * 86_400_000).replace(/-/g, "");
      return { url: URLS.ecosBaseRate(ymd), accept: "application/json", read: (t) => { const p = parseEcosRows(t); if (!p.ok) return failedRead(s, p.detail); const r = p.rows.at(-1); return row(r?.time ?? null, r?.value ?? null, `ECOS 722Y001 ${ymd}`); } };
    }
    case "kr_gdp_advance_yoy": {
      const d = new Date(nowMs); const q = Math.floor(d.getUTCMonth() / 3); // the quarter before the current one
      const quarter = q === 0 ? `${d.getUTCFullYear() - 1}Q4` : `${d.getUTCFullYear()}Q${q}`;
      return { url: URLS.ecosGdp(quarter), accept: "application/json", read: (t) => { const p = parseEcosRows(t); if (!p.ok) return failedRead(s, p.detail); const r = p.rows.at(-1); return row(r?.time ?? null, r?.value ?? null, `ECOS 200Y102 ${quarter}`); } };
    }
    default: return null;
  }
}

// ---- BLS: one document per fetch group ----------------------------------------------------------------------------

async function blsDocUnit(b: Budget, url: string, list: OfficialSeriesId[], plan: ProbePlan): Promise<UnitOut> {
  const label = `${OFFICIAL_SERIES[list[0]!].fetchGroup ?? list[0]}: BLS release page`;
  const { got, req } = await probeGet(b, list[0]!, url, "text/html", "primary", label, list);
  const requests = [req];
  const reads = new Map<OfficialSeriesId, { r: Readout; obs: FetchedObservation | null }>();
  if (got?.ok) {
    req.parsed = [];
    for (const s of list) {
      let r: Readout, obs: FetchedObservation | null = null;
      try {
        const p = parseBlsSeries(s, got.text);
        r = p ? readout(s, p) : failedRead(s, "no parser for this document");
        if (p?.ok) obs = asObs(s, p.obs, got, b);
      } catch (e) { r = failedRead(s, `parser threw: ${String(e)}`); }
      req.parsed.push(r);
      reads.set(s, { r, obs });
    }
  }
  const results: SeriesProbe[] = [];
  for (const s of list) {
    const read = reads.get(s);
    const c = await corroborate(b, s, read?.obs ?? null, plan);
    if (c.req) requests.push(c.req);
    results.push({
      series: s, group: "bls", period: read?.r.period ?? null,
      primary: read ? { ok: read.r.ok, value_text: read.r.value_text, detail: read.r.detail } : { ok: false, value_text: null, detail: req.error },
      corroboration: c.summary,
    });
  }
  return { requests, results };
}

// ---- central banks: discover the latest decision in the feed or index, then the rail's parser ---------------------------

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_RE = MONTH_NAMES.join("|");
const ORDINAL_Q: Record<string, number> = { First: 1, Second: 2, Third: 3, Fourth: 4 };
const isoDay = (y: string, month: number, d: string) => `${y}-${String(month).padStart(2, "0")}-${d.padStart(2, "0")}`;

/** Up to `max` matches of a global regex, mapped (a feed is newest first, so the first few are the ones that matter). */
function firstMatches(text: string, re: RegExp, max: number, map: (m: RegExpExecArray) => string | null): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m && out.length < max; m = re.exec(text)) { const v = map(m); if (v) out.push(v); }
  return out;
}

async function centralBankUnit(b: Budget, s: OfficialSeriesId, plan: ProbePlan): Promise<UnitOut> {
  const requests: ProbeRequest[] = [];
  let primary: Readout = failedRead(s, "not fetched");
  let obs: FetchedObservation | null = null;
  const get = async (url: string, accept: string, label: string) => { const r = await probeGet(b, s, url, accept, "primary", label, [s]); requests.push(r.req); return r; };
  /** The rail's settle(): a document about another period than the one asked for is "pending", never a value. */
  const settle = (target: string, p: DocParse, g: Extract<Got, { ok: true }>, req: ProbeRequest) => {
    primary = readout(s, p);
    if (p.ok && p.obs.period !== target) primary = { ...primary, ok: false, detail: `the document is about ${p.obs.period}, not ${target} (the rail would answer pending)` };
    else if (p.ok) obs = asObs(s, p.obs, g, b);
    req.parsed = [primary];
  };
  /** A feed or index that names no decision: what it said, reported on the feed's own request. */
  const indexRead = (req: ProbeRequest, found: { target: string; r: { ok: boolean; detail?: string; url?: string } } | null, what: string) => {
    const r: Readout = found?.r.ok
      ? { series: s, ok: true, period: found.target, value_text: null, detail: `${what} for ${found.target}${found.r.url ? `: ${where(found.r.url).path}` : ""}` }
      : failedRead(s, found ? `${found.target}: ${found.r.detail ?? "not found"}` : `no ${what} named in the document`);
    req.parsed = [r];
    if (!r.ok) primary = r;
  };

  switch (s) {
    case "fomc_upper_bound": {
      const rss = await get(URLS.fedRss, "application/rss+xml, text/xml", "Fed monetary press RSS");
      if (!rss.got?.ok) { primary = failedRead(s, rss.req.error ?? "not fetched"); break; }
      const text = rss.got.text;
      const days = newestFirst(firstMatches(text, /\/monetary(\d{4})(\d{2})(\d{2})a\.htm/g, 20, (m) => `${m[1]}-${m[2]}-${m[3]}`));
      const f = firstDecisive(days, (d) => findFomcStatement(text, d));
      indexRead(rss.req, f, "FOMC statement");
      if (!f?.r.ok) break;
      const st = await get(f.r.url, "text/html", "FOMC statement");
      if (st.got?.ok) settle(f.target, parseFomcStatement(st.got.text), st.got, st.req); else primary = failedRead(s, st.req.error ?? "not fetched");
      break;
    }
    case "ecb_dfr": {
      // The rail reads the index of the target's year. From 1 January to the year's first meeting the current year's
      // index is missing (404) or names no decision yet, so the previous year's is read once (PRIMARY_REQUESTS counts it).
      const thisYear = new Date(b.now()).getUTCFullYear();
      for (const year of [thisYear, thisYear - 1]) {
        const idx = await get(URLS.ecbIndex(String(year)), "text/html", `ECB monetary policy decisions index ${year}`);
        const current = year === thisYear;
        if (!idx.got?.ok) {
          primary = failedRead(s, idx.req.error ?? "not fetched");
          if (current && idx.got && !idx.got.ok && idx.got.httpStatus === 404) continue;
          break;
        }
        const text = idx.got.text;
        const days = newestFirst(firstMatches(text, /isoDate="(\d{4}-\d{2}-\d{2})"/g, 60, (m) => m[1]!));
        const f = firstDecisive(days, (d) => findEcbDecision(text, d));
        indexRead(idx.req, f, "Monetary policy decisions release");
        // no decision this year yet: the previous year's index; drift is reported, never skipped past
        if (!f) { if (current) continue; break; }
        if (!f.r.ok) { if (current && f.r.reason === "not_published") continue; break; }
        const rel = await get(f.r.url, "text/html", "ECB monetary policy decisions release");
        if (rel.got?.ok) settle(f.target, parseEcbRelease(rel.got.text), rel.got, rel.req); else primary = failedRead(s, rel.req.error ?? "not fetched");
        break;
      }
      break;
    }
    case "boe_bank_rate": {
      const g = await get(URLS.boeRss, "application/rss+xml, text/xml", "BoE news RSS");
      if (!g.got?.ok) { primary = failedRead(s, g.req.error ?? "not fetched"); break; }
      const text = g.got.text;
      // "<Month YYYY> Monetary Policy Summary" titles, newest first by (year, month)
      const months = [...new Set(firstMatches(text, new RegExp(String.raw`\b(${MONTHS_RE}) (\d{4}) Monetary Policy Summary`, "gi"), 20, (m) => `${m[2]}-${String(monthNumber(m[1]!)).padStart(2, "0")}`))].sort().reverse();
      const f = firstDecisive(months, (ym) => parseBoeRss(text, `${MONTH_NAMES[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`));
      if (!f) { primary = failedRead(s, "no Monetary Policy Summary item in the feed"); g.req.parsed = [primary]; break; }
      // The item is matched by month and its pubDate becomes the period. The probe cannot know the scheduled decision
      // day, so this period gate passes by construction; the rail's (settle(target) with the market's day) does not.
      // The readout leads with the pubDate: the operator checks it against the MPC date (runbook, "Reading the answer").
      settle(f.r.ok ? f.r.obs.period : f.target, f.r, g.got, g.req);
      break;
    }
    case "bok_base_rate": {
      const g = await get(URLS.bokRss, "application/rss+xml, application/xml", "BoK Monetary Policy Decision RSS");
      if (!g.got?.ok) { primary = failedRead(s, g.req.error ?? "not fetched"); break; }
      const text = g.got.text;
      const days = newestFirst(firstMatches(text, new RegExp(String.raw`Monetary Policy Decision[^<]{0,200}?\(\s*(${MONTHS_RE}) (\d{1,2}), (\d{4})\)`, "g"), 6, (m) => isoDay(m[3]!, monthNumber(m[1]!), m[2]!)));
      const f = firstDecisive(days, (d) => parseBokDecisionRss(text, d));
      if (!f) { primary = failedRead(s, "no dated Monetary Policy Decision item in the feed"); g.req.parsed = [primary]; break; }
      settle(f.target, f.r, g.got, g.req);
      break;
    }
    case "kr_gdp_advance_yoy": {
      const g = await get(URLS.bokPressRss, "application/rss+xml, application/xml", "BoK press release RSS");
      if (!g.got?.ok) { primary = failedRead(s, g.req.error ?? "not fetched"); break; }
      const text = g.got.text;
      const quarters = newestFirst(firstMatches(text, /Real Gross Domestic Product: (First|Second|Third|Fourth) Quarter of (\d{4}) \(Advance Estimate\)/g, 8, (m) => `${m[2]}-Q${ORDINAL_Q[m[1]!]}`));
      const f = firstDecisive(quarters, (q) => parseBokGdpRss(text, q));
      if (!f) { primary = failedRead(s, "no advance-estimate item in the feed"); g.req.parsed = [primary]; break; }
      settle(f.target, f.r, g.got, g.req);
      break;
    }
    case "bcb_selic_target": {
      const g = await get(URLS.bcbHistory, "application/json", "BCB Copom history");
      if (!g.got?.ok) { primary = failedRead(s, g.req.error ?? "not fetched"); break; }
      const day = latestOrdinaryCopomMeeting(g.got.text);
      if (!day) { primary = failedRead(s, "no ordinary Copom meeting in the body"); g.req.parsed = [primary]; break; }
      settle(day, parseBcbHistory(g.got.text, day), g.got, g.req);
      break;
    }
    default: primary = failedRead(s, "not a central-bank series");
  }

  const c = await corroborate(b, s, obs, plan);
  if (c.req) requests.push(c.req);
  const p: Readout = primary;
  return { requests, results: [{ series: s, group: "central_banks", period: p.period, primary: { ok: p.ok, value_text: p.value_text, detail: p.detail }, corroboration: c.summary }] };
}

// ---- elections ------------------------------------------------------------------------------------------------------

/** Bytes of a body, read and dropped chunk by chunk (never buffered), up to `cap`. */
async function countBytes(res: Response, cap: number): Promise<number> {
  if (!res.body) return 0;
  const reader = res.body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) { await reader.cancel().catch(() => undefined); break; }
  }
  return n;
}

/**
 * One GET of a constant election URL under the same rules as officialGet: https only, the host on ELECTION_HOSTS,
 * redirects by hand (each Location checked before it is requested), the shared request and time budget. The body is
 * counted, never parsed.
 */
async function electionGet(b: Budget, p: { label: string; url: string }): Promise<ProbeRequest> {
  const sink: FetchTrace[] = [];
  let current = p.url;
  let error: string | null = null;
  for (let hop = 0; ; hop++) {
    let u: URL;
    try { u = new URL(current); } catch { error = "unreadable URL"; break; }
    if (u.protocol !== "https:" || !ELECTION_HOSTS.has(u.hostname)) { error = `refused: ${u.hostname} is not an https host on the election probe list; not requested`; break; }
    if (b.requests <= 0) { error = "request budget exhausted"; break; }
    const remaining = b.deadlineMs - b.now();
    if (remaining < 500) { error = "time budget exhausted"; break; }
    b.requests--; b.used++;
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(current, { headers: { "User-Agent": OFFICIAL_UA, Accept: "text/html, application/json;q=0.9, */*;q=0.8", "Cache-Control": "no-cache" }, redirect: "manual", signal: AbortSignal.timeout(Math.min(8000, remaining)) });
    } catch (e) {
      error = `fetch failed: ${String(e).slice(0, 120)}`;
      sink.push({ url: current, status: null, content_type: null, server: null, bytes: null, ms: Date.now() - t0, error });
      break;
    }
    const head = { url: current, status: res.status, content_type: res.headers.get("content-type"), server: res.headers.get("server") };
    if (res.status >= 300 && res.status <= 399) {
      const location = res.headers.get("location");
      await discardBody(res);
      const cl = contentLength(res.headers);
      sink.push({ ...head, bytes: null, ...(cl !== undefined ? { content_length: cl } : {}), ms: Date.now() - t0, ...(location ? { location } : {}) });
      if (!location) { error = `HTTP ${res.status} without a Location`; break; }
      try { current = new URL(location, current).href; } catch { error = `HTTP ${res.status} with an unreadable Location`; break; }
      if (hop >= MAX_REDIRECTS) { error = `more than ${MAX_REDIRECTS} redirects`; break; }
      continue;
    }
    try {
      const bytes = await countBytes(res, ELECTION_BODY_CAP);
      sink.push({ ...head, bytes, ms: Date.now() - t0 });
    } catch (e) {
      error = `body: ${String(e).slice(0, 120)}`;
      sink.push({ ...head, bytes: null, ms: Date.now() - t0, error });
    }
    if (!error && res.status !== 200) error = `HTTP ${res.status}`;
    break;
  }
  return request("election", p.label, [], p.url, sink, error);
}

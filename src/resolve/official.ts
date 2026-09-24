/**
 * official_release: binary legs of ladders that settle on one scheduled official number (US CPI/PPI 12-month change,
 * FOMC upper bound, ECB deposit facility rate, BoE Bank Rate, BoK Base Rate, Korea GDP advance YoY, BCB Selic).
 * The rail fetches the named source itself (src/ingest/official.ts), stores the FIRST PRINT once per (series, period)
 * in official_observations (migration 016), and every leg decides from that stored row in code. Jev is never called.
 * A leg resolves Yes iff the decided value falls in its bucket, else No: a "No" is a positive determination that the
 * value fell in a different bucket, never an absence.
 * Pure: no I/O. Imported by the resolver, the ingestion adapters, registration, the leg builder and the evals.
 */
import { z } from "zod";
import { OfficialSeries, type OfficialBucket, type EvidenceInput, type MarketRegistration, type Resolver } from "./schema";
import type { StructuredDecision } from "./structured";
import { railEnabled } from "./rails";

export type OfficialSeriesId = z.infer<typeof OfficialSeries>;
export type OfficialRoundingRule = Extract<Resolver, { kind: "official_release" }>["rounding"];
export type OfficialResolver = Extract<Resolver, { kind: "official_release" }>;

// ---- series registry ----------------------------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const ORDINALS = ["First", "Second", "Third", "Fourth"] as const;

export interface SeriesDef {
  id: OfficialSeriesId;
  label: string;
  /** percent: the 12-month change as published (1 dp). rate_change_bps: the new level minus prior_level, in bps. */
  decides: "percent" | "rate_change_bps";
  /** The rounding the market texts for this series prescribe (research 2026-09-24). */
  rounding: OfficialRoundingRule;
  period: "month" | "quarter" | "day";
  /** Every host the adapter may request for this series (primary + corroboration). Anything else is refused. */
  hosts: readonly string[];
  /** The primary document, named in evidence when the release was not observed. */
  primaryUrl: string;
  /** when_available: a second official source is compared once it has the number; none: single-source by design. */
  corroboration: "when_available" | "none";
}

export const OFFICIAL_SERIES: Record<OfficialSeriesId, SeriesDef> = {
  us_cpi_u_nsa_yoy: { id: "us_cpi_u_nsa_yoy", label: "US CPI-U all items, 12-month change before seasonal adjustment (BLS)", decides: "percent", rounding: "pct_1dp", period: "month", hosts: ["www.bls.gov", "api.bls.gov"], primaryUrl: "https://www.bls.gov/news.release/cpi.nr0.htm", corroboration: "when_available" },
  us_ppi_fd_nsa_yoy: { id: "us_ppi_fd_nsa_yoy", label: "US PPI final demand, 12-month change before seasonal adjustment (BLS)", decides: "percent", rounding: "pct_1dp", period: "month", hosts: ["www.bls.gov", "api.bls.gov"], primaryUrl: "https://www.bls.gov/news.release/ppi.nr0.htm", corroboration: "when_available" },
  fomc_upper_bound: { id: "fomc_upper_bound", label: "FOMC target range upper bound (Federal Reserve statement)", decides: "rate_change_bps", rounding: "bps_away_from_zero_25", period: "day", hosts: ["www.federalreserve.gov", "fred.stlouisfed.org"], primaryUrl: "https://www.federalreserve.gov/feeds/press_monetary.xml", corroboration: "when_available" },
  ecb_dfr: { id: "ecb_dfr", label: "ECB deposit facility rate (Monetary policy decisions release)", decides: "rate_change_bps", rounding: "bps_nearest_25_min_25", period: "day", hosts: ["www.ecb.europa.eu", "data-api.ecb.europa.eu"], primaryUrl: "https://www.ecb.europa.eu/press/govcdec/mopo/html/index.en.html", corroboration: "when_available" },
  boe_bank_rate: { id: "boe_bank_rate", label: "Bank of England Bank Rate (Monetary Policy Summary)", decides: "rate_change_bps", rounding: "bps_nearest_25_min_25", period: "day", hosts: ["www.bankofengland.co.uk"], primaryUrl: "https://www.bankofengland.co.uk/rss/news", corroboration: "when_available" },
  bok_base_rate: { id: "bok_base_rate", label: "Bank of Korea Base Rate (Monetary Policy Decision)", decides: "rate_change_bps", rounding: "bps_nearest_25_min_25", period: "day", hosts: ["www.bok.or.kr", "ecos.bok.or.kr"], primaryUrl: "https://www.bok.or.kr/eng/bbs/E0000627/news.rss?menuNo=400022", corroboration: "when_available" },
  kr_gdp_advance_yoy: { id: "kr_gdp_advance_yoy", label: "Korea real GDP, year-on-year change, advance estimate (Bank of Korea)", decides: "percent", rounding: "pct_1dp", period: "quarter", hosts: ["www.bok.or.kr", "ecos.bok.or.kr"], primaryUrl: "https://www.bok.or.kr/eng/bbs/E0000634/news.rss?menuNo=400069", corroboration: "when_available" },
  // SGS series 432 forward-fills future dates with the current target (a documented trap), so it cannot corroborate
  // a decision before its effective date; the Copom history row for the meeting is the only source.
  bcb_selic_target: { id: "bcb_selic_target", label: "Banco Central do Brasil Selic target (Copom history)", decides: "rate_change_bps", rounding: "bps_nearest_25_min_25", period: "day", hosts: ["www.bcb.gov.br"], primaryUrl: "https://www.bcb.gov.br/api/servico/sitebcb/historicotaxasjuros", corroboration: "none" },
};

/** Series that exist as markets but have no deterministic adapter, with the reason registration refuses them. */
export const UNSUPPORTED_OFFICIAL_SERIES: Record<string, string> = {
  boj_policy_rate: "official source is PDF-only",
};

export function seriesDef(id: OfficialSeriesId): SeriesDef { return OFFICIAL_SERIES[id]; }

/**
 * The scheduled publication of each event the rail is registered for (research 2026-09-24). release_at belongs to the
 * (series, period), never to a registration: every leg of every market reads the same first print, so a market
 * registered with an earlier release_at could otherwise record a first print that a market with a later one would
 * refuse forever. Registration refuses a differing release_at for these events. fallback_until: the market texts'
 * fallback when the source does not publish (the next scheduled release or meeting), when the text names one.
 */
export interface KnownRelease { release_at: string; fallback_until: string | null; basis: string }
export const KNOWN_RELEASES: Record<string, KnownRelease> = {
  "us_cpi_u_nsa_yoy:2026-09": { release_at: "2026-10-14T12:30:00Z", fallback_until: "2026-11-10T13:30:00Z", basis: "BLS CPI schedule: September 2026 -> Oct. 14, 2026 08:30 ET; the market then waits for the next CPI release, Nov. 10, 2026 08:30 ET" },
  "us_ppi_fd_nsa_yoy:2026-09": { release_at: "2026-10-15T12:30:00Z", fallback_until: "2026-11-13T13:30:00Z", basis: "BLS PPI schedule: September 2026 -> Oct. 15, 2026 08:30 ET; next PPI release Nov. 13, 2026 08:30 ET" },
  "bok_base_rate:2026-10-22": { release_at: "2026-10-22T01:00:00Z", fallback_until: "2026-11-26T01:00:00Z", basis: "BoK 2026 MPB dates: October Thursday 22 (10:00 KST UNVERIFIED); next meeting November Thursday 26" },
  "kr_gdp_advance_yoy:2026-Q3": { release_at: "2026-10-26T23:00:00Z", fallback_until: null, basis: "BoK statistical calendar: 2026-10-27 08:00 KST Real GDP Q3 advance" },
  "fomc_upper_bound:2026-10-28": { release_at: "2026-10-28T18:00:00Z", fallback_until: "2026-12-09T19:00:00Z", basis: "FOMC October 27-28, statement 2:00 p.m. EDT (UNVERIFIED); the market falls back at the end of the next meeting, December 9" },
  "ecb_dfr:2026-10-29": { release_at: "2026-10-29T13:15:00Z", fallback_until: "2026-12-17T13:15:00Z", basis: "ECB Governing Council October 29 (14:15 CET UNVERIFIED); next meeting December 16-17" },
  "bcb_selic_target:2026-11-04": { release_at: "2026-11-04T21:30:00Z", fallback_until: null, basis: "Copom November 3-4 (~18:30 BRT UNVERIFIED)" },
  "boe_bank_rate:2026-11-05": { release_at: "2026-11-05T12:00:00Z", fallback_until: null, basis: "BoE MPC Thursday 5 November, 12:00 UK (UNVERIFIED for November)" },
};
/** No official number is awaited longer than this after its release_at (the markets' fallbacks are shorter). */
export const FALLBACK_MAX_MS = 45 * 86_400_000;

export function knownRelease(series: string, period: string): KnownRelease | undefined { return KNOWN_RELEASES[`${series}:${period}`]; }

/** The scheduled publication time of the market's event: the registry's when the event is known, else the market's. */
export function releaseAtOf(r: Pick<OfficialResolver, "series" | "period" | "release_at">): string {
  return knownRelease(r.series, r.period)?.release_at ?? r.release_at;
}

/** When the market texts stop waiting for the number: the named fallback, or release_at + 45 days, whichever is first. */
export function fallbackEndMs(r: Pick<OfficialResolver, "series" | "period" | "release_at">): number {
  const cap = Date.parse(releaseAtOf(r)) + FALLBACK_MAX_MS;
  const named = knownRelease(r.series, r.period)?.fallback_until;
  return named ? Math.min(Date.parse(named), cap) : cap;
}

export function hostAllowed(series: OfficialSeriesId, url: string): boolean {
  try { return OFFICIAL_SERIES[series].hosts.includes(new URL(url).hostname.toLowerCase()) && new URL(url).protocol === "https:"; }
  catch { return false; }
}

// ---- periods --------------------------------------------------------------------------------------------------

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const QUARTER_RE = /^(\d{4})-Q([1-4])$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function periodValid(series: OfficialSeriesId, period: string): boolean {
  switch (OFFICIAL_SERIES[series].period) {
    case "month": return MONTH_RE.test(period);
    case "quarter": return QUARTER_RE.test(period);
    case "day": {
      const m = DAY_RE.exec(period);
      if (!m) return false;
      const d = new Date(`${period}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === period;
    }
    default: { const never: never = OFFICIAL_SERIES[series].period; throw new Error(`unhandled period kind ${String(never)}`); }
  }
}

/**
 * How a document names the target period. Gate 1 requires the deciding text to contain one of these
 * (case- and whitespace-insensitive): a release that still names the previous month or meeting is not the target.
 */
export function periodMentions(series: OfficialSeriesId, period: string): string[] {
  const def = OFFICIAL_SERIES[series];
  if (def.period === "month") {
    const m = MONTH_RE.exec(period);
    return m ? [`${MONTHS[Number(m[2]) - 1]} ${m[1]}`] : [];
  }
  if (def.period === "quarter") {
    const q = QUARTER_RE.exec(period);
    return q ? [`${ORDINALS[Number(q[2]) - 1]} Quarter of ${q[1]}`, `${q[1]}Q${q[2]}`] : [];
  }
  const d = DAY_RE.exec(period);
  if (!d) return [];
  const [y, mo, day] = [d[1]!, MONTHS[Number(d[2]) - 1]!, String(Number(d[3]))];
  switch (series) {
    case "fomc_upper_bound": case "bok_base_rate": return [`${mo} ${day}, ${y}`];
    case "ecb_dfr": return [`${day} ${mo} ${y}`];
    case "boe_bank_rate": return [`${mo} ${y}`];
    case "bcb_selic_target": return [period];
    default: return [period];
  }
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function namesPeriod(series: OfficialSeriesId, period: string, text: string): boolean {
  const t = squash(text);
  return periodMentions(series, period).some((m) => t.includes(squash(m)));
}

// ---- decimal arithmetic (no floats on the deciding path) ---------------------------------------------------------

export interface Decimal { n: bigint; scale: number }

/** "334.980" -> { n: 334980n, scale: 3 }. Only plain optionally-signed decimals; anything else is undefined. */
export function parseDecimal(s: string): Decimal | undefined {
  const m = /^\s*([+-]?)(\d+)(?:\.(\d+))?\s*$/.exec(s);
  if (!m) return undefined;
  const frac = m[3] ?? "";
  const n = BigInt(m[2]! + frac);
  return { n: m[1] === "-" ? -n : n, scale: frac.length };
}

const pow10 = (k: number) => 10n ** BigInt(k);
const rescale = (d: Decimal, scale: number) => d.n * pow10(scale - d.scale);

/** num/den rounded half away from zero (den > 0). */
export function divRoundHalfAway(num: bigint, den: bigint): bigint {
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (2n * a + den) / (2n * den);
  return neg ? -q : q;
}

/**
 * The 12-month percent change (I[t] / I[t-12] - 1) * 100 from the published index strings, rounded half away from
 * zero to one decimal (returned in tenths of a percent). nearTie: the unrounded change lies within 0.0005 of an
 * x.x5 boundary, where the published index's own rounding can flip the printed decimal.
 */
export function yoyTenths(current: string, base: string): { tenths: number; nearTie: boolean } | undefined {
  const a = parseDecimal(current), b = parseDecimal(base);
  if (!a || !b) return undefined;
  const scale = Math.max(a.scale, b.scale);
  const A = rescale(a, scale), B = rescale(b, scale);
  if (B <= 0n) return undefined;
  const N = (A - B) * 1_000_000n; // N / B = percent * 10^4
  const den = 1000n * B;          // N / den = percent * 10 (tenths)
  const tenths = divRoundHalfAway(N, den);
  const absN = N < 0n ? -N : N;
  const k = absN / den;
  const boundary = (2n * k + 1n) * 500n * B;
  const dist = absN > boundary ? absN - boundary : boundary - absN;
  return { tenths: Number(tenths), nearTie: dist <= 5n * B };
}

/** A published percent ("3.4", "-0.2", 3.4) in tenths, rounded half away from zero. */
export function percentTenths(v: string | number): number | undefined {
  const d = typeof v === "string" ? parseDecimal(v) : Number.isFinite(v) ? parseDecimal(v.toFixed(6)) : undefined;
  if (!d) return undefined;
  return d.scale <= 1 ? Number(d.n * pow10(1 - d.scale)) : Number(divRoundHalfAway(d.n, pow10(d.scale - 1)));
}

/** A rate level in hundredths of a percent (= basis points of level), rounded half away from zero. */
export function levelBps(v: string | number): number | undefined {
  const d = typeof v === "string" ? parseDecimal(v) : Number.isFinite(v) ? parseDecimal(v.toFixed(6)) : undefined;
  if (!d) return undefined;
  return d.scale <= 2 ? Number(d.n * pow10(2 - d.scale)) : Number(divRoundHalfAway(d.n, pow10(d.scale - 2)));
}

/** A rate change in hundredths of a basis point: exact for levels with up to four decimals. */
export function changeHundredthsBp(value: string | number, prior: number): number | undefined {
  const a = typeof value === "string" ? parseDecimal(value) : parseDecimal(value.toFixed(6));
  const b = parseDecimal(prior.toFixed(6));
  if (!a || !b) return undefined;
  const scale = Math.max(a.scale, b.scale, 4);
  return Number(divRoundHalfAway(rescale(a, scale) - rescale(b, scale), pow10(scale - 4)));
}

/** The market's rounding of a rate change (hundredths of a bp in, whole bps out; always a multiple of 25). */
export function roundedChangeBps(hundredths: number, rule: OfficialRoundingRule): number {
  if (hundredths === 0) return 0;
  const sign = hundredths < 0 ? -1 : 1;
  const a = Math.abs(hundredths);
  switch (rule) {
    case "bps_away_from_zero_25": return sign * Math.ceil(a / 2500) * 25;
    case "bps_nearest_25_min_25": return sign * (a < 2500 ? 25 : Math.floor((a + 1250) / 2500) * 25);
    case "pct_1dp": throw new Error("pct_1dp is not a basis-point rule");
    default: { const never: never = rule; throw new Error(`unhandled rounding ${String(never)}`); }
  }
}

/** Two readings of the same number agree at the precision the series is published and decided in. */
export function sameAtPrecision(series: OfficialSeriesId, a: string | number, b: string | number): boolean {
  if (OFFICIAL_SERIES[series].decides === "percent") { const x = percentTenths(a), y = percentTenths(b); return x !== undefined && x === y; }
  const x = levelBps(a), y = levelBps(b);
  return x !== undefined && x === y;
}

// ---- buckets --------------------------------------------------------------------------------------------------

/** Bucket bounds on the decided grid: tenths of a percent, or whole bps. Off-grid bounds are undefined. */
function gridUnits(x: number, decides: SeriesDef["decides"]): number | undefined {
  const u = decides === "percent" ? x * 10 : x;
  const r = Math.round(u);
  return Math.abs(u - r) < 1e-9 ? r : undefined;
}

export function bucketContains(b: OfficialBucket, decides: SeriesDef["decides"], units: number): boolean {
  if (b.lo !== undefined) { const lo = gridUnits(b.lo, decides); if (lo === undefined || (b.lo_inclusive ? units < lo : units <= lo)) return false; }
  if (b.hi !== undefined) { const hi = gridUnits(b.hi, decides); if (hi === undefined || (b.hi_inclusive ? units > hi : units >= hi)) return false; }
  return true;
}

/** Why a bucket can never be Yes (empty, off-grid, or holding no reachable value), or null. */
export function bucketProblem(b: OfficialBucket, decides: SeriesDef["decides"]): string | null {
  if (b.lo === undefined && b.hi === undefined) return "bucket has neither lo nor hi";
  const lo = b.lo === undefined ? undefined : gridUnits(b.lo, decides);
  const hi = b.hi === undefined ? undefined : gridUnits(b.hi, decides);
  const grid = decides === "percent" ? "a multiple of 0.1" : "a whole number of bps";
  if (b.lo !== undefined && lo === undefined) return `bucket lo ${b.lo} is not ${grid}`;
  if (b.hi !== undefined && hi === undefined) return `bucket hi ${b.hi} is not ${grid}`;
  if (lo === undefined || hi === undefined) return null; // open-ended on one side: always reachable
  const min = b.lo_inclusive ? lo : lo + 1, max = b.hi_inclusive ? hi : hi - 1;
  if (min > max) return `bucket "${b.label}" is empty`;
  if (decides === "rate_change_bps" && Math.floor(max / 25) * 25 < min) return `bucket "${b.label}" holds no multiple of 25 bps (the market rounds every change to the 25 bp grid)`;
  return null;
}

// ---- the evidence document the watch stores and the resolver reads --------------------------------------------

const iso = z.iso.datetime({ offset: true });

export const CorroborationStatus = z.enum(["agree", "disagree", "unavailable", "inconclusive", "single_source"]);
export const OfficialCorroboration = z.object({
  status: CorroborationStatus,
  source_url: z.string().nullable(),
  value: z.number().nullable(),
  value_text: z.string().nullable(),
  detail: z.string().max(500),
  checked_at: iso,
});
export type OfficialCorroboration = z.infer<typeof OfficialCorroboration>;

export const OfficialObservationDoc = z.object({
  kind: z.literal("official_observation"),
  series: OfficialSeries,
  /** The period the DOCUMENT is about (its header, statement date or title), not the market's target. */
  period: z.string(),
  value: z.number(),
  value_text: z.string().min(1),
  deciding_text: z.string().min(1),
  source_url: z.string().min(1),
  raw_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** When the rail first observed it (our clock). */
  observed_at: iso,
  /** Rate decisions: the direction the text states, cross-checked against prior_level. */
  direction: z.enum(["up", "down", "unchanged"]).nullable(),
  corroboration: OfficialCorroboration.nullable(),
  /** The level the document says the rate moved from (BoK "from 2.75%", BCB's previous meeting), as published. */
  stated_prior: z.string().nullable().optional(),
  /** The step the document states (Fed "by 1/4 percentage point" = 25, BoK/ECB "by 25 basis points"). */
  stated_step_bps: z.number().nullable().optional(),
});
export type OfficialObservationDoc = z.infer<typeof OfficialObservationDoc>;

export const OfficialMissingDoc = z.object({
  kind: z.literal("official_missing"),
  series: OfficialSeries,
  period: z.string(),
  release_at: iso,
  source_url: z.string().min(1),
  detail: z.string(),
});
export type OfficialMissingDoc = z.infer<typeof OfficialMissingDoc>;

export const OfficialDoc = z.discriminatedUnion("kind", [OfficialObservationDoc, OfficialMissingDoc]);
export type OfficialDoc = z.infer<typeof OfficialDoc>;

/** Fixed key order, so the same stored row always serializes to the same bytes (evidence raw_sha256). */
export function officialDocJson(doc: OfficialDoc): string {
  if (doc.kind === "official_missing") {
    return JSON.stringify({ kind: doc.kind, series: doc.series, period: doc.period, release_at: doc.release_at, source_url: doc.source_url, detail: doc.detail });
  }
  const c = doc.corroboration;
  return JSON.stringify({
    kind: doc.kind, series: doc.series, period: doc.period, value: doc.value, value_text: doc.value_text, deciding_text: doc.deciding_text,
    source_url: doc.source_url, raw_sha256: doc.raw_sha256, observed_at: doc.observed_at, direction: doc.direction,
    corroboration: c ? { status: c.status, source_url: c.source_url, value: c.value, value_text: c.value_text, detail: c.detail, checked_at: c.checked_at } : null,
    stated_prior: doc.stated_prior ?? null, stated_step_bps: doc.stated_step_bps ?? null,
  });
}

/**
 * The evidence a leg resolves from: the document itself (structured) and its JSON (text, raw bytes).
 * ownCapture: this market's own watch made the observation (its adapter never fetches before the market's
 * release_at). For events outside KNOWN_RELEASES the release-time part of gate 1 applies only to such observations.
 */
export function officialEvidence(doc: OfficialDoc, fetchedAt: string, opts: { ownCapture?: boolean } = {}): { evidence: EvidenceInput; rawBytes: Uint8Array } {
  const text = officialDocJson(doc);
  const observedAt = doc.kind === "official_observation" ? doc.observed_at : fetchedAt;
  return {
    evidence: {
      source_kind: "official_release", source_url: doc.source_url, text, structured: JSON.parse(text) as unknown, observed_at: observedAt, fetched_at: fetchedAt,
      http_status: 200, provenance: { series: doc.series, period: doc.period, doc_kind: doc.kind, own_capture: opts.ownCapture === true },
    },
    rawBytes: new TextEncoder().encode(text),
  };
}

/**
 * The observation a verdict may use. The stored first print decides; a later read of the same (series, period) that
 * disagrees is a revision to alert on, never a replacement. With first_print_lock off (mutation harness only) the
 * latest fetch wins, which is exactly the failure the rail exists for.
 */
export function firstPrintFor(stored: OfficialObservationDoc, fetched: OfficialObservationDoc | null): OfficialObservationDoc {
  if (!fetched || railEnabled("first_print_lock")) return stored;
  return { ...fetched, corroboration: stored.corroboration };
}

// ---- the decision ---------------------------------------------------------------------------------------------

type Option = "OPTION_A" | "OPTION_B";
const other = (o: Option): Option => (o === "OPTION_A" ? "OPTION_B" : "OPTION_A");
const unresolved = (caveat: string, detail: string): StructuredDecision => ({ status: "UNRESOLVED", outcome: "NONE", caveats: [caveat], detail });

/**
 * The published reading as exact decimal text when it is one ("3.4", "2.50"), else the parsed number (a range such
 * as "3-3/4 to 4" carries its upper bound in value), so no float sits on the deciding path when decimal text exists.
 */
export function reading(doc: Pick<OfficialObservationDoc, "value" | "value_text">): string | number {
  return parseDecimal(doc.value_text) ? doc.value_text : doc.value;
}

/** The decided value in grid units (tenths of a percent, or bps of change after the market's rounding). */
export function decidedUnits(r: OfficialResolver, doc: Pick<OfficialObservationDoc, "value" | "value_text">): { units: number; shown: string } | { error: string } {
  const def = OFFICIAL_SERIES[r.series];
  if (def.decides === "percent") {
    const t = percentTenths(reading(doc));
    return t === undefined ? { error: `unreadable value ${doc.value_text}` } : { units: t, shown: `${(t / 10).toFixed(1)}%` };
  }
  if (r.prior_level === undefined) return { error: "prior_level missing for a rate-change series" };
  const h = changeHundredthsBp(reading(doc), r.prior_level);
  if (h === undefined) return { error: `unreadable level ${doc.value_text}` };
  const bps = roundedChangeBps(h, r.rounding);
  return { units: bps, shown: `${bps > 0 ? "+" : ""}${bps} bps (raw ${(h / 100).toFixed(2)} bps vs prior ${r.prior_level})` };
}

/**
 * Whether the document's own account of the move contradicts the registered prior_level: the direction it states,
 * the level it says the rate moved from, or the step it names. The change is otherwise computed against prior_level
 * alone, so a wrong registration would silently pick the wrong bucket (BoK prior 3.00 with "from 2.50% to 2.25%"
 * would read as a 75 bp cut). null when consistent or not a rate-change series.
 */
export function priorLevelProblem(r: OfficialResolver, doc: Pick<OfficialObservationDoc, "value" | "value_text" | "direction" | "stated_prior" | "stated_step_bps">): string | null {
  if (OFFICIAL_SERIES[r.series].decides !== "rate_change_bps" || r.prior_level === undefined) return null;
  const h = changeHundredthsBp(reading(doc), r.prior_level);
  if (h === undefined) return null; // decidedUnits reports the unreadable level
  const sign = h === 0 ? "unchanged" : h > 0 ? "up" : "down";
  if (doc.direction && sign !== doc.direction) return `the document says ${doc.direction} to ${doc.value_text}, but prior_level ${r.prior_level} implies ${sign}`;
  if (doc.stated_prior !== null && doc.stated_prior !== undefined && levelBps(doc.stated_prior) !== levelBps(r.prior_level)) {
    return `the document moves from ${doc.stated_prior}%, the registered prior_level is ${r.prior_level}%`;
  }
  if (doc.stated_step_bps !== null && doc.stated_step_bps !== undefined && doc.direction !== "unchanged" && Math.abs(h) !== doc.stated_step_bps * 100) {
    return `the document states a ${doc.stated_step_bps} bp move, but ${doc.value_text} against prior_level ${r.prior_level} is ${(h / 100).toFixed(2)} bp`;
  }
  return null;
}

/**
 * Decide one leg from the rail's document. Gate 1 (release time + period named), gate 2 (corroboration), gate 3
 * (bucket). Every path returns a decision, so an official_release market never reaches Jev.
 */
export function decideOfficial(market: MarketRegistration, ev: EvidenceInput): StructuredDecision {
  const r = market.resolver as OfficialResolver;
  const def = OFFICIAL_SERIES[r.series];
  if (ev.source_kind !== "official_release") {
    return { status: "ERROR", outcome: "NONE", error_code: "SOURCE_MISMATCH", error_reason: "SOURCE_REF_MISMATCH", caveats: [], detail: `official_release markets decide only from the official rail's stored first print, not ${ev.source_kind} evidence` };
  }
  const parsed = OfficialDoc.safeParse(ev.structured);
  if (!parsed.success) return { status: "ERROR", outcome: "NONE", error_code: "INSUFFICIENT_DATA", error_reason: "CORRUPT_INPUT", caveats: [], detail: `official document invalid: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ").slice(0, 200)}` };
  const doc = parsed.data;
  if (doc.series !== r.series) return { status: "ERROR", outcome: "NONE", error_code: "SOURCE_MISMATCH", error_reason: "SUBJECT_MISMATCH", caveats: [], detail: `document series ${doc.series} != market series ${r.series}` };
  if (doc.kind === "official_missing") return unresolved(doc.period === r.period ? "release_not_observed" : "awaiting_release", `${r.series} ${r.period}: ${doc.detail}`);

  // gate 1: the observation was made at or after the scheduled release and is about the target period. The release
  // time belongs to the event: a known event is checked against its scheduled time whoever captured the first
  // print; for any other event only this market's own capture is (another market's capture of the right period
  // is the release itself, and the adapter records nothing about another period).
  if (railEnabled("official_release_gate")) {
    const problems: string[] = [];
    const known = knownRelease(r.series, r.period);
    const releaseAt = releaseAtOf(r);
    const own = (ev.provenance as { own_capture?: unknown } | undefined)?.own_capture === true;
    if ((known || own) && Date.parse(doc.observed_at) < Date.parse(releaseAt)) problems.push(`observed ${doc.observed_at} before the scheduled release ${releaseAt}`);
    if (doc.period !== r.period) problems.push(`document is about ${doc.period}, market is ${r.period}`);
    if (!namesPeriod(r.series, r.period, doc.deciding_text)) problems.push(`deciding text does not name ${periodMentions(r.series, r.period).join(" | ")}`);
    if (problems.length) return unresolved("awaiting_release", problems.join("; "));
  }

  const decided = decidedUnits(r, doc);
  if ("error" in decided) return unresolved("value_unreadable", decided.error);

  // what the document itself says about the move must agree with the registered prior level
  const mismatch = priorLevelProblem(r, doc);
  if (mismatch) return unresolved("prior_level_mismatch", mismatch);

  // gate 2: a second official source, when it already has the number, must agree at the published precision
  const caveats = ["first_print"];
  const c = doc.corroboration;
  if (c && (c.status === "agree" || c.status === "disagree") && c.value !== null) {
    const second = c.value_text !== null && parseDecimal(c.value_text) ? c.value_text : c.value;
    if (c.status === "disagree" || !sameAtPrecision(r.series, reading(doc), second)) {
      return unresolved("sources_disagree", `primary ${doc.value_text} vs ${c.source_url ?? "corroboration"} ${c.value_text ?? c.value}: ${c.detail}`);
    }
  } else if (c?.status === "disagree") {
    return unresolved("sources_disagree", c.detail);
  } else if (c?.status === "single_source") {
    caveats.push("single_source");
  } else {
    caveats.push("corroboration_unavailable");
  }

  // gate 3: the bucket
  const inBucket = bucketContains(r.bucket, def.decides, decided.units);
  const pos = market.positive_option;
  return {
    status: "RESOLVED", outcome: inBucket ? pos : other(pos), caveats,
    detail: `${r.series} ${r.period} first print ${doc.value_text} -> ${decided.shown}; bucket "${r.bucket.label}" ${inBucket ? "contains" : "excludes"} it`,
  };
}

// ---- registration -----------------------------------------------------------------------------------------------

export function parseOfficialRef(ref: string): { series: string; period: string } | null {
  const m = /^official:([a-z0-9_]+):([0-9A-Za-z-]+)$/.exec(ref.trim());
  return m ? { series: m[1]!, period: m[2]! } : null;
}

/** Refusals that must name their reason before schema parsing would reject the series as unknown. */
export function officialRefusal(input: unknown): string | null {
  const o = (input ?? {}) as { resolver?: { kind?: unknown; series?: unknown }; sources?: Array<{ kind?: unknown; ref?: unknown }> };
  const named = new Set<string>();
  if (o.resolver?.kind === "official_release" && typeof o.resolver.series === "string") named.add(o.resolver.series);
  for (const s of Array.isArray(o.sources) ? o.sources : []) {
    const p = s?.kind === "official_release" && typeof s.ref === "string" ? parseOfficialRef(s.ref) : null;
    if (p) named.add(p.series);
  }
  for (const s of named) if (UNSUPPORTED_OFFICIAL_SERIES[s]) return `official_release series ${s} refused: ${UNSUPPORTED_OFFICIAL_SERIES[s]}`;
  return null;
}

/** Cross-field rules for official_release markets; [] when the market is not one or is valid. */
export function officialRegistrationIssues(reg: MarketRegistration): string[] {
  const r = reg.resolver;
  const officialSources = reg.sources.filter((s) => s.kind === "official_release");
  if (r?.kind !== "official_release") return officialSources.length ? ["official_release sources need an official_release resolver"] : [];
  const issues: string[] = [];
  const def = OFFICIAL_SERIES[r.series];
  if (!periodValid(r.series, r.period)) issues.push(`period ${r.period} is not a ${def.period} period for ${r.series}`);
  if (def.decides === "rate_change_bps" && r.prior_level === undefined) issues.push(`${r.series} decides a change in bps: prior_level is required`);
  if (def.decides === "percent" && r.prior_level !== undefined) issues.push(`${r.series} decides a published percent: prior_level must be absent`);
  if (def.decides === "percent" ? r.rounding !== "pct_1dp" : r.rounding === "pct_1dp") issues.push(`rounding ${r.rounding} does not fit ${r.series} (${def.decides})`);
  const bp = bucketProblem(r.bucket, def.decides);
  if (bp) issues.push(bp);
  if (Date.parse(r.release_at) < Date.parse(reg.open_at)) issues.push(`release_at ${r.release_at} is before open_at ${reg.open_at}`);
  const known = knownRelease(r.series, r.period);
  if (known && Date.parse(known.release_at) !== Date.parse(r.release_at)) issues.push(`release_at ${r.release_at} differs from the scheduled release ${known.release_at} of ${r.series}:${r.period} (${known.basis})`);
  if (!officialSources.length) issues.push("an official_release market needs an official:<series>:<period> source");
  for (const s of reg.sources) {
    if (s.kind !== "official_release") { issues.push(`source ${s.kind} ${s.ref.slice(0, 80)}: official_release markets take only official:<series>:<period> sources (the rail fetches the series' allowlisted hosts: ${def.hosts.join(", ")})`); continue; }
    const p = parseOfficialRef(s.ref);
    if (!p) { issues.push(`source ref ${s.ref.slice(0, 80)} is not official:<series>:<period>`); continue; }
    if (p.series !== r.series || p.period !== r.period) issues.push(`source ref ${s.ref} does not match resolver ${r.series}:${r.period}`);
  }
  return issues;
}

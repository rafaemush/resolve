/**
 * Building official_release leg registrations from platform ladders (scripts/official-legs.ts). Pure: the bucket
 * label parser turns an option title ("≤2.9%", "2.0–2.4%", "25 bps cut", "50+ bps increase", "No change", "50k to
 * 100k", "<-50k", "200k+") into the bucket the leg represents, in the series' decided unit. Anything it does not
 * recognise is null, never a guess: the leg is then left out of the suggestions with its label listed for the founder.
 */
import type { MarketRegistration, OfficialBucket } from "../resolve/schema";
import { OFFICIAL_SERIES, type OfficialSeriesId, type SeriesDef } from "../resolve/official";

const NUM = String.raw`[-−]?\d+(?:\.\d+)?`;
const norm = (s: string) => s.replace(/[−–—]/g, (c) => (c === "−" ? "-" : "–")).replace(/\s+/g, " ").trim();
const num = (s: string) => Number(s.replace("−", "-"));
const one = (x: number, side: "lo" | "hi", inclusive: boolean, label: string): OfficialBucket =>
  side === "lo" ? { label, lo: x, lo_inclusive: inclusive, hi_inclusive: true } : { label, hi: x, hi_inclusive: inclusive, lo_inclusive: true };

function percentBucket(label: string): OfficialBucket | null {
  const t = norm(label).replace(/\s*%/g, "%");
  let m: RegExpExecArray | null;
  if ((m = new RegExp(String.raw`^(?:≤|<=)\s*(${NUM})%$`).exec(t))) return one(num(m[1]!), "hi", true, label);
  if ((m = new RegExp(String.raw`^(?:≥|>=)\s*(${NUM})%$`).exec(t))) return one(num(m[1]!), "lo", true, label);
  if ((m = new RegExp(String.raw`^<\s*(${NUM})%$`).exec(t))) return one(num(m[1]!), "hi", false, label);
  if ((m = new RegExp(String.raw`^>\s*(${NUM})%$`).exec(t))) return one(num(m[1]!), "lo", false, label);
  if ((m = new RegExp(String.raw`^(${NUM})%\s*\+$`).exec(t))) return one(num(m[1]!), "lo", true, label);
  if ((m = new RegExp(String.raw`^(${NUM})%? or (?:more|higher|above)$`, "i").exec(t))) return one(num(m[1]!), "lo", true, label);
  if ((m = new RegExp(String.raw`^(${NUM})%? or (?:less|lower|below)$`, "i").exec(t))) return one(num(m[1]!), "hi", true, label);
  if ((m = new RegExp(String.raw`^(${NUM})%?\s*(?:–|-|to)\s*(${NUM})%$`, "i").exec(t))) {
    const lo = num(m[1]!), hi = num(m[2]!);
    return lo <= hi ? { label, lo, hi, lo_inclusive: true, hi_inclusive: true } : null;
  }
  if ((m = new RegExp(String.raw`^(${NUM})%$`).exec(t))) { const x = num(m[1]!); return { label, lo: x, hi: x, lo_inclusive: true, hi_inclusive: true }; }
  return null;
}

const DOWN = /\b(decrease|decreases|cut|cuts|lower|reduction|down)\b|↓/i;
const UP = /\b(increase|increases|hike|hikes|raise|raises|up)\b|↑/i;

function bpsBucket(label: string): OfficialBucket | null {
  const t = norm(label);
  if (/^(no change|unchanged|hold|no move|maintain(ed)?)$/i.test(t)) return { label, lo: 0, hi: 0, lo_inclusive: true, hi_inclusive: true };
  const down = DOWN.test(t), up = UP.test(t);
  if (down === up) return null;
  const sign = down ? -1 : 1;
  const m = /(\d+)\s*(\+)?\s*(?:bps?|basis points?)\b(\+)?/i.exec(t);
  if (!m) {
    // "Increase" / "Decrease" alone: any change in that direction (the market rounds every change to >= 25 bps)
    return /^(increase|decrease|hike|cut)$/i.test(t) ? (sign > 0 ? one(25, "lo", true, label) : one(-25, "hi", true, label)) : null;
  }
  const size = Number(m[1]);
  if (!size || size % 25 !== 0) return null;
  const plus = !!(m[2] || m[3]) || /\bor more\b/i.test(t);
  if (plus) return sign > 0 ? one(size, "lo", true, label) : one(-size, "hi", true, label);
  return { label, lo: sign * size, hi: sign * size, lo_inclusive: true, hi_inclusive: true };
}

/** "50k" -> 50, "-50k" -> -50, "0" -> 0 (a bound without "k" must be zero). */
function kValue(n: string, k: string): number | null {
  const x = num(n);
  return k || x === 0 ? x : null;
}

/**
 * Payroll-change ladders in thousands: "<-50k", "-50k to 0", "0 to 50k", "200k+". "X to Y" is half-open [X, Y): the
 * ladders put each boundary in two adjacent labels and settle a value exactly on it in the higher bracket, which
 * buildLegRegistration requires the market text to say (TIE_TO_HIGHER), so "<-50k" is below -50 and "200k+" from 200.
 */
function thousandsBucket(label: string): OfficialBucket | null {
  const t = norm(label).replace(/(\d)\s+k\b/gi, "$1k");
  let m: RegExpExecArray | null;
  const K = String.raw`(${NUM})(k?)`;
  if ((m = new RegExp(String.raw`^(?:<|less than |below |under )\s*${K}$`, "i").exec(t))) { const x = kValue(m[1]!, m[2]!); return x === null ? null : one(x, "hi", false, label); }
  if ((m = new RegExp(String.raw`^(?:≤|<=)\s*${K}$`).exec(t))) { const x = kValue(m[1]!, m[2]!); return x === null ? null : one(x, "hi", true, label); }
  if ((m = new RegExp(String.raw`^(?:>|more than |above |over )\s*${K}$`, "i").exec(t))) { const x = kValue(m[1]!, m[2]!); return x === null ? null : one(x, "lo", false, label); }
  if ((m = new RegExp(String.raw`^(?:≥|>=)\s*${K}$`).exec(t))) { const x = kValue(m[1]!, m[2]!); return x === null ? null : one(x, "lo", true, label); }
  if ((m = new RegExp(String.raw`^${K}\s*\+$`).exec(t)) || (m = new RegExp(String.raw`^${K} or (?:more|higher|above)$`, "i").exec(t))) { const x = kValue(m[1]!, m[2]!); return x === null ? null : one(x, "lo", true, label); }
  if ((m = new RegExp(String.raw`^${K}\s*(?:to|–)\s*${K}$`, "i").exec(t))) {
    if (!m[2] && !m[4]) return null; // "0 to 50" names no unit
    const lo = kValue(m[1]!, m[2]!), hi = kValue(m[3]!, m[4]!);
    return lo === null || hi === null || lo >= hi ? null : { label, lo, hi, lo_inclusive: true, hi_inclusive: false };
  }
  return null;
}

/** A thousands ladder is read half-open only when its text settles a boundary value in the higher bracket. */
export const TIE_TO_HIGHER = /\bhigher (?:range )?bracket\b/i;

/** The bucket an option title names, in the series' decided unit (percent at 1 dp, bps of change, thousands), else null. */
export function parseBucketLabel(label: string, decides: SeriesDef["decides"]): OfficialBucket | null {
  switch (decides) {
    case "percent": return percentBucket(label);
    case "rate_change_bps": return bpsBucket(label);
    case "change_thousands": return thousandsBucket(label);
    case "election": return null; // election legs are built by src/markets/election-legs.ts (subject mapping first)
    default: { const never: never = decides; throw new Error(`unhandled decided unit ${String(never)}`); }
  }
}

export interface LegGroup {
  series: OfficialSeriesId;
  period: string;
  release_at: string;
  prior_level?: number;
  /** The ladder's title on the platform, for the condition text. */
  title: string;
}

export interface LegInput {
  platform: "limitless" | "polymarket";
  external_id: string;
  group: LegGroup;
  label: string;
  open_at: string;
  deadline_utc: string;
  /** The leg's own resolution text from the platform (HTML allowed; stripped here). */
  criteria: string;
}

const strip = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/** One leg as a registration: Yes/No, positive = Yes, the resolver named by the group and the bucket from the label. */
export function buildLegRegistration(i: LegInput): { ok: true; market: MarketRegistration } | { ok: false; reason: string } {
  const def = OFFICIAL_SERIES[i.group.series];
  const bucket = parseBucketLabel(i.label, def.decides);
  if (!bucket) return { ok: false, reason: `unrecognised option label "${i.label}"` };
  if (def.decides === "change_thousands" && !TIE_TO_HIGHER.test(strip(i.criteria))) {
    return { ok: false, reason: `"${i.label}": the market text does not say which bracket a value exactly on a boundary settles in, so "X to Y" cannot be read as [X, Y)` };
  }
  const head = `Leg "${i.label}" of "${i.group.title}": resolves Yes iff the first print of ${def.label} for ${i.group.period}, decided under the market's rounding, falls in this bucket; otherwise No (another bucket was printed). `;
  const market: MarketRegistration = {
    platform: i.platform, external_id: i.external_id,
    condition: (head + strip(i.criteria)).slice(0, 4000),
    event_statement: `${def.label} for ${i.group.period} is in the bucket "${i.label}"`.slice(0, 1000),
    option_a: "Yes", option_b: "No", positive_option: "OPTION_A",
    anchors: [i.group.series],
    sources: [{ kind: "official_release", ref: `official:${i.group.series}:${i.group.period}` }],
    open_at: i.open_at, deadline_utc: i.deadline_utc, grace_seconds: 3600,
    resolver: {
      kind: "official_release", series: i.group.series, period: i.group.period, release_at: i.group.release_at,
      ...(i.group.prior_level !== undefined ? { prior_level: i.group.prior_level } : {}), bucket, rounding: def.rounding,
    },
    // a "No" here is a positive determination of another bucket, never an absence
    negative_rule: "explicit_negative", allow_prerelease: false,
  };
  return { ok: true, market };
}

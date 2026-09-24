/**
 * Building official_release leg registrations from platform ladders (scripts/official-legs.ts). Pure: the bucket
 * label parser turns an option title ("≤2.9%", "2.0–2.4%", "25 bps cut", "50+ bps increase", "No change") into the
 * bucket the leg represents, in the series' decided unit. Anything it does not recognise is null, never a guess:
 * the leg is then left out of the suggestions with its label listed for the founder.
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

/** The bucket an option title names, in the series' decided unit (percent at 1 dp, or bps of change), else null. */
export function parseBucketLabel(label: string, decides: SeriesDef["decides"]): OfficialBucket | null {
  return decides === "percent" ? percentBucket(label) : bpsBucket(label);
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

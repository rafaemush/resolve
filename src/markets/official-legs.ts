/**
 * Building official_release leg registrations from platform ladders (scripts/official-legs.ts). Pure: the bucket
 * label parser turns an option title ("≤2.9%", "2.0–2.4%", "25 bps cut", "50+ bps increase", "No change", "50k to
 * 100k", "<-50k", "200k+") into the bucket the leg represents, in the series' decided unit. Anything it does not
 * recognise is null, never a guess: the leg is then left out of the suggestions with its label listed for the founder.
 * derivePriorLevel / priorForGroup: a rate ladder's prior_level from the rail's own stored first print of the meeting
 * before it (release calendar order), never from memory, and only from a print the rail itself would decide from.
 * titlePeriodProblem / platformPeriodProblem: a ladder named on the command line must be about the period it was named with.
 */
import type { MarketRegistration, OfficialBucket } from "../resolve/schema";
import {
  OFFICIAL_SERIES, changeHundredthsBp, knownRelease, levelBps, namesPeriod, parseDecimal, periodMentions, reading, sameAtPrecision, type OfficialCorroboration, type OfficialSeriesId, type SeriesDef,
} from "../resolve/official";
import { previousInCalendar, type CalendarRow } from "../resolve/release-calendar";

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

// ---- prior_level of rate ladders ----------------------------------------------------------------------------------

/** A first print as official_observations stores it: one row per (series, period), first print wins (migration 016). */
export interface StoredFirstPrint {
  value: number | string; value_text: string; deciding_text: string; observed_at: string;
  /** The second source at record time (or after an audited re-check); null when none was recorded. */
  corroboration: OfficialCorroboration | null;
  /** meta.doc_period: the period the document itself is about. */
  doc_period?: string | null;
}
export type FirstPrintLookup = (series: OfficialSeriesId, period: string) => StoredFirstPrint | undefined;

/** The scheduled release of a calendar meeting: the registry's time, else the calendar row's (null: none stated). */
const scheduledAt = (series: OfficialSeriesId, period: string, row: CalendarRow): string | null => knownRelease(series, period)?.release_at ?? row.release_at;

/**
 * Pure. Why the rail would not decide the legs of (series, period) from this stored first print, or null: the same
 * refusals decideOfficial (src/resolve/official.ts) makes before a verdict, applied to the meeting before a ladder so
 * that its level becomes a prior only when the rail trusts it. Gate 1: about the period (its own document period and
 * a deciding text that names it), observed at or after the scheduled release (a release time the calendar does not
 * state cannot be checked, so it is refused), and before the market's fallback. Gate 2: no second source disagrees
 * (a stored "disagree" holds every leg at sources_disagree until an operator re-check). Then a readable level in
 * whole basis points (the prior it becomes is exact).
 * tests/official-prior.test.ts holds this to decideOfficial on the same rows.
 */
export function storedPrintProblem(series: OfficialSeriesId, period: string, releaseAt: string | null, row: StoredFirstPrint): string | null {
  const at = `the stored first print of ${series}:${period}`;
  if (row.doc_period && row.doc_period !== period) return `${at} is about ${row.doc_period}`;
  if (!namesPeriod(series, period, row.deciding_text)) return `${at}: its deciding text does not name ${periodMentions(series, period).join(" | ")}`;
  if (releaseAt === null) return `${at}: the calendar states no release time, so the print cannot be checked as observed after it`;
  if (Date.parse(row.observed_at) < Date.parse(releaseAt)) return `${at} was observed ${row.observed_at}, before the scheduled release ${releaseAt}`;
  const fallback = knownRelease(series, period)?.fallback_until;
  if (fallback && Date.parse(row.observed_at) >= Date.parse(fallback)) return `${at} was first observed ${row.observed_at}, at or after the market's fallback ${fallback}`;
  const c = row.corroboration;
  const level = reading({ value: Number(row.value), value_text: row.value_text });
  if (c?.status === "disagree") return `${at} (${row.value_text}) is disputed: the second source says ${c.value_text ?? c.value ?? "otherwise"} (${c.detail}); the rail holds that meeting's legs at sources_disagree`;
  if (c?.status === "agree" && c.value !== null && !sameAtPrecision(series, level, c.value_text !== null && parseDecimal(c.value_text) ? c.value_text : c.value)) {
    return `${at} (${row.value_text}) differs from its second source ${c.value_text ?? c.value}: the rail holds that meeting's legs at sources_disagree`;
  }
  const bps = levelBps(level);
  if (bps === undefined) return `${at} (${row.value_text}) is not a readable level`;
  // a prior is carried in whole basis points: a level off that grid is refused, never rounded onto it
  if (changeHundredthsBp(level, bps / 100) !== 0) return `${at} (${row.value_text}) is not a level in whole basis points`;
  return null;
}

/**
 * ok: the previous meeting's period and the level its stored first print set. Otherwise the reason; pending: the
 * previous meeting is known and not yet released at `nowMs`, so any prior level for this meeting would be a forecast.
 */
export type DerivedPrior =
  | { ok: true; prior_period: string; prior_level: number; value_text: string; observed_at: string }
  | { ok: false; prior_period: string | null; pending: boolean; reason: string };

/**
 * Pure. The meeting before (series, period) in calendar order when its scheduled release has passed at `nowMs`: only
 * then can a first print of it exist, so withPriors reads nothing for a meeting before that. null otherwise.
 */
export function releasedPrevious(series: OfficialSeriesId, period: string, nowMs: number): string | null {
  const prev = previousInCalendar(series, period);
  if ("reason" in prev) return null;
  const at = scheduledAt(series, prev.period, prev.row);
  return at !== null && Date.parse(at) <= nowMs ? prev.period : null;
}

/**
 * Pure. The prior_level of a rate-change leg from the rail's own record: the level the stored first print of the
 * previous scheduled meeting (release calendar order) set. The reason instead when the series decides no rate change,
 * the calendar does not list the previous meeting, that meeting has no stored first print, or the rail would not
 * decide from the one stored (storedPrintProblem: disputed, observed early, about another period, unreadable).
 */
export function derivePriorLevel(series: OfficialSeriesId, period: string, lookup: FirstPrintLookup, nowMs: number): DerivedPrior {
  const def = OFFICIAL_SERIES[series];
  if (def.decides !== "rate_change_bps") return { ok: false, prior_period: null, pending: false, reason: `${series} decides ${def.decides}: it takes no prior_level` };
  const prev = previousInCalendar(series, period);
  if ("reason" in prev) return { ok: false, prior_period: null, pending: false, reason: `previous meeting unknown: ${prev.reason}` };
  const at = scheduledAt(series, prev.period, prev.row);
  const row = lookup(series, prev.period);
  if (!row) {
    const pending = at === null || Date.parse(at) > nowMs;
    return { ok: false, prior_period: prev.period, pending, reason: `no stored first print of ${series}:${prev.period}, the meeting before ${period}${pending ? ` (not released yet: ${at ?? "time unknown"})` : ""}` };
  }
  const problem = storedPrintProblem(series, prev.period, at, row);
  if (problem) return { ok: false, prior_period: prev.period, pending: false, reason: problem };
  const bps = levelBps(reading({ value: Number(row.value), value_text: row.value_text }))!;
  return { ok: true, prior_period: prev.period, prior_level: bps / 100, value_text: row.value_text, observed_at: row.observed_at };
}

/**
 * Pure. The prior_level a rate-change group is suggested with, and a note for its basis. A hand-written prior must be
 * a level in whole basis points and, when the calendar lists the meeting before it, equal that meeting's trusted
 * stored first print exactly (else this throws with both values: the group is wrong, not the record); the stored
 * level is what the group then carries. While that meeting is not released the hand prior would be a forecast, and
 * once it is, a hand prior with no trusted print to check it against is a guess: both skip the group. Only a group
 * whose previous meeting the calendar does not list keeps an unchecked hand prior (the built-in first meetings). A
 * group without one takes the derived level, or is skipped with the reason: never suggested with a guess.
 */
export function priorForGroup(g: Pick<LegGroup, "series" | "period" | "prior_level">, d: DerivedPrior): { prior_level: number; note: string } | { skip: string } {
  if (g.prior_level !== undefined) {
    const bps = levelBps(g.prior_level);
    if (bps === undefined || bps / 100 !== g.prior_level) throw new Error(`${g.series}:${g.period}: the hand-written prior_level ${g.prior_level} is not a level in whole basis points; correct the group before suggesting it`);
    if (d.ok && g.prior_level !== d.prior_level) {
      throw new Error(`${g.series}:${g.period}: the hand-written prior_level ${g.prior_level} disagrees with the stored first print of ${g.series}:${d.prior_period}, ${d.value_text} (level ${d.prior_level}, observed ${d.observed_at}); correct the group before suggesting it`);
    }
    if (d.ok) return { prior_level: d.prior_level, note: `prior ${d.prior_level} (hand-written) equals the stored first print of ${d.prior_period}, ${d.value_text}` };
    if (d.pending) return { skip: `${g.series}:${g.period}: the hand-written prior_level ${g.prior_level} is a forecast: ${d.reason}` };
    if (d.prior_period !== null) return { skip: `${g.series}:${g.period}: the hand-written prior_level ${g.prior_level} cannot be checked (${d.reason}); the group is not suggested rather than suggested with a guess` };
    return { prior_level: g.prior_level, note: `prior ${g.prior_level} (hand-written; not checked against a stored first print: ${d.reason})` };
  }
  if (d.ok) return { prior_level: d.prior_level, note: `prior ${d.prior_level} from the stored first print of ${g.series}:${d.prior_period}, ${d.value_text} (observed ${d.observed_at})` };
  return { skip: `${g.series}:${g.period}: no prior_level (${d.reason}); the group is not suggested rather than suggested with a guess` };
}

// ---- the period of a ladder named on the command line ------------------------------------------------------------

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const QUARTER_ORDINALS = ["first", "second", "third", "fourth"] as const;
const monthsIn = (t: string) => new Set<string>([...t.matchAll(new RegExp(String.raw`\b(${MONTH_NAMES.join("|")})\b`, "gi"))].map((m) => MONTH_NAMES.find((n) => n.toLowerCase() === m[1]!.toLowerCase())!));
const quartersIn = (t: string) => new Set([...t.matchAll(/\bQ([1-4])\b|\b(first|second|third|fourth) quarter\b/gi)].map((m) => m[1] ? Number(m[1]) : QUARTER_ORDINALS.indexOf(m[2]!.toLowerCase() as (typeof QUARTER_ORDINALS)[number]) + 1));

/** What a ladder about `period` names: its quarter (GDP) or its month (a data month, a decision's month). */
function periodWord(period: string): { quarter: number } | { month: string } | null {
  const q = /^\d{4}-Q([1-4])$/.exec(period);
  if (q) return { quarter: Number(q[1]) };
  const month = MONTH_NAMES[Number(period.slice(5, 7)) - 1];
  return /^\d{4}-\d{2}/.test(period) && month ? { month } : null;
}

/**
 * Pure. Why a ladder title is not about `period`, or null: it must name the period's month (a decision's month; the
 * quarter for GDP) and no other. A title names the question's period once; the texts below it also date the release.
 */
export function titlePeriodProblem(series: OfficialSeriesId, period: string, title: string): string | null {
  const w = periodWord(period);
  if (!w) return `period ${period} names no month or quarter`;
  if ("quarter" in w) {
    const named = [...quartersIn(title)];
    return named.length === 1 && named[0] === w.quarter ? null : `the title "${title}" names ${named.length ? named.map((n) => `Q${n}`).join(", ") : "no quarter"}, not only Q${w.quarter} (${series}:${period})`;
  }
  const named = [...monthsIn(title)];
  return named.length === 1 && named[0] === w.month ? null : `the title "${title}" names ${named.length ? named.join(", ") : "no month"}, not only ${w.month} (${series}:${period})`;
}

/**
 * Pure. Why a platform ladder is not about `period`, or null. A built-in group carries its period next to its slug,
 * checked against the platform when it was written; a ladder named on the command line carries one typed argument, so
 * the platform's own words must agree with it: the ladder's title passes titlePeriodProblem, the leg's own text names
 * the month (or quarter) too, and the title or text names its year. The texts also date the release ("published on
 * November 10, 2026" for October data), so only the title is held to one month.
 */
export function platformPeriodProblem(series: OfficialSeriesId, period: string, title: string, criteria: string): string | null {
  const t = titlePeriodProblem(series, period, title);
  if (t) return `platform ${t}`;
  const text = strip(criteria);
  const w = periodWord(period)!;
  if ("quarter" in w ? !quartersIn(text).has(w.quarter) : !monthsIn(text).has(w.month)) return `the platform text does not name ${"quarter" in w ? `Q${w.quarter}` : w.month} (${series}:${period})`;
  if (!new RegExp(String.raw`\b${period.slice(0, 4)}\b`).test(`${title} ${text}`)) return `neither the platform title nor its text names ${period.slice(0, 4)} (${series}:${period})`;
  return null;
}

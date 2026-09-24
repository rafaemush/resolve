/**
 * Pure pieces of scripts/limitless-cadence.ts: the weekly re-scan table from v_limitless_cadence (migration 018) and
 * the resolution-latency summary from limitless_markets. Nothing here touches the network;
 * tests/limitless-cadence.test.ts runs it on inline rows.
 */
import { z } from "zod";

/** v_limitless_cadence as PostgREST returns it (bigint counts may arrive as strings). */
export const CadenceRow = z.object({
  iso_week: z.string(),
  week_start: z.string(),
  category: z.string(),
  markets_first_seen: z.coerce.number().int(),
  markets_created_in_week: z.coerce.number().int(),
  markets_expiring_45d: z.coerce.number().int(),
  legs_first_seen: z.coerce.number().int(),
});
export type CadenceRow = z.infer<typeof CadenceRow>;

/** The limitless_markets columns the latency summary reads. */
export const RecorderRow = z.object({
  slug: z.string(),
  group_slug: z.string().nullable(),
  market_type: z.string().nullable(),
  expiration_at: z.string().nullable(),
  last_pending_at: z.string().nullable(),
  resolved_seen_at: z.string().nullable(),
  winning_outcome_index: z.number().int().nullable(),
});
export type RecorderRow = z.infer<typeof RecorderRow>;

type Counts = Pick<CadenceRow, "markets_first_seen" | "markets_created_in_week" | "markets_expiring_45d" | "legs_first_seen">;
const COLS = ["markets_first_seen", "markets_created_in_week", "markets_expiring_45d", "legs_first_seen"] as const;
const zero = (): Counts => ({ markets_first_seen: 0, markets_created_in_week: 0, markets_expiring_45d: 0, legs_first_seen: 0 });
const add = (a: Counts, b: Counts) => { for (const c of COLS) a[c] += b[c]; };
const pick = (r: Counts): Counts => ({ markets_first_seen: r.markets_first_seen, markets_created_in_week: r.markets_created_in_week, markets_expiring_45d: r.markets_expiring_45d, legs_first_seen: r.legs_first_seen });

export interface WeekCadence { iso_week: string; week_start: string; total: Counts; categories: Array<{ category: string } & Counts> }

/** Pure. View rows -> weeks in date order, categories largest first, with week totals and a grand total. */
export function cadenceByWeek(rows: CadenceRow[]): { weeks: WeekCadence[]; total: Counts } {
  const weeks = new Map<string, WeekCadence>();
  const total = zero();
  for (const r of rows) {
    const w = weeks.get(r.week_start) ?? { iso_week: r.iso_week, week_start: r.week_start, total: zero(), categories: [] };
    weeks.set(r.week_start, w);
    w.categories.push({ category: r.category, ...pick(r) });
    add(w.total, pick(r));
    add(total, pick(r));
  }
  const out = [...weeks.values()].sort((a, b) => a.week_start.localeCompare(b.week_start));
  for (const w of out) w.categories.sort((a, b) => b.markets_first_seen - a.markets_first_seen || a.category.localeCompare(b.category));
  return { weeks: out, total };
}

/** A resolution bounded this tightly is inside the ±10 minutes the recorder claims (plan §17.3). */
export const TIGHT_WINDOW_MS = 20 * 60_000;

export interface LatencySummary {
  /** Markets with an outcome of their own (singles and legs; containers excluded). */
  markets: number;
  resolved: number; voided: number;
  /** Expired by the clock with no outcome yet. */
  pending_after_expiry: number;
  /** Resolved with a pending observation before it: the platform resolved inside (last_pending_at, resolved_seen_at]. */
  bounded: number;
  /** Of those, a window of at most TIGHT_WINDOW_MS. */
  within_20_min: number;
  /** First seen already resolved: only an upper bound on the resolution time, no latency. */
  unbounded: number;
  /** Hours from expiration to resolved_seen_at (an upper bound on the latency), over bounded markets; null when none. */
  median_hours: number | null; p90_hours: number | null;
  /** Widest (last_pending_at, resolved_seen_at] window among bounded markets, minutes. */
  max_window_minutes: number | null;
}

const quantile = (sorted: number[], q: number): number | null => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null);
const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

/** Pure. Latency is reported only where it was observed: a market first seen already resolved has none. */
export function latencySummary(rows: RecorderRow[], nowMs: number): LatencySummary {
  const own = rows.filter((r) => !(r.market_type === "group" && r.group_slug === null));
  const s: LatencySummary = { markets: own.length, resolved: 0, voided: 0, pending_after_expiry: 0, bounded: 0, within_20_min: 0, unbounded: 0, median_hours: null, p90_hours: null, max_window_minutes: null };
  const latencies: number[] = [];
  let maxWindow: number | null = null;
  for (const r of own) {
    const exp = r.expiration_at ? Date.parse(r.expiration_at) : null;
    if (!r.resolved_seen_at) { if (exp !== null && exp <= nowMs) s.pending_after_expiry++; continue; }
    s.resolved++;
    if (r.winning_outcome_index === null) s.voided++;
    if (!r.last_pending_at || exp === null) { s.unbounded++; continue; }
    const seen = Date.parse(r.resolved_seen_at), window = seen - Date.parse(r.last_pending_at);
    s.bounded++;
    if (window <= TIGHT_WINDOW_MS) s.within_20_min++;
    maxWindow = Math.max(maxWindow ?? 0, window);
    latencies.push(seen - exp);
  }
  latencies.sort((a, b) => a - b);
  const med = quantile(latencies, 0.5), p90 = quantile(latencies, 0.9);
  s.median_hours = med === null ? null : hours(med);
  s.p90_hours = p90 === null ? null : hours(p90);
  s.max_window_minutes = maxWindow === null ? null : Math.round(maxWindow / 60_000);
  return s;
}

/** Pure. The printed report. */
export function renderCadence(c: ReturnType<typeof cadenceByWeek>, l: LatencySummary): string {
  const pad = (v: string | number, n: number) => String(v).padStart(n);
  const line = (label: string, x: Counts) => `  ${label.padEnd(24)}${pad(x.markets_first_seen, 8)}${pad(x.markets_created_in_week, 10)}${pad(x.markets_expiring_45d, 10)}${pad(x.legs_first_seen, 8)}`;
  const out = ["Limitless manual markets by week of first sight (v_limitless_cadence)", `  ${"".padEnd(24)}${pad("seen", 8)}${pad("created", 10)}${pad("exp<=45d", 10)}${pad("legs", 8)}`];
  if (!c.weeks.length) out.push("  (no rows yet: the recorder has not run)");
  for (const w of c.weeks) {
    out.push(line(`${w.iso_week} (${w.week_start})`, w.total));
    for (const k of w.categories) out.push(line(`  ${k.category}`, k));
  }
  out.push(line("total", c.total));
  out.push("  seen = single markets and group containers first seen; created = of those, created by Limitless that same week");
  out.push("  (the creation cadence; the first week's seen includes the backfill); exp<=45d = expiring within 45 days of first sight.");
  out.push("", "Resolution latency (limitless_markets; official time = first sighting, source limitless_api_poll)");
  out.push(`  markets with an outcome of their own ${l.markets}; resolved ${l.resolved} (void ${l.voided}); expired, no outcome yet ${l.pending_after_expiry}`);
  out.push(`  bounded ${l.bounded} (window <= 20 min: ${l.within_20_min}; widest ${l.max_window_minutes ?? "-"} min); first seen already resolved ${l.unbounded} (no latency)`);
  out.push(`  expiry -> first sighting, bounded markets: median ${l.median_hours ?? "-"} h, p90 ${l.p90_hours ?? "-"} h (upper bounds; the true time is inside each window)`);
  return out.join("\n");
}

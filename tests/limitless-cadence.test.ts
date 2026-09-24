/**
 * scripts/limitless-cadence.ts (pure part, scripts/lib/limitless-cadence.ts): the weekly re-scan table and the
 * resolution-latency summary, which reports a latency only where a pending observation bounds it.
 */
import { describe, expect, it } from "vitest";
import { CadenceRow, cadenceByWeek, latencySummary, renderCadence, type RecorderRow } from "../scripts/lib/limitless-cadence";

const row = (week: string, iso: string, category: string, seen: number, created: number, exp45: number, legs: number) =>
  CadenceRow.parse({ iso_week: iso, week_start: week, category, markets_first_seen: String(seen), markets_created_in_week: created, markets_expiring_45d: exp45, legs_first_seen: legs });

describe("cadenceByWeek", () => {
  it("groups by week in date order, categories largest first, with week and grand totals (bigint strings coerced)", () => {
    const c = cadenceByWeek([
      row("2026-09-28", "2026-W40", "Politics", 3, 3, 1, 12), row("2026-09-21", "2026-W39", "Crypto", 58, 2, 20, 0),
      row("2026-09-21", "2026-W39", "Politics", 61, 1, 9, 400), row("2026-09-28", "2026-W40", "Crypto", 5, 5, 5, 0),
    ]);
    expect(c.weeks.map((w) => [w.iso_week, w.categories.map((k) => k.category), w.total.markets_first_seen, w.total.markets_created_in_week])).toEqual([
      ["2026-W39", ["Politics", "Crypto"], 119, 3],
      ["2026-W40", ["Crypto", "Politics"], 8, 8],
    ]);
    expect(c.total).toEqual({ markets_first_seen: 127, markets_created_in_week: 11, markets_expiring_45d: 35, legs_first_seen: 412 });
  });
});

describe("latencySummary", () => {
  const NOW = Date.parse("2026-10-20T12:00:00.000Z");
  const r = (over: Partial<RecorderRow>): RecorderRow => ({ slug: "s", group_slug: null, market_type: "single", expiration_at: "2026-10-18T00:00:00.000Z", last_pending_at: null, resolved_seen_at: null, winning_outcome_index: null, ...over });
  it("latency only where observed: bounded windows, first-seen-resolved markets without one, containers left out", () => {
    const s = latencySummary([
      r({ last_pending_at: "2026-10-18T23:55:00.000Z", resolved_seen_at: "2026-10-19T00:05:00.000Z", winning_outcome_index: 0 }), // 24.1 h, 10-min window
      r({ last_pending_at: "2026-10-19T10:00:00.000Z", resolved_seen_at: "2026-10-20T00:00:00.000Z", winning_outcome_index: 1 }), // 48 h, 14-h window
      r({ last_pending_at: "2026-10-18T02:50:00.000Z", resolved_seen_at: "2026-10-18T03:00:00.000Z", winning_outcome_index: null }), // void, 3 h
      r({ resolved_seen_at: "2026-10-19T00:00:00.000Z", winning_outcome_index: 1 }), // first seen already resolved
      r({ last_pending_at: "2026-10-20T11:50:00.000Z" }), // expired, still pending
      r({ expiration_at: "2026-11-01T00:00:00.000Z", last_pending_at: "2026-10-20T11:50:00.000Z" }), // not expired yet
      r({ market_type: "group", group_slug: null, resolved_seen_at: null }), // a container
    ], NOW);
    expect(s).toEqual({ markets: 6, resolved: 4, voided: 1, pending_after_expiry: 1, bounded: 3, within_20_min: 2, unbounded: 1, median_hours: 24.1, p90_hours: 48, max_window_minutes: 840 });
  });
  it("nothing resolved yet: no numbers are made up", () => {
    expect(latencySummary([r({})], NOW)).toMatchObject({ resolved: 0, bounded: 0, median_hours: null, p90_hours: null, max_window_minutes: null, pending_after_expiry: 1 });
    const text = renderCadence(cadenceByWeek([]), latencySummary([], NOW));
    expect(text).toContain("(no rows yet: the recorder has not run)");
    expect(text).toContain("median - h, p90 - h");
  });
});

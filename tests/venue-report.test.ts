/**
 * scripts/venue-report.ts rules and rendering (plan §17.3 P7-lite), pure, on inline v_venue_report / v_track_record
 * rows: arguments, the private/ output rule, the window, per-venue totals (agreement per market, reconciled per distinct
 * event, lead p50/p90 over distinct events only from 5 up), every percentage withheld until v_track_record says the
 * platform is reportable, identifiers only, the route named "web evidence" (never the model), and the footer.
 */
import { describe, expect, it } from "vitest";
import {
  basisLabel, duration, inWindow, when, outDirRefusal, parseReportArgs, percentileCont, platformReportable, renderCsv, renderMarkdown, reportBaseName, share, venueTotals,
  CSV_COLUMNS, FOOTER_TEXT, MIN_LEAD_EVENTS, UsageError, VenueRow, type TrackRow,
} from "../scripts/lib/venue-report";

const row = (id: string, over: Partial<VenueRow> = {}): VenueRow => VenueRow.parse({
  market_id: `m-${id}`, platform: "limitless", event_key: `limitless:${id}`, external_id: id, venue_slug: id, condition_id: null, status: "open",
  determination_basis: "structured", determinable_at: null, committed_at: "2026-10-10T00:00:00.000Z", posted_at: "2026-10-10T00:00:05.000Z", first_delivered_at: null,
  official_at: null, official_at_source: null, agreement: null, lead_seconds: null, registered_at: "2026-10-01T00:00:00.000Z", n_commits: 1,
  latest_commitment_sha256: "e".repeat(64), evidence_raw_sha256: "a".repeat(64), ...over,
});
const settled = (id: string, agreement: string, lead: number | null, over: Partial<VenueRow> = {}) =>
  row(id, { status: "resolved", agreement, lead_seconds: lead, official_at: "2026-10-12T00:00:00.000Z", official_at_source: "limitless_api_poll", ...over });
const track = (platform: string, week: string, reportable: boolean): TrackRow => ({ platform, week, reportable });

describe("arguments and output", () => {
  it("--platform is required; --since is a real date; --out defaults to private/reports", () => {
    expect(parseReportArgs(["--platform", "limitless"])).toEqual({ platform: "limitless", since: null, out: "private/reports" });
    expect(parseReportArgs(["--platform=all", "--since=2026-10-01", "--out", "private/x"])).toEqual({ platform: "all", since: "2026-10-01", out: "private/x" });
    for (const bad of [[], ["--platform", "kalshi"], ["--platform"], ["--platform", "all", "--since", "2026-02-30"], ["--platform", "all", "--since", "Oct 1"], ["--platform", "all", "--apply"], ["--platform", "all", "extra"]]) {
      expect(() => parseReportArgs(bad), bad.join(" ")).toThrow(UsageError);
    }
  });
  it("writes only inside the repository's private/ directory", () => {
    expect(outDirRefusal("/repo", "/repo/private/reports")).toBeNull();
    expect(outDirRefusal("/repo/", "/repo/private")).toBeNull();
    expect(outDirRefusal("/repo", "/repo/docs")).toMatch(/private/);
    expect(outDirRefusal("/repo", "/repo/private-leak")).toMatch(/private/);
    expect(outDirRefusal("/repo", "/tmp/reports")).toMatch(/private/);
  });
  it("file names carry the platform, the day and the window", () => {
    expect(reportBaseName("limitless", "2026-10-28T12:00:00.000Z", null)).toBe("venue-report-limitless-2026-10-28");
    expect(reportBaseName("all", "2026-10-28T12:00:00.000Z", "2026-10-01")).toBe("venue-report-all-2026-10-28-since-2026-10-01");
  });
});

describe("window, reportable gate, percentiles", () => {
  it("--since keeps markets first committed on or after it, or registered then when never committed; other platforms out", () => {
    const rows = [row("a", { committed_at: "2026-09-30T23:59:59.000Z" }), row("b"), row("c", { committed_at: null, registered_at: "2026-10-02T00:00:00.000Z" }), row("d", { platform: "polymarket" })];
    expect(inWindow(rows, "limitless", "2026-10-01").map((r) => r.external_id)).toEqual(["b", "c"]);
    expect(inWindow(rows, "limitless", null)).toHaveLength(3);
  });
  it("reportable is the platform's latest week in v_track_record; no row = not reportable", () => {
    const t = [track("limitless", "2026-10-05T00:00:00+00:00", false), track("limitless", "2026-10-12T00:00:00+00:00", true), track("polymarket", "2026-10-12T00:00:00+00:00", false)];
    expect(platformReportable(t, "limitless")).toBe(true);
    expect(platformReportable(t, "polymarket")).toBe(false);
    expect(platformReportable(t, "custom")).toBe(false);
  });
  it("percentile_cont interpolates like the database", () => {
    expect(percentileCont([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(percentileCont([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentileCont([10, 20, 30, 40, 50], 0.9)).toBe(46);
  });
});

describe("venueTotals", () => {
  // a 3-leg ladder (one event) plus singles; leads in seconds
  const ladder = [
    settled("fed-25", "agree", 7200, { event_key: "limitless:group:1" }),
    settled("fed-50", "agree", 3600, { event_key: "limitless:group:1" }),
    settled("fed-0", "abstained", null, { event_key: "limitless:group:1", determination_basis: "jev" }),
  ];
  const singles = [settled("s1", "agree", 600), settled("s2", "disagree", 1200), settled("s3", "void", null), row("s4", { status: "closed_unresolved", agreement: "unresolved_by_platform" }), row("s5", { committed_at: null, n_commits: 0, determination_basis: null })];

  it("agreement per market, reconciled per distinct event, web evidence of committed", () => {
    const t = venueTotals([...ladder, ...singles], "limitless", false);
    expect(t).toMatchObject({ markets: 8, events: 6, committed: 7, reconciled_events: 4, agreement: { agree: 3, disagree: 1, abstained: 1, void: 1, unresolved_by_platform: 1 }, web_evidence: 1 });
  });
  it("lead: one per event (the smallest of its RESOLVED legs), and no p50/p90 below 5 events", () => {
    const t = venueTotals([...ladder, ...singles], "limitless", false);
    expect(t.lead).toEqual({ events: 3, p50: null, p90: null, poll_sourced: 3 });
    expect(MIN_LEAD_EVENTS).toBe(5);
    const five = [...ladder, ...singles, settled("s6", "agree", 1800, { official_at_source: "gamma_closed_time" }), settled("s7", "agree", 2400)];
    const t5 = venueTotals(five, "limitless", false);
    // events: group:1 -> 3600 (not 7200), s1 600, s2 1200, s6 1800, s7 2400
    expect(t5.lead).toEqual({ events: 5, p50: 1800, p90: Math.round(percentileCont([600, 1200, 1800, 2400, 3600], 0.9)), poll_sourced: 4 });
  });
  it("every percentage is withheld until the platform is reportable", () => {
    const t = venueTotals([...ladder, ...singles], "limitless", false);
    expect(share(1, 7, t)).toBe("percentage withheld: fewer than 100 reconciled events on limitless");
    const r = venueTotals([...ladder, ...singles], "limitless", true);
    expect(share(1, 7, r)).toBe("14.3 %");
    expect(share(0, 0, r)).toBe("no committed verdicts");
  });
});

describe("rendering", () => {
  const rows = [settled("fed-25", "agree", 7200, { event_key: "limitless:group:1", condition_id: "0x" + "c".repeat(64) }), settled("fed-50", "agree", 3600, { event_key: "limitless:group:1", determination_basis: "jev" }), row("s5", { committed_at: null, n_commits: 0, determination_basis: null, posted_at: null })];
  const sections = [{ totals: venueTotals(rows, "limitless", false), rows }];
  const md = renderMarkdown({ sections, since: "2026-10-01", generatedAt: "2026-10-28T12:00:00.000Z", gitSha: "abc123def456" });

  it("Markdown: totals, one row per market grouped by event, the footer with time and git sha", () => {
    expect(md).toContain("# Venue reconciliation report: Limitless");
    expect(md).toContain("| Reconciled (distinct events) | 1 |");
    expect(md).toContain("| Web-evidence verdicts | 1 of 2 committed (percentage withheld: fewer than 100 reconciled events on limitless) |");
    expect(md).toContain("not enough data (1 distinct event with a measured lead; 5 needed)");
    expect(md).toMatch(/\| limitless:group:1 \| fed-25 \|/);
    expect(md).toMatch(/\n\|  \| fed-50 \|/);
    expect(md).toContain("3,600 s (1 h 0 min)");
    expect(md.trim().endsWith(`${FOOTER_TEXT} Generated 2026-10-28T12:00:00.000Z at git abc123def456.`)).toBe(true);
  });
  it("never names the model, claims no accuracy, prints no percentage while not reportable", () => {
    expect(md).not.toMatch(/jev|typesafe|accura|DCM|24.72/i);
    expect(md).not.toMatch(/\d %/);
    expect(renderCsv(sections)).not.toMatch(/jev/i);
    expect(basisLabel("jev")).toBe("web evidence");
    expect(basisLabel(null)).toBe("pre-check");
  });
  it("CSV: header row, one line per market, RFC 4180", () => {
    const csv = renderCsv(sections);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines.filter(Boolean)).toHaveLength(4);
    expect(lines[1]).toContain("fed-25,fed-25,0x" + "c".repeat(64));
  });
  it("durations keep their sign, carry minutes into hours, and switch to days from 48 h", () => {
    expect(duration(-90)).toBe("-90 s (-2 min)");
    expect(duration(172_795)).toBe("172,795 s (2 d)"); // 2,880 minutes: 48 h, never "47 h 60 min"
    expect(duration(7_170)).toBe("7,170 s (2 h 0 min)");
    expect(duration(3 * 86400)).toBe("259,200 s (3 d)");
    expect(duration(3599)).toBe("3,599 s (1 h 0 min)");
    expect(when("2026-10-10T00:00:05.123Z")).toBe("2026-10-10 00:00:05Z");
    expect(when(null)).toBeNull();
  });
  it("an empty section says so", () => {
    expect(renderMarkdown({ sections: [{ totals: venueTotals([], "polymarket", false), rows: [] }], since: null, generatedAt: "2026-10-28T12:00:00.000Z", gitSha: "x" })).toContain("No market in this window.");
    expect(renderMarkdown({ sections: [], since: null, generatedAt: "2026-10-28T12:00:00.000Z", gitSha: "x" })).toContain("no market shadowed yet");
  });
});

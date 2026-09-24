/**
 * scripts/venue-report.ts rules and rendering (plan §17.3 P7-lite), pure, on inline v_venue_report / v_track_record
 * rows: arguments, the private/ output rule, the window, per-venue totals (agreement per market, reconciled per distinct
 * event, lead p50/p90 over distinct events only from 5 up), every percentage withheld until v_track_record says the
 * platform is reportable, identifiers only, the route named "web evidence" (never the model), and the footer.
 */
import { describe, expect, it } from "vitest";
import {
  basisLabel, duration, inWindow, when, outDirRefusal, parseReportArgs, percentileCont, platformReportable, renderCsv, renderMarkdown, reportBaseName, share, venueTotals, withDeliveries,
  CSV_COLUMNS, DELIVERY_COLUMNS, FOOTER_TEXT, MIN_LEAD_EVENTS, UsageError, VENUE_COLUMNS, VenueRow, type DeliveryRow, type TrackRow,
} from "../scripts/lib/venue-report";

const row = (id: string, over: Partial<VenueRow> = {}): VenueRow => VenueRow.parse({
  market_id: `m-${id}`, platform: "limitless", event_key: `limitless:${id}`, external_id: id, venue_slug: id, condition_id: null, status: "open",
  determination_basis: "structured", determinable_at: null, committed_at: "2026-10-10T00:00:00.000Z", posted_at: "2026-10-10T00:00:05.000Z",
  official_at: null, official_at_source: null, agreement: null, lead_seconds: null, registered_at: "2026-10-01T00:00:00.000Z", n_commits: 1,
  latest_commitment_sha256: "e".repeat(64), evidence_raw_sha256: "a".repeat(64), ...over,
});
const settled = (id: string, agreement: string, lead: number | null, over: Partial<VenueRow> = {}) =>
  row(id, { status: "resolved", agreement, lead_seconds: lead, official_at: "2026-10-12T00:00:00.000Z", official_at_source: "limitless_api_poll", ...over });
const track = (platform: string, week: string, reportable: boolean): TrackRow => ({ platform, week, reportable });
const TENANT = "0a1b2c3d-0000-4000-8000-000000000001";
const OTHER = "0a1b2c3d-0000-4000-8000-000000000002";

describe("arguments and output", () => {
  it("--platform is required; --since is a real date; --out defaults to private/reports", () => {
    expect(parseReportArgs(["--platform", "limitless"])).toEqual({ platform: "limitless", since: null, tenant: null, out: "private/reports" });
    expect(parseReportArgs(["--platform=all", "--since=2026-10-01", "--out", "private/x"])).toEqual({ platform: "all", since: "2026-10-01", tenant: null, out: "private/x" });
    expect(parseReportArgs(["--platform", "limitless", "--tenant", TENANT.toUpperCase()])).toMatchObject({ tenant: TENANT });
    for (const bad of [[], ["--platform", "kalshi"], ["--platform"], ["--platform", "all", "--since", "2026-02-30"], ["--platform", "all", "--since", "Oct 1"], ["--platform", "all", "--apply"], ["--platform", "all", "extra"], ["--platform", "all", "--tenant", "acme"], ["--platform", "all", "--tenant"]]) {
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
    expect(reportBaseName("limitless", "2026-10-28T12:00:00.000Z", null, TENANT)).toBe("venue-report-limitless-2026-10-28-tenant-0a1b2c3d");
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
  const sections = [{ totals: venueTotals(rows, "limitless", false), rows: withDeliveries(rows, [], null) }];
  const md = renderMarkdown({ sections, since: "2026-10-01", tenant: null, generatedAt: "2026-10-28T12:00:00.000Z", gitSha: "abc123def456" });

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
    expect(renderCsv(sections, false)).not.toMatch(/jev/i);
    expect(basisLabel("jev")).toBe("web evidence");
    expect(basisLabel(null)).toBe("pre-check");
  });
  it("CSV: header row, one line per market, RFC 4180", () => {
    const csv = renderCsv(sections, false);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.filter((c) => c !== "first_delivered_at").join(","));
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
    expect(renderMarkdown({ sections: [{ totals: venueTotals([], "polymarket", false), rows: [] }], since: null, tenant: null, generatedAt: "2026-10-28T12:00:00.000Z", gitSha: "x" })).toContain("No market in this window.");
    expect(renderMarkdown({ sections: [], since: null, tenant: null, generatedAt: "2026-10-28T12:00:00.000Z", gitSha: "x" })).toContain("no market shadowed yet");
  });
  it("CSV formula injection: a platform identifier a spreadsheet would evaluate is written as text", () => {
    const evil = [row("x", { external_id: "=HYPERLINK(\"http://x\",\"y\")", venue_slug: "@SUM(A1)", event_key: "-2+3", lead_seconds: -120, status: "resolved", agreement: "agree" })];
    const line = renderCsv([{ totals: venueTotals(evil, "limitless", false), rows: withDeliveries(evil, [], null) }], false).split("\r\n")[1]!;
    expect(line).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(line).toContain(`"'@SUM(A1)"`);
    expect(line.startsWith(`limitless,"'-2+3",`)).toBe(true);
    expect(line).toContain(",agree,-120,");
  });
});

describe("delivery times: per tenant, never another follower's", () => {
  const rows = [row("a"), row("b"), row("c")];
  const deliveries: DeliveryRow[] = [
    { tenant_id: TENANT, market_id: "m-a", first_delivered_at: "2026-10-10T00:00:07.000Z" },
    { tenant_id: OTHER, market_id: "m-a", first_delivered_at: "2026-10-10T00:00:06.000Z" },
    { tenant_id: OTHER, market_id: "m-b", first_delivered_at: "2026-10-10T00:00:09.000Z" },
  ];
  it("the view rows carry no delivery time; v_venue_deliveries is read for the report's tenant only", () => {
    expect(VENUE_COLUMNS).not.toContain("first_delivered_at");
    expect(DELIVERY_COLUMNS).toBe("tenant_id, market_id, first_delivered_at");
  });
  it("withDeliveries keeps only the report tenant's deliveries, and none without a tenant", () => {
    expect(withDeliveries(rows, deliveries, TENANT).map((r) => r.first_delivered_at)).toEqual(["2026-10-10T00:00:07.000Z", null, null]);
    expect(withDeliveries(rows, deliveries, OTHER).map((r) => r.first_delivered_at)).toEqual(["2026-10-10T00:00:06.000Z", "2026-10-10T00:00:09.000Z", null]);
    expect(withDeliveries(rows, deliveries, null).map((r) => r.first_delivered_at)).toEqual([null, null, null]);
  });
  it("without --tenant there is no delivery column at all; with it, the column is the tenant's own", () => {
    const none = { sections: [{ totals: venueTotals(rows, "limitless", false), rows: withDeliveries(rows, deliveries, null) }], since: null, tenant: null, generatedAt: "2026-10-28T12:00:00.000Z", gitSha: "x" };
    const md = renderMarkdown(none);
    expect(md).not.toMatch(/delivered/i);
    expect(renderCsv(none.sections, false).split("\r\n")[0]).not.toContain("first_delivered_at");
    const mine = { ...none, tenant: TENANT, sections: [{ totals: none.sections[0]!.totals, rows: withDeliveries(rows, deliveries, TENANT) }] };
    const md2 = renderMarkdown(mine);
    expect(md2).toContain("| First delivered to you |");
    expect(md2).toContain("delivered to your account");
    expect(md2).toContain("2026-10-10 00:00:07Z");
    expect(md2).not.toContain("2026-10-10 00:00:06Z");
    expect(md2).not.toContain("2026-10-10 00:00:09Z");
    const csv = renderCsv(mine.sections, true).split("\r\n");
    expect(csv[0]).toBe(CSV_COLUMNS.join(","));
    expect(csv[1]).toContain("2026-10-10T00:00:07.000Z");
    expect(csv.join("\n")).not.toContain("2026-10-10T00:00:06.000Z");
  });
});

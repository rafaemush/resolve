/**
 * Venue reconciliation report (plan §17.3 P7-lite, §17.5 "weekly per-prospect reconciliation report with lead-time
 * p50/p90 and jev_share", §19.3): pure rules and rendering for scripts/venue-report.ts (tests/venue-report.test.ts).
 * Every number is a count or a statistic of v_venue_report rows (migration 021); the only other inputs are v_track_record,
 * read for one fact: whether the platform's record is reportable (100 reconciled distinct events, migration 017), and with
 * --tenant, v_venue_deliveries (021) for that one tenant: when each verdict was first delivered to it by webhook. A
 * delivery time is per follower, so a report without --tenant has no delivery column and a report for one venue never
 * shows another follower's. Until the platform is reportable, every percentage is replaced by the reason it is withheld.
 * Identifiers only (slugs, ids, hashes): never a market title or criteria text. Customer-facing wording: the verdict
 * route is "structured" or "web evidence", never the model.
 */
import { z } from "zod";
import { toCsv } from "../../src/ops/csv";
import { publicBasis, publicText } from "../../src/api/public-names";

export const REPORT_PLATFORMS = ["limitless", "polymarket", "custom"] as const;
export type ReportPlatform = (typeof REPORT_PLATFORMS)[number];
/** Lead-time percentiles need this many distinct events with a measured lead. */
export const MIN_LEAD_EVENTS = 5;
export const FOOTER_TEXT = "Informational signal, not financial advice, not an oracle of record.";
export const DEFAULT_OUT = "private/reports";

export class UsageError extends Error {}
export const USAGE = "usage: npx tsx scripts/venue-report.ts --platform limitless|polymarket|custom|all [--since YYYY-MM-DD] [--tenant <tenant uuid>] [--out private/reports]";

export interface ReportArgs { platform: ReportPlatform | "all"; since: string | null; tenant: string | null; out: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure. Anything it does not understand stops before a read. */
export function parseReportArgs(argv: readonly string[]): ReportArgs {
  const out: ReportArgs = { platform: "all", since: null, tenant: null, out: DEFAULT_OUT };
  let platformGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf("=");
    const flag = raw.startsWith("--") && eq > 0 ? raw.slice(0, eq) : raw;
    if (!["--platform", "--since", "--tenant", "--out"].includes(flag)) throw new UsageError(`unknown argument "${raw}"`);
    const value = eq > 0 ? raw.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith("--") || !value.trim()) throw new UsageError(`${flag} needs a value`);
    if (flag === "--platform") {
      if (value !== "all" && !(REPORT_PLATFORMS as readonly string[]).includes(value)) throw new UsageError(`--platform must be limitless, polymarket, custom or all, got "${value}"`);
      out.platform = value as ReportArgs["platform"];
      platformGiven = true;
    } else if (flag === "--since") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        throw new UsageError(`--since must be a date YYYY-MM-DD, got "${value}"`);
      }
      out.since = value;
    } else if (flag === "--tenant") {
      if (!UUID.test(value)) throw new UsageError(`--tenant must be a tenant id (uuid), got "${value}"`);
      out.tenant = value.toLowerCase();
    } else {
      out.out = value.trim();
    }
  }
  if (!platformGiven) throw new UsageError("--platform is required");
  return out;
}

/**
 * Pure. Why an output directory is refused, or null. A report quotes live rows of the record, so it is written only
 * under the repository's private/ directory (gitignored), never into a tracked path.
 */
export function outDirRefusal(repoRoot: string, resolvedOut: string): string | null {
  const root = repoRoot.replace(/\/+$/, "");
  const priv = `${root}/private`;
  return resolvedOut === priv || resolvedOut.startsWith(`${priv}/`) ? null : `--out must be inside ${priv} (gitignored): a report quotes live output and is never committed`;
}

const ts = z.string().nullable();
/** The v_venue_report columns the report reads. */
export const VenueRow = z.object({
  market_id: z.string(), platform: z.string(), event_key: z.string(), external_id: z.string(), venue_slug: z.string().nullable(), condition_id: z.string().nullable(),
  status: z.string(), determination_basis: z.string().nullable(), determinable_at: ts, committed_at: ts, posted_at: ts,
  official_at: ts, official_at_source: z.string().nullable(), agreement: z.string().nullable(), lead_seconds: z.number().int().nullable(),
  registered_at: z.string(), n_commits: z.number().int(), latest_commitment_sha256: z.string().nullable(), evidence_raw_sha256: z.string().nullable(),
});
export type VenueRow = z.infer<typeof VenueRow>;
export const VENUE_COLUMNS = Object.keys(VenueRow.shape).join(", ");

/** The v_venue_deliveries columns (--tenant only): one tenant's first delivered shadow.committed per market. */
export const DeliveryRow = z.object({ tenant_id: z.string(), market_id: z.string(), first_delivered_at: z.string() });
export type DeliveryRow = z.infer<typeof DeliveryRow>;
export const DELIVERY_COLUMNS = Object.keys(DeliveryRow.shape).join(", ");

/** A report row: the view row, plus the first delivery to the report's tenant (null without --tenant or none delivered). */
export type ReportRow = VenueRow & { first_delivered_at: string | null };

/**
 * Pure. Attach the tenant's first delivery to each row. Only rows of `tenant` count, whatever else is passed, so a
 * report prepared for one venue can never carry another follower's delivery time; no tenant, no delivery times.
 */
export function withDeliveries(rows: readonly VenueRow[], deliveries: readonly DeliveryRow[], tenant: string | null): ReportRow[] {
  const first = new Map<string, string>();
  if (tenant) for (const d of deliveries) if (d.tenant_id.toLowerCase() === tenant.toLowerCase()) first.set(d.market_id, d.first_delivered_at);
  return rows.map((r) => ({ ...r, first_delivered_at: first.get(r.market_id) ?? null }));
}

export const TrackRow = z.object({ platform: z.string(), week: z.string(), reportable: z.boolean(), n_events_reconciled_cumulative: z.coerce.number().nullable().optional() });
export type TrackRow = z.infer<typeof TrackRow>;
export const TRACK_COLUMNS = "platform, week, reportable, n_events_reconciled_cumulative";

/** Pure. The rows in the window: the platform, and --since against the first commit (the registration when none). */
export function inWindow<R extends VenueRow>(rows: readonly R[], platform: ReportPlatform, since: string | null): R[] {
  const from = since ? Date.parse(`${since}T00:00:00Z`) : null;
  return rows.filter((r) => r.platform === platform && (from === null || Date.parse(r.committed_at ?? r.registered_at) >= from));
}

/** Pure. v_track_record's gate for the platform: its latest week's `reportable` (cumulative); false with no row. */
export function platformReportable(track: readonly TrackRow[], platform: string): boolean {
  const rows = track.filter((t) => t.platform === platform).sort((a, b) => Date.parse(b.week) - Date.parse(a.week));
  return rows[0]?.reportable === true;
}

/** Pure. percentile_cont (linear interpolation), as the database computes median_lead_seconds. */
export function percentileCont(xs: readonly number[], p: number): number {
  if (!xs.length) throw new Error("percentile of nothing");
  const s = [...xs].sort((a, b) => a - b);
  const pos = p * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

const RECONCILED = new Set(["agree", "disagree", "abstained", "void"]);
const DECIDED = new Set(["agree", "disagree"]);
const POLL_SOURCES = new Set(["limitless_api_poll", "first_observed_poll"]);

export interface VenueTotals {
  platform: ReportPlatform;
  markets: number;
  events: number;
  committed: number;
  reconciled_events: number;
  agreement: { agree: number; disagree: number; abstained: number; void: number; unresolved_by_platform: number };
  /** Committed markets whose latest commit is a web-evidence verdict (determination_basis jev), of `committed`. */
  web_evidence: number;
  /** One lead per distinct event (the smallest of its RESOLVED legs' leads): conservative. */
  lead: { events: number; p50: number | null; p90: number | null; poll_sourced: number };
  reportable: boolean;
}

/**
 * Pure. Per-venue totals. Agreement counts are per market (leg); "reconciled" counts distinct events with at least one
 * leg agree, disagree, abstained or void (the record's n). An event's lead is the smallest lead_seconds of its legs that
 * committed RESOLVED (agree or disagree), so the reported lead never exceeds any leg's; p50/p90 only when at least
 * MIN_LEAD_EVENTS events have one.
 */
export function venueTotals(rows: readonly VenueRow[], platform: ReportPlatform, reportable: boolean): VenueTotals {
  const count = (a: string) => rows.filter((r) => r.agreement === a).length;
  const events = new Set(rows.map((r) => r.event_key));
  const reconciledEvents = new Set(rows.filter((r) => r.agreement && RECONCILED.has(r.agreement)).map((r) => r.event_key));
  const leadByEvent = new Map<string, { lead: number; poll: boolean }>();
  for (const r of rows) {
    if (!r.agreement || !DECIDED.has(r.agreement) || r.lead_seconds === null) continue;
    const prev = leadByEvent.get(r.event_key);
    if (!prev || r.lead_seconds < prev.lead) leadByEvent.set(r.event_key, { lead: r.lead_seconds, poll: POLL_SOURCES.has(r.official_at_source ?? "") });
  }
  const leads = [...leadByEvent.values()];
  const enough = leads.length >= MIN_LEAD_EVENTS;
  const committed = rows.filter((r) => r.committed_at !== null);
  return {
    platform, markets: rows.length, events: events.size, committed: committed.length, reconciled_events: reconciledEvents.size,
    agreement: { agree: count("agree"), disagree: count("disagree"), abstained: count("abstained"), void: count("void"), unresolved_by_platform: count("unresolved_by_platform") },
    web_evidence: committed.filter((r) => r.determination_basis === "jev").length,
    lead: {
      events: leads.length,
      p50: enough ? Math.round(percentileCont(leads.map((l) => l.lead), 0.5)) : null,
      p90: enough ? Math.round(percentileCont(leads.map((l) => l.lead), 0.9)) : null,
      poll_sourced: leads.filter((l) => l.poll).length,
    },
    reportable,
  };
}

const NAMES: Record<ReportPlatform, string> = { limitless: "Limitless", polymarket: "Polymarket", custom: "Custom markets" };
const n = (x: number) => x.toLocaleString("en-US");

/** Pure. A share as a percentage only when the platform's record is reportable; otherwise why it is withheld. */
export function share(k: number, of: number, t: Pick<VenueTotals, "reportable" | "platform">): string {
  if (!t.reportable) return `percentage withheld: fewer than 100 reconciled events on ${t.platform}`;
  if (of === 0) return "no committed verdicts";
  return `${(Math.round((k / of) * 1000) / 10).toFixed(1)} %`;
}

/** Pure. 13800 -> "13,800 s (3 h 50 min)"; negative leads (the official time came first) keep their sign. */
export function duration(seconds: number): string {
  const a = Math.abs(seconds), minutes = Math.round(a / 60), h = Math.floor(minutes / 60), m = minutes % 60;
  const human = h >= 48 ? `${Math.round((a / 86400) * 10) / 10} d` : h > 0 ? `${h} h ${m} min` : `${m} min`;
  return `${n(seconds)} s (${seconds < 0 ? "-" : ""}${human})`;
}

/**
 * Pure. The Route column: the public route name (publicBasis, src/api/public-names.ts) in words. A value outside the
 * public names prints through publicText, so no internal name reaches a venue.
 */
export function basisLabel(b: string | null): string {
  if (b === null) return "pre-check";
  const p = publicBasis(b);
  return p === "web_evidence" ? "web evidence" : p === "structured" ? "structured" : publicText(b);
}

/** Pure. An ISO time as the tables print it: "2026-10-10 00:00:05Z" (the CSV keeps the full ISO value). */
export function when(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 19).replace("T", " ")}Z` : iso;
}

const cell = (s: string | number | null | undefined) => (s === null || s === undefined || s === "" ? "–" : String(s).replace(/\|/g, "\\|"));
const short = (h: string | null) => (h ? `${h.slice(0, 12)}…` : null);

/** Pure. The totals table of one venue. */
export function renderTotals(t: VenueTotals): string {
  const lead = t.lead.p50 === null
    ? `not enough data (${t.lead.events} distinct event${t.lead.events === 1 ? "" : "s"} with a measured lead; ${MIN_LEAD_EVENTS} needed)`
    : `${duration(t.lead.p50)} / ${duration(t.lead.p90!)} over ${t.lead.events} distinct events${t.lead.poll_sourced ? ` (${t.lead.poll_sourced} with a poll-observed official time: an upper bound, up to 10 minutes late)` : ""}`;
  return [
    "| | |", "|---|---|",
    `| Markets | ${n(t.markets)} |`,
    `| Distinct events | ${n(t.events)} |`,
    `| Committed (markets) | ${n(t.committed)} |`,
    `| Reconciled (distinct events) | ${n(t.reconciled_events)} |`,
    `| Agree / disagree / abstained / void / unresolved by platform (markets) | ${[t.agreement.agree, t.agreement.disagree, t.agreement.abstained, t.agreement.void, t.agreement.unresolved_by_platform].map(n).join(" / ")} |`,
    `| Web-evidence verdicts | ${n(t.web_evidence)} of ${n(t.committed)} committed (${share(t.web_evidence, t.committed, t)}) |`,
    `| Lead time p50 / p90 | ${lead} |`,
  ].join("\n");
}

/**
 * Pure. One table row per market, grouped by event (the event key printed on its first leg). The "First delivered"
 * column exists only in a report prepared for one tenant (`perTenant`).
 */
export function renderEvents(rows: readonly ReportRow[], perTenant: boolean): string {
  const byEvent = new Map<string, ReportRow[]>();
  for (const r of [...rows].sort((a, b) => a.event_key.localeCompare(b.event_key) || a.external_id.localeCompare(b.external_id))) {
    byEvent.set(r.event_key, [...(byEvent.get(r.event_key) ?? []), r]);
  }
  const heads = ["Event", "Market", "Status", "Route", "Determinable", "Committed", "Posted", ...(perTenant ? ["First delivered to you"] : []), "Official", "Official time", "Agreement", "Lead", "Commitment"];
  const lines = [`| ${heads.join(" | ")} |`, `|${heads.map(() => "---").join("|")}|`];
  for (const [event, legs] of byEvent) {
    legs.forEach((r, i) => {
      const cells = [
        i === 0 ? cell(event) : "", cell(r.venue_slug ?? r.external_id), cell(r.status), cell(r.committed_at ? basisLabel(r.determination_basis) : null),
        cell(when(r.determinable_at)), cell(when(r.committed_at)), cell(when(r.posted_at)), ...(perTenant ? [cell(when(r.first_delivered_at))] : []),
        cell(when(r.official_at)), cell(r.official_at_source), cell(r.agreement), cell(r.lead_seconds === null ? null : duration(r.lead_seconds)), cell(short(r.latest_commitment_sha256)),
      ];
      lines.push(`| ${cells.join(" | ")} |`);
    });
  }
  return lines.join("\n");
}

/** `tenant`: the account the report is prepared for (--tenant); null = no delivery column. */
export interface RenderInput { sections: Array<{ totals: VenueTotals; rows: ReportRow[] }>; since: string | null; tenant: string | null; generatedAt: string; gitSha: string }

/** Pure. The Markdown report. */
export function renderMarkdown(r: RenderInput): string {
  const scope = r.sections.length ? r.sections.map((s) => NAMES[s.totals.platform]).join(", ") : "no market shadowed yet";
  const out = [
    `# Venue reconciliation report: ${scope}`,
    "",
    `Window: ${r.since ? `markets first committed (or registered, when never committed) on or after ${r.since}` : "every market shadowed so far"}. Every number below is read from Resolve's record (v_venue_report${r.tenant ? ", v_venue_deliveries for your account" : ""} and v_track_record); markets are named by their platform ids only.`,
    "",
    `How to read it: *committed* is the first time Resolve recorded a hash-committed verdict for the market, *posted* when that commitment reached the public channel, *determinable* when a verdict first called the outcome, ${r.tenant ? "*first delivered to you* when the first `shadow.committed` webhook for the market was delivered to your account, " : ""}*official* the platform's resolution time, and *lead* the official time minus the posted time of the market's final commit. Every commitment can be checked at \`GET /v1/track-record/verify?hash=<sha256>\`.`,
  ];
  for (const s of r.sections) {
    out.push("", `## ${NAMES[s.totals.platform]}`, "", renderTotals(s.totals), "");
    out.push(s.rows.length ? renderEvents(s.rows, r.tenant !== null) : "No market in this window.");
  }
  out.push("", "---", "", `${FOOTER_TEXT} Generated ${r.generatedAt} at git ${r.gitSha}.`, "");
  return out.join("\n");
}

export const CSV_COLUMNS = [
  "platform", "event_key", "external_id", "venue_slug", "condition_id", "status", "route", "determinable_at", "committed_at", "posted_at", "first_delivered_at",
  "official_at", "official_at_source", "agreement", "lead_seconds", "n_commits", "commitment_sha256", "evidence_raw_sha256",
] as const;

/**
 * Pure. One CSV row per market of every section (data only: the totals, the window and the footer are in the Markdown
 * beside it). first_delivered_at (to the report's tenant) is a column only in a report prepared for one tenant.
 */
export function renderCsv(sections: RenderInput["sections"], perTenant: boolean): string {
  const rows = sections.flatMap((s) => [...s.rows].sort((a, b) => a.event_key.localeCompare(b.event_key) || a.external_id.localeCompare(b.external_id)).map((r) => ({
    platform: r.platform, event_key: r.event_key, external_id: r.external_id, venue_slug: r.venue_slug, condition_id: r.condition_id, status: r.status,
    route: r.committed_at ? basisLabel(r.determination_basis) : null, determinable_at: r.determinable_at, committed_at: r.committed_at, posted_at: r.posted_at,
    first_delivered_at: r.first_delivered_at, official_at: r.official_at, official_at_source: r.official_at_source, agreement: r.agreement, lead_seconds: r.lead_seconds,
    n_commits: r.n_commits, commitment_sha256: r.latest_commitment_sha256, evidence_raw_sha256: r.evidence_raw_sha256,
  })));
  return toCsv(perTenant ? CSV_COLUMNS : CSV_COLUMNS.filter((c) => c !== "first_delivered_at"), rows);
}

/** Pure. File names: venue-report-<platform|all>-<generated day>[-since-<day>][-tenant-<first 8 of the id>].{md,csv}. */
export function reportBaseName(platform: ReportArgs["platform"], generatedAt: string, since: string | null, tenant: string | null = null): string {
  return `venue-report-${platform}-${generatedAt.slice(0, 10)}${since ? `-since-${since}` : ""}${tenant ? `-tenant-${tenant.slice(0, 8)}` : ""}`;
}

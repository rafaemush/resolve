/**
 * GET /v1/shadow/export (plan §17.3 P7-lite "CSV export", §17.2 #2): one row per market the calling tenant follows and
 * is entitled to (the same rule as the webhooks and GET /v1/shadow/:market_id: followBlock over follow_entitlements'
 * facts, computed here for every follow at once), read from v_venue_report (migration 021): the latest commit's
 * commitment, verdict and evidence hashes (the private early reveal the tenant already receives), and once the platform
 * has resolved the market, the official outcome, its time and source, the agreement and lead_seconds. Never the nonce or
 * the preimage (the view has neither): a commitment stays checkable by anyone at GET /v1/track-record/verify.
 * Since migration 023 a RESOLVED latest verdict is priced like every other reveal (src/shadow/reveal.ts): the export asks
 * charge_reveals() once for every exported market whose latest commit is RESOLVED (source read: charged once per tenant
 * and market, a replay free, never refunded), and a market the tenant has not received is exported locked: its commitment,
 * times and hashes, with committed_status and committed_outcome empty and the reveal column naming why. A settled market
 * is not priced (reveal public): its commits are public by then, and its official_outcome and agreement columns would
 * tell a locked row's outcome anyway.
 * The rules and shapes here are pure; the route (src/api/v1.ts) does the reads.
 */
import { z } from "zod";
import { followBlock, type Plan } from "./follows";
import { revealIsPublic, revealReleased, type RevealAnswer } from "./reveal";
import { toCsv, type CsvValue } from "../ops/csv";
import { COST } from "../ops/budget";

export const EXPORT_PLATFORMS = ["polymarket", "limitless", "custom"] as const;
/** At most this many follows are read (Supabase answers at most 1,000 rows per request), so at most this many rows. */
export const EXPORT_ROW_CAP = 1000;
/** Market ids per v_venue_report read: 100 uuids keep the PostgREST URL near 4 KB. */
export const EXPORT_CHUNK = 100;
/**
 * Subrequests of one export after authentication: the plan read, the follows read, one v_venue_report read per
 * EXPORT_CHUNK entitled markets, and one charge_reveals() call for every exported market whose latest verdict is RESOLVED
 * = 2 + 10 + 1 = 13; after a charge that crossed the low-credit threshold, credits.low under waitUntil (the endpoint read,
 * the insert and one alert: 7). With the middleware (key lookup through the Cache API: match, database read and put; the
 * daily-cap RPC; the rate-limit RPC; the request log insert and, if that fails, one alert) the request stays near 31 of
 * Workers Free's 50.
 */
export const EXPORT_SUBREQUESTS = 2 * COST.db + Math.ceil(EXPORT_ROW_CAP / EXPORT_CHUNK) * COST.db + COST.db;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day ("2026-02-30" is not one), or an ISO 8601 time that parses. */
const validSince = (s: string): boolean => {
  if (DAY.test(s)) { const t = Date.parse(`${s}T00:00:00Z`); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s; }
  return /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s));
};
export const ExportQuery = z.object({
  platform: z.enum(EXPORT_PLATFORMS).optional(),
  /** A UTC day (YYYY-MM-DD) or an ISO time with an offset. */
  since: z.string().trim().refine(validSince, "since must be YYYY-MM-DD or an ISO 8601 time")
    .transform((s) => new Date(DAY.test(s) ? `${s}T00:00:00Z` : s).toISOString()).optional(),
  format: z.enum(["json", "csv"]).default("json"),
});
export type ExportQuery = z.infer<typeof ExportQuery>;

/** One active follow of the tenant as the route reads it (market_follows with its market embedded). */
export interface ExportFollow {
  id: string;
  market_id: string;
  created_at: string;
  markets: { platform: string; status: string; deleted_at: string | null } | null;
}

const counts = (f: ExportFollow) => !!f.markets && f.markets.status === "open" && f.markets.deleted_at === null;

/**
 * Pure. The follows that deliver now, oldest first. For each follow, open_rank is what follow_entitlements() (migration
 * 014) computes: its position by (created_at, id) among the tenant's follows of open, undeleted markets plus its own
 * market (a tenant has one active follow per market, so that is 1 + the open-market follows before it); followBlock()
 * then applies the plan's cap and the evaluation rule. `liveKey` is the tenant holding a live key, which an
 * authenticated caller does. A follow whose market row is missing is never exported. Linear after the sort: 1,000
 * follows stay far inside a Worker's CPU budget.
 */
export function entitledFollows(follows: readonly ExportFollow[], plan: Plan, liveKey: boolean): ExportFollow[] {
  const ordered = [...follows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: ExportFollow[] = [];
  let openBefore = 0;
  for (const f of ordered) {
    if (f.markets && followBlock({ tenant_id: "", follow_id: f.id, plan, live_key: liveKey, open_rank: openBefore + 1 }) === null) out.push(f);
    if (counts(f)) openBefore++;
  }
  return out;
}

/** The v_venue_report columns the export reads (never first_delivered_at: other tenants' deliveries are not this one's). */
export const EXPORT_VIEW_COLUMNS = [
  "market_id", "platform", "external_id", "event_key", "venue_slug", "status", "n_commits", "latest_committed_at", "latest_commitment_sha256",
  "committed_status", "committed_outcome", "evidence_raw_sha256", "evidence_canonical_sha256",
  "official_outcome", "official_at", "official_at_source", "agreement", "lead_seconds", "reconciled_at",
] as const;
export type ExportViewRow = Record<(typeof EXPORT_VIEW_COLUMNS)[number], CsvValue>;

/** The export's columns, in order (CSV header and JSON keys). */
export const EXPORT_COLUMNS = [
  "market_id", "platform", "external_id", "event_key", "venue_slug", "status",
  "committed_at", "commitment_sha256", "committed_status", "committed_outcome", "evidence_raw_sha256", "evidence_canonical_sha256", "n_commits",
  "official_outcome", "official_at", "official_at_source", "agreement", "lead_seconds", "reveal",
] as const;
export type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], CsvValue>;

/**
 * Pure. Whether a row is priced (charge_reveals()): its latest commit is RESOLVED and the market has not settled. A settled
 * market's commits are public (revealIsPublic), and its official_outcome and agreement would give a locked row's outcome
 * away in any case.
 */
export const pricedRow = (v: Pick<ExportViewRow, "committed_status" | "status">): boolean => v.committed_status === "RESOLVED" && !revealIsPublic(v.status);

/**
 * Pure. One export row: the latest commit (the verdict the market stands on) and the final reconciliation. A RESOLVED
 * latest verdict shows only when `reveal` releases it to this tenant; otherwise (locked, or no answer at all: never
 * released by default) committed_status and committed_outcome are empty and `reveal` names why. reveal is the answer's
 * reason for a priced row, public for a RESOLVED row of a settled market (shown, never priced), not_resolved for a commit
 * that is not RESOLVED, empty for a market with no commit yet.
 */
export function exportRow(v: ExportViewRow, reveal: RevealAnswer | null = null): ExportRow {
  const priced = pricedRow(v);
  const hidden = priced && !(reveal !== null && revealReleased(reveal));
  return {
    market_id: v.market_id, platform: v.platform, external_id: v.external_id, event_key: v.event_key, venue_slug: v.venue_slug, status: v.status,
    committed_at: v.latest_committed_at, commitment_sha256: v.latest_commitment_sha256,
    committed_status: hidden ? null : v.committed_status, committed_outcome: hidden ? null : v.committed_outcome,
    evidence_raw_sha256: v.evidence_raw_sha256, evidence_canonical_sha256: v.evidence_canonical_sha256, n_commits: v.n_commits,
    official_outcome: v.official_outcome, official_at: v.official_at, official_at_source: v.official_at_source, agreement: v.agreement,
    lead_seconds: v.lead_seconds === null || v.lead_seconds === undefined ? null : Number(v.lead_seconds),
    reveal: priced ? (reveal?.reason ?? "billing_unavailable") : v.committed_status === "RESOLVED" ? "public" : v.latest_commitment_sha256 ? "not_resolved" : null,
  };
}

/**
 * Pure. The view rows the query exports: the platform filter, then `since` (a row whose latest commit or final
 * reconciliation was recorded at or after it: what changed since a previous export). Only these are priced.
 */
export function selectRows(view: readonly ExportViewRow[], q: Pick<ExportQuery, "platform" | "since">): ExportViewRow[] {
  const since = q.since ? Date.parse(q.since) : null;
  const at = (v: CsvValue) => (typeof v === "string" ? Date.parse(v) : NaN);
  return view
    .filter((v) => !q.platform || v.platform === q.platform)
    .filter((v) => since === null || at(v.latest_committed_at) >= since || at(v.reconciled_at) >= since);
}

/**
 * Pure. Rows for the query (selectRows), each with its reveal answer by market id, ordered by platform, event_key,
 * external_id.
 */
export function exportRows(view: readonly ExportViewRow[], q: Pick<ExportQuery, "platform" | "since">, reveals: ReadonlyMap<string, RevealAnswer> = new Map()): ExportRow[] {
  return selectRows(view, q)
    .map((v) => exportRow(v, reveals.get(String(v.market_id)) ?? null))
    .sort((a, b) => String(a.platform).localeCompare(String(b.platform)) || String(a.event_key).localeCompare(String(b.event_key)) || String(a.external_id).localeCompare(String(b.external_id)));
}

export function exportCsv(rows: readonly ExportRow[]): string {
  return toCsv(EXPORT_COLUMNS, rows);
}

/** Pure. The market ids in reads of at most EXPORT_CHUNK. */
export function chunks<T>(xs: readonly T[], size = EXPORT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

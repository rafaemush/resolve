/**
 * Polymarket candidates (plan §16.4 P5 step 1, §17.3 P5): gamma markets in the deadline window under the $50k cap ->
 * exclusions (sports, price thresholds, X-only sources, no machine-readable primary source) -> one candidate per
 * distinct EVENT (gamma pages are dominated by multi-leg ladders: 100 rows = 15 events at offset 1200, MEASURED) with a
 * representative leg, the leg count and a suggested registration. Pure: scripts/candidates.ts does the fetching.
 */
import { z } from "zod";
import { conditionText, isPriceThreshold, officialReleaseKind, scanSources, sourceRefs, suggestAnchors, toIso, type CandidateEntry, type SourceScan } from "./candidates";

/** The gamma fields this module reads; everything else on the row is ignored. */
export const GammaRow = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  question: z.string().min(1),
  slug: z.string().nullish(),
  conditionId: z.string().nullish(),
  questionID: z.string().nullish(),
  description: z.string().nullish(),
  resolutionSource: z.string().nullish(),
  endDate: z.string().nullish(),
  startDate: z.string().nullish(),
  createdAt: z.string().nullish(),
  volumeNum: z.number().nullish(),
  outcomes: z.unknown(),
  negRisk: z.boolean().nullish(),
  groupItemTitle: z.string().nullish(),
  closed: z.boolean().nullish(),
  tags: z.array(z.object({ slug: z.string() }).loose()).nullish(),
  events: z.array(z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    title: z.string().nullish(),
    slug: z.string().nullish(),
    seriesSlug: z.string().nullish(),
    resolutionSource: z.string().nullish(),
  }).loose()).nullish(),
}).loose();
export type GammaRow = z.infer<typeof GammaRow>;

/** gamma tag slugs of sports and e-sports markets (checked on 2026-09-24's 13k-row window: 6,491 rows carry "sports"). */
export const SPORT_TAGS: ReadonlySet<string> = new Set(["sports", "esports", "games", "soccer", "basketball", "baseball", "hockey", "tennis", "golf", "f1", "formula1", "ufc", "mma", "boxing", "cricket", "nfl", "nba", "mlb", "nhl", "cfb", "ncaa", "rugby", "chess", "olympics"]);
/** gamma tag slugs of price-threshold / up-or-down markets. */
export const PRICE_TAGS: ReadonlySet<string> = new Set(["crypto-prices", "hit-price", "multi-strikes", "up-or-down", "finance-updown", "stock-prices", "daily-close", "weekly-close", "pyth-finance"]);

export type PolymarketExclusion = "schema" | "not_binary" | "closed" | "volume_cap" | "outside_window" | "sports" | "price" | "requires_x" | "no_primary_source";

export function outcomesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== "string") return [];
  try { const a: unknown = JSON.parse(v); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

export interface Window { now: Date; days: number; maxVolume: number }

export type Classified =
  | { kind: "excluded"; reason: PolymarketExclusion; row: GammaRow }
  | { kind: "kept"; row: GammaRow; scan: SourceScan; tags: string[] };

const eventOf = (r: GammaRow) => r.events?.[0] ?? null;
export const eventKey = (r: GammaRow) => { const e = eventOf(r); return e ? `event:${e.id}` : `market:${r.id}`; };

/**
 * Pure. Deterministic filters in a fixed order, re-checking what gamma was asked to filter (a query parameter is not
 * trusted as a guarantee): closed, volume cap, deadline window, binary outcomes, sports, price, X-only, primary source.
 */
export function classifyGamma(row: GammaRow, w: Window): Classified {
  const ex = (reason: PolymarketExclusion): Classified => ({ kind: "excluded", reason, row });
  if (row.closed === true) return ex("closed");
  if ((row.volumeNum ?? 0) > w.maxVolume) return ex("volume_cap");
  const end = row.endDate ? Date.parse(row.endDate) : NaN;
  if (!Number.isFinite(end) || end <= w.now.getTime() || end > w.now.getTime() + w.days * 86_400_000) return ex("outside_window");
  if (outcomesOf(row.outcomes).length !== 2) return ex("not_binary");
  const tags = (row.tags ?? []).map((t) => t.slug.toLowerCase());
  if (tags.some((t) => SPORT_TAGS.has(t))) return ex("sports");
  if (tags.some((t) => PRICE_TAGS.has(t)) || isPriceThreshold(row.question)) return ex("price");
  const e = eventOf(row);
  const subject = `${row.question}\n${e?.title ?? ""}`;
  const scan = scanSources(subject, [row.description], [row.resolutionSource, e?.resolutionSource]);
  if (scan.requiresX) return ex("requires_x");
  if (!scan.tier) return ex("no_primary_source");
  return { kind: "kept", row, scan, tags };
}

export interface PolymarketBuild {
  entries: CandidateEntry[];
  counts: {
    markets_fetched: number;
    events_fetched: number;
    markets_excluded: Record<PolymarketExclusion, number>;
    /** Events with no kept leg, by the reason of their first leg (the reasons of one event's legs almost always agree). */
    events_excluded: Record<PolymarketExclusion, number>;
    events_kept: number;
    legs_in_kept_events: number;
    events_with_tier_a_source: number;
    events_with_tier_b_source_only: number;
    requires_x_events: number;
    official_release_events: number;
  };
}

const zeroReasons = (): Record<PolymarketExclusion, number> => ({ schema: 0, not_binary: 0, closed: 0, volume_cap: 0, outside_window: 0, sports: 0, price: 0, requires_x: 0, no_primary_source: 0 });

const RECURRING_TAGS = new Set(["recurring", "daily", "daily-temperature", "highest-temperature", "lowest-temperature", "weekly"]);
/** Display tags that say nothing about the subject; skipped when a tag becomes meta.category. */
const NOISE_TAGS = new Set(["hide-from-new", "recurring", "daily", "weekly", "monthly", "neg-risk", "featured", "trending", "new"]);

/**
 * Pure. Dedupe by event and score. Representative leg = the kept leg with the most volume (then the lowest id), so the
 * candidate is the leg the market actually trades. Score (higher first) = 2 x source tier (A = 1, B = 2/3)
 * + earliness (1 at now, 0 at the window's end) + 0.5 x deadline density (the share of the busiest deadline day that
 * this event's day holds, so clusters of reveals rank together) + 0.5 for an official-release family (the P1a rail's
 * scope) - 0.5 for a recurring daily/weekly series.
 */
export function buildPolymarket(raw: unknown[], w: Window): PolymarketBuild {
  const counts: PolymarketBuild["counts"] = {
    markets_fetched: raw.length, events_fetched: 0, markets_excluded: zeroReasons(), events_excluded: zeroReasons(),
    events_kept: 0, legs_in_kept_events: 0, events_with_tier_a_source: 0, events_with_tier_b_source_only: 0, requires_x_events: 0, official_release_events: 0,
  };
  const byEvent = new Map<string, { legs: GammaRow[]; kept: Array<Extract<Classified, { kind: "kept" }>>; firstReason: PolymarketExclusion | null; requiresX: boolean }>();
  for (const r of raw) {
    const p = GammaRow.safeParse(r);
    if (!p.success) { counts.markets_excluded.schema++; continue; }
    const c = classifyGamma(p.data, w);
    const key = eventKey(p.data);
    const ev = byEvent.get(key) ?? { legs: [], kept: [], firstReason: null, requiresX: false };
    byEvent.set(key, ev);
    ev.legs.push(p.data);
    if (c.kind === "kept") ev.kept.push(c);
    else {
      counts.markets_excluded[c.reason]++;
      ev.firstReason ??= c.reason;
      if (c.reason === "requires_x") ev.requiresX = true;
    }
  }
  counts.events_fetched = byEvent.size;

  const kept: Array<{ key: string; legs: GammaRow[]; rep: Extract<Classified, { kind: "kept" }> }> = [];
  for (const [key, ev] of byEvent) {
    if (!ev.kept.length) {
      counts.events_excluded[ev.firstReason ?? "schema"]++;
      if (ev.requiresX) counts.requires_x_events++;
      continue;
    }
    const rep = [...ev.kept].sort((a, b) => (b.row.volumeNum ?? 0) - (a.row.volumeNum ?? 0) || Number(a.row.id) - Number(b.row.id))[0]!;
    kept.push({ key, legs: ev.legs, rep });
  }

  const day = (r: GammaRow) => (r.endDate ?? "").slice(0, 10);
  const perDay = new Map<string, number>();
  for (const k of kept) perDay.set(day(k.rep.row), (perDay.get(day(k.rep.row)) ?? 0) + 1);
  const busiest = Math.max(1, ...perDay.values());

  const entries: CandidateEntry[] = [];
  for (const { legs, rep } of kept) {
    const r = rep.row;
    const e = eventOf(r);
    const outcomes = outcomesOf(r.outcomes);
    const subject = `${r.question} ${e?.title ?? ""}`;
    const official = officialReleaseKind(subject);
    const deadline = toIso(r.endDate)!;
    const earliness = Math.max(0, Math.min(1, 1 - (Date.parse(deadline) - w.now.getTime()) / (w.days * 86_400_000)));
    const density = (perDay.get(day(r)) ?? 0) / busiest;
    const tierScore = rep.scan.tier === "A" ? 1 : 2 / 3;
    const recurring = rep.tags.some((t) => RECURRING_TAGS.has(t));
    const score = Math.round((2 * tierScore + earliness + 0.5 * density + (official ? 0.5 : 0) - (recurring ? 0.5 : 0)) * 1000) / 1000;

    const cond = conditionText(r.description ?? "", r.question);
    const yesNo = outcomes[0]!.trim().toLowerCase() === "yes" && outcomes[1]!.trim().toLowerCase() === "no";
    // The platform's question ("Will the 5-year Treasury yield dip below 4.52% in September?") is only a starting point:
    // Jev's options are built from event_statement (src/resolve/jev.ts), which must be a declarative, deadline-free fact.
    const needs = ["anchors", "event_statement"];
    if (!yesNo) needs.push("positive_option");
    if (cond.truncated) needs.push("condition");
    if (rep.scan.bareDomain || rep.scan.primary.some((c) => !c.url.startsWith("https://"))) needs.push("sources");
    if (!r.conditionId) needs.push("meta.condition_id");
    const openAt = toIso(r.startDate) ?? toIso(r.createdAt) ?? w.now.toISOString();
    const meta: Record<string, unknown> = {};
    if (r.conditionId) meta.condition_id = r.conditionId;
    if (r.slug) meta.slug = r.slug;
    if (e) meta.event_id = e.id;
    if (r.questionID) meta.question_id = r.questionID;
    if (typeof r.negRisk === "boolean") meta.neg_risk = r.negRisk;
    meta.category = official ?? rep.tags.find((t) => !NOISE_TAGS.has(t) && !t.startsWith("rewards-")) ?? "uncategorized";

    counts.events_kept++;
    counts.legs_in_kept_events += legs.length;
    if (rep.scan.tier === "A") counts.events_with_tier_a_source++; else counts.events_with_tier_b_source_only++;
    if (official) counts.official_release_events++;

    entries.push({
      approved: false,
      needs_review: needs,
      volume_usd: Math.round((r.volumeNum ?? 0) * 100) / 100,
      score,
      score_parts: { source_tier: rep.scan.tier, earliness: Math.round(earliness * 1000) / 1000, density: Math.round(density * 1000) / 1000, official_release: official, recurring },
      event: { id: e?.id ?? null, title: e?.title ?? r.question, slug: e?.slug ?? null, url: e?.slug ? `https://polymarket.com/event/${e.slug}` : null, series: e?.seriesSlug ?? null, legs: legs.length, leg_ids: legs.map((l) => l.id) },
      representative_leg: { id: r.id, question: r.question, label: r.groupItemTitle ?? null },
      tags: rep.tags,
      sources_found: { primary: rep.scan.primary.map((c) => ({ url: c.url, class: c.cls })), other: rep.scan.other.map((c) => ({ url: c.url, class: c.cls })) },
      resolver_hint: official ? "official_release" : rep.scan.primary.some((c) => c.cls === "github") ? "github" : rep.scan.primary.some((c) => c.cls === "onchain") ? "onchain" : "jev_web",
      registration: {
        market: {
          platform: "polymarket",
          external_id: r.id,
          condition: cond.condition,
          event_statement: r.question.slice(0, 1000),
          option_a: outcomes[0]!,
          option_b: outcomes[1]!,
          positive_option: "OPTION_A",
          anchors: suggestAnchors(r.question, r.groupItemTitle),
          sources: sourceRefs(rep.scan.primary),
          open_at: openAt,
          deadline_utc: deadline,
          // A published value or declared winner makes the negative explicit; "happens by" markets rest on absence.
          negative_rule: official ? "explicit_negative" : "absence_after_deadline",
        },
        meta,
        is_test: false,
      },
    });
  }
  entries.sort((a, b) => (b.score as number) - (a.score as number) || String(a.registration.market.deadline_utc).localeCompare(String(b.registration.market.deadline_utc)));
  return { entries, counts };
}

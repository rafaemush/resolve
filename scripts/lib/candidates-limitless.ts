/**
 * Limitless candidates (plan §16.4 P5 step 2, §17.1, §17.3 P5): every active manual market expiring within the window,
 * classified and scored for checkability, with a suggested registration per registrable market. A group market (a
 * negRisk ladder such as "Fed Decision in October?") has no outcome of its own (reconcile refuses a container slug), so
 * each leg is its own entry, tagged with its group and one leg per group marked representative. Pure: scripts/candidates.ts
 * does the fetching.
 */
import { z } from "zod";
import { conditionText, officialReleaseKind, PRICE_WORDING, scanSources, sourceRefs, stripHtml, suggestAnchors, toIso, type CandidateEntry, type OfficialKind, type SourceScan } from "./candidates";

const LimitlessLeg = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullish(),
  conditionId: z.string().nullish(),
  groupId: z.union([z.number(), z.string()]).nullish(),
  createdAt: z.string().nullish(),
  expirationTimestamp: z.number().nullish(),
  volumeFormatted: z.string().nullish(),
  tradeType: z.string().nullish(),
  outcomeTokens: z.array(z.string()).nullish(),
  tokens: z.record(z.string(), z.unknown()).nullish(),
  orderInGroup: z.number().nullish(),
  status: z.string().nullish(),
  expired: z.boolean().nullish(),
}).loose();
type LimitlessLeg = z.infer<typeof LimitlessLeg>;

/** The /markets/active row: a single market, or a group container whose legs are in `markets`. */
export const LimitlessRow = LimitlessLeg.extend({
  id: z.union([z.number(), z.string()]).transform(String),
  automationType: z.string(),
  marketType: z.string().nullish(),
  categories: z.array(z.string()).nullish(),
  properties: z.array(z.object({ propertyKeySlug: z.string(), value: z.array(z.string()).nullish() }).loose()).nullish(),
  markets: z.array(LimitlessLeg).nullish(),
}).loose();
export type LimitlessRow = z.infer<typeof LimitlessRow>;

export type LimitlessCategory = "official_release" | "price" | "sports" | "politics" | "specials" | "pre_tge" | "company_news" | "other";

const SPORT_CATEGORIES = new Set(["sports", "football", "esports", "f1", "nhl", "nba", "nfl", "mlb", "tennis", "cricket", "ufc", "mma", "soccer", "basketball"]);
/** Limitless ladders read "What will Gold (XAUUSD) hit ...", "Ethereum ATH by ___" on top of the shared wording. */
const LADDER_TEXT = /\bwhat (price )?will .{1,60}\bhit\b|\bATH\b/i;
const PRE_TGE_TEXT = /\b(launch a token|token launch|TGE|airdrop|FDV)\b/i;
const COMPANY_TEXT = /\b(earnings|revenue|IPO|quarterly results|guidance)\b/i;

export interface ClassifyInput { title: string; categories: string[]; automationType: string; properties?: Array<{ propertyKeySlug: string; value?: string[] | null }> | null }

/**
 * Pure. First match wins: sports (sports automation or category, a "A vs. B" title outside politics, or the "sport"
 * domain property unless Limitless filed it under Politics or Specials: the Ballon d'Or is an award announcement, not a
 * fixture) -> official release (CPI/PPI/PCE/GDP/exports/PMI prints, central-bank decisions, election results; Limitless
 * files most of these under "Crypto", so the words decide, never the category) -> pre_tge -> price -> company_news ->
 * politics -> specials -> other.
 */
export function classifyLimitless(m: ClassifyInput): { category: LimitlessCategory; official: OfficialKind | null } {
  const text = m.title;
  const cats = m.categories.map((c) => c.toLowerCase());
  const filedElsewhere = cats.includes("politics") || cats.includes("specials");
  const sportProperty = (m.properties ?? []).some((p) => p.propertyKeySlug === "domain" && (p.value ?? []).includes("sport"));
  if (m.automationType === "sports" || cats.some((c) => SPORT_CATEGORIES.has(c)) || (!cats.includes("politics") && /\bvs\.?\s/i.test(text)) || (sportProperty && !filedElsewhere)) return { category: "sports", official: null };
  const official = officialReleaseKind(text);
  if (official) return { category: "official_release", official };
  if (cats.includes("pre-tge") || PRE_TGE_TEXT.test(text)) return { category: "pre_tge", official: null };
  if (LADDER_TEXT.test(text) || PRICE_WORDING.test(text)) return { category: "price", official: null };
  if (cats.includes("company news") || cats.includes("earnings") || COMPANY_TEXT.test(text)) return { category: "company_news", official: null };
  if (cats.includes("politics")) return { category: "politics", official: null };
  if (cats.includes("specials")) return { category: "specials", official: null };
  return { category: "other", official: null };
}

/**
 * Pure. 0 (not checkable now) .. 4. Base by category: official_release 3 (deterministic rail in P1a's scope), pre_tge /
 * company_news / politics / specials / other 2 with a first-party source URL else 1 (web evidence through the model),
 * price 1 (the any-touch rail is not built), sports 0 (rail removed, plan §17.1). +1 for a tier-A source URL. X-only
 * sources and AMM legs without outcome labels (reconcile cannot map them) are 0.
 */
export function checkability(category: LimitlessCategory, scan: SourceScan, labelled: boolean): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  if (!labelled) return { score: 0, reasons: ["no outcome labels on the market (AMM): reconcile cannot map the official outcome"] };
  if (scan.requiresX) return { score: 0, reasons: ["only X/Twitter sources: abstains (plan §17.3)"] };
  let base: number;
  switch (category) {
    case "sports": return { score: 0, reasons: ["sports: no rail (plan §17.1)"] };
    case "price": base = 1; reasons.push("price: the any-touch rail is not built"); break;
    case "official_release": base = 3; reasons.push("official release: deterministic rail scope (P1a)"); break;
    case "pre_tge": case "company_news": case "politics": case "specials": case "other":
      base = scan.tier ? 2 : 1;
      reasons.push(scan.tier ? `${category}: first-party source URL` : `${category}: no first-party source URL`);
      break;
    default: { const never: never = category; throw new Error(`unknown category ${String(never)}`); }
  }
  if (scan.tier === "A") { base += 1; reasons.push("tier-A source (official, chain or GitHub)"); }
  return { score: base, reasons };
}

export interface LimitlessWindow { now: Date; days: number; maxVolume: number }

export interface LimitlessBuild {
  entries: CandidateEntry[];
  counts: {
    rows_fetched: number;
    manual_rows: number;
    /** Rows the feed returned with automationType other than manual although the query asked for manual. */
    non_manual_rows_dropped: number;
    schema_rows_dropped: number;
    manual_markets_in_window: number;
    legs_in_window: number;
    /** Legs of an in-window group whose own expiry is already past or beyond the window (e.g. "Fed rate cut by __?" June leg). */
    legs_outside_window: number;
    markets_by_category: Record<LimitlessCategory, number>;
    legs_by_category: Record<LimitlessCategory, number>;
    requires_x_legs: number;
    unlabelled_amm_legs: number;
    over_volume_cap_legs: number;
  };
}

const zeroCats = (): Record<LimitlessCategory, number> => ({ official_release: 0, price: 0, sports: 0, politics: 0, specials: 0, pre_tge: 0, company_news: 0, other: 0 });

const usd = (l: LimitlessLeg) => { const v = Number(l.volumeFormatted ?? 0); return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0; };
/**
 * Reconcile reads the labels from the registered market's own object (GET /markets/{slug}): outcomeTokens, or tokens
 * {yes, no} (src/jobs/reconcile.ts limitlessLabels). A group's outcomeTokens are not on its legs, so they do not count.
 */
const labelled = (leg: LimitlessLeg) => (leg.outcomeTokens?.length ?? 0) >= 2 || (!!leg.tokens && "yes" in leg.tokens && "no" in leg.tokens);

export function buildLimitless(raw: unknown[], w: LimitlessWindow): LimitlessBuild {
  const counts: LimitlessBuild["counts"] = {
    rows_fetched: raw.length, manual_rows: 0, non_manual_rows_dropped: 0, schema_rows_dropped: 0, manual_markets_in_window: 0, legs_in_window: 0, legs_outside_window: 0,
    markets_by_category: zeroCats(), legs_by_category: zeroCats(), requires_x_legs: 0, unlabelled_amm_legs: 0, over_volume_cap_legs: 0,
  };
  const entries: CandidateEntry[] = [];
  const horizon = w.now.getTime() + w.days * 86_400_000;
  for (const r of raw) {
    const p = LimitlessRow.safeParse(r);
    if (!p.success) { counts.schema_rows_dropped++; continue; }
    const row = p.data;
    // The feed's automationType filter is not trusted: 47 of 296 rows came back "sports" on 2026-09-24.
    if (row.automationType !== "manual") { counts.non_manual_rows_dropped++; continue; }
    counts.manual_rows++;
    const exp = row.expirationTimestamp ?? NaN;
    if (!Number.isFinite(exp) || exp <= w.now.getTime() || exp > horizon) continue;
    const group = row.markets?.length ? row : null;
    const legs: LimitlessLeg[] = group ? [...row.markets!].sort((a, b) => (a.orderInGroup ?? 0) - (b.orderInGroup ?? 0)) : [row];
    const { category, official } = classifyLimitless({ title: row.title, categories: row.categories ?? [], automationType: row.automationType, properties: row.properties });
    counts.manual_markets_in_window++;
    counts.markets_by_category[category]++;
    const expiry = (leg: LimitlessLeg) => leg.expirationTimestamp ?? exp;
    const inWindow = legs.filter((leg) => expiry(leg) > w.now.getTime() && expiry(leg) <= horizon);
    counts.legs_outside_window += legs.length - inWindow.length;
    // The most-traded in-window leg; the group's order breaks ties.
    const representative = [...inWindow].sort((a, b) => usd(b) - usd(a) || (a.orderInGroup ?? 0) - (b.orderInGroup ?? 0))[0]?.slug;
    for (const leg of inWindow) {
      const legExp = expiry(leg);
      counts.legs_in_window++;
      counts.legs_by_category[category]++;
      const descHtml = leg.description ?? row.description ?? "";
      const desc = stripHtml(descHtml);
      const statement = group ? `${row.title} — ${leg.title}` : row.title;
      const scan = scanSources(`${row.title} ${leg.title}`, [descHtml]);
      const hasLabels = labelled(leg);
      const check = checkability(category, scan, hasLabels);
      if (scan.requiresX) counts.requires_x_legs++;
      if (!hasLabels) counts.unlabelled_amm_legs++;
      const volume = usd(leg);
      if (volume > w.maxVolume) counts.over_volume_cap_legs++;
      const cond = conditionText(desc, statement);
      const deadline = new Date(legExp).toISOString();
      const needs = ["anchors"];
      if (!scan.tier || scan.bareDomain || scan.primary.some((c) => !c.url.startsWith("https://"))) needs.push("sources");
      if (!hasLabels) needs.push("options");
      if (cond.truncated) needs.push("condition");
      if (!leg.conditionId) needs.push("meta.condition_id");
      const meta: Record<string, unknown> = { slug: leg.slug, category };
      if (leg.conditionId) meta.condition_id = leg.conditionId;
      if (group) meta.group_id = row.id;
      entries.push({
        approved: false,
        needs_review: needs,
        volume_usd: volume,
        checkability: check.score,
        checkability_reasons: check.reasons,
        category,
        official_kind: official,
        requires_x: scan.requiresX,
        trade_type: leg.tradeType ?? row.tradeType ?? null,
        group: group ? { id: row.id, slug: row.slug, title: row.title, legs: legs.length } : null,
        representative: leg.slug === representative,
        url: `https://limitless.exchange/markets/${leg.slug}`,
        limitless_categories: row.categories ?? [],
        sources_found: { primary: scan.primary.map((c) => ({ url: c.url, class: c.cls })), other: scan.other.map((c) => ({ url: c.url, class: c.cls })) },
        resolver_hint: category === "official_release" ? "official_release" : category === "price" ? "price_touch (not built)" : category === "sports" ? "none" : "jev_web",
        registration: {
          market: {
            platform: "limitless",
            external_id: leg.slug,
            condition: cond.condition,
            event_statement: statement.slice(0, 1000),
            // Reconcile maps the official label (outcomeTokens, or YES = 0 / NO = 1 from tokens) by exact text.
            option_a: "Yes",
            option_b: "No",
            positive_option: "OPTION_A",
            anchors: suggestAnchors(group ? row.title : leg.title, group ? leg.title : null),
            sources: sourceRefs(scan.primary),
            open_at: toIso(leg.createdAt) ?? toIso(row.createdAt) ?? w.now.toISOString(),
            deadline_utc: deadline,
            negative_rule: category === "official_release" ? "explicit_negative" : "absence_after_deadline",
          },
          meta,
          is_test: false,
        },
      });
    }
  }
  entries.sort((a, b) => String(a.registration.market.deadline_utc).localeCompare(String(b.registration.market.deadline_utc))
    || String((a.group as { slug?: string } | null)?.slug ?? a.registration.market.external_id).localeCompare(String((b.group as { slug?: string } | null)?.slug ?? b.registration.market.external_id)));
  return { entries, counts };
}

/** Pure. Manual markets created after `since` among the fetched rows (the weekly re-scan's creation-cadence number, plan §17.3). */
export function createdSince(raw: unknown[], since: Date): number {
  let n = 0;
  for (const r of raw) {
    const p = LimitlessRow.safeParse(r);
    if (!p.success || p.data.automationType !== "manual") continue;
    const t = Date.parse(p.data.createdAt ?? "");
    if (Number.isFinite(t) && t > since.getTime()) n++;
  }
  return n;
}

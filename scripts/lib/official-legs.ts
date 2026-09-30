/**
 * The testable parts of scripts/official-legs.ts: the built-in ladder groups, its arguments (those groups, or one
 * ad-hoc group named on the command line), the private/ output rule, the read of stored first prints
 * (official_observations, migration 016) through a client the caller supplies, the prior_level of every rate-change
 * group (src/markets/official-legs.ts derivePriorLevel / priorForGroup), and the run itself (suggestLegs) over the
 * platform reads the caller supplies. No network and no database here: the script builds the fetch and the client.
 */
import { z } from "zod";
import { OFFICIAL_SERIES, OfficialCorroboration, UNSUPPORTED_OFFICIAL_SERIES, knownRelease, periodValid, type OfficialSeriesId } from "../../src/resolve/official";
import { isElectionSeries } from "../../src/resolve/election";
import {
  buildLegRegistration, derivePriorLevel, platformPeriodProblem, priorForGroup, releasedPrevious, titlePeriodProblem, type FirstPrintLookup, type LegGroup, type StoredFirstPrint,
} from "../../src/markets/official-legs";
import { limitlessLabels, limitlessOutcomeIndex } from "../../src/markets/outcomes";
import { validateRegistration } from "../../src/markets/register";
import type { MarketRegistration } from "../../src/resolve/schema";
import { redact } from "../../src/ops/redact";

export class UsageError extends Error {}
export const DEFAULT_OUT = "private/shadow-markets/official-release-2026-09-24.json";
export const USAGE = [
  "usage: npx tsx scripts/official-legs.ts [--only <series>[,<series>...]] [--out private/<file>.json]",
  "       npx tsx scripts/official-legs.ts (--pm-slug <polymarket event slug> | --lm-slug <limitless group slug>) --series <id> --period <period> --title <ladder title> [--out private/<file>.json]",
].join("\n");

// ---- the ladder groups ----------------------------------------------------------------------------------------------

/**
 * slug: a Limitless group (its Polymarket mirror is found through externalSlug); pmSlug: a Polymarket-only event.
 * adhoc: named on the command line, so the platform's own title and texts must be about its period (suggestLegs).
 */
export interface Group extends LegGroup { slug?: string; pmSlug?: string; basis: string; adhoc?: true }

/** release_at comes from the event registry (src/resolve/official.ts KNOWN_RELEASES): registration refuses any other. */
const scheduled = (series: LegGroup["series"], period: string): string => {
  const k = knownRelease(series, period);
  if (!k) throw new Error(`${series}:${period} is not in KNOWN_RELEASES`);
  return k.release_at;
};

const BLS_CPI_BASIS = "BLS CPI schedule: September 2026 -> Oct. 14, 2026 08:30 AM ET (observed 2026-09-27); Table A of the release";
const BLS_EMPSIT_BASIS = "BLS Employment Situation schedule: September 2026 -> Oct. 02, 2026 08:30 AM ET (observed 2026-09-27); the platform endDate (08:30Z) is not the release time";
/** The built-in ladders: the eight Limitless manual negRisk groups (Polymarket mirrors through externalSlug), then the Polymarket-only ones. */
export const GROUPS: readonly Group[] = [
  { slug: "september-inflation-us-annual-1789462576803", series: "us_cpi_u_nsa_yoy", period: "2026-09", release_at: scheduled("us_cpi_u_nsa_yoy", "2026-09"), title: "September Inflation US - Annual",
    basis: "BLS CPI schedule: September 2026 -> Oct. 14, 2026 08:30 AM ET (observed)" },
  { slug: "ppi-yoy-september-2026-1789463068607", series: "us_ppi_fd_nsa_yoy", period: "2026-09", release_at: scheduled("us_ppi_fd_nsa_yoy", "2026-09"), title: "PPI YoY - September 2026",
    basis: "BLS PPI schedule: September 2026 -> Oct. 15, 2026 08:30 AM ET (observed)" },
  { slug: "bank-of-korea-decision-in-october-1788169618885", series: "bok_base_rate", period: "2026-10-22", release_at: scheduled("bok_base_rate", "2026-10-22"), prior_level: 3.0, title: "Bank of Korea decision in October?",
    basis: "BoK 2026 MPB dates PDF: October Thursday 22 (observed); 10:00 KST decision time UNVERIFIED (earlier decision items are stamped 10:30 KST); prior 3.00% (raised 2026-08-27)" },
  { slug: "south-korea-gdp-growth-yoy-in-q3-2026-1786348145771", series: "kr_gdp_advance_yoy", period: "2026-Q3", release_at: scheduled("kr_gdp_advance_yoy", "2026-Q3"), title: "South Korea GDP growth (YoY) in Q3 2026?",
    basis: "BoK statistical calendar: 2026-10-27 08:00 KST Real GDP Q3 advance (observed)" },
  { slug: "fed-decision-in-october-1786349804918", series: "fomc_upper_bound", period: "2026-10-28", release_at: scheduled("fomc_upper_bound", "2026-10-28"), prior_level: 4.0, title: "Fed Decision in October?",
    basis: "FOMC calendar: October 27-28 (observed); 2:00 p.m. EDT statement time from the September statement (UNVERIFIED for October); prior upper bound 4.00 (September 16)" },
  { slug: "ecb-interest-rates-october-2026-1789050608644", series: "ecb_dfr", period: "2026-10-29", release_at: scheduled("ecb_dfr", "2026-10-29"), prior_level: 2.5, title: "ECB Interest Rates: October 2026",
    basis: "ECB calendar: 29/10/2026 meeting day 2 (observed); 14:15 CET release time UNVERIFIED; prior DFR 2.50% (September 10, effective 16th)" },
  { slug: "bank-of-brazil-decision-in-november-1789385653368", series: "bcb_selic_target", period: "2026-11-04", release_at: scheduled("bcb_selic_target", "2026-11-04"), prior_level: 13.75, title: "Bank of Brazil decision in November?",
    basis: "Copom November 3-4 (SGS 432 fill ends 04/11/2026; the official calendar page is JS-only); ~18:30 BRT decision time UNVERIFIED; prior Selic 13.75% (meeting 281)" },
  { slug: "bank-of-england-decision-in-november-1789387521621", series: "boe_bank_rate", period: "2026-11-05", release_at: scheduled("boe_bank_rate", "2026-11-05"), prior_level: 3.75, title: "Bank of England decision in November?",
    basis: "BoE MPC dates: Thursday 5 November (observed); 12:00 UK (GMT) from the September pattern (UNVERIFIED for November); prior Bank Rate 3.75%" },
  // Polymarket-only BLS ladders (gamma events observed 2026-09-27; no Limitless group). Titles as on the platform.
  { pmSlug: "september-inflation-us-monthly", series: "us_cpi_u_sa_mom", period: "2026-09", release_at: scheduled("us_cpi_u_sa_mom", "2026-09"), title: "September Inflation US - Monthly", basis: BLS_CPI_BASIS },
  { pmSlug: "core-cpi-yoy-september-2026", series: "us_core_cpi_nsa_yoy", period: "2026-09", release_at: scheduled("us_core_cpi_nsa_yoy", "2026-09"), title: "Core CPI YoY - September 2026", basis: BLS_CPI_BASIS },
  { pmSlug: "core-cpi-mom-september-2026", series: "us_core_cpi_sa_mom", period: "2026-09", release_at: scheduled("us_core_cpi_sa_mom", "2026-09"), title: "Core CPI MoM - September 2026", basis: BLS_CPI_BASIS },
  { pmSlug: "september-unemployment-rate-2026", series: "us_unemployment_rate", period: "2026-09", release_at: scheduled("us_unemployment_rate", "2026-09"), title: "September Unemployment Rate", basis: BLS_EMPSIT_BASIS },
  { pmSlug: "how-many-jobs-added-in-september-2026", series: "us_nonfarm_payrolls_change", period: "2026-09", release_at: scheduled("us_nonfarm_payrolls_change", "2026-09"), title: "How many jobs added in September?", basis: BLS_EMPSIT_BASIS },
];
export const REFUSED = [{ slug: "bank-of-japan-decision-in-october-1789388114859", series: "boj_policy_rate", title: "Bank of Japan Decision in October?" }] as const;

// ---- arguments ----------------------------------------------------------------------------------------------------

/** A ladder named on the command line: exactly one platform slug; release_at and basis come from KNOWN_RELEASES. */
export interface AdhocGroup { pmSlug?: string; slug?: string; series: OfficialSeriesId; period: string; title: string }
export interface LegArgs { out: string; only: string[] | null; adhoc: AdhocGroup | null }

const FLAGS = ["--only", "--out", "--pm-slug", "--lm-slug", "--series", "--period", "--title"] as const;
type Flag = (typeof FLAGS)[number];
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;

export function parseLegArgs(argv: readonly string[]): LegArgs {
  const seen = new Map<Flag, string>();
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf("=");
    const flag = (raw.startsWith("--") && eq > 0 ? raw.slice(0, eq) : raw) as Flag;
    if (!FLAGS.includes(flag)) throw new UsageError(`unknown argument "${raw}"`);
    const value = eq > 0 ? raw.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith("--") || !value.trim()) throw new UsageError(`${flag} needs a value`);
    if (seen.has(flag)) throw new UsageError(`${flag} given twice`);
    seen.set(flag, value.trim());
  }
  const only = seen.get("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const named = (["--pm-slug", "--lm-slug", "--series", "--period", "--title"] as const).filter((f) => seen.has(f));
  if (!named.length) return { out: seen.get("--out") ?? DEFAULT_OUT, only, adhoc: null };

  // one ad-hoc group: every field named, one platform
  if (only) throw new UsageError("--only selects built-in groups; it cannot be combined with an ad-hoc group");
  const pm = seen.get("--pm-slug"), lm = seen.get("--lm-slug");
  if (!pm === !lm) throw new UsageError("an ad-hoc group needs exactly one of --pm-slug or --lm-slug");
  for (const f of ["--series", "--period", "--title"] as const) if (!seen.has(f)) throw new UsageError(`an ad-hoc group needs ${f}`);
  const slug = (pm ?? lm)!;
  if (!SLUG.test(slug)) throw new UsageError(`${pm ? "--pm-slug" : "--lm-slug"} must be a platform slug (lowercase letters, digits and hyphens), got "${slug}"`);
  const series = seen.get("--series")!;
  if (UNSUPPORTED_OFFICIAL_SERIES[series]) throw new UsageError(`--series ${series} is refused: ${UNSUPPORTED_OFFICIAL_SERIES[series]}`);
  if (!Object.hasOwn(OFFICIAL_SERIES, series)) throw new UsageError(`--series ${series} is not an official_release series`);
  if (isElectionSeries(series)) throw new UsageError(`--series ${series} is an election series: its legs are built by scripts/election-legs.ts`);
  const id = series as OfficialSeriesId;
  const period = seen.get("--period")!;
  if (!periodValid(id, period)) throw new UsageError(`--period ${period} is not a ${OFFICIAL_SERIES[id].period} period for ${series}`);
  if (!knownRelease(id, period)) throw new UsageError(`${series}:${period} is not in KNOWN_RELEASES (src/resolve/official.ts, extended from src/resolve/release-calendar.ts): its release time is not known, so no leg is suggested`);
  const title = seen.get("--title")!;
  if (title.length > 200) throw new UsageError("--title is longer than 200 characters");
  // the one typed period must be the ladder's: its title names that month (or quarter) and no other
  const off = titlePeriodProblem(id, period, title);
  if (off) throw new UsageError(`--title: ${off}; give the ladder's title as the platform shows it`);
  return { out: seen.get("--out") ?? `private/shadow-markets/official-release-${series}-${period}.json`, only: null, adhoc: { ...(pm ? { pmSlug: pm } : { slug: lm! }), series: id, period, title } };
}

/**
 * The groups a run suggests: the ad-hoc one (release_at and basis from the registry, which parseLegArgs required), or
 * the built-in groups, all or those of the --only series (a series without a built-in group is a usage error).
 */
export function selectGroups(args: Pick<LegArgs, "only" | "adhoc">, groups: readonly Group[] = GROUPS): Group[] {
  const { only, adhoc } = args;
  if (adhoc) {
    const k = knownRelease(adhoc.series, adhoc.period);
    if (!k) throw new UsageError(`${adhoc.series}:${adhoc.period} is not in KNOWN_RELEASES`);
    return [{ ...(adhoc.pmSlug ? { pmSlug: adhoc.pmSlug } : { slug: adhoc.slug! }), series: adhoc.series, period: adhoc.period, release_at: k.release_at, title: adhoc.title, basis: k.basis, adhoc: true }];
  }
  for (const s of only ?? []) if (!groups.some((g) => g.series === s)) throw new UsageError(`--only ${s}: no ladder group for that series`);
  return groups.filter((g) => !only || only.includes(g.series));
}

/**
 * Pure. Why an output file is refused, or null. The file copies platform market texts, so it is written only under
 * the repository's private/ directory (gitignored), as JSON.
 */
export function outPathRefusal(repoRoot: string, resolvedOut: string): string | null {
  const priv = `${repoRoot.replace(/\/+$/, "")}/private/`;
  if (!resolvedOut.startsWith(priv)) return `--out must be inside ${priv} (gitignored): the file copies platform market texts and is never committed`;
  return resolvedOut.endsWith(".json") ? null : "--out must name a .json file";
}

// ---- stored first prints ------------------------------------------------------------------------------------------

type Result = { data: unknown[] | null; error: { message: string } | null };
interface InQuery extends PromiseLike<Result> { in(column: string, values: readonly string[]): InQuery }
/** The one query shape the reader uses (a Supabase client satisfies it; tests pass an in-memory one). */
export interface ObservationsClient { from(table: string): { select(columns: string): InQuery } }

const ObservationRow = z.object({
  series: z.string(), period: z.string(), value: z.union([z.number(), z.string()]), value_text: z.string(), deciding_text: z.string(), observed_at: z.string(),
  // parsed strictly: a corroboration the reader cannot read is never taken for "none recorded"
  corroboration: OfficialCorroboration.nullable(),
  meta: z.record(z.string(), z.unknown()).nullable().optional(),
});

/**
 * The stored first prints of `keys`, as a lookup. official_observations holds exactly one row per (series, period),
 * inserted once by record_official_observation and immutable afterwards (migration 016): that row IS the first print.
 * Its deciding text and corroboration come with it, so the prior is taken only from a print the rail trusts
 * (storedPrintProblem). One select; a read error or a row of an unexpected shape throws (a first print is never
 * treated as absent or undisputed by mistake).
 */
export async function readFirstPrints(client: ObservationsClient, keys: ReadonlyArray<{ series: OfficialSeriesId; period: string }>): Promise<FirstPrintLookup> {
  const want = new Set(keys.map((k) => `${k.series}:${k.period}`));
  const found = new Map<string, StoredFirstPrint>();
  if (want.size) {
    const { data, error } = await client.from("official_observations").select("series, period, value, value_text, deciding_text, observed_at, corroboration, meta")
      .in("series", [...new Set(keys.map((k) => k.series))]).in("period", [...new Set(keys.map((k) => k.period))]);
    if (error) throw new Error(`official_observations read: ${redact(error.message).slice(0, 200)}`);
    for (const raw of data ?? []) {
      const k = raw as { series?: unknown; period?: unknown } | null;
      if (!want.has(`${k?.series}:${k?.period}`)) continue; // the in x in product reads a few pairs nobody asked for
      const r = ObservationRow.parse(raw);
      const key = `${r.series}:${r.period}`;
      const doc = r.meta?.doc_period;
      found.set(key, { value: r.value, value_text: r.value_text, deciding_text: r.deciding_text, observed_at: r.observed_at, corroboration: r.corroboration, doc_period: typeof doc === "string" ? doc : null });
    }
  }
  return (series, period) => found.get(`${series}:${period}`);
}

/**
 * The groups as suggested: every rate-change group with its prior_level (hand-written and checked, or derived from the
 * stored first print of the meeting before it), the others unchanged; a rate group without one is returned in skipped
 * with the reason. `read` is called once, and only when some group's previous meeting is in the release calendar and
 * already released at `nowMs` (the first meeting of each calendar family, or a meeting whose predecessor is still
 * ahead, needs no database: no print can exist). A hand-written prior that disagrees with a stored first print throws
 * (priorForGroup).
 */
export async function withPriors<G extends LegGroup & { basis: string }>(
  groups: readonly G[], read: (keys: Array<{ series: OfficialSeriesId; period: string }>) => Promise<FirstPrintLookup>, nowMs: number,
): Promise<{ groups: G[]; skipped: Array<{ group: G; reason: string }> }> {
  const rate = (g: G) => OFFICIAL_SERIES[g.series].decides === "rate_change_bps";
  const keys = groups.filter(rate).flatMap((g) => { const p = releasedPrevious(g.series, g.period, nowMs); return p === null ? [] : [{ series: g.series, period: p }]; });
  const lookup: FirstPrintLookup = keys.length ? await read(keys) : () => undefined;
  const out: G[] = [];
  const skipped: Array<{ group: G; reason: string }> = [];
  for (const g of groups) {
    if (!rate(g)) { out.push(g); continue; }
    const p = priorForGroup(g, derivePriorLevel(g.series, g.period, lookup, nowMs));
    if ("skip" in p) { skipped.push({ group: g, reason: p.skip }); continue; }
    out.push({ ...g, prior_level: p.prior_level, basis: `${g.basis}; ${p.note}` });
  }
  return { groups: out, skipped };
}

// ---- the run ------------------------------------------------------------------------------------------------------

export interface LegEntry { market: MarketRegistration; meta: Record<string, unknown>; approved: false }
export interface SkippedLeg { platform: string; group: string; label: string; external_id: string; reason: string }
export interface SkippedGroup { group: string; series: OfficialSeriesId; period: string; reason: string }
export interface Suggestion { entries: LegEntry[]; skipped: SkippedLeg[]; skipped_groups: SkippedGroup[]; notes: string[] }

/** What the run reads, supplied by the script (network and database) or by a test (in memory). */
export interface SuggestIo {
  /** One read-only public GET; the parsed JSON, or null on any failure (the script rate-limits and records it). */
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
  /** The stored first prints of `keys` (readFirstPrints); withPriors calls it at most once, and only when needed. */
  readStored(keys: Array<{ series: OfficialSeriesId; period: string }>): Promise<FirstPrintLookup>;
  nowMs: number;
  /** Limitless X-API-Key, sent only when set (never printed). */
  limitlessKey?: string;
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const iso = (v: unknown) => { const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : undefined; };
export const groupName = (g: Group) => g.slug ?? g.pmSlug ?? g.title;

/**
 * Suggested registrations for every open leg of `selected`. The prior_level of every rate group comes first, before
 * any platform request (withPriors: a hand-written prior that disagrees with a stored first print throws, a group
 * without a trusted prior is skipped with the reason). Then each group's Limitless legs and Polymarket mirror (or its
 * Polymarket-only event); each leg is built, validated like a registration, and kept or skipped with the reason. A
 * leg of an ad-hoc group is also skipped when the platform's own title or text is not about the group's period
 * (platformPeriodProblem): the period was one typed argument.
 */
export async function suggestLegs(selected: readonly Group[], io: SuggestIo): Promise<Suggestion> {
  const entries: LegEntry[] = [];
  const skipped: SkippedLeg[] = [];
  const notes: string[] = [];
  const deadlineNotes = new Set<string>();

  function add(platform: "limitless" | "polymarket", g: Group, platformTitle: string, leg: { external_id: string; label: string; open_at?: string; deadline_utc?: string; criteria: string }, meta: Record<string, unknown>) {
    const skip = (reason: string) => { skipped.push({ platform, group: groupName(g), label: leg.label, external_id: leg.external_id, reason }); };
    if (!leg.open_at || !leg.deadline_utc) return skip("no creation or expiration time on the platform object");
    const off = g.adhoc ? platformPeriodProblem(g.series, g.period, platformTitle, leg.criteria) : null;
    if (off) return skip(`not about ${g.period}: ${off}`);
    const b = buildLegRegistration({ platform, external_id: leg.external_id, group: g, label: leg.label, open_at: leg.open_at, deadline_utc: leg.deadline_utc, criteria: leg.criteria });
    if (!b.ok) return skip(b.reason);
    try { validateRegistration(b.market); }
    catch (e) { return skip(String(e).slice(0, 300)); }
    // The rail decides from the scheduled release whatever the trading close; say so where the platform closes first.
    if (Date.parse(leg.deadline_utc) < Date.parse(g.release_at)) deadlineNotes.add(`${groupName(g)}: the ${platform} deadline ${leg.deadline_utc} is before the release ${g.release_at}; the legs still decide from the release (the deadline is the trading close, not part of the question)`);
    entries.push({ market: b.market, meta: { ...meta, category: "official_release", series: g.series, period: g.period, resolver_basis: g.basis }, approved: false });
  }

  /** Every open leg of one gamma event, as Polymarket registrations of the group. */
  async function addPolymarketEvent(g: Group, slug: string, provider: string): Promise<void> {
    const ev = (await io.getJson(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`)) as Obj[] | null;
    const event = Array.isArray(ev) ? ev[0] : undefined;
    if (!event) { notes.push(`${groupName(g)}: gamma has no event with slug ${slug} (externalProvider ${provider})`); return; }
    const pms = Array.isArray(event.markets) ? (event.markets as Obj[]) : [];
    for (const m of pms) {
      if (m.closed === true) { skipped.push({ platform: "polymarket", group: groupName(g), label: String(m.groupItemTitle ?? m.question ?? ""), external_id: String(m.id ?? ""), reason: "closed on Polymarket" }); continue; }
      add("polymarket", g, String(event.title ?? ""), { external_id: String(m.id ?? ""), label: String(m.groupItemTitle ?? ""), open_at: iso(m.startDate ?? m.createdAt ?? event.startDate), deadline_utc: iso(m.endDate ?? event.endDate), criteria: String(m.description ?? event.description ?? "") },
        { condition_id: m.conditionId ?? null, slug: m.slug ?? null, event_id: event.id ?? null, event_slug: event.slug ?? slug });
    }
  }

  const priced = await withPriors(selected, io.readStored, io.nowMs);
  const skipped_groups = priced.skipped.map((s) => ({ group: groupName(s.group), series: s.group.series, period: s.group.period, reason: s.reason }));
  notes.push(...skipped_groups.map((s) => `${s.group}: skipped, ${s.reason}`));
  for (const g of priced.groups) {
    if (!g.slug) { await addPolymarketEvent(g, g.pmSlug!, "none: Polymarket-only ladder"); continue; }
    const lm = (await io.getJson(`https://api.limitless.exchange/markets/${g.slug}`, io.limitlessKey ? { "X-API-Key": io.limitlessKey } : {})) as Obj | null;
    if (!lm) { notes.push(`${g.slug}: Limitless GET failed; no legs from it`); continue; }
    const legs = Array.isArray(lm.markets) ? (lm.markets as Obj[]) : [];
    if (!legs.length) notes.push(`${g.slug}: Limitless group returned no sub-markets`);
    for (const m of legs) {
      if (m.hidden === true) { skipped.push({ platform: "limitless", group: g.slug, label: String(m.title ?? ""), external_id: String(m.slug ?? ""), reason: "hidden sub-market" }); continue; }
      // The labels reconcile reads this leg's winningOutcomeIndex with; the venue payload proposes over the same list.
      const labels = limitlessLabels({ outcomeTokens: Array.isArray(m.outcomeTokens) && m.outcomeTokens.every((x) => typeof x === "string") ? (m.outcomeTokens as string[]) : null, tokens: m.tokens && typeof m.tokens === "object" ? (m.tokens as Record<string, unknown>) : null });
      if (!labels || limitlessOutcomeIndex("OPTION_A", { option_a: "Yes", option_b: "No" }, labels) === null || limitlessOutcomeIndex("OPTION_B", { option_a: "Yes", option_b: "No" }, labels) === null) {
        skipped.push({ platform: "limitless", group: g.slug, label: String(m.title ?? ""), external_id: String(m.slug ?? ""), reason: `outcome labels ${JSON.stringify(labels)} do not map Yes and No to one index each: reconcile could not read the outcome` });
        continue;
      }
      add("limitless", g, String(lm.title ?? ""), { external_id: String(m.slug ?? ""), label: String(m.title ?? ""), open_at: iso(m.createdAt), deadline_utc: iso(m.expirationTimestamp), criteria: String(m.description ?? lm.description ?? "") },
        { limitless_slug: m.slug, group_slug: g.slug, ...(str(m.conditionId) ? { condition_id: m.conditionId } : {}), outcome_labels: [...labels], limitless_market_id: m.id ?? null, status: m.status ?? null });
    }
    const meta = (lm.metadata ?? {}) as Obj;
    const ext = str(lm.externalSlug) ?? str(meta.externalSlug);
    if (!ext) { notes.push(`${g.slug}: no externalSlug on the Limitless group; no Polymarket mirror looked up`); continue; }
    await addPolymarketEvent(g, ext, String(meta.externalProvider ?? lm.externalProvider ?? "null"));
  }
  notes.push(...deadlineNotes);
  return { entries, skipped, skipped_groups, notes };
}

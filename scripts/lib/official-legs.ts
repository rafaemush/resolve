/**
 * The testable parts of scripts/official-legs.ts: its arguments (the built-in ladder groups, or one ad-hoc group named
 * on the command line), the private/ output rule, the read of stored first prints (official_observations, migration
 * 016) through a client the caller supplies, and the prior_level of every rate-change group (src/markets/official-legs.ts
 * derivePriorLevel / priorForGroup). No network and no database here: the script builds the client.
 */
import { z } from "zod";
import { OFFICIAL_SERIES, UNSUPPORTED_OFFICIAL_SERIES, knownRelease, periodValid, type OfficialSeriesId } from "../../src/resolve/official";
import { isElectionSeries } from "../../src/resolve/election";
import { previousInCalendar } from "../../src/resolve/release-calendar";
import { derivePriorLevel, priorForGroup, type FirstPrintLookup, type LegGroup, type StoredFirstPrint } from "../../src/markets/official-legs";
import { redact } from "../../src/ops/redact";

export class UsageError extends Error {}
export const DEFAULT_OUT = "private/shadow-markets/official-release-2026-09-24.json";
export const USAGE = [
  "usage: npx tsx scripts/official-legs.ts [--only <series>[,<series>...]] [--out private/<file>.json]",
  "       npx tsx scripts/official-legs.ts (--pm-slug <polymarket event slug> | --lm-slug <limitless group slug>) --series <id> --period <period> --title <ladder title> [--out private/<file>.json]",
].join("\n");

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
  return { out: seen.get("--out") ?? `private/shadow-markets/official-release-${series}-${period}.json`, only: null, adhoc: { ...(pm ? { pmSlug: pm } : { slug: lm! }), series: id, period, title } };
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
  series: z.string(), period: z.string(), value: z.union([z.number(), z.string()]), value_text: z.string(), observed_at: z.string(),
  meta: z.record(z.string(), z.unknown()).nullable().optional(),
});

/**
 * The stored first prints of `keys`, as a lookup. official_observations holds exactly one row per (series, period),
 * inserted once by record_official_observation and immutable afterwards (migration 016): that row IS the first print.
 * One select; a read error or a row of an unexpected shape throws (a first print is never treated as absent by mistake).
 */
export async function readFirstPrints(client: ObservationsClient, keys: ReadonlyArray<{ series: OfficialSeriesId; period: string }>): Promise<FirstPrintLookup> {
  const want = new Set(keys.map((k) => `${k.series}:${k.period}`));
  const found = new Map<string, StoredFirstPrint>();
  if (want.size) {
    const { data, error } = await client.from("official_observations").select("series, period, value, value_text, observed_at, meta")
      .in("series", [...new Set(keys.map((k) => k.series))]).in("period", [...new Set(keys.map((k) => k.period))]);
    if (error) throw new Error(`official_observations read: ${redact(error.message).slice(0, 200)}`);
    for (const raw of data ?? []) {
      const r = ObservationRow.parse(raw);
      const key = `${r.series}:${r.period}`;
      if (!want.has(key)) continue; // the in x in product reads a few pairs nobody asked for
      const doc = r.meta?.doc_period;
      found.set(key, { value: r.value, value_text: r.value_text, observed_at: r.observed_at, doc_period: typeof doc === "string" ? doc : null });
    }
  }
  return (series, period) => found.get(`${series}:${period}`);
}

/**
 * The groups as suggested: every rate-change group with its prior_level (hand-written and checked, or derived from the
 * stored first print of the meeting before it), the others unchanged; a rate group without one is returned in skipped
 * with the reason. `read` is called once, and only when some group's previous meeting is in the release calendar
 * (the first meeting of each calendar family needs no database). A hand-written prior that disagrees with a stored
 * first print throws (priorForGroup).
 */
export async function withPriors<G extends LegGroup & { basis: string }>(
  groups: readonly G[], read: (keys: Array<{ series: OfficialSeriesId; period: string }>) => Promise<FirstPrintLookup>, nowMs: number,
): Promise<{ groups: G[]; skipped: Array<{ group: G; reason: string }> }> {
  const rate = (g: G) => OFFICIAL_SERIES[g.series].decides === "rate_change_bps";
  const keys = groups.filter(rate).flatMap((g) => { const p = previousInCalendar(g.series, g.period); return "reason" in p ? [] : [{ series: g.series, period: p.period }]; });
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

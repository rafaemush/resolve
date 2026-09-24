/**
 * The one mapping between a platform's outcome labels and a registered market's OPTION_A / OPTION_B, used in both
 * directions: reconcile reads an official outcome with it (src/jobs/reconcile.ts), and the venue-shaped verdict
 * payloads propose one with it (src/shadow/venue.ts). A proposed Limitless winningOutcomeIndex is defined as the index
 * that reconcile would read back as the committed outcome, so the two can never disagree (tests/venue.test.ts).
 * Pure.
 */
import type { MarketRow } from "../ingest/types";

type Options = Pick<MarketRow, "option_a" | "option_b">;
export type Option = "OPTION_A" | "OPTION_B";

/** NFKC, lower case, every run of non letters/digits collapsed to one space. "Yes." and "YES" are both "yes". */
export function normalizeLabel(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Strict label mapping: the official label must equal one registered option after normalization. A "Yes" label maps
 * only to an option whose text is "Yes"; a market registered as "Merged by Oct 1" / "Not merged" never matches it.
 * Identical options, an empty label or no match -> null (the caller abstains and alerts).
 */
export function mapOfficialLabel(label: string, m: Options): Option | null {
  const l = normalizeLabel(label), a = normalizeLabel(m.option_a), b = normalizeLabel(m.option_b);
  if (!l || a === b) return null;
  return l === a ? "OPTION_A" : l === b ? "OPTION_B" : null;
}

/**
 * Limitless outcome labels by winningOutcomeIndex for a market that exposes tokens {yes, no} (single CLOB markets and
 * group legs): YES = 0, NO = 1. Limitless documents winningIndex "0 = YES, 1 = NO"
 * (developers/websocket/market-lifecycle.md) and prices[] follows it (tests/fixtures/limitless-markets.json: the Senate
 * legs price Democratic [0.625, 0.375] and Republican [0.375, 0.625]; the group container's outcomeTokens are
 * ["Yes", "No"]).
 */
export const LIMITLESS_YES_NO: readonly string[] = Object.freeze(["Yes", "No"]);

/**
 * Outcome labels by index from a Limitless market object: outcomeTokens when present; otherwise tokens {yes, no}
 * (LIMITLESS_YES_NO). AMM markets expose only positionIds, no labels: null, so reconcile abstains and alerts rather than
 * guess.
 */
export function limitlessLabels(j: { outcomeTokens?: string[] | null; tokens?: Record<string, unknown> | null }): readonly string[] | null {
  if (j.outcomeTokens && j.outcomeTokens.length >= 2) return j.outcomeTokens;
  if (j.tokens && "yes" in j.tokens && "no" in j.tokens) return LIMITLESS_YES_NO;
  return null;
}

/** Read direction (reconcile): the option a winningOutcomeIndex stands for; null when out of range or no label matches. */
export function limitlessOutcomeAt(index: number, labels: readonly string[], m: Options): Option | null {
  const label = Number.isInteger(index) && index >= 0 ? labels[index] : undefined;
  return label === undefined ? null : mapOfficialLabel(label, m);
}

/**
 * Write direction (the venue payload): the one winningOutcomeIndex that limitlessOutcomeAt() reads back as `outcome`
 * over the same labels; null when no index or more than one does (options that are not the market's own labels are
 * never proposed as a guess). Defaults to the tokens {yes, no} order every registrable Limitless leg carries
 * (scripts/lib/candidates-limitless.ts registers option_a "Yes", option_b "No").
 */
export function limitlessOutcomeIndex(outcome: Option, m: Options, labels: readonly string[] = LIMITLESS_YES_NO): number | null {
  const hits = labels.flatMap((_, i) => (limitlessOutcomeAt(i, labels, m) === outcome ? [i] : []));
  return hits.length === 1 ? hits[0]! : null;
}

/** The Limitless slug reconcile queries: an importer-supplied meta slug (limitless_slug, then slug), else external_id. */
export function limitlessSlug(m: Pick<MarketRow, "external_id" | "meta">): string {
  const meta = m.meta ?? {};
  for (const k of ["limitless_slug", "slug"]) { const v = meta[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
  return m.external_id;
}

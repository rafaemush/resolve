/**
 * Venue-shaped verdict payloads (plan §17.2 #1, §17.3 P7-lite "Limitless-shaped verdict payload", §19.3): the `venue`
 * object of shadow.committed and shadow.revealed, in the identifiers the platform of record uses, so a venue can act on
 * a verdict without mapping Resolve's OPTION_A / OPTION_B itself.
 *   limitless   {platform, slug, group_slug, condition_id, proposed_winning_outcome_index}
 *   polymarket  {platform, condition_id, slug, event_id, proposed_outcome_label}
 *   custom      {platform, external_id}
 * A proposal exists only for a committed RESOLVED verdict; anything else (UNRESOLVED, ERROR, a commit that cannot be
 * read) proposes nothing (null), never a guess. Both proposals use src/markets/outcomes.ts, the mapping reconcile reads
 * outcomes with, and exist only when reconcile would read them back as the committed outcome: the Limitless index over
 * the leg's own labels as recorded at registration (meta.outcome_labels), the Polymarket label only when it maps to
 * exactly that option. group_slug is meta.group_slug, recorded at registration since 2026-09-25 (seed-shadow --check
 * refuses a Limitless group leg without it); a market registered without it carries group_slug null.
 * Identifiers only: never a title, a question or resolution criteria (Platform Content). Pure.
 */
import type { MarketRow } from "../ingest/types";
import { LIMITLESS_YES_NO, limitlessOutcomeIndex, limitlessSlug, mapOfficialLabel, type Option } from "../markets/outcomes";

export type VenueMarket = Pick<MarketRow, "platform" | "external_id" | "option_a" | "option_b"> & { meta?: Record<string, unknown> | null; condition_id?: string | null };
/** The committed verdict fields a proposal reads. */
export type VenueVerdict = { resolution_status: string; winning_outcome: string } | null;

export interface LimitlessVenue { platform: "limitless"; slug: string; group_slug: string | null; condition_id: string | null; proposed_winning_outcome_index: number | null }
export interface PolymarketVenue { platform: "polymarket"; condition_id: string | null; slug: string | null; event_id: string | null; proposed_outcome_label: string | null }
export interface CustomVenue { platform: "custom"; external_id: string }
export type Venue = LimitlessVenue | PolymarketVenue | CustomVenue;

/** A non-empty string (trimmed), or a number as its decimal string (gamma event ids, Limitless group ids); else null. */
const id = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

/** The option a committed verdict proposes: OPTION_A / OPTION_B of a RESOLVED verdict, else null. */
export function proposedOption(c: VenueVerdict): Option | null {
  if (!c || c.resolution_status !== "RESOLVED") return null;
  return c.winning_outcome === "OPTION_A" || c.winning_outcome === "OPTION_B" ? c.winning_outcome : null;
}

/** Both options are text (markets.option_a/b are NOT NULL; a partial row proposes nothing rather than throwing). */
const hasOptions = (m: Pick<VenueMarket, "option_a" | "option_b">): boolean => typeof m.option_a === "string" && typeof m.option_b === "string";

/**
 * The Polymarket label to propose for `option`: the option's registered text, only when reconcile would read that label
 * back as the same option (gamma reports the winning outcome by label and reconcile maps it with mapOfficialLabel). Options
 * that are equal after normalization ("Yes" / "yes.") or empty map to nothing there, so nothing is proposed here either.
 */
export function polymarketLabel(option: Option | null, m: Pick<VenueMarket, "option_a" | "option_b">): string | null {
  if (!option || !hasOptions(m)) return null;
  const label = option === "OPTION_A" ? m.option_a : m.option_b;
  return mapOfficialLabel(label, m) === option ? label : null;
}

/**
 * The outcome labels by winningOutcomeIndex recorded at registration (meta.outcome_labels: the leg's outcomeTokens, or
 * [Yes, No] for tokens {yes, no}; scripts/lib/candidates-limitless.ts, scripts/official-legs.ts), the labels reconcile reads
 * from the same market object. Absent (a registration made before the key existed): tokens {yes, no}, LIMITLESS_YES_NO.
 * Present but not a list of at least two strings: null, and nothing is proposed.
 */
export function limitlessMetaLabels(meta: Record<string, unknown>): readonly string[] | null {
  const v = meta.outcome_labels;
  if (v === undefined || v === null) return LIMITLESS_YES_NO;
  return Array.isArray(v) && v.length >= 2 && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

export function venuePayload(m: VenueMarket, committed: VenueVerdict): Venue {
  const meta = m.meta ?? {};
  const conditionId = (id(m.condition_id) ?? id(meta.condition_id))?.toLowerCase() ?? null;
  const option = proposedOption(committed);
  switch (m.platform) {
    case "limitless": {
      const labels = limitlessMetaLabels(meta);
      return {
        platform: "limitless",
        slug: limitlessSlug({ external_id: m.external_id, meta: meta as Record<string, unknown> }),
        group_slug: id(meta.group_slug),
        condition_id: conditionId,
        proposed_winning_outcome_index: option && labels && hasOptions(m) ? limitlessOutcomeIndex(option, m, labels) : null,
      };
    }
    case "polymarket":
      return {
        platform: "polymarket",
        condition_id: conditionId,
        slug: id(meta.slug),
        event_id: id(meta.event_id),
        proposed_outcome_label: polymarketLabel(option, m),
      };
    case "custom":
      return { platform: "custom", external_id: m.external_id };
    default: {
      const never: never = m.platform;
      throw new Error(`unknown platform ${String(never)}`);
    }
  }
}

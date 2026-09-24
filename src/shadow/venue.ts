/**
 * Venue-shaped verdict payloads (plan §17.2 #1, §17.3 P7-lite "Limitless-shaped verdict payload", §19.3): the `venue`
 * object of shadow.committed and shadow.revealed, in the identifiers the platform of record uses, so a venue can act on
 * a verdict without mapping Resolve's OPTION_A / OPTION_B itself.
 *   limitless   {platform, slug, group_slug, condition_id, proposed_winning_outcome_index}
 *   polymarket  {platform, condition_id, slug, event_id, proposed_outcome_label}
 *   custom      {platform, external_id}
 * A proposal exists only for a committed RESOLVED verdict; anything else (UNRESOLVED, ERROR, a commit that cannot be
 * read) proposes nothing (null), never a guess. The Limitless index comes from src/markets/outcomes.ts, the mapping
 * reconcile reads Limitless outcomes with, so the proposed index read back by reconcile is the committed outcome.
 * Identifiers only: never a title, a question or resolution criteria (Platform Content). Pure.
 */
import type { MarketRow } from "../ingest/types";
import { limitlessOutcomeIndex, limitlessSlug, type Option } from "../markets/outcomes";

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

export function venuePayload(m: VenueMarket, committed: VenueVerdict): Venue {
  const meta = m.meta ?? {};
  const conditionId = (id(m.condition_id) ?? id(meta.condition_id))?.toLowerCase() ?? null;
  const option = proposedOption(committed);
  switch (m.platform) {
    case "limitless":
      return {
        platform: "limitless",
        slug: limitlessSlug({ external_id: m.external_id, meta: meta as Record<string, unknown> }),
        group_slug: id(meta.group_slug),
        condition_id: conditionId,
        proposed_winning_outcome_index: option ? limitlessOutcomeIndex(option, m) : null,
      };
    case "polymarket":
      return {
        platform: "polymarket",
        condition_id: conditionId,
        slug: id(meta.slug),
        event_id: id(meta.event_id),
        // gamma reports the winning outcome by label, and reconcile maps a label to an option by its registered text
        proposed_outcome_label: option === "OPTION_A" ? m.option_a : option === "OPTION_B" ? m.option_b : null,
      };
    case "custom":
      return { platform: "custom", external_id: m.external_id };
    default: {
      const never: never = m.platform;
      throw new Error(`unknown platform ${String(never)}`);
    }
  }
}

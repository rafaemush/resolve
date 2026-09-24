/**
 * Chain evidence covers one poll window (Base: the blocks since cursor.block; Solana: the signatures since
 * cursor.sig), but the absence proof judges the whole market window. Without memory, a matching log seen before
 * the deadline is gone from the next window, and the post-deadline observation of an empty window "proves"
 * absence: a RESOLVED NO contradicting the committed YES. So the watch cursor carries the earliest entries the
 * market's chain resolver counts; the adapters publish them as structured.earlier_matches, the structured
 * resolver reads them before the window's own entries, and the change projection includes them.
 */
import type { Resolver } from "../resolve/schema";
import { chainEntryMatches } from "../resolve/structured";

type Entry = Record<string, unknown>;

/** Only the earliest match decides (the resolver takes the first); a few more keep the evidence self-explaining. */
export const MAX_EARLIER_MATCHES = 5;

/** The matches carried by a watch cursor from earlier windows, earliest first. */
export function earlierMatches(cursor: Record<string, unknown>): Entry[] {
  return Array.isArray(cursor.earlier_matches) ? (cursor.earlier_matches as Entry[]) : [];
}

/** The cursor value after a window: the carried matches, then this window's (windows arrive in chain order), capped. */
export function nextEarlierMatches(resolver: Resolver | undefined, carried: Entry[], windowEntries: Entry[]): Entry[] {
  if (carried.length >= MAX_EARLIER_MATCHES) return carried;
  return [...carried, ...windowEntries.filter((e) => chainEntryMatches(resolver, e))].slice(0, MAX_EARLIER_MATCHES);
}

/**
 * Importer metadata carried beside a shadow registration (plan §16.4 P5 step 1). MarketRegistration strips unknown keys,
 * so the platform identifiers that reconcile and on-chain corroboration need (condition id, slugs, event and group ids)
 * travel next to the market and are merged into markets.meta through this whitelist. markets.meta is read by the
 * reconcile loop (limitlessSlug), so it must never become a free-form bag: unknown keys are dropped and reported, and a
 * known key with the wrong type is refused instead of stored.
 */
import { z } from "zod";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "0x followed by 64 hex characters");
/** gamma event ids are strings ("60182"), Limitless group ids numbers (10014423): stored as strings either way. */
const platformId = z.union([z.string().trim().min(1).max(200), z.number().int().nonnegative()]).transform(String);
const text = (max: number) => z.string().trim().min(1).max(max);

export const MarketMeta = z.object({
  /** Polymarket CTF conditionId / Limitless leg conditionId; also written to markets.condition_id (migration 012). */
  condition_id: hex32.transform((s) => s.toLowerCase()),
  slug: text(300),
  question_id: hex32.transform((s) => s.toLowerCase()),
  neg_risk: z.boolean(),
  /** Read first by reconcile's limitlessSlug(): the leg slug when external_id is something else. */
  limitless_slug: text(300),
  group_id: platformId,
  event_id: platformId,
  category: text(100),
}).partial();
export type MarketMeta = z.infer<typeof MarketMeta>;

export const META_KEYS: ReadonlyArray<string> = Object.keys(MarketMeta.shape);

export type MetaMerge = { ok: true; meta: MarketMeta; dropped: string[] } | { ok: false; error: string };

/** Pure. Absent meta is an empty object; anything but a plain object, or a whitelisted key of the wrong type, is an error. */
export function mergeMeta(input: unknown): MetaMerge {
  if (input === undefined || input === null) return { ok: true, meta: {}, dropped: [] };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "meta must be a JSON object" };
  const known: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (META_KEYS.includes(k)) known[k] = v; else dropped.push(k);
  }
  const parsed = MarketMeta.safeParse(known);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "meta"}: ${i.message}`).join("; ") };
  return { ok: true, meta: parsed.data, dropped: dropped.sort() };
}

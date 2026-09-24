/**
 * Pure rules of scripts/seed-shadow.ts (tests/seed-shadow.test.ts): argument parsing and the --check validation of a
 * curated candidate file. The check is the same one --dry-run and --apply run first, so nothing that fails it can be
 * registered.
 */
import { CandidateFile, type CandidateEntry, type CandidatePlatform } from "./candidates";
import { MarketRegistration } from "../../src/resolve/schema";
import { mergeMeta, type MarketMeta } from "../../src/markets/meta";

/** Plan §16.4 P5 step 3: shadow markets stay in the long tail (gamma volume_num_max, the same cap as candidates.ts). */
export const SHADOW_VOLUME_CAP_USD = 50_000;

export type SeedMode = "check" | "dry-run" | "apply";
export interface SeedArgs { file: string; mode: SeedMode }

export class UsageError extends Error {}
export const USAGE = "usage: npx tsx scripts/seed-shadow.ts <curated file.json> [--check | --dry-run (default) | --apply]";

/** Pure. One file and at most one mode flag; anything else is a usage error, so a typo never becomes a write. */
export function parseSeedArgs(argv: string[]): SeedArgs {
  let file: string | null = null;
  const modes: SeedMode[] = [];
  for (const a of argv) {
    if (a === "--check") modes.push("check");
    else if (a === "--dry-run") modes.push("dry-run");
    else if (a === "--apply") modes.push("apply");
    else if (a.startsWith("-")) throw new UsageError(`unknown argument "${a}"`);
    else if (file) throw new UsageError(`one file at a time (got "${file}" and "${a}")`);
    else file = a;
  }
  if (!file) throw new UsageError("the curated file is required");
  if (modes.length > 1) throw new UsageError(`${modes.map((m) => `--${m}`).join(" and ")} are exclusive`);
  return { file, mode: modes[0] ?? "dry-run" };
}

export interface EntryCheck {
  index: number;
  platform: string;
  external_id: string;
  approved: boolean;
  errors: string[];
}

export interface FileCheck {
  platform: CandidatePlatform | null;
  /** Structural errors of the file itself (not of one entry). */
  fileErrors: string[];
  entries: EntryCheck[];
  approved: number;
  /** Approved entries that fail a rule: any one of these blocks --apply. */
  approvedInvalid: number;
}

/**
 * Pure. Every entry is checked (so the founder sees what an approval would run into); only approved entries can block.
 * Rules: the registration parses with MarketRegistration (the Worker's own schema) and names the file's platform; meta
 * holds only whitelisted keys of the right type (src/markets/meta.ts), and a Polymarket entry carries meta.condition_id;
 * volume <= $50k; is_test is false; the deadline is in the future; every web source is https; an approved entry has
 * nothing left under needs_review; no (platform, external_id) appears twice.
 */
export function checkCandidateFile(json: unknown, now: Date): FileCheck {
  const parsed = CandidateFile.safeParse(json);
  if (!parsed.success) {
    return { platform: null, fileErrors: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "file"}: ${i.message}`), entries: [], approved: 0, approvedInvalid: 0 };
  }
  const platform = parsed.data.header.platform;
  const seen = new Map<string, number>();
  const entries = parsed.data.entries.map((e, index) => checkEntry(e, index, platform, now, seen));
  const approved = entries.filter((e) => e.approved);
  return { platform, fileErrors: [], entries, approved: approved.length, approvedInvalid: approved.filter((e) => e.errors.length).length };
}

function checkEntry(e: CandidateEntry, index: number, platform: CandidatePlatform, now: Date, seen: Map<string, number>): EntryCheck {
  const errors: string[] = [];
  const m = MarketRegistration.safeParse(e.registration.market);
  const externalId = typeof e.registration.market.external_id === "string" ? e.registration.market.external_id : "?";
  if (!m.success) for (const i of m.error.issues) errors.push(`market.${i.path.join(".")}: ${i.message}`);
  else {
    if (m.data.platform !== platform) errors.push(`market.platform is ${m.data.platform}, the file is for ${platform}`);
    if (Date.parse(m.data.deadline_utc) <= now.getTime()) errors.push(`deadline_utc ${m.data.deadline_utc} is not in the future`);
    for (const s of m.data.sources) {
      if ((s.kind === "web_fetch" || s.kind === "web_render") && !s.ref.startsWith("https://")) errors.push(`source ${s.ref} is not https`);
    }
  }
  const meta = mergeMeta(e.registration.meta);
  if (!meta.ok) errors.push(`meta: ${meta.error}`);
  else {
    if (meta.dropped.length) errors.push(`meta keys outside the whitelist: ${meta.dropped.join(", ")}`);
    if (platform === "polymarket" && !meta.meta.condition_id) errors.push("meta.condition_id is required for Polymarket (on-chain corroboration of the official outcome)");
  }
  if (e.volume_usd > SHADOW_VOLUME_CAP_USD) errors.push(`volume $${e.volume_usd} is over the $${SHADOW_VOLUME_CAP_USD} shadow cap`);
  if (e.registration.is_test !== false) errors.push("is_test must be false for a shadow market on the public record");
  if (e.approved && e.needs_review.length) errors.push(`approved while needs_review still lists ${e.needs_review.join(", ")} (edit those fields, then empty the list)`);
  const key = `${platform}:${externalId}`;
  const first = seen.get(key);
  if (first !== undefined) errors.push(`duplicate of entry ${first} (${key})`);
  else seen.set(key, index);
  return { index, platform, external_id: externalId, approved: e.approved, errors };
}

/** The columns seed-shadow reads back from markets. */
export interface ShadowRow { id: string; platform: string; external_id: string; status: string; is_test: boolean; condition_id: string | null; meta: Record<string, unknown> | null }

/**
 * Pure. What the database row must show after --apply registered an entry (read from the database, never taken from the
 * Worker's answer): the same platform and external_id, is_test false, condition_id and every whitelisted meta key as
 * sent. Empty = verified.
 */
export function verifyRow(row: ShadowRow | null, platform: string, externalId: string, meta: MarketMeta): string[] {
  if (!row) return ["no row found after registration"];
  const out: string[] = [];
  if (row.platform !== platform || row.external_id !== externalId) out.push(`row is ${row.platform}:${row.external_id}`);
  if (row.is_test !== false) out.push("is_test is not false");
  if ((meta.condition_id ?? null) !== (row.condition_id ?? null)) out.push(`condition_id ${row.condition_id ?? "null"} != ${meta.condition_id ?? "null"}`);
  for (const [k, v] of Object.entries(meta)) if (row.meta?.[k] !== v) out.push(`meta.${k} is ${JSON.stringify(row.meta?.[k])}, expected ${JSON.stringify(v)}`);
  return out;
}

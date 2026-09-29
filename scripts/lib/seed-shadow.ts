/**
 * Pure rules of scripts/seed-shadow.ts (tests/seed-shadow.test.ts): argument parsing and the --check validation of a
 * curated candidate file. The check is the same one --dry-run and --apply run first, so nothing that fails it can be
 * registered.
 */
import { CandidateFile, type CandidateEntry, type CandidatePlatform } from "./candidates";
import { MarketRegistration } from "../../src/resolve/schema";
import { mergeMeta, type MarketMeta } from "../../src/markets/meta";
import { limitlessOutcomeIndex } from "../../src/markets/outcomes";
import { registrationPolicyIssues, webRenderRefusal } from "../../src/markets/policy";

/** Plan §16.4 P5 step 3: shadow markets stay in the long tail (gamma volume_num_max, the same cap as candidates.ts). */
export const SHADOW_VOLUME_CAP_USD = 50_000;

export type SeedMode = "check" | "dry-run" | "apply";
/** acceptConsensusReading: --accept-consensus-reading, the founder's call to register entries marked consensus_reporting. */
export interface SeedArgs { file: string; mode: SeedMode; acceptConsensusReading: boolean }

export class UsageError extends Error {}
export const USAGE = "usage: npx tsx scripts/seed-shadow.ts <curated file.json> [--check | --dry-run (default) | --apply] [--accept-consensus-reading]";
export const ACCEPT_CONSENSUS_FLAG = "--accept-consensus-reading";

/** Pure. One file, at most one mode flag and the consensus flag; anything else is a usage error, so a typo never becomes a write. */
export function parseSeedArgs(argv: string[]): SeedArgs {
  let file: string | null = null;
  let acceptConsensusReading = false;
  const modes: SeedMode[] = [];
  for (const a of argv) {
    if (a === "--check") modes.push("check");
    else if (a === "--dry-run") modes.push("dry-run");
    else if (a === "--apply") modes.push("apply");
    else if (a === ACCEPT_CONSENSUS_FLAG) acceptConsensusReading = true;
    else if (a.startsWith("-")) throw new UsageError(`unknown argument "${a}"`);
    else if (file) throw new UsageError(`one file at a time (got "${file}" and "${a}")`);
    else file = a;
  }
  if (!file) throw new UsageError("the curated file is required");
  if (modes.length > 1) throw new UsageError(`${modes.map((m) => `--${m}`).join(" and ")} are exclusive`);
  return { file, mode: modes[0] ?? "dry-run", acceptConsensusReading };
}

/**
 * criteria_basis values an entry may carry (scripts/election-legs.ts). consensus_reporting: the market settles on "a
 * consensus of credible reporting" and turns to the authority only if there is ambiguity, while the rail decides from the
 * authority's count; registering such a market is the founder's policy call, so it is held back (never registered, never
 * an error) unless --accept-consensus-reading is passed. Any other value is refused: an unknown basis is never registered.
 */
export const CRITERIA_BASES = ["consensus_reporting"] as const;

export interface EntryCheck {
  index: number;
  platform: string;
  external_id: string;
  approved: boolean;
  errors: string[];
  /** Why the entry is held back from registration whatever its approval (criteria_basis without the founder's flag), else null. */
  held: string | null;
}

export interface FileCheck {
  platform: CandidatePlatform | null;
  /** Structural errors of the file itself (not of one entry). */
  fileErrors: string[];
  entries: EntryCheck[];
  approved: number;
  /** Approved entries held back (criteria_basis consensus_reporting without --accept-consensus-reading): never registered. */
  heldBack: number;
  /** Approved entries that would be registered: approved and not held back. */
  registrable: number;
  /** Approved entries not held back that fail a rule: any one of these blocks --apply. */
  approvedInvalid: number;
}
export interface CheckOptions { acceptConsensusReading?: boolean }

/**
 * Pure. Every entry is checked (so the founder sees what an approval would run into); only approved entries can block.
 * Rules: the registration parses with MarketRegistration (the Worker's own schema) and names the file's platform; meta
 * holds only whitelisted keys of the right type (src/markets/meta.ts), a Polymarket entry carries meta.condition_id, and a
 * Limitless entry its outcome labels, both options among them, and a group leg its group slug (limitlessMetaProblems);
 * volume <= $50k; is_test is false; the deadline is in the future; event_statement is a declarative, deadline-free fact
 * (eventStatementProblem); every source passes the Worker's registration policy (src/markets/policy.ts: per-kind ref
 * grammar, resolver and sources on one subject, web sources public https URLs) and none is web_render, so --check
 * catches offline what the Worker would refuse; an approved entry has nothing left under needs_review; no
 * (platform, external_id) appears twice.
 */
export function checkCandidateFile(json: unknown, now: Date, opts: CheckOptions = {}): FileCheck {
  const parsed = CandidateFile.safeParse(json);
  if (!parsed.success) {
    return { platform: null, fileErrors: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "file"}: ${i.message}`), entries: [], approved: 0, heldBack: 0, registrable: 0, approvedInvalid: 0 };
  }
  const platform = parsed.data.header.platform;
  const seen = new Map<string, number>();
  const entries = parsed.data.entries.map((e, index) => checkEntry(e, index, platform, now, seen, opts));
  const approved = entries.filter((e) => e.approved);
  const live = approved.filter((e) => !e.held);
  return { platform, fileErrors: [], entries, approved: approved.length, heldBack: approved.length - live.length, registrable: live.length, approvedInvalid: live.filter((e) => e.errors.length).length };
}

/**
 * Pure. The entries --dry-run and --apply may register, by index: approved and not held back. The one list both modes
 * walk, so an entry held back in --check is never registered in a real run either.
 */
export function registrationPlan(check: FileCheck): number[] {
  return check.entries.filter((e) => e.approved && !e.held).map((e) => e.index);
}

/** One run's selection: the file's check (made with the run's flags) and the entries it POSTs, in file order, by index. */
export interface SeedSelection { check: FileCheck; platform: CandidatePlatform | null; register: Array<{ index: number; entry: CandidateEntry }> }

/**
 * Pure. The one selection scripts/seed-shadow.ts makes, in every mode: the parsed file checked with the run's own flags
 * (args.acceptConsensusReading, so a held entry is held in --check and in real runs alike), and the entries --dry-run
 * and --apply walk, approved and not held back (registrationPlan). A file that fails the check (a file error, or an
 * approved entry with errors) selects nothing.
 */
export function selectForRegistration(json: unknown, args: SeedArgs, now: Date): SeedSelection {
  const check = checkCandidateFile(json, now, { acceptConsensusReading: args.acceptConsensusReading });
  if (check.fileErrors.length || check.approvedInvalid) return { check, platform: check.platform, register: [] };
  const file = CandidateFile.parse(json);
  const plan = new Set(registrationPlan(check));
  return { check, platform: file.header.platform, register: file.entries.flatMap((entry, index) => (plan.has(index) ? [{ index, entry }] : [])) };
}

/** Pure. Why an entry's criteria_basis holds it back (null: it carries none, or the founder accepted it); errors: an unknown basis. */
export function criteriaBasisHold(entry: unknown, opts: CheckOptions): { held: string | null; error: string | null } {
  const basis = (entry as { criteria_basis?: unknown } | null)?.criteria_basis;
  if (basis === undefined) return { held: null, error: null };
  if (!(CRITERIA_BASES as readonly unknown[]).includes(basis)) return { held: null, error: `criteria_basis ${JSON.stringify(basis)} is not one seed-shadow reads (${CRITERIA_BASES.join(", ")}): never registered` };
  if (opts.acceptConsensusReading) return { held: null, error: null };
  return { held: `criteria_basis ${String(basis)}: the market settles on a consensus of credible reporting (the authority only if there is ambiguity); held back unless ${ACCEPT_CONSENSUS_FLAG} is passed`, error: null };
}

/** Interrogative openers, capitalized as a sentence starts: "WHO declared ..." (the organization) is not "Who ...". */
const INTERROGATIVE = /^[\s"'\u201c(]*([Ww]ill|[Ww]ould|[Ww]hich|[Ww]hat|[Ww]hom?|[Ww]hose|[Ww]hen|[Ww]here|[Ww]hy|[Hh]ow|[Ii]s|[Aa]re|[Ww]as|[Ww]ere|[Dd]oes|[Dd]o|[Dd]id|[Hh]as|[Hh]ave|[Hh]ad|[Cc]an|[Cc]ould|[Ss]hould|[Ss]hall)\b/;
/** Month names as written in a date (capitalized), so "signed by Janet Yellen" or "by decision" never reads as a date. */
const MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\\.?";
/**
 * Deadline wording: "by September 30", "before the deadline", "no later than 2026-10-01", "by the end of Q3", "until 1
 * October". A month counts only before a day, a year or the end of a clause, so "backed by May Holdings" is not a date.
 */
const DEADLINE = new RegExp(`\\b(?:[Bb]y|[Bb]efore|[Uu]ntil|[Nn]o later than|[Pp]rior to)\\s+(?:the\\s+)?(?:[Dd]eadline|[Ee]nd of|[Cc]lose of|${MONTH}(?=\\s+\\d|\\s*[,.;:)]|\\s*$)|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?![a-z]))`);
const URLS = /https?:\/\/\S+/g;

/**
 * Pure. Why an event_statement cannot go to Jev as written, or null. jevOptionStatements() builds both options from it
 * ("The event has occurred: <event_statement>"), so it must be a declarative fact with no deadline (column comment on
 * markets.event_statement): a question is not a fact ("Will ...?", "Fed Decision in October? — 25 bps decrease"), and
 * deadline wording moved jev-1.13.0 to NOT_DETERMINABLE on explicit evidence (src/resolve/jev.ts, live probe
 * 2026-09-23). The deadline is enforced by the time-window precheck. A "?" inside a URL does not count.
 */
export function eventStatementProblem(statement: string): string | null {
  const text = statement.replace(URLS, " ");
  if (text.includes("?")) return "contains a question mark: write it as a declarative fact";
  const q = INTERROGATIVE.exec(text);
  if (q) return `starts with "${q[1]}": write it as a declarative fact, not a question`;
  const d = DEADLINE.exec(text);
  if (d) return `names a deadline ("${d[0]}"): the deadline is deadline_utc, checked in code`;
  return null;
}

const REGENERATE = "regenerate the file with npx tsx scripts/candidates.ts limitless";

/**
 * Pure. What a Limitless entry's meta lacks for the venue payload (src/shadow/venue.ts): the leg's outcome labels by
 * winningOutcomeIndex (the payload proposes an index over exactly these, the labels reconcile reads), with each option
 * the text of exactly one label (else reconcile could never read that outcome); and for a group leg (meta.group_id) the
 * group's slug. A candidate file generated before 2026-09-25 has neither, so its entries are refused rather than
 * registered with a proposal over assumed labels or a null group_slug.
 */
export function limitlessMetaProblems(meta: MarketMeta, market: Pick<MarketRegistration, "option_a" | "option_b"> | null): string[] {
  const out: string[] = [];
  if (!meta.outcome_labels) out.push(`meta.outcome_labels is required for Limitless (the outcome labels by winningOutcomeIndex): ${REGENERATE}`);
  else if (market) {
    for (const [o, key] of [["OPTION_A", "option_a"], ["OPTION_B", "option_b"]] as const) {
      if (limitlessOutcomeIndex(o, market, meta.outcome_labels) === null) out.push(`market.${key} "${market[key]}" is not exactly one of the outcome labels ${JSON.stringify(meta.outcome_labels)}: reconcile could not read that outcome`);
    }
  }
  if (meta.group_id && !meta.group_slug) out.push(`meta.group_slug is required with meta.group_id (the venue payload's group_slug): ${REGENERATE}`);
  return out;
}

function checkEntry(e: CandidateEntry, index: number, platform: CandidatePlatform, now: Date, seen: Map<string, number>, opts: CheckOptions): EntryCheck {
  const errors: string[] = [];
  const basis = criteriaBasisHold(e, opts);
  if (basis.error) errors.push(basis.error);
  const m = MarketRegistration.safeParse(e.registration.market);
  const externalId = typeof e.registration.market.external_id === "string" ? e.registration.market.external_id : "?";
  if (!m.success) for (const i of m.error.issues) errors.push(`market.${i.path.join(".")}: ${i.message}`);
  else {
    if (m.data.platform !== platform) errors.push(`market.platform is ${m.data.platform}, the file is for ${platform}`);
    if (Date.parse(m.data.deadline_utc) <= now.getTime()) errors.push(`deadline_utc ${m.data.deadline_utc} is not in the future`);
    for (const p of registrationPolicyIssues(m.data)) errors.push(`source policy: ${p}`);
    const render = webRenderRefusal(m.data);
    if (render) errors.push(render);
  }
  // Checked whatever else fails, so one --check run shows every field the founder still has to rewrite.
  const statement = typeof e.registration.market.event_statement === "string" ? eventStatementProblem(e.registration.market.event_statement) : null;
  if (statement) errors.push(`event_statement ${statement}`);
  const meta = mergeMeta(e.registration.meta);
  if (!meta.ok) errors.push(`meta: ${meta.error}`);
  else {
    if (meta.dropped.length) errors.push(`meta keys outside the whitelist: ${meta.dropped.join(", ")}`);
    if (platform === "polymarket" && !meta.meta.condition_id) errors.push("meta.condition_id is required for Polymarket (on-chain corroboration of the official outcome)");
    if (platform === "limitless") errors.push(...limitlessMetaProblems(meta.meta, m.success ? m.data : null));
  }
  if (e.volume_usd > SHADOW_VOLUME_CAP_USD) errors.push(`volume $${e.volume_usd} is over the $${SHADOW_VOLUME_CAP_USD} shadow cap`);
  if (e.registration.is_test !== false) errors.push("is_test must be false for a shadow market on the public record");
  if (e.approved && e.needs_review.length) errors.push(`approved while needs_review still lists ${e.needs_review.join(", ")} (edit those fields, then empty the list)`);
  const key = `${platform}:${externalId}`;
  const first = seen.get(key);
  if (first !== undefined) errors.push(`duplicate of entry ${first} (${key})`);
  else seen.set(key, index);
  return { index, platform, external_id: externalId, approved: e.approved, errors, held: basis.held };
}

/** The columns seed-shadow reads back from markets. */
export interface ShadowRow { id: string; platform: string; external_id: string; status: string; is_test: boolean; condition_id: string | null; meta: Record<string, unknown> | null; sources: unknown }

/** What an approved entry registers: the row must show exactly this. */
export interface ExpectedShadow { platform: string; externalId: string; meta: MarketMeta; sources: ReadonlyArray<{ kind: string; ref: string }> }

const sourceKeys = (sources: unknown): string[] =>
  (Array.isArray(sources) ? sources : []).map((s: { kind?: unknown; ref?: unknown }) => `${String(s?.kind)} ${String(s?.ref)}`).sort();

/**
 * Pure. What the database row must show for an approved entry, read from the database and never taken from the Worker's
 * answer, both right after --apply registered it and when a rerun finds it already there: the same platform and
 * external_id, is_test false, condition_id, every whitelisted meta key and the sources as sent, and, while the market is
 * open, one active watch per source. Since migration 019 the market and its watches land in one transaction, but a
 * market registered before it (market first, then its watches one by one) can be an open market that polls fewer
 * sources or none; a rerun must name it instead of counting it as already present. Other statuses have no active watches by design
 * (unsupported_source never gets any; terminal statuses deactivate them). Empty = verified.
 */
export function verifyRow(row: ShadowRow | null, activeWatches: number, want: ExpectedShadow): string[] {
  if (!row) return ["no row found after registration"];
  const out: string[] = [];
  if (row.platform !== want.platform || row.external_id !== want.externalId) out.push(`row is ${row.platform}:${row.external_id}`);
  if (row.is_test !== false) out.push("is_test is not false");
  if ((want.meta.condition_id ?? null) !== (row.condition_id ?? null)) out.push(`condition_id ${row.condition_id ?? "null"} != ${want.meta.condition_id ?? "null"}`);
  // by value: meta.outcome_labels is a list, and jsonb returns a new one
  for (const [k, v] of Object.entries(want.meta)) if (JSON.stringify(row.meta?.[k]) !== JSON.stringify(v)) out.push(`meta.${k} is ${JSON.stringify(row.meta?.[k])}, expected ${JSON.stringify(v)}`);
  const have = sourceKeys(row.sources), sent = sourceKeys(want.sources);
  if (have.join("\n") !== sent.join("\n")) out.push(`sources are [${have.join(", ")}], the entry lists [${sent.join(", ")}]`);
  if (row.status === "open" && activeWatches !== have.length) out.push(`open with ${activeWatches} active watch${activeWatches === 1 ? "" : "es"} for ${have.length} source${have.length === 1 ? "" : "s"}`);
  return out;
}

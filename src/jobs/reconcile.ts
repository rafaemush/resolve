/**
 * Reconcile shadow commits against the platform of record, then reveal (plan §16.4 P2 step 2, §17.3 P2a).
 *
 * One run (the 10-minute cron, or POST /internal/reconcile), inside one subrequest budget:
 *   1. re-post commits still pending after 60 s (retryUnposted);
 *   2. post at most 5 pending reveals as replies to their commits;
 *   3. alert when a commit or reveal is still pending after 15 minutes;
 *   4. discovery: non-test shadow markets past their deadline whose reconcile_next_at is due, longest-waiting first, at
 *      most 25. A market the run does not settle (platform pending, label unmappable, platform unreachable, a failed
 *      write, a watch still owed its post-deadline poll) is rescheduled in one batched write, so it moves behind the
 *      others instead of holding a slot forever. An official outcome is settled by settle_market() (migration 012) in
 *      one transaction: one reconciliation row per commit (final on the latest commit, the market's one public
 *      agreement), one pending reveal row per commit, watches off, the terminal status. No official outcome 21 days
 *      after the deadline closes the market as closed_unresolved through the same path. A settled market's followers
 *      get shadow.revealed (queued inside the settle's reservation, src/shadow/events.ts);
 *      A due Limitless market's official_at is the earliest sighting of its outcome: this run's, the stored first one,
 *      or the Limitless recorder's (one batched read per run, src/jobs/limitless-recorder.ts);
 *   5. the queued shadow.revealed rows get their first delivery attempt with whatever budget is left (the 5-minute
 *      drain delivers the rest).
 * Official outcomes map to OPTION_A/OPTION_B only by normalized label equality with the registered option text. The
 * positional fallback that used to map "first outcome" to OPTION_A is gone: no match means no reconciliation and an
 * alert, never a guess.
 */
import { z } from "zod";
import type { Env } from "../env";
import { db, type Db } from "../db/supabase";
import { sha256Hex } from "../resolve/text";
import { buildReveal, committedOf, marketRef, postPendingReveals, retryUnposted, type Agreement, type CommitRow, type CommittedVerdict, type OfficialRecord, type ResolutionFallback } from "../bot/commit";
import type { MarketRow } from "../ingest/types";
import { alert } from "../ops/alerts";
import { redact } from "../ops/redact";
import { Budget, COST, DISPATCH_CHECK_SUBREQUESTS, EXCEPTION_RESERVE, INVOCATION_SUBREQUESTS } from "../ops/budget";
import { queueForFollowers, shadowRevealedPayload, QUEUE_SUBREQUESTS, type RevealedCommit } from "../shadow/events";
import { deliverInline } from "../webhooks/deliver";

/**
 * Of Workers Free's 50 subrequests per invocation: the 10-minute invocation runs the pg_net dispatch check first and
 * keeps one alert back for a job that throws (src/jobs/schedule.ts), so reconcile gets 50 - 6 - 5 = 39.
 */
export const RECONCILE_SUBREQUESTS = INVOCATION_SUBREQUESTS - DISPATCH_CHECK_SUBREQUESTS - EXCEPTION_RESERVE;
export const MARKETS_PER_RUN = 25;
export const MAX_REVEALS_PER_RUN = 5;
export const MAX_RETRIES_PER_RUN = 5;
/** No official outcome this long after the deadline: the market closes as closed_unresolved (agreement unresolved_by_platform). */
export const CLOSE_OUT_DAYS = 21;
export const UNPOSTED_ALERT_MINUTES = 15;
/** Recheck of a market the platform has not resolved yet: the cron interval (see recheckDelaySeconds). */
export const RECHECK_PENDING_S = 600;
/** Cap of the backoff for markets that cannot be mapped, reached or written. */
export const RECHECK_MAX_S = 6 * 3600;
/** gamma closed with no umaResolutionStatus at all for this long is no longer "pending": someone has to look. */
export const UMA_SILENT_DAYS = 7;
const UA = "ResolveBot/1.0";
const FETCH_TIMEOUT_MS = 8000;

export type OfficialState =
  | { kind: "resolved"; official: OfficialRecord & { outcome: "OPTION_A" | "OPTION_B" | "VOID" }; detail: string }
  | { kind: "pending"; source_url: string; detail: string }
  | { kind: "unmappable"; label: string | null; source_url: string; detail: string }
  | { kind: "unreachable"; detail: string };

type Options = Pick<MarketRow, "option_a" | "option_b">;

/** NFKC, lower case, every run of non letters/digits collapsed to one space. "Yes." and "YES" are both "yes". */
export function normalizeLabel(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Strict label mapping: the official label must equal one registered option after normalization. A "Yes" label maps
 * only to an option whose text is "Yes"; a market registered as "Merged by Oct 1" / "Not merged" never matches it.
 * Identical options, an empty label or no match -> null (the caller abstains and alerts).
 */
export function mapOfficialLabel(label: string, m: Options): "OPTION_A" | "OPTION_B" | null {
  const l = normalizeLabel(label), a = normalizeLabel(m.option_a), b = normalizeLabel(m.option_b);
  if (!l || a === b) return null;
  return l === a ? "OPTION_A" : l === b ? "OPTION_B" : null;
}

/** gamma serializes outcomes / outcomePrices either as arrays or as JSON strings of arrays. */
function stringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== "string") return [];
  try { const a: unknown = JSON.parse(v); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

/** gamma closedTime looks like "2026-10-05 12:02:13+00"; null when it does not parse. */
function gammaTime(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v.trim().replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const GammaMarket = z.object({
  outcomes: z.unknown(),
  outcomePrices: z.unknown(),
  closed: z.boolean().nullish(),
  umaResolutionStatus: z.string().nullish(),
  closedTime: z.string().nullish(),
  slug: z.string().nullish(),
});

/**
 * Pure: gamma market JSON -> official state. Official means closed AND umaResolutionStatus "resolved" (plan §16.4 P2):
 * on a closed market that UMA has not settled, outcomePrices can be a last trade, not a resolution. Closed for
 * UMA_SILENT_DAYS with no UMA status at all is unmappable (alerted), never read from prices. official_at is gamma
 * closedTime, labeled; otherwise the observation time.
 */
export function polymarketOfficial(json: unknown, m: Options, observedAt: string, apiUrl: string): OfficialState {
  const p = GammaMarket.safeParse(json);
  if (!p.success) return { kind: "unreachable", detail: `gamma schema drift: ${p.error.issues[0]?.path.join(".") ?? "?"}` };
  const j = p.data;
  const sourceUrl = j.slug ? `https://polymarket.com/event/${j.slug}` : apiUrl;
  const uma = j.umaResolutionStatus ?? "";
  const closedAt = gammaTime(j.closedTime);
  if (j.closed !== true || uma !== "resolved") {
    if (j.closed === true && !uma && closedAt && Date.parse(observedAt) - Date.parse(closedAt) > UMA_SILENT_DAYS * 86_400_000) {
      return { kind: "unmappable", label: null, source_url: sourceUrl, detail: `closed since ${closedAt} with no umaResolutionStatus; outcomePrices are not an official outcome` };
    }
    return { kind: "pending", source_url: sourceUrl, detail: `closed=${j.closed ?? "?"} uma=${uma || "n/a"}` };
  }
  const outcomes = stringArray(j.outcomes), prices = stringArray(j.outcomePrices).map(Number);
  const at = closedAt ?? observedAt;
  const atSource = closedAt ? "gamma_closed_time" as const : "first_observed_poll" as const;
  if (prices.length === 2 && prices.every((x) => x === 0.5)) {
    return { kind: "resolved", official: { outcome: "VOID", label: null, at, at_source: atSource, source_url: sourceUrl }, detail: "resolved 50-50" };
  }
  const winners = prices.flatMap((x, i) => (x >= 0.99 ? [i] : []));
  if (winners.length !== 1) return { kind: "unmappable", label: null, source_url: sourceUrl, detail: `closed but no single winning price in [${prices.join(",")}]` };
  const label = outcomes[winners[0]!] ?? "";
  const outcome = mapOfficialLabel(label, m);
  if (!outcome) return { kind: "unmappable", label, source_url: sourceUrl, detail: `official label "${label}" matches neither option` };
  return { kind: "resolved", official: { outcome, label, at, at_source: atSource, source_url: sourceUrl }, detail: `resolved ${label}` };
}

const LimitlessMarket = z.object({
  slug: z.string().nullish(),
  status: z.string().nullish(),
  expired: z.boolean().nullish(),
  winningOutcomeIndex: z.number().int().nullish(),
  outcomeTokens: z.array(z.string()).nullish(),
  tokens: z.record(z.string(), z.unknown()).nullish(),
  payoutNumerators: z.array(z.union([z.number(), z.string()])).nullish(),
  /** Present only on a group container (its legs are separate markets with their own slug and outcome). */
  markets: z.array(z.unknown()).nullish(),
});

/**
 * Outcome labels by index from the market's own data: outcomeTokens when present (["Yes","No"]); otherwise tokens
 * {yes, no} (single CLOB markets and group legs), whose index order is YES = 0, NO = 1: Limitless documents winningIndex
 * "0 = YES, 1 = NO" (developers/websocket/market-lifecycle.md) and prices[] follows it (the 2026-09-23 sample: the
 * Senate legs price Democratic [0.625, 0.375] and Republican [0.375, 0.625]). AMM markets expose only positionIds,
 * no labels: null, so they abstain and alert rather than guess.
 */
function limitlessLabels(j: z.infer<typeof LimitlessMarket>): string[] | null {
  if (j.outcomeTokens && j.outcomeTokens.length >= 2) return j.outcomeTokens;
  if (j.tokens && "yes" in j.tokens && "no" in j.tokens) return ["Yes", "No"];
  return null;
}

/**
 * Pure: GET /markets/{slug} JSON -> official state. Resolved when winningOutcomeIndex is a number; equal positive
 * payoutNumerators with no index = VOID (CTF 50-50). The REST object has no resolution timestamp and updatedAt is not
 * one (plan §17.1), so official_at is the observation time, labeled limitless_api_poll (withFirstSeen swaps in an
 * earlier sighting when a previous run saw the outcome and could not settle).
 */
export function limitlessOfficial(json: unknown, m: Options, slug: string, observedAt: string): OfficialState {
  const sourceUrl = `https://limitless.exchange/markets/${slug}`;
  const p = LimitlessMarket.safeParse(json);
  if (!p.success) return { kind: "unreachable", detail: `limitless schema drift: ${p.error.issues[0]?.path.join(".") ?? "?"}` };
  const j = p.data;
  // A group container has no outcome of its own; its legs (marketType "group" too, with a groupId) do.
  if (j.markets) return { kind: "unmappable", label: null, source_url: sourceUrl, detail: "slug is a group container; register the leg's own slug" };
  const payout = j.payoutNumerators?.map(Number) ?? null;
  const validPayout = payout && payout.length === 2 && payout.every((x) => Number.isFinite(x) && x >= 0) && payout.some((x) => x > 0) ? payout : null;
  const idx = typeof j.winningOutcomeIndex === "number" ? j.winningOutcomeIndex : null;
  const official = (outcome: "OPTION_A" | "OPTION_B" | "VOID", label: string | null) => ({ outcome, label, at: observedAt, at_source: "limitless_api_poll" as const, source_url: sourceUrl });
  if (validPayout && validPayout[0] === validPayout[1]) {
    if (idx !== null) return { kind: "unmappable", label: null, source_url: sourceUrl, detail: `winningOutcomeIndex ${idx} with equal payoutNumerators` };
    return { kind: "resolved", official: official("VOID", null), detail: "resolved 50-50 (equal payoutNumerators)" };
  }
  if (idx === null) return { kind: "pending", source_url: sourceUrl, detail: `status=${j.status ?? "?"} expired=${j.expired ?? "?"}` };
  if (validPayout && validPayout[idx] !== Math.max(...validPayout)) return { kind: "unmappable", label: null, source_url: sourceUrl, detail: `winningOutcomeIndex ${idx} contradicts payoutNumerators [${validPayout.join(",")}]` };
  const labels = limitlessLabels(j);
  if (!labels) return { kind: "unmappable", label: null, source_url: sourceUrl, detail: `no outcome labels in the market object (tradeType AMM?); index ${idx}` };
  const label = labels[idx];
  if (label === undefined) return { kind: "unmappable", label: null, source_url: sourceUrl, detail: `winningOutcomeIndex ${idx} outside ${labels.length} outcomes` };
  const outcome = mapOfficialLabel(label, m);
  if (!outcome) return { kind: "unmappable", label, source_url: sourceUrl, detail: `official label "${label}" matches neither option` };
  return { kind: "resolved", official: official(outcome, label), detail: `resolved ${label}` };
}

/** The Limitless slug: an importer-supplied meta slug, else external_id. */
export function limitlessSlug(m: Pick<MarketRow, "external_id" | "meta">): string {
  const meta = m.meta ?? {};
  for (const k of ["limitless_slug", "slug"]) { const v = meta[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
  return m.external_id;
}

async function officialFor(env: Env, m: MarketRow, observedAt: string): Promise<OfficialState> {
  const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers: { Accept: "application/json", "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  try {
    switch (m.platform) {
      case "polymarket": {
        const url = `https://gamma-api.polymarket.com/markets/${encodeURIComponent(m.external_id)}`;
        const res = await get(url);
        if (!res.ok) return { kind: "unreachable", detail: `gamma HTTP ${res.status}` };
        return polymarketOfficial(await res.json(), m, observedAt, url);
      }
      case "limitless": {
        const slug = limitlessSlug(m);
        const res = await get(`https://api.limitless.exchange/markets/${encodeURIComponent(slug)}`, env.LIMITLESS_API_KEY ? { "X-API-Key": env.LIMITLESS_API_KEY } : {});
        if (res.status === 404) return { kind: "unmappable", label: null, source_url: `https://limitless.exchange/markets/${slug}`, detail: `limitless has no market "${slug}" (HTTP 404)` };
        if (!res.ok) return { kind: "unreachable", detail: `limitless HTTP ${res.status}` };
        return limitlessOfficial(await res.json(), m, slug, observedAt);
      }
      case "custom":
        return { kind: "unreachable", detail: "custom markets are reconciled manually" };
      default: {
        const never: never = m.platform;
        return { kind: "unreachable", detail: `unknown platform ${String(never)}` };
      }
    }
  } catch (e) {
    return { kind: "unreachable", detail: redact(String(e)).slice(0, 200) };
  }
}

export function agreementFor(committed: Pick<CommittedVerdict, "resolution_status" | "winning_outcome">, officialOutcome: OfficialRecord["outcome"]): Agreement {
  if (officialOutcome === null) return "unresolved_by_platform";
  if (officialOutcome === "VOID") return "void";
  if (committed.resolution_status !== "RESOLVED") return "abstained";
  return committed.winning_outcome === officialOutcome ? "agree" : "disagree";
}

export interface CommitForPlan { id: string; resolution_id: string; created_at: string; telegram_date: string | null; committed: CommittedVerdict }
export interface PlannedReconciliation {
  commit_id: string;
  row: {
    resolution_id: string; market_id: string; platform: string; official_outcome: OfficialRecord["outcome"]; official_label: string | null;
    official_at: string | null; official_at_source: OfficialRecord["at_source"]; agreement: Agreement; lead_seconds: number | null; source_url: string | null; final: boolean;
  };
}

/**
 * Pure: one reconciliation per commit in commit order, final only on the latest commit (the market's one agreement on
 * the public record). The final row comes last so the partial unique index on (market_id) where final never sees two
 * finals mid-statement. lead_seconds = official_at - the commit's telegram_date; null when unposted or no official time.
 */
export function planReconciliations(m: Pick<MarketRow, "id" | "platform">, commits: CommitForPlan[], official: OfficialRecord): PlannedReconciliation[] {
  const ordered = [...commits].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
  const lastId = ordered[ordered.length - 1]?.id;
  return ordered.map((c) => ({
    commit_id: c.id,
    row: {
      resolution_id: c.resolution_id, market_id: m.id, platform: m.platform, official_outcome: official.outcome, official_label: official.label,
      official_at: official.at, official_at_source: official.at ? official.at_source : null, agreement: agreementFor(c.committed, official.outcome),
      lead_seconds: official.at && c.telegram_date ? Math.round((Date.parse(official.at) - Date.parse(c.telegram_date)) / 1000) : null,
      source_url: official.source_url, final: c.id === lastId,
    },
  }));
}

/** A market checked without being settled: when to look again, the backoff exponent, a first official sighting to keep. */
export interface Deferral { id: string; next_at: string; attempts: number; first_seen_at: string | null }

/**
 * Pure. Seconds until a market the run did not settle is checked again. "pending" stays at the cron interval: the
 * official time of a Limitless market is the first poll that sees its outcome (±10 min, plan §17.3), and fairness comes
 * from ordering discovery by reconcile_next_at, not from backing off. "failed" (unmappable, unreachable, a write that
 * failed) doubles per consecutive failed check up to 6 hours: those need a fix or the end of an outage, and their alerts
 * repeat daily.
 */
export function recheckDelaySeconds(kind: "pending" | "failed", failedBefore: number): number {
  if (kind === "pending") return RECHECK_PENDING_S;
  return Math.min(RECHECK_MAX_S, RECHECK_PENDING_S * 2 ** Math.min(20, Math.max(0, failedBefore)));
}

/** Pure. "retry" = due again at once (a stale plan, or the budget ran out), with the failure count unchanged. */
export function deferral(m: Pick<MarketRow, "id" | "reconcile_attempts">, kind: "pending" | "failed" | "retry", nowMs: number, firstSeen: string | null = null): Deferral {
  const failedBefore = m.reconcile_attempts ?? 0;
  if (kind === "retry") return { id: m.id, next_at: new Date(nowMs).toISOString(), attempts: failedBefore, first_seen_at: firstSeen };
  return { id: m.id, next_at: new Date(nowMs + recheckDelaySeconds(kind, failedBefore) * 1000).toISOString(), attempts: kind === "pending" ? 0 : failedBefore + 1, first_seen_at: firstSeen };
}

const pollTime = (s: OfficialRecord["at_source"]) => s === "limitless_api_poll" || s === "first_observed_poll";

/**
 * Pure. A poll-observed official time is the first observation: when an earlier run saw the outcome but could not
 * settle, markets.official_first_seen_at holds that sighting and it wins over this run's (later) one.
 */
export function withFirstSeen(state: OfficialState, firstSeen: string | null | undefined): OfficialState {
  if (state.kind !== "resolved" || !firstSeen || !pollTime(state.official.at_source)) return state;
  return { ...state, official: { ...state.official, at: firstSeen } };
}

/**
 * Pure. The Limitless recorder checks every expired manual market on its own 10-minute dispatch and often sees the
 * outcome before reconcile reaches the market; its first sighting (limitless_markets.resolved_seen_at, migration 018)
 * is the same kind of time (limitless_api_poll, an upper bound on the resolution) and wins when it is earlier than this
 * run's or the stored first sighting. A platform timestamp is never replaced.
 */
export function withRecorderSeen(state: OfficialState, recorderSeen: string | null | undefined): OfficialState {
  if (state.kind !== "resolved" || !recorderSeen || state.official.at_source !== "limitless_api_poll" || !state.official.at) return state;
  const seen = Date.parse(recorderSeen);
  if (!Number.isFinite(seen) || seen >= Date.parse(state.official.at)) return state;
  return { ...state, official: { ...state.official, at: new Date(seen).toISOString() } };
}

export interface ReconcileSummary {
  checked: number; resolved: number; closed_out: number; pending: number; unmappable: number; unreachable: number; disagreements: number;
  awaiting_watch: number; settle_retried: number; rescheduled: number;
  reconciliations: number; reveals_recorded: number; reveals_posted: number; reveals_waiting: number; retried: number; retry_posted: number;
  /** shadow.revealed deliveries queued for followers of the markets settled this run. */
  shadow_revealed_queued: number;
  stopped_by_budget: boolean; subrequests: number; errors: string[];
}

type Row = Record<string, unknown>;

interface CommitDbRow { id: string; market_id: string; resolution_id: string | null; created_at: string; telegram_date: string | null; channel: string; message_id: number | null; commitment_sha256: string; nonce: string; payload: Record<string, unknown>; resolutions: ResolutionFallback | null }

/** settle_market()'s answer (migration 012). */
const SettleAnswer = z.discriminatedUnion("result", [
  z.object({ result: z.literal("settled"), reconciliations: z.number().int(), reveals: z.number().int() }),
  z.object({ result: z.literal("not_open"), status: z.string() }),
  z.object({ result: z.literal("awaiting_watch") }),
  z.object({ result: z.literal("commits_changed") }),
]);

/** One market's check: its reschedule (null once settled), whether it spent the alert reserved with it, whether the budget stopped the run. */
interface Step { defer: Deferral | null; alerted: boolean; stop: boolean }

export async function runReconcile(env: Env): Promise<ReconcileSummary> {
  const client = db(env);
  const started = Date.now();
  const budget = new Budget(RECONCILE_SUBREQUESTS - COST.db); // the loop_runs row below is reserved up front
  const out: ReconcileSummary = { checked: 0, resolved: 0, closed_out: 0, pending: 0, unmappable: 0, unreachable: 0, disagreements: 0, awaiting_watch: 0, settle_retried: 0, rescheduled: 0, reconciliations: 0, reveals_recorded: 0, reveals_posted: 0, reveals_waiting: 0, retried: 0, retry_posted: 0, shadow_revealed_queued: 0, stopped_by_budget: false, subrequests: 0, errors: [] };
  const queued: Row[] = [];
  const say = async (key: string, text: string, dedupMinutes: number) => {
    if (budget.take(COST.alert)) await alert(env, key, text, { dedupMinutes });
    else out.errors.push(`alert ${key} not sent: subrequest budget`);
  };

  const rt = await retryUnposted(env, MAX_RETRIES_PER_RUN, budget);
  out.retried = rt.attempted; out.retry_posted = rt.posted;
  const rv = await postPendingReveals(env, budget, MAX_REVEALS_PER_RUN);
  out.reveals_posted = rv.posted; out.reveals_waiting = rv.waiting;
  if (rt.stopped || rv.stopped) out.stopped_by_budget = true;
  await alertStalePending(client, budget, say, out);
  await discover(env, client, budget, started, out, queued);
  if (out.unreachable) await say("reconcile_unreachable", `reconcile could not read ${out.unreachable} platform answer(s): ${out.errors.slice(0, 3).join("; ")}`, 360);
  // Last, on what the markets left: a row not attempted here is delivered by the 5-minute drain.
  await deliverInline(env, queued, { budget });

  out.subrequests = budget.used + COST.db;
  const rows = out.reconciliations + out.reveals_recorded + out.reveals_posted + out.retry_posted;
  const { error: le } = await client.from("loop_runs").insert({
    loop_name: "settle_bot", verifier_name: "reconcile", verifier_ok: out.errors.length === 0 && out.disagreements === 0,
    outcome: out.errors.length || out.unreachable ? "failure" : rows > 0 ? "success" : "no_op", rows_written: rows, duration_ms: Date.now() - started,
    error: out.errors.length ? out.errors.join(" | ").slice(0, 2000) : null, meta: out,
  });
  if (le) console.error(JSON.stringify({ level: "error", job: "reconcile", error: redact(le.message) }));
  return out;
}

type Say = (key: string, text: string, dedupMinutes: number) => Promise<void>;

/** Commits and reveals still pending after 15 minutes: the post path is broken (token, channel rights, Telegram down). */
async function alertStalePending(client: Db, budget: Budget, say: Say, out: ReconcileSummary): Promise<void> {
  if (!budget.take(COST.db)) { out.stopped_by_budget = true; return; }
  const cutoff = new Date(Date.now() - UNPOSTED_ALERT_MINUTES * 60_000).toISOString();
  const { data, error } = await client.from("bot_posts").select("id, kind, created_at, payload").eq("channel", "pending").lte("created_at", cutoff).order("created_at", { ascending: true }).limit(20);
  if (error) { out.errors.push(`pending check: ${redact(error.message)}`); return; }
  for (const kind of ["commit", "reveal"] as const) {
    const stale = (data ?? []).filter((r) => r.kind === kind);
    if (!stale.length) continue;
    const oldest = stale[0]!;
    const lastError = (oldest.payload as { post_error?: string } | null)?.post_error ?? "no attempt recorded (telegram not configured?)";
    await say(`unposted_${kind}`, `${stale.length}${stale.length === 20 ? "+" : ""} ${kind}(s) still unposted after ${UNPOSTED_ALERT_MINUTES} min; oldest ${oldest.id} from ${oldest.created_at}: ${lastError}`, 60);
  }
}

/**
 * Due markets, longest-waiting first; every market checked and not settled is rescheduled in one defer_reconcile()
 * request. A failure of either request is alerted from a reservation taken up front.
 */
async function discover(env: Env, client: Db, budget: Budget, nowMs: number, out: ReconcileSummary, queued: Row[]): Promise<void> {
  if (!budget.take(2 * COST.db + COST.alert)) { out.stopped_by_budget = true; return; }
  const nowIso = new Date(nowMs).toISOString();
  const { data: markets, error } = await client.from("markets").select("*").is("tenant_id", null).eq("is_test", false).eq("status", "open").in("platform", ["polymarket", "limitless"])
    .is("deleted_at", null).lte("deadline_utc", nowIso).lte("reconcile_next_at", nowIso).order("reconcile_next_at", { ascending: true }).limit(MARKETS_PER_RUN);
  if (error) {
    budget.release(COST.db);
    out.errors.push(`markets: ${redact(error.message)}`);
    await alert(env, "reconcile_discovery", `reconcile could not list the markets due for a check: ${redact(error.message)}. Nothing was reconciled this run.`, { dedupMinutes: 60 });
    return;
  }
  const deferrals: Deferral[] = [];
  const due = (markets ?? []) as unknown as MarketRow[];
  const sightings = await recorderSightings(client, budget, due, out);
  for (const m of due) {
    // Could not read the recorder: settling now could stamp a later official_at than the first sighting, so the
    // Limitless market waits for the next run (a failed read is in out.errors, so the run records a failure).
    if (m.platform === "limitless" && sightings === null) { deferrals.push(deferral(m, "retry", nowMs)); continue; }
    // one alert per market (a label it cannot map, or a write that failed) is reserved with its check
    if (!budget.take(COST.http + COST.alert)) { out.stopped_by_budget = true; break; }
    out.checked++;
    const step = await checkMarket(env, client, budget, m, nowMs, out, queued, sightings?.get(limitlessSlug(m)));
    if (!step.alerted) budget.release(COST.alert);
    if (step.defer) deferrals.push(step.defer);
    if (step.stop) break;
  }
  if (!deferrals.length) { budget.release(COST.db + COST.alert); return; }
  const { data: n, error: de } = await client.rpc("defer_reconcile", { p_rows: deferrals });
  if (de) {
    out.errors.push(`reschedule: ${redact(de.message)}`);
    await alert(env, "reconcile_reschedule", `reconcile could not reschedule ${deferrals.length} market(s): ${redact(de.message)}. They stay due, so the next run checks them again ahead of newer markets.`, { dedupMinutes: 360 });
    return;
  }
  budget.release(COST.alert);
  out.rescheduled = typeof n === "number" ? n : 0;
}

/**
 * The recorder's first sightings (slug -> resolved_seen_at) for the due Limitless markets, in one read. An empty map when
 * none is due (no read); null when the read failed or the budget could not cover it: could not look, never "none seen".
 */
async function recorderSightings(client: Db, budget: Budget, due: MarketRow[], out: ReconcileSummary): Promise<Map<string, string> | null> {
  const slugs = [...new Set(due.filter((m) => m.platform === "limitless").map(limitlessSlug))];
  if (!slugs.length) return new Map();
  if (!budget.take(COST.db)) { out.stopped_by_budget = true; return null; }
  const { data, error } = await client.from("limitless_markets").select("slug, resolved_seen_at").in("slug", slugs);
  if (error) { out.errors.push(`recorder sightings: ${redact(error.message)}`); return null; }
  const seen = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ slug: string; resolved_seen_at: string | null }>) if (r.resolved_seen_at) seen.set(r.slug, r.resolved_seen_at);
  return seen;
}

async function checkMarket(env: Env, client: Db, budget: Budget, m: MarketRow, nowMs: number, out: ReconcileSummary, queued: Row[], recorderSeen?: string): Promise<Step> {
  const state = withRecorderSeen(withFirstSeen(await officialFor(env, m, new Date(nowMs).toISOString()), m.official_first_seen_at), recorderSeen);
  switch (state.kind) {
    case "unreachable":
      out.unreachable++; out.errors.push(`${marketRef(m)}: ${state.detail}`);
      return { defer: deferral(m, "failed", nowMs), alerted: false, stop: false };
    case "unmappable":
      out.unmappable++;
      await alert(env, `reconcile_label_${m.id}`, `reconcile cannot map the official outcome of ${marketRef(m)} (options "${m.option_a}" / "${m.option_b}"): ${state.detail}. No reconciliation was written; the market stays open, rechecked with backoff, until its registration is fixed by hand. ${state.source_url}`, { dedupMinutes: 1440 });
      return { defer: deferral(m, "failed", nowMs), alerted: true, stop: false };
    case "pending":
      if (nowMs < Date.parse(m.deadline_utc) + CLOSE_OUT_DAYS * 86_400_000) { out.pending++; return { defer: deferral(m, "pending", nowMs), alerted: false, stop: false }; }
      return settle(env, client, budget, m, { outcome: null, label: null, at: null, at_source: null, source_url: state.source_url }, nowMs, out, queued);
    case "resolved":
      return settle(env, client, budget, m, state.official, nowMs, out, queued);
    default: {
      const never: never = state;
      throw new Error(`unhandled official state ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Plan one market's outcome and write it through settle_market(), which does every write in one transaction (and
 * nothing when a watch still owes its post-deadline poll, or a commit landed that this plan did not see). A failure
 * spends the alert reserved with the market's check and reschedules it with backoff. A settled market's followers get
 * shadow.revealed, queued inside the same reservation so it can never be dropped for budget.
 */
async function settle(env: Env, client: Db, budget: Budget, m: MarketRow, official: OfficialRecord, nowMs: number, out: ReconcileSummary, queued: Row[]): Promise<Step> {
  const firstSeen = official.at && pollTime(official.at_source) ? official.at : null;
  const later = (kind: "pending" | "failed" | "retry", alerted = false, stop = false): Step => ({ defer: deferral(m, kind, nowMs, firstSeen), alerted, stop });
  const failed = async (what: string, message: string): Promise<Step> => {
    const text = `${marketRef(m)} ${what}: ${redact(message)}`;
    out.errors.push(text);
    await alert(env, `reconcile_write_${m.id}`, `reconcile could not settle ${text}. Nothing was written for the market; it stays open and is retried with backoff.`, { dedupMinutes: 1440 });
    return later("failed", true);
  };
  if (!budget.take(COST.db)) { out.stopped_by_budget = true; return later("retry", false, true); }
  const { data, error } = await client.from("bot_posts")
    .select("id, market_id, resolution_id, created_at, telegram_date, channel, message_id, commitment_sha256, nonce, payload, resolutions(resolution_status, winning_outcome, confidence_score, caveats, thresholds_version, determination_basis)")
    .eq("market_id", m.id).eq("kind", "commit");
  if (error) return failed("commits read", error.message);
  const rows = (data ?? []) as unknown as CommitDbRow[];
  const commits: Array<CommitForPlan & { db: CommitDbRow; provable: boolean }> = [];
  const unprovable: string[] = []; // commits that cannot be revealed: unreadable, or a preimage that does not hash to the commitment
  for (const r of rows) {
    const committed = r.resolution_id ? committedOf(r as CommitRow, r.resolutions) : null;
    if (!committed || !r.resolution_id) { unprovable.push(`${r.id} (committed verdict unreadable)`); continue; }
    // Never reveal a preimage that does not hash to the published commitment.
    const provable = (await sha256Hex(committed.preimage)) === r.commitment_sha256;
    if (!provable) unprovable.push(`${r.id} (preimage does not hash to the commitment)`);
    commits.push({ id: r.id, resolution_id: r.resolution_id, created_at: r.created_at, telegram_date: r.telegram_date, committed, db: r, provable });
  }
  const plan = planReconciliations(m, commits, official);
  const disagree = plan.filter((p) => p.row.agreement === "disagree");
  // the write, the alerts a settled market raises and its followers' shadow.revealed, reserved together so neither an
  // alert nor the event is ever dropped for budget
  const alerts = ((disagree.length ? 1 : 0) + (unprovable.length ? 1 : 0)) * COST.alert + QUEUE_SUBREQUESTS;
  if (!budget.take(COST.db + alerts)) { out.stopped_by_budget = true; return later("retry", false, true); }

  const byId = new Map(commits.map((c) => [c.id, c]));
  const reveals = plan.flatMap((p) => {
    const c = byId.get(p.commit_id)!;
    if (!c.provable) return [];
    const { payload } = buildReveal(m, c.db, c.committed, official, p.row.agreement);
    // A commit that was never public (channel none) gets a recorded, never-posted reveal; otherwise the reveal waits
    // pending until postPendingReveals replies to the posted commit.
    const channel = c.db.channel === "none" ? "none" : "pending";
    return [{ resolution_id: c.resolution_id, channel, reply_to_message_id: c.db.message_id, commitment_sha256: c.db.commitment_sha256, nonce: c.db.nonce, payload, dedup_key: `reveal:${c.id}` }];
  });
  const status = official.outcome === null ? "closed_unresolved" : official.outcome === "VOID" ? "void" : "resolved";
  const { data: answer, error: se } = await client.rpc("settle_market", {
    // every commit read, readable or not: settle_market refuses a plan that missed a commit written since
    p_market: m.id, p_commit_ids: rows.map((r) => r.id), p_reconciliations: plan.map((p) => p.row), p_reveals: reveals,
    p_status: status, p_official_outcome: official.outcome, p_official_at: official.at, p_official_source_url: official.source_url,
  });
  const parsed = se ? null : SettleAnswer.safeParse(answer);
  if (!parsed?.success) {
    budget.release(alerts);
    return failed("settle_market", se?.message ?? `unexpected answer ${JSON.stringify(answer).slice(0, 200)}`);
  }
  const a = parsed.data;
  switch (a.result) {
    case "awaiting_watch": // nothing written; the post-deadline verdict may still be committed
      budget.release(alerts); out.awaiting_watch++;
      return later("pending");
    case "commits_changed": // watches are off now, so the next run's plan is complete
      budget.release(alerts); out.settle_retried++;
      return later("retry");
    case "not_open": // settled by a concurrent run
      budget.release(alerts); out.settle_retried++;
      return { defer: null, alerted: false, stop: false };
    case "settled":
      break;
    default: {
      const never: never = a;
      throw new Error(`unhandled settle answer ${JSON.stringify(never)}`);
    }
  }
  out.reconciliations += a.reconciliations; out.reveals_recorded += a.reveals;
  if (official.outcome === null) out.closed_out++; else out.resolved++;
  const revealed: RevealedCommit[] = plan.map((p) => {
    const c = byId.get(p.commit_id)!;
    return { commitment_sha256: c.db.commitment_sha256, committed_at: c.created_at, agreement: p.row.agreement, final: p.row.final, committed: c.provable ? c.committed : null };
  });
  const q = await queueForFollowers(env, m, "shadow.revealed", shadowRevealedPayload(m, official, revealed));
  queued.push(...q.rows);
  out.shadow_revealed_queued += q.rows.length;
  if (q.error) out.errors.push(`${marketRef(m)} shadow.revealed: ${q.error}`);
  // No follower (the common case): only the follows read was spent. Otherwise keep the reservation (an alert may be spent).
  if (!q.followers && !q.error) budget.release(QUEUE_SUBREQUESTS - COST.db);
  if (disagree.length) {
    out.disagreements += disagree.length;
    await alert(env, `reconcile_disagree_${m.id}`, `DISAGREE on ${marketRef(m)}: ${disagree.length} commit(s) called the market against the official ${official.outcome}${official.label ? ` (${official.label})` : ""}${disagree.some((d) => d.row.final) ? ", including the final commit (a false RESOLVED on the public record)" : ""}. Revealed through the same path as agreements. ${official.source_url ?? ""}`, { dedupMinutes: 1440 });
  }
  if (unprovable.length) {
    out.errors.push(`${marketRef(m)} unprovable commits: ${unprovable.join(", ")}`);
    await alert(env, `reveal_preimage_${m.id}`, `${marketRef(m)}: ${unprovable.length} commit(s) cannot be revealed: ${unprovable.join(", ")}. Readable ones are reconciled; none of these is revealed.`, { dedupMinutes: 1440 });
  }
  return { defer: null, alerted: false, stop: false };
}

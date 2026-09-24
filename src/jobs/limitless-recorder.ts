/**
 * Limitless resolution-latency recorder (plan §17.3 P0 row, §19.3). Limitless's REST object has no resolution
 * timestamp (updatedAt is not one, plan §17.1), so the official time of a manual market is the first observation that
 * shows its outcome: source limitless_api_poll, within the poll gap (±10 min when every pending market is checked each
 * run). The database keeps each first sighting once (migration 018); reconcile uses it as official_at when it is earlier
 * than its own sighting. The same rows are the weekly creation cadence of manual markets (v_limitless_cadence).
 *
 * One run = one signed pg_net POST from dispatch_internal('limitless_record') every 10 minutes (or an admin POST), its
 * own Worker invocation, on RECORDER_SUBREQUESTS:
 *   state   1  app_config: the page cursor and the consecutive-failure count
 *   import  1  GET /markets/active?automationType=manual, one page of 25 per run (the filter lets other rows through,
 *              so automationType is re-checked per row). Group legs come inline in the feed row; a container whose
 *              legs were never recorded is fetched with GET /markets/<group slug>, at most MAX_GROUP_FETCHES per run
 *   write   1  record_limitless_observations(feed rows): the atomic merge, which answers the due list
 *   check  <=25 GET /markets/<slug> for expired markets with no outcome yet, least recently checked first
 *   write   1  record_limitless_observations(legs + checks)
 *   end     2  app_config upsert and the loop_runs row, plus one alertMany() (5), all reserved before any work
 * Worst case 1 + 1 + 4 + 1 + 25 + 1 + 2 + 5 = 40 of 45. CPU (Workers Free: 10 ms): a feed page is ~350 KB of JSON,
 * 0.6 ms to JSON.parse on the founder's machine (2026-09-24 capture); the schemas keep only the fields below.
 * Wall time: pg_net hangs up after 30 s and Cloudflare then cancels the invocation, so no request starts after
 * RUN_DEADLINE_MS, the loop_runs row (which decides the answer) is written before the alert, and the alert (a Telegram
 * DM that can take longer than the whole run) goes out under waitUntil when the route gives one.
 * The marketResolved websocket (exact resolutionDate) needs a Durable Object on Workers Paid:
 * docs/runbooks/limitless-recorder.md.
 */
import { z } from "zod";
import type { Env } from "../env";
import { db, type Db } from "../db/supabase";
import { alertMany, type AlertItem } from "../ops/alerts";
import { Budget, COST } from "../ops/budget";
import { redact } from "../ops/redact";
import type { WaitUntil } from "../webhooks/deliver";
import { CLOSE_OUT_DAYS } from "./reconcile";
import { botUa } from "../ops/ua";

/** 5 below Workers Free's 50 per invocation: a miscount here can never cost the run its loop_runs row. */
export const RECORDER_SUBREQUESTS = 45;
export const LIMITLESS_API = "https://api.limitless.exchange";
/** The feed's maximum (limit=100 answers 400, plan §16.2). */
export const PAGE_SIZE = 25;
/** 1,000 markets; the manual feed had 296 rows on 2026-09-24. A cursor past it (or unreadable) restarts at 1. */
export const MAX_PAGE = 40;
export const MAX_GROUP_FETCHES = 4;
export const MAX_CHECKS_PER_RUN = 25;
/** Stop checking a market this long after its expiry with no outcome: reconcile closes it out at the same age. */
export const GIVE_UP_DAYS = CLOSE_OUT_DAYS;
/** loop_name of every run's row; the liveness tick alerts when the newest is stale (src/jobs/tick.ts). */
export const RECORDER_LOOP = "limitless_recorder";
export const PAGE_KEY = "limitless_recorder_page";
export const FAILURES_KEY = "limitless_recorder_failures";
export const FAILING_ALERT_RUNS = 3;
export const FAILING_DEDUP_MINUTES = 360;
export const SCHEMA_DEDUP_MINUTES = 1440;
/**
 * pg_net's timeout for this dispatch (dispatch_internal, migration 018). Past it pg_net hangs up and Cloudflare cancels
 * an HTTP-triggered invocation whose client is gone: the run would end without its cursor, streak or loop_runs row.
 */
export const DISPATCH_TIMEOUT_MS = 30_000;
/**
 * No request starts after this, so the last one ends by RUN_DEADLINE_MS + FETCH_TIMEOUT_MS = 20 s and leaves 10 s of
 * DISPATCH_TIMEOUT_MS for the three writes after it (the checks, app_config, loop_runs).
 */
export const RUN_DEADLINE_MS = 12_000;
export const FETCH_TIMEOUT_MS = 8000;
/** The loop_runs row, the app_config write and one alertMany(), reserved before any work. */
const END_RESERVE = 2 * COST.db + COST.alert;

const Slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);
/**
 * Milliseconds since the epoch, 2001-09-09 to year 5138. A value in seconds or nanoseconds (a unit drift) is schema
 * drift, counted and alerted: never a 1970 expiry, and never a RangeError from toISOString() that stops every run on
 * the same page (Date ends at 8.64e15 ms).
 */
const EpochMs = z.number().int().min(1e12).max(1e14);
/** The fields the recorder keeps from a Limitless market object (feed row, group leg or GET /markets/<slug>). */
const MarketObject = z.object({
  id: z.union([z.number(), z.string()]).nullish(),
  slug: Slug,
  marketType: z.string().nullish(),
  tradeType: z.string().nullish(),
  automationType: z.string().nullish(),
  conditionId: z.string().nullish(),
  groupId: z.union([z.number(), z.string()]).nullish(),
  status: z.string().nullish(),
  expired: z.boolean().nullish(),
  expirationTimestamp: EpochMs.nullish(),
  createdAt: z.string().nullish(),
  winningOutcomeIndex: z.number().int().nonnegative().nullish(),
  payoutNumerators: z.array(z.union([z.number(), z.string()])).nullish(),
  categories: z.array(z.string()).nullish(),
});
type MarketObject = z.infer<typeof MarketObject>;
/** Legs are parsed one by one, so one malformed leg never drops its group. */
const WithLegs = MarketObject.extend({ markets: z.array(z.unknown()).nullish() });
const FeedPage = z.object({ data: z.array(z.unknown()), totalMarketsCount: z.number().int().nonnegative() });

/** One row for record_limitless_observations (migration 018). observed = false: a check that could not read the market. */
export interface Observation {
  slug: string; group_slug: string | null; container: boolean; condition_id: string | null; category: string | null;
  trade_type: string | null; automation_type: string | null; market_type: string | null; expiration_at: string | null;
  platform_created_at: string | null; observed: boolean; observed_at: string | null; checked: boolean; expired: boolean;
  winning_outcome_index: number | null; void: boolean; meta: Record<string, unknown>;
}

const isoOrNull = (t: number | null | undefined): string | null => (typeof t === "number" && Number.isFinite(t) ? new Date(t).toISOString() : null);
const isoFromText = (s: string | null | undefined): string | null => { const t = Date.parse(s ?? ""); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const issuePath = (e: z.ZodError) => e.issues[0]?.path.join(".") || "(root)";

/**
 * Pure. Equal positive payoutNumerators with no winningOutcomeIndex is a void (CTF 50-50), the reconcile reading
 * (src/jobs/reconcile.ts limitlessOfficial); anything else without an index is still pending.
 */
export function isVoid(m: Pick<MarketObject, "winningOutcomeIndex" | "payoutNumerators">): boolean {
  if (typeof m.winningOutcomeIndex === "number" || !m.payoutNumerators) return false;
  const p = m.payoutNumerators.map(Number);
  return p.length === 2 && p.every((x) => Number.isFinite(x) && x >= 0) && p[0]! > 0 && p[0] === p[1];
}

export interface ObserveContext { observedAt: string; checked: boolean; container?: boolean; groupSlug?: string | null; parentCategory?: string | null }

/**
 * Pure. One market object -> one observation. Only an outcome of the object's own counts: a container has none (its
 * legs do), so it never carries an index. The observation states what was seen; the database decides whether it is
 * the first sighting (record_limitless_observations keeps resolved_seen_at and the index once set).
 */
export function observe(m: MarketObject, ctx: ObserveContext): Observation {
  const container = !!ctx.container;
  const voided = !container && isVoid(m);
  const meta: Record<string, unknown> = { platform_id: m.id ?? null, group_id: m.groupId ?? null, status: m.status ?? null, categories: m.categories ?? [] };
  if (m.payoutNumerators) meta.payout_numerators = m.payoutNumerators;
  if (voided) meta.void = true;
  if (ctx.checked) { meta.last_error = null; meta.last_http_status = 200; }
  return {
    slug: m.slug, group_slug: ctx.groupSlug ?? null, container, condition_id: m.conditionId ?? null,
    category: m.categories?.[0] ?? ctx.parentCategory ?? null, trade_type: m.tradeType ?? null, automation_type: m.automationType ?? null,
    market_type: m.marketType ?? null, expiration_at: isoOrNull(m.expirationTimestamp), platform_created_at: isoFromText(m.createdAt),
    observed: true, observed_at: ctx.observedAt, checked: ctx.checked, expired: m.expired === true,
    winning_outcome_index: container ? null : (m.winningOutcomeIndex ?? null), void: voided, meta,
  };
}

/** Pure. A check that could not read the market: it moves to the back of the queue, and the error is kept on the row. */
export function failedCheck(slug: string, error: string, httpStatus: number | null): Observation {
  return {
    slug, group_slug: null, container: false, condition_id: null, category: null, trade_type: null, automation_type: null, market_type: null,
    expiration_at: null, platform_created_at: null, observed: false, observed_at: null, checked: true, expired: false,
    winning_outcome_index: null, void: false, meta: { last_error: redact(error).slice(0, 300), last_http_status: httpStatus },
  };
}

export interface LegsResult { observations: Observation[]; dropped: number }

/** Pure. The legs of a container (feed row or GET /markets/<group slug>), each with the container's slug. */
export function legObservations(group: { slug: string; categories?: string[] | null }, legs: unknown[], observedAt: string): LegsResult {
  const out: Observation[] = [];
  let dropped = 0;
  for (const raw of legs) {
    const p = MarketObject.safeParse(raw);
    if (!p.success) { dropped++; continue; }
    out.push(observe(p.data, { observedAt, checked: false, groupSlug: group.slug, parentCategory: group.categories?.[0] ?? null }));
  }
  return { observations: out, dropped };
}

export interface FeedParse {
  observations: Observation[];
  /** Containers the row gave no legs for: GET /markets/<slug> if their legs were never recorded. */
  containers_without_legs: string[];
  rows: number; manual: number; non_manual_skipped: number; schema_dropped: number; legs: number; legs_dropped: number;
  /** The first schema failure, for the alert. */
  drift: string | null;
}

/**
 * Pure. One feed page's rows -> observations. The feed's automationType filter is not trusted (47 of 296 rows came back
 * "sports" on 2026-09-24): a row that is not manual is skipped and counted. A group row becomes its container plus one
 * observation per leg (group_slug set); a row that fails the schema is counted, never guessed.
 */
export function feedObservations(rows: unknown[], observedAt: string): FeedParse {
  const out: FeedParse = { observations: [], containers_without_legs: [], rows: rows.length, manual: 0, non_manual_skipped: 0, schema_dropped: 0, legs: 0, legs_dropped: 0, drift: null };
  for (const raw of rows) {
    const p = WithLegs.safeParse(raw);
    if (!p.success) { out.schema_dropped++; out.drift ??= `feed row: ${issuePath(p.error)}`; continue; }
    const row = p.data;
    if (row.automationType !== "manual") { out.non_manual_skipped++; continue; }
    out.manual++;
    const container = row.marketType === "group" || !!row.markets?.length;
    out.observations.push(observe(row, { observedAt, checked: false, container }));
    if (!container) continue;
    if (!row.markets?.length) { out.containers_without_legs.push(row.slug); continue; }
    const legs = legObservations(row, row.markets, observedAt);
    out.observations.push(...legs.observations);
    out.legs += legs.observations.length;
    if (legs.dropped) { out.legs_dropped += legs.dropped; out.drift ??= `leg of ${row.slug}`; }
  }
  return out;
}

/** Pure. GET /markets/<group slug> -> its legs, or why it could not give them. */
export function groupLegs(json: unknown, groupSlug: string, observedAt: string): LegsResult | { error: string } {
  const p = WithLegs.safeParse(json);
  if (!p.success) return { error: `schema drift at ${issuePath(p.error)}` };
  if (p.data.slug !== groupSlug) return { error: `answered for slug ${p.data.slug}` };
  if (!p.data.markets?.length) return { error: "no legs in the group object" };
  return legObservations(p.data, p.data.markets, observedAt);
}

/** Pure. GET /markets/<slug> answer -> one check observation (a failed one when the object is not this market's). */
export function checkObservation(slug: string, json: unknown, observedAt: string): Observation {
  const p = WithLegs.safeParse(json);
  if (!p.success) return failedCheck(slug, `schema drift at ${issuePath(p.error)}`, 200);
  if (p.data.slug !== slug) return failedCheck(slug, `answered for slug ${p.data.slug}`, 200);
  if (p.data.markets?.length) return failedCheck(slug, "slug is a group container, not a market with an outcome", 200);
  return observe(p.data, { observedAt, checked: true });
}

/** Pure. The stored cursor: an integer page in 1..MAX_PAGE; anything else restarts at 1. */
export function parseCursor(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_PAGE ? n : 1;
}

/** Pure. The page after this one: back to 1 after a short page, the feed's last page, or MAX_PAGE. */
export function nextPage(page: number, rowsOnPage: number, total: number): number {
  return rowsOnPage < PAGE_SIZE || page * PAGE_SIZE >= total || page >= MAX_PAGE ? 1 : page + 1;
}

/**
 * Pure. Consecutive failed runs after this one, and whether to alert. An unreadable count with a failed run alerts
 * (could not look is not zero); a run that did not fail resets the count.
 */
export function failureStreak(previous: number | null, failed: boolean): { failures: number; alert: boolean } {
  if (!failed) return { failures: 0, alert: false };
  const failures = (previous ?? 0) + 1;
  return { failures, alert: previous === null || failures >= FAILING_ALERT_RUNS };
}

export interface RecorderSummary {
  page: number; next_page: number; feed_total: number | null; feed_rows: number; manual_rows: number; non_manual_skipped: number;
  schema_dropped: number; legs_dropped: number; containers_without_legs: number; groups_fetched: number;
  observations: number; inserted: number; updated: number; newly_expired: number; newly_resolved: number;
  due: number; checked: number; check_errors: number;
  consecutive_failures: number | null;
  /** Keys raised this run, raised after the loop_runs row; delivery and dedup are in the alerts table. */
  alerts: string[];
  stopped_by_budget: boolean; stopped_by_deadline: boolean; subrequests: number;
  /** false when the run's loop_runs row could not be written: the route answers 500 so dispatch_failures() counts it. */
  recorded: boolean;
  errors: string[];
}

const RecordAnswer = z.object({
  inserted: z.number().int(), updated: z.number().int(), newly_expired: z.number().int(), newly_resolved: z.number().int(),
  groups_missing_legs: z.array(z.string()), due: z.array(z.string()),
});

function limitlessHeaders(env: Env): Record<string, string> {
  const key = env.LIMITLESS_API_KEY?.trim();
  return { Accept: "application/json", "User-Agent": botUa(env), ...(key ? { "X-API-Key": key } : {}) };
}

type Got = { ok: true; json: unknown } | { ok: false; status: number | null; error: string };

async function getJson(env: Env, url: string): Promise<Got> {
  try {
    const res = await fetch(url, { headers: limitlessHeaders(env), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, json: await res.json() };
  } catch (e) {
    return { ok: false, status: null, error: redact(String(e)).slice(0, 200) };
  }
}

async function record(client: Db, rows: Observation[], dueLimit: number): Promise<z.infer<typeof RecordAnswer> | { error: string }> {
  try {
    const { data, error } = await client.rpc("record_limitless_observations", { p_rows: rows, p_due_limit: dueLimit, p_give_up_days: GIVE_UP_DAYS });
    if (error) return { error: redact(`${error.code ?? ""} ${error.message}`.trim()).slice(0, 300) };
    const p = RecordAnswer.safeParse(data);
    return p.success ? p.data : { error: `unexpected answer ${JSON.stringify(data).slice(0, 120)}` };
  } catch (e) {
    return { error: redact(String(e)).slice(0, 300) };
  }
}

export async function runLimitlessRecorder(env: Env, opts: { waitUntil?: WaitUntil } = {}): Promise<RecorderSummary> {
  const started = Date.now();
  const client = db(env);
  const budget = new Budget(RECORDER_SUBREQUESTS);
  budget.need(END_RESERVE, "the end-of-run writes");
  const out: RecorderSummary = {
    page: 1, next_page: 1, feed_total: null, feed_rows: 0, manual_rows: 0, non_manual_skipped: 0, schema_dropped: 0, legs_dropped: 0,
    containers_without_legs: 0, groups_fetched: 0, observations: 0, inserted: 0, updated: 0, newly_expired: 0, newly_resolved: 0,
    due: 0, checked: 0, check_errors: 0, consecutive_failures: null, alerts: [], stopped_by_budget: false, stopped_by_deadline: false,
    subrequests: 0, recorded: false, errors: [],
  };
  const overDeadline = () => { if (Date.now() - started <= RUN_DEADLINE_MS) return false; out.stopped_by_deadline = true; return true; };
  const tally = (a: z.infer<typeof RecordAnswer>) => { out.inserted += a.inserted; out.updated += a.updated; out.newly_expired += a.newly_expired; out.newly_resolved += a.newly_resolved; };

  // state ------------------------------------------------------------------------------------------------------------
  let previousFailures: number | null = null;
  budget.need(COST.db, "the state read");
  try {
    const { data, error } = await client.from("app_config").select("key, value").in("key", [PAGE_KEY, FAILURES_KEY]);
    if (error) throw new Error(error.message);
    const cfg = new Map(((data ?? []) as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
    out.page = parseCursor(cfg.get(PAGE_KEY));
    const f = Number(cfg.get(FAILURES_KEY) ?? "0");
    previousFailures = Number.isInteger(f) && f >= 0 ? f : 0;
  } catch (e) {
    out.errors.push(`state read: ${redact(String(e)).slice(0, 200)}`);
  }
  out.next_page = out.page;

  // import: one feed page ----------------------------------------------------------------------------------------------
  let feed: FeedParse | null = null;
  budget.need(COST.http, "the feed page");
  const feedAt = new Date().toISOString();
  const page = await getJson(env, `${LIMITLESS_API}/markets/active?automationType=manual&page=${out.page}&limit=${PAGE_SIZE}`);
  if (!page.ok) out.errors.push(`feed page ${out.page}: ${page.error}`);
  else {
    const p = FeedPage.safeParse(page.json);
    if (!p.success) out.errors.push(`feed page ${out.page}: schema drift at ${issuePath(p.error)}`);
    else {
      feed = feedObservations(p.data.data, feedAt);
      out.feed_total = p.data.totalMarketsCount;
      out.feed_rows = feed.rows; out.manual_rows = feed.manual; out.non_manual_skipped = feed.non_manual_skipped;
      out.schema_dropped = feed.schema_dropped; out.legs_dropped = feed.legs_dropped; out.containers_without_legs = feed.containers_without_legs.length;
      out.next_page = nextPage(out.page, p.data.data.length, p.data.totalMarketsCount);
      if (feed.drift) out.errors.push(`${feed.schema_dropped} feed row(s) and ${feed.legs_dropped} leg(s) failed the schema (first: ${feed.drift})`);
    }
  }

  // write the feed, learn what to check ------------------------------------------------------------------------------
  // What the budget leaves for checks once the second write and the group fetches are set aside.
  budget.need(COST.db, "the feed write");
  const dueLimit = Math.max(0, Math.min(MAX_CHECKS_PER_RUN, budget.left - COST.db - MAX_GROUP_FETCHES * COST.http));
  const first = await record(client, feed?.observations ?? [], dueLimit);
  out.observations += feed?.observations.length ?? 0;
  let due: string[] = [];
  let missing: string[] = [];
  if ("error" in first) {
    out.errors.push(`record feed: ${first.error}`);
    out.next_page = out.page; // the page moves on only once its rows are written: the next run reads it again
  } else { tally(first); due = first.due; missing = first.groups_missing_legs; }
  out.due = due.length;

  // legs of containers never recorded (the feed inlines legs, so this is the fallback) --------------------------------
  const second: Observation[] = [];
  for (const slug of missing.slice(0, MAX_GROUP_FETCHES)) {
    if (overDeadline()) break;
    if (!budget.take(COST.http)) { out.stopped_by_budget = true; break; }
    const at = new Date().toISOString();
    const g = await getJson(env, `${LIMITLESS_API}/markets/${encodeURIComponent(slug)}`);
    out.groups_fetched++;
    const legs = g.ok ? groupLegs(g.json, slug, at) : { error: g.error };
    if ("error" in legs) { out.errors.push(`group ${slug}: ${legs.error}`); continue; }
    second.push(...legs.observations);
    if (legs.dropped) { out.legs_dropped += legs.dropped; out.errors.push(`group ${slug}: ${legs.dropped} leg(s) failed the schema`); }
  }

  // check expired markets with no outcome yet -------------------------------------------------------------------------
  const failures: string[] = [];
  for (const slug of due) {
    if (overDeadline()) break;
    if (!budget.take(COST.http)) { out.stopped_by_budget = true; break; }
    const at = new Date().toISOString(); // before the request: a pending answer is never later than the platform's read
    const r = await getJson(env, `${LIMITLESS_API}/markets/${encodeURIComponent(slug)}`);
    const o = r.ok ? checkObservation(slug, r.json, at) : failedCheck(slug, r.error, r.status);
    out.checked++;
    if (!o.observed) { out.check_errors++; failures.push(`${slug}: ${String(o.meta.last_error)}`); }
    second.push(o);
  }
  // One market's error is on its row (meta.last_error) and it moves to the back of the queue; all of them failing is the run failing.
  if (out.checked > 0 && out.check_errors === out.checked) out.errors.push(`all ${out.checked} check(s) failed: ${failures.slice(0, 3).join("; ")}`);

  if (second.length) {
    budget.need(COST.db, "the check write"); // set aside when dueLimit was computed
    const r = await record(client, second, 0);
    out.observations += second.length;
    if ("error" in r) out.errors.push(`record checks: ${r.error}`);
    else tally(r);
  }

  // end: cursor, failure streak, loop_runs, then alerts (reserved up front) ---------------------------------------
  const failed = out.errors.length > 0;
  const streak = failureStreak(previousFailures, failed);
  out.consecutive_failures = streak.failures;
  const { error: se } = await client.from("app_config").upsert([
    { key: PAGE_KEY, value: String(out.next_page), updated_at: new Date().toISOString() },
    { key: FAILURES_KEY, value: String(streak.failures), updated_at: new Date().toISOString() },
  ], { onConflict: "key" });
  if (se) out.errors.push(`state write: ${redact(se.message).slice(0, 200)}`);

  const alerts: AlertItem[] = [];
  if (streak.alert) alerts.push({
    key: "limitless_recorder_failing", dedupMinutes: FAILING_DEDUP_MINUTES,
    text: `The Limitless recorder failed ${previousFailures === null ? "this run and could not read how many before it" : `${streak.failures} runs in a row`}: ${out.errors.slice(0, 3).join("; ")}. First sightings of Limitless outcomes are not being recorded while this lasts (reconcile falls back to its own). loop_runs where loop_name = 'limitless_recorder' has every run.`,
    meta: { page: out.page, errors: out.errors.slice(0, 5) },
  });
  if (out.schema_dropped || out.legs_dropped) alerts.push({
    key: "limitless_recorder_schema", dedupMinutes: SCHEMA_DEDUP_MINUTES,
    text: `Limitless answered ${out.schema_dropped} feed row(s) and ${out.legs_dropped} group leg(s) the recorder's schema refuses (page ${out.page}${feed?.drift ? `, first: ${feed.drift}` : ""}). Those markets are not recorded until src/jobs/limitless-recorder.ts reads the new shape.`,
  });
  out.alerts = alerts.map((a) => a.key);
  if (!alerts.length) budget.release(COST.alert);

  out.subrequests = budget.used;
  const rows = out.inserted + out.updated;
  const { errors, recorded: _unknownYet, ...meta } = out;
  try {
    const { error } = await client.from("loop_runs").insert({
      loop_name: RECORDER_LOOP, outcome: errors.length ? "failure" : rows > 0 ? "success" : "no_op", rows_written: rows,
      duration_ms: Date.now() - started, error: errors.length ? errors.join(" | ").slice(0, 2000) : null, meta,
    });
    out.recorded = !error;
    if (error) console.error(JSON.stringify({ level: "error", job: "limitless_recorder", error: redact(error.message) }));
  } catch (e) {
    console.error(JSON.stringify({ level: "error", job: "limitless_recorder", error: redact(String(e)) }));
  }
  // After the row: alertMany never throws, and a slow DM (3 attempts of up to 8 s) must not cost the run its answer.
  if (alerts.length) {
    const sending = alertMany(env, alerts);
    if (opts.waitUntil) opts.waitUntil(sending);
    else await sending;
  }
  return out;
}

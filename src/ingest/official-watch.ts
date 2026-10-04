/**
 * The official_release step of a watch poll (runWatch calls fetchOfficial for source_kind official_release).
 *
 * (a) Before the event's scheduled release (KNOWN_RELEASES, else the market's release_at): no upstream request;
 *     next_poll_at = the start of the release minute (pg_cron dispatches once a minute, migration 007).
 * (b) At/after it every leg first reads the shared first print (official_observations, migration 016). Dozens of
 *     legs of one ladder share one (series, period): only the holder of claim_official_fetch requests the source,
 *     so the upstream sees one fetcher per minute however many legs exist. Series read from one page (the CPI
 *     release: headline and core, 1- and 12-month; the Employment Situation: unemployment rate and payrolls) share
 *     one slot named by their fetch group (fetchSlotOf), and the holder's capture in waitUntil records every series
 *     of the group the page states for the period from the same bytes (also when the page is out without the
 *     holder's own number, a "-" cell, or when the holder's part of the page drifted), so the page is fetched once
 *     per release. A Retry-After extends that lease, so every ladder on the page backs off, not one leg.
 * (c) The holder's capture runs in waitUntil whenever the route has an ExecutionContext, and the poll returns at
 *     once: pg_net waits 30 s at most. Inside the release minute it is the scheduled burst (plan §18.1): every 3 s for
 *     at most 25 s and at most 10 upstream requests, stopping at the first observation. A first print the burst
 *     inserts within INLINE_COMMIT_WINDOW_S (15 s) of release_at commits the holder's own leg in the same invocation
 *     (holderCapture: runWatch of that watch again, dispatch inline_commit, so the same store, resolve, commitVerdict
 *     and publishShadowCommitted as every poll) and starts every other open leg of the event at once
 *     (redispatch_official_legs, migration 024: one signed pg_net POST per leg, each its own invocation), before the
 *     siblings are recorded; the poll keeps the holder's lease until a second before its next minute poll, so no other
 *     run of that leg starts beside the inline commit, and commitVerdict's dedup against the market's latest commit
 *     holds even if one did. A first print recorded later, or outside the release minute, resolves every leg from the
 *     stored row on its next minute poll, as before (MEASURED 2026-10-02: first print +8 s, commit rows +61 s; the 53 s
 *     were that wait). "Commit" is the bot_posts row's created_at (/record: release to commit); the Telegram post is
 *     the channel poster's, a separate and paced step. Without an ExecutionContext (no production route) the capture
 *     runs as bounded awaits: at most 12 s including corroboration outside the release minute (every request's
 *     timeout is clamped to that), and nothing commits inline.
 * (d) Not observed by release + 6 h: one UNRESOLVED observation (release_not_observed) per leg plus an alert, then a
 *     poll every 15 minutes until the market text's fallback window ends (the next scheduled release or meeting,
 *     45 days at most), daily for 7 more days, then the watch stops with one alert. Never an older period: the
 *     adapters only record a document about the target period. A first print first seen at or after the named
 *     fallback is still recorded (the audit trail of when it appeared) but decides nothing: gate 1 answers
 *     released_after_fallback, because the market texts then settle on an earlier period.
 * (e) Change detection projects series|period|first print|corroboration status (src/ingest/projection.ts): later
 *     polls are no_op, and an audited re-check of the corroboration (recheck_official_corroboration) re-resolves.
 *
 * Subrequests per invocation (Workers Free allows 50, src/ops/budget.ts; an alert is COST.alert = 5: dedup read, insert,
 * a Telegram DM of up to 3 attempts). The slot holder in the release minute, counted from the route's
 * claim_watch_dispatch:
 *   - With waitUntil (every production route): the request makes HOLDER_REQUEST_SUBREQUESTS = 6 (the claim, watch
 *     load, official_observations read, claim_official_fetch, watches update, loop_runs insert). The capture: burst <= 10
 *     upstream (a Fed or ECB attempt is feed + document, and each redirect hop, all counted in the 10) + corroboration 1 +
 *     R2 put of the upstream body 1 + record_official_observation 1 = 13, and at most 2 alerts (an R2 failure; a revision
 *     or a disagreement) = 10. For a fetch group, the siblings: 1 read of their rows + per missing sibling (3 at most, the
 *     CPI group) corroboration 1 + record 1 + one alert (a sibling is either inserted, and alerted on a disagreement, or a
 *     revision) = 1 + 3 x 7.
 *     Not inline (recorded after the window, another leg's print, or no first print): 6 + 13 + 7 = 26 before alerts, 51
 *     in the theoretical worst case with every alert at once (R2 down and all four CPI series disagreeing): the last
 *     sibling's alert would be the subrequest that fails (alert() never throws; the record stands). A capture that is
 *     pending or drifted while the page states siblings: 6 + 10 + its alert 5 + R2 1 (+5) + the siblings 22, + the
 *     lease extension 1 = 50 at most.
 *     Inline: 6 + what the capture spent (Capture.subrequests, counted as it runs) + what inlinePlan reserves before
 *     anything starts: the redispatch 1 + the inline poll INLINE_RUN_SUBREQUESTS 24 (its commit counted at 10, an inline
 *     post; a ladder's is 2) + the deferred siblings and their redispatch (siblingSubrequests: 8 for the CPI page, 4 for
 *     the Employment Situation) + one alert 5, within INVOCATION_SUBREQUESTS or not inline at all; the publish's webhook
 *     first attempts get what is left (attemptInline fits whole deliveries of 4 into it, and only those that can finish
 *     by the capture's hardStop: withinDeadline, an endpoint's rows being sequential). A CPI page read on its first
 *     fetch: 6 + 4 + 38 = 48 reserved, nothing left for a webhook attempt: the drain delivers them, DRAIN_MAX = 5 rows per
 *     5-minute run across every pending row, paid reveals first, so past about 5 queued rows (this leg's followers with
 *     endpoints, plus whatever else is pending) some are attempted after the refund rule's 10 minutes and their charges
 *     are refunded (a known exposure, docs/runbooks/venue-pilot.md states the drain's ceiling); measured 34
 *     (tests/official-inline-commit.test.ts). A release without siblings: 6 + 4 + 30 = 40, two webhook first attempts.
 *     The publish is queued right after the bot_posts insert, before commitVerdict's inline Telegram post (whose seconds
 *     could outlast waitUntil). Not reserved, as on every watch run: the alerts the inline poll and the siblings raise
 *     themselves (a prior-level mismatch, an R2 failure, a resolution or a commit not recorded, a sibling's disagreement
 *     or revision; 5 each). Past 50 the last subrequests fail: the sibling records and their redispatch (those siblings
 *     are recorded by the next minute's holder, as before 024) or a webhook attempt in flight (requeued by the drain's
 *     stale sweep). Over the reservation: the siblings as before and one redispatch of every leg, the holder's own
 *     included: 27 before alerts.
 *   - Without waitUntil (tests and local runs only): the request runs the capture (17 with the claim, 3 alerts at most:
 *     an R2 failure, a revision or a disagreement, a prior-level mismatch) and runWatch stores and resolves: R2 put 1 +
 *     evidence insert 1 (+1 re-read) + check_gates 1 + resolutions insert 1 + evidence update 1 + commit 10 + publish 18
 *     (queueing 4 + its inline webhook attempt inlineSubrequests(INLINE_MAX) 14, alerts included) + watches update 1 +
 *     loop_runs insert 1 = 36: 53 before its alerts, over Workers Free's 50 (the webhook attempts would fail, left to the
 *     drain). No siblings are recorded and nothing commits inline on this path.
 *
 * Election series (src/resolve/election.ts) poll differently: no burst (a count is final hours after polls close, never
 * in the first minute), the fetch lease of a contest is extended to ELECTION_REFETCH_S after every pending or failed
 * capture so each contest file is requested at most once per 4 minutes however many legs poll it, the holder's leg
 * polls again in 5 minutes and every other leg every 15, and the count may take 72 h (not 6) before the legs are
 * reported release_not_observed, after which every leg polls hourly. Upstream-failure alerts are per authority (tse,
 * eq), not per series. A TSE capture requests the configuration and then the contest file (2 upstream requests); an
 * isolate that captured another TSE contest in the last 60 s reuses the configuration it read (a per-isolate memo, so
 * it only saves requests: the bound on the TSE hosts is the fetch lease of each contest, since every isolate and every
 * contest reads the configuration again). A final-flagged TSE file that no leg can decide from (its own environment
 * flag, a stamp before polls close, totals that do not add up, a vote destination the rail does not read) is pending
 * with an alert and never recorded, since the first print of every series of its fetch group would be locked to it
 * (src/ingest/official.ts). The Élections Québec capture requests the one file, and a final count is
 * recorded only on a read that confirms an earlier one (EQ_STABLE_MS; the first read is kept in app_config, 1 read and
 * at most 1 write per capture). A final-flagged file that is not every riding of the election once (a read that lost
 * ridings), or whose statistics, party totals or polling stations do not add up to its ridings, is pending with an
 * alert before that state is touched: it is never kept as a first read and never confirms one (src/ingest/official.ts).
 * The holder's waitUntil records its own series and the siblings of its fetch group from the same bytes: request 5 +
 * upstream 2 (Québec: 1 + the app_config read 1) + R2 1 + record 1 + siblings read 1 + one record per sibling (the TSE
 * national file: 8; the Québec file: 29, no corroboration request exists for elections) = 39 at most, with a lease
 * extension 1 and an alert 3 when a capture fails or waits instead.
 * Workers Free budget (100,000 requests a day), from polls close until the counts are final (72 h at most): every leg
 * polls once per 15 minutes (96 a day) and each contest's holder once per 5 minutes (288 a day), so a day costs
 * 96 x legs + 288 x contests Worker requests; the upstream sees at most 360 requests a day per contest (720 for a TSE
 * contest: configuration + file) and 1 per 4 minutes. After 72 h: 24 a day per leg; once stored: 4 a day per leg.
 */
import type { Env } from "../env";
import { db, rpc } from "../db/supabase";
import type { FetchOutcome, MarketRow, WatchRow } from "./types";
import { MAX_DEFER_S } from "./http";
import { fetchPrimary, fetchCorroboration, budget, type ConfirmRead, type FetchedObservation, type PrimaryResult } from "./official";
import {
  OFFICIAL_SERIES, OfficialCorroboration, firstPrintFor, officialEvidence, priorLevelProblem, releaseAtOf, fallbackEndMs, fetchSlotOf, missingAfterMs,
  type OfficialObservationDoc, type OfficialMissingDoc, type OfficialResolver, type OfficialSeriesId,
} from "../resolve/official";
import { ELECTION_SERIES, canonicalSnapshot, isElectionSeries } from "../resolve/election";
import { railEnabled } from "../resolve/rails";
import { alert } from "../ops/alerts";
import { Budget as SubrequestBudget, COST, INVOCATION_SUBREQUESTS } from "../ops/budget";
import { z } from "zod";

export const BURST_INTERVAL_MS = 3000;
export const BURST_WINDOW_MS = 25_000;
export const BURST_MAX_REQUESTS = 10;
/** Corroboration and the record must land inside waitUntil's 30 s after the response. */
export const BURST_HARD_STOP_MS = 28_000;
/** Outside the release minute: one attempt (feed + document, a redirect or two) and corroboration, 12 s in all. */
export const SINGLE_HARD_STOP_MS = 12_000;
export const SINGLE_MAX_REQUESTS = 4;
/** Longer than a whole burst plus corroboration, so two holders never overlap. */
export const FETCH_LEASE_S = 45;
export const MISSING_AFTER_MS = 6 * 3600_000;
/** After the fallback window: daily polls for this long, then the watch stops. */
export const LATE_DAILY_MS = 7 * 86_400_000;
/** A dispatch this close before release_at waits for it instead of losing the release minute. */
export const EARLY_WAIT_MS = 5000;
/** Election contests: after a capture that found no final count, nobody fetches the contest again for this long. */
export const ELECTION_REFETCH_S = 240;
/** Election cadence while awaiting the final count: the holder's leg, every other leg, and after missingAfterMs. */
export const ELECTION_POLL_MIN = { holder: 5, other: 15, missing: 60 } as const;
/**
 * Élections Québec first print: a final-flagged count is recorded only when the same counts (every riding's candidate
 * votes and the file-wide totals and flags, never the file's timestamps: ConfirmRead.fingerprint) were first read at
 * least this long before. The CDN serves copies up to about 2 min old and the counts can still move after the flag is
 * first seen, so one read never locks the first print. The first read is kept in app_config (confirmKeyOf), so the
 * confirming read may come from any leg in any isolate; a read with other counts starts the wait again. Changes after
 * the lock (the recensement) are expected to be far smaller than the 1% riding-lead margin (UNVERIFIED): the resolver's
 * margins, not this wait, keep such a change from flipping a verdict.
 */
export const EQ_STABLE_MS = 10 * 60_000;
/** The app_config key holding the first read of a count that awaits its confirming read (one per fetch slot and period). */
export const confirmKeyOf = (slot: string, period: string) => `official_confirm:${slot}:${period}`;
interface ConfirmState { fingerprint: string; first_read_at: string; as_of: string; raw_sha256: string }
function confirmState(v: unknown): ConfirmState | null {
  if (typeof v !== "string") return null;
  let o: unknown;
  try { o = JSON.parse(v); } catch { return null; }
  const x = o as Partial<ConfirmState> | null;
  if (!x || typeof x.fingerprint !== "string" || typeof x.first_read_at !== "string" || !Number.isFinite(Date.parse(x.first_read_at))) return null;
  return { fingerprint: x.fingerprint, first_read_at: x.first_read_at, as_of: String(x.as_of ?? ""), raw_sha256: String(x.raw_sha256 ?? "") };
}
type Confirmed = { kind: "confirmed"; first_read_at: string } | { kind: "wait"; detail: string } | { kind: "error"; error: string };
/**
 * Is this read the confirmation of an earlier read of the same counts at least EQ_STABLE_MS before? Otherwise the read is
 * kept (when its counts differ from the kept one, or none is kept) and the capture stays pending.
 */
async function confirmRead(env: Env, slot: string, period: string, c: ConfirmRead, raw_sha256: string, nowMs: number): Promise<Confirmed> {
  const key = confirmKeyOf(slot, period);
  const client = db(env);
  const { data, error } = await client.from("app_config").select("value").eq("key", key).maybeSingle();
  if (error) return { kind: "error", error: `app_config read (${key}): ${error.message.slice(0, 160)}` };
  const kept = confirmState((data as { value?: unknown } | null)?.value);
  if (kept && kept.fingerprint === c.fingerprint) {
    const since = Date.parse(kept.first_read_at);
    if (nowMs - since >= EQ_STABLE_MS) return { kind: "confirmed", first_read_at: kept.first_read_at };
    return { kind: "wait", detail: `the final count (as of ${c.as_of}) was first read at ${kept.first_read_at}; it is recorded once a read at or after ${iso(since + EQ_STABLE_MS)} shows the same counts` };
  }
  const state: ConfirmState = { fingerprint: c.fingerprint, first_read_at: iso(nowMs), as_of: c.as_of, raw_sha256 };
  const { error: we } = await client.from("app_config").upsert({ key, value: JSON.stringify(state), updated_at: iso(nowMs) }, { onConflict: "key" });
  if (we) return { kind: "error", error: `app_config write (${key}): ${we.message.slice(0, 160)}` };
  return { kind: "wait", detail: `first read of this final count (as of ${c.as_of}${kept ? "; the counts differ from the read kept at " + kept.first_read_at : ""}); it is recorded once a read at or after ${iso(nowMs + EQ_STABLE_MS)} shows the same counts` };
}

/**
 * The release-minute capture commits the holder's own leg in its own invocation when the first print it recorded was
 * recorded (official_observations.observed_at, the database's clock) at most this long after release_at (rail
 * inline_commit_window). Later in the burst, the inline poll and the deferred siblings' records after it might not
 * finish inside waitUntil's 30 s after the response, so those legs are left to their next minute poll, as before. (The
 * siblings' corroboration, up to 8 s, starts when the first print is recorded and runs beside the inline poll:
 * prepareSiblings.)
 */
export const INLINE_COMMIT_WINDOW_S = 15;
/**
 * The holder's request before its waitUntil task: claim_watch_dispatch (POST /internal/watch/:id), the watch load, the
 * official_observations read, claim_official_fetch, then runWatch's watches update and loop_runs insert.
 */
export const HOLDER_REQUEST_SUBREQUESTS = 6 * COST.db;
/** One redispatch_official_legs() call (migration 024): every other open leg of the series given, dispatched now. */
export const REDISPATCH_SUBREQUESTS = COST.db;
/**
 * The inline poll of the holder's own leg (runWatch, dispatch inline_commit) without its webhook first attempts: the
 * watch load 1, the official_observations read 1, R2 put 1, evidence insert 1 (+1 re-read after a duplicate), the
 * runtime 2 (check_gates, the resolutions insert), the evidence update 1, the commit 10 at most (commit_context, the
 * bot_posts insert, both again after a dedup collision, and an inline post's lease claim, send 3, receipt and release; a
 * ladder's legs are batched for the channel poster: 2), the publish's queueing 4 (follows, endpoints, charge_reveals,
 * insert: COMMITTED_QUEUE_SUBREQUESTS without its alert), the watches update 1 and the loop_runs insert 1 = 24. A tenant
 * market costs less (a plan read more in the runtime, no commit, its event queued in 2). Its alerts are not in it (see
 * the header: they are the run's own).
 */
export const INLINE_RUN_SUBREQUESTS = 24 * COST.db;
/** Recording n deferred siblings after the inline commit: the read of their rows, corroboration and record per sibling, and their legs' redispatch. */
export const siblingSubrequests = (n: number): number => (n > 0 ? COST.db + n * (COST.http + COST.db) + REDISPATCH_SUBREQUESTS : 0);
/** The longest the inline commit waits for the holder's request to write its own bookkeeping (it is long done by then). */
export const REQUEST_DONE_WAIT_MS = 5000;

/**
 * What runWatch hands the official adapter so the slot holder can commit its own leg in the invocation that recorded the
 * first print: the same runWatch (store, resolve, commitVerdict, publishShadowCommitted), never a copy of it.
 */
export interface InlineCommit {
  /**
   * runWatch of the holder's own watch, dispatch inline_commit, its webhook first attempts held to `webhooks` and to what
   * can finish by `webhookDeadlineMs` (the capture's hardStop: inside waitUntil's 30 s after the response).
   */
  run(webhooks: SubrequestBudget, webhookDeadlineMs: number): Promise<{ outcome: string; detail: string; verdict?: string }>;
  /** Settles once the holder's request has written its watches update and loop_runs row. */
  requestDone: Promise<void>;
}
export interface OfficialDeps { now(): number; sleep(ms: number): Promise<void>; waitUntil?: (p: Promise<unknown>) => void; inline?: InlineCommit }
const REAL: Pick<OfficialDeps, "now" | "sleep"> = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * Pure: does this capture commit the holder's own leg in its own invocation? Only a first print this capture inserted
 * (not one another leg stored first), as this market's own capture, recorded at or after release_at and at most
 * INLINE_COMMIT_WINDOW_S after it. With the rail inline_commit_window off: any first print the burst inserts.
 */
export function inlineCommitDue(c: { inserted: boolean; ownCapture: boolean; observedAt: string }, releaseAtMs: number): boolean {
  if (!c.inserted || !c.ownCapture) return false;
  const after = Date.parse(c.observedAt) - releaseAtMs;
  if (!Number.isFinite(after) || after < 0) return false;
  return !railEnabled("inline_commit_window") || after <= INLINE_COMMIT_WINDOW_S * 1000;
}

export type InlinePlan = { fits: true; spent: number; reserved: number; webhooks: number } | { fits: false; spent: number; reserved: number };
/**
 * Pure: the inline commit's budget, out of the invocation's INVOCATION_SUBREQUESTS (Workers Free). Spent: the holder's
 * request and its capture as counted (Capture.subrequests). Reserved before anything starts: the redispatch, the inline
 * poll (INLINE_RUN_SUBREQUESTS), the deferred siblings and their redispatch, and one alert (the publish's alerts, which
 * ride in its webhook attempt's alertMany or go out on their own when nothing was queued, or a failed redispatch's). The
 * publish's webhook first attempts get what is left plus that alert (attemptInline fits as many deliveries as it can,
 * none below one delivery's worth, none that could not finish by the capture's hardStop; the drain takes the rest, 5 rows
 * per 5-minute run, paid first). When the reservation does not fit, the leg is not committed inline: it is redispatched
 * with the others.
 */
export function inlinePlan(captureSubrequests: number, siblings: number): InlinePlan {
  const b = new SubrequestBudget(INVOCATION_SUBREQUESTS);
  const spent = HOLDER_REQUEST_SUBREQUESTS + captureSubrequests;
  const reserved = REDISPATCH_SUBREQUESTS + INLINE_RUN_SUBREQUESTS + siblingSubrequests(siblings) + COST.alert;
  if (!b.take(spent) || !b.take(reserved)) return { fits: false, spent, reserved };
  return { fits: true, spent, reserved, webhooks: b.left + COST.alert };
}

const MIN = 60_000;
const DAY = 86_400_000;
const minuteStart = (ms: number) => Math.floor(ms / MIN) * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

export type OfficialPhase = "before" | "awaiting" | "observed" | "missing";
/** election: the series is an election contest (its cadence and missing window, src/resolve/election.ts). */
export interface OfficialSchedule { releaseAtMs: number; fallbackEndMs: number; missingAfterMs?: number; election?: boolean }

export function officialSchedule(r: OfficialResolver): OfficialSchedule {
  return { releaseAtMs: Date.parse(releaseAtOf(r)), fallbackEndMs: fallbackEndMs(r), missingAfterMs: missingAfterMs(r.series), election: isElectionSeries(r.series) };
}

/**
 * next_poll_at when a poll changes nothing. pg_cron selects due watches at each minute start, so every schedule is
 * a minute start. Awaiting: every minute for 10 minutes after the release, every 5 minutes to 6 h, then every 15
 * until the fallback window ends, then daily. Observed: the first print is final, so every 6 h (an audited
 * corroboration re-check is picked up then) until the fallback window ends.
 */
export function officialIdleNextPoll(nowMs: number, s: OfficialSchedule, phase: OfficialPhase, opts: { holder?: boolean } = {}): string {
  const late = nowMs >= s.fallbackEndMs;
  if (s.election && (phase === "awaiting" || phase === "missing")) {
    // an election count is final hours after polls close: the holder's leg every 5 minutes, the others every 15, hourly
    // once the missing window has passed, daily after the fallback window
    if (late) return iso(minuteStart(nowMs) + DAY);
    const since = nowMs - s.releaseAtMs;
    const min = phase === "missing" || since >= (s.missingAfterMs ?? MISSING_AFTER_MS) ? ELECTION_POLL_MIN.missing : opts.holder ? ELECTION_POLL_MIN.holder : ELECTION_POLL_MIN.other;
    return iso(minuteStart(nowMs) + min * MIN);
  }
  switch (phase) {
    case "before": { const m = minuteStart(s.releaseAtMs); return iso(m > nowMs ? m : Math.max(s.releaseAtMs, nowMs + 1000)); }
    case "awaiting": {
      if (late) return iso(minuteStart(nowMs) + DAY);
      const since = nowMs - s.releaseAtMs;
      return iso(minuteStart(nowMs) + (since < 10 * MIN ? 1 : since < MISSING_AFTER_MS ? 5 : 15) * MIN);
    }
    case "missing": return iso(minuteStart(nowMs) + (late ? DAY : 15 * MIN));
    case "observed": return iso(nowMs + 6 * 3600_000);
    default: { const never: never = phase; throw new Error(`unhandled phase ${String(never)}`); }
  }
}

/** The dispatch landed in the release minute (at or after the release): burst. */
export function inReleaseMinute(nowMs: number, releaseAtMs: number): boolean {
  return nowMs >= releaseAtMs && nowMs < minuteStart(releaseAtMs) + MIN;
}

/** official_observations as record_official_observation returns it (jsonb) or a select reads it. */
export interface StoredRow {
  series: string; period: string; value: number | string; value_text: string; deciding_text: string; source_url: string;
  raw_sha256: string; observed_at: string; corroboration: unknown; meta?: Record<string, unknown> | null;
  inserted?: boolean; revision_differs?: boolean;
}

const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function docFromRow(row: StoredRow): OfficialObservationDoc {
  const c = OfficialCorroboration.safeParse(row.corroboration);
  const dir = row.meta?.direction;
  return {
    kind: "official_observation", series: row.series as OfficialSeriesId, period: String(row.meta?.doc_period ?? row.period),
    value: Number(row.value), value_text: row.value_text, deciding_text: row.deciding_text, source_url: row.source_url,
    raw_sha256: row.raw_sha256, observed_at: new Date(row.observed_at).toISOString(),
    direction: dir === "up" || dir === "down" || dir === "unchanged" ? dir : null,
    corroboration: c.success ? c.data : null,
    stated_prior: strOrNull(row.meta?.stated_prior), stated_step_bps: numOrNull(row.meta?.stated_step_bps),
    // an election first print carries the count it was read from; a row without one decides nothing (value_unreadable)
    ...(row.meta?.contest !== undefined ? { contest: canonicalSnapshot(row.meta.contest) } : {}),
  };
}

function docFromFetch(obs: FetchedObservation, corroboration: OfficialCorroboration): OfficialObservationDoc {
  return {
    kind: "official_observation", series: obs.series, period: obs.period, value: obs.value, value_text: obs.value_text, deciding_text: obs.deciding_text,
    source_url: obs.source_url, raw_sha256: obs.raw_sha256, observed_at: obs.fetched_at, direction: obs.direction, corroboration,
    stated_prior: strOrNull(obs.meta.stated_prior), stated_step_bps: numOrNull(obs.meta.stated_step_bps),
    ...(obs.contest ? { contest: obs.contest } : {}),
  };
}

/** Upstream-failure alerts of an election series are per authority (one TSE outage is one alert, not 36). */
const upstreamAlertKey = (r: OfficialResolver) => `official_upstream_${isElectionSeries(r.series) ? ELECTION_SERIES[r.series].authority : r.series}_${r.period}`;

async function safeAlert(env: Env, key: string, text: string, dedupMinutes: number, meta: Record<string, unknown>): Promise<void> {
  try { await alert(env, key, text, { dedupMinutes, meta }); }
  catch (e) { console.error(JSON.stringify({ level: "error", job: "official_alert", key, error: String(e).slice(0, 200) })); }
}

/**
 * Siblings a capture left for its caller to record after the inline commit (mode.deferSiblings): how many, and the call
 * that records them. Their read and corroboration already started when the capture returned (prepareSiblings); record()
 * waits for them and writes the first prints.
 */
export interface DeferredSiblings { count: number; record(): Promise<SiblingsRecorded> }
export interface SiblingsRecorded { notes: string[]; inserted: OfficialSeriesId[] }

export type Capture =
  /**
   * subrequests: what the capture spent as counted (upstream requests, corroboration 1, R2 put 1, the record 1, COST.alert
   * per alert it raised), for the inline commit's budget (inlinePlan). later: the siblings left to the caller. hardStop:
   * the capture's deadline (epoch ms, its start + BURST_HARD_STOP_MS in the burst), the end of the time its waitUntil has.
   */
  | { kind: "recorded"; stored: OfficialObservationDoc; fetched: OfficialObservationDoc; inserted: boolean; revision: boolean; ownCapture: boolean; requests: number; siblings: string[]; subrequests: number; hardStop: number; later?: DeferredSiblings }
  | { kind: "pending"; detail: string; requests: number; siblings?: string[] }
  | { kind: "error"; error: string; retryable: boolean; drift: boolean; httpStatus?: number; deferSeconds?: number; requests: number; siblings?: string[] };

/** record_official_observation for one fetched observation of `period`, with the revision and disagreement alerts. */
async function recordObservation(env: Env, obs: FetchedObservation, period: string, corroboration: OfficialCorroboration, meta: Record<string, unknown>): Promise<StoredRow> {
  const alertMeta = { series: obs.series, period };
  const row = await rpc<StoredRow>(db(env), "record_official_observation", {
    p_series: obs.series, p_period: period, p_value: obs.value, p_value_text: obs.value_text, p_deciding_text: obs.deciding_text,
    p_source_url: obs.source_url, p_raw_sha256: obs.raw_sha256, p_corroboration: corroboration,
    p_meta: { ...obs.meta, direction: obs.direction, doc_period: obs.period, fetched_at: obs.fetched_at, ...(obs.contest ? { contest: obs.contest } : {}), ...meta },
  });
  if (row.revision_differs) {
    await safeAlert(env, `official_revision_${obs.series}_${period}`, `${obs.series} ${period}: stored first print ${row.value_text} (${new Date(row.observed_at).toISOString()}); a later read offered ${obs.value_text} from ${obs.source_url}. The first print stands.`, 1440, alertMeta);
  }
  if (row.inserted && corroboration.status === "disagree") {
    await safeAlert(env, `official_disagree_${obs.series}_${period}`, `${obs.series} ${period}: primary ${obs.value_text} (${obs.source_url}) vs ${corroboration.value_text} (${corroboration.source_url}). Every leg stays UNRESOLVED (sources_disagree) until an operator re-checks it (POST /internal/official/recheck).`, 1440, alertMeta);
  }
  return row;
}

const corroborate = async (obs: FetchedObservation, period: string, deps: Pick<OfficialDeps, "now">, hardStop: number): Promise<OfficialCorroboration> => {
  try { return await fetchCorroboration(obs, period, budget(deps.now, 0, 1, Math.min(deps.now() + 8000, hardStop))); }
  catch (e) { return { status: "unavailable", source_url: null, value: null, value_text: null, detail: `corroboration threw: ${String(e).slice(0, 200)}`, checked_at: iso(deps.now()) }; }
};

/** Siblings read and corroborated, not yet recorded: the ones not stored yet, each with its corroboration. */
interface PreparedSiblings { notes: string[]; todo: Array<{ obs: FetchedObservation; corroboration: OfficialCorroboration }> }

/**
 * The first half of recording the siblings: which ones are not stored yet (1 read) and each one's corroboration (1
 * request each, under the capture's own deadline: at most 8 s and never past hardStop). A capture that defers its
 * siblings starts this the moment it records its own first print, so their corroboration runs beside the inline commit
 * with the same time it always had, and only the records wait for it (a corroboration started after a slow inline run
 * would find the deadline gone and record a first print as corroboration "unavailable", which resolves). Never throws.
 */
async function prepareSiblings(env: Env, r: OfficialResolver, siblings: FetchedObservation[], deps: Pick<OfficialDeps, "now">, hardStop: number): Promise<PreparedSiblings> {
  if (!siblings.length) return { notes: [], todo: [] };
  try {
    const { data, error } = await db(env).from("official_observations").select("series").eq("period", r.period).in("series", siblings.map((s) => s.series));
    if (error) return { notes: siblings.map((s) => `${s.series}: not recorded (official_observations read: ${error.message.slice(0, 120)})`), todo: [] };
    const stored = new Set(((data ?? []) as Array<{ series: string }>).map((x) => x.series));
    const todo = siblings.filter((s) => !stored.has(s.series));
    const notes = siblings.filter((s) => stored.has(s.series)).map((s) => `${s.series}: already stored`);
    const corr = await Promise.all(todo.map((s) => corroborate(s, r.period, deps, hardStop)));
    return { notes, todo: todo.map((obs, i) => ({ obs, corroboration: corr[i]! })) };
  } catch (e) {
    return { notes: siblings.map((s) => `${s.series}: not recorded (${String(e).slice(0, 120)})`), todo: [] };
  }
}

/** The second half: record_official_observation per prepared sibling. Never throws. */
async function recordPrepared(env: Env, r: OfficialResolver, marketId: string, p: PreparedSiblings, upstream: number, extraMeta: Record<string, unknown> = {}): Promise<SiblingsRecorded> {
  const notes = [...p.notes];
  const inserted: OfficialSeriesId[] = [];
  for (const { obs: s, corroboration } of p.todo) {
    try {
      const row = await recordObservation(env, s, r.period, corroboration, { upstream_requests: upstream + 1, captured_by_market: marketId, sibling_of: r.series, ...extraMeta });
      if (row.inserted) inserted.push(s.series);
      notes.push(`${s.series}: ${row.inserted ? "recorded" : "already stored"} ${row.value_text}`);
    } catch (e) { notes.push(`${s.series}: record_official_observation: ${String(e).slice(0, 160)}`); }
  }
  return { notes, inserted };
}

/**
 * The other series of the fetch group that the holder's page states for the period: each one not yet stored gets its
 * own corroboration and first print from the same bytes (already in R2). Never throws; returns one note per sibling and
 * the series whose first print this call inserted.
 */
async function recordSiblings(env: Env, r: OfficialResolver, marketId: string, siblings: FetchedObservation[], upstream: number, deps: Pick<OfficialDeps, "now">, hardStop: number, extraMeta: Record<string, unknown> = {}): Promise<SiblingsRecorded> {
  return recordPrepared(env, r, marketId, await prepareSiblings(env, r, siblings, deps, hardStop), upstream, extraMeta);
}

/**
 * The holder's page states other series of the group although it gave the holder's own series no first print (a "-"
 * cell, or its part of the page drifted): the body to R2 once, then each sibling's first print (recordSiblings).
 */
async function recordPageSiblings(env: Env, r: OfficialResolver, marketId: string, res: { siblings?: FetchedObservation[]; siblingNotes?: string[] }, upstream: number, deps: Pick<OfficialDeps, "now">, hardStop: number): Promise<string[]> {
  const siblings = res.siblings ?? [];
  if (!siblings.length) return res.siblingNotes ?? [];
  const body = siblings[0]!;
  try { await env.RAW.put(`raw/${body.raw_sha256}`, body.raw, { httpMetadata: { contentType: "application/octet-stream" } }); }
  catch (e) { await safeAlert(env, "r2_put_failed", `R2 put raw/${body.raw_sha256} (${r.series} ${r.period} upstream body) failed: ${String(e).slice(0, 200)}`, 60, { series: r.series, period: r.period }); }
  return [...(await recordSiblings(env, r, marketId, siblings, upstream, deps, hardStop)).notes, ...(res.siblingNotes ?? [])];
}

/**
 * The slot holder's fetch: primary (one attempt, or the burst), then corroboration (one request), the upstream body
 * to R2, and record_official_observation (first print wins; a different later value comes back as revision_differs).
 * marketId is recorded as the capturer: for events outside KNOWN_RELEASES only a market's own capture is held to
 * its own release_at (src/resolve/official.ts gate 1). With mode.siblings (a capture in waitUntil) the other series
 * of the fetch group that the same page states are recorded too (recordSiblings); with mode.deferSiblings as well, a
 * capture that recorded the holder's own series leaves them to the caller (Capture.later), who records them after its
 * inline commit. Every other outcome records them here, as without it.
 */
export async function captureOfficial(env: Env, r: OfficialResolver, marketId: string, mode: { burst: boolean; siblings?: boolean; deferSiblings?: boolean }, deps: Pick<OfficialDeps, "now" | "sleep">): Promise<Capture> {
  const start = deps.now();
  const hardStop = start + (mode.burst ? BURST_HARD_STOP_MS : SINGLE_HARD_STOP_MS);
  const b = mode.burst ? budget(deps.now, BURST_WINDOW_MS, BURST_MAX_REQUESTS) : budget(deps.now, 0, SINGLE_MAX_REQUESTS, hardStop);
  const meta = { series: r.series, period: r.period };
  let res: PrimaryResult;
  for (;;) {
    const t0 = deps.now();
    res = await fetchPrimary(r.series, r.period, b);
    if (res.kind === "observed" || !mode.burst) break;
    if (res.kind === "error" && !res.retryable) break;
    const next = t0 + BURST_INTERVAL_MS;
    if (b.requests <= 0 || next >= b.deadlineMs) break;
    await deps.sleep(Math.max(0, next - deps.now()));
  }
  const election = isElectionSeries(r.series);
  // a count that needs a confirming read (Élections Québec) is recorded only on that read, never on the first one
  let confirmedMeta: Record<string, unknown> = {};
  if (res.kind === "observed" && res.confirm) {
    const k = await confirmRead(env, fetchSlotOf(r.series), r.period, res.confirm, res.obs.raw_sha256, deps.now());
    if (k.kind === "wait") res = { kind: "pending", detail: k.detail };
    else if (k.kind === "error") res = { kind: "error", error: k.error, retryable: true, drift: false };
    else confirmedMeta = { first_final_read_at: k.first_read_at, counts_sha256: res.confirm.fingerprint };
  }
  if (res.kind === "pending") {
    if (res.alert) await safeAlert(env, res.alert.key, res.alert.text, res.alert.dedupMinutes, meta);
    // An election count that is not final yet: nobody fetches this contest again for ELECTION_REFETCH_S.
    if (election) {
      try { await rpc(db(env), "extend_official_fetch", { p_series: fetchSlotOf(r.series), p_period: r.period, p_seconds: ELECTION_REFETCH_S }); }
      catch (e) { console.error(JSON.stringify({ level: "error", job: "official_capture", series: r.series, period: r.period, error: `extend_official_fetch: ${String(e).slice(0, 200)}` })); }
    }
    // the page is out without this series' number: the other series it states are still recorded (waitUntil only)
    if (!mode.siblings || !res.siblings?.length) return { kind: "pending", detail: res.detail, requests: b.used };
    return { kind: "pending", detail: res.detail, requests: b.used, siblings: await recordPageSiblings(env, r, marketId, res, b.used, deps, hardStop) };
  }
  if (res.kind === "error") {
    // The source asked to wait: the whole ladder backs off (every leg's claim fails while the lease lives). An election
    // contest always backs off for at least ELECTION_REFETCH_S after a failed capture.
    const defer = res.deferSeconds ?? (election ? ELECTION_REFETCH_S : undefined);
    if (defer !== undefined) {
      try { await rpc(db(env), "extend_official_fetch", { p_series: fetchSlotOf(r.series), p_period: r.period, p_seconds: Math.min(MAX_DEFER_S, Math.max(FETCH_LEASE_S, defer)) }); }
      catch (e) { await safeAlert(env, upstreamAlertKey(r), `${r.series} ${r.period}: could not extend the fetch lease for a wait of ${defer} s: ${String(e).slice(0, 200)}`, 60, meta); }
    }
    // The fetch lease rotates across the legs of a ladder, so no single watch accumulates an error streak: the
    // alert is per series. Only a retryable answer inside the release-minute burst (the burst itself retries) waits.
    // A drift in this series' part of a shared page does not hold back the other series the page states (waitUntil only).
    const siblings = mode.siblings && res.siblings?.length ? await recordPageSiblings(env, r, marketId, res, b.used, deps, hardStop) : undefined;
    if (res.drift) await safeAlert(env, election ? `official_schema_${ELECTION_SERIES[r.series as keyof typeof ELECTION_SERIES].authority}` : `official_schema_${r.series}`, `${r.series} ${r.period}: the source no longer parses (${res.error}). Nothing was recorded for ${r.series}${siblings ? ` (from the same page: ${siblings.join("; ").slice(0, 300)})` : ""}; the parser needs a look before the release window closes.`, 360, meta);
    else if (!res.retryable || !mode.burst) await safeAlert(env, upstreamAlertKey(r), `${r.series} ${r.period}: ${res.error}. Nothing was recorded; the next poll retries.`, 60, meta);
    return { kind: "error", error: `${res.error} (${b.used} upstream requests)`, retryable: res.retryable, drift: res.drift, httpStatus: res.httpStatus, deferSeconds: res.deferSeconds, requests: b.used, ...(siblings ? { siblings } : {}) };
  }
  const obs = res.obs;
  const pageSiblings = res.siblings ?? [];
  const siblingNotes = res.siblingNotes ?? [];
  const corroboration = await corroborate(obs, r.period, deps, hardStop);
  let alerts = 0;
  // The upstream body first: a first print names bytes that exist (the evidence rows follow the same rule).
  try { await env.RAW.put(`raw/${obs.raw_sha256}`, obs.raw, { httpMetadata: { contentType: "application/octet-stream" } }); }
  catch (e) { alerts++; await safeAlert(env, "r2_put_failed", `R2 put raw/${obs.raw_sha256} (${r.series} ${r.period} upstream body) failed: ${String(e).slice(0, 200)}`, 60, meta); }
  let row: StoredRow;
  try { row = await recordObservation(env, obs, r.period, corroboration, { upstream_requests: b.used + 1, captured_by_market: marketId, ...confirmedMeta }); }
  catch (e) { return { kind: "error", error: `record_official_observation: ${String(e).slice(0, 200)}`, retryable: true, drift: false, requests: b.used }; }
  // recordObservation alerted a revision, or a disagreement on the row it inserted (each one alert)
  if (row.revision_differs) alerts++;
  if (row.inserted && corroboration.status === "disagree") alerts++;
  const subrequests = b.used + COST.http + COST.db + COST.db + alerts * COST.alert;
  const stored = docFromRow(row);
  const fetched = docFromFetch(obs, corroboration);
  const base = { kind: "recorded" as const, stored, fetched, inserted: row.inserted === true, revision: row.revision_differs === true, ownCapture: row.meta?.captured_by_market === marketId, requests: b.used, subrequests, hardStop };
  const recordAll = async (prepared: Promise<PreparedSiblings>): Promise<SiblingsRecorded> => {
    const done = await recordPrepared(env, r, marketId, await prepared, b.used, confirmedMeta);
    return { notes: [...done.notes, ...siblingNotes], inserted: done.inserted };
  };
  if (mode.siblings && mode.deferSiblings) {
    // the siblings' read and corroboration start now, under this capture's deadline; only their records are deferred
    const prepared = prepareSiblings(env, r, pageSiblings, deps, hardStop);
    return { ...base, siblings: [], later: { count: pageSiblings.length, record: () => recordAll(prepared) } };
  }
  return { ...base, siblings: mode.siblings ? (await recordAll(prepareSiblings(env, r, pageSiblings, deps, hardStop))).notes : [] };
}

/** Resolves when p settles or after ms, whichever comes first (a real timer, cleared: the burst's injected sleep is not used). */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([p.catch(() => undefined), new Promise<void>((r) => { timer = setTimeout(r, ms); })]); }
  finally { clearTimeout(timer); }
}

/** redispatch_official_legs()'s answer (migration 024, jsonb). */
const RedispatchAnswer = z.object({
  outcome: z.enum(["dispatched", "skipped", "failure"]),
  dispatched: z.number().int().nonnegative(),
  legs: z.number().int().nonnegative().optional(),
  busy: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});
export interface Redispatched { ok: boolean; dispatched: number; busy: number; detail: string; alerted: boolean }

/**
 * One redispatch_official_legs() call: every open leg of `series` for the period dispatched now (the holder skipped, or
 * with holderToo handed over). Never throws. A call that did not dispatch (refused, skipped, failed, an answer of
 * another shape, the function missing before migration 024) alerts once: those legs resolve on their next minute poll,
 * and "could not dispatch" never reads as "nothing to dispatch". 1 subrequest, and COST.alert when it alerts.
 */
async function redispatchLegs(env: Env, r: OfficialResolver, series: readonly string[], holder: string, holderToo: boolean): Promise<Redispatched> {
  let why: string;
  try {
    const raw = await rpc<unknown>(db(env), "redispatch_official_legs", { p_series: [...series], p_period: r.period, p_holder: holder, p_holder_too: holderToo });
    const a = RedispatchAnswer.safeParse(raw);
    if (a.success && a.data.outcome === "dispatched") return { ok: true, dispatched: a.data.dispatched, busy: a.data.busy ?? 0, detail: `${a.data.dispatched} leg(s) dispatched, ${a.data.busy ?? 0} busy`, alerted: false };
    why = a.success ? `${a.data.outcome}: ${a.data.reason ?? a.data.error ?? "no reason given"}` : `unexpected answer ${JSON.stringify(raw).slice(0, 160)}`;
  } catch (e) { why = String(e).slice(0, 200); }
  await safeAlert(env, `official_redispatch_${r.series}_${r.period}`, `${r.series} ${r.period}: the first print is recorded, but the open legs of ${series.join(", ")} could not be dispatched at once (${why}); they resolve on their next minute poll. Check that migration 024 is applied (npx tsx scripts/migrate.ts), app_config worker_base_url and the vault secret internal_hmac_secret (select_due_watches signs with the same), and watch_daily_cap.`, 60, { series: r.series, period: r.period, legs: [...series] });
  return { ok: false, dispatched: 0, busy: 0, detail: `not dispatched: ${why}`, alerted: true };
}

/**
 * The slot holder's waitUntil task. Captures (the burst in the release minute) and, when the first print it inserted
 * was recorded within INLINE_COMMIT_WINDOW_S of release_at (inlineCommitDue) and the invocation's budget holds the rest
 * (inlinePlan):
 *   1. redispatch_official_legs() for the holder's series, holder skipped: every other leg of the event runs within
 *      seconds, in its own invocation;
 *   2. once the holder's request has written its own bookkeeping, runWatch of the holder's own watch (InlineCommit.run:
 *      store, resolve, commitVerdict, publishShadowCommitted, the poll path itself), its webhook first attempts held to
 *      what the budget leaves;
 *   3. then the siblings the page states (deferred by captureOfficial), and one redispatch for the series it inserted.
 * Over budget: the siblings first, then one redispatch of every leg of the holder's series and the inserted siblings,
 * the holder's own included (it hands its lease over). Outside the window, or with no first print inserted: exactly the
 * capture as before (siblings recorded, every leg resolves on its next minute poll). Logs one line.
 */
async function holderCapture(env: Env, r: OfficialResolver, market: MarketRow, watchId: string, s: OfficialSchedule, burst: boolean, inline: InlineCommit | undefined, deps: OfficialDeps): Promise<void> {
  const c = await captureOfficial(env, r, market.id, { burst, siblings: true, deferSiblings: inline !== undefined }, deps);
  const line: Record<string, unknown> = { job: "official_capture", series: r.series, period: r.period, burst, outcome: c.kind, requests: c.requests, detail: c.kind === "recorded" ? c.stored.value_text : c.kind === "pending" ? c.detail : c.error };
  const log = () => console.log(JSON.stringify(line));
  if (c.kind !== "recorded" || !c.later || !inline) {
    if (c.siblings?.length) line.siblings = c.siblings;
    return log();
  }
  const later = c.later;
  if (!inlineCommitDue({ inserted: c.inserted, ownCapture: c.ownCapture, observedAt: c.stored.observed_at }, s.releaseAtMs)) {
    const sib = await later.record();
    if (sib.notes.length) line.siblings = sib.notes;
    return log();
  }
  const plan = inlinePlan(c.subrequests, later.count);
  line.inline = { after_release_ms: Date.parse(c.stored.observed_at) - s.releaseAtMs, spent: plan.spent, reserved: plan.reserved, fits: plan.fits };
  if (!plan.fits) {
    const sib = await later.record();
    if (sib.notes.length) line.siblings = sib.notes;
    // the holder's lease is handed over once its request has written it (it is long done by then)
    await settleWithin(inline.requestDone, REQUEST_DONE_WAIT_MS);
    line.redispatch = (await redispatchLegs(env, r, [r.series, ...sib.inserted], watchId, true)).detail;
    return log();
  }
  const rd = redispatchLegs(env, r, [r.series], watchId, false);
  // the request's own watches update and loop_runs row land first (the inline poll's bookkeeping is the last word)
  await settleWithin(inline.requestDone, REQUEST_DONE_WAIT_MS);
  const first = await rd;
  line.redispatch = first.detail;
  // The siblings' first prints and the dispatch of their legs run beside the inline run, not after it: the inline run
  // awaits commitVerdict's channel post (a 1.2 s gap, up to 3 x 8 s attempts and 429 waits), and waiting for it could
  // spend waitUntil's 30 s before the siblings are recorded. Both shares are reserved in inlinePlan, so running them at
  // the same time spends nothing more; never throws (recordPrepared and redispatchLegs report, they do not throw).
  const siblings = later.record().then(async (sib) => {
    if (sib.notes.length) line.siblings = sib.notes;
    if (sib.inserted.length) line.redispatch_siblings = (await redispatchLegs(env, r, sib.inserted, watchId, false)).detail;
  });
  try {
    const run = await inline.run(new SubrequestBudget(plan.webhooks - (first.alerted ? COST.alert : 0)), c.hardStop);
    line.inline = { ...(line.inline as object), outcome: run.outcome, verdict: run.verdict ?? null, detail: run.detail.slice(0, 300) };
  } catch (e) {
    // runWatch records every failure itself; a throw past it is alerted here, and the leg resolves on its next poll
    line.inline = { ...(line.inline as object), outcome: "threw", detail: String(e).slice(0, 300) };
    await safeAlert(env, `official_inline_commit_${r.series}_${r.period}`, `${r.series} ${r.period}: the inline commit of market ${market.id} threw (${String(e).slice(0, 200)}); the leg resolves from the stored first print on its next minute poll.`, 60, { series: r.series, period: r.period, market_id: market.id });
  }
  await siblings;
  return log();
}

async function observedOutcome(env: Env, r: OfficialResolver, stored: OfficialObservationDoc, fetched: OfficialObservationDoc | null, ownCapture: boolean, nowMs: number, s: OfficialSchedule, note: string): Promise<FetchOutcome> {
  const doc = firstPrintFor(stored, fetched);
  // A document whose own account of the move contradicts the registered prior_level holds every leg: say so once a day.
  const mismatch = priorLevelProblem(r, doc);
  if (mismatch) await safeAlert(env, `official_prior_mismatch_${r.series}_${r.period}`, `${r.series} ${r.period}: ${mismatch}. The legs stay UNRESOLVED (prior_level_mismatch); check the registered prior_level against the release.`, 1440, { series: r.series, period: r.period, prior_level: r.prior_level ?? null });
  const { evidence, rawBytes } = officialEvidence(doc, iso(nowMs), { ownCapture });
  const done = nowMs >= s.fallbackEndMs;
  return { evidence, rawBytes, nextPollAt: officialIdleNextPoll(nowMs, s, "observed"), note: `${note}: ${doc.value_text}`, ...(done ? { stop: "the first print is resolved and the market's fallback window has passed" } : {}) };
}

async function missingOutcome(env: Env, r: OfficialResolver, nowMs: number, s: OfficialSchedule, why: string): Promise<FetchOutcome> {
  const meta = { series: r.series, period: r.period };
  const stopAt = s.fallbackEndMs + LATE_DAILY_MS;
  const hours = Math.round((s.missingAfterMs ?? MISSING_AFTER_MS) / 3600_000);
  const cadence = s.election ? "hourly" : "every 15 min";
  const doc: OfficialMissingDoc = { kind: "official_missing", series: r.series, period: r.period, release_at: releaseAtOf(r), source_url: OFFICIAL_SERIES[r.series].primaryUrl, detail: `not observed by release_at + ${hours} h` };
  const { evidence, rawBytes } = officialEvidence(doc, iso(nowMs));
  if (nowMs >= stopAt) {
    await safeAlert(env, `official_stopped_${r.series}_${r.period}`, `${r.series} ${r.period} was never observed; its fallback window ended ${iso(s.fallbackEndMs)} and a week of daily polls found nothing. The watches stop; the legs stay UNRESOLVED (release_not_observed). Last: ${why}`, 14_400, meta);
    return { evidence, rawBytes, nextPollAt: officialIdleNextPoll(nowMs, s, "missing"), note: `release_not_observed, polling stopped: ${why}`, stop: "never observed; the fallback window and a week of daily polls have passed" };
  }
  await safeAlert(env, `official_missing_${r.series}_${r.period}`, `${r.series} ${r.period} was not observed by release_at + ${hours} h (release ${releaseAtOf(r)}). Its legs are UNRESOLVED (release_not_observed) and keep polling (${cadence} until ${iso(s.fallbackEndMs)}, then daily); nothing resolves from an older period. Last: ${why}`, 720, meta);
  return { evidence, rawBytes, nextPollAt: officialIdleNextPoll(nowMs, s, "missing"), note: `release_not_observed: ${why}` };
}

/** Never throws: anything unexpected becomes a failed poll (streak, alerts, retry) instead of a lost invocation. */
export async function fetchOfficial(env: Env, watch: WatchRow, market: MarketRow, given: Partial<OfficialDeps> = {}): Promise<FetchOutcome> {
  try { return await pollOfficial(env, watch, market, { ...REAL, ...given }); }
  catch (e) { return { error: `official_release adapter threw: ${String(e).slice(0, 300)}` }; }
}

async function pollOfficial(env: Env, watch: WatchRow, market: MarketRow, deps: OfficialDeps): Promise<FetchOutcome> {
  const r = market.resolver;
  if (r?.kind !== "official_release") return { error: `watch ${watch.id}: official_release source on a market whose resolver is ${r?.kind ?? "absent"}` };
  const s = officialSchedule(r);
  let now = deps.now();
  if (now < s.releaseAtMs) {
    if (s.releaseAtMs - now > EARLY_WAIT_MS) return { notModified: true, nextPollAt: officialIdleNextPoll(now, s, "before"), note: `awaiting_release: ${r.series} ${r.period} is scheduled for ${releaseAtOf(r)}; nothing is fetched before it` };
    await deps.sleep(s.releaseAtMs - now);
    now = deps.now();
  }
  const client = db(env);
  const { data, error } = await client.from("official_observations").select("*").eq("series", r.series).eq("period", r.period).maybeSingle();
  if (error) return { error: `official_observations read: ${error.message}` };
  if (data) {
    const row = data as StoredRow;
    return observedOutcome(env, r, docFromRow(row), null, row.meta?.captured_by_market === market.id, now, s, "stored first print");
  }

  const missing = now - s.releaseAtMs >= (s.missingAfterMs ?? MISSING_AFTER_MS);
  let holder: boolean;
  try { holder = (await rpc<boolean>(client, "claim_official_fetch", { p_series: fetchSlotOf(r.series), p_period: r.period, p_seconds: FETCH_LEASE_S })) === true; }
  catch (e) { return { error: `claim_official_fetch: ${String(e).slice(0, 200)}` }; }
  if (!holder) {
    if (missing) return missingOutcome(env, r, now, s, "another leg holds the fetch lease");
    return { notModified: true, nextPollAt: officialIdleNextPoll(now, s, "awaiting"), note: "awaiting_observation: another leg of this event holds the fetch lease" };
  }

  // an election count is never final in the first minute after polls close: no burst for election contests
  const burst = !missing && !s.election && inReleaseMinute(now, s.releaseAtMs);
  if (deps.waitUntil) {
    // pg_net stops waiting after 30 s: the capture never runs inside the request when it can run after it. Only the
    // release-minute burst can commit inline (holderCapture): then the poll keeps this watch's lease until its next
    // minute poll, so no other run of this leg (a tenant fetch, a redispatch) starts beside the inline commit, and the
    // lease ends exactly when the leg is due again, so a task that dies holding it delays nothing.
    const inline = burst ? deps.inline : undefined;
    const next = s.election ? officialIdleNextPoll(now, s, "awaiting", { holder: true }) : iso(minuteStart(now) + MIN);
    // a second before the next minute start: pg_cron's select_due_watches() then finds the lease expired (lease_until < now())
    const leaseUntil = iso(Date.parse(next) - 1000);
    const task = holderCapture(env, r, market, watch.id, s, burst, inline, deps)
      .catch((e) => safeAlert(env, upstreamAlertKey(r), `${r.series} ${r.period}: the capture threw: ${String(e).slice(0, 200)}`, 60, { series: r.series, period: r.period }));
    deps.waitUntil(task);
    if (missing) return missingOutcome(env, r, now, s, "the capture continues in waitUntil");
    return {
      notModified: true, nextPollAt: next, ...(inline ? { leaseUntil } : {}),
      note: burst
        ? `release minute: the capture burst continues in waitUntil; ${inline ? `a first print recorded within ${INLINE_COMMIT_WINDOW_S} s of release_at commits this leg in this invocation and dispatches the event's other legs at once, else ` : ""}every leg resolves from the stored first print on its next poll`
        : "the capture continues in waitUntil; every leg resolves from the stored first print on its next poll",
    };
  }

  const c = await captureOfficial(env, r, market.id, { burst }, deps);
  switch (c.kind) {
    case "recorded": return observedOutcome(env, r, c.stored, c.fetched, c.ownCapture, deps.now(), s, c.inserted ? "first print recorded" : "first print already stored");
    case "pending": return missing ? missingOutcome(env, r, now, s, c.detail) : { notModified: true, nextPollAt: officialIdleNextPoll(deps.now(), s, "awaiting", { holder: true }), note: `awaiting_observation: ${c.detail}` };
    // httpStatus is recorded for diagnostics; no leg ever stores a 200 for an official source, so runWatch's per-watch
    // 200 -> non-200 alert stays quiet and the per-series alert above is the one that fires.
    case "error": return missing ? missingOutcome(env, r, now, s, c.error) : { error: c.error, ...(c.httpStatus !== undefined ? { httpStatus: c.httpStatus } : {}), ...(c.deferSeconds !== undefined ? { deferSeconds: c.deferSeconds } : {}) };
    default: { const never: never = c; throw new Error(`unhandled capture ${String(never)}`); }
  }
}

/**
 * The official_release step of a watch poll (runWatch calls fetchOfficial for source_kind official_release).
 *
 * (a) Before the event's scheduled release (KNOWN_RELEASES, else the market's release_at): no upstream request;
 *     next_poll_at = the start of the release minute (pg_cron dispatches once a minute, migration 007).
 * (b) At/after it every leg first reads the shared first print (official_observations, migration 016). Dozens of
 *     legs of one ladder share one (series, period): only the holder of claim_official_fetch requests the source,
 *     so the upstream sees one fetcher per minute however many legs exist. A Retry-After extends that lease, so the
 *     whole ladder backs off, not one leg.
 * (c) The holder's capture runs in waitUntil whenever the route has an ExecutionContext, and the poll returns at
 *     once (legs resolve from the stored row on their next poll): pg_net waits 30 s at most. Inside the release
 *     minute it is the scheduled burst (plan §18.1): every 3 s for at most 25 s and at most 10 upstream requests,
 *     stopping at the first observation. Without an ExecutionContext the capture runs as bounded awaits: at most
 *     12 s including corroboration outside the release minute (every request's timeout is clamped to that).
 * (d) Not observed by release + 6 h: one UNRESOLVED observation (release_not_observed) per leg plus an alert, then a
 *     poll every 15 minutes until the market text's fallback window ends (the next scheduled release or meeting,
 *     45 days at most), daily for 7 more days, then the watch stops with one alert. Never an older period: the
 *     adapters only record a document about the target period.
 * (e) Change detection projects series|period|first print|corroboration status (src/ingest/projection.ts): later
 *     polls are no_op, and an audited re-check of the corroboration (recheck_official_corroboration) re-resolves.
 *
 * Subrequests per invocation (Workers Free allows 50), worst case = the slot holder in the release minute with no
 * waitUntil: watch load 1 + official_observations read 1 + claim_official_fetch 1 + burst <= 10 upstream (a Fed or
 * ECB attempt is feed + document, and each redirect hop, all counted in the 10) + extend_official_fetch 1 +
 * corroboration 1 + R2 put of the upstream body 1 + record_official_observation 1 + revision/disagreement/prior-level
 * alerts <= 3 x 3 (dedup read, insert, Telegram) = 26, then runWatch stores and resolves: R2 put 1 + evidence insert
 * 1 + check_gates 1 + resolutions insert 1 + evidence update 1 + commit 3 (bot_posts read, Telegram, insert) +
 * watches update 1 + loop_runs insert 1 = 10. Total 36. With waitUntil: the request makes 5 (load, read, claim,
 * watches update, loop_runs) and the capture task <= 23.
 */
import type { Env } from "../env";
import { db, rpc } from "../db/supabase";
import type { FetchOutcome, MarketRow, WatchRow } from "./types";
import { MAX_DEFER_S } from "./http";
import { fetchPrimary, fetchCorroboration, budget, type FetchedObservation, type PrimaryResult } from "./official";
import {
  OFFICIAL_SERIES, OfficialCorroboration, firstPrintFor, officialEvidence, priorLevelProblem, releaseAtOf, fallbackEndMs,
  type OfficialObservationDoc, type OfficialMissingDoc, type OfficialResolver, type OfficialSeriesId,
} from "../resolve/official";
import { alert } from "../ops/alerts";

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

export interface OfficialDeps { now(): number; sleep(ms: number): Promise<void>; waitUntil?: (p: Promise<unknown>) => void }
const REAL: Pick<OfficialDeps, "now" | "sleep"> = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const MIN = 60_000;
const DAY = 86_400_000;
const minuteStart = (ms: number) => Math.floor(ms / MIN) * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

export type OfficialPhase = "before" | "awaiting" | "observed" | "missing";
export interface OfficialSchedule { releaseAtMs: number; fallbackEndMs: number }

export function officialSchedule(r: OfficialResolver): OfficialSchedule {
  return { releaseAtMs: Date.parse(releaseAtOf(r)), fallbackEndMs: fallbackEndMs(r) };
}

/**
 * next_poll_at when a poll changes nothing. pg_cron selects due watches at each minute start, so every schedule is
 * a minute start. Awaiting: every minute for 10 minutes after the release, every 5 minutes to 6 h, then every 15
 * until the fallback window ends, then daily. Observed: the first print is final, so every 6 h (an audited
 * corroboration re-check is picked up then) until the fallback window ends.
 */
export function officialIdleNextPoll(nowMs: number, s: OfficialSchedule, phase: OfficialPhase): string {
  const late = nowMs >= s.fallbackEndMs;
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
  };
}

function docFromFetch(obs: FetchedObservation, corroboration: OfficialCorroboration): OfficialObservationDoc {
  return {
    kind: "official_observation", series: obs.series, period: obs.period, value: obs.value, value_text: obs.value_text, deciding_text: obs.deciding_text,
    source_url: obs.source_url, raw_sha256: obs.raw_sha256, observed_at: obs.fetched_at, direction: obs.direction, corroboration,
    stated_prior: strOrNull(obs.meta.stated_prior), stated_step_bps: numOrNull(obs.meta.stated_step_bps),
  };
}

async function safeAlert(env: Env, key: string, text: string, dedupMinutes: number, meta: Record<string, unknown>): Promise<void> {
  try { await alert(env, key, text, { dedupMinutes, meta }); }
  catch (e) { console.error(JSON.stringify({ level: "error", job: "official_alert", key, error: String(e).slice(0, 200) })); }
}

export type Capture =
  | { kind: "recorded"; stored: OfficialObservationDoc; fetched: OfficialObservationDoc; inserted: boolean; revision: boolean; ownCapture: boolean; requests: number }
  | { kind: "pending"; detail: string; requests: number }
  | { kind: "error"; error: string; retryable: boolean; drift: boolean; httpStatus?: number; deferSeconds?: number; requests: number };

/**
 * The slot holder's fetch: primary (one attempt, or the burst), then corroboration (one request), the upstream body
 * to R2, and record_official_observation (first print wins; a different later value comes back as revision_differs).
 * marketId is recorded as the capturer: for events outside KNOWN_RELEASES only a market's own capture is held to
 * its own release_at (src/resolve/official.ts gate 1).
 */
export async function captureOfficial(env: Env, r: OfficialResolver, marketId: string, mode: { burst: boolean }, deps: Pick<OfficialDeps, "now" | "sleep">): Promise<Capture> {
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
  if (res.kind === "pending") return { ...res, requests: b.used };
  if (res.kind === "error") {
    // The source asked to wait: the whole ladder backs off (every leg's claim fails while the lease lives).
    if (res.deferSeconds !== undefined) {
      try { await rpc(db(env), "extend_official_fetch", { p_series: r.series, p_period: r.period, p_seconds: Math.min(MAX_DEFER_S, Math.max(FETCH_LEASE_S, res.deferSeconds)) }); }
      catch (e) { await safeAlert(env, `official_upstream_${r.series}_${r.period}`, `${r.series} ${r.period}: could not extend the fetch lease for Retry-After ${res.deferSeconds} s: ${String(e).slice(0, 200)}`, 60, meta); }
    }
    // The fetch lease rotates across the legs of a ladder, so no single watch accumulates an error streak: the
    // alert is per series. Only a retryable answer inside the release-minute burst (the burst itself retries) waits.
    if (res.drift) await safeAlert(env, `official_schema_${r.series}`, `${r.series} ${r.period}: the source no longer parses (${res.error}). Nothing was recorded; the parser needs a look before the release window closes.`, 360, meta);
    else if (!res.retryable || !mode.burst) await safeAlert(env, `official_upstream_${r.series}_${r.period}`, `${r.series} ${r.period}: ${res.error}. Nothing was recorded; the next poll retries.`, 60, meta);
    return { kind: "error", error: `${res.error} (${b.used} upstream requests)`, retryable: res.retryable, drift: res.drift, httpStatus: res.httpStatus, deferSeconds: res.deferSeconds, requests: b.used };
  }
  const obs = res.obs;
  let corroboration: OfficialCorroboration;
  try { corroboration = await fetchCorroboration(obs, r.period, budget(deps.now, 0, 1, Math.min(deps.now() + 8000, hardStop))); }
  catch (e) { corroboration = { status: "unavailable", source_url: null, value: null, value_text: null, detail: `corroboration threw: ${String(e).slice(0, 200)}`, checked_at: iso(deps.now()) }; }
  // The upstream body first: a first print names bytes that exist (the evidence rows follow the same rule).
  try { await env.RAW.put(`raw/${obs.raw_sha256}`, obs.raw, { httpMetadata: { contentType: "application/octet-stream" } }); }
  catch (e) { await safeAlert(env, "r2_put_failed", `R2 put raw/${obs.raw_sha256} (${r.series} ${r.period} upstream body) failed: ${String(e).slice(0, 200)}`, 60, meta); }
  let row: StoredRow;
  try {
    row = await rpc<StoredRow>(db(env), "record_official_observation", {
      p_series: r.series, p_period: r.period, p_value: obs.value, p_value_text: obs.value_text, p_deciding_text: obs.deciding_text,
      p_source_url: obs.source_url, p_raw_sha256: obs.raw_sha256, p_corroboration: corroboration,
      p_meta: { ...obs.meta, direction: obs.direction, doc_period: obs.period, fetched_at: obs.fetched_at, upstream_requests: b.used + 1, captured_by_market: marketId },
    });
  } catch (e) { return { kind: "error", error: `record_official_observation: ${String(e).slice(0, 200)}`, retryable: true, drift: false, requests: b.used }; }
  const stored = docFromRow(row);
  const fetched = docFromFetch(obs, corroboration);
  if (row.revision_differs) {
    await safeAlert(env, `official_revision_${r.series}_${r.period}`, `${r.series} ${r.period}: stored first print ${stored.value_text} (${stored.observed_at}); a later read offered ${obs.value_text} from ${obs.source_url}. The first print stands.`, 1440, meta);
  }
  if (row.inserted && corroboration.status === "disagree") {
    await safeAlert(env, `official_disagree_${r.series}_${r.period}`, `${r.series} ${r.period}: primary ${obs.value_text} (${obs.source_url}) vs ${corroboration.value_text} (${corroboration.source_url}). Every leg stays UNRESOLVED (sources_disagree) until an operator re-checks it (POST /internal/official/recheck).`, 1440, meta);
  }
  return { kind: "recorded", stored, fetched, inserted: row.inserted === true, revision: row.revision_differs === true, ownCapture: row.meta?.captured_by_market === marketId, requests: b.used };
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
  const doc: OfficialMissingDoc = { kind: "official_missing", series: r.series, period: r.period, release_at: releaseAtOf(r), source_url: OFFICIAL_SERIES[r.series].primaryUrl, detail: "not observed by release_at + 6 h" };
  const { evidence, rawBytes } = officialEvidence(doc, iso(nowMs));
  if (nowMs >= stopAt) {
    await safeAlert(env, `official_stopped_${r.series}_${r.period}`, `${r.series} ${r.period} was never observed; its fallback window ended ${iso(s.fallbackEndMs)} and a week of daily polls found nothing. The watches stop; the legs stay UNRESOLVED (release_not_observed). Last: ${why}`, 14_400, meta);
    return { evidence, rawBytes, nextPollAt: officialIdleNextPoll(nowMs, s, "missing"), note: `release_not_observed, polling stopped: ${why}`, stop: "never observed; the fallback window and a week of daily polls have passed" };
  }
  await safeAlert(env, `official_missing_${r.series}_${r.period}`, `${r.series} ${r.period} was not observed by release_at + 6 h (release ${releaseAtOf(r)}). Its legs are UNRESOLVED (release_not_observed) and keep polling (every 15 min until ${iso(s.fallbackEndMs)}, then daily); nothing resolves from an older period. Last: ${why}`, 720, meta);
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

  const missing = now - s.releaseAtMs >= MISSING_AFTER_MS;
  let holder: boolean;
  try { holder = (await rpc<boolean>(client, "claim_official_fetch", { p_series: r.series, p_period: r.period, p_seconds: FETCH_LEASE_S })) === true; }
  catch (e) { return { error: `claim_official_fetch: ${String(e).slice(0, 200)}` }; }
  if (!holder) {
    if (missing) return missingOutcome(env, r, now, s, "another leg holds the fetch lease");
    return { notModified: true, nextPollAt: officialIdleNextPoll(now, s, "awaiting"), note: "awaiting_observation: another leg of this event holds the fetch lease" };
  }

  const burst = !missing && inReleaseMinute(now, s.releaseAtMs);
  if (deps.waitUntil) {
    // pg_net stops waiting after 30 s: the capture never runs inside the request when it can run after it.
    const task = captureOfficial(env, r, market.id, { burst }, deps)
      .then((c) => console.log(JSON.stringify({ job: "official_capture", series: r.series, period: r.period, burst, outcome: c.kind, requests: c.requests, detail: c.kind === "recorded" ? c.stored.value_text : c.kind === "pending" ? c.detail : c.error })))
      .catch((e) => safeAlert(env, `official_upstream_${r.series}_${r.period}`, `${r.series} ${r.period}: the capture threw: ${String(e).slice(0, 200)}`, 60, { series: r.series, period: r.period }));
    deps.waitUntil(task);
    if (missing) return missingOutcome(env, r, now, s, "the capture continues in waitUntil");
    return { notModified: true, nextPollAt: iso(minuteStart(now) + MIN), note: `${burst ? "release minute: the capture burst" : "the capture"} continues in waitUntil; every leg resolves from the stored first print on its next poll` };
  }

  const c = await captureOfficial(env, r, market.id, { burst }, deps);
  switch (c.kind) {
    case "recorded": return observedOutcome(env, r, c.stored, c.fetched, c.ownCapture, deps.now(), s, c.inserted ? "first print recorded" : "first print already stored");
    case "pending": return missing ? missingOutcome(env, r, now, s, c.detail) : { notModified: true, nextPollAt: officialIdleNextPoll(deps.now(), s, "awaiting"), note: `awaiting_observation: ${c.detail}` };
    // httpStatus is recorded for diagnostics; no leg ever stores a 200 for an official source, so runWatch's per-watch
    // 200 -> non-200 alert stays quiet and the per-series alert above is the one that fires.
    case "error": return missing ? missingOutcome(env, r, now, s, c.error) : { error: c.error, ...(c.httpStatus !== undefined ? { httpStatus: c.httpStatus } : {}), ...(c.deferSeconds !== undefined ? { deferSeconds: c.deferSeconds } : {}) };
    default: { const never: never = c; throw new Error(`unhandled capture ${String(never)}`); }
  }
}

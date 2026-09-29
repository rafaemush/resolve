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
 *     once (legs resolve from the stored row on their next poll): pg_net waits 30 s at most. Inside the release
 *     minute it is the scheduled burst (plan §18.1): every 3 s for at most 25 s and at most 10 upstream requests,
 *     stopping at the first observation. Without an ExecutionContext the capture runs as bounded awaits: at most
 *     12 s including corroboration outside the release minute (every request's timeout is clamped to that).
 * (d) Not observed by release + 6 h: one UNRESOLVED observation (release_not_observed) per leg plus an alert, then a
 *     poll every 15 minutes until the market text's fallback window ends (the next scheduled release or meeting,
 *     45 days at most), daily for 7 more days, then the watch stops with one alert. Never an older period: the
 *     adapters only record a document about the target period. A first print first seen at or after the named
 *     fallback is still recorded (the audit trail of when it appeared) but decides nothing: gate 1 answers
 *     released_after_fallback, because the market texts then settle on an earlier period.
 * (e) Change detection projects series|period|first print|corroboration status (src/ingest/projection.ts): later
 *     polls are no_op, and an audited re-check of the corroboration (recheck_official_corroboration) re-resolves.
 *
 * Subrequests per invocation (Workers Free allows 50), worst case = the slot holder in the release minute with no
 * waitUntil: watch load 1 + official_observations read 1 + claim_official_fetch 1 + burst <= 10 upstream (a Fed or
 * ECB attempt is feed + document, and each redirect hop, all counted in the 10) + extend_official_fetch 1 +
 * corroboration 1 + R2 put of the upstream body 1 + record_official_observation 1 + revision/disagreement/prior-level
 * alerts <= 3 x 3 (dedup read, insert, Telegram) = 26, then runWatch stores and resolves: R2 put 1 + evidence insert
 * 1 + check_gates 1 + resolutions insert 1 + evidence update 1 + commit 3 (bot_posts read, Telegram, insert) +
 * watches update 1 + loop_runs insert 1 = 10. Total 36 (no siblings are recorded inline). With waitUntil: the request
 * makes 5 (load, read, claim, watches update, loop_runs) and the capture task <= 23 for its own series plus, for a
 * fetch group, 1 read of the siblings' rows and per missing sibling (3 at most, the CPI group) corroboration 1 +
 * record 1 + one alert 3 (a sibling is either inserted, and alerted on a disagreement, or a revision) = 16: 44.
 *
 * Election series (src/resolve/election.ts) poll differently: no burst (a count is final hours after polls close, never
 * in the first minute), the fetch lease of a contest is extended to ELECTION_REFETCH_S after every pending or failed
 * capture so each contest file is requested at most once per 4 minutes however many legs poll it, the holder's leg
 * polls again in 5 minutes and every other leg every 15, and the count may take 72 h (not 6) before the legs are
 * reported release_not_observed, after which every leg polls hourly. Upstream-failure alerts are per authority (tse,
 * eq), not per series. A TSE capture requests the configuration and then the contest file (2 upstream requests); an
 * isolate that captured another TSE contest in the last 60 s reuses the configuration it read (a per-isolate memo, so
 * it only saves requests: the bound on the TSE hosts is the fetch lease of each contest, since every isolate and every
 * contest reads the configuration again). The Élections Québec capture requests the one file, and a final count is
 * recorded only on a read that confirms an earlier one (EQ_STABLE_MS; the first read is kept in app_config, 1 read and
 * at most 1 write per capture). The holder's waitUntil records its own series and the siblings of its fetch group from
 * the same bytes: request 5 + upstream 2 (Québec: 1 + the app_config read 1) + R2 1 + record 1 + siblings read 1 + one
 * record per sibling (the TSE national file: 8; the Québec file: 29, no corroboration request exists for elections) =
 * 39 at most, with a lease extension 1 and an alert 3 when a capture fails or waits instead.
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

export interface OfficialDeps { now(): number; sleep(ms: number): Promise<void>; waitUntil?: (p: Promise<unknown>) => void }
const REAL: Pick<OfficialDeps, "now" | "sleep"> = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

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

export type Capture =
  | { kind: "recorded"; stored: OfficialObservationDoc; fetched: OfficialObservationDoc; inserted: boolean; revision: boolean; ownCapture: boolean; requests: number; siblings: string[] }
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

/**
 * The other series of the fetch group that the holder's page states for the period: each one not yet stored gets its
 * own corroboration and first print from the same bytes (already in R2). Never throws; returns one note per sibling.
 */
async function recordSiblings(env: Env, r: OfficialResolver, marketId: string, siblings: FetchedObservation[], upstream: number, deps: Pick<OfficialDeps, "now">, hardStop: number, extraMeta: Record<string, unknown> = {}): Promise<string[]> {
  if (!siblings.length) return [];
  const { data, error } = await db(env).from("official_observations").select("series").eq("period", r.period).in("series", siblings.map((s) => s.series));
  if (error) return siblings.map((s) => `${s.series}: not recorded (official_observations read: ${error.message.slice(0, 120)})`);
  const stored = new Set(((data ?? []) as Array<{ series: string }>).map((x) => x.series));
  const todo = siblings.filter((s) => !stored.has(s.series));
  const notes = siblings.filter((s) => stored.has(s.series)).map((s) => `${s.series}: already stored`);
  const corr = await Promise.all(todo.map((s) => corroborate(s, r.period, deps, hardStop)));
  for (const [i, s] of todo.entries()) {
    try {
      const row = await recordObservation(env, s, r.period, corr[i]!, { upstream_requests: upstream + 1, captured_by_market: marketId, sibling_of: r.series, ...extraMeta });
      notes.push(`${s.series}: ${row.inserted ? "recorded" : "already stored"} ${row.value_text}`);
    } catch (e) { notes.push(`${s.series}: record_official_observation: ${String(e).slice(0, 160)}`); }
  }
  return notes;
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
  return [...await recordSiblings(env, r, marketId, siblings, upstream, deps, hardStop), ...(res.siblingNotes ?? [])];
}

/**
 * The slot holder's fetch: primary (one attempt, or the burst), then corroboration (one request), the upstream body
 * to R2, and record_official_observation (first print wins; a different later value comes back as revision_differs).
 * marketId is recorded as the capturer: for events outside KNOWN_RELEASES only a market's own capture is held to
 * its own release_at (src/resolve/official.ts gate 1). With mode.siblings (a capture in waitUntil) the other series
 * of the fetch group that the same page states are recorded too (recordSiblings).
 */
export async function captureOfficial(env: Env, r: OfficialResolver, marketId: string, mode: { burst: boolean; siblings?: boolean }, deps: Pick<OfficialDeps, "now" | "sleep">): Promise<Capture> {
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
  const corroboration = await corroborate(obs, r.period, deps, hardStop);
  // The upstream body first: a first print names bytes that exist (the evidence rows follow the same rule).
  try { await env.RAW.put(`raw/${obs.raw_sha256}`, obs.raw, { httpMetadata: { contentType: "application/octet-stream" } }); }
  catch (e) { await safeAlert(env, "r2_put_failed", `R2 put raw/${obs.raw_sha256} (${r.series} ${r.period} upstream body) failed: ${String(e).slice(0, 200)}`, 60, meta); }
  let row: StoredRow;
  try { row = await recordObservation(env, obs, r.period, corroboration, { upstream_requests: b.used + 1, captured_by_market: marketId, ...confirmedMeta }); }
  catch (e) { return { kind: "error", error: `record_official_observation: ${String(e).slice(0, 200)}`, retryable: true, drift: false, requests: b.used }; }
  const stored = docFromRow(row);
  const fetched = docFromFetch(obs, corroboration);
  const siblings = mode.siblings ? await recordSiblings(env, r, marketId, res.siblings ?? [], b.used, deps, hardStop, confirmedMeta) : [];
  if (mode.siblings) siblings.push(...(res.siblingNotes ?? []));
  return { kind: "recorded", stored, fetched, inserted: row.inserted === true, revision: row.revision_differs === true, ownCapture: row.meta?.captured_by_market === marketId, requests: b.used, siblings };
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
    // pg_net stops waiting after 30 s: the capture never runs inside the request when it can run after it.
    const task = captureOfficial(env, r, market.id, { burst, siblings: true }, deps)
      .then((c) => console.log(JSON.stringify({ job: "official_capture", series: r.series, period: r.period, burst, outcome: c.kind, requests: c.requests, detail: c.kind === "recorded" ? c.stored.value_text : c.kind === "pending" ? c.detail : c.error, ...(c.siblings?.length ? { siblings: c.siblings } : {}) })))
      .catch((e) => safeAlert(env, upstreamAlertKey(r), `${r.series} ${r.period}: the capture threw: ${String(e).slice(0, 200)}`, 60, { series: r.series, period: r.period }));
    deps.waitUntil(task);
    if (missing) return missingOutcome(env, r, now, s, "the capture continues in waitUntil");
    return { notModified: true, nextPollAt: s.election ? officialIdleNextPoll(now, s, "awaiting", { holder: true }) : iso(minuteStart(now) + MIN), note: `${burst ? "release minute: the capture burst" : "the capture"} continues in waitUntil; every leg resolves from the stored first print on its next poll` };
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

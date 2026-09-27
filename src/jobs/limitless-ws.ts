/**
 * Limitless lifecycle listener: the exact resolution time of a Limitless market (the marketResolved websocket event),
 * kept next to the poll recorder's first sighting (src/jobs/limitless-recorder.ts, migration 018; ±10 min).
 *
 * One instance. A Durable Object (class LimitlessListener, SQLite backend) addressed only by LISTENER_NAME: pingListener()
 * is the only code that makes a stub, and the object refuses any other name the runtime shows it. It opens an outbound
 * websocket with fetch() + Upgrade: websocket, speaks Engine.IO v4 / Socket.IO v5 by hand (limitless-ws-protocol.ts),
 * subscribes to the lifecycle, and queues every marketResolved in its own storage. It serves nothing public and changes
 * no customer-facing output.
 *
 * The write, without a migration. Service role can only SELECT limitless_markets; its one write path is
 * record_limitless_observations(), where an observed = false, checked = false row only merges meta (every other column
 * keeps its value; scripts/selftest/recorder.ts asserts it on Postgres). The alarm writes, per slug the poll recorded:
 *   meta.ws        {resolution_date, winning_index, winning_outcome, trade_type, received_at, source: "limitless_ws",
 *                   poll_index when the poll already had an index}   (the first event; never replaced)
 *   meta.ws_latest the same shape, when a later event for the slug says something else
 * resolved_seen_at is NOT set: it is the poll's first sighting (reconcile reads it as official_at, limitless_api_poll),
 * set once, and it could never be cross-checked against the poll if the websocket wrote it first. Unknown slugs are
 * never inserted: the lifecycle channel also carries every automated market (BTC/ETH 5-minute markets), which would
 * swamp v_limitless_cadence. A slug the table lacks is looked up once more 2 min later (UNKNOWN_RETRY_MS: a poll insert
 * racing the event), then dropped and counted in the day summary. Later lookups could not help: the poll imports only
 * manual markets from /markets/active, so a market already resolved is never inserted afterwards. The runbook
 * (docs/runbooks/limitless-recorder.md) has the SQL that reads meta.ws.
 *
 * Cross-check. At flush time the poll has usually not seen the outcome yet (it polls every 10 min), so every
 * CROSS_CHECK_MS the alarm also reads the rows the poll resolved in the last day that carry meta.ws, and alerts
 * (limitless_ws_index_disagrees) when meta.ws.winning_index is not winning_outcome_index or resolution_date is outside
 * (last_pending_at, resolved_seen_at]. Each slug is checked once (state.checked, kept 2 days).
 *
 * Liveness. A 60 s alarm: reconnect when due (backoff 1 s doubling to 60 s, half jittered, reset after 60 s of stable
 * connection), drop a socket with no server ping for pingInterval + pingTimeout (85 s, as an Engine.IO v4 client) or no subscription confirmation 30 s after
 * the namespace ack, flush the queue, write loop_runs, raise alerts. The alarm also keeps the object in memory: an
 * outbound websocket defers eviction for 15 min at most, then an object with no incoming event for 70-140 s is evicted
 * (Durable Object lifecycle docs, read 2026-09-28). The every-minute cron pings the object (pingListener), which creates
 * it on the first deploy and restarts it after an eviction even if an alarm were lost. No stable connection for 15 min:
 * one alert (limitless_ws_down, once per outage; dedup 15 min, so a second outage is never swallowed by the first's), then limitless_ws_recovered. loop_runs (loop_name
 * limitless_ws): one row per (re)connect, one per outage alert, one per UTC day with the counters; never per message.
 *
 * Switch: wrangler.toml LIMITLESS_WS_ENABLED; only "1" runs it. It ships "0": the workerd outbound-websocket path and
 * Cloudflare egress to ws.limitless.exchange are not yet verified (the smoke run used Node), and the Durable Object
 * duration allowance is per account. Turn it on in its own deploy (runbook: post-deploy check). Off: the object clears
 * its alarm, forgets its outage clock and stays idle.
 *
 * On deploy. Cloudflare shuts every Durable Object down on a code update. The socket goes without a close event; the
 * stored alarm or the next cron ping (at most ~60 s) starts the new code, which reconnects. Limitless does not replay
 * events from that gap; the poll recorder still records those markets. The queue is never lost (written on arrival);
 * up to one alarm period of counters can be.
 *
 * Cost (Durable Objects pricing page, read 2026-09-28). An accepted websocket bills duration for as long as it is open
 * and the object cannot hibernate: 128 MB x 86,400 s = 10,800 GB-s a day for the one instance.
 *   Workers Free: 13,000 GB-s/day included PER ACCOUNT (shared with every other Worker on account 2669bd..., OilFlow
 *     included); this one instance uses 83% of it alone, and past any free limit "further operations of that type will
 *     fail" until 00:00 UTC for every Durable Object on the account. Enable it on Free only after checking the account's
 *     Durable Object duration in the dashboard; Workers Paid is the intended home. Requests 100,000/day (~1,440 alarms + 1,440 cron pings + incoming
 *     messages, at most ~5,000). SQLite rows written 100,000/day (~1,500 state saves + ~2 per
 *     resolved event, ~4 for an unknown slug: put, requeue put + delete, delete).
 *   Workers Paid: 400,000 GB-s/month included vs ~328,000 used (10,800 x 30.4), so $0 beyond the base fee; incoming
 *     websocket messages bill 20:1 against 1M requests/month; storage is far inside the included amounts.
 * Per alarm at most 14 of 50 subrequests: connect 1 + FLUSH_BATCHES_PER_ALARM x (select + RPC) + cross-check 1 + loop_runs 1
 * + one alertMany (5).
 */
import { z } from "zod";
import type { Env } from "../env";
import { db } from "../db/supabase";
import { alertMany, type AlertItem } from "../ops/alerts";
import { redact } from "../ops/redact";
import { botUa } from "../ops/ua";
import { GIVE_UP_DAYS, type Observation } from "./limitless-recorder";
import { emitFrame, namespaceConnect, parseFrame, pongFrame, type SocketPacket } from "./limitless-ws-protocol";

/** The one instance. Two would pass Workers Free's 13,000 GB-s a day, an allowance shared by the whole account (header). */
export const LISTENER_NAME = "limitless-lifecycle";
/** Where the one instance is created (permanently): eastern North America, next to Supabase (us-east-1). */
export const LOCATION_HINT = "enam";
/** Only wrangler.toml LIMITLESS_WS_ENABLED = "1" runs the listener; anything else (unset included) is off: the cron stops pinging and the object closes its socket and clears its alarm. */
export const listenerEnabled = (env: Pick<Env, "LIMITLESS_WS_ENABLED">): boolean => env.LIMITLESS_WS_ENABLED?.trim() === "1";
export const WS_URL = "https://ws.limitless.exchange/socket.io/?EIO=4&transport=websocket";
export const NAMESPACE = "/markets";
export const SUBSCRIBE_EVENT = "subscribe_market_lifecycle";
export const LOOP_NAME = "limitless_ws";
export const LIVENESS_ALARM_MS = 60_000;
/** Until the open packet says otherwise (it said 25,000 and 60,000 on 2026-09-28). No server ping for pingInterval + pingTimeout is a dead connection, as for an Engine.IO v4 client. */
export const DEFAULT_PING_INTERVAL_MS = 25_000;
export const DEFAULT_PING_TIMEOUT_MS = 60_000;
/** After the namespace ack, the "Subscribed to market lifecycle events" system message (or any lifecycle event) must come within this. */
export const SUBSCRIBE_TIMEOUT_MS = 30_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** A subscribed connection up this long ends the outage and resets the backoff. */
export const STABLE_MS = 60_000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const DOWN_ALERT_MS = 15 * 60_000;
/** Once per outage is kept in state; the dedup only has to stop a double send, so it is the threshold itself (a new outage alerts at the earliest 15 min after it starts, which is after any earlier outage's alert). */
export const DOWN_ALERT_DEDUP_MINUTES = 15;
export const RECOVERED_DEDUP_MINUTES = 60;
export const SCHEMA_DEDUP_MINUTES = 1440;
export const DISAGREE_DEDUP_MINUTES = 360;
export const DISAGREE_KEY = "limitless_ws_index_disagrees";
export const WRITE_FAILING_ALERTS = 15;
export const WRITE_FAILING_DEDUP_MINUTES = 360;
/** Slugs per select + RPC (the select's in.(...) list stays well under PostgREST's URL limit). */
export const FLUSH_BATCH = 50;
export const FLUSH_BATCHES_PER_ALARM = 3;
/** When a slug the table does not have is looked up again (a poll insert racing the event); after the last one the event is dropped. */
export const UNKNOWN_RETRY_MS = [2 * 60_000] as const;
/** How often the alarm cross-checks meta.ws against the poll's sighting, over rows the poll resolved in the last CROSS_CHECK_LOOKBACK_MS. */
export const CROSS_CHECK_MS = 10 * 60_000;
export const CROSS_CHECK_LOOKBACK_MS = 86_400_000;
/** A checked slug is remembered this long (longer than the lookback, so it is never checked twice). */
export const CHECKED_KEEP_MS = 2 * 86_400_000;
export const CHECKED_MAX = 5_000;
/** A queued event this old is dropped whatever happened (a database down for a week). */
export const MAX_EVENT_AGE_MS = 7 * 86_400_000;
/** A resolutionDate this far past the moment the event arrived is a clock or unit error, never kept. */
export const FUTURE_SKEW_MS = 5 * 60_000;
export const MAX_PENDING_RUNS = 50;
export const DROPPED_SAMPLE_MAX = 10;
export const STATE_KEY = "state";
export const QUEUE_PREFIX = "q:";
const STORAGE_BATCH = 128;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MIN_DATE = Date.UTC(2020, 0, 1);

// ---- pure helpers ---------------------------------------------------------------------------------------------------

/** What meta.ws / meta.ws_latest hold for one marketResolved. */
export interface WsRecord {
  resolution_date: string; winning_index: number | null; winning_outcome: string | null; trade_type: string | null;
  received_at: string; source: "limitless_ws"; poll_index?: number;
}
/** One queued event: the record plus its slug and how many lookups found no row for it. */
export interface QueuedEvent extends Omit<WsRecord, "poll_index"> { slug: string; tries: number }

const Resolved = z.object({
  slug: z.string().regex(SLUG),
  type: z.string().max(20).nullish(),
  winningOutcome: z.string().max(20).nullish(),
  winningIndex: z.number().int().min(0).max(1000).nullish(),
  resolutionDate: z.string().max(40),
});

/** Pure. A marketResolved payload -> the queued event, or why it is refused (schema drift, alerted once a day). */
export function parseResolved(raw: unknown, receivedAt: number): QueuedEvent | { error: string } {
  const p = Resolved.safeParse(raw);
  if (!p.success) return { error: `marketResolved payload refused at ${p.error.issues[0]?.path.join(".") || "(root)"}` };
  const t = Date.parse(p.data.resolutionDate);
  if (!Number.isFinite(t) || t < MIN_DATE) return { error: "marketResolved resolutionDate is not a date after 2020" };
  if (t > receivedAt + FUTURE_SKEW_MS) return { error: "marketResolved resolutionDate is more than 5 min after it arrived" };
  return {
    slug: p.data.slug, resolution_date: new Date(t).toISOString(), winning_index: p.data.winningIndex ?? null,
    winning_outcome: p.data.winningOutcome ?? null, trade_type: p.data.type ? p.data.type.toLowerCase() : null,
    received_at: new Date(receivedAt).toISOString(), source: "limitless_ws", tries: 0,
  };
}

/** Pure. Delay before connect attempt n (1-based): 1 s doubling to 60 s, the upper half jittered by rnd in [0, 1). */
export function backoffMs(attempt: number, rnd: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 30) - 1));
  return Math.round(base / 2 + (Math.min(Math.max(rnd, 0), 1) * base) / 2);
}

/** Pure. Queue key: due time first (15 digits of ms), so list() returns the earliest due first. */
export function queueKey(dueMs: number, slug: string, resolutionDate: string): string {
  return `${QUEUE_PREFIX}${String(Math.max(0, Math.floor(dueMs))).padStart(15, "0")}:${slug}|${resolutionDate}`;
}
const dueBefore = (ms: number) => `${QUEUE_PREFIX}${String(Math.max(0, Math.floor(ms))).padStart(15, "0")}`;

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();

/** The row limitless_markets already has for a slug: what the flush reads before it writes. */
export interface KnownRow { slug: string; winning_outcome_index: number | null; meta: Record<string, unknown> | null }

export interface BatchPlan {
  /** One observed = false row per slug, meta only (record_limitless_observations). */
  rows: Observation[];
  /** Queue keys done with: written, duplicate, dropped, expired, or re-keyed. */
  remove: string[];
  /** Re-keyed unknown slugs: new key -> event. */
  requeue: Array<[string, QueuedEvent]>;
  written: number; duplicate: number; changed: number; unknown_retried: number; unknown_dropped: number; expired: number;
  dropped_slugs: string[];
  /** Slugs whose websocket index is not the poll's. */
  disagreements: string[];
}

const sameOutcome = (a: unknown, b: WsRecord): boolean =>
  !!a && typeof a === "object" && (a as WsRecord).resolution_date === b.resolution_date && ((a as WsRecord).winning_index ?? null) === b.winning_index;

/** The meta-only observation: nothing but meta moves in record_limitless_observations for observed = false, checked = false. */
export function metaOnlyObservation(slug: string, meta: Record<string, unknown>): Observation {
  return {
    slug, group_slug: null, container: false, condition_id: null, category: null, trade_type: null, automation_type: null,
    market_type: null, expiration_at: null, platform_created_at: null, observed: false, observed_at: null, checked: false,
    expired: false, winning_outcome_index: null, void: false, meta,
  };
}

/**
 * Pure. What one batch of due queue entries (in key order) does, given the rows the table has for their slugs. The
 * first event per slug is meta.ws and is never replaced; a different later one is meta.ws_latest; the same one again
 * is a duplicate. A slug with no row is looked up again later (UNKNOWN_RETRY_MS) and dropped after the last lookup.
 */
export function planBatch(entries: Array<[string, QueuedEvent]>, known: Map<string, KnownRow>, now: number): BatchPlan {
  const plan: BatchPlan = { rows: [], remove: [], requeue: [], written: 0, duplicate: 0, changed: 0, unknown_retried: 0, unknown_dropped: 0, expired: 0, dropped_slugs: [], disagreements: [] };
  const patches = new Map<string, Record<string, unknown>>();
  const view = new Map<string, { ws: unknown; latest: unknown }>();
  for (const [key, ev] of entries) {
    plan.remove.push(key);
    const age = now - Date.parse(ev.received_at);
    if (!(age <= MAX_EVENT_AGE_MS)) { plan.expired++; continue; }
    const row = known.get(ev.slug);
    if (!row) {
      const wait = (UNKNOWN_RETRY_MS as readonly number[])[ev.tries];
      if (wait === undefined) { plan.unknown_dropped++; plan.dropped_slugs.push(ev.slug); continue; }
      plan.requeue.push([queueKey(now + wait, ev.slug, ev.resolution_date), { ...ev, tries: ev.tries + 1 }]);
      plan.unknown_retried++;
      continue;
    }
    const { slug: _slug, tries: _tries, ...base } = ev;
    const rec: WsRecord = { ...base, ...(typeof row.winning_outcome_index === "number" ? { poll_index: row.winning_outcome_index } : {}) };
    const seen = view.get(ev.slug) ?? { ws: row.meta?.ws ?? null, latest: row.meta?.ws_latest ?? null };
    view.set(ev.slug, seen);
    if (sameOutcome(seen.ws, rec) || sameOutcome(seen.latest, rec)) { plan.duplicate++; continue; }
    const patch = patches.get(ev.slug) ?? {};
    if (!seen.ws) { patch.ws = rec; seen.ws = rec; plan.written++; }
    else { patch.ws_latest = rec; seen.latest = rec; plan.changed++; }
    patches.set(ev.slug, patch);
    if (typeof row.winning_outcome_index === "number" && rec.winning_index !== null && rec.winning_index !== row.winning_outcome_index) plan.disagreements.push(ev.slug);
  }
  plan.rows = [...patches].map(([slug, meta]) => metaOnlyObservation(slug, meta));
  return plan;
}

/** A row the poll resolved, as the cross-check reads it. */
export interface ResolvedRow {
  slug: string; winning_outcome_index: number | null; last_pending_at: string | null; resolved_seen_at: string | null;
  meta: Record<string, unknown> | null;
}

/**
 * Pure. The rows the poll resolved that carry meta.ws and were not checked yet -> the slugs now checked and the ones
 * that disagree: meta.ws.winning_index is not winning_outcome_index (both set), or meta.ws.resolution_date is outside
 * (last_pending_at, resolved_seen_at]. A row without meta.ws yet is left for a later pass.
 */
export function crossCheck(rows: ResolvedRow[], checked: Record<string, number>): { checked: string[]; disagreements: Array<{ slug: string; reason: string }> } {
  const out = { checked: [] as string[], disagreements: [] as Array<{ slug: string; reason: string }> };
  for (const r of rows) {
    const ws = r.meta?.ws as Partial<WsRecord> | undefined;
    if (!ws || typeof ws !== "object" || !r.resolved_seen_at || checked[r.slug] !== undefined) continue;
    out.checked.push(r.slug);
    const reasons: string[] = [];
    if (typeof r.winning_outcome_index === "number" && typeof ws.winning_index === "number" && ws.winning_index !== r.winning_outcome_index) {
      reasons.push(`index ${ws.winning_index} vs poll ${r.winning_outcome_index}`);
    }
    const t = Date.parse(String(ws.resolution_date));
    const lo = r.last_pending_at ? Date.parse(r.last_pending_at) : -Infinity;
    const hi = Date.parse(r.resolved_seen_at);
    if (!(t > lo && t <= hi)) reasons.push(`resolution_date ${ws.resolution_date} outside (${r.last_pending_at ?? "-"}, ${r.resolved_seen_at}]`);
    if (reasons.length) out.disagreements.push({ slug: r.slug, reason: reasons.join("; ") });
  }
  return out;
}

// ---- persisted state ------------------------------------------------------------------------------------------------

export interface Counters {
  frames: number; pings: number; garbage: number; received: number; invalid: number; created: number; system: number;
  exceptions: number; other_events: number; written: number; duplicate: number; changed: number; unknown_retried: number;
  unknown_dropped: number; expired: number; disagreements: number; connect_attempts: number; connect_failures: number;
  connects: number; closes: number; stale_drops: number; subscribe_timeouts: number; subscribe_confirmed: number;
  connected_ms: number; down_ms: number; max_down_ms: number; write_errors: number; queue_errors: number; runs_dropped: number;
}
const zeroCounters = (): Counters => ({
  frames: 0, pings: 0, garbage: 0, received: 0, invalid: 0, created: 0, system: 0, exceptions: 0, other_events: 0, written: 0,
  duplicate: 0, changed: 0, unknown_retried: 0, unknown_dropped: 0, expired: 0, disagreements: 0, connect_attempts: 0,
  connect_failures: 0, connects: 0, closes: 0, stale_drops: 0, subscribe_timeouts: 0, subscribe_confirmed: 0, connected_ms: 0,
  down_ms: 0, max_down_ms: 0, write_errors: 0, queue_errors: 0, runs_dropped: 0,
});

export interface LoopRow {
  loop_name: string; started_at: string; outcome: "success" | "failure" | "no_op"; rows_written: number; duration_ms: number;
  error: string | null; meta: Record<string, unknown>;
}

export interface ListenerState {
  /** Start of the current outage: no connection that has been subscribed for STABLE_MS. Null while stable. */
  down_since: number | null;
  attempts: number;
  next_connect_at: number;
  last_alive_at: number | null;
  last_close: { at: string; code: number | null; reason: string } | null;
  last_error: string | null;
  /** The down_since the outage alert went out for (one alert per outage). */
  alerted_down_since: number | null;
  recovered: { down_since: string; down_ms: number } | null;
  write_failures: number;
  write_error: string | null;
  schema_drift: string | null;
  disagreements: string[];
  /** Slugs the cross-check (or the flush) already compared with the poll -> when; pruned after CHECKED_KEEP_MS. */
  checked: Record<string, number>;
  last_cross_check_at: number;
  /** Time accounting: connected_ms / down_ms are counted up to here. */
  acct_at: number;
  day: string;
  counters: Counters;
  dropped_sample: string[];
  pending_runs: LoopRow[];
}

/** Pure. The state a new instance starts from: a fresh one, or the stored one with no connection (there is none yet). */
export function restoreState(saved: Partial<ListenerState> | undefined, now: number): ListenerState {
  const fresh: ListenerState = {
    down_since: now, attempts: 0, next_connect_at: 0, last_alive_at: null, last_close: null, last_error: null,
    alerted_down_since: null, recovered: null, write_failures: 0, write_error: null, schema_drift: null, disagreements: [],
    checked: {}, last_cross_check_at: 0, acct_at: now, day: utcDay(now), counters: zeroCounters(), dropped_sample: [], pending_runs: [],
  };
  if (!saved || typeof saved !== "object") return fresh;
  const s: ListenerState = { ...fresh, ...saved, counters: { ...zeroCounters(), ...(saved.counters ?? {}) } };
  // A new instance has no socket: it has been down since it was last seen alive (an eviction or a deploy).
  if (s.down_since === null) s.down_since = s.last_alive_at ?? now;
  if (!Number.isFinite(s.acct_at) || s.acct_at > now) s.acct_at = now;
  return s;
}

/** Pure. The day summary's outcome: a failure when the day had an outage of 15 min or more or a failed write. */
export function daySummaryRow(s: ListenerState, now: number): LoopRow {
  const c = s.counters;
  const ongoing = s.down_since !== null ? now - s.down_since : 0;
  const maxDown = Math.max(c.max_down_ms, ongoing);
  const reasons: string[] = [];
  if (maxDown >= DOWN_ALERT_MS) reasons.push(`disconnected for up to ${Math.round(maxDown / 60_000)} min`);
  if (c.write_errors) reasons.push(`${c.write_errors} failed database flush(es)`);
  const rows = c.written + c.changed;
  return {
    loop_name: LOOP_NAME, started_at: iso(now), outcome: reasons.length ? "failure" : rows > 0 ? "success" : "no_op", rows_written: rows,
    duration_ms: 0, error: reasons.length ? reasons.join("; ") : null,
    meta: { kind: "day", day: s.day, ...c, max_down_ms: maxDown, dropped_sample: s.dropped_sample },
  };
}

// ---- the Durable Object ---------------------------------------------------------------------------------------------

type Phase = "idle" | "connecting" | "engine" | "namespace" | "open";

export class LimitlessListener {
  private s!: ListenerState;
  private readonly ready: Promise<void>;
  private sock: WebSocket | null = null;
  private phase: Phase = "idle";
  private connecting: Promise<void> | null = null;
  private connectedAt = 0;
  private lastPingAt = 0;
  private pingIntervalMs = DEFAULT_PING_INTERVAL_MS;
  private pingTimeoutMs = DEFAULT_PING_TIMEOUT_MS;
  private subscribed = false;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.s = restoreState(await ctx.storage.get<ListenerState>(STATE_KEY), Date.now());
    });
  }

  /**
   * Only the one named instance ever connects. Where the runtime exposes the id's name inside the object, any other name
   * is refused; where it does not (name undefined), pingListener() is still the only code that makes a stub.
   */
  private get isTheOne(): boolean { const n = this.ctx.id.name; return n === undefined || n === LISTENER_NAME; }

  /** POST /ensure: the every-minute cron's ping. GET /status: the same snapshot without side effects. */
  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const path = new URL(request.url).pathname;
    if (!this.isTheOne) return Response.json({ error: `only the instance named ${LISTENER_NAME} runs` }, { status: 409 });
    if (path === "/status") return Response.json(this.status(Date.now()));
    if (path !== "/ensure") return Response.json({ error: "not found" }, { status: 404 });
    if (await this.switchedOff()) return Response.json({ ...this.status(Date.now()), phase: "disabled" });
    await this.tick(Date.now());
    await this.arm(Date.now(), false);
    return Response.json(this.status(Date.now()));
  }

  async alarm(): Promise<void> {
    await this.ready;
    if (!this.isTheOne) return; // never re-armed: a stray instance goes quiet
    if (await this.switchedOff()) return;
    try {
      const now = Date.now();
      this.rollDay(now);
      await this.tick(now);
      await this.flush(Date.now());
      await this.crossCheckDue(Date.now());
      const alerts = this.alertsDue(Date.now());
      await this.writeRuns();
      if (alerts.length) {
        const r = await alertMany(this.env, alerts);
        // Disagreements stay pending until an alert actually goes out, so one found inside the dedup window is not lost.
        if (r.sent.includes(DISAGREE_KEY)) {
          const sent = new Set((alerts.find((a) => a.key === DISAGREE_KEY)?.meta?.slugs as string[] | undefined) ?? []);
          this.s.disagreements = this.s.disagreements.filter((x) => !sent.has(x));
        }
      }
    } catch (e) {
      console.error(JSON.stringify({ level: "error", job: LOOP_NAME, error: redact(String(e)).slice(0, 300) }));
    } finally {
      await this.save().catch(() => {});
      await this.arm(Date.now(), true).catch(() => {});
    }
  }

  /**
   * Switched off: close the socket, clear the alarm, keep the queue and the counters, and forget the outage clock, so
   * switching back on starts it at that moment instead of alerting the whole off period as an outage (true = off).
   */
  private async switchedOff(): Promise<boolean> {
    if (listenerEnabled(this.env)) return false;
    const sock = this.sock;
    this.sock = null;
    this.phase = "idle";
    this.subscribed = false;
    if (sock) try { sock.close(1000, "switched off"); } catch { /* already closing */ }
    const s = this.s, now = Date.now();
    this.account(now);
    s.down_since = null; s.alerted_down_since = null; s.last_alive_at = null; s.recovered = null; s.attempts = 0; s.next_connect_at = 0;
    await this.save().catch(() => {});
    await this.ctx.storage.deleteAlarm();
    return true;
  }

  /** The liveness step both entry points share: account time, drop a dead socket, end a stable outage, reconnect when due. */
  private async tick(now: number): Promise<void> {
    this.account(now);
    this.checkHealth(now);
    this.settle(now);
    if (!this.sock && now >= this.s.next_connect_at) await this.connect();
  }

  // ---- connection ---------------------------------------------------------------------------------------------------

  private connect(): Promise<void> {
    if (this.sock) return Promise.resolve();
    this.connecting ??= this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async open(): Promise<void> {
    this.s.counters.connect_attempts++;
    this.phase = "connecting";
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`no upgrade within ${CONNECT_TIMEOUT_MS} ms`)), CONNECT_TIMEOUT_MS);
    let ws: WebSocket | null = null;
    try {
      const res = await fetch(WS_URL, { headers: { Upgrade: "websocket", "User-Agent": botUa(this.env) }, signal: ac.signal });
      ws = res.webSocket ?? null;
      if (!ws) throw new Error(`upgrade refused: HTTP ${res.status}`);
      ws.accept();
    } catch (e) {
      this.s.counters.connect_failures++;
      this.s.last_error = redact(e instanceof Error ? e.message : String(e)).slice(0, 200);
      this.down(Date.now(), null, `connect failed: ${this.s.last_error}`, false);
      return;
    } finally {
      clearTimeout(timer);
    }
    const sock = ws;
    this.sock = sock;
    this.phase = "engine";
    this.subscribed = false;
    this.lastPingAt = Date.now(); // the handshake gets the same two intervals as a ping
    this.pingIntervalMs = DEFAULT_PING_INTERVAL_MS;
    this.pingTimeoutMs = DEFAULT_PING_TIMEOUT_MS;
    sock.addEventListener("message", (ev) => this.onFrame(sock, ev.data));
    sock.addEventListener("close", (ev) => this.gone(sock, ev.code ?? null, `closed by the server${ev.reason ? `: ${ev.reason}` : ""}`));
    sock.addEventListener("error", (ev) => this.gone(sock, null, `socket error${(ev as { message?: string }).message ? `: ${(ev as { message?: string }).message}` : ""}`));
  }

  private send(frame: string): void {
    try { this.sock?.send(frame); } catch (e) { this.drop(`send failed: ${String(e)}`); }
  }

  /** Close our socket on purpose (stale, protocol close) and schedule the reconnect. */
  private drop(reason: string): void {
    const sock = this.sock;
    if (!sock) return;
    this.sock = null;
    try { sock.close(1000, reason.slice(0, 100)); } catch { /* already closing */ }
    this.down(Date.now(), null, reason, true);
  }

  /** The socket closed or failed under us. Events from a socket we already replaced are ignored. */
  private gone(sock: WebSocket, code: number | null, reason: string): void {
    if (sock !== this.sock) return;
    this.sock = null;
    this.down(Date.now(), code, reason, true);
  }

  private down(now: number, code: number | null, reason: string, wasSocket: boolean): void {
    this.account(now);
    const uptime = this.phase === "open" ? now - this.connectedAt : 0;
    this.phase = "idle";
    this.subscribed = false;
    const s = this.s;
    s.attempts = (uptime >= STABLE_MS ? 0 : s.attempts) + 1;
    s.down_since ??= now;
    s.next_connect_at = now + backoffMs(s.attempts, Math.random());
    s.last_close = { at: iso(now), code, reason: redact(reason).slice(0, 200) };
    if (wasSocket) s.counters.closes++;
    void this.save().then(() => this.arm(Date.now(), false)).catch(() => {});
  }

  /** A socket with no server ping for pingInterval + pingTimeout, or never confirmed subscribed, is dropped and reconnected. */
  private checkHealth(now: number): void {
    if (!this.sock) return;
    const limit = this.pingIntervalMs + this.pingTimeoutMs;
    const quiet = now - this.lastPingAt;
    if (quiet > limit) {
      this.s.counters.stale_drops++;
      this.drop(`stale: no server ping for ${Math.round(quiet / 1000)} s (limit ${limit / 1000} s) in phase ${this.phase}`);
      return;
    }
    if (this.phase === "open" && !this.subscribed && now - this.connectedAt > SUBSCRIBE_TIMEOUT_MS) {
      this.s.counters.subscribe_timeouts++;
      this.drop(`no lifecycle subscription confirmed ${Math.round((now - this.connectedAt) / 1000)} s after the namespace ack`);
    }
  }

  /** A connection subscribed for STABLE_MS ends the outage (it ended when that connection opened) and resets the backoff. */
  private settle(now: number): void {
    if (this.phase !== "open" || !this.subscribed) return;
    const s = this.s;
    s.last_alive_at = now;
    if (now - this.connectedAt < STABLE_MS) return;
    s.attempts = 0;
    if (s.down_since === null) return;
    const downMs = Math.max(0, this.connectedAt - s.down_since);
    s.counters.max_down_ms = Math.max(s.counters.max_down_ms, downMs);
    if (s.alerted_down_since !== null) s.recovered = { down_since: iso(s.alerted_down_since), down_ms: downMs };
    s.alerted_down_since = null;
    s.down_since = null;
    s.last_error = null;
  }

  // ---- frames ---------------------------------------------------------------------------------------------------------

  private onFrame(sock: WebSocket, data: unknown): void {
    if (sock !== this.sock) return;
    const now = Date.now();
    const c = this.s.counters;
    c.frames++;
    const f = parseFrame(data);
    switch (f.kind) {
      case "open":
        this.pingIntervalMs = f.pingInterval;
        this.pingTimeoutMs = f.pingTimeout;
        this.lastPingAt = now;
        this.phase = "namespace";
        this.send(namespaceConnect(NAMESPACE));
        return;
      case "ping":
        this.lastPingAt = now;
        c.pings++;
        this.send(pongFrame(f.data));
        return;
      case "pong":
      case "noop":
        return;
      case "close":
        this.drop("the server sent an Engine.IO close packet");
        return;
      case "invalid":
        c.garbage++;
        return;
      case "message":
        this.onPacket(f.packet, now);
        return;
      default: {
        const never: never = f;
        throw new Error(`unhandled frame ${JSON.stringify(never)}`);
      }
    }
  }

  private onPacket(p: SocketPacket, now: number): void {
    if (p.nsp !== NAMESPACE) { this.s.counters.garbage++; return; }
    switch (p.type) {
      case "connect":
        if (this.phase === "namespace") this.connected(now);
        return;
      case "connect_error":
        this.drop(`the server refused ${NAMESPACE}: ${p.message}`);
        return;
      case "disconnect":
        this.drop(`the server disconnected ${NAMESPACE}`);
        return;
      case "ack":
        return;
      case "event":
        if (this.phase === "open") this.onEvent(p.name, p.args, now);
        else this.s.counters.garbage++;
        return;
      default: {
        const never: never = p;
        throw new Error(`unhandled packet ${JSON.stringify(never)}`);
      }
    }
  }

  /** The namespace ack: subscribe, and record the (re)connect. The outage ends only once the connection is stable (settle). */
  private connected(now: number): void {
    this.account(now);
    const s = this.s;
    s.counters.connects++;
    this.phase = "open";
    this.connectedAt = now;
    this.lastPingAt = now;
    this.send(emitFrame(NAMESPACE, SUBSCRIBE_EVENT));
    this.pushRun({
      loop_name: LOOP_NAME, started_at: iso(now), outcome: "success", rows_written: 0, duration_ms: 0, error: null,
      meta: {
        kind: "connected", down_ms: s.down_since !== null ? now - s.down_since : 0, attempts: s.attempts, last_close: s.last_close,
        last_error: s.last_error, ping_interval_ms: this.pingIntervalMs,
      },
    });
    void this.save().catch(() => {});
  }

  private confirmSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.s.counters.subscribe_confirmed++;
  }

  private onEvent(name: string, args: unknown[], now: number): void {
    const c = this.s.counters;
    switch (name) {
      case "marketResolved": {
        this.confirmSubscribed();
        c.received++;
        const ev = parseResolved(args[0], now);
        if ("error" in ev) { c.invalid++; this.s.schema_drift ??= ev.error; return; }
        void this.ctx.storage.put(queueKey(now, ev.slug, ev.resolution_date), ev).catch(() => { c.queue_errors++; });
        return;
      }
      case "marketCreated": this.confirmSubscribed(); c.created++; return;
      case "system": {
        c.system++;
        const m = args[0] && typeof args[0] === "object" ? (args[0] as { message?: unknown }).message : undefined;
        if (typeof m === "string" && /subscribed/i.test(m) && /lifecycle/i.test(m)) this.confirmSubscribed();
        return;
      }
      case "exception": c.exceptions++; return;
      default: c.other_events++;
    }
  }

  // ---- database -------------------------------------------------------------------------------------------------------

  /** Due queue entries -> meta.ws on the rows the poll recorded; stops at the first failed read or write (retried next alarm). */
  private async flush(now: number): Promise<void> {
    const s = this.s;
    let failed: string | null = null;
    let client: ReturnType<typeof db> | null = null;
    for (let b = 0; b < FLUSH_BATCHES_PER_ALARM; b++) {
      const due = await this.ctx.storage.list<QueuedEvent>({ prefix: QUEUE_PREFIX, end: dueBefore(now + 1), limit: FLUSH_BATCH });
      if (!due.size) break;
      const entries = [...due.entries()];
      const slugs = [...new Set(entries.map(([, e]) => e.slug))].filter((x) => SLUG.test(x));
      client ??= db(this.env);
      let known: Map<string, KnownRow>;
      try {
        const { data, error } = await client.from("limitless_markets").select("slug, winning_outcome_index, meta").in("slug", slugs);
        if (error) throw new Error(`read limitless_markets: ${error.message}`);
        known = new Map(((data ?? []) as KnownRow[]).map((r) => [r.slug, r]));
      } catch (e) { failed = redact(String(e)).slice(0, 300); break; }
      const plan = planBatch(entries, known, now);
      if (plan.rows.length) {
        try {
          const { error } = await client.rpc("record_limitless_observations", { p_rows: plan.rows, p_due_limit: 0, p_give_up_days: GIVE_UP_DAYS });
          if (error) throw new Error(`record_limitless_observations: ${error.code ?? ""} ${error.message}`);
        } catch (e) { failed = redact(String(e)).slice(0, 300); break; }
      }
      // The re-keyed entries first, then the old keys: a restart between the two leaves a duplicate, never a loss.
      for (let i = 0; i < plan.requeue.length; i += STORAGE_BATCH) await this.ctx.storage.put(Object.fromEntries(plan.requeue.slice(i, i + STORAGE_BATCH)));
      for (let i = 0; i < plan.remove.length; i += STORAGE_BATCH) await this.ctx.storage.delete(plan.remove.slice(i, i + STORAGE_BATCH));
      const c = s.counters;
      c.written += plan.written; c.duplicate += plan.duplicate; c.changed += plan.changed; c.unknown_retried += plan.unknown_retried;
      c.unknown_dropped += plan.unknown_dropped; c.expired += plan.expired; c.disagreements += plan.disagreements.length;
      for (const slug of plan.dropped_slugs) if (s.dropped_sample.length < DROPPED_SAMPLE_MAX) s.dropped_sample.push(slug);
      for (const slug of plan.disagreements) { this.addDisagreement(slug); s.checked[slug] = now; }
      if (due.size < FLUSH_BATCH) break;
    }
    if (failed) { s.write_failures++; s.write_error = failed; s.counters.write_errors++; }
    else { s.write_failures = 0; s.write_error = null; }
  }

  private addDisagreement(slug: string): void {
    const d = this.s.disagreements;
    if (d.length < 20 && !d.includes(slug)) d.push(slug);
  }

  /** Every CROSS_CHECK_MS: rows the poll resolved in the last day that carry meta.ws, compared once each (crossCheck). */
  private async crossCheckDue(now: number): Promise<void> {
    const s = this.s;
    if (now - s.last_cross_check_at < CROSS_CHECK_MS) return;
    s.last_cross_check_at = now;
    for (const [slug, t] of Object.entries(s.checked)) if (now - t > CHECKED_KEEP_MS) delete s.checked[slug];
    try {
      const { data, error } = await db(this.env).from("limitless_markets")
        .select("slug, winning_outcome_index, last_pending_at, resolved_seen_at, meta")
        .gte("resolved_seen_at", iso(now - CROSS_CHECK_LOOKBACK_MS));
      if (error) throw new Error(error.message);
      const r = crossCheck((data ?? []) as ResolvedRow[], s.checked);
      for (const slug of r.checked) s.checked[slug] = now;
      for (const d of r.disagreements) { this.addDisagreement(d.slug); s.counters.disagreements++; }
      const keys = Object.keys(s.checked);
      for (let i = 0; i < keys.length - CHECKED_MAX; i++) delete s.checked[keys[i]!];
    } catch (e) {
      console.error(JSON.stringify({ level: "error", job: LOOP_NAME, error: `cross-check: ${redact(String(e)).slice(0, 300)}` }));
    }
  }

  private pushRun(row: LoopRow): void {
    const runs = this.s.pending_runs;
    runs.push(row);
    while (runs.length > MAX_PENDING_RUNS) { runs.shift(); this.s.counters.runs_dropped++; }
  }

  /** Pending loop_runs rows in one insert; kept for the next alarm when it fails. */
  private async writeRuns(): Promise<void> {
    const rows = [...this.s.pending_runs]; // a copy: a row pushed while the insert is in flight stays pending
    if (!rows.length) return;
    try {
      const { error } = await db(this.env).from("loop_runs").insert(rows);
      if (error) throw new Error(error.message);
      this.s.pending_runs = this.s.pending_runs.slice(rows.length);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", job: LOOP_NAME, error: `loop_runs insert: ${redact(String(e)).slice(0, 300)}` }));
    }
  }

  // ---- bookkeeping ----------------------------------------------------------------------------------------------------

  /** Wall time since the last call, counted as connected or down. A restarted instance counts its gap as down. */
  private account(now: number): void {
    const d = Math.max(0, now - this.s.acct_at);
    if (this.phase === "open") this.s.counters.connected_ms += d;
    else this.s.counters.down_ms += d;
    this.s.acct_at = now;
  }

  private rollDay(now: number): void {
    const today = utcDay(now);
    if (this.s.day === today) return;
    this.account(now);
    this.pushRun(daySummaryRow(this.s, now));
    this.s.day = today;
    this.s.counters = zeroCounters();
    this.s.dropped_sample = [];
  }

  /** The alerts this alarm raises; each pending one is cleared here (alertMany records and dedups it). */
  private alertsDue(now: number): AlertItem[] {
    const s = this.s;
    const out: AlertItem[] = [];
    if (s.down_since !== null && now - s.down_since >= DOWN_ALERT_MS && s.alerted_down_since !== s.down_since) {
      const mins = Math.round((now - s.down_since) / 60_000);
      out.push({
        key: "limitless_ws_down", dedupMinutes: DOWN_ALERT_DEDUP_MINUTES,
        text: `The Limitless lifecycle websocket has had no stable connection for ${mins} min (since ${iso(s.down_since)}; ${s.attempts} connect attempt(s), last: ${s.last_close?.reason ?? "none"}). Exact resolution times are not being recorded while this lasts; the 10-minute poll recorder still records first sightings. loop_runs where loop_name = '${LOOP_NAME}' has the reconnects.`,
        meta: { down_since: iso(s.down_since), attempts: s.attempts, last_close: s.last_close, last_error: s.last_error },
      });
      this.pushRun({
        loop_name: LOOP_NAME, started_at: iso(now), outcome: "failure", rows_written: 0, duration_ms: 0,
        error: `no stable connection for ${mins} min: ${s.last_close?.reason ?? "no close recorded"}`.slice(0, 500),
        meta: { kind: "down", down_since: iso(s.down_since), attempts: s.attempts, last_close: s.last_close, last_error: s.last_error },
      });
      s.alerted_down_since = s.down_since;
    }
    if (s.recovered) {
      out.push({ key: "limitless_ws_recovered", dedupMinutes: RECOVERED_DEDUP_MINUTES, text: `The Limitless lifecycle websocket is connected again after ${Math.round(s.recovered.down_ms / 60_000)} min (down since ${s.recovered.down_since}).` });
      s.recovered = null;
    }
    if (s.schema_drift) {
      out.push({ key: "limitless_ws_schema", dedupMinutes: SCHEMA_DEDUP_MINUTES, text: `Limitless sent a marketResolved event the listener refuses (${s.schema_drift}); that event is not recorded. src/jobs/limitless-ws.ts parseResolved reads the shape.` });
      s.schema_drift = null;
    }
    if (s.disagreements.length) {
      // Cleared by alarm() only once alertMany says it was sent: one found inside the dedup window waits for the next send.
      out.push({ key: DISAGREE_KEY, dedupMinutes: DISAGREE_DEDUP_MINUTES, text: `The websocket's marketResolved disagrees with the poll's sighting for ${s.disagreements.length} market(s): ${s.disagreements.slice(0, 5).join(", ")} (winningIndex differs from winning_outcome_index, or resolutionDate is outside (last_pending_at, resolved_seen_at]). Both readings are on the row (meta.ws, winning_outcome_index); nothing picks between them.`, meta: { slugs: s.disagreements.slice(0, 20) } });
    }
    if (s.write_failures >= WRITE_FAILING_ALERTS && s.write_failures % WRITE_FAILING_ALERTS === 0) {
      out.push({ key: "limitless_ws_write_failing", dedupMinutes: WRITE_FAILING_DEDUP_MINUTES, text: `The Limitless listener could not write to the database for ${s.write_failures} alarms in a row: ${s.write_error ?? "unknown error"}. Events stay queued in the Durable Object (up to 7 days) and are retried every minute.` });
    }
    return out;
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, this.s);
  }

  /**
   * The next alarm: LIVENESS_ALARM_MS from now, or the reconnect time when that is sooner and there is no socket.
   * force: set it whatever is stored (the alarm handler, whose own alarm just fired); otherwise only move it earlier.
   */
  private async arm(now: number, force: boolean): Promise<void> {
    let at = now + LIVENESS_ALARM_MS;
    if (!this.sock) at = Math.min(at, Math.max(now, this.s.next_connect_at));
    const current = force ? null : await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private status(now: number) {
    const s = this.s;
    return {
      name: LISTENER_NAME, phase: this.phase, subscribed: this.subscribed,
      connected_for_ms: this.phase === "open" ? now - this.connectedAt : null,
      last_ping_age_ms: this.sock ? now - this.lastPingAt : null, ping_interval_ms: this.pingIntervalMs,
      down_since: s.down_since === null ? null : iso(s.down_since), down_for_ms: s.down_since === null ? null : now - s.down_since,
      attempts: s.attempts, next_connect_in_ms: this.sock ? null : Math.max(0, s.next_connect_at - now),
      last_close: s.last_close, last_error: s.last_error, write_failures: s.write_failures, pending_runs: s.pending_runs.length,
      day: s.day, counters: s.counters,
    };
  }
}

// ---- the cron side ----------------------------------------------------------------------------------------------------

/** One Durable Object request from the every-minute invocation (src/jobs/schedule.ts). */
export const LISTENER_PING_SUBREQUESTS = 1;

export interface ListenerPing { ok: boolean; http_status: number; phase: string | null; state: unknown }

/**
 * The every-minute cron's ping: creates the one instance on the first deploy and wakes it after an eviction or a deploy
 * (its alarm does too; this is the second way in). Throws when the binding is missing, so the scheduler alerts it.
 */
export async function pingListener(env: Env): Promise<ListenerPing> {
  if (!listenerEnabled(env)) return { ok: true, http_status: 0, phase: "disabled", state: null };
  const ns = env.LIMITLESS_WS;
  if (!ns) throw new Error("the LIMITLESS_WS Durable Object binding is missing (wrangler.toml [[durable_objects.bindings]])");
  const stub = ns.get(ns.idFromName(LISTENER_NAME), { locationHint: LOCATION_HINT });
  const res = await stub.fetch("https://limitless-listener.internal/ensure", { method: "POST" });
  let state: unknown = null;
  try { state = await res.json(); } catch { /* a non-JSON answer: the status says enough */ }
  const phase = state && typeof state === "object" && typeof (state as { phase?: unknown }).phase === "string" ? (state as { phase: string }).phase : null;
  return { ok: res.ok, http_status: res.status, phase, state };
}

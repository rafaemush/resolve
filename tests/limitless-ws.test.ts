/**
 * Limitless lifecycle listener (src/jobs/limitless-ws.ts, src/jobs/limitless-ws-protocol.ts): the Engine.IO / Socket.IO
 * framing (open, namespace ack, event frames, ping/pong, garbage never throws), marketResolved -> the meta-only write
 * through record_limitless_observations, and the Durable Object's liveness against a scripted websocket, an in-memory
 * storage/alarm and the in-memory database: reconnect with backoff, stale and unsubscribed sockets dropped, the alarm
 * and the cron ping restarting an evicted object, one alert after 15 min without a stable connection, and loop_runs rows
 * per reconnect and per day, never per message.
 * The frames are shaped like the read-only capture of 2026-09-28 (private/limitless-ws/); slugs and titles here are
 * synthetic. The SQL side of the meta-only merge is asserted on Postgres by scripts/selftest/recorder.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, rpcError: null as string | null, selectError: null as string | null }));
vi.mock("../src/db/supabase", () => ({
  db: () => ({
    ...h.db.client,
    from: (t: string) => {
      const q = h.db.client.from(t);
      if (t !== "limitless_markets" || !h.selectError) return q;
      return new Proxy(q, { get: (o, k) => (k === "in" ? () => Promise.resolve({ data: null, error: { message: h.selectError } }) : Reflect.get(o, k)) });
    },
  }),
}));
vi.mock("../src/ops/alerts", () => ({
  alert: vi.fn(async () => ({ sent: true, deduped: false })),
  alertMany: vi.fn(async (_env: unknown, items: Array<{ key: string }>) => ({ sent: items.map((i) => i.key), deduped: [] })),
}));

import {
  backoffMs, crossCheck, daySummaryRow, LOCATION_HINT, metaOnlyObservation, parseResolved, pingListener, planBatch, queueKey, restoreState,
  listenerEnabled, LimitlessListener, BACKOFF_MAX_MS, DOWN_ALERT_DEDUP_MINUTES, DOWN_ALERT_MS, LISTENER_NAME, LISTENER_PING_SUBREQUESTS, LIVENESS_ALARM_MS,
  LOOP_NAME, MAX_EVENT_AGE_MS, QUEUE_PREFIX, STABLE_MS, STATE_KEY, SUBSCRIBE_EVENT, SUBSCRIBE_TIMEOUT_MS, UNKNOWN_RETRY_MS, WS_URL,
  type KnownRow, type ListenerState, type QueuedEvent,
} from "../src/jobs/limitless-ws";
import { emitFrame, namespaceConnect, parseFrame, parsePacket, pongFrame } from "../src/jobs/limitless-ws-protocol";
import { GIVE_UP_DAYS } from "../src/jobs/limitless-recorder";
import { alertMany } from "../src/ops/alerts";
import { RESOLVE_BOT_UA } from "../src/ops/ua";

// ---- frames shaped like the 2026-09-28 capture (synthetic ids, slugs and titles) --------------------------------------
const OPEN = '0{"sid":"AAAAAAAAAAAAAAAAAAAA","upgrades":[],"pingInterval":25000,"pingTimeout":60000,"maxPayload":1000000}';
const NS_ACK = '40/markets,{"sid":"BBBBBBBBBBBBBBBBBBBB"}';
const REGISTERED = '42/markets,["system",{"message":"Successfully registered connection"}]';
const SUBSCRIBED = '42/markets,["system",{"message":"Subscribed to market lifecycle events"}]';
const created = (slug: string) => `42/markets,${JSON.stringify(["marketCreated", { slug, title: "(synthetic)", type: "CLOB", categoryIds: [1, 2], createdAt: "2026-09-28T10:00:00.000Z" }])}`;
const resolvedFrame = (slug: string, winningIndex: number, resolutionDate: string, extra: Record<string, unknown> = {}) =>
  `42/markets,${JSON.stringify(["marketResolved", { slug, type: "CLOB", winningOutcome: winningIndex === 0 ? "YES" : "NO", winningIndex, resolutionDate, ...extra }])}`;

// ---- the stand-ins ---------------------------------------------------------------------------------------------------
class FakeSocket {
  sent: string[] = [];
  accepted = false;
  closedBy: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Array<(ev: any) => void>>();
  accept() { this.accepted = true; }
  send(d: string) { if (this.closedBy) throw new Error("socket closed"); this.sent.push(d); }
  close(code?: number, reason?: string) { this.closedBy = { code, reason }; }
  addEventListener(t: string, f: (ev: any) => void) { const l = this.listeners.get(t) ?? []; l.push(f); this.listeners.set(t, l); }
  recv(data: unknown) { for (const f of this.listeners.get("message") ?? []) f({ data }); }
  serverClose(code = 1006, reason = "") { for (const f of this.listeners.get("close") ?? []) f({ code, reason }); }
  /** The capture's handshake, answered by the server. */
  handshake(opts: { subscribed?: boolean } = {}) {
    this.recv(OPEN); this.recv(NS_ACK); this.recv(REGISTERED);
    if (opts.subscribed !== false) this.recv(SUBSCRIBED);
  }
}

function fakeStorage(initial: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  const st = {
    map, alarm: null as number | null,
    async get<T>(k: string): Promise<T | undefined> { return structuredClone(map.get(k)) as T | undefined; },
    async put(k: string | Record<string, unknown>, v?: unknown) {
      if (typeof k === "string") map.set(k, structuredClone(v)); else for (const [a, b] of Object.entries(k)) map.set(a, structuredClone(b));
    },
    async delete(k: string | string[]) { let n = 0; for (const x of Array.isArray(k) ? k : [k]) if (map.delete(x)) n++; return Array.isArray(k) ? n : n > 0; },
    async list<T>(o: { prefix?: string; end?: string; limit?: number } = {}): Promise<Map<string, T>> {
      const keys = [...map.keys()].filter((k) => (!o.prefix || k.startsWith(o.prefix)) && (!o.end || k < o.end)).sort();
      return new Map(keys.slice(0, o.limit ?? keys.length).map((k) => [k, structuredClone(map.get(k)) as T]));
    },
    async getAlarm() { return st.alarm; },
    async setAlarm(at: number) { st.alarm = at; },
    async deleteAlarm() { st.alarm = null; },
  };
  return st;
}
type Storage = ReturnType<typeof fakeStorage>;

const env = { SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k", RESOLVE_BOT_UA, LIMITLESS_WS_ENABLED: "1" } as unknown as Env;
const T0 = Date.parse("2026-09-28T10:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));
const S1 = "synthetic-weekly-market-1";

let sockets: FakeSocket[];
let fetches: Array<{ url: string; headers: Record<string, string> }>;
/** What the next connect attempts get: "ok" a socket, "refuse" HTTP 503 without one, "throw" a network error. */
let upgrade: Array<"ok" | "refuse" | "throw">;
let rpcCalls: Array<Record<string, any>>;

function makeDb(rows: Row[] = []) {
  rpcCalls = [];
  h.db = fakeDb({ limitless_markets: rows, loop_runs: [] }, {}, {
    rpc: {
      // record_limitless_observations for the listener's rows: an unknown slug would be inserted (the test fails on it);
      // a known one merges meta (meta = t.meta || excluded.meta) and nothing else, as the SQL does for observed = false.
      record_limitless_observations: async (db, a) => {
        rpcCalls.push(a);
        if (h.rpcError) return { data: null, error: { code: "57P01", message: h.rpcError } };
        const t = db.tables.limitless_markets!;
        let inserted = 0, updated = 0;
        for (const r of a.p_rows as Array<Record<string, any>>) {
          // In the SQL, coalesce(excluded.x, t.x) would overwrite any non-null column: the listener may send nothing but meta.
          for (const [k, v] of Object.entries(r)) {
            if (k === "slug" || k === "meta") continue;
            if (v !== null && v !== false) throw new Error(`the listener sent ${k} = ${JSON.stringify(v)}; only meta may move`);
          }
          const ex = t.find((x) => x.slug === r.slug);
          if (!ex) { inserted++; t.push({ slug: r.slug, meta: r.meta }); continue; }
          updated++;
          ex.meta = { ...ex.meta, ...r.meta };
        }
        return { data: { inserted, updated, newly_expired: 0, newly_resolved: 0, groups_missing_legs: [], due: [] }, error: null };
      },
    },
  });
}

function make(storage: Storage = fakeStorage(), name: string | undefined = LISTENER_NAME, e: Env = env) {
  const ctx = { id: { name }, storage, blockConcurrencyWhile: async (f: () => Promise<void>) => f() };
  return { obj: new LimitlessListener(ctx as unknown as DurableObjectState, e), storage };
}
const ensure = async (obj: LimitlessListener) => (await obj.fetch(new Request("https://limitless-listener.internal/ensure", { method: "POST" }))).json() as Promise<Record<string, any>>;
const status = async (obj: LimitlessListener) => (await obj.fetch(new Request("https://limitless-listener.internal/status"))).json() as Promise<Record<string, any>>;
/** Move the clock to `ms` and run the alarm, as the runtime would when it fires. */
async function alarmAt(obj: LimitlessListener, ms: number) { vi.setSystemTime(ms); await obj.alarm(); await flushMicrotasks(); }
const saved = (st: Storage) => st.map.get(STATE_KEY) as ListenerState;
const queue = (st: Storage) => [...st.map.keys()].filter((k) => k.startsWith(QUEUE_PREFIX)).sort();
const alertKeys = () => vi.mocked(alertMany).mock.calls.flatMap((c) => c[1].map((i) => [i.key, i.dedupMinutes]));
const runs = () => (h.db.tables.loop_runs ?? []) as Array<Record<string, any>>;
/** A server ping at `ms`: what keeps a live connection from being dropped as stale by the next alarm. */
const pingAt = (sock: FakeSocket, ms: number) => { vi.setSystemTime(ms); sock.recv("2"); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.mocked(alertMany).mockReset();
  vi.mocked(alertMany).mockImplementation(async (_env, items) => ({ sent: items.map((i) => i.key), deduped: [] }));
  h.rpcError = null; h.selectError = null;
  sockets = []; fetches = []; upgrade = [];
  makeDb();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    fetches.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    const mode = upgrade.shift() ?? "ok";
    if (mode === "throw") throw new Error("network connection lost");
    if (mode === "refuse") return { status: 503, webSocket: null } as unknown as Response;
    const s = new FakeSocket();
    sockets.push(s);
    return { status: 101, webSocket: s } as unknown as Response;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// =====================================================================================================================
describe("Engine.IO / Socket.IO framing (pure)", () => {
  it("the open packet: sid and the timers the server announced", () => {
    expect(parseFrame(OPEN)).toEqual({ kind: "open", sid: "AAAAAAAAAAAAAAAAAAAA", pingInterval: 25000, pingTimeout: 60000 });
    expect(parseFrame('0{"upgrades":[],"pingInterval":25000,"pingTimeout":60000}')).toMatchObject({ kind: "invalid" });
    expect(parseFrame('0{"sid":"x","pingInterval":25,"pingTimeout":60000}')).toMatchObject({ kind: "invalid" }); // seconds, not ms
    expect(parseFrame("0not json")).toMatchObject({ kind: "invalid" });
  });

  it("the namespace ack, a disconnect and a refusal", () => {
    expect(parseFrame(NS_ACK)).toEqual({ kind: "message", packet: { type: "connect", nsp: "/markets", sid: "BBBBBBBBBBBBBBBBBBBB" } });
    expect(parseFrame("40")).toEqual({ kind: "message", packet: { type: "connect", nsp: "/", sid: null } });
    expect(parseFrame("41/markets,")).toEqual({ kind: "message", packet: { type: "disconnect", nsp: "/markets" } });
    expect(parseFrame('44/markets,{"message":"Not authorized"}')).toEqual({ kind: "message", packet: { type: "connect_error", nsp: "/markets", message: "Not authorized" } });
  });

  it("event frames: name, args, an ack id when present; an ack", () => {
    const date = "2026-09-28T09:58:02.774Z";
    expect(parseFrame(resolvedFrame("s-1", 1, date))).toEqual({
      kind: "message",
      packet: { type: "event", nsp: "/markets", id: null, name: "marketResolved", args: [{ slug: "s-1", type: "CLOB", winningOutcome: "NO", winningIndex: 1, resolutionDate: date }] },
    });
    expect(parseFrame(SUBSCRIBED)).toMatchObject({ kind: "message", packet: { type: "event", name: "system", args: [{ message: "Subscribed to market lifecycle events" }] } });
    expect(parsePacket('2/markets,12["x",1]')).toEqual({ type: "event", nsp: "/markets", id: 12, name: "x", args: [1] });
    expect(parsePacket('3/markets,12[{"ok":true}]')).toEqual({ type: "ack", nsp: "/markets", id: 12, args: [{ ok: true }] });
    expect(parsePacket('2["root-namespace"]')).toEqual({ type: "event", nsp: "/", id: null, name: "root-namespace", args: [] });
  });

  it("ping and pong: the server pings, the client answers 3 with the same data", () => {
    expect(parseFrame("2")).toEqual({ kind: "ping", data: "" });
    expect(parseFrame("2probe")).toEqual({ kind: "ping", data: "probe" });
    expect(parseFrame("3")).toEqual({ kind: "pong", data: "" });
    expect(parseFrame("6")).toEqual({ kind: "noop" });
    expect(parseFrame("1")).toEqual({ kind: "close" });
    expect(pongFrame()).toBe("3");
    expect(pongFrame("probe")).toBe("3probe");
  });

  it("what the client sends: the namespace connect and the subscribe emit, exactly as in the capture", () => {
    expect(namespaceConnect("/markets")).toBe("40/markets,");
    expect(emitFrame("/markets", SUBSCRIBE_EVENT)).toBe('42/markets,["subscribe_market_lifecycle"]');
    expect(emitFrame("/markets", "x", { a: 1 })).toBe('42/markets,["x",{"a":1}]');
  });

  it("garbage is an invalid frame with a reason, never an exception", () => {
    const junk: unknown[] = [
      new ArrayBuffer(8), new Uint8Array([52, 50]), null, undefined, 42, {}, "", "9", "5", "4", "4{", "4x", "45/markets,1-[]", "46/markets,[]",
      "42/markets,notjson", "42/markets,{}", '42/markets,[1,2]', "42/markets,[]", '43/markets,["no id"]', "42/markets,1234567890123456[\"x\"]",
      "0", "0[]", '0{"sid":""}', "\u0000\u0001", "42/markets", "4/markets,",
    ];
    for (const j of junk) {
      const f = parseFrame(j);
      if (j === "4/markets,") { expect(f).toMatchObject({ kind: "invalid" }); continue; }
      expect(f.kind, JSON.stringify(String(j))).toBe("invalid");
      expect((f as { reason: string }).reason.length).toBeGreaterThan(0);
    }
    // random strings: parsed or refused, never thrown
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const alphabet = '0123456789/markets,[]{}":';
    for (let n = 0; n < 2000; n++) {
      const s = Array.from({ length: 1 + Math.floor(rnd() * 30) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
      expect(() => parseFrame(s)).not.toThrow();
    }
  });
});

// =====================================================================================================================
describe("marketResolved payload, backoff and the flush plan (pure)", () => {
  const date = "2026-09-28T09:58:02.774Z";

  it("parseResolved keeps the exact resolutionDate (normalized ISO), the index and the outcome", () => {
    expect(parseResolved({ slug: S1, type: "CLOB", winningOutcome: "NO", winningIndex: 1, resolutionDate: date }, T0)).toEqual({
      slug: S1, resolution_date: date, winning_index: 1, winning_outcome: "NO", trade_type: "clob", received_at: at(T0), source: "limitless_ws", tries: 0,
    });
    expect(parseResolved({ slug: S1, resolutionDate: "2026-09-28T09:58:02Z" }, T0)).toMatchObject({ resolution_date: "2026-09-28T09:58:02.000Z", winning_index: null, trade_type: null });
  });

  it("parseResolved refuses a drifted shape instead of storing a wrong date or slug", () => {
    for (const bad of [
      null, [], {}, { slug: S1 }, { slug: "../x", resolutionDate: date }, { slug: S1, resolutionDate: 1790549100 },
      { slug: S1, resolutionDate: "yesterday" }, { slug: S1, resolutionDate: "1999-01-01T00:00:00Z" },
      { slug: S1, resolutionDate: at(T0 + 10 * 60_000) }, { slug: S1, resolutionDate: date, winningIndex: 0.5 }, { slug: S1, resolutionDate: date, winningIndex: -1 },
    ]) expect(parseResolved(bad, T0)).toHaveProperty("error");
  });

  it("backoff: 1 s doubling to 60 s, the upper half jittered", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 50].map((n) => backoffMs(n, 0))).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect([1, 2, 7, 50].map((n) => backoffMs(n, 1))).toEqual([1000, 2000, 60000, 60000]);
    for (let n = 1; n < 100; n++) expect(backoffMs(n, 0.999)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
  });

  it("queue keys sort by due time, so the earliest due is listed first", () => {
    const keys = [queueKey(T0 + 1000, "b", date), queueKey(T0, "z", date), queueKey(T0 + UNKNOWN_RETRY_MS[0] + 1, "a", date)];
    expect([...keys].sort()).toEqual([keys[1], keys[0], keys[2]]);
  });

  it("planBatch: first event -> meta.ws, same again -> duplicate, different -> meta.ws_latest; unknown -> retried once then dropped", () => {
    const ev = (slug: string, idx: number, d = date, tries = 0): QueuedEvent => ({ ...(parseResolved({ slug, type: "CLOB", winningIndex: idx, winningOutcome: idx ? "NO" : "YES", resolutionDate: d }, T0) as QueuedEvent), tries });
    const known = new Map<string, KnownRow>([
      ["k1", { slug: "k1", winning_outcome_index: null, meta: {} }],
      ["k2", { slug: "k2", winning_outcome_index: 0, meta: { ws: { resolution_date: date, winning_index: 1 } } }],
    ]);
    const p = planBatch([
      ["q1", ev("k1", 1)], ["q2", ev("k1", 1)], ["q3", ev("k1", 0, "2026-09-28T09:59:00.000Z")],
      ["q4", ev("k2", 1)], ["q5", ev("u1", 1)], ["q6", ev("u2", 1, date, 1)], ["q7", ev("u3", 1, date, 2)],
      ["q8", { ...ev("k1", 1), received_at: at(T0 - MAX_EVENT_AGE_MS - 1) }],
    ], known, T0);
    expect(p).toMatchObject({ written: 1, duplicate: 2, changed: 1, unknown_retried: 1, unknown_dropped: 2, expired: 1, dropped_slugs: ["u2", "u3"], disagreements: [] });
    expect(p.remove).toEqual(["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"]);
    expect(p.requeue.map(([k, e]) => [k, e.slug, e.tries])).toEqual([
      [queueKey(T0 + UNKNOWN_RETRY_MS[0], "u1", date), "u1", 1],
    ]);
    expect(UNKNOWN_RETRY_MS).toEqual([2 * 60_000]);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toEqual(metaOnlyObservation("k1", {
      ws: { resolution_date: date, winning_index: 1, winning_outcome: "NO", trade_type: "clob", received_at: at(T0), source: "limitless_ws" },
      ws_latest: { resolution_date: "2026-09-28T09:59:00.000Z", winning_index: 0, winning_outcome: "YES", trade_type: "clob", received_at: at(T0), source: "limitless_ws" },
    }));
  });

  it("planBatch: the poll's index rides along as poll_index, and a websocket index that differs is flagged", () => {
    const known = new Map<string, KnownRow>([["k", { slug: "k", winning_outcome_index: 0, meta: {} }]]);
    const p = planBatch([["q", parseResolved({ slug: "k", winningIndex: 1, resolutionDate: date }, T0) as QueuedEvent]], known, T0);
    expect(p.rows[0]!.meta.ws).toMatchObject({ winning_index: 1, poll_index: 0 });
    expect(p.disagreements).toEqual(["k"]);
  });

  it("the meta-only observation moves nothing but meta in record_limitless_observations", () => {
    expect(metaOnlyObservation("k", { ws: {} })).toEqual({
      slug: "k", group_slug: null, container: false, condition_id: null, category: null, trade_type: null, automation_type: null,
      market_type: null, expiration_at: null, platform_created_at: null, observed: false, observed_at: null, checked: false,
      expired: false, winning_outcome_index: null, void: false, meta: { ws: {} },
    });
  });

  it("restoreState: a new instance is down since it was last seen alive; the day summary fails on a 15-min outage", () => {
    const s = restoreState({ down_since: null, last_alive_at: T0 - 40_000 } as Partial<ListenerState>, T0);
    expect(s.down_since).toBe(T0 - 40_000);
    expect(restoreState(undefined, T0).down_since).toBe(T0);
    const row = daySummaryRow({ ...s, down_since: T0 - DOWN_ALERT_MS }, T0);
    expect(row).toMatchObject({ loop_name: LOOP_NAME, outcome: "failure", meta: { kind: "day", max_down_ms: DOWN_ALERT_MS } });
    expect(daySummaryRow({ ...s, down_since: null }, T0)).toMatchObject({ outcome: "no_op", error: null });
  });
});

// =====================================================================================================================
describe("LimitlessListener (the Durable Object)", () => {
  it("the cron ping opens the socket with fetch + Upgrade: websocket and speaks the captured handshake", async () => {
    const { obj, storage } = make();
    const first = await ensure(obj);
    expect(fetches).toEqual([{ url: WS_URL, headers: { Upgrade: "websocket", "User-Agent": RESOLVE_BOT_UA } }]);
    expect(first.phase).toBe("engine");
    const sock = sockets[0]!;
    expect(sock.accepted).toBe(true);
    sock.handshake();
    expect(sock.sent).toEqual(["40/markets,", '42/markets,["subscribe_market_lifecycle"]']);
    expect(await status(obj)).toMatchObject({ phase: "open", subscribed: true, ping_interval_ms: 25000 });
    expect(storage.alarm).toBe(T0 + LIVENESS_ALARM_MS);
    // a second ping while connected does not open a second socket
    await ensure(obj);
    expect(fetches).toHaveLength(1);
  });

  it("answers every server ping with a pong, and a pinged connection outlives the stale limit", async () => {
    const { obj } = make();
    await ensure(obj);
    const sock = sockets[0]!;
    sock.handshake();
    for (let i = 1; i <= 12; i++) { vi.setSystemTime(T0 + i * 25_000); sock.recv("2"); }
    expect(sock.sent.filter((f) => f === "3")).toHaveLength(12);
    await alarmAt(obj, T0 + 12 * 25_000 + 1000);
    expect(sock.closedBy).toBeNull();
    expect(await status(obj)).toMatchObject({ phase: "open", counters: { pings: 12, stale_drops: 0 } });
  });

  it("marketResolved -> meta.ws on the poll's row through record_limitless_observations, meta only, then the queue is empty", async () => {
    const pollRow = { slug: S1, winning_outcome_index: null, resolved_seen_at: null, last_pending_at: at(T0 - 600_000), check_attempts: 3, meta: { status: "LOCKED", categories: ["Economy"] } };
    makeDb([structuredClone(pollRow)]);
    const { obj, storage } = make();
    await ensure(obj);
    const sock = sockets[0]!;
    sock.handshake();
    const date = at(T0 - 200);
    sock.recv(resolvedFrame(S1, 1, date));
    await flushMicrotasks();
    expect(queue(storage)).toEqual([queueKey(T0, S1, date)]);
    expect(rpcCalls).toEqual([]); // nothing reaches the database per message

    pingAt(sock, T0 + 25_000);
    await alarmAt(obj, T0 + LIVENESS_ALARM_MS);
    expect(sock.closedBy).toBeNull();
    const ws = { resolution_date: date, winning_index: 1, winning_outcome: "NO", trade_type: "clob", received_at: at(T0), source: "limitless_ws" };
    expect(rpcCalls).toEqual([{ p_rows: [metaOnlyObservation(S1, { ws })], p_due_limit: 0, p_give_up_days: GIVE_UP_DAYS }]);
    const row = h.db.tables.limitless_markets!.find((r) => r.slug === S1)!;
    expect(row).toEqual({ ...pollRow, meta: { ...pollRow.meta, ws } });
    expect(queue(storage)).toEqual([]);
    expect(saved(storage).counters).toMatchObject({ received: 1, written: 1 });
    expect(h.db.tables.limitless_markets).toHaveLength(1);
  });

  it("the same event again is not written twice; a different later one is meta.ws_latest and meta.ws is kept", async () => {
    makeDb([{ slug: S1, winning_outcome_index: null, meta: {} }]);
    const { obj, storage } = make();
    await ensure(obj);
    const sock = sockets[0]!;
    sock.handshake();
    const d1 = at(T0 - 200), d2 = at(T0 + 5_000);
    sock.recv(resolvedFrame(S1, 1, d1));
    pingAt(sock, T0 + 25_000);
    await alarmAt(obj, T0 + 60_000);
    pingAt(sock, T0 + 75_000);
    sock.recv(resolvedFrame(S1, 1, d1)); // a replay
    await alarmAt(obj, T0 + 120_000);
    expect(rpcCalls).toHaveLength(1);
    pingAt(sock, T0 + 125_000);
    sock.recv(resolvedFrame(S1, 0, d2)); // Limitless changed its mind
    await alarmAt(obj, T0 + 150_000);
    expect(sock.closedBy).toBeNull();
    const meta = h.db.tables.limitless_markets![0]!.meta;
    expect(meta.ws).toMatchObject({ resolution_date: d1, winning_index: 1 });
    expect(meta.ws_latest).toMatchObject({ resolution_date: d2, winning_index: 0 });
    expect(saved(storage).counters).toMatchObject({ written: 1, duplicate: 1, changed: 1 });
  });

  it("a poll index that the websocket contradicts is alerted, never overwritten", async () => {
    makeDb([{ slug: S1, winning_outcome_index: 0, resolved_seen_at: at(T0 - 60_000), meta: {} }]);
    const { obj } = make();
    await ensure(obj);
    sockets[0]!.handshake();
    sockets[0]!.recv(resolvedFrame(S1, 1, at(T0 - 90_000)));
    pingAt(sockets[0]!, T0 + 25_000);
    await alarmAt(obj, T0 + 60_000);
    const row = h.db.tables.limitless_markets![0]!;
    expect(row.winning_outcome_index).toBe(0);
    expect(row.meta.ws).toMatchObject({ winning_index: 1, poll_index: 0 });
    expect(alertKeys()).toContainEqual(["limitless_ws_index_disagrees", 360]);
  });

  it("an unknown slug is never inserted: looked up once more after 2 min, then dropped and counted", async () => {
    const { obj, storage } = make();
    await ensure(obj);
    const sock = sockets[0]!;
    sock.handshake();
    sock.recv(resolvedFrame("synthetic-btc-5-min-1", 1, at(T0 - 100)));
    const keepAlive = (ms: number) => { vi.setSystemTime(ms); sock.recv("2"); };
    keepAlive(T0 + 59_000);
    await alarmAt(obj, T0 + 60_000);
    expect(queue(storage)).toEqual([queueKey(T0 + 60_000 + UNKNOWN_RETRY_MS[0], "synthetic-btc-5-min-1", at(T0 - 100))]);
    const t1 = T0 + 60_000 + UNKNOWN_RETRY_MS[0];
    keepAlive(t1 - 1000);
    await alarmAt(obj, t1);
    expect(queue(storage)).toEqual([]);
    expect(rpcCalls).toEqual([]);
    expect(h.db.tables.limitless_markets).toEqual([]);
    expect(saved(storage)).toMatchObject({ counters: { unknown_retried: 1, unknown_dropped: 1, written: 0 }, dropped_sample: ["synthetic-btc-5-min-1"] });
  });

  it("a failed database read or write keeps the event queued and retries it on the next alarm", async () => {
    makeDb([{ slug: S1, winning_outcome_index: null, meta: {} }]);
    const { obj, storage } = make();
    await ensure(obj);
    const sock = sockets[0]!;
    sock.handshake();
    sock.recv(resolvedFrame(S1, 1, at(T0 - 100)));
    h.selectError = "canceling statement due to statement timeout";
    vi.setSystemTime(T0 + 50_000); sock.recv("2");
    await alarmAt(obj, T0 + 60_000);
    expect(queue(storage)).toHaveLength(1);
    expect(saved(storage)).toMatchObject({ write_failures: 1 });
    h.selectError = null; h.rpcError = "terminating connection due to administrator command";
    vi.setSystemTime(T0 + 110_000); sock.recv("2");
    await alarmAt(obj, T0 + 120_000);
    expect(queue(storage)).toHaveLength(1);
    expect(saved(storage)).toMatchObject({ write_failures: 2, write_error: expect.stringContaining("administrator command") });
    h.rpcError = null;
    vi.setSystemTime(T0 + 170_000); sock.recv("2");
    await alarmAt(obj, T0 + 180_000);
    expect(queue(storage)).toEqual([]);
    expect(h.db.tables.limitless_markets![0]!.meta.ws).toMatchObject({ winning_index: 1 });
    expect(saved(storage)).toMatchObject({ write_failures: 0, write_error: null, counters: { write_errors: 2, written: 1 } });
  });

  it("garbage frames are counted and ignored; the connection stays up and a later event still lands", async () => {
    makeDb([{ slug: S1, winning_outcome_index: null, meta: {} }]);
    const { obj, storage } = make();
    await ensure(obj);
    const sock = sockets[0]!;
    sock.handshake();
    for (const g of [new ArrayBuffer(4), "", "zzz", "42/markets,{bad", '42/other,["marketResolved",{}]', "4x", '42/markets,["newEventName",{}]', created("synthetic-created-1")]) sock.recv(g);
    sock.recv(resolvedFrame(S1, 1, "not a date"));
    expect(sock.closedBy).toBeNull();
    sock.recv(resolvedFrame(S1, 1, at(T0 - 100)));
    vi.setSystemTime(T0 + 50_000); sock.recv("2");
    await alarmAt(obj, T0 + 60_000);
    expect(sock.closedBy).toBeNull();
    expect(h.db.tables.limitless_markets![0]!.meta.ws).toMatchObject({ winning_index: 1 });
    expect(saved(storage).counters).toMatchObject({ garbage: 6, other_events: 1, created: 1, received: 2, invalid: 1, written: 1 });
    expect(alertKeys()).toEqual([["limitless_ws_schema", 1440]]);
  });

  it("reconnects with backoff after a close: 0.5 s, then doubling while attempts fail, capped at 60 s", async () => {
    const { obj, storage } = make();
    await ensure(obj);
    sockets[0]!.handshake();
    vi.setSystemTime(T0 + 10_000);
    sockets[0]!.serverClose(1006, "");
    await flushMicrotasks();
    expect(await status(obj)).toMatchObject({ phase: "idle", attempts: 1, last_close: { code: 1006 } });
    expect(storage.alarm).toBe(T0 + 10_000 + 500);
    // an alarm before the reconnect is due does not connect
    await alarmAt(obj, T0 + 10_200);
    expect(fetches).toHaveLength(1);
    // failed attempts back off: 1 s, 2 s, 4 s, ... 30 s at rnd = 0 (60 s at most)
    upgrade = ["throw", "refuse", "throw", "throw", "throw", "throw", "throw", "throw"];
    let t = T0 + 10_500;
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      await alarmAt(obj, t);
      const next = storage.alarm!;
      delays.push(next - t);
      t = next;
    }
    expect(fetches).toHaveLength(9);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(saved(storage)).toMatchObject({ attempts: 9, last_error: "network connection lost", counters: { connect_failures: 8 } });
    // the next attempt succeeds; a subscribed connection stable for 60 s resets the backoff and ends the outage
    await alarmAt(obj, t);
    sockets[1]!.handshake();
    vi.setSystemTime(t + 30_000); sockets[1]!.recv("2");
    await alarmAt(obj, t + STABLE_MS);
    expect(saved(storage)).toMatchObject({ attempts: 0, down_since: null });
    // the outage began when the instance started: its first connection closed before it had been stable for a minute
    expect(saved(storage).counters.max_down_ms).toBe(t - T0);
  });

  it("stale: no server ping for pingInterval + pingTimeout (85 s) -> dropped by us and reconnected", async () => {
    const { obj, storage } = make();
    await ensure(obj);
    const sock = sockets[0]!;
    sock.handshake();
    await alarmAt(obj, T0 + 50_001); // one late ping is within the protocol's allowance
    expect(sock.closedBy).toBeNull();
    await alarmAt(obj, T0 + 85_000); // exactly the limit: still fine
    expect(sock.closedBy).toBeNull();
    await alarmAt(obj, T0 + 85_001);
    expect(sock.closedBy).toMatchObject({ code: 1000 });
    expect(saved(storage)).toMatchObject({ counters: { stale_drops: 1 }, last_close: { reason: expect.stringContaining("stale") } });
    // a late frame from the dropped socket changes nothing
    sock.recv(resolvedFrame(S1, 1, at(T0)));
    await flushMicrotasks();
    expect(queue(storage)).toEqual([]);
    await alarmAt(obj, storage.alarm!);
    expect(fetches).toHaveLength(2);
    sockets[1]!.handshake();
    expect(await status(obj)).toMatchObject({ phase: "open", subscribed: true });
  });

  it("a namespace ack without the lifecycle subscription confirmed within 30 s is dropped", async () => {
    const { obj, storage } = make();
    await ensure(obj);
    sockets[0]!.handshake({ subscribed: false });
    vi.setSystemTime(T0 + 25_000); sockets[0]!.recv("2");
    await alarmAt(obj, T0 + SUBSCRIBE_TIMEOUT_MS + 1);
    expect(sockets[0]!.closedBy).toMatchObject({ code: 1000 });
    expect(saved(storage).counters.subscribe_timeouts).toBe(1);
    // any lifecycle event is proof enough of the subscription
    await alarmAt(obj, storage.alarm!);
    sockets[1]!.handshake({ subscribed: false });
    sockets[1]!.recv(created("synthetic-created-2"));
    vi.setSystemTime(T0 + 60_000); sockets[1]!.recv("2");
    await alarmAt(obj, T0 + 61_000);
    expect(sockets[1]!.closedBy).toBeNull();
  });

  it("the server's Engine.IO close, a namespace disconnect or a refused namespace all reconnect", async () => {
    const { obj, storage } = make();
    await ensure(obj);
    for (const [i, frame] of [["1"], ["41/markets,"], ['44/markets,{"message":"Not authorized"}']].map(([f], n) => [n, f] as const)) {
      sockets[i]!.handshake();
      sockets[i]!.recv(frame);
      expect(sockets[i]!.closedBy).toMatchObject({ code: 1000 });
      await flushMicrotasks();
      await alarmAt(obj, storage.alarm!);
      expect(fetches).toHaveLength(i + 2);
    }
    expect(saved(storage).counters.closes).toBe(3);
  });

  it("alarm-driven restart: after an eviction or a deploy, the stored alarm reconnects a new instance", async () => {
    const first = make();
    await ensure(first.obj);
    sockets[0]!.handshake();
    vi.setSystemTime(T0 + 60_000); sockets[0]!.recv("2");
    await alarmAt(first.obj, T0 + 60_000);
    expect(saved(first.storage)).toMatchObject({ last_alive_at: T0 + 60_000, down_since: null });
    // the runtime drops the object (a deploy): no close event reaches it; the new instance starts from storage
    const second = make(first.storage);
    await alarmAt(second.obj, T0 + 120_000);
    expect(fetches).toHaveLength(2);
    sockets[1]!.handshake();
    expect(await status(second.obj)).toMatchObject({ phase: "open", down_since: at(T0 + 60_000) });
    // stable a minute later: the outage (about a minute) ends without any alert
    vi.setSystemTime(T0 + 150_000); sockets[1]!.recv("2");
    await alarmAt(second.obj, T0 + 180_000);
    expect(saved(second.storage)).toMatchObject({ down_since: null, attempts: 0 });
    expect(alertKeys()).toEqual([]);
    expect(runs().filter((r) => r.meta.kind === "connected")).toHaveLength(2);
  });

  it("the every-minute cron ping restarts an evicted object even when no alarm is stored", async () => {
    const st = fakeStorage({ [STATE_KEY]: { ...restoreState(undefined, T0 - 300_000), down_since: null, last_alive_at: T0 - 90_000 } });
    const { obj } = make(st);
    expect(st.alarm).toBeNull();
    const r = await ensure(obj);
    expect(fetches).toHaveLength(1);
    expect(r).toMatchObject({ phase: "engine", down_since: at(T0 - 90_000) });
    expect(st.alarm).toBe(T0 + LIVENESS_ALARM_MS);
  });

  it("one alert after 15 min without a stable connection, once per outage, then one recovered alert", async () => {
    const { obj, storage } = make();
    upgrade = Array(40).fill("throw");
    await ensure(obj);
    for (let m = 1; m <= 14; m++) await alarmAt(obj, T0 + m * 60_000);
    expect(alertKeys()).toEqual([]);
    await alarmAt(obj, T0 + DOWN_ALERT_MS);
    expect(alertKeys()).toEqual([["limitless_ws_down", DOWN_ALERT_DEDUP_MINUTES]]);
    const text = vi.mocked(alertMany).mock.calls[0]![1][0]!.text;
    expect(text).toContain("15 min");
    expect(text).toContain("network connection lost");
    for (let m = 16; m <= 20; m++) await alarmAt(obj, T0 + m * 60_000);
    expect(alertKeys()).toHaveLength(1);
    expect(runs().filter((r) => r.meta.kind === "down")).toMatchObject([{ loop_name: LOOP_NAME, outcome: "failure" }]);
    // back: connected, subscribed, stable for a minute
    upgrade = [];
    await alarmAt(obj, T0 + 21 * 60_000);
    const sock = sockets.at(-1)!;
    sock.handshake();
    vi.setSystemTime(T0 + 21 * 60_000 + 30_000); sock.recv("2");
    await alarmAt(obj, T0 + 22 * 60_000);
    expect(alertKeys()).toEqual([["limitless_ws_down", DOWN_ALERT_DEDUP_MINUTES], ["limitless_ws_recovered", 60]]);
    expect(saved(storage)).toMatchObject({ down_since: null, alerted_down_since: null, recovered: null });
  });

  it("a flapping connection (never stable for a minute) still counts as down and alerts at 15 min", async () => {
    const { obj } = make();
    await ensure(obj);
    let t = T0;
    while (t < T0 + DOWN_ALERT_MS + 60_000) {
      const sock = sockets.at(-1)!;
      sock.handshake();
      vi.setSystemTime(t + 20_000);
      sock.serverClose(1006, "");
      await flushMicrotasks();
      t += 60_000;
      await alarmAt(obj, t);
    }
    expect(alertKeys()).toEqual([["limitless_ws_down", DOWN_ALERT_DEDUP_MINUTES]]);
  });

  it("loop_runs: one row per reconnect and one per UTC day, never one per message", async () => {
    const late = Date.parse("2026-09-28T23:58:00.000Z");
    vi.setSystemTime(late);
    makeDb([{ slug: S1, winning_outcome_index: null, meta: {} }]);
    const { obj } = make();
    await ensure(obj);
    const sock = sockets[0]!;
    sock.handshake();
    for (let i = 0; i < 50; i++) { sock.recv("2"); sock.recv(created(`synthetic-created-${i}`)); }
    sock.recv(resolvedFrame(S1, 1, at(late - 100)));
    pingAt(sock, late + 30_000);
    await alarmAt(obj, late + 60_000);
    expect(runs().map((r) => r.meta.kind)).toEqual(["connected"]);
    pingAt(sock, late + 100_000);
    await alarmAt(obj, late + 120_000); // 00:00 UTC has passed
    expect(runs().map((r) => r.meta.kind)).toEqual(["connected", "day"]);
    expect(runs()[1]).toMatchObject({ loop_name: LOOP_NAME, outcome: "success", rows_written: 1, meta: { day: "2026-09-28", pings: 52, created: 50, received: 1, written: 1, connects: 1 } });
    pingAt(sock, late + 150_000);
    await alarmAt(obj, late + 180_000);
    expect(runs()).toHaveLength(2);
    expect(sock.closedBy).toBeNull();
  });

  it("LIMITLESS_WS_ENABLED = 0: the next alarm closes the socket and clears the alarm; nothing reconnects", async () => {
    const e = { ...env } as Env;
    const on = make(fakeStorage(), LISTENER_NAME, e);
    await ensure(on.obj);
    sockets[0]!.handshake();
    // a live object whose env says "0" (as a restarted one would see it) closes its socket at the next alarm
    e.LIMITLESS_WS_ENABLED = "0";
    pingAt(sockets[0]!, T0 + 30_000);
    await alarmAt(on.obj, T0 + 60_000);
    expect(sockets[0]!.closedBy).toMatchObject({ code: 1000, reason: "switched off" });
    expect(on.storage.alarm).toBeNull();
    // a deploy with the var set to "0" restarts the object with the new env; neither the alarm nor the ping reconnects it
    const off = make(on.storage, LISTENER_NAME, { ...env, LIMITLESS_WS_ENABLED: "0" } as Env);
    await alarmAt(off.obj, T0 + 120_000);
    expect(on.storage.alarm).toBeNull();
    expect(await ensure(off.obj)).toMatchObject({ phase: "disabled" });
    expect(on.storage.alarm).toBeNull();
    expect(fetches).toHaveLength(1);
    expect(listenerEnabled({ LIMITLESS_WS_ENABLED: "1" })).toBe(true);
    expect(listenerEnabled({})).toBe(false);
    expect(listenerEnabled({ LIMITLESS_WS_ENABLED: " 0 " })).toBe(false);
  });

  it("a second outage soon after an alerted one still alerts (the dedup is no longer than the threshold)", async () => {
    // alertMany as it dedups: a key sent within its dedupMinutes is reported deduped, not sent
    const last = new Map<string, number>();
    vi.mocked(alertMany).mockImplementation(async (_e, items) => {
      const sent: string[] = [], deduped: string[] = [];
      for (const i of items) {
        const t = last.get(i.key);
        if (t !== undefined && Date.now() - t < (i.dedupMinutes ?? 60) * 60_000) deduped.push(i.key);
        else { sent.push(i.key); last.set(i.key, Date.now()); }
      }
      return { sent, deduped };
    });
    const { obj } = make();
    upgrade = Array(20).fill("throw");
    await ensure(obj);
    for (let m = 1; m <= 16; m++) await alarmAt(obj, T0 + m * 60_000);
    expect(alertKeys()).toEqual([["limitless_ws_down", DOWN_ALERT_DEDUP_MINUTES]]);
    // stable again for a minute
    upgrade = [];
    await alarmAt(obj, T0 + 17 * 60_000);
    const sock = sockets.at(-1)!;
    sock.handshake();
    vi.setSystemTime(T0 + 17 * 60_000 + 30_000); sock.recv("2");
    await alarmAt(obj, T0 + 18 * 60_000);
    expect(alertKeys().map(([k]) => k)).toEqual(["limitless_ws_down", "limitless_ws_recovered"]);
    // down again one minute later; the new outage's alert is not within DOWN_ALERT_DEDUP_MINUTES of the first
    vi.setSystemTime(T0 + 19 * 60_000); sock.serverClose(1006, ""); await flushMicrotasks();
    upgrade = Array(40).fill("throw");
    const t0 = T0 + 19 * 60_000;
    for (let m = 1; m <= 16; m++) await alarmAt(obj, t0 + m * 60_000);
    const downs = (await Promise.all(vi.mocked(alertMany).mock.results.map((r) => r.value))).flatMap((r) => r.sent).filter((k) => k === "limitless_ws_down");
    expect(downs).toHaveLength(2);
  });

  it("switched off for days, then on again: no outage alert for the off period", async () => {
    const e = { ...env } as Env;
    const { obj, storage } = make(fakeStorage(), LISTENER_NAME, e);
    await ensure(obj);
    sockets[0]!.handshake();
    pingAt(sockets[0]!, T0 + 30_000);
    await alarmAt(obj, T0 + 60_000);
    expect(saved(storage).last_alive_at).toBe(T0 + 60_000);
    e.LIMITLESS_WS_ENABLED = "0";
    await alarmAt(obj, T0 + 120_000);
    // three days later a deploy turns it back on: a new instance from the stored state
    const later = T0 + 3 * 86_400_000;
    vi.setSystemTime(later);
    const on = make(storage, LISTENER_NAME, { ...env } as Env);
    await ensure(on.obj);
    vi.setSystemTime(later + 200);
    sockets.at(-1)!.handshake();
    pingAt(sockets.at(-1)!, later + 30_000);
    await alarmAt(on.obj, later + 60_000);
    pingAt(sockets.at(-1)!, later + 90_000);
    await alarmAt(on.obj, later + 120_000);
    expect(alertKeys()).toEqual([]);
    expect(runs().filter((r) => r.meta.kind === "down")).toEqual([]);
    expect(runs().filter((r) => r.meta.kind === "day" && r.outcome === "failure")).toEqual([]);
  });

  it("cross-check, normal order: websocket first, the poll resolves later with another index -> one alert per slug", async () => {
    makeDb([{ slug: S1, winning_outcome_index: null, resolved_seen_at: null, last_pending_at: at(T0 - 600_000), meta: {} }]);
    const { obj, storage } = make();
    await ensure(obj);
    const sock = sockets[0]!;
    sock.handshake();
    sock.recv(resolvedFrame(S1, 1, at(T0 - 200)));
    pingAt(sock, T0 + 30_000);
    await alarmAt(obj, T0 + 60_000);
    expect(alertKeys()).toEqual([]);
    // the poll sees the outcome 8 min later, with index 0
    const row = h.db.tables.limitless_markets![0]!;
    Object.assign(row, { winning_outcome_index: 0, resolved_seen_at: at(T0 + 8 * 60_000) });
    let t = T0 + 60_000;
    for (let i = 0; i < 12; i++) { t += 60_000; pingAt(sock, t - 10_000); await alarmAt(obj, t); }
    expect(alertKeys()).toEqual([["limitless_ws_index_disagrees", 360]]);
    expect(vi.mocked(alertMany).mock.calls.flatMap((c) => c[1]).find((i) => i.key === "limitless_ws_index_disagrees")!.meta).toEqual({ slugs: [S1] });
    expect(saved(storage).checked[S1]).toBeDefined();
    expect(saved(storage).disagreements).toEqual([]);
    // checked once: later passes stay quiet
    for (let i = 0; i < 12; i++) { t += 60_000; pingAt(sock, t - 10_000); await alarmAt(obj, t); }
    expect(alertKeys()).toHaveLength(1);
  });

  it("a disagreement found inside the dedup window is kept and sent later, not dropped", async () => {
    vi.mocked(alertMany).mockImplementationOnce(async (_e, items) => ({ sent: [], deduped: items.map((i) => i.key) }));
    makeDb([{ slug: S1, winning_outcome_index: 0, resolved_seen_at: at(T0 - 60_000), meta: {} }]);
    const { obj, storage } = make();
    await ensure(obj);
    sockets[0]!.handshake();
    sockets[0]!.recv(resolvedFrame(S1, 1, at(T0 - 90_000)));
    pingAt(sockets[0]!, T0 + 25_000);
    await alarmAt(obj, T0 + 60_000);
    expect(saved(storage).disagreements).toEqual([S1]);
    pingAt(sockets[0]!, T0 + 100_000);
    await alarmAt(obj, T0 + 120_000);
    expect(saved(storage).disagreements).toEqual([]);
    expect(alertKeys()).toEqual([["limitless_ws_index_disagrees", 360], ["limitless_ws_index_disagrees", 360]]);
  });

  it("crossCheck (pure): index and resolution window, rows without meta.ws left for later, checked slugs skipped", () => {
    const ws = (i: number, d: string) => ({ ws: { resolution_date: d, winning_index: i } });
    const rows = [
      { slug: "a", winning_outcome_index: 1, last_pending_at: at(T0 - 600_000), resolved_seen_at: at(T0), meta: ws(1, at(T0 - 60_000)) },
      { slug: "b", winning_outcome_index: 0, last_pending_at: at(T0 - 600_000), resolved_seen_at: at(T0), meta: ws(1, at(T0 - 60_000)) },
      { slug: "c", winning_outcome_index: 1, last_pending_at: at(T0 - 600_000), resolved_seen_at: at(T0), meta: ws(1, at(T0 + 1)) },
      { slug: "d", winning_outcome_index: 1, last_pending_at: at(T0 - 600_000), resolved_seen_at: at(T0), meta: {} },
      { slug: "e", winning_outcome_index: 0, last_pending_at: null, resolved_seen_at: at(T0), meta: ws(1, at(T0 - 60_000)) },
    ];
    const r = crossCheck(rows, { e: T0 });
    expect(r.checked).toEqual(["a", "b", "c"]);
    expect(r.disagreements.map((d) => d.slug)).toEqual(["b", "c"]);
  });

  it("any instance but the named one refuses to run", async () => {
    const { obj, storage } = make(fakeStorage(), "another-name");
    const res = await obj.fetch(new Request("https://limitless-listener.internal/ensure", { method: "POST" }));
    expect(res.status).toBe(409);
    await obj.alarm();
    expect(fetches).toEqual([]);
    expect(storage.alarm).toBeNull();
  });
});

// =====================================================================================================================
describe("pingListener (the every-minute cron's side)", () => {
  it("addresses the one named instance with one request and reports its phase", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const ns = {
      idFromName: vi.fn((n: string) => ({ name: n })),
      get: vi.fn(() => ({ fetch: async (u: string, init?: RequestInit) => { calls.push([u, init]); return Response.json({ phase: "open", subscribed: true }); } })),
    };
    const r = await pingListener({ ...env, LIMITLESS_WS: ns } as unknown as Env);
    expect(ns.idFromName).toHaveBeenCalledWith(LISTENER_NAME);
    expect(ns.get).toHaveBeenCalledWith({ name: LISTENER_NAME }, { locationHint: "enam" });
    expect(LOCATION_HINT).toBe("enam");
    expect(calls).toEqual([["https://limitless-listener.internal/ensure", { method: "POST" }]]);
    expect(r).toMatchObject({ ok: true, http_status: 200, phase: "open" });
    expect(LISTENER_PING_SUBREQUESTS).toBe(1);
  });

  it("throws without the binding, so the scheduler alerts it", async () => {
    await expect(pingListener(env)).rejects.toThrow(/LIMITLESS_WS/);
  });

  it("switched off: no request to the object at all", async () => {
    const ns = { idFromName: vi.fn(), get: vi.fn() };
    expect(await pingListener({ ...env, LIMITLESS_WS: ns, LIMITLESS_WS_ENABLED: "0" } as unknown as Env)).toEqual({ ok: true, http_status: 0, phase: "disabled", state: null });
    expect(ns.get).not.toHaveBeenCalled();
  });
});

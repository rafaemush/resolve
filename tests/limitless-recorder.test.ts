/**
 * Limitless resolution-latency recorder (plan §17.3 P0 row, src/jobs/limitless-recorder.ts): payload parsing on the
 * structure-only fixture (single, group container + legs, AMM, the automationType re-check), the page cursor, the
 * failure streak, and full runs against the in-memory database with a stand-in for record_limitless_observations and a
 * stubbed Limitless API: the checks follow the database's order, the budget holds in the worst case, failures alert,
 * no request starts after the run deadline, and the loop_runs row lands before the alert.
 * The SQL merge itself (first sightings kept once, the due order, the guard trigger) is asserted on real Postgres by
 * scripts/selftest/recorder.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb } from "./lib/fake-db";
import LIMITLESS from "./fixtures/limitless-markets.json";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, client: null as unknown }));
vi.mock("../src/db/supabase", () => ({ db: () => h.client ?? h.db.client }));
vi.mock("../src/ops/alerts", () => ({
  alert: vi.fn(async () => ({ sent: true, deduped: false })),
  alertMany: vi.fn(async (_env: unknown, items: Array<{ key: string }>) => ({ sent: items.map((i) => i.key), deduped: [] })),
}));

import {
  checkObservation, failureStreak, feedObservations, groupLegs, isVoid, nextPage, observe, parseCursor, runLimitlessRecorder,
  DISPATCH_TIMEOUT_MS, FAILURES_KEY, FETCH_TIMEOUT_MS, MAX_CHECKS_PER_RUN, MAX_GROUP_FETCHES, MAX_PAGE, PAGE_KEY, RECORDER_SUBREQUESTS,
  RUN_DEADLINE_MS, type Observation,
} from "../src/jobs/limitless-recorder";
import { alertMany } from "../src/ops/alerts";
import { COST } from "../src/ops/budget";
import { RESOLVE_BOT_UA } from "../src/ops/ua";

const FIX = LIMITLESS as Record<string, any>;
const AT = "2026-10-20T12:00:00.000Z";
const manual = (o: Record<string, unknown>) => ({ ...o, automationType: "manual" });

describe("payload parsing (structure-only fixture)", () => {
  it("re-checks automationType: the feed's manual filter lets a sports row through, and it is skipped", () => {
    const f = feedObservations([FIX.single_clob, FIX.amm], AT);
    expect(f).toMatchObject({ rows: 2, manual: 1, non_manual_skipped: 1, schema_dropped: 0 });
    expect(f.observations.map((o) => o.slug)).toEqual([FIX.amm.slug]);
  });

  it("a single market: its own fields, pending, the observation time as given", () => {
    const [o] = feedObservations([manual(FIX.single_clob)], AT).observations;
    expect(o).toEqual({
      slug: FIX.single_clob.slug, group_slug: null, container: false, condition_id: FIX.single_clob.conditionId, category: null,
      trade_type: "clob", automation_type: "manual", market_type: "single", expiration_at: new Date(FIX.single_clob.expirationTimestamp).toISOString(),
      platform_created_at: null, observed: true, observed_at: AT, checked: false, expired: false, winning_outcome_index: null, void: false,
      meta: { platform_id: FIX.single_clob.id, group_id: null, status: "FUNDED", categories: [] },
    } satisfies Observation);
  });

  it("a group row is its container (never an outcome) plus one observation per option leg, each with the group's slug", () => {
    const f = feedObservations([FIX.group], AT);
    expect(f).toMatchObject({ manual: 1, legs: 2, legs_dropped: 0, containers_without_legs: [] });
    const [container, ...legs] = f.observations;
    expect(container).toMatchObject({ slug: FIX.group.slug, container: true, group_slug: null, market_type: "group", winning_outcome_index: null });
    expect(legs.map((l) => [l.slug, l.group_slug, l.container, l.condition_id, l.market_type])).toEqual([
      [FIX.group.markets[0].slug, FIX.group.slug, false, FIX.group.markets[0].conditionId, "group"],
      [FIX.group.markets[1].slug, FIX.group.slug, false, FIX.group.markets[1].conditionId, "group"],
    ]);
  });

  it("an option leg with winningOutcomeIndex set is seen resolved; expired with a null index is pending", () => {
    const resolved = { ...FIX.group.markets[0], status: "RESOLVED", expired: true, winningOutcomeIndex: 1 };
    const pending = { ...FIX.group.markets[1], expired: true, winningOutcomeIndex: null };
    const [, a, b] = feedObservations([{ ...FIX.group, markets: [resolved, pending] }], AT).observations;
    expect(a).toMatchObject({ expired: true, winning_outcome_index: 1, void: false, meta: { status: "RESOLVED" } });
    expect(b).toMatchObject({ expired: true, winning_outcome_index: null, void: false });
  });

  it("a container never carries an outcome, even if the object has one", () => {
    const [c] = feedObservations([{ ...FIX.group, winningOutcomeIndex: 0, payoutNumerators: [1, 1] }], AT).observations;
    expect(c).toMatchObject({ container: true, winning_outcome_index: null, void: false });
  });

  it("void = equal positive payoutNumerators with no index (the reconcile reading); anything else stays pending", () => {
    expect(isVoid({ winningOutcomeIndex: null, payoutNumerators: [1, 1] })).toBe(true);
    expect(isVoid({ winningOutcomeIndex: null, payoutNumerators: ["5", "5"] })).toBe(true);
    expect(isVoid({ winningOutcomeIndex: 0, payoutNumerators: [1, 1] })).toBe(false);
    expect(isVoid({ winningOutcomeIndex: null, payoutNumerators: [0, 0] })).toBe(false);
    expect(isVoid({ winningOutcomeIndex: null, payoutNumerators: [1, 0] })).toBe(false);
    expect(isVoid({ winningOutcomeIndex: null, payoutNumerators: null })).toBe(false);
    const o = observe({ ...FIX.amm, payoutNumerators: [1, 1] }, { observedAt: AT, checked: true });
    expect(o).toMatchObject({ void: true, winning_outcome_index: null, meta: { void: true, payout_numerators: [1, 1], last_error: null } });
  });

  it("a row or a leg the schema refuses is counted and named, never guessed; the rest of the page and the group survive", () => {
    const badLeg = { ...FIX.group.markets[1], winningOutcomeIndex: -1 };
    const f = feedObservations([{ ...FIX.amm, slug: undefined }, { ...FIX.group, markets: [FIX.group.markets[0], badLeg] }, FIX.amm], AT);
    expect(f).toMatchObject({ schema_dropped: 1, legs: 1, legs_dropped: 1, drift: "feed row: slug" });
    expect(f.observations.map((o) => o.slug)).toEqual([FIX.group.slug, FIX.group.markets[0].slug, FIX.amm.slug]);
  });

  it("expirationTimestamp in another unit (seconds, nanoseconds) is schema drift, never a 1970 date or a thrown RangeError", () => {
    const ns = { ...FIX.amm, automationType: "manual", slug: "ns", expirationTimestamp: FIX.amm.expirationTimestamp * 1e6 };
    const s = { ...FIX.amm, automationType: "manual", slug: "s", expirationTimestamp: Math.floor(FIX.amm.expirationTimestamp / 1000) };
    const f = feedObservations([ns, s, manual(FIX.amm)], AT);
    expect(f).toMatchObject({ schema_dropped: 2, manual: 1, drift: "feed row: expirationTimestamp" });
    expect(f.observations.map((o) => o.slug)).toEqual([FIX.amm.slug]);
    expect(checkObservation("ns", { ...ns, expired: true }, AT)).toMatchObject({ observed: false, meta: { last_error: "schema drift at expirationTimestamp" } });
  });

  it("a group row without inline legs is listed for GET /markets/<group slug>; that answer gives the legs", () => {
    const f = feedObservations([{ ...FIX.group, markets: undefined }], AT);
    expect(f.containers_without_legs).toEqual([FIX.group.slug]);
    expect(f.observations).toHaveLength(1);
    const g = groupLegs(FIX.group, FIX.group.slug, AT);
    expect("error" in g ? g.error : g.observations.map((o) => o.group_slug)).toEqual([FIX.group.slug, FIX.group.slug]);
    expect(groupLegs(FIX.single_clob, FIX.group.slug, AT)).toEqual({ error: `answered for slug ${FIX.single_clob.slug}` });
  });

  it("a check answer must be this market's own object with an outcome of its own", () => {
    const ok = checkObservation(FIX.amm.slug, { ...FIX.amm, expired: true, winningOutcomeIndex: 0 }, AT);
    expect(ok).toMatchObject({ observed: true, checked: true, expired: true, winning_outcome_index: 0, meta: { last_error: null, last_http_status: 200 } });
    expect(checkObservation("other-slug", FIX.amm, AT)).toMatchObject({ observed: false, checked: true, meta: { last_error: `answered for slug ${FIX.amm.slug}` } });
    expect(checkObservation(FIX.group.slug, FIX.group, AT)).toMatchObject({ observed: false, meta: { last_error: "slug is a group container, not a market with an outcome" } });
    expect(checkObservation(FIX.amm.slug, { ...FIX.amm, expired: "yes" }, AT)).toMatchObject({ observed: false, meta: { last_error: "schema drift at expired" } });
  });
});

describe("page cursor and failure streak", () => {
  it("the stored cursor is a page in 1..MAX_PAGE, anything else restarts at 1", () => {
    expect([parseCursor("3"), parseCursor(String(MAX_PAGE)), parseCursor(null), parseCursor("0"), parseCursor("2.5"), parseCursor("abc"), parseCursor(String(MAX_PAGE + 1))]).toEqual([3, MAX_PAGE, 1, 1, 1, 1, 1]);
  });
  it("wraps to 1 after a short page, at the feed's end, and at MAX_PAGE; otherwise advances", () => {
    expect(nextPage(3, 25, 296)).toBe(4);
    expect(nextPage(12, 21, 296)).toBe(1); // short page
    expect(nextPage(1, 0, 0)).toBe(1); // empty feed
    expect(nextPage(12, 25, 300)).toBe(1); // full last page: no empty extra fetch
    expect(nextPage(MAX_PAGE, 25, 10_000)).toBe(1);
  });
  it("counts consecutive failed runs, alerts from the third, resets on a run that did not fail", () => {
    expect(failureStreak(0, true)).toEqual({ failures: 1, alert: false });
    expect(failureStreak(1, true)).toEqual({ failures: 2, alert: false });
    expect(failureStreak(2, true)).toEqual({ failures: 3, alert: true });
    expect(failureStreak(7, true)).toEqual({ failures: 8, alert: true });
    expect(failureStreak(7, false)).toEqual({ failures: 0, alert: false });
    expect(failureStreak(null, true)).toEqual({ failures: 1, alert: true }); // could not read the count: alert, never assume zero
  });
});

// ---- full runs -------------------------------------------------------------------------------------------------------

const env = { LIMITLESS_API_KEY: "" } as unknown as Env;
const rowsOf = (n: number, prefix = "m") => Array.from({ length: n }, (_, i) => manual({ ...FIX.amm, id: i, slug: `${prefix}-${i}` }));

describe("runLimitlessRecorder", () => {
  let fetches: Array<{ url: string; headers: Record<string, string> }>;
  let feed: { data: unknown[]; totalMarketsCount: number } | Response;
  let market: (slug: string) => unknown;
  let due: string[];
  let records: Array<{ rows: Observation[]; limit: number; giveUp: number }>;

  const newDb = (config: Record<string, string> = {}) => {
    records = [];
    h.client = null;
    h.db = fakeDb({ app_config: Object.entries(config).map(([key, value]) => ({ key, value })), limitless_markets: [], loop_runs: [] }, {}, {
      primaryKey: { app_config: "key" },
      rpc: {
        // Stand-in: stores rows by slug, lists containers with no leg rows, answers the due list the test sets.
        record_limitless_observations: async (db, a) => {
          const rows = a.p_rows as Observation[];
          records.push({ rows, limit: a.p_due_limit, giveUp: a.p_give_up_days });
          const t = (db.tables.limitless_markets ??= []);
          let inserted = 0, updated = 0;
          for (const r of rows) {
            const ex = t.find((x) => x.slug === r.slug);
            if (ex) { updated++; if (r.group_slug) ex.group_slug = r.group_slug; } else { inserted++; t.push({ slug: r.slug, group_slug: r.group_slug }); }
          }
          const missing = [...new Set(rows.filter((r) => r.container && !t.some((x) => x.group_slug === r.slug)).map((r) => r.slug))];
          return { data: { inserted, updated, newly_expired: 0, newly_resolved: 0, groups_missing_legs: missing, due: due.slice(0, a.p_due_limit) }, error: null };
        },
      },
    });
  };

  beforeEach(() => {
    fetches = []; due = [];
    feed = { data: rowsOf(25), totalMarketsCount: 296 };
    market = (slug) => ({ ...FIX.amm, slug, expired: true, winningOutcomeIndex: null });
    vi.mocked(alertMany).mockClear();
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetches.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
      if (String(url).startsWith("https://api.limitless.exchange/markets/active?")) return feed instanceof Response ? feed : new Response(JSON.stringify(feed), { status: 200 });
      const m = String(url).match(/^https:\/\/api\.limitless\.exchange\/markets\/([^?]+)$/);
      if (m) { const body = market(decodeURIComponent(m[1]!)); return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 }); }
      throw new Error(`unexpected fetch ${url}`);
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const cfg = () => Object.fromEntries(h.db.tables.app_config!.map((r) => [r.key, r.value]));
  const alertKeys = () => vi.mocked(alertMany).mock.calls.flatMap((c) => c[1].map((i) => [i.key, i.dedupMinutes]));

  it("imports the cursor's page, checks the due markets in the database's order, writes both phases, advances the cursor", async () => {
    newDb({ [PAGE_KEY]: "3", [FAILURES_KEY]: "1" });
    due = ["exp-b", "exp-a", "exp-c"];
    market = (slug) => ({ ...FIX.amm, slug, expired: true, winningOutcomeIndex: slug === "exp-a" ? 0 : null });
    const r = await runLimitlessRecorder(env);
    expect(fetches.map((f) => f.url)).toEqual([
      "https://api.limitless.exchange/markets/active?automationType=manual&page=3&limit=25",
      "https://api.limitless.exchange/markets/exp-b", "https://api.limitless.exchange/markets/exp-a", "https://api.limitless.exchange/markets/exp-c",
    ]);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ limit: MAX_CHECKS_PER_RUN, giveUp: 21 });
    expect(records[0]!.rows).toHaveLength(25);
    expect(records[0]!.rows.every((o) => o.observed && !o.checked)).toBe(true);
    expect(records[1]!.rows.map((o) => [o.slug, o.checked, o.winning_outcome_index])).toEqual([["exp-b", true, null], ["exp-a", true, 0], ["exp-c", true, null]]);
    expect(records[1]!.limit).toBe(0);
    expect(r).toMatchObject({ page: 3, next_page: 4, feed_total: 296, manual_rows: 25, due: 3, checked: 3, check_errors: 0, consecutive_failures: 0, errors: [], recorded: true });
    expect(cfg()).toMatchObject({ [PAGE_KEY]: "4", [FAILURES_KEY]: "0" });
    expect(h.db.tables.loop_runs![0]).toMatchObject({ loop_name: "limitless_recorder", outcome: "success", rows_written: 28 });
    expect(h.db.tables.loop_runs![0]!.meta).toMatchObject({ checked: 3, subrequests: r.subrequests });
    expect(alertMany).not.toHaveBeenCalled();
  });

  it("a short page wraps the cursor to 1; no stored cursor starts at page 1", async () => {
    newDb();
    feed = { data: rowsOf(21), totalMarketsCount: 296 };
    const r = await runLimitlessRecorder(env);
    expect(fetches[0]!.url).toContain("&page=1&");
    expect(r).toMatchObject({ page: 1, next_page: 1 });
    expect(cfg()[PAGE_KEY]).toBe("1");
  });

  it("sends ResolveBot's one UA (wrangler RESOLVE_BOT_UA, else the shared constant), and X-API-Key only when LIMITLESS_API_KEY is non-empty", async () => {
    newDb();
    await runLimitlessRecorder(env);
    expect(fetches[0]!.headers).toEqual({ Accept: "application/json", "User-Agent": RESOLVE_BOT_UA });
    expect(RESOLVE_BOT_UA).toBe("ResolveBot/1.0 (+https://resolve.rafaemush.workers.dev/bot)");
    fetches = [];
    newDb();
    await runLimitlessRecorder({ LIMITLESS_API_KEY: "", RESOLVE_BOT_UA: "ResolveBot/1.0 (+configured)" } as unknown as Env);
    expect(fetches[0]!.headers["User-Agent"]).toBe("ResolveBot/1.0 (+configured)");
    fetches = [];
    newDb();
    await runLimitlessRecorder({ LIMITLESS_API_KEY: "lmts_test_key_0000" } as unknown as Env);
    expect(fetches[0]!.headers["X-API-Key"]).toBe("lmts_test_key_0000");
  });

  it("a container without inline legs: GET /markets/<group slug> once, legs written with group_slug, capped per run", async () => {
    newDb();
    const groups = Array.from({ length: MAX_GROUP_FETCHES + 2 }, (_, i) => ({ ...FIX.group, slug: `grp-${i}`, markets: undefined }));
    feed = { data: groups, totalMarketsCount: groups.length };
    market = (slug) => ({ ...FIX.group, slug, markets: FIX.group.markets.map((l: Record<string, unknown>, j: number) => ({ ...l, slug: `${slug}-leg-${j}` })) });
    const r = await runLimitlessRecorder(env);
    expect(fetches.slice(1).map((f) => f.url)).toEqual(Array.from({ length: MAX_GROUP_FETCHES }, (_, i) => `https://api.limitless.exchange/markets/grp-${i}`));
    expect(r).toMatchObject({ containers_without_legs: MAX_GROUP_FETCHES + 2, groups_fetched: MAX_GROUP_FETCHES, errors: [] });
    expect(records[1]!.rows.map((o) => o.group_slug)).toEqual(Array.from({ length: MAX_GROUP_FETCHES }, (_, i) => [`grp-${i}`, `grp-${i}`]).flat());
    // the next run fetches only the two whose legs are still missing
    fetches = [];
    await runLimitlessRecorder(env);
    expect(fetches.slice(1).map((f) => f.url)).toEqual(["https://api.limitless.exchange/markets/grp-4", "https://api.limitless.exchange/markets/grp-5"]);
  });

  it("worst case stays inside the budget and reports exactly the subrequests it made", async () => {
    newDb({ [FAILURES_KEY]: "2" });
    feed = { data: Array.from({ length: 6 }, (_, i) => ({ ...FIX.group, slug: `grp-${i}`, markets: undefined })), totalMarketsCount: 6 };
    due = Array.from({ length: 60 }, (_, i) => `exp-${i}`);
    market = (slug) => (slug.startsWith("grp-") ? { ...FIX.group, slug } : new Response("upstream down", { status: 502 }));
    const r = await runLimitlessRecorder(env);
    const used = h.db.calls.length + fetches.length + vi.mocked(alertMany).mock.calls.length * COST.alert;
    expect(used).toBeLessThanOrEqual(RECORDER_SUBREQUESTS);
    expect(r.subrequests).toBe(used);
    expect(r).toMatchObject({ groups_fetched: MAX_GROUP_FETCHES, checked: MAX_CHECKS_PER_RUN, check_errors: MAX_CHECKS_PER_RUN, consecutive_failures: 3 });
    expect(alertKeys()).toEqual([["limitless_recorder_failing", 360]]);
  });

  it("one market's failed check is kept on its row and moves it back; only every check failing fails the run", async () => {
    newDb();
    due = ["gone", "fine"];
    market = (slug) => (slug === "gone" ? new Response("not found", { status: 404 }) : { ...FIX.amm, slug, expired: true });
    const r = await runLimitlessRecorder(env);
    expect(r).toMatchObject({ checked: 2, check_errors: 1, errors: [] });
    expect(records[1]!.rows[0]).toMatchObject({ slug: "gone", observed: false, checked: true, meta: { last_error: "HTTP 404", last_http_status: 404 } });
    expect(h.db.tables.loop_runs![0]!.outcome).toBe("success");
  });

  it("a feed that fails keeps the cursor, still checks the due markets, and counts toward the streak", async () => {
    newDb({ [PAGE_KEY]: "5" });
    feed = new Response("bad gateway", { status: 502 });
    due = ["exp-1"];
    const r = await runLimitlessRecorder(env);
    expect(records[0]!.rows).toEqual([]);
    expect(fetches.map((f) => f.url).slice(1)).toEqual(["https://api.limitless.exchange/markets/exp-1"]);
    expect(r).toMatchObject({ page: 5, next_page: 5, consecutive_failures: 1, errors: ["feed page 5: HTTP 502"] });
    expect(cfg()).toMatchObject({ [PAGE_KEY]: "5", [FAILURES_KEY]: "1" });
    expect(h.db.tables.loop_runs![0]).toMatchObject({ outcome: "failure", error: "feed page 5: HTTP 502" });
    expect(alertMany).not.toHaveBeenCalled();
  });

  it("three failed runs in a row alert limitless_recorder_failing (dedup 360); a clean run resets the count", async () => {
    newDb();
    feed = new Response("bad gateway", { status: 502 });
    for (let i = 0; i < 3; i++) await runLimitlessRecorder(env);
    expect(cfg()[FAILURES_KEY]).toBe("3");
    expect(alertKeys()).toEqual([["limitless_recorder_failing", 360]]);
    feed = { data: rowsOf(3), totalMarketsCount: 3 };
    const r = await runLimitlessRecorder(env);
    expect(r.consecutive_failures).toBe(0);
    expect(cfg()[FAILURES_KEY]).toBe("0");
  });

  it("an unreadable streak with a failed run alerts: could not look is not zero", async () => {
    newDb();
    const base = h.db.client;
    h.client = { ...base, from: (t: string) => (t === "app_config" ? { select: () => ({ in: async () => ({ data: null, error: { message: "db down" } }) }), upsert: () => base.from("app_config").upsert([]) } : base.from(t)) };
    const r = await runLimitlessRecorder(env);
    expect(r.errors[0]).toBe("state read: Error: db down");
    expect(r).toMatchObject({ page: 1, consecutive_failures: 1 });
    expect(alertKeys()).toEqual([["limitless_recorder_failing", 360]]);
  });

  it("schema drift alerts limitless_recorder_schema and marks the run failed", async () => {
    newDb();
    feed = { data: [...rowsOf(2), { ...FIX.amm, automationType: "manual", expirationTimestamp: "soon" }], totalMarketsCount: 3 };
    const r = await runLimitlessRecorder(env);
    expect(r).toMatchObject({ schema_dropped: 1, manual_rows: 2 });
    expect(r.errors[0]).toContain("1 feed row(s) and 0 leg(s) failed the schema (first: feed row: expirationTimestamp)");
    expect(alertKeys()).toEqual([["limitless_recorder_schema", 1440]]);
  });

  it("a write the database refuses fails the run and keeps the cursor, so the page is read again", async () => {
    newDb({ [PAGE_KEY]: "2" });
    h.db.options.rpc!.record_limitless_observations = async () => ({ data: null, error: { code: "P0001", message: "record_limitless_observations: every observed row needs an observed_at within the last 10 minutes" } });
    due = ["never-asked"];
    const r = await runLimitlessRecorder(env);
    expect(r.errors).toEqual(["record feed: P0001 record_limitless_observations: every observed row needs an observed_at within the last 10 minutes"]);
    expect(r).toMatchObject({ checked: 0, page: 2, next_page: 2 });
    expect(cfg()[PAGE_KEY]).toBe("2");
    expect(h.db.tables.loop_runs![0]).toMatchObject({ outcome: "failure" });
    expect(h.db.tables.loop_runs![0]!.meta).not.toHaveProperty("recorded");
  });

  it("a nanosecond expirationTimestamp in the feed is recorded as drift: the run records itself, advances and alerts", async () => {
    newDb({ [PAGE_KEY]: "2" });
    feed = { data: [...rowsOf(24), { ...FIX.amm, automationType: "manual", slug: "ns", expirationTimestamp: FIX.amm.expirationTimestamp * 1e6 }], totalMarketsCount: 296 };
    const r = await runLimitlessRecorder(env);
    expect(r).toMatchObject({ schema_dropped: 1, manual_rows: 24, next_page: 3, recorded: true });
    expect(cfg()[PAGE_KEY]).toBe("3");
    expect(h.db.tables.loop_runs![0]).toMatchObject({ outcome: "failure" });
    expect(alertKeys()).toEqual([["limitless_recorder_schema", 1440]]);
  });

  it("starts no request after RUN_DEADLINE_MS, so the last one ends inside pg_net's 30 s with room for the writes", async () => {
    expect(RUN_DEADLINE_MS + FETCH_TIMEOUT_MS).toBeLessThanOrEqual(DISPATCH_TIMEOUT_MS - 10_000);
    newDb();
    due = Array.from({ length: 10 }, (_, i) => `exp-${i}`);
    let clock = Date.parse(AT);
    const startedAt: number[] = [];
    const pending = market;
    market = (slug) => { startedAt.push(clock - Date.parse(AT)); clock += 5_000; return pending(slug); }; // each check takes 5 s
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const r = await runLimitlessRecorder(env);
      expect(r).toMatchObject({ due: 10, stopped_by_deadline: true, recorded: true });
      expect(r.checked).toBe(startedAt.length);
      expect(r.checked).toBeLessThan(10);
      expect(Math.max(...startedAt)).toBeLessThanOrEqual(RUN_DEADLINE_MS);
      expect(records[1]!.rows).toHaveLength(r.checked); // what was checked is still written
    } finally {
      now.mockRestore();
    }
  });

  it("writes its loop_runs row before the alert, and hands the alert to waitUntil when the route gives one", async () => {
    newDb({ [FAILURES_KEY]: "2" });
    feed = new Response("bad gateway", { status: 502 });
    let rowsWhenAlerted = -1;
    let deliver = () => {};
    vi.mocked(alertMany).mockImplementationOnce(async (_env, items) => {
      rowsWhenAlerted = h.db.tables.loop_runs!.length;
      await new Promise<void>((resolve) => { deliver = resolve; }); // a DM still in flight when the run answers
      return { sent: items.map((i) => i.key), deduped: [] };
    });
    const later: Array<Promise<unknown>> = [];
    const r = await runLimitlessRecorder(env, { waitUntil: (p) => { later.push(p); } });
    expect(r).toMatchObject({ recorded: true, alerts: ["limitless_recorder_failing"] });
    expect(rowsWhenAlerted).toBe(1);
    expect(h.db.tables.loop_runs![0]!.meta).toMatchObject({ alerts: ["limitless_recorder_failing"], subrequests: r.subrequests });
    expect(later).toHaveLength(1);
    deliver();
    await Promise.all(later);
  });

  it("a loop_runs row that cannot be written makes the run unrecorded (the route answers 500)", async () => {
    newDb();
    const base = h.db.client;
    h.client = { ...base, from: (t: string) => (t === "loop_runs" ? { insert: async () => ({ error: { message: "loop_runs down" } }) } : base.from(t)) };
    const r = await runLimitlessRecorder(env);
    expect(r.recorded).toBe(false);
  });
});

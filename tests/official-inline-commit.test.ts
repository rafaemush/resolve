/**
 * The inline commit of an official release (plan "3. Be fast", migration 024; src/ingest/official-watch.ts
 * holderCapture): the fetch-slot holder whose release-minute capture records the first print within
 * INLINE_COMMIT_WINDOW_S of release_at commits its own leg in the same invocation (runWatch itself: store, resolve,
 * commitVerdict, publishShadowCommitted) and dispatches the event's other legs at once with one
 * redispatch_official_legs() call; outside the window it behaves as before. The whole path runs for real over an
 * in-memory database (tests/lib/fake-db.ts, which counts every query and RPC): the real capture, the real resolver behind
 * a runtime that makes its two database calls through the same client, the real commitVerdict (commit_context and the
 * bot_posts insert-first with its unique dedup_key) and the real priced publish (follow_entitlements, charge_reveals);
 * fetch is stubbed with the saved BLS bodies (the September CPI page is SYNTHETIC: the August page with its month edited).
 * Counted here: every subrequest of the holder's invocation (inside Workers Free's 50 by construction), the window as a
 * rail (red when switched off), and the races with the poll path (one commit row either way).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, Config } from "../src/env";
import { officialFixture as fx } from "../evals/lib/official-fixtures";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { POST_RPCS } from "./lib/fake-post-rpcs";
import { REVEAL_RPCS, followEntitlements } from "./lib/fake-rpcs";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, clockMs: undefined as number | undefined, dispatched: [] as string[], redispatchCalls: [] as Array<Record<string, unknown>> }));
vi.mock("../src/db/supabase", () => ({
  db: () => h.db.client,
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })), alertMany: vi.fn(async () => ({ sent: [], deduped: [] })) }));
vi.mock("../src/resolve/runtime", async () => {
  const real = await vi.importActual<typeof import("../src/resolve")>("../src/resolve");
  const th = await vi.importActual<typeof import("../src/resolve/thresholds")>("../src/resolve/thresholds");
  return {
    JevUnavailableError: class extends Error {},
    // The real resolver; the runtime's own two subrequests on a structured route (check_gates, the resolutions insert)
    // go through the counted client, as src/resolve/runtime.ts makes them.
    resolveWithRuntime: vi.fn(async (_e: unknown, _c: unknown, o: { marketId: string; market: never; evidence: never; evidenceId: string | null }) => {
      await h.db.client.rpc("check_gates", {});
      const result = await real.resolveMarket({ marketId: o.marketId, market: o.market, evidence: o.evidence, thresholds: th.DEFAULT_THRESHOLDS, spotlightSecret: "t", model: "jev-1.13.0" }, { jev: async () => { throw new Error("Jev must never be called for official_release"); } });
      const id = `res-${(h.db.tables.resolutions ?? []).length + 1}`;
      await h.db.client.from("resolutions").insert({ id, market_id: o.marketId, evidence_id: o.evidenceId, status_row: "complete", verdict: result.verdict });
      return { resolutionId: id, jevCalls: 0, jevCostUsd: 0, result };
    }),
  };
});

import { runWatch } from "../src/ingest/watch";
import {
  fetchOfficial, inlineCommitDue, inlinePlan, siblingSubrequests, HOLDER_REQUEST_SUBREQUESTS, INLINE_COMMIT_WINDOW_S, INLINE_RUN_SUBREQUESTS, REDISPATCH_SUBREQUESTS,
  type InlineCommit,
} from "../src/ingest/official-watch";
import { buildLegRegistration } from "../src/markets/official-legs";
import { alert, alertMany } from "../src/ops/alerts";
import { COST, INVOCATION_SUBREQUESTS, type Budget } from "../src/ops/budget";
import { __setRailsForMutationTesting } from "../src/resolve/rails";
import type { MarketRow, WatchRow } from "../src/ingest/types";

const env = () => ({ RAW: { put: r2 } }) as unknown as Env; // no TELEGRAM_*: commits stay pending for the channel poster
const cfg = { botUa: "ResolveBot/test" } as Config;
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const now = () => h.clockMs ?? Date.now();

// ---- upstream ---------------------------------------------------------------------------------------------------------
const CPI_AUG = fx("bls_cpi_nr0.html");
/** SYNTHETIC: the saved August CPI release with its month edited (header, Table A's last column, the summary sentences). */
const CPI_SEP = CPI_AUG
  .replace("CONSUMER PRICE INDEX - AUGUST 2026", "CONSUMER PRICE INDEX - SEPTEMBER 2026")
  .replace('id="cpi_pressa.h.2.8">Aug.<br />2026', 'id="cpi_pressa.h.2.8">Sep.<br />2026')
  .replace("ended<br />Aug. 2026", "ended<br />Sep. 2026")
  .replace("seasonally adjusted basis in August", "seasonally adjusted basis in September");
const API_BODY: Record<string, string> = { CUUR0000SA0: "bls_v1_cpi.json", CUSR0000SA0: "bls_v1_cpi_sa.json", CUSR0000SA0L1E: "bls_v1_core_sa.json", CUUR0000SA0L1E: "bls_v1_core_nsa.json" };
const ok = (body: string, type = "text/html") => new Response(body, { status: 200, headers: { "content-type": type } });
let fetches: string[] = [];
/** The page answers the August release for the first `augustFor` requests, then September's. */
function serve(augustFor = 0) {
  fetches = [];
  let page = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetches.push(url);
    if (url === "https://www.bls.gov/news.release/cpi.nr0.htm") return ok(page++ < augustFor ? CPI_AUG : CPI_SEP);
    if (url === "https://www.bls.gov/news.release/ppi.nr0.htm") return ok(fx("bls_ppi_nr0.html"));
    if (url.startsWith("https://api.bls.gov/") && url.includes("WPU")) return ok(fx("bls_v1_ppi.json"), "application/json");
    const id = /\/timeseries\/data\/([A-Z0-9]+)$/.exec(url)?.[1];
    if (id && API_BODY[id]) return ok(fx(API_BODY[id]), "application/json");
    if (url.startsWith("https://api.bls.gov/")) return ok(fx("bls_v1_ppi.json"), "application/json");
    if (url.startsWith("https://hooks.example/")) return new Response("ok", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}
let r2: ReturnType<typeof vi.fn>;

// ---- the database -----------------------------------------------------------------------------------------------------
const CPI_REL = "2026-10-14T12:30:00Z";
type Series = Parameters<typeof buildLegRegistration>[0]["group"]["series"];
interface Leg { market: MarketRow; watch: Row }
function leg(n: number, series: Series, period: string, release_at: string, label: string): Leg {
  const r = buildLegRegistration({ platform: "limitless", external_id: `leg-${series}-${label}`, group: { series, period, release_at, title: "t" }, label, open_at: "2026-09-04T00:00:00Z", deadline_utc: "2026-10-15T03:59:00Z", criteria: "test" });
  if (!r.ok) throw new Error(r.reason);
  const market = { ...r.market, id: uuid(n), tenant_id: null, status: "open", is_test: false, deleted_at: null, event_key: `official:${series}:${period}`, official_outcome: null, official_resolved_at: null, official_source_url: null } as MarketRow;
  const watch: Row = {
    id: uuid(100 + n), market_id: market.id, source_kind: "official_release", source_ref: { ref: `official:${series}:${period}`, series, period }, poll_interval_s: 60,
    next_poll_at: release_at, lease_until: null, etag: null, cursor: {}, coverage: [], last_evidence_hash: null, last_canonical_hash: null, last_http_status: null,
    consecutive_errors: 0, backlog: false, active: true, deleted_at: null, markets: market,
  };
  return { market, watch };
}
const tenant = (id: string): Row => ({ id, plan: "payg", credits_balance: 1000, created_at: "2026-10-01T00:00:00.000Z", deleted_at: null, low_credit_notified_at: null });

/** The stand-ins of migration 016 (one fetch lease, first print wins) and 024 (redispatch_official_legs, as the SQL selects). */
const OFFICIAL_RPCS: NonNullable<Parameters<typeof fakeDb>[2]>["rpc"] = {
  check_gates: async () => ({ data: { jev_breaker_open: false, jev_spend_today_usd: 0 }, error: null }),
  claim_official_fetch: async (db, a) => {
    const slots = (db.tables.official_fetch_slots ??= []);
    const s = slots.find((x) => x.series === a.p_series && x.period === a.p_period);
    if (s && s.lease_until > now()) return { data: false, error: null };
    if (s) s.lease_until = now() + a.p_seconds * 1000; else slots.push({ series: a.p_series, period: a.p_period, lease_until: now() + a.p_seconds * 1000 });
    return { data: true, error: null };
  },
  extend_official_fetch: async () => ({ data: null, error: null }),
  record_official_observation: async (db, a) => {
    const obs = (db.tables.official_observations ??= []);
    const existing = obs.find((x) => x.series === a.p_series && x.period === a.p_period);
    if (existing) return { data: { ...existing, inserted: false, revision_differs: Number(existing.value) !== Number(a.p_value) }, error: null };
    const row = { series: a.p_series, period: a.p_period, value: a.p_value, value_text: a.p_value_text, deciding_text: a.p_deciding_text, source_url: a.p_source_url, raw_sha256: a.p_raw_sha256, observed_at: new Date(now()).toISOString(), corroboration: a.p_corroboration, meta: a.p_meta };
    obs.push(row);
    return { data: { ...row, inserted: true, revision_differs: false }, error: null };
  },
  redispatch_official_legs: async (db, a) => {
    h.redispatchCalls.push(a);
    const legs = (db.tables.watches ?? []).filter((w) => {
      const m = (db.tables.markets ?? []).find((x) => x.id === w.market_id);
      return w.active && !w.deleted_at && w.source_kind === "official_release" && m && m.status === "open" && !m.deleted_at
        && a.p_series.includes(m.resolver?.series) && m.resolver?.period === a.p_period && (w.id !== a.p_holder || a.p_holder_too);
    });
    const free = legs.filter((w) => w.lease_until === null || Date.parse(w.lease_until) < now() || (a.p_holder_too && w.id === a.p_holder));
    for (const w of free) { w.lease_until = new Date(now() + 30_000).toISOString(); h.dispatched.push(w.id); }
    return { data: { outcome: "dispatched", dispatched: free.length, legs: legs.length, busy: legs.length - free.length, series: a.p_series, period: a.p_period }, error: null };
  },
};

function world(legs: Leg[], followers: Record<string, string[]> = {}): FakeDb {
  const tenants = [...new Set(Object.values(followers).flat())];
  return fakeDb({
    markets: legs.map((l) => l.market), watches: legs.map((l) => l.watch),
    official_observations: [], official_fetch_slots: [], evidence: [], resolutions: [], loop_runs: [], bot_posts: [],
    tenants: tenants.map(tenant), api_keys: tenants.map((t) => ({ id: `k-${t}`, tenant_id: t, revoked_at: null, deleted_at: null, expires_at: null })),
    market_follows: Object.entries(followers).flatMap(([m, ts]) => ts.map((t, i) => ({ id: `f-${m}-${i}`, tenant_id: t, market_id: m, created_at: "2026-10-01T00:00:00.000Z", deleted_at: null }))),
    webhook_endpoints: tenants.map((t) => ({ id: `e-${t}`, tenant_id: t, url: `https://hooks.example/${t}`, secret: "whsec_test", active: true, deleted_at: null, consecutive_failures: 0, events: ["shadow.committed", "shadow.revealed", "credits.low"] })),
    webhook_deliveries: [], credit_ledger: [],
  }, { bot_posts: ["dedup_key"] }, { rpc: { ...POST_RPCS, ...REVEAL_RPCS, follow_entitlements: followEntitlements, ...OFFICIAL_RPCS } });
}
const commitsOf = (marketId: string) => (h.db.tables.bot_posts ?? []).filter((b) => b.market_id === marketId && b.kind === "commit");
const watchOf = (id: string) => h.db.tables.watches!.find((w) => w.id === id)!;
const alertCalls = () => vi.mocked(alert).mock.calls.length + vi.mocked(alertMany).mock.calls.length;
/** Every subrequest the fake world saw: queries and RPCs, upstream and webhook requests, R2 puts, COST.alert per alert call. */
const subrequests = () => h.db.calls.length + fetches.length + r2.mock.calls.length + alertCalls() * COST.alert;

/** One holder poll under a waitUntil, as POST /internal/watch/:id runs it; waits for everything handed to waitUntil. */
async function holderPoll(watchId: string): Promise<Awaited<ReturnType<typeof runWatch>>> {
  const pending: Array<Promise<unknown>> = [];
  const s = await runWatch(env(), cfg, watchId, { waitUntil: (p) => pending.push(p), dispatch: "pg_net" });
  for (let i = 0; i < pending.length; i++) await pending[i]; // the list grows while it is awaited (the publish's inline attempt)
  return s;
}
/** The POSTs a redispatch fired, run as POST /internal/watch/:id would (each in its own invocation). */
async function runDispatched(): Promise<void> {
  const ids = h.dispatched.splice(0);
  for (const id of ids) await runWatch(env(), cfg, id, { dispatch: "pg_net" });
}

const H = () => leg(1, "us_cpi_u_nsa_yoy", "2026-09", CPI_REL, "3.4%"); // the holder: OPTION_A
const L2 = () => leg(2, "us_cpi_u_nsa_yoy", "2026-09", CPI_REL, "3.5%"); // another leg of the event: OPTION_B
const S1 = () => leg(3, "us_cpi_u_sa_mom", "2026-09", CPI_REL, "0.4%"); // a leg of a sibling series of the same page

beforeEach(() => {
  r2 = vi.fn(async () => ({}));
  h.clockMs = undefined; h.dispatched = []; h.redispatchCalls = [];
  vi.mocked(alert).mockClear(); vi.mocked(alertMany).mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); __setRailsForMutationTesting([]); });
const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });

// ---- the pure rules ---------------------------------------------------------------------------------------------------

describe("the window and the budget (pure)", () => {
  const rel = Date.parse(CPI_REL);
  const due = (ms: number, o: Partial<{ inserted: boolean; ownCapture: boolean }> = {}) => inlineCommitDue({ inserted: true, ownCapture: true, observedAt: new Date(rel + ms).toISOString(), ...o }, rel);
  it(`inline only for a first print this capture inserted, at or after release_at and at most ${INLINE_COMMIT_WINDOW_S} s after it`, () => {
    expect(INLINE_COMMIT_WINDOW_S).toBe(15);
    expect([due(0), due(8000), due(15_000), due(15_001), due(20_000), due(-1)]).toEqual([true, true, true, false, false, false]);
    expect([due(3000, { inserted: false }), due(3000, { ownCapture: false })]).toEqual([false, false]);
  });
  it("the window is a rail: switched off, a first print the burst inserts late commits inline too (the failure it exists for)", () => {
    __setRailsForMutationTesting(["inline_commit_window"]);
    expect([due(15_001), due(45_000), due(-1), due(3000, { inserted: false })]).toEqual([true, true, false, false]);
  });
  it("the reservation: the redispatch, the inline poll, the deferred siblings and their redispatch, one alert; the webhook attempts get the rest", () => {
    expect([HOLDER_REQUEST_SUBREQUESTS, REDISPATCH_SUBREQUESTS, INLINE_RUN_SUBREQUESTS]).toEqual([6, 1, 24]);
    expect([siblingSubrequests(0), siblingSubrequests(1), siblingSubrequests(3)]).toEqual([0, 4, 8]);
    // one page fetch, corroboration, R2, record: 4; no siblings (a PPI release): 6 + 4 + 1 + 24 + 5 = 40, 10 left + the alert
    expect(inlinePlan(4, 0)).toEqual({ fits: true, spent: 10, reserved: 30, webhooks: 15 });
    // the CPI page's three siblings: 8 more, 2 left + the alert (no webhook delivery fits: the drain takes them)
    expect(inlinePlan(4, 3)).toEqual({ fits: true, spent: 10, reserved: 38, webhooks: 7 });
    // a capture that spent 12 (4 page fetches and an R2 alert) on a CPI page: 18 + 38 > 50, not inline
    expect(inlinePlan(12, 3)).toEqual({ fits: false, spent: 18, reserved: 38 });
    expect(inlinePlan(INVOCATION_SUBREQUESTS, 0).fits).toBe(false);
  });
});

// ---- the holder's invocation ------------------------------------------------------------------------------------------

describe("a first print recorded at +3 s: the holder's leg commits in the same invocation, the other legs are dispatched at once", () => {
  it("commits the holder's leg inline (bot_posts row, release to commit 3 s), redispatches the event's legs with one call, then the siblings", async () => {
    const [h1, l2, s1] = [H(), L2(), S1()];
    h.db = world([h1, l2, s1]);
    at("2026-10-14T12:30:03Z");
    serve();
    const s = await holderPoll(h1.watch.id as string);
    expect(s.outcome).toBe("no_op");
    // the holder's own leg: resolved and committed by the inline poll, its loop_runs row marked inline_commit
    const c = commitsOf(h1.market.id);
    expect(c).toHaveLength(1);
    expect(c[0]!.payload.committed).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A" });
    expect(Date.parse(c[0]!.created_at) - Date.parse(CPI_REL)).toBe(3000); // "commit" = the bot_posts row's created_at
    expect(c[0]!.channel).toBe("pending"); // the Telegram post is the channel poster's, separately
    expect(h.db.tables.loop_runs!.filter((r) => r.loop_name === "watch").map((r) => r.meta.dispatch)).toEqual(["pg_net", "inline_commit"]);
    // one redispatch for the event (the holder skipped), then one for the sibling series the page gave
    expect(h.redispatchCalls).toEqual([
      { p_series: ["us_cpi_u_nsa_yoy"], p_period: "2026-09", p_holder: h1.watch.id, p_holder_too: false },
      { p_series: ["us_cpi_u_sa_mom", "us_core_cpi_nsa_yoy", "us_core_cpi_sa_mom"], p_period: "2026-09", p_holder: h1.watch.id, p_holder_too: false },
    ]);
    expect(h.dispatched).toEqual([l2.watch.id, s1.watch.id]);
    expect(h.db.tables.official_observations!.map((o) => o.series).sort()).toEqual(["us_core_cpi_nsa_yoy", "us_core_cpi_sa_mom", "us_cpi_u_nsa_yoy", "us_cpi_u_sa_mom"]);
    expect(fetches.filter((u) => u.endsWith("cpi.nr0.htm"))).toHaveLength(1); // still one page fetch per release
    // the dispatched legs resolve from the stored rows in their own invocations, seconds later
    await runDispatched();
    expect(commitsOf(l2.market.id)[0]!.payload.committed).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_B" });
    expect(commitsOf(s1.market.id)[0]!.payload.committed).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A" });
    expect(alertCalls()).toBe(0);
  });

  it(`subrequests of the holder's invocation on a CPI page (siblings deferred): counted, inside the reservation and inside ${INVOCATION_SUBREQUESTS}`, async () => {
    const [h1, l2] = [H(), L2()];
    h.db = world([h1, l2], { [h1.market.id]: ["t_a", "t_b"] });
    at("2026-10-14T12:30:03Z");
    serve();
    await holderPoll(h1.watch.id as string);
    const counted = subrequests() + 1; // + claim_watch_dispatch, made by the route before runWatch
    // request 6 | capture: page 1, corroboration 1, R2 1, record 1 | redispatch 1 | inline poll: load, observations read,
    // R2, evidence insert, check_gates, resolutions insert, evidence update, commit_context, bot_posts insert (batched:
    // the event has another open leg), follow_entitlements, endpoints, charge_reveals, deliveries insert, watches update,
    // loop_runs = 15 | siblings: read 1, corroboration 3, record 3 | their redispatch 1
    expect(counted).toBe(6 + 4 + 1 + 15 + 7 + 1);
    const plan = inlinePlan(4, 3);
    expect(plan.fits).toBe(true);
    expect(counted).toBeLessThanOrEqual(plan.spent + plan.reserved);
    expect(counted).toBeLessThanOrEqual(INVOCATION_SUBREQUESTS);
    // the two followers were charged and queued; no webhook first attempt fit the budget the siblings left, so the drain
    // delivers them (within 5 minutes, inside the refund rule's 10)
    expect(h.db.tables.credit_ledger!.map((l) => l.tenant_id).sort()).toEqual(["t_a", "t_b"]);
    expect(h.db.tables.webhook_deliveries!.filter((d) => d.event_type === "shadow.committed").map((d) => d.status)).toEqual(["pending", "pending"]);
    expect(fetches.filter((u) => u.startsWith("https://hooks.example/"))).toEqual([]);
  });

  it("a release with no siblings (PPI): the webhook first attempts get what the reservation leaves (two deliveries), all inside 50", async () => {
    const p = leg(5, "us_ppi_fd_nsa_yoy", "2026-08", "2026-09-10T12:30:00Z", "5.4%");
    const p2 = leg(6, "us_ppi_fd_nsa_yoy", "2026-08", "2026-09-10T12:30:00Z", "5.6%");
    h.db = world([p, p2], { [p.market.id]: ["t_a", "t_b"] });
    at("2026-09-10T12:30:02Z");
    serve();
    await holderPoll(p.watch.id as string);
    expect(commitsOf(p.market.id)).toHaveLength(1);
    expect(fetches.filter((u) => u.startsWith("https://hooks.example/")).sort()).toEqual(["https://hooks.example/t_a", "https://hooks.example/t_b"]);
    const counted = subrequests() + 1;
    const plan = inlinePlan(4, 0);
    expect(counted).toBeLessThanOrEqual(plan.spent + plan.reserved + (plan.fits ? plan.webhooks - COST.alert : 0));
    expect(counted).toBeLessThanOrEqual(INVOCATION_SUBREQUESTS);
    expect(h.redispatchCalls).toEqual([{ p_series: ["us_ppi_fd_nsa_yoy"], p_period: "2026-08", p_holder: p.watch.id, p_holder_too: false }]);
  });
});

describe("outside the window: exactly as before", () => {
  it("a first print recorded at +20 s: nothing commits inline, no redispatch, the siblings are recorded, the leg resolves on its next minute poll", async () => {
    const [h1, l2] = [H(), L2()];
    h.db = world([h1, l2]);
    at("2026-10-14T12:30:20Z");
    serve();
    await holderPoll(h1.watch.id as string);
    expect(h.db.tables.official_observations).toHaveLength(4);
    expect(commitsOf(h1.market.id)).toHaveLength(0);
    expect(h.redispatchCalls).toEqual([]);
    expect(h.db.tables.loop_runs!.filter((r) => r.loop_name === "watch").map((r) => r.meta.dispatch)).toEqual(["pg_net"]);
    // its lease ends a second before the next minute poll, which resolves it
    expect(watchOf(h1.watch.id as string)).toMatchObject({ lease_until: "2026-10-14T12:30:59.000Z", next_poll_at: "2026-10-14T12:31:00.000Z" });
    vi.setSystemTime(new Date("2026-10-14T12:31:00.050Z"));
    await runWatch(env(), cfg, h1.watch.id as string, { dispatch: "pg_net" });
    expect(commitsOf(h1.market.id)).toHaveLength(1);
  });

  it("the rail switched off: the same +20 s capture commits inline (so the test above depends on the window, not on luck)", async () => {
    __setRailsForMutationTesting(["inline_commit_window"]);
    const [h1, l2] = [H(), L2()];
    h.db = world([h1, l2]);
    at("2026-10-14T12:30:20Z");
    serve();
    await holderPoll(h1.watch.id as string);
    expect(commitsOf(h1.market.id)).toHaveLength(1);
    expect(h.redispatchCalls).toHaveLength(2);
  });

  it("a first print another leg stored first (not inserted by this capture) never commits inline", async () => {
    const [h1, l2] = [H(), L2()];
    h.db = world([h1, l2]);
    at("2026-10-14T12:30:03Z");
    serve();
    // another leg's capture stored it while this poll's read raced it: the read saw nothing, the record answers inserted false
    const read = h.db.client.from;
    let first = true;
    h.db.client.from = ((t: string) => {
      const q = read(t);
      if (t !== "official_observations" || !first) return q;
      first = false;
      h.db.tables.official_observations!.push({ series: "us_cpi_u_nsa_yoy", period: "2026-09", value: 3.4, value_text: "3.4", deciding_text: "x", source_url: "https://www.bls.gov/news.release/cpi.nr0.htm", raw_sha256: "a".repeat(64), observed_at: "2026-10-14T12:30:01.000Z", corroboration: null, meta: { captured_by_market: l2.market.id } });
      return Object.assign(q, { maybeSingle: () => Promise.resolve({ data: null, error: null }) });
    }) as never;
    await holderPoll(h1.watch.id as string);
    expect(commitsOf(h1.market.id)).toHaveLength(0);
    expect(h.redispatchCalls).toEqual([]);
  });
});

describe("over budget: no inline commit, every leg (the holder's own included) is dispatched with one call", () => {
  it("four page fetches and a failed R2 put (an alert) before the first print: 18 + 38 > 50, so the holder hands its lease to the redispatch", async () => {
    const [h1, l2] = [H(), L2()];
    h.db = world([h1, l2]);
    at("2026-10-14T12:30:01Z");
    serve(3);
    r2 = vi.fn(async () => { throw new Error("R2 unavailable"); });
    let t = Date.parse("2026-10-14T12:30:01Z");
    h.clockMs = t;
    const deps = { now: () => t, sleep: async (ms: number) => { t += ms; h.clockMs = t; } };
    let done!: () => void;
    const inline: InlineCommit = { requestDone: new Promise<void>((r) => { done = r; }), run: async () => { throw new Error("the inline poll must not run over budget"); } };
    const pending: Array<Promise<unknown>> = [];
    done();
    await fetchOfficial(env(), h1.watch as unknown as WatchRow, h1.market, { ...deps, waitUntil: (p) => pending.push(p), inline });
    for (let i = 0; i < pending.length; i++) await pending[i];
    expect(fetches.filter((u) => u.endsWith("cpi.nr0.htm"))).toHaveLength(4);
    expect(h.db.tables.official_observations).toHaveLength(4); // the siblings first, as before
    expect(h.redispatchCalls).toEqual([{ p_series: ["us_cpi_u_nsa_yoy", "us_cpi_u_sa_mom", "us_core_cpi_nsa_yoy", "us_core_cpi_sa_mom"], p_period: "2026-09", p_holder: h1.watch.id, p_holder_too: true }]);
    expect(h.dispatched.sort()).toEqual([h1.watch.id, l2.watch.id].sort());
  });
});

describe("races with the poll path: one commit row either way", () => {
  it("the inline commit, then the next minute poll of the same leg: a no_op, one commit row", async () => {
    const h1 = H();
    h.db = world([h1, L2()]);
    at("2026-10-14T12:30:03Z");
    serve();
    await holderPoll(h1.watch.id as string);
    expect(commitsOf(h1.market.id)).toHaveLength(1);
    vi.setSystemTime(new Date("2026-10-14T12:31:00.050Z"));
    const next = await runWatch(env(), cfg, h1.watch.id as string, { dispatch: "pg_net" });
    expect(next.outcome).toBe("no_op");
    expect(commitsOf(h1.market.id)).toHaveLength(1);
  });

  for (const hashSaved of [true, false]) {
    it(`the poll first, then a late inline task: one commit row${hashSaved ? "" : " (the poll's hash lost too: commitVerdict's dedup against the latest commit holds it)"}`, async () => {
      const h1 = H();
      h.db = world([h1, L2()]);
      at("2026-10-14T12:30:03Z");
      serve();
      let release!: () => void;
      const pending: Array<Promise<unknown>> = [];
      const inline: InlineCommit = { requestDone: new Promise<void>((r) => { release = r; }), run: (webhooks: Budget) => runWatch(env(), cfg, h1.watch.id as string, { waitUntil: (p) => pending.push(p), dispatch: "inline_commit", webhooks }) };
      await fetchOfficial(env(), h1.watch as unknown as WatchRow, h1.market, { waitUntil: (p) => pending.push(p), inline });
      // the capture records the first print and the task waits for the request's bookkeeping; a poll of the same leg runs first
      await vi.waitFor(() => expect(h.redispatchCalls).toHaveLength(1));
      const poll = await runWatch(env(), cfg, h1.watch.id as string, { dispatch: "pg_net" });
      expect(poll.outcome).toBe("success");
      expect(commitsOf(h1.market.id)).toHaveLength(1);
      if (!hashSaved) watchOf(h1.watch.id as string).last_canonical_hash = null;
      release();
      for (let i = 0; i < pending.length; i++) await pending[i];
      expect(commitsOf(h1.market.id)).toHaveLength(1);
      expect(h.db.tables.resolutions).toHaveLength(hashSaved ? 1 : 2);
    });
  }
});

describe("never inline outside the release-minute burst", () => {
  it("a holder outside the release minute keeps no lease and offers no inline commit", async () => {
    const h1 = H();
    h.db = world([h1]);
    at("2026-10-14T12:45:00Z");
    serve();
    const pending: Array<Promise<unknown>> = [];
    const inline: InlineCommit = { requestDone: Promise.resolve(), run: async () => { throw new Error("no inline commit outside the burst"); } };
    const out = await fetchOfficial(env(), h1.watch as unknown as WatchRow, h1.market, { waitUntil: (p) => pending.push(p), inline });
    expect(out.leaseUntil).toBeUndefined();
    expect(out.note).toMatch(/^the capture continues in waitUntil/);
    for (let i = 0; i < pending.length; i++) await pending[i];
    expect(h.db.tables.official_observations).toHaveLength(4);
    expect(h.redispatchCalls).toEqual([]);
  });

  it("a tenant's /v1/resolve fetch in the release minute captures as before (its request's subrequests are not the ones the inline budget counts)", async () => {
    const [h1, l2] = [H(), L2()];
    h.db = world([h1, l2]);
    at("2026-10-14T12:30:03Z");
    serve();
    const pending: Array<Promise<unknown>> = [];
    await runWatch(env(), cfg, h1.watch.id as string, { waitUntil: (p) => pending.push(p), dispatch: "tenant_fetch" });
    for (let i = 0; i < pending.length; i++) await pending[i];
    expect(h.db.tables.official_observations).toHaveLength(4);
    expect(commitsOf(h1.market.id)).toHaveLength(0);
    expect(h.redispatchCalls).toEqual([]);
    expect(watchOf(h1.watch.id as string).lease_until).toBeNull();
  });

  it("a redispatch that could not run alerts once and says so: the legs resolve on their next minute poll", async () => {
    const [h1, l2] = [H(), L2()];
    h.db = world([h1, l2]);
    h.db.options.rpc!.redispatch_official_legs = async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.redispatch_official_legs" } });
    at("2026-10-14T12:30:03Z");
    serve();
    await holderPoll(h1.watch.id as string);
    expect(commitsOf(h1.market.id)).toHaveLength(1); // the inline commit does not depend on it
    const keys = vi.mocked(alert).mock.calls.map((c) => c[1]);
    expect(keys).toEqual(["official_redispatch_us_cpi_u_nsa_yoy_2026-09", "official_redispatch_us_cpi_u_nsa_yoy_2026-09"]);
    expect(String(vi.mocked(alert).mock.calls[0]![2])).toContain("migration 024");
  });
});

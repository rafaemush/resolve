/**
 * Reconcile (plan §16.4 P2 step 2, §17.3 P2a): strict label mapping (no positional fallback), the Limitless official
 * mapping on the real API shape, final-flag selection, the recheck schedule, and full runs against an in-memory
 * database (settle_market / defer_reconcile stand-ins, uq_reconciliations_final enforced) with a stubbed Limitless API
 * and Telegram: one agreement per market, reveals as replies, the 21-day close-out, a final that moves to a newer
 * commit, failed writes alerted, a commit that lands mid-settle, no starvation, the post-deadline poll waited for, and
 * the subrequest budget of one invocation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { MarketRow } from "../src/ingest/types";
import { fakeDb, type FakeDb } from "./lib/fake-db";
import { RECONCILE_RPCS, RECONCILIATION_FINAL, settleMarket } from "./lib/fake-rpcs";
import LIMITLESS from "./fixtures/limitless-markets.json";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", () => ({ db: () => h.db.client }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { agreementFor, deferral, limitlessOfficial, limitlessSlug, mapOfficialLabel, planReconciliations, polymarketOfficial, recheckDelaySeconds, runReconcile, withFirstSeen, RECHECK_MAX_S, RECHECK_PENDING_S, RECONCILE_SUBREQUESTS, type CommitForPlan, type OfficialState } from "../src/jobs/reconcile";
import { buildPreimage, committedFields, type CommittedVerdict, type OfficialRecord } from "../src/bot/commit";
import { COST } from "../src/ops/budget";
import { alert } from "../src/ops/alerts";
import { sha256Hex } from "../src/resolve/text";
import type { Verdict } from "../src/resolve/schema";

const FIX = LIMITLESS as Record<string, any>;
const YES_NO = { option_a: "Yes", option_b: "No" };
const NOW = "2026-10-20T12:00:00.000Z";

describe("mapOfficialLabel (strict)", () => {
  it("maps by normalized equality only", () => {
    expect(mapOfficialLabel("Yes", YES_NO)).toBe("OPTION_A");
    expect(mapOfficialLabel("  NO. ", YES_NO)).toBe("OPTION_B");
    expect(mapOfficialLabel("Team Nemesis", { option_a: "Conventus Stellarum", option_b: "team nemesis" })).toBe("OPTION_B");
  });
  it("yes/no only when the option text is yes/no", () => {
    expect(mapOfficialLabel("Yes", { option_a: "Merged by Oct 1", option_b: "Not merged" })).toBeNull();
    expect(mapOfficialLabel("Yes", { option_a: "Yes, before the deadline", option_b: "No" })).toBeNull(); // the old prefix match is gone
  });
  it("mismatch, empty label or identical options -> null (never positional)", () => {
    expect(mapOfficialLabel("Republican Party", YES_NO)).toBeNull();
    expect(mapOfficialLabel("", YES_NO)).toBeNull();
    expect(mapOfficialLabel("Yes", { option_a: "yes", option_b: "YES" })).toBeNull();
  });
});

describe("polymarketOfficial", () => {
  const url = "https://gamma-api.polymarket.com/markets/1";
  const gamma = (over: Record<string, unknown>) => ({ closed: true, umaResolutionStatus: "resolved", outcomes: '["Yes","No"]', outcomePrices: '["0","1"]', closedTime: "2026-10-05 12:02:13+00", slug: "x", ...over });
  it("maps the winning label strictly and labels closedTime", () => {
    const s = polymarketOfficial(gamma({}), YES_NO, NOW, url);
    expect(s).toMatchObject({ kind: "resolved", official: { outcome: "OPTION_B", label: "No", at: "2026-10-05T12:02:13.000Z", at_source: "gamma_closed_time", source_url: "https://polymarket.com/event/x" } });
  });
  it("a label that matches neither option is unmappable, not the first option", () => {
    expect(polymarketOfficial(gamma({ outcomes: ["Up", "Down"], outcomePrices: ["1", "0"] }), YES_NO, NOW, url)).toMatchObject({ kind: "unmappable", label: "Up" });
  });
  it("official only when closed AND umaResolutionStatus is resolved: a closed market's prices are not an outcome", () => {
    expect(polymarketOfficial(gamma({ umaResolutionStatus: null, closedTime: "2026-10-19 12:00:00+00" }), YES_NO, NOW, url).kind).toBe("pending");
    expect(polymarketOfficial(gamma({ umaResolutionStatus: "", closedTime: "2026-10-19 12:00:00+00" }), YES_NO, NOW, url).kind).toBe("pending");
    // closed 15 days ago and UMA never said anything: someone has to look (alerted), never read from prices
    expect(polymarketOfficial(gamma({ umaResolutionStatus: null }), YES_NO, NOW, url)).toMatchObject({ kind: "unmappable", label: null });
  });
  it("pending while not closed or UMA not resolved; 50-50 is VOID; no closedTime -> first observation", () => {
    expect(polymarketOfficial(gamma({ closed: false }), YES_NO, NOW, url).kind).toBe("pending");
    expect(polymarketOfficial(gamma({ umaResolutionStatus: "proposed" }), YES_NO, NOW, url).kind).toBe("pending");
    expect(polymarketOfficial(gamma({ outcomePrices: ["0.5", "0.5"] }), YES_NO, NOW, url)).toMatchObject({ kind: "resolved", official: { outcome: "VOID" } });
    expect(polymarketOfficial(gamma({ closedTime: null }), YES_NO, NOW, url)).toMatchObject({ official: { at: NOW, at_source: "first_observed_poll" } });
  });
});

describe("limitlessOfficial on the real API shape (fixture from the 2026-09-23 sample)", () => {
  const single = FIX.single_clob;
  const resolved = (idx: number, over: Record<string, unknown> = {}) => ({ ...single, status: "RESOLVED", expired: true, winningOutcomeIndex: idx, ...over });

  it("an unresolved market is pending", () => {
    expect(limitlessOfficial(single, YES_NO, single.slug, NOW)).toMatchObject({ kind: "pending" });
  });
  it("index 0 = Yes, 1 = No from tokens {yes, no}; official_at is the first observation, labeled", () => {
    expect(limitlessOfficial(resolved(0), YES_NO, single.slug, NOW)).toMatchObject({ kind: "resolved", official: { outcome: "OPTION_A", label: "Yes", at: NOW, at_source: "limitless_api_poll", source_url: `https://limitless.exchange/markets/${single.slug}` } });
    expect(limitlessOfficial(resolved(1), YES_NO, single.slug, NOW)).toMatchObject({ kind: "resolved", official: { outcome: "OPTION_B", label: "No" } });
    expect(limitlessOfficial(resolved(1, { payoutNumerators: [0, 1] }), YES_NO, single.slug, NOW)).toMatchObject({ kind: "resolved", official: { outcome: "OPTION_B" } });
  });
  it("a group leg (marketType group, own tokens) maps like a single market; the group container does not", () => {
    const leg = FIX.group.markets[0];
    expect(limitlessOfficial({ ...leg, winningOutcomeIndex: 0 }, YES_NO, leg.slug, NOW)).toMatchObject({ kind: "resolved", official: { outcome: "OPTION_A" } });
    expect(limitlessOfficial(FIX.group, YES_NO, FIX.group.slug, NOW)).toMatchObject({ kind: "unmappable" });
  });
  it("registered options that are not the platform's labels abstain", () => {
    expect(limitlessOfficial(resolved(0), { option_a: "Team Nemesis", option_b: "Conventus Stellarum" }, single.slug, NOW)).toMatchObject({ kind: "unmappable", label: "Yes" });
  });
  it("an AMM market has no labels: unmappable, never a guess", () => {
    expect(limitlessOfficial({ ...FIX.amm, winningOutcomeIndex: 0 }, YES_NO, FIX.amm.slug, NOW)).toMatchObject({ kind: "unmappable" });
  });
  it("equal payoutNumerators with no index is VOID; contradictions are unmappable", () => {
    expect(limitlessOfficial({ ...single, payoutNumerators: [1, 1] }, YES_NO, single.slug, NOW)).toMatchObject({ kind: "resolved", official: { outcome: "VOID", label: null } });
    expect(limitlessOfficial(resolved(0, { payoutNumerators: [0, 1] }), YES_NO, single.slug, NOW).kind).toBe("unmappable");
    expect(limitlessOfficial(resolved(0, { payoutNumerators: ["1", "1"] }), YES_NO, single.slug, NOW).kind).toBe("unmappable");
    expect(limitlessOfficial(resolved(2), YES_NO, single.slug, NOW).kind).toBe("unmappable");
  });
  it("slug: meta slug first, else external_id", () => {
    expect(limitlessSlug({ external_id: "a", meta: {} })).toBe("a");
    expect(limitlessSlug({ external_id: "a", meta: { slug: "b" } })).toBe("b");
    expect(limitlessSlug({ external_id: "a", meta: { slug: "b", limitless_slug: "c" } })).toBe("c");
  });
});

function committed(status: Verdict["resolution_status"], outcome: Verdict["winning_outcome"], nonce = "n"): CommittedVerdict {
  const v = { resolution_status: status, winning_outcome: outcome, confidence_score: 0.95, caveats: status === "UNRESOLVED" ? ["no_anchor"] : [], evidence: null, thresholds_version: "v1", determination_basis: "structured" } as unknown as Verdict;
  const fields = committedFields(v);
  return { preimage_version: "v2", preimage: buildPreimage("limitless:m", fields, nonce), ...fields };
}

describe("agreement and final-flag selection", () => {
  const OFF: OfficialRecord = { outcome: "OPTION_A", label: "Yes", at: "2026-10-02T00:00:00.000Z", at_source: "limitless_api_poll", source_url: null };
  it("agreementFor", () => {
    expect(agreementFor(committed("RESOLVED", "OPTION_A"), "OPTION_A")).toBe("agree");
    expect(agreementFor(committed("RESOLVED", "OPTION_B"), "OPTION_A")).toBe("disagree");
    expect(agreementFor(committed("UNRESOLVED", "NONE"), "OPTION_A")).toBe("abstained");
    expect(agreementFor(committed("RESOLVED", "OPTION_A"), "VOID")).toBe("void");
    expect(agreementFor(committed("RESOLVED", "OPTION_A"), null)).toBe("unresolved_by_platform");
  });
  it("one row per commit, final only on the latest, final last, lead from telegram_date", () => {
    const commits: CommitForPlan[] = [
      { id: "c3", resolution_id: "r3", created_at: "2026-10-01T03:00:00.000Z", telegram_date: null, committed: committed("RESOLVED", "OPTION_A") },
      { id: "c1", resolution_id: "r1", created_at: "2026-10-01T01:00:00.000Z", telegram_date: "2026-10-01T01:00:05.000Z", committed: committed("UNRESOLVED", "NONE") },
      { id: "c2", resolution_id: "r2", created_at: "2026-10-01T02:00:00.000Z", telegram_date: "2026-10-01T02:00:00.000Z", committed: committed("RESOLVED", "OPTION_B") },
    ];
    const plan = planReconciliations({ id: "m", platform: "limitless" }, commits, OFF);
    expect(plan.map((p) => [p.commit_id, p.row.final, p.row.agreement, p.row.lead_seconds])).toEqual([
      ["c1", false, "abstained", 82_795], // 2026-10-02T00:00:00 - 2026-10-01T01:00:05
      ["c2", false, "disagree", 79_200],
      ["c3", true, "agree", null], // unposted: no lead time
    ]);
    expect(plan.filter((p) => p.row.final)).toHaveLength(1);
    expect(plan[2]!.row).toMatchObject({ official_label: "Yes", official_at_source: "limitless_api_poll", resolution_id: "r3", market_id: "m" });
    expect(planReconciliations({ id: "m", platform: "limitless" }, [], OFF)).toEqual([]);
  });
});

describe("recheck schedule (no starvation)", () => {
  const T = Date.parse(NOW);
  it("pending stays at the cron interval; failed checks double from 10 min to 6 h", () => {
    expect(recheckDelaySeconds("pending", 7)).toBe(RECHECK_PENDING_S);
    expect([0, 1, 2, 5, 6, 30].map((n) => recheckDelaySeconds("failed", n))).toEqual([600, 1200, 2400, 19_200, RECHECK_MAX_S, RECHECK_MAX_S]);
  });
  it("a deferral counts consecutive failures and resets them on a pending answer; retry is due at once", () => {
    const m = { id: "m", reconcile_attempts: 2 };
    expect(deferral(m, "failed", T)).toEqual({ id: "m", next_at: new Date(T + 2400_000).toISOString(), attempts: 3, first_seen_at: null });
    expect(deferral(m, "pending", T, "x")).toEqual({ id: "m", next_at: new Date(T + 600_000).toISOString(), attempts: 0, first_seen_at: "x" });
    expect(deferral(m, "retry", T)).toMatchObject({ next_at: NOW, attempts: 2 });
  });
  it("a poll-observed official time is the first sighting; a platform timestamp is kept", () => {
    const poll: OfficialState = { kind: "resolved", official: { outcome: "OPTION_A", label: "Yes", at: NOW, at_source: "limitless_api_poll", source_url: null }, detail: "" };
    expect(withFirstSeen(poll, "2026-10-20T11:00:00.000Z")).toMatchObject({ official: { at: "2026-10-20T11:00:00.000Z" } });
    expect(withFirstSeen(poll, null)).toBe(poll);
    const gammaTs: OfficialState = { ...poll, official: { ...poll.official, at_source: "gamma_closed_time" } };
    expect(withFirstSeen(gammaTs, "2026-10-20T11:00:00.000Z")).toBe(gammaTs);
  });
});

// ---- a full run -----------------------------------------------------------------------------------------------------

const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "-100" } as unknown as Env;
const PAST = new Date(Date.now() - 3 * 86_400_000).toISOString(); // past the deadline, inside the 21-day close-out

function market(id: string, over: Partial<MarketRow> = {}): Record<string, unknown> {
  return { id, tenant_id: null, deleted_at: null, is_test: false, status: "open", platform: "limitless", external_id: `slug-${id}`, meta: {}, option_a: "Yes", option_b: "No", deadline_utc: PAST, grace_seconds: 3600, reconcile_next_at: PAST, reconcile_attempts: 0, official_first_seen_at: null, ...over };
}
/** A watch that has finished its post-deadline poll. */
const watch = (id: string, marketId: string, over: Record<string, unknown> = {}) => ({ id, market_id: marketId, active: true, deleted_at: null, last_polled_at: new Date().toISOString(), consecutive_errors: 0, ...over });
/** The production shapes: unique columns, uq_reconciliations_final, and the two RPCs. */
function newDb(tables: Record<string, Array<Record<string, any>>>, rpc = RECONCILE_RPCS): FakeDb {
  return fakeDb({ markets: [], watches: [], bot_posts: [], reconciliations: [], loop_runs: [], ...tables }, { bot_posts: ["dedup_key"], reconciliations: ["resolution_id"] }, { partialUnique: RECONCILIATION_FINAL, rpc });
}
async function commitRow(id: string, marketId: string, createdAt: string, c: CommittedVerdict, messageId: number | null): Promise<Record<string, unknown>> {
  return {
    id, market_id: marketId, resolution_id: `res-${id}`, kind: "commit", channel: messageId ? "telegram" : "pending", message_id: messageId, created_at: createdAt,
    telegram_date: messageId ? createdAt : null, commitment_sha256: await sha256Hex(c.preimage), nonce: c.preimage.split("|").at(-1), payload: { committed: c }, dedup_key: `commit:${marketId}:${id}`, resolutions: null,
  };
}

describe("runReconcile", () => {
  let fetches: string[];
  let sent: Array<Record<string, any>>;
  let limitless: (slug: string) => unknown;
  const RESOLVED_YES = () => ({ ...FIX.single_clob, status: "RESOLVED", expired: true, winningOutcomeIndex: 0 });

  beforeEach(() => {
    fetches = []; sent = [];
    limitless = RESOLVED_YES;
    vi.mocked(alert).mockClear();
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetches.push(String(url));
      if (String(url).startsWith("https://api.telegram.org/")) {
        sent.push(JSON.parse(String(init!.body)));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 900 + sent.length, date: 1791000000 } }), { status: 200 });
      }
      const m = String(url).match(/^https:\/\/api\.limitless\.exchange\/markets\/(.+)$/);
      if (m) return new Response(JSON.stringify(limitless(decodeURIComponent(m[1]!))), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const alerts = () => vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes]);

  it("resolves a Limitless market: one agreement per market, reveals as replies next run, watches off", async () => {
    const early = committed("UNRESOLVED", "NONE", "n1"), late = committed("RESOLVED", "OPTION_A", "n2");
    h.db = newDb({
      markets: [market("m1")],
      watches: [watch("w1", "m1")],
      bot_posts: [await commitRow("c1", "m1", "2026-09-20T00:00:00.000Z", early, 11), await commitRow("c2", "m1", "2026-09-21T00:00:00.000Z", late, 12)],
    });

    const r1 = await runReconcile(env);
    expect(r1).toMatchObject({ checked: 1, resolved: 1, reconciliations: 2, reveals_recorded: 2, reveals_posted: 0, errors: [] });
    // one write request (one transaction), then the read of the market's followers for shadow.revealed
    expect(h.db.calls.filter((c) => c.action === "rpc").map((c) => c.table)).toEqual(["rpc:settle_market", "rpc:follow_entitlements"]);
    const rec = h.db.tables.reconciliations!;
    expect(rec.map((x) => [x.resolution_id, x.final, x.agreement, x.official_outcome, x.official_label, x.official_at_source])).toEqual([
      ["res-c1", false, "abstained", "OPTION_A", "Yes", "limitless_api_poll"],
      ["res-c2", true, "agree", "OPTION_A", "Yes", "limitless_api_poll"],
    ]);
    expect(h.db.tables.markets![0]).toMatchObject({ status: "resolved", official_outcome: "OPTION_A" });
    expect(h.db.tables.watches![0]!.active).toBe(false);
    const reveals = h.db.tables.bot_posts!.filter((b) => b.kind === "reveal");
    expect(reveals.map((b) => [b.dedup_key, b.channel])).toEqual([["reveal:c1", "pending"], ["reveal:c2", "pending"]]);
    expect(h.db.tables.loop_runs![0]).toMatchObject({ loop_name: "settle_bot", verifier_name: "reconcile", outcome: "success" });
    expect(sent).toHaveLength(0);

    const r2 = await runReconcile(env);
    expect(r2).toMatchObject({ checked: 0, reveals_posted: 2 });
    expect(sent.map((s) => s.reply_to_message_id)).toEqual([11, 12]);
    for (const s of sent) {
      const line = (p: string) => String(s.text).split("\n").find((l: string) => l.startsWith(p))!.slice(p.length);
      expect(await sha256Hex(line("preimage "))).toBe(line("commitment sha256 "));
    }
    expect(h.db.tables.bot_posts!.filter((b) => b.kind === "reveal").every((b) => b.channel === "telegram")).toBe(true);
    // idempotent: a third run writes nothing new
    const r3 = await runReconcile(env);
    expect(r3).toMatchObject({ reveals_posted: 0, reconciliations: 0 });
    expect(h.db.tables.reconciliations).toHaveLength(2);
  });

  it("a settled market's entitled followers get shadow.revealed: queued with the settle, first attempt on what the run has left", async () => {
    const early = committed("UNRESOLVED", "NONE", "n1"), late = committed("RESOLVED", "OPTION_A", "n2");
    const hooks: Array<Record<string, any>> = [];
    const upstream = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://hooks.example/")) { hooks.push(JSON.parse(String(init!.body))); return new Response("ok", { status: 200 }); }
      return upstream(url, init);
    });
    h.db = newDb({
      markets: [market("m1"), market("m2")],
      watches: [watch("w1", "m1"), watch("w2", "m2")],
      bot_posts: [
        await commitRow("c1", "m1", "2026-09-20T00:00:00.000Z", early, 11), await commitRow("c2", "m1", "2026-09-21T00:00:00.000Z", late, 12),
        await commitRow("c3", "m2", "2026-09-21T00:00:00.000Z", committed("RESOLVED", "OPTION_A", "n3"), 13),
      ],
      // t1 pays as it goes; t2 is an evaluation whose only key expired yesterday: its follow ended with the key
      tenants: [{ id: "t1", plan: "payg", deleted_at: null }, { id: "t2", plan: "free", deleted_at: null }],
      api_keys: [{ id: "k2", tenant_id: "t2", revoked_at: null, deleted_at: null, expires_at: new Date(Date.now() - 86_400_000).toISOString() }],
      market_follows: [
        { id: "f1", tenant_id: "t1", market_id: "m1", created_at: "2026-09-19T00:00:00.000Z", deleted_at: null },
        { id: "f2", tenant_id: "t2", market_id: "m1", created_at: "2026-09-19T00:00:00.000Z", deleted_at: null },
      ],
      webhook_endpoints: [
        { id: "e1", tenant_id: "t1", url: "https://hooks.example/e1", secret: "whsec_test", active: true, deleted_at: null, consecutive_failures: 0, events: ["shadow.revealed"] },
        { id: "e2", tenant_id: "t2", url: "https://hooks.example/e2", secret: "whsec_test", active: true, deleted_at: null, consecutive_failures: 0, events: ["shadow.revealed"] },
      ],
      webhook_deliveries: [],
    });
    const r = await runReconcile(env);
    expect(r).toMatchObject({ resolved: 2, shadow_revealed_queued: 1, errors: [] });
    expect(h.db.tables.webhook_deliveries!.map((d) => [d.endpoint_id, d.event_type, d.status, d.attempt])).toEqual([["e1", "shadow.revealed", "delivered", 1]]);
    expect(hooks).toHaveLength(1);
    const data = hooks[0]!.data;
    expect(data).toMatchObject({ market: "limitless:slug-m1", agreement: "agree", official: { outcome: "OPTION_A", label: "Yes", at_source: "limitless_api_poll" } });
    expect(data.commits.map((c: Record<string, unknown>) => [c.agreement, c.final, c.preimage])).toEqual([["abstained", false, early.preimage], ["agree", true, late.preimage]]);
    for (const c of data.commits) expect(await sha256Hex(c.preimage)).toBe(c.commitment_sha256);
    expect(r.subrequests).toBeLessThanOrEqual(RECONCILE_SUBREQUESTS);
    // m2 has no follower: its settle spent one follows read and queued nothing
    expect(h.db.calls.filter((c) => c.table === "rpc:follow_entitlements")).toHaveLength(2);
  });

  it("the four-request write this replaced collides on uq_reconciliations_final once a newer commit exists", async () => {
    // ON CONFLICT (resolution_id) DO NOTHING covers only that index: the new final r3 meets the old final r2 (reproduced
    // on Postgres 16 by the review; the fake enforces the same partial unique index)
    h.db = newDb({ reconciliations: [{ resolution_id: "r1", market_id: "m", final: false }, { resolution_id: "r2", market_id: "m", final: true }] });
    const rows = [{ resolution_id: "r1", market_id: "m", final: false }, { resolution_id: "r2", market_id: "m", final: false }, { resolution_id: "r3", market_id: "m", final: true }];
    const { error } = await h.db.client.from("reconciliations").upsert(rows, { onConflict: "resolution_id", ignoreDuplicates: true });
    expect(error).toMatchObject({ code: "23505" });
    expect(error.message).toContain("uq_reconciliations_final");
  });

  it("moves the final to a commit that landed after an earlier partial settle (uq_reconciliations_final never collides)", async () => {
    // An earlier Worker wrote the reconciliations with final on c2, then failed before the market status; c3 landed since.
    h.db = newDb({
      markets: [market("m1")],
      watches: [watch("w1", "m1")],
      bot_posts: [
        await commitRow("c1", "m1", "2026-09-20T00:00:00.000Z", committed("UNRESOLVED", "NONE", "n1"), 11),
        await commitRow("c2", "m1", "2026-09-21T00:00:00.000Z", committed("UNRESOLVED", "NONE", "n2"), 12),
        await commitRow("c3", "m1", "2026-09-22T00:00:00.000Z", committed("RESOLVED", "OPTION_A", "n3"), 13),
      ],
      reconciliations: [
        { resolution_id: "res-c1", market_id: "m1", agreement: "abstained", final: false, official_at: "2026-09-23T00:00:00.000Z" },
        { resolution_id: "res-c2", market_id: "m1", agreement: "abstained", final: true, official_at: "2026-09-23T00:00:00.000Z" },
      ],
    });
    const r = await runReconcile(env);
    expect(r).toMatchObject({ resolved: 1, reconciliations: 3, reveals_recorded: 3, errors: [] });
    expect(h.db.tables.reconciliations!.map((x) => [x.resolution_id, x.final])).toEqual([["res-c1", false], ["res-c2", false], ["res-c3", true]]);
    expect(h.db.tables.reconciliations![0]!.official_at).toBe("2026-09-23T00:00:00.000Z"); // an existing row keeps its first observation
    expect(h.db.tables.markets![0]!.status).toBe("resolved");
    expect(h.db.tables.bot_posts!.filter((b) => b.kind === "reveal").map((b) => b.dedup_key)).toEqual(["reveal:c1", "reveal:c2", "reveal:c3"]);
  });

  it("a failed settle write is alerted, rolled back, and rescheduled with backoff", async () => {
    const broken = async () => ({ data: null, error: { code: "23514", message: "new row violates check constraint \"reconciliations_agreement_check\"" } });
    h.db = newDb({ markets: [market("m1")], watches: [watch("w1", "m1")], bot_posts: [await commitRow("c1", "m1", "2026-09-20T00:00:00.000Z", committed("RESOLVED", "OPTION_A"), 11)] }, { ...RECONCILE_RPCS, settle_market: broken });
    const before = Date.now();
    const r = await runReconcile(env);
    expect(r.errors.join()).toContain("settle_market: new row violates check constraint");
    expect(alerts()).toEqual([["reconcile_write_m1", 1440]]);
    expect(h.db.tables.reconciliations).toHaveLength(0);
    const m = h.db.tables.markets![0]!;
    expect(m).toMatchObject({ status: "open", reconcile_attempts: 1 });
    expect(Date.parse(m.reconcile_next_at) - before).toBeGreaterThanOrEqual(600_000);
    expect(h.db.tables.loop_runs![0]).toMatchObject({ outcome: "failure", verifier_ok: false });
  });

  it("a failed discovery read is alerted", async () => {
    h.db = newDb({});
    const from = h.db.client.from;
    h.db.client.from = (t: string) => (t === "markets" ? ({ select: () => { const q: any = { is: () => q, eq: () => q, in: () => q, lte: () => q, order: () => q, limit: async () => ({ data: null, error: { message: "canceling statement due to statement timeout" } }) }; return q; } }) : from(t)) as never;
    const r = await runReconcile(env);
    expect(r.errors).toEqual(["markets: canceling statement due to statement timeout"]);
    expect(alerts()).toEqual([["reconcile_discovery", 60]]);
  });

  it("a commit that lands between the plan and the write stops the settle; the next run includes it", async () => {
    let raced = false;
    const racing = async (db: FakeDb, a: Record<string, any>) => {
      if (!raced) { raced = true; db.tables.bot_posts!.push(await commitRow("c2", "m1", "2026-09-21T00:00:00.000Z", committed("RESOLVED", "OPTION_A", "n2"), 12)); }
      return settleMarket(db, a);
    };
    h.db = newDb({ markets: [market("m1")], watches: [watch("w1", "m1")], bot_posts: [await commitRow("c1", "m1", "2026-09-20T00:00:00.000Z", committed("UNRESOLVED", "NONE", "n1"), 11)] }, { ...RECONCILE_RPCS, settle_market: racing });
    const r1 = await runReconcile(env);
    expect(r1).toMatchObject({ resolved: 0, settle_retried: 1, reconciliations: 0 });
    expect(h.db.tables.reconciliations).toHaveLength(0);
    expect(h.db.tables.markets![0]!.status).toBe("open");
    expect(h.db.tables.watches![0]!.active).toBe(false); // no further commit can start
    const r2 = await runReconcile(env);
    expect(r2).toMatchObject({ resolved: 1, reconciliations: 2 });
    expect(h.db.tables.reconciliations!.find((x) => x.final)!.resolution_id).toBe("res-c2");
  });

  it("25 markets that stay open never starve a newer one", async () => {
    limitless = (slug) => (slug === "slug-new" ? RESOLVED_YES() : { ...FIX.single_clob, markets: [] }); // group containers: unmappable
    const old = Array.from({ length: 25 }, (_, i) => market(`o${String(i).padStart(2, "0")}`, { deadline_utc: new Date(Date.now() - 10 * 86_400_000).toISOString(), reconcile_next_at: new Date(Date.now() - 9 * 86_400_000).toISOString() }));
    h.db = newDb({ markets: [...old, market("new")], bot_posts: [await commitRow("cn", "new", "2026-09-20T00:00:00.000Z", committed("RESOLVED", "OPTION_A"), 11)] });
    let runs = 0;
    while (h.db.tables.markets!.find((m) => m.id === "new")!.status === "open" && runs < 8) { await runReconcile(env); runs++; }
    expect(h.db.tables.markets!.find((m) => m.id === "new")!.status).toBe("resolved");
    const deferred = h.db.tables.markets!.filter((m) => m.id !== "new");
    expect(deferred.every((m) => m.status === "open" && m.reconcile_attempts === 1 && Date.parse(m.reconcile_next_at) > Date.now())).toBe(true);
    expect(new Set(alerts().map((a) => a[0])).size).toBe(25); // each unmappable market alerted (daily dedup), none dropped
  });

  it("waits for the watch's post-deadline poll, then settles with the first sighting as official_at", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const deadline = Date.parse("2026-10-20T12:00:00.000Z");
    vi.setSystemTime(deadline + 30 * 60_000); // inside the 1 h grace: the absence verdict is not committed yet
    const iso = (ms: number) => new Date(ms).toISOString();
    h.db = newDb({
      markets: [market("m1", { deadline_utc: iso(deadline), reconcile_next_at: iso(deadline) })],
      watches: [watch("w1", "m1", { last_polled_at: iso(deadline + 29 * 60_000) })],
      bot_posts: [await commitRow("c1", "m1", iso(deadline - 3600_000), committed("UNRESOLVED", "NONE", "n1"), 11)],
    });
    const r1 = await runReconcile(env);
    expect(r1).toMatchObject({ awaiting_watch: 1, resolved: 0, reconciliations: 0 });
    expect(h.db.tables.watches![0]!.active).toBe(true);
    expect(h.db.tables.markets![0]).toMatchObject({ status: "open", official_first_seen_at: iso(deadline + 30 * 60_000), reconcile_next_at: iso(deadline + 40 * 60_000) });

    // the watch's first poll after deadline + grace commits the absence verdict
    vi.setSystemTime(deadline + 75 * 60_000);
    h.db.tables.bot_posts!.push(await commitRow("c2", "m1", iso(deadline + 66 * 60_000), committed("RESOLVED", "OPTION_A", "n2"), 12));
    h.db.tables.watches![0]!.last_polled_at = iso(deadline + 66 * 60_000);
    const r2 = await runReconcile(env);
    expect(r2).toMatchObject({ resolved: 1, reconciliations: 2 });
    const final = h.db.tables.reconciliations!.find((x) => x.final)!;
    expect(final).toMatchObject({ resolution_id: "res-c2", agreement: "agree", official_at: iso(deadline + 30 * 60_000) }); // not this run's clock
    expect(h.db.tables.watches![0]!.active).toBe(false);
  });

  it("a reveal never reaches the channel before its commit, then goes out as a reply", async () => {
    const fresh = new Date(Date.now() - 10_000).toISOString(); // younger than RETRY_AFTER_S: not re-posted this run
    h.db = newDb({ markets: [market("m1")], watches: [watch("w1", "m1")], bot_posts: [await commitRow("c1", "m1", fresh, committed("RESOLVED", "OPTION_A"), null)] });
    await runReconcile(env); // settles: the reveal row is recorded pending
    const r = await runReconcile(env);
    expect(r).toMatchObject({ reveals_posted: 0, reveals_waiting: 1 });
    expect(sent).toHaveLength(0);
    Object.assign(h.db.tables.bot_posts!.find((b) => b.id === "c1")!, { channel: "telegram", message_id: 55, telegram_date: fresh });
    const r2 = await runReconcile(env);
    expect(r2.reveals_posted).toBe(1);
    expect(sent.map((x) => x.reply_to_message_id)).toEqual([55]);
  });

  it("never reveals a commit whose preimage does not hash to its commitment", async () => {
    const row = await commitRow("c1", "m1", "2026-09-20T00:00:00.000Z", committed("RESOLVED", "OPTION_A"), 11);
    row.commitment_sha256 = "0".repeat(64);
    h.db = newDb({ markets: [market("m1")], watches: [watch("w1", "m1")], bot_posts: [row] });
    const r = await runReconcile(env);
    expect(r).toMatchObject({ resolved: 1, reconciliations: 1, reveals_recorded: 0 });
    expect(h.db.tables.bot_posts!.filter((b) => b.kind === "reveal")).toHaveLength(0);
    expect(alerts()).toEqual([["reveal_preimage_m1", 1440]]);
  });

  it("a label mismatch writes nothing, alerts, and leaves the market open", async () => {
    h.db = newDb({ markets: [market("m1", { option_a: "Team Nemesis", option_b: "Conventus Stellarum" })], bot_posts: [await commitRow("c1", "m1", "2026-09-20T00:00:00.000Z", committed("RESOLVED", "OPTION_A"), 11)] });
    const r = await runReconcile(env);
    expect(r).toMatchObject({ unmappable: 1, resolved: 0, reconciliations: 0, rescheduled: 1 });
    expect(h.db.tables.reconciliations).toHaveLength(0);
    expect(h.db.tables.markets![0]).toMatchObject({ status: "open", reconcile_attempts: 1 });
    expect(alerts()).toEqual([["reconcile_label_m1", 1440]]);
  });

  it("a disagreement is revealed like an agreement and alerted", async () => {
    h.db = newDb({ markets: [market("m1")], bot_posts: [await commitRow("c1", "m1", "2026-09-20T00:00:00.000Z", committed("RESOLVED", "OPTION_B"), 11)] });
    const r = await runReconcile(env);
    expect(r.disagreements).toBe(1);
    expect(h.db.tables.reconciliations![0]).toMatchObject({ agreement: "disagree", final: true });
    expect(h.db.tables.bot_posts!.some((b) => b.dedup_key === "reveal:c1")).toBe(true);
    expect(alerts()).toEqual([["reconcile_disagree_m1", 1440]]);
    expect(h.db.tables.loop_runs![0]!.verifier_ok).toBe(false);
  });

  it("no official outcome 21 days after the deadline closes the market as unresolved_by_platform", async () => {
    limitless = () => FIX.single_clob; // still unresolved
    const longAgo = new Date(Date.now() - 22 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    h.db = newDb({ markets: [market("old", { deadline_utc: longAgo }), market("new", { deadline_utc: recent })], watches: [watch("w", "old")], bot_posts: [await commitRow("c1", "old", "2026-09-01T00:00:00.000Z", committed("RESOLVED", "OPTION_A"), 11)] });
    const r = await runReconcile(env);
    expect(r).toMatchObject({ closed_out: 1, pending: 1 });
    expect(h.db.tables.reconciliations![0]).toMatchObject({ agreement: "unresolved_by_platform", final: true, official_outcome: null, official_at: null, lead_seconds: null });
    expect(h.db.tables.markets!.map((m) => m.status)).toEqual(["closed_unresolved", "open"]);
    expect(h.db.tables.markets![1]).toMatchObject({ reconcile_attempts: 0 }); // pending: rechecked in 10 minutes, no backoff
    expect(h.db.tables.watches![0]!.active).toBe(false);
    expect(h.db.tables.bot_posts!.find((b) => b.dedup_key === "reveal:c1")!.payload.agreement).toBe("unresolved_by_platform");
  });

  it("test markets are never selected", async () => {
    h.db = newDb({ markets: [market("t", { is_test: true })] });
    expect((await runReconcile(env)).checked).toBe(0);
    expect(fetches.filter((u) => u.includes("limitless"))).toHaveLength(0);
  });

  it("alerts when a commit is still unposted after 15 minutes", async () => {
    const stale = { ...(await commitRow("c1", "m1", new Date(Date.now() - 20 * 60_000).toISOString(), committed("RESOLVED", "OPTION_A"), null)), payload: { committed: committed("RESOLVED", "OPTION_A"), text: "t", post_error: "Forbidden" } };
    h.db = newDb({ bot_posts: [stale] });
    const failing = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "Forbidden: bot is not a member of the channel chat" }), { status: 403 }));
    vi.stubGlobal("fetch", failing);
    const r = await runReconcile(env);
    expect(r).toMatchObject({ retried: 1, retry_posted: 0 });
    expect(alerts()).toEqual([["unposted_commit", 60]]);
    expect(h.db.tables.bot_posts![0]!.payload.post_attempts).toBe(1);
  });

  it("stays inside one invocation's subrequest budget and never half-settles a market", async () => {
    const markets = Array.from({ length: 25 }, (_, i) => market(`m${String(i).padStart(2, "0")}`));
    const commits = [];
    for (const m of markets) for (let k = 0; k < 3; k++) commits.push(await commitRow(`${m.id}-c${k}`, m.id as string, `2026-09-2${k}T00:00:00.000Z`, committed("RESOLVED", k === 2 ? "OPTION_B" : "OPTION_A", `${m.id}${k}`), 100 + k));
    h.db = newDb({ markets, watches: markets.map((m) => watch(`w-${m.id}`, m.id as string)), bot_posts: commits });
    const r = await runReconcile(env);
    const used = h.db.calls.length + fetches.length + vi.mocked(alert).mock.calls.length * COST.alert;
    expect(r.stopped_by_budget).toBe(true);
    expect(used).toBeLessThanOrEqual(RECONCILE_SUBREQUESTS);
    expect(r.subrequests).toBeLessThanOrEqual(RECONCILE_SUBREQUESTS);
    // every market is either fully settled (3 rows, one final, resolved, watch off) or untouched
    for (const m of h.db.tables.markets!) {
      const rows = h.db.tables.reconciliations!.filter((x) => x.market_id === m.id);
      if (m.status === "resolved") {
        expect(rows).toHaveLength(3);
        expect(rows.filter((x) => x.final)).toHaveLength(1);
        expect(h.db.tables.watches!.find((w) => w.market_id === m.id)!.active).toBe(false);
      } else {
        expect(rows).toHaveLength(0);
      }
    }
    expect(r.resolved).toBeGreaterThan(0);
    expect(h.db.tables.loop_runs).toHaveLength(1);
  });
});

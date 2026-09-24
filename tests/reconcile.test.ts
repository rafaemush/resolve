/**
 * Reconcile (plan §16.4 P2 step 2, §17.3 P2a): strict label mapping (no positional fallback), the Limitless official
 * mapping on the real API shape, final-flag selection, and a full run against an in-memory database with a stubbed
 * Limitless API and Telegram: one agreement per market, reveals as replies, the 21-day close-out, and the subrequest
 * budget of one invocation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { MarketRow } from "../src/ingest/types";
import { fakeDb, type FakeDb } from "./lib/fake-db";
import LIMITLESS from "./fixtures/limitless-markets.json";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", () => ({ db: () => h.db.client }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { agreementFor, limitlessOfficial, limitlessSlug, mapOfficialLabel, planReconciliations, polymarketOfficial, runReconcile, RECONCILE_SUBREQUESTS, type CommitForPlan } from "../src/jobs/reconcile";
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

// ---- a full run -----------------------------------------------------------------------------------------------------

const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "-100" } as unknown as Env;
const PAST = new Date(Date.now() - 3 * 86_400_000).toISOString(); // past the deadline, inside the 21-day close-out

function market(id: string, over: Partial<MarketRow> = {}): Record<string, unknown> {
  return { id, tenant_id: null, deleted_at: null, is_test: false, status: "open", platform: "limitless", external_id: `slug-${id}`, meta: {}, option_a: "Yes", option_b: "No", deadline_utc: PAST, ...over };
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

  beforeEach(() => {
    fetches = []; sent = [];
    limitless = () => ({ ...FIX.single_clob, status: "RESOLVED", expired: true, winningOutcomeIndex: 0 });
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
  afterEach(() => vi.unstubAllGlobals());

  it("resolves a Limitless market: one agreement per market, reveals as replies next run, watches off", async () => {
    const early = committed("UNRESOLVED", "NONE", "n1"), late = committed("RESOLVED", "OPTION_A", "n2");
    h.db = fakeDb({
      markets: [market("m1")],
      watches: [{ id: "w1", market_id: "m1", active: true }],
      bot_posts: [await commitRow("c1", "m1", "2026-09-20T00:00:00.000Z", early, 11), await commitRow("c2", "m1", "2026-09-21T00:00:00.000Z", late, 12)],
      reconciliations: [], loop_runs: [],
    }, { bot_posts: ["dedup_key"], reconciliations: ["resolution_id"] });

    const r1 = await runReconcile(env);
    expect(r1).toMatchObject({ checked: 1, resolved: 1, reconciliations: 2, reveals_recorded: 2, reveals_posted: 0, errors: [] });
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

  it("a label mismatch writes nothing, alerts, and leaves the market open", async () => {
    h.db = fakeDb({ markets: [market("m1", { option_a: "Team Nemesis", option_b: "Conventus Stellarum" })], watches: [], bot_posts: [await commitRow("c1", "m1", "2026-09-20T00:00:00.000Z", committed("RESOLVED", "OPTION_A"), 11)], reconciliations: [], loop_runs: [] }, { bot_posts: ["dedup_key"] });
    const r = await runReconcile(env);
    expect(r).toMatchObject({ unmappable: 1, resolved: 0, reconciliations: 0 });
    expect(h.db.tables.reconciliations).toHaveLength(0);
    expect(h.db.tables.markets![0]!.status).toBe("open");
    expect(vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes])).toEqual([["reconcile_label_m1", 1440]]);
  });

  it("a disagreement is revealed like an agreement and alerted", async () => {
    h.db = fakeDb({ markets: [market("m1")], watches: [], bot_posts: [await commitRow("c1", "m1", "2026-09-20T00:00:00.000Z", committed("RESOLVED", "OPTION_B"), 11)], reconciliations: [], loop_runs: [] }, { bot_posts: ["dedup_key"], reconciliations: ["resolution_id"] });
    const r = await runReconcile(env);
    expect(r.disagreements).toBe(1);
    expect(h.db.tables.reconciliations![0]).toMatchObject({ agreement: "disagree", final: true });
    expect(h.db.tables.bot_posts!.some((b) => b.dedup_key === "reveal:c1")).toBe(true);
    expect(vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes])).toEqual([["reconcile_disagree_m1", 1440]]);
    expect(h.db.tables.loop_runs![0]!.verifier_ok).toBe(false);
  });

  it("no official outcome 21 days after the deadline closes the market as unresolved_by_platform", async () => {
    limitless = () => FIX.single_clob; // still unresolved
    const longAgo = new Date(Date.now() - 22 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    h.db = fakeDb({ markets: [market("old", { deadline_utc: longAgo }), market("new", { deadline_utc: recent })], watches: [{ id: "w", market_id: "old", active: true }], bot_posts: [await commitRow("c1", "old", "2026-09-01T00:00:00.000Z", committed("RESOLVED", "OPTION_A"), 11)], reconciliations: [], loop_runs: [] }, { bot_posts: ["dedup_key"], reconciliations: ["resolution_id"] });
    const r = await runReconcile(env);
    expect(r).toMatchObject({ closed_out: 1, pending: 1 });
    expect(h.db.tables.reconciliations![0]).toMatchObject({ agreement: "unresolved_by_platform", final: true, official_outcome: null, official_at: null, lead_seconds: null });
    expect(h.db.tables.markets!.map((m) => m.status)).toEqual(["closed_unresolved", "open"]);
    expect(h.db.tables.watches![0]!.active).toBe(false);
    expect(h.db.tables.bot_posts!.find((b) => b.dedup_key === "reveal:c1")!.payload.agreement).toBe("unresolved_by_platform");
  });

  it("test markets are never selected", async () => {
    h.db = fakeDb({ markets: [market("t", { is_test: true })], watches: [], bot_posts: [], reconciliations: [], loop_runs: [] });
    expect((await runReconcile(env)).checked).toBe(0);
    expect(fetches.filter((u) => u.includes("limitless"))).toHaveLength(0);
  });

  it("alerts when a commit is still unposted after 15 minutes", async () => {
    const stale = { ...(await commitRow("c1", "m1", new Date(Date.now() - 20 * 60_000).toISOString(), committed("RESOLVED", "OPTION_A"), null)), payload: { committed: committed("RESOLVED", "OPTION_A"), text: "t", post_error: "Forbidden" } };
    h.db = fakeDb({ markets: [], watches: [], bot_posts: [stale], reconciliations: [], loop_runs: [] });
    const failing = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "Forbidden: bot is not a member of the channel chat" }), { status: 403 }));
    vi.stubGlobal("fetch", failing);
    const r = await runReconcile(env);
    expect(r).toMatchObject({ retried: 1, retry_posted: 0 });
    expect(vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes])).toEqual([["unposted_commit", 60]]);
    expect(h.db.tables.bot_posts![0]!.payload.post_attempts).toBe(1);
  });

  it("stays inside one invocation's subrequest budget and never half-settles a market", async () => {
    const markets = Array.from({ length: 25 }, (_, i) => market(`m${String(i).padStart(2, "0")}`));
    const commits = [];
    for (const m of markets) for (let k = 0; k < 3; k++) commits.push(await commitRow(`${m.id}-c${k}`, m.id as string, `2026-09-2${k}T00:00:00.000Z`, committed("RESOLVED", k === 2 ? "OPTION_B" : "OPTION_A", `${m.id}${k}`), 100 + k));
    h.db = fakeDb({ markets, watches: markets.map((m) => ({ id: `w-${m.id}`, market_id: m.id, active: true })), bot_posts: commits, reconciliations: [], loop_runs: [] }, { bot_posts: ["dedup_key"], reconciliations: ["resolution_id"] });
    const r = await runReconcile(env);
    const alerts = vi.mocked(alert).mock.calls.length;
    const used = h.db.calls.length + fetches.length + alerts * COST.alert;
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

/**
 * Reconcile x the Limitless recorder (migration 018, src/jobs/limitless-recorder.ts): a Limitless market's official_at is
 * the earliest sighting of its outcome, the recorder's included, read in one batched select per run; a platform
 * timestamp is never replaced; a recorder read that fails holds the Limitless market instead of settling it with a
 * possibly later time, and is alerted (every run would hold it again).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { MarketRow } from "../src/ingest/types";
import { fakeDb, type FakeDb } from "./lib/fake-db";
import { RECONCILE_RPCS, RECONCILIATION_FINAL } from "./lib/fake-rpcs";
import { POST_RPCS } from "./lib/fake-post-rpcs";
import LIMITLESS from "./fixtures/limitless-markets.json";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, client: null as unknown }));
vi.mock("../src/db/supabase", () => ({ db: () => h.client ?? h.db.client }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { runReconcile, withFirstSeen, withRecorderSeen, type OfficialState } from "../src/jobs/reconcile";
import { alert } from "../src/ops/alerts";
import { buildPreimage, committedFields, type CommittedVerdict } from "../src/bot/commit";
import { sha256Hex } from "../src/resolve/text";
import type { Verdict } from "../src/resolve/schema";

const FIX = LIMITLESS as Record<string, any>;
const NOW = "2026-10-20T12:00:00.000Z";

describe("withRecorderSeen", () => {
  const poll: OfficialState = { kind: "resolved", official: { outcome: "OPTION_A", label: "Yes", at: NOW, at_source: "limitless_api_poll", source_url: null }, detail: "" };
  it("the recorder's earlier first sighting wins; a later one never moves official_at forward", () => {
    expect(withRecorderSeen(poll, "2026-10-20T11:40:00.000Z")).toMatchObject({ official: { at: "2026-10-20T11:40:00.000Z", at_source: "limitless_api_poll" } });
    expect(withRecorderSeen(poll, "2026-10-20T12:10:00.000Z")).toBe(poll);
    expect(withRecorderSeen(poll, NOW)).toBe(poll);
  });
  it("the earliest of this run, the stored first sighting and the recorder", () => {
    const stored = withFirstSeen(poll, "2026-10-20T11:50:00.000Z");
    expect(withRecorderSeen(stored, "2026-10-20T11:55:00.000Z")).toMatchObject({ official: { at: "2026-10-20T11:50:00.000Z" } });
    expect(withRecorderSeen(stored, "2026-10-20T11:30:00.000Z")).toMatchObject({ official: { at: "2026-10-20T11:30:00.000Z" } });
  });
  it("only a resolved, poll-observed Limitless time; nothing, garbage or a platform timestamp is left alone", () => {
    expect(withRecorderSeen(poll, null)).toBe(poll);
    expect(withRecorderSeen(poll, "not a time")).toBe(poll);
    const gamma: OfficialState = { ...poll, official: { ...poll.official, at_source: "gamma_closed_time" } };
    expect(withRecorderSeen(gamma, "2026-10-20T11:00:00.000Z")).toBe(gamma);
    const pending: OfficialState = { kind: "pending", source_url: "x", detail: "" };
    expect(withRecorderSeen(pending, "2026-10-20T11:00:00.000Z")).toBe(pending);
  });
});

// ---- runs ------------------------------------------------------------------------------------------------------------

const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "-100" } as unknown as Env;
const PAST = new Date(Date.now() - 3 * 86_400_000).toISOString();

function committed(status: Verdict["resolution_status"], outcome: Verdict["winning_outcome"], nonce = "n"): CommittedVerdict {
  const v = { resolution_status: status, winning_outcome: outcome, confidence_score: 0.95, caveats: [], evidence: null, thresholds_version: "v1", determination_basis: "structured" } as unknown as Verdict;
  const fields = committedFields(v);
  return { preimage_version: "v2", preimage: buildPreimage("limitless:m", fields, nonce), ...fields };
}
function market(id: string, over: Partial<MarketRow> = {}): Record<string, unknown> {
  return { id, tenant_id: null, deleted_at: null, is_test: false, status: "open", platform: "limitless", external_id: `slug-${id}`, meta: {}, option_a: "Yes", option_b: "No", deadline_utc: PAST, grace_seconds: 3600, reconcile_next_at: PAST, reconcile_attempts: 0, official_first_seen_at: null, ...over };
}
async function commitRow(id: string, marketId: string, c: CommittedVerdict): Promise<Record<string, unknown>> {
  return {
    id, market_id: marketId, resolution_id: `res-${id}`, kind: "commit", channel: "telegram", message_id: 11, created_at: "2026-09-20T00:00:00.000Z",
    telegram_date: "2026-09-20T00:00:00.000Z", commitment_sha256: await sha256Hex(c.preimage), nonce: "n", payload: { committed: c }, dedup_key: `commit:${marketId}:${id}`, resolutions: null,
  };
}

describe("runReconcile with recorder sightings", () => {
  let fetches: string[];
  beforeEach(() => {
    fetches = [];
    h.client = null;
    vi.mocked(alert).mockClear();
    vi.stubGlobal("fetch", async (url: string) => {
      fetches.push(String(url));
      if (String(url).startsWith("https://api.limitless.exchange/markets/")) return new Response(JSON.stringify({ ...FIX.single_clob, status: "RESOLVED", expired: true, winningOutcomeIndex: 0 }), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const newDb = async (recorder: Array<Record<string, unknown>>) => fakeDb({
    markets: [market("m1", { meta: { limitless_slug: "the-leg" } })], watches: [], reconciliations: [], loop_runs: [],
    bot_posts: [await commitRow("c1", "m1", committed("RESOLVED", "OPTION_A"))], limitless_markets: recorder,
  }, { bot_posts: ["dedup_key"], reconciliations: ["resolution_id"] }, { partialUnique: RECONCILIATION_FINAL, rpc: { ...RECONCILE_RPCS, ...POST_RPCS } });

  it("settles with the recorder's earlier first sighting, labelled limitless_api_poll, in one batched read", async () => {
    const seen = new Date(Date.parse(PAST) + 40 * 60_000).toISOString(); // 40 min after the deadline, days before this run
    h.db = await newDb([{ slug: "the-leg", resolved_seen_at: seen }, { slug: "other", resolved_seen_at: "2026-09-01T00:00:00.000Z" }]);
    const r = await runReconcile(env);
    expect(r).toMatchObject({ resolved: 1, errors: [] });
    expect(h.db.calls.filter((c) => c.table === "limitless_markets")).toEqual([{ table: "limitless_markets", action: "select" }]);
    expect(h.db.tables.reconciliations![0]).toMatchObject({ official_at: seen, official_at_source: "limitless_api_poll", lead_seconds: Math.round((Date.parse(seen) - Date.parse("2026-09-20T00:00:00.000Z")) / 1000) });
    expect(fetches).toEqual(["https://api.limitless.exchange/markets/the-leg"]);
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
  });

  it("no recorder sighting yet: reconcile's own observation stands", async () => {
    h.db = await newDb([{ slug: "the-leg", resolved_seen_at: null }]);
    const before = Date.now();
    await runReconcile(env);
    expect(Date.parse(h.db.tables.reconciliations![0]!.official_at)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("a recorder read that fails holds the Limitless market (no GET, no settle, due again at once), alerts and fails the run", async () => {
    h.db = await newDb([]);
    const base = h.db.client;
    h.client = { ...base, from: (t: string) => (t === "limitless_markets" ? { select: () => ({ in: async () => ({ data: null, error: { message: "relation limitless_markets does not exist" } }) }) } : base.from(t)) };
    const r = await runReconcile(env);
    expect(r.errors).toEqual(["recorder sightings: relation limitless_markets does not exist"]);
    expect(r).toMatchObject({ checked: 0, resolved: 0, rescheduled: 1 });
    expect(fetches).toEqual([]);
    expect(h.db.tables.reconciliations).toHaveLength(0);
    expect(h.db.tables.markets![0]).toMatchObject({ status: "open", reconcile_attempts: 0 });
    expect(h.db.tables.loop_runs![0]!.outcome).toBe("failure");
    const calls = vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes]);
    expect(calls).toEqual([["reconcile_recorder_read", 360]]);
    expect(vi.mocked(alert).mock.calls[0]![2]).toContain("1 due Limitless market(s) are held");
  });
});

/**
 * Commit-reveal (plan §16.4 P2 step 1, §17.3 P2a): preimage v2 recomputed by a third party from the reveal text alone,
 * the public confidence floor (counted by distinct event since migration 017), insert-first ordering, dedup against the
 * market's latest commit only (A -> B -> A is committed again), the legs of an event left to the channel poster, the
 * channel lease and pacing on the inline post, and v1 fallbacks. The channel poster itself: tests/post.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Verdict } from "../src/resolve/schema";
import type { MarketRow } from "../src/ingest/types";
import { fakeDb, type FakeDb } from "./lib/fake-db";
import { POST_RPCS } from "./lib/fake-post-rpcs";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", () => ({ db: () => h.db.client }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { applyPublicFloor, buildPreimage, buildReveal, commitDedupKey, commitVerdict, committedFields, committedOf, floorCandidate, MARKET_NOT_OPEN_SQLSTATE, PUBLIC_FLOOR, type CommittedVerdict, type OfficialRecord } from "../src/bot/commit";
import { PACE } from "../src/bot/channel";
import { alert } from "../src/ops/alerts";
import { sha256Hex } from "../src/resolve/text";

const CANON = "c".repeat(64), RAW = "d".repeat(64);
const MARKET = { id: "22222222-2222-4222-8222-222222222222", platform: "limitless", external_id: "will-x-happen-1790000000000", option_a: "Yes", option_b: "No", status: "open", is_test: false, event_key: "limitless:will-x-happen-1790000000000" } as unknown as MarketRow;
/** A markets row as commit_context() reads it. */
const marketRow = (id: string, eventKey: string, over: Record<string, unknown> = {}) => ({ id, platform: "limitless", external_id: id, status: "open", is_test: false, tenant_id: null, deleted_at: null, event_key: eventKey, ...over });

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    market_id: MARKET.id, resolution_status: "RESOLVED", winning_outcome: "OPTION_A", confidence_score: 0.93, error_code: null, error_reason: null,
    caveats: ["claimed_at_display_only"], determination_basis: "jev", checks: [], jev_model: "jev-1.13.0", thresholds_version: "v1", latency_ms: 800,
    evidence: { raw_sha256: RAW, canonical_sha256: CANON, source_url: "https://example.org/a", source_kind: "web_fetch", observed_at: "2026-10-01T00:00:00.000Z", claimed_at: null, quote: null },
    ...over,
  };
}

/** What a third party does with nothing but the reveal post: take the preimage line, hash it, compare. */
function recomputeFromText(text: string): { preimage: string; commitment: string; nonce: string } {
  const line = (prefix: string) => text.split("\n").find((l) => l.startsWith(prefix))!.slice(prefix.length);
  return { preimage: line("preimage "), commitment: line("commitment sha256 "), nonce: line("nonce ") };
}

describe("preimage v2", () => {
  it("is recomputable from the reveal text alone and names the market publicly", async () => {
    const fields = committedFields(verdict({ confidence_score: 0.934 }));
    const nonce = "0123456789abcdef01234567";
    const preimage = buildPreimage(`${MARKET.platform}:${MARKET.external_id}`, fields, nonce);
    expect(preimage).toBe(`limitless:will-x-happen-1790000000000|RESOLVED|OPTION_A|0.93|claimed_at_display_only|${CANON}|v1|${nonce}`);
    const commitment = await sha256Hex(preimage);
    const committed: CommittedVerdict = { preimage_version: "v2", preimage, ...fields };
    const official: OfficialRecord = { outcome: "OPTION_A", label: "Yes", at: "2026-10-02T00:00:00.000Z", at_source: "limitless_api_poll", source_url: "https://limitless.exchange/markets/will-x-happen-1790000000000" };
    const { text, payload } = buildReveal(MARKET, { id: "c1", commitment_sha256: commitment, nonce }, committed, official, "agree");
    const got = recomputeFromText(text);
    expect(await sha256Hex(got.preimage)).toBe(got.commitment);
    expect(got.commitment).toBe(commitment);
    expect(got.preimage.endsWith(`|${got.nonce}`)).toBe(true);
    expect(text).toContain("market limitless:will-x-happen-1790000000000");
    expect(text).toContain("-> agree");
    expect(payload).toMatchObject({ commit_id: "c1", agreement: "agree", committed: { preimage } });
  });

  it("a close-out reveal says the platform published no outcome", () => {
    const fields = committedFields(verdict());
    const committed: CommittedVerdict = { preimage_version: "v2", preimage: buildPreimage("limitless:x", fields, "n"), ...fields };
    const { text } = buildReveal(MARKET, { id: "c1", commitment_sha256: "0".repeat(64), nonce: "n" }, committed, { outcome: null, label: null, at: null, at_source: null, source_url: null }, "unresolved_by_platform");
    expect(text).toContain("official none");
    expect(text).toContain("unresolved_by_platform");
  });

  it("v1 commits fall back to the resolutions row and the v1 preimage (market uuid first)", async () => {
    const nonce = "abc";
    const resolution = { resolution_status: "RESOLVED" as const, winning_outcome: "OPTION_B" as const, confidence_score: "0.91", caveats: ["x"], thresholds_version: "v1", determination_basis: "structured" as const };
    const c = committedOf({ id: "c1", market_id: MARKET.id, nonce, commitment_sha256: "", payload: { canonical_sha256: CANON, evidence_raw_sha256: "n/a" } }, resolution)!;
    expect(c.preimage_version).toBe("v1");
    // exactly the string the v1 commitVerdict hashed: `${market.id}|status|outcome|conf|caveats|canonical|thresholds|nonce`
    expect(c.preimage).toBe(`${MARKET.id}|RESOLVED|OPTION_B|0.91|x|${CANON}|v1|abc`);
    expect(c.raw_sha256).toBeNull();
    expect(committedOf({ id: "c1", market_id: MARKET.id, nonce, commitment_sha256: "", payload: {} }, null)).toBeNull();
  });

  it("payload.committed wins over the resolutions row", () => {
    const fields = committedFields(verdict());
    const committed: CommittedVerdict = { preimage_version: "v2", preimage: "p", ...fields };
    const r = committedOf({ id: "c1", market_id: MARKET.id, nonce: "n", commitment_sha256: "", payload: { committed } }, { resolution_status: "ERROR", winning_outcome: "NONE", confidence_score: 0, caveats: [], thresholds_version: "v1", determination_basis: null });
    expect(r).toEqual(committed);
  });
});

describe("public confidence floor (plan §17.3 P2a)", () => {
  const jev = (c: number, over: Partial<Verdict> = {}) => committedFields(verdict({ confidence_score: c, ...over }));

  it("commits a Jev RESOLVED below 0.90 as UNRESOLVED/NONE with the caveat during the first 100 public commits", () => {
    const out = applyPublicFloor(jev(0.85), 0);
    expect(out).toMatchObject({ resolution_status: "UNRESOLVED", winning_outcome: "NONE", confidence_score: 0.85, determination_basis: "jev" });
    expect(out.caveats).toEqual(["claimed_at_display_only", PUBLIC_FLOOR.caveat]);
    expect(applyPublicFloor(jev(0.89), 99).resolution_status).toBe("UNRESOLVED");
  });

  it("leaves everything else alone", () => {
    expect(applyPublicFloor(jev(0.85), 100).resolution_status).toBe("RESOLVED");          // floor lifted after 100
    expect(applyPublicFloor(jev(0.9), 0).resolution_status).toBe("RESOLVED");             // at the floor
    expect(applyPublicFloor(jev(0.85, { determination_basis: "structured" }), 0).resolution_status).toBe("RESOLVED");
    const unresolved = jev(0.5, { resolution_status: "UNRESOLVED", winning_outcome: "NONE" });
    expect(applyPublicFloor(unresolved, 0)).toBe(unresolved);
    expect(floorCandidate(jev(0.85))).toBe(true);
    expect(floorCandidate(jev(0.95))).toBe(false);
  });

  it("never duplicates the caveat", () => {
    const once = applyPublicFloor(jev(0.8), 0);
    expect(applyPublicFloor({ ...once, resolution_status: "RESOLVED", winning_outcome: "OPTION_A" }, 0).caveats.filter((c) => c === PUBLIC_FLOOR.caveat)).toHaveLength(1);
  });
});

describe("commitVerdict: insert first, then post, then the receipt", () => {
  const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "-100" } as unknown as Env;
  let sent: Array<Record<string, unknown>>;
  let telegramOk: boolean;
  // Only ever forward: sendMessage's throttle remembers the last send across tests.
  let clock = Date.parse("2026-10-01T12:00:00.000Z");
  /** Each commit a few seconds after the previous one, as separate invocations are (created_at orders the commits). */
  const tick = () => { clock += 5000; vi.setSystemTime(clock); };
  const commits = () => h.db.tables.bot_posts!.filter((b) => b.kind === "commit");

  beforeEach(() => {
    h.db = fakeDb({ bot_posts: [], markets: [marketRow(MARKET.id, MARKET.event_key!)] }, { bot_posts: ["dedup_key"] }, { rpc: POST_RPCS });
    sent = [];
    telegramOk = true;
    clock += 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock);
    vi.mocked(alert).mockClear();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (!String(url).startsWith("https://api.telegram.org/")) throw new Error(`unexpected fetch ${url}`);
      // the row must already exist when the post goes out
      expect(h.db.tables.bot_posts!.length).toBeGreaterThan(0);
      sent.push(JSON.parse(String(init.body)));
      return telegramOk
        ? new Response(JSON.stringify({ ok: true, result: { message_id: 76 + sent.length, date: Math.floor(Date.now() / 1000) } }), { status: 200 })
        : new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 });
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("records a pending row, posts it under the channel lease, then fills only the delivery columns", async () => {
    const r = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    expect(r).toMatchObject({ committed: true, posted: true, reason: "posted" });
    expect(h.db.calls.map((c) => `${c.table}.${c.action}`)).toEqual(["rpc:commit_context.rpc", "bot_posts.insert", "rpc:claim_post_lease.rpc", "bot_posts.update", "rpc:release_post_lease.rpc"]);
    const row = h.db.tables.bot_posts![0]!;
    // what the private early reveal sends followers: the recorded row, its commitment and the committed verdict
    expect(r.commit).toEqual({ id: row.id, commitment_sha256: row.commitment_sha256, committed_at: row.created_at, committed: row.payload.committed });
    expect(row).toMatchObject({ kind: "commit", channel: "telegram", message_id: 77, dedup_key: commitDedupKey(MARKET.id, null), payload: { batched: false } });
    expect(row.telegram_date).toBe(new Date(Math.floor(clock / 1000) * 1000).toISOString());
    expect(row.posted_at).toBe(row.telegram_date);
    expect(row.payload.committed.preimage_version).toBe("v2");
    expect(await sha256Hex(row.payload.committed.preimage)).toBe(row.commitment_sha256);
    expect(String(sent[0]!.text)).toContain("market limitless:will-x-happen-1790000000000");
    expect(String(sent[0]!.text)).not.toContain(row.nonce); // the nonce stays private until the reveal
    expect(Date.parse(h.db.tables.post_leases![0]!.lease_until)).toBeLessThanOrEqual(Date.now()); // released
  });

  it("a failed post leaves the row pending with post_error and post_attempts", async () => {
    telegramOk = false;
    const r = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    expect(r.committed).toBe(true);
    expect(r.posted).toBe(false);
    expect(h.db.tables.bot_posts![0]).toMatchObject({ channel: "pending", message_id: null, posted_at: null, payload: { post_error: "Bad Request: chat not found", post_attempts: 1 } });
  });

  it("the latest commit's verdict signature is not committed again, whatever the confidence", async () => {
    await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    tick();
    const again = await commitVerdict(env, MARKET, "res2", verdict({ confidence_score: 0.97 }));
    expect(again).toEqual({ committed: false, posted: false, reason: "the market's latest commit already has this verdict signature" });
    expect(sent).toHaveLength(1);
  });

  it("A -> B -> A: a verdict that returns to an earlier signature is committed again and is the latest commit", async () => {
    const A = () => verdict({ confidence_score: 0.95, determination_basis: "structured" });
    const B = () => verdict({ resolution_status: "UNRESOLVED", winning_outcome: "NONE", confidence_score: 0.5, determination_basis: "structured", caveats: ["no_anchor"] });
    expect((await commitVerdict(env, MARKET, "r1", A())).committed).toBe(true);
    tick();
    expect((await commitVerdict(env, MARKET, "r2", B())).committed).toBe(true);
    tick();
    const back = await commitVerdict(env, MARKET, "r3", A());
    expect(back).toMatchObject({ committed: true, posted: true });
    const [c1, c2, c3] = commits();
    expect([c1!.dedup_key, c2!.dedup_key, c3!.dedup_key]).toEqual([commitDedupKey(MARKET.id, null), commitDedupKey(MARKET.id, c1!.id), commitDedupKey(MARKET.id, c2!.id)]);
    expect(commits().map((c) => c.payload.verdict_signature)).toEqual(["RESOLVED|OPTION_A|", "UNRESOLVED|NONE|", "RESOLVED|OPTION_A|"]);
    // the reconcile settles the latest commit (created_at, then id): the market's current verdict, A
    const latest = [...commits()].sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0]!;
    expect(latest.id).toBe(c3!.id);
    expect(sent.map((s) => String(s.text).includes(c3!.commitment_sha256))).toEqual([false, false, true]);
    tick();
    expect((await commitVerdict(env, MARKET, "r4", A())).committed).toBe(false); // A again right after A: deduped
  });

  it("a floored UNRESOLVED after a public RESOLVED is committed (the retraction reaches the channel), and RESOLVED again after it", async () => {
    expect((await commitVerdict(env, MARKET, "r1", verdict({ confidence_score: 0.95 }))).committed).toBe(true); // Jev >= 0.90: not floored
    tick();
    const floored = await commitVerdict(env, MARKET, "r2", verdict({ confidence_score: 0.85 }));
    expect(floored).toMatchObject({ committed: true, posted: true });
    expect(commits()[1]!.payload.committed).toMatchObject({ resolution_status: "UNRESOLVED", winning_outcome: "NONE", caveats: ["claimed_at_display_only", PUBLIC_FLOOR.caveat] });
    tick();
    expect((await commitVerdict(env, MARKET, "r3", verdict({ confidence_score: 0.86 }))).committed).toBe(false); // floored again = the latest
    tick();
    expect((await commitVerdict(env, MARKET, "r4", verdict({ confidence_score: 0.96 }))).committed).toBe(true);
    expect(commits().map((c) => c.payload.committed.resolution_status)).toEqual(["RESOLVED", "UNRESOLVED", "RESOLVED"]);
    expect(sent).toHaveLength(3);
  });

  it("a concurrent commit that lands after the read collides on the dedup key; the new verdict is compared with it", async () => {
    const other = async (signature: string) => {
      const real = h.db.client.rpc;
      let first = true;
      h.db.client.rpc = async (fn, args) => {
        const r = await real(fn, args);
        if (fn === "commit_context" && first) {
          first = false; // another invocation commits right after this one read "no commit yet"
          h.db.tables.bot_posts!.push({ id: `other-${signature}`, market_id: MARKET.id, kind: "commit", channel: "telegram", created_at: new Date(Date.now() + 1).toISOString(), dedup_key: commitDedupKey(MARKET.id, null), payload: { verdict_signature: signature } });
        }
        return r;
      };
    };
    await other("RESOLVED|OPTION_A|");
    const same = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    expect(same).toMatchObject({ committed: false, reason: "the market's latest commit already has this verdict signature" });
    expect(commits()).toHaveLength(1);

    h.db = fakeDb({ bot_posts: [], markets: [marketRow(MARKET.id, MARKET.event_key!)] }, { bot_posts: ["dedup_key"] }, { rpc: POST_RPCS });
    await other("UNRESOLVED|NONE|");
    const differs = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    expect(differs).toMatchObject({ committed: true });
    expect(commits().at(-1)!.dedup_key).toBe(commitDedupKey(MARKET.id, "other-UNRESOLVED|NONE|"));
  });

  it("applies the public floor to the committed verdict, not to the resolutions row", async () => {
    const r = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.85 }));
    expect(r.committed).toBe(true);
    const row = h.db.tables.bot_posts![0]!;
    expect(row.payload.committed).toMatchObject({ resolution_status: "UNRESOLVED", winning_outcome: "NONE", caveats: ["claimed_at_display_only", PUBLIC_FLOOR.caveat] });
    expect(row.payload.verdict_signature).toBe("UNRESOLVED|NONE|");
  });

  it("the floor counts distinct events: 100 commits on the legs of 10 ladders keep it; 100 events lift it", async () => {
    const seed = (events: number, legs: number) => {
      for (let e = 0; e < events; e++) for (let l = 0; l < legs; l++) {
        const id = `m${e}-${l}`;
        h.db.tables.markets!.push(marketRow(id, `polymarket:event:${e}`, { status: "resolved" }));
        h.db.tables.bot_posts!.push({ id: `p${e}-${l}`, market_id: id, kind: "commit", channel: "telegram", dedup_key: `old${e}-${l}`, created_at: "2026-09-01T00:00:00.000Z", payload: {} });
      }
    };
    seed(10, 10);
    await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.85 }));
    expect(commits().at(-1)!.payload.committed.resolution_status).toBe("UNRESOLVED");
    h.db = fakeDb({ bot_posts: [], markets: [marketRow(MARKET.id, MARKET.event_key!)] }, { bot_posts: ["dedup_key"] }, { rpc: POST_RPCS });
    seed(100, 1);
    await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.85 }));
    expect(commits().at(-1)!.payload.committed.resolution_status).toBe("RESOLVED");
  });

  it("a market whose event has another open leg is recorded pending, batched, and left to the channel poster", async () => {
    h.db.tables.markets!.push(marketRow("leg-2", MARKET.event_key!), marketRow("leg-closed", MARKET.event_key!, { status: "resolved" }), marketRow("leg-test", MARKET.event_key!, { is_test: true }));
    const r = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    expect(r).toMatchObject({ committed: true, posted: false });
    expect(r.reason).toContain(`event ${MARKET.event_key} has 1 other open market(s)`);
    expect(h.db.tables.bot_posts![0]).toMatchObject({ channel: "pending", payload: { batched: true } });
    expect(sent).toHaveLength(0);
    expect(h.db.calls.map((c) => c.table)).toEqual(["rpc:commit_context", "bot_posts"]); // no lease taken
  });

  it("the inline post waits for the poster when the channel is at its pacing ceiling or held by another poster", async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    h.db.tables.bot_posts!.push(...Array.from({ length: PACE.messages }, (_, i) => ({ id: `q${i}`, market_id: "x", kind: i % 2 ? "reveal" : "commit", channel: "telegram", message_id: 1000 + i, posted_at: recent, created_at: recent, dedup_key: `q${i}`, payload: {} })));
    const paced = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    expect(paced).toMatchObject({ committed: true, posted: false });
    expect(paced.reason).toContain("channel paced");
    expect(sent).toHaveLength(0);

    h.db = fakeDb({ bot_posts: [], markets: [marketRow(MARKET.id, MARKET.event_key!)], post_leases: [{ channel: "telegram_public", holder: "someone-else", lease_until: new Date(Date.now() + 30_000).toISOString() }] }, { bot_posts: ["dedup_key"] }, { rpc: POST_RPCS });
    const busy = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    expect(busy.reason).toContain("channel busy");
    expect(h.db.tables.bot_posts![0]).toMatchObject({ channel: "pending" });
    expect(sent).toHaveLength(0);
  });

  it("test markets are recorded with channel none and never posted", async () => {
    const r = await commitVerdict(env, { ...MARKET, is_test: true }, "res1", verdict({ confidence_score: 0.85 }));
    expect(r).toMatchObject({ committed: true, posted: false, reason: "test market: recorded, never posted" });
    expect(sent).toHaveLength(0);
    expect(h.db.tables.bot_posts![0]).toMatchObject({ channel: "none", posted_at: null });
    expect(h.db.tables.bot_posts![0]!.payload.committed.resolution_status).toBe("RESOLVED"); // no floor off the record
  });

  it("a market settled while the verdict was computed: nothing recorded, nothing posted, no alert (RS001)", async () => {
    h.db.client.from = () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: MARKET_NOT_OPEN_SQLSTATE, message: `market ${MARKET.id} is resolved: a commit is recorded only while its market is open` } }) }) }) }) as never;
    const r = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    expect(r).toMatchObject({ committed: false, posted: false });
    expect(r.reason).toContain("is resolved");
    expect(sent).toHaveLength(0);
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
  });

  it("an insert failure is alerted and nothing is posted", async () => {
    h.db.client.from = () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "57014", message: "statement timeout" } }) }) }) }) as never;
    const r = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    expect(r.committed).toBe(false);
    expect(sent).toHaveLength(0);
    expect(vi.mocked(alert).mock.calls[0]![1]).toBe(`commit_insert_${MARKET.id}`);
  });

  it("an unreadable latest commit is alerted and nothing is recorded (the dedup cannot be decided)", async () => {
    h.db.client.rpc = async () => ({ data: null, error: { code: "57014", message: "statement timeout" } });
    const r = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    expect(r).toMatchObject({ committed: false, posted: false });
    expect(h.db.tables.bot_posts).toHaveLength(0);
    expect(vi.mocked(alert).mock.calls[0]![1]).toBe(`commit_insert_${MARKET.id}`);
  });
});

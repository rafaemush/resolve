/**
 * Commit-reveal (plan §16.4 P2 step 1, §17.3 P2a): preimage v2 recomputed by a third party from the reveal text alone,
 * the public confidence floor, insert-first ordering, the retry selection and v1 fallbacks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Verdict } from "../src/resolve/schema";
import type { MarketRow } from "../src/ingest/types";
import { fakeDb, type FakeDb } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", () => ({ db: () => h.db.client }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { applyPublicFloor, buildPreimage, buildReveal, commitVerdict, committedFields, committedOf, floorCandidate, MARKET_NOT_OPEN_SQLSTATE, PUBLIC_FLOOR, retryCandidates, retryUnposted, type CommittedVerdict, type OfficialRecord } from "../src/bot/commit";
import { alert } from "../src/ops/alerts";
import { sha256Hex } from "../src/resolve/text";

const CANON = "c".repeat(64), RAW = "d".repeat(64);
const MARKET = { id: "22222222-2222-4222-8222-222222222222", platform: "limitless", external_id: "will-x-happen-1790000000000", option_a: "Yes", option_b: "No", status: "open", is_test: false } as unknown as MarketRow;

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

describe("retryCandidates (pure)", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const row = (id: string, secondsAgo: number, over: Record<string, unknown> = {}) => ({ id, kind: "commit", channel: "pending", created_at: new Date(now - secondsAgo * 1000).toISOString(), payload: {}, ...over });

  it("picks pending commits older than 60 s, oldest first, at most max", () => {
    const rows = [row("young", 30), row("b", 120), row("a", 600), row("posted", 900, { channel: "telegram" }), row("reveal", 900, { kind: "reveal" }), row("c", 61), row("d", 60)];
    expect(retryCandidates(rows, now, 5).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(retryCandidates(rows, now, 2).map((r) => r.id)).toEqual(["a", "b"]);
    expect(retryCandidates(rows, now, 0)).toEqual([]);
  });
});

describe("commitVerdict: insert first, then post, then the receipt", () => {
  const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "-100" } as unknown as Env;
  let sent: Array<Record<string, unknown>>;
  let telegramOk: boolean;

  beforeEach(() => {
    h.db = fakeDb({ bot_posts: [] }, { bot_posts: ["dedup_key"] });
    sent = [];
    telegramOk = true;
    vi.mocked(alert).mockClear();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (!String(url).startsWith("https://api.telegram.org/")) throw new Error(`unexpected fetch ${url}`);
      // the row must already exist when the post goes out
      expect(h.db.tables.bot_posts!.length).toBeGreaterThan(0);
      sent.push(JSON.parse(String(init.body)));
      return telegramOk
        ? new Response(JSON.stringify({ ok: true, result: { message_id: 77, date: 1790000000 } }), { status: 200 })
        : new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records a pending row, posts it, then fills only the delivery columns", async () => {
    const r = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    expect(r).toEqual({ committed: true, posted: true, reason: "posted" });
    expect(h.db.calls.map((c) => `${c.table}.${c.action}`)).toEqual(["bot_posts.insert", "bot_posts.update"]);
    const row = h.db.tables.bot_posts![0]!;
    expect(row).toMatchObject({ kind: "commit", channel: "telegram", message_id: 77, telegram_date: new Date(1790000000 * 1000).toISOString(), posted_at: new Date(1790000000 * 1000).toISOString() });
    expect(row.payload.committed.preimage_version).toBe("v2");
    expect(await sha256Hex(row.payload.committed.preimage)).toBe(row.commitment_sha256);
    expect(String(sent[0]!.text)).toContain("market limitless:will-x-happen-1790000000000");
    expect(String(sent[0]!.text)).not.toContain(row.nonce); // the nonce stays private until the reveal
  });

  it("a failed post leaves the row pending with post_error and post_attempts", async () => {
    telegramOk = false;
    const r = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    expect(r.committed).toBe(true);
    expect(r.posted).toBe(false);
    expect(h.db.tables.bot_posts![0]).toMatchObject({ channel: "pending", message_id: null, posted_at: null, payload: { post_error: "Bad Request: chat not found", post_attempts: 1 } });
  });

  it("the same verdict signature is committed once (unique dedup_key), with no second post", async () => {
    await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    const again = await commitVerdict(env, MARKET, "res2", verdict({ confidence_score: 0.97 }));
    expect(again).toEqual({ committed: false, posted: false, reason: "already committed for this verdict signature" });
    expect(sent).toHaveLength(1);
  });

  it("applies the public floor to the committed verdict, not to the resolutions row", async () => {
    const r = await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.85 }));
    expect(r.committed).toBe(true);
    const row = h.db.tables.bot_posts![0]!;
    expect(row.payload.committed).toMatchObject({ resolution_status: "UNRESOLVED", winning_outcome: "NONE", caveats: ["claimed_at_display_only", PUBLIC_FLOOR.caveat] });
    expect(row.dedup_key).toBe(`commit:${MARKET.id}:UNRESOLVED|NONE|`);
    expect(h.db.calls[0]).toEqual({ table: "bot_posts", action: "select" }); // the public-commit count
  });

  it("the floor lifts after 100 public commits on non-test markets", async () => {
    h.db.tables.bot_posts = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, kind: "commit", channel: "telegram", dedup_key: `old${i}`, markets: { is_test: false } }));
    await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.85 }));
    expect(h.db.tables.bot_posts!.at(-1)!.payload.committed.resolution_status).toBe("RESOLVED");
  });

  it("test markets are recorded with channel none and never posted", async () => {
    const r = await commitVerdict(env, { ...MARKET, is_test: true }, "res1", verdict({ confidence_score: 0.85 }));
    expect(r).toEqual({ committed: true, posted: false, reason: "test market: recorded, never posted" });
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

  it("retryUnposted re-posts a commit pending for more than 60 s", async () => {
    telegramOk = false;
    await commitVerdict(env, MARKET, "res1", verdict({ confidence_score: 0.95 }));
    h.db.tables.bot_posts![0]!.created_at = new Date(Date.now() - 120_000).toISOString();
    telegramOk = true;
    const r = await retryUnposted(env, 5);
    expect(r).toMatchObject({ attempted: 1, posted: 1, failed: 0 });
    expect(h.db.tables.bot_posts![0]).toMatchObject({ channel: "telegram", message_id: 77 });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toBe(sent[0]!.text); // the stored text, byte for byte
  });
});

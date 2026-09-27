/**
 * The channel poster (src/bot/post.ts) and the channel (src/bot/channel.ts), plan §16.4 P2 step 1 and §18.2: pending
 * commits grouped by event and posted as one message per event, chunked under Telegram's limit and never truncated;
 * at most 15 commit/reveal messages per rolling minute; one poster at a time (the channel lease); reveals of legs that
 * share one commit message posted as one reply; every leg's preimage recomputable from the posted text alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { POST_RPCS } from "./lib/fake-post-rpcs";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", () => ({ db: () => h.db.client }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { BATCH_MAX_WAIT_S, BATCH_QUIET_S, commitBatchMessages, planCommitPosts, planRevealPosts, postPending, RETRY_AFTER_S, REVEAL_MAX_WAIT_S, revealBatchMessages, revealLeg, revealMessageIds, type PendingCommitRow, type PendingRevealRow, type RevealLeg } from "../src/bot/post";
import { MESSAGE_MAX, PACE, POSTER_LEASE_S, SEND_WORST_MS } from "../src/bot/channel";
import { RECHECK_PENDING_S, UNPOSTED_ALERT_MINUTES } from "../src/jobs/reconcile";
import { buildPreimage, buildReveal, commitText, committedFields, type CommittedVerdict, type OfficialRecord } from "../src/bot/commit";
import { Budget, COST } from "../src/ops/budget";
import { CHANNEL_POST_LIMITS, CHANNEL_POST_SUBREQUESTS } from "../src/jobs/schedule";
import { sha256Hex } from "../src/resolve/text";
import { shapeVerify, type VerifyCommit, type VerifyReveal } from "../src/api/public";
import type { Verdict } from "../src/resolve/schema";

const T0 = Date.parse("2026-10-14T12:30:00.000Z");
const ago = (s: number, now = T0) => new Date(now - s * 1000).toISOString();
const CPI = "official:us_cpi_u_nsa_yoy:2026-09";

function commitRow(id: string, secondsAgo: number, over: Partial<PendingCommitRow> & { batched?: boolean; eventKey?: string } = {}, now = T0): PendingCommitRow {
  const { batched = false, eventKey, ...rest } = over;
  return {
    id, market_id: `m-${id}`, created_at: ago(secondsAgo, now), commitment_sha256: id.padEnd(64, "0").slice(0, 64),
    payload: { text: `stored text of ${id}`, batched },
    markets: { platform: "polymarket", external_id: `ext-${id}`, event_key: eventKey ?? `polymarket:ext-${id}` },
    ...rest,
  };
}

describe("planCommitPosts (pure)", () => {
  it("groups the legs of an event; an inline row waits RETRY_AFTER_S, a batched leg BATCH_QUIET_S", () => {
    const rows = [
      commitRow("leg1", BATCH_QUIET_S + 10, { batched: true, eventKey: CPI }),
      commitRow("leg2", BATCH_QUIET_S + 5, { batched: true, eventKey: CPI }),
      commitRow("single", RETRY_AFTER_S + 1),
      commitRow("inflight", RETRY_AFTER_S - 1),
    ];
    const plan = planCommitPosts(rows, T0, 4);
    expect(plan.map((g) => [g.eventKey, g.rows.map((r) => r.id)])).toEqual([["polymarket:ext-single", ["single"]], [CPI, ["leg1", "leg2"]]]);
  });

  it("an event waits while a leg is still arriving, unless its oldest leg has waited BATCH_MAX_WAIT_S", () => {
    const arriving = [commitRow("a", BATCH_QUIET_S + 20, { batched: true, eventKey: CPI }), commitRow("b", 3, { batched: true, eventKey: CPI })];
    expect(planCommitPosts(arriving, T0, 4)).toEqual([]);
    const stale = [commitRow("a", BATCH_MAX_WAIT_S, { batched: true, eventKey: CPI }), commitRow("b", 3, { batched: true, eventKey: CPI })];
    expect(planCommitPosts(stale, T0, 4).map((g) => g.rows.map((r) => r.id))).toEqual([["a"]]);
  });

  it("an event Telegram keeps refusing goes behind the others instead of blocking them", () => {
    const poisoned = commitRow("poisoned", 900);
    poisoned.payload.post_attempts = 3;
    expect(planCommitPosts([poisoned, commitRow("fresh", 100)], T0, 4).map((g) => g.rows[0]!.id)).toEqual(["fresh", "poisoned"]);
  });

  it("oldest event first, at most maxEvents; a row read without its market is its own event", () => {
    const rows = [commitRow("new", 100), commitRow("old", 900), commitRow("mid", 500), { ...commitRow("bare", 700), markets: null }];
    expect(planCommitPosts(rows, T0, 2).map((g) => g.eventKey)).toEqual(["polymarket:ext-old", "market:m-bare"]);
    expect(planCommitPosts(rows, T0, 0)).toEqual([]);
  });
});

describe("commitBatchMessages (pure)", () => {
  const legs = (n: number, idLen = 6) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, ref: `polymarket:${String(500000 + i).padEnd(idLen, "7")}`, commitment: String(i).padStart(64, "a"), created_at: ago(60 - i) }));

  it("24 CPI legs are one message: a header naming the event, one line per leg", () => {
    const [m, ...rest] = commitBatchMessages(CPI, legs(24));
    expect(rest).toHaveLength(0);
    expect(m!.ids).toEqual(legs(24).map((l) => l.id));
    const lines = m!.text.split("\n");
    expect(lines[0]).toBe("#official_us_cpi_u_nsa_yoy_2026-09 | 24 verdicts committed");
    expect(lines[1]).toBe(`event ${CPI}`);
    for (const l of legs(24)) expect(lines.filter((x) => x === `market ${l.ref} | commitment ${l.commitment}`)).toHaveLength(1);
    expect(m!.text).toContain("Informational signal, not financial advice");
  });

  it("chunks under the limit, never truncates: every leg's full line in exactly one message, parts numbered", () => {
    const many = legs(60, 200); // 200-character external ids: about 280 characters per line
    const msgs = commitBatchMessages(CPI, many);
    expect(msgs.length).toBeGreaterThan(1);
    for (const [i, m] of msgs.entries()) {
      expect(m.text.length).toBeLessThanOrEqual(MESSAGE_MAX);
      expect(m.text.split("\n")[0]).toBe(`#official_us_cpi_u_nsa_yoy_2026-09 | 60 verdicts committed (part ${i + 1}/${msgs.length})`);
    }
    expect(msgs.flatMap((m) => m.ids)).toEqual(many.map((l) => l.id));
    for (const l of many) expect(msgs.filter((m) => m.text.split("\n").includes(`market ${l.ref} | commitment ${l.commitment}`))).toHaveLength(1);
  });
});

function verdict(i: number): Verdict {
  return {
    market_id: `m${i}`, resolution_status: "RESOLVED", winning_outcome: i % 3 ? "OPTION_B" : "OPTION_A", confidence_score: 0.99, error_code: null, error_reason: null,
    caveats: [], determination_basis: "structured", checks: [], jev_model: "jev-1.13.0", thresholds_version: "v1", latency_ms: 100,
    evidence: { raw_sha256: "e".repeat(64), canonical_sha256: "f".repeat(64), source_url: "https://www.bls.gov/cpi", source_kind: "official_release", observed_at: ago(0), claimed_at: null, quote: null },
  } as Verdict;
}

/** A leg committed and settled the way commitVerdict and settle_market record it. */
async function legOf(i: number, official: OfficialRecord): Promise<RevealLeg> {
  const ref = `polymarket:${600000 + i}`;
  const nonce = `nonce${i}`.padEnd(24, "0");
  const fields = committedFields(verdict(i));
  const committed: CommittedVerdict = { preimage_version: "v2", preimage: buildPreimage(ref, fields, nonce), ...fields };
  const agreement = committed.winning_outcome === official.outcome ? "agree" : "disagree";
  return { id: `rv${i}`, ref, commitment: await sha256Hex(committed.preimage), nonce, committed, official, agreement };
}
const OFFICIAL_NO: OfficialRecord = { outcome: "OPTION_B", label: "No", at: "2026-10-14T12:30:05.000Z", at_source: "gamma_closed_time", source_url: "https://polymarket.com/event/cpi-sep" };

/** What a third party does with nothing but the posted reveal text: each leg block's market line, preimage and nonce. */
function legsFromText(text: string): Array<{ commitment: string; preimage: string; nonce: string; ref: string }> {
  const out: Array<{ commitment: string; preimage: string; nonce: string; ref: string }> = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const head = lines.find((l) => l.startsWith("market "));
    if (!head) continue;
    const [, ref, commitment] = /^market (\S+) \| commitment ([0-9a-f]{64})$/.exec(head)!;
    const take = (p: string) => lines.find((l) => l.startsWith(p))!.slice(p.length);
    out.push({ ref: ref!, commitment: commitment!, preimage: take("preimage "), nonce: take("nonce ") });
  }
  return out;
}

describe("revealBatchMessages (pure)", () => {
  it("every leg's commitment is recomputable from the posted text alone, across chunks", async () => {
    const legs = await Promise.all(Array.from({ length: 30 }, (_, i) => legOf(i, OFFICIAL_NO)));
    const msgs = revealBatchMessages(CPI, legs);
    expect(msgs.length).toBeGreaterThan(1);
    const seen = msgs.flatMap((m) => { expect(m.text.length).toBeLessThanOrEqual(MESSAGE_MAX); return legsFromText(m.text); });
    expect(seen.map((l) => l.ref)).toEqual(legs.map((l) => l.ref));
    for (const l of seen) {
      expect(await sha256Hex(l.preimage)).toBe(l.commitment);
      expect(l.preimage.startsWith(`${l.ref}|`)).toBe(true);
      expect(l.preimage.endsWith(`|${l.nonce}`)).toBe(true);
    }
    expect(msgs.flatMap((m) => m.ids)).toEqual(legs.map((l) => l.id));
    // a shared official source is printed once, in the header
    expect(msgs[0]!.text.split("\n\n")[0]).toContain("official source https://polymarket.com/event/cpi-sep at 2026-10-14T12:30:05.000Z (gamma_closed_time)");
  });
});

describe("channel posts name neither the model nor its vendor (plan §2.1, the vendor's MCA §2.3(a))", () => {
  it("a model-routed leg's commit and reveal texts, batched and single, carry no model name", async () => {
    const NAMES = /jev|typesafe/i;
    const ref = "polymarket:700001";
    const nonce = "nonceweb".padEnd(24, "0");
    const v = { ...verdict(1), determination_basis: "jev", jev_model: "jev-1.13.0", checks: [{ name: "jev_call", pass: true, detail: "jev-1.13.0 900 tokens 300 ms" }] } as Verdict;
    const fields = committedFields(v);
    expect(fields.determination_basis).toBe("jev"); // what the committed verdict behind the reveal holds
    const committed: CommittedVerdict = { preimage_version: "v2", preimage: buildPreimage(ref, fields, nonce), ...fields };
    const commitment = await sha256Hex(committed.preimage);
    const leg: RevealLeg = { id: "rvw", ref, commitment, nonce, committed, official: OFFICIAL_NO, agreement: "agree" };
    const market = { platform: "polymarket", external_id: "700001" } as const;
    const texts = [
      ...commitBatchMessages(CPI, [{ id: "cw", ref, commitment, created_at: ago(5) }]).map((m) => m.text),
      ...revealBatchMessages(CPI, [leg]).map((m) => m.text),
      commitText(market, commitment, fields.raw_sha256, ago(5)),
      buildReveal(market, { id: "cw", commitment_sha256: commitment, nonce }, committed, OFFICIAL_NO, "agree").text,
    ];
    expect(texts).toHaveLength(4);
    for (const t of texts) expect(t).not.toMatch(NAMES);
  });
});

describe("planRevealPosts (pure)", () => {
  const reveal = (id: string, commitId: string, secondsAgo: number): PendingRevealRow => ({ id, market_id: `m-${id}`, created_at: ago(secondsAgo), commitment_sha256: "a".repeat(64), nonce: "n", payload: { commit_id: commitId }, markets: null });
  it("groups by the commit message answered; a reveal whose commit is unposted waits", () => {
    const commits = new Map([["c1", { channel: "telegram", message_id: 500 }], ["c2", { channel: "telegram", message_id: 500 }], ["c3", { channel: "telegram", message_id: 501 }], ["c4", { channel: "pending", message_id: null }]]);
    const plan = planRevealPosts([reveal("r3", "c3", 50), reveal("r1", "c1", 90), reveal("r2", "c2", 80), reveal("r4", "c4", 99)], commits, new Map(), T0, 5);
    expect(plan.waiting).toBe(1);
    expect(plan.groups.map((g) => [g.replyTo, g.rows.map((r) => r.id)])).toEqual([[500, ["r1", "r2"]], [501, ["r3"]]]);
    expect(planRevealPosts([reveal("r1", "c1", 90), reveal("r3", "c3", 50)], commits, new Map(), T0, 1).groups).toHaveLength(1);
  });

  it("a message with a leg still open is held until its oldest reveal has waited REVEAL_MAX_WAIT_S", () => {
    const commits = new Map([["c1", { channel: "telegram", message_id: 500 }], ["c3", { channel: "telegram", message_id: 501 }], ["c4", { channel: "pending", message_id: null }]]);
    const reveals = [reveal("r1", "c1", REVEAL_MAX_WAIT_S - 1), reveal("r3", "c3", 5), reveal("r4", "c4", 5)];
    expect(revealMessageIds(reveals, commits)).toEqual([500, 501]);
    const open = new Map([[500, 1]]);
    const held = planRevealPosts(reveals, commits, open, T0, 5);
    expect([held.groups.map((g) => g.replyTo), held.held, held.waiting]).toEqual([[501], 1, 1]);
    const due = planRevealPosts(reveals, commits, open, T0 + 1000, 5);
    expect([due.groups.map((g) => g.replyTo), due.held]).toEqual([[500, 501], 0]);
  });

  it("the hold outlasts one reconcile interval and never trips the 15-minute unposted alert", () => {
    expect(REVEAL_MAX_WAIT_S).toBeGreaterThan(RECHECK_PENDING_S);
    // the every-minute poster picks a due message up within a minute
    expect(REVEAL_MAX_WAIT_S + 60).toBeLessThan(UNPOSTED_ALERT_MINUTES * 60);
  });
});

describe("postPending", () => {
  const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "-100" } as unknown as Env;
  let sent: Array<Record<string, any>>;
  let telegramOk: boolean;
  /** How long each send takes on the fake clock. */
  let sendMs: number;
  let clock = T0;

  beforeEach(() => {
    sent = []; telegramOk = true; sendMs = 1300;
    clock += 3_600_000; // only forward: sendMessage's throttle remembers the last send across tests
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock);
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (!String(url).startsWith("https://api.telegram.org/")) throw new Error(`unexpected fetch ${url}`);
      sent.push(JSON.parse(String(init.body)));
      vi.setSystemTime(Date.now() + sendMs); // past the 1.2 s throttle without waiting for it
      return telegramOk
        ? new Response(JSON.stringify({ ok: true, result: { message_id: 800 + sent.length, date: Math.floor(Date.now() / 1000) } }), { status: 200 })
        : new Response(JSON.stringify({ ok: false, description: "Too Many Requests: retry after 30" }), { status: 400 });
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  const now = () => Date.now();
  const pending = (id: string, secondsAgo: number, eventKey: string, batched: boolean): Row => ({ ...commitRow(id, secondsAgo, { batched, eventKey }, now()), kind: "commit", channel: "pending", message_id: null, telegram_date: null, posted_at: null, dedup_key: id });
  const newDb = (rows: Row[], leases: Row[] = []) => fakeDb({ bot_posts: rows, post_leases: leases }, { bot_posts: ["dedup_key"] }, { rpc: POST_RPCS });
  const budget = () => new Budget(CHANNEL_POST_SUBREQUESTS);
  const recentMessages = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `q${i}`, kind: "commit", channel: "telegram", message_id: 100 + i, posted_at: ago(20, now()), created_at: ago(20, now()), dedup_key: `q${i}`, payload: {} }));

  it("posts the legs of an event as ONE message sharing its message_id; a single-market commit as its stored text", async () => {
    h.db = newDb([pending("leg1", 45, CPI, true), pending("leg2", 44, CPI, true), pending("leg3", 40, CPI, true), pending("solo", 70, "polymarket:solo", false)]);
    const r = await postPending(env, budget(), CHANNEL_POST_LIMITS, now());
    expect(r).toMatchObject({ channel: "claimed", commits_attempted: 4, commits_posted: 4, messages: 2, stopped: null, errors: [], send_errors: [] });
    expect(sent).toHaveLength(2);
    const legs = h.db.tables.bot_posts!.filter((b) => b.id.startsWith("leg"));
    expect(new Set(legs.map((b) => b.message_id)).size).toBe(1);
    expect(legs.every((b) => b.channel === "telegram" && b.telegram_date && b.posted_at === b.telegram_date)).toBe(true);
    const batch = sent.find((s) => String(s.text).startsWith("#official"))!;
    for (const b of legs) expect(String(batch.text)).toContain(`market polymarket:ext-${b.id} | commitment ${b.commitment_sha256}`);
    expect(sent.find((s) => s.text === "stored text of solo")).toBeDefined(); // byte for byte
    expect(Date.parse(h.db.tables.post_leases![0]!.lease_until)).toBeLessThanOrEqual(Date.now()); // released
  });

  it("never more than 15 messages per rolling 60 s: over the ceiling the rows stay pending", async () => {
    h.db = newDb([...recentMessages(PACE.messages - 1), pending("a", 70, "polymarket:a", false), pending("b", 70, "polymarket:b", false)]);
    const r = await postPending(env, budget(), CHANNEL_POST_LIMITS, now());
    expect(r).toMatchObject({ messages: 1, commits_posted: 1, stopped: "paced" });
    expect(h.db.tables.bot_posts!.filter((b) => b.channel === "pending").map((b) => b.id)).toEqual(["b"]);

    h.db = newDb([...recentMessages(PACE.messages), pending("a", 70, "polymarket:a", false)]);
    expect(await postPending(env, budget(), CHANNEL_POST_LIMITS, now())).toMatchObject({ channel: "paced", messages: 0 });
    expect(sent).toHaveLength(1);
  });

  it("legs that share one message count once toward the ceiling", async () => {
    const shared = recentMessages(PACE.messages).map((b) => ({ ...b, message_id: 100 })); // 15 legs, one message
    h.db = newDb([...shared, pending("a", 70, "polymarket:a", false)]);
    expect(await postPending(env, budget(), CHANNEL_POST_LIMITS, now())).toMatchObject({ channel: "claimed", messages: 1 });
  });

  it("one poster at a time: a live lease of another holder posts nothing; nothing pending takes no lease", async () => {
    h.db = newDb([pending("a", 70, "polymarket:a", false)], [{ channel: "telegram_public", holder: "reconcile-run", lease_until: new Date(Date.now() + 60_000).toISOString() }]);
    expect(await postPending(env, budget(), CHANNEL_POST_LIMITS, now())).toMatchObject({ channel: "busy", messages: 0 });
    h.db = newDb([]);
    expect(await postPending(env, budget(), CHANNEL_POST_LIMITS, now())).toMatchObject({ channel: "idle" });
    expect(h.db.tables.post_leases).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("no send starts with less than SEND_WORST_MS of the lease left: the rest stays pending, never attempted", async () => {
    sendMs = 20_000; // slow sends: the lease runs out before the four events do
    const fits = Math.floor((POSTER_LEASE_S * 1000 - SEND_WORST_MS) / sendMs) + 1;
    expect(fits).toBeLessThan(CHANNEL_POST_LIMITS.commitEvents);
    h.db = newDb(["a", "b", "c", "d"].map((id, i) => pending(id, 70 + i, `polymarket:${id}`, false)));
    const r = await postPending(env, budget(), CHANNEL_POST_LIMITS, now());
    expect(r).toMatchObject({ channel: "claimed", messages: fits, commits_posted: fits, commits_failed: 0, stopped: "lease" });
    expect(sent).toHaveLength(fits);
    const left = h.db.tables.bot_posts!.filter((b) => b.channel === "pending");
    expect(left).toHaveLength(CHANNEL_POST_LIMITS.commitEvents - fits);
    for (const b of left) expect(b.payload).not.toHaveProperty("post_attempts");
    expect(Date.parse(h.db.tables.post_leases![0]!.lease_until)).toBeLessThanOrEqual(Date.now()); // released
  });

  it("a failed send records the failure on every leg of the message and stops the run", async () => {
    telegramOk = false;
    h.db = newDb([pending("leg1", 45, CPI, true), pending("leg2", 44, CPI, true), pending("solo", 70, "polymarket:solo", false)]);
    const r = await postPending(env, budget(), CHANNEL_POST_LIMITS, now());
    expect(r).toMatchObject({ stopped: "failure", commits_failed: 1, messages: 1 }); // the oldest event (solo) first
    expect(h.db.tables.bot_posts!.find((b) => b.id === "solo")!.payload).toMatchObject({ post_error: "Too Many Requests: retry after 30", post_attempts: 1 });
    telegramOk = false;
    h.db = newDb([pending("leg1", 45, CPI, true), pending("leg2", 44, CPI, true)]);
    await postPending(env, budget(), CHANNEL_POST_LIMITS, now());
    expect(h.db.tables.bot_posts!.map((b) => [b.channel, b.payload.post_attempts])).toEqual([["pending", 1], ["pending", 1]]);
  });

  it("reveals of legs that share one commit message are ONE reply; each leg recomputable from it; a lone reveal is its stored text", async () => {
    const legs = await Promise.all([0, 1, 2].map((i) => legOf(i, OFFICIAL_NO)));
    const rows: Row[] = [];
    for (const [i, l] of legs.entries()) {
      rows.push({ id: `c${i}`, market_id: `m${i}`, kind: "commit", channel: "telegram", message_id: 500, posted_at: ago(7200, now()), created_at: ago(7200, now()), commitment_sha256: l.commitment, nonce: l.nonce, dedup_key: `c${i}`, payload: {} });
      const { payload } = buildReveal({ platform: "polymarket", external_id: String(600000 + i) }, { id: `c${i}`, commitment_sha256: l.commitment, nonce: l.nonce }, l.committed, OFFICIAL_NO, l.agreement);
      rows.push({ id: l.id, market_id: `m${i}`, kind: "reveal", channel: "pending", created_at: ago(30, now()), commitment_sha256: l.commitment, nonce: l.nonce, dedup_key: `reveal:c${i}`, payload, markets: { platform: "polymarket", external_id: String(600000 + i), event_key: CPI } });
    }
    const lone = await legOf(9, OFFICIAL_NO);
    rows.push({ id: "c9", market_id: "m9", kind: "commit", channel: "telegram", message_id: 501, posted_at: ago(7200, now()), created_at: ago(7200, now()), commitment_sha256: lone.commitment, nonce: lone.nonce, dedup_key: "c9", payload: {} });
    const loneReveal = buildReveal({ platform: "polymarket", external_id: "600009" }, { id: "c9", commitment_sha256: lone.commitment, nonce: lone.nonce }, lone.committed, OFFICIAL_NO, lone.agreement);
    rows.push({ id: "rv9", market_id: "m9", kind: "reveal", channel: "pending", created_at: ago(20, now()), commitment_sha256: lone.commitment, nonce: lone.nonce, dedup_key: "reveal:c9", payload: loneReveal.payload, markets: { platform: "polymarket", external_id: "600009", event_key: "polymarket:event:9" } });
    h.db = newDb(rows);

    const r = await postPending(env, budget(), CHANNEL_POST_LIMITS, now());
    expect(r).toMatchObject({ reveals_posted: 4, reveals_waiting: 0, messages: 2 });
    expect(sent.map((s) => s.reply_to_message_id)).toEqual([500, 501]);
    const got = legsFromText(String(sent[0]!.text));
    expect(got.map((l) => l.ref)).toEqual(legs.map((l) => l.ref));
    for (const l of got) expect(await sha256Hex(l.preimage)).toBe(l.commitment);
    expect(sent[1]!.text).toBe(loneReveal.text);
    const reveals = h.db.tables.bot_posts!.filter((b) => b.kind === "reveal");
    expect(reveals.map((b) => [b.channel, b.reply_to_message_id])).toEqual([["telegram", 500], ["telegram", 500], ["telegram", 500], ["telegram", 501]]);
    expect(new Set(reveals.slice(0, 3).map((b) => b.message_id)).size).toBe(1);
    expect(revealLeg(rows.find((b) => b.id === "rv0") as PendingRevealRow)).not.toBeNull();
    // GET /v1/track-record/verify still answers per leg: its own commitment, preimage and nonce, the shared messages
    for (const [i, l] of legs.entries()) {
      const commit = h.db.tables.bot_posts!.find((b) => b.id === `c${i}`)!;
      const reveal = h.db.tables.bot_posts!.find((b) => b.id === l.id)!;
      const v = shapeVerify({ ...commit, markets: { platform: "polymarket", external_id: String(600000 + i) } } as unknown as VerifyCommit, reveal as unknown as VerifyReveal);
      expect(v).toMatchObject({ commitment_sha256: l.commitment, market: l.ref, message_id: 500, revealed: true, reveal_posted: true, nonce: l.nonce, preimage: l.committed.preimage });
      expect(await sha256Hex(String(v.preimage))).toBe(v.commitment_sha256);
    }
  });

  describe("reveals of a ladder settled across reconcile runs", () => {
    const setup = async () => {
      const legs = await Promise.all([0, 1].map((i) => legOf(i, OFFICIAL_NO)));
      const commit = (i: number, market: Record<string, unknown>): Row => ({ id: `c${i}`, market_id: `m${i}`, kind: "commit", channel: "telegram", message_id: 500, posted_at: ago(7200, now()), created_at: ago(7200, now()), commitment_sha256: legs[i]!.commitment, nonce: legs[i]!.nonce, dedup_key: `c${i}`, payload: {}, markets: { deleted_at: null, ...market } });
      const reveal = (i: number, secondsAgo: number): Row => {
        const { payload } = buildReveal({ platform: "polymarket", external_id: String(600000 + i) }, { id: `c${i}`, commitment_sha256: legs[i]!.commitment, nonce: legs[i]!.nonce }, legs[i]!.committed, OFFICIAL_NO, legs[i]!.agreement);
        return { id: legs[i]!.id, market_id: `m${i}`, kind: "reveal", channel: "pending", created_at: ago(secondsAgo, now()), commitment_sha256: legs[i]!.commitment, nonce: legs[i]!.nonce, dedup_key: `reveal:c${i}`, payload, markets: { platform: "polymarket", external_id: String(600000 + i), event_key: CPI } };
      };
      return { legs, commit, reveal };
    };

    it("a message's reveals wait while another of its legs is open: legs settled in two runs share ONE reply", async () => {
      const { legs, commit, reveal } = await setup();
      h.db = newDb([commit(0, { status: "resolved" }), commit(1, { status: "open" }), reveal(0, 30)]);
      expect(await postPending(env, budget(), CHANNEL_POST_LIMITS, now())).toMatchObject({ channel: "claimed", reveals_held: 1, reveals_posted: 0, messages: 0, errors: [] });
      expect(sent).toHaveLength(0);
      // the next reconcile run settles leg 1 (its market closes and its reveal is recorded in one transaction)
      h.db.tables.bot_posts!.find((b) => b.id === "c1")!.markets.status = "resolved";
      h.db.tables.bot_posts!.push(reveal(1, 5));
      expect(await postPending(env, budget(), CHANNEL_POST_LIMITS, now())).toMatchObject({ reveals_held: 0, reveals_posted: 2, messages: 1 });
      expect(sent.map((s) => s.reply_to_message_id)).toEqual([500]);
      expect(legsFromText(String(sent[0]!.text)).map((l) => l.ref)).toEqual(legs.map((l) => l.ref));
    });

    it("a leg that stays open holds the others at most REVEAL_MAX_WAIT_S; a deleted open leg never holds them", async () => {
      const { commit, reveal } = await setup();
      h.db = newDb([commit(0, { status: "resolved" }), commit(1, { status: "open" }), reveal(0, REVEAL_MAX_WAIT_S)]);
      expect(await postPending(env, budget(), CHANNEL_POST_LIMITS, now())).toMatchObject({ reveals_held: 0, reveals_posted: 1, messages: 1 });
      expect(sent.map((s) => s.reply_to_message_id)).toEqual([500]);
      h.db = newDb([commit(0, { status: "resolved" }), commit(1, { status: "open", deleted_at: ago(60, now()) }), reveal(0, 30)]);
      expect(await postPending(env, budget(), CHANNEL_POST_LIMITS, now())).toMatchObject({ reveals_held: 0, reveals_posted: 1 });
    });
  });

  it("a reveal waits while its commit is unposted", async () => {
    h.db = newDb([
      { id: "c1", market_id: "m1", kind: "commit", channel: "pending", created_at: ago(10, now()), commitment_sha256: "a".repeat(64), dedup_key: "c1", payload: { text: "t", batched: false } },
      { id: "rv1", market_id: "m1", kind: "reveal", channel: "pending", created_at: ago(5, now()), commitment_sha256: "a".repeat(64), nonce: "n", dedup_key: "reveal:c1", payload: { commit_id: "c1", text: "reveal" } },
    ]);
    expect(await postPending(env, budget(), CHANNEL_POST_LIMITS, now())).toMatchObject({ reveals_waiting: 1, reveals_posted: 0, messages: 0 });
    expect(sent).toHaveLength(0);
  });

  it("stays inside the every-minute invocation's share: at most 4 events, never past its budget", async () => {
    const rows = Array.from({ length: 12 }, (_, e) => [0, 1].map((l) => pending(`e${e}l${l}`, 60 + e, `polymarket:event:${e}`, true))).flat();
    h.db = newDb(rows);
    let fetches = 0;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { fetches++; return real(url, init); });
    const b = budget();
    const r = await postPending(env, b, CHANNEL_POST_LIMITS, now());
    expect(r.messages).toBe(4); // four events, one message each
    expect(h.db.tables.bot_posts!.filter((x) => x.channel === "telegram")).toHaveLength(8);
    expect(h.db.calls.length + fetches * COST.telegram).toBeLessThanOrEqual(CHANNEL_POST_SUBREQUESTS);
    expect(b.used).toBeLessThanOrEqual(CHANNEL_POST_SUBREQUESTS);
  });
});

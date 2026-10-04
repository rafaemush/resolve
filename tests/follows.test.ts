/**
 * Follows and the private early reveal (plan §17.3 P7-lite, §19.2 item 5): the follow rules, per-plan caps and the
 * entitlement rule (an evaluation ends with its key; a lowered plan keeps only its oldest follows), the shadow response
 * and the event payloads (never the nonce or the preimage before the reveal), and the four tenant routes over an
 * in-memory database with migration 014's follow_market() and follow_entitlements() stand-ins. The routes name a market
 * by its uuid or by its venue id "<platform>:<external_id>" (plan §22.3 #4), which resolves only to the one public
 * shadow market (never a tenant's, never a test market, never a deleted one, never a guess between two).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Verdict } from "../src/resolve/schema";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { followEntitlements as followEntitlementsStandIn, followMarket as followMarketStandIn, REVEAL_RPCS } from "./lib/fake-rpcs";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, plan: "free" as string }));
vi.mock("../src/db/supabase", () => ({
  db: () => h.db.client,
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/api/auth", () => ({
  authenticate: async () => ({ ok: true, auth: { keyId: "k1", tenantId: "t1", plan: h.plan, strictV0: false, environment: "test", scopes: [], requestsToday: 0, dailyCap: 1000 } }),
  rateLimit: async () => ({ allowed: true }),
  extractApiKey: () => null,
  invalidateKeyCache: async () => undefined,
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })), alertMany: vi.fn(async () => ({ sent: [], deduped: [] })) }));

import { v1 } from "../src/api/v1";
import { followBlock, followCap, followEntitlements, followerTenants, followRefusal, onlyMatch, parseMarketRef, shadowVerdict, shapeShadow, shapeShadowCommit, venueBasis, EARLY_REVEAL_LABEL, PLANS, type FollowEntitlement, type FollowTarget, type ShadowCommitRow } from "../src/shadow/follows";
import { shadowCommittedPayload, shadowRevealedPayload } from "../src/shadow/events";
import { buildPreimage, committedFields, DISCLAIMER, type CommittedVerdict, type OfficialRecord } from "../src/bot/commit";
import { sha256Hex } from "../src/resolve/text";

const M = "22222222-2222-4222-8222-222222222222";
const CID = `0x${"ab".repeat(32)}`;
const MARKET = { id: M, platform: "polymarket" as const, external_id: "551234", status: "open" as const, deadline_utc: "2026-10-20T00:00:00.000Z", option_a: "Yes", option_b: "No", condition_id: CID, meta: { slug: "cpi-above-3", event_id: "60182" } };
const NONCE = "0123456789abcdef01234567";

function committed(over: Partial<Verdict> = {}): CommittedVerdict {
  const v = {
    resolution_status: "RESOLVED", winning_outcome: "OPTION_A", confidence_score: 0.95, caveats: ["claimed_at_display_only"], thresholds_version: "v1", determination_basis: "structured",
    evidence: { raw_sha256: "d".repeat(64), canonical_sha256: "c".repeat(64) }, ...over,
  } as unknown as Verdict;
  const fields = committedFields(v);
  return { preimage_version: "v2", preimage: buildPreimage(`polymarket:${MARKET.external_id}`, fields, NONCE), ...fields };
}

describe("followCap (plan §17.3 P7-lite)", () => {
  it("an evaluation key 50, pay as you go 500 (since the priced reveal), Builder 50 as published, Growth 500, unlimited on Platform", () => {
    expect(Object.fromEntries(PLANS.map((p) => [p, followCap(p)]))).toEqual({ free: 50, payg: 500, builder: 50, growth: 500, platform: null });
  });
});

describe("followBlock: an evaluation ends with its key; only follows within the plan's cap deliver", () => {
  const e = (over: Partial<FollowEntitlement> = {}): FollowEntitlement => ({ tenant_id: "t1", follow_id: "f1", plan: "free", live_key: true, open_rank: 1, ...over });
  it("a free follow delivers while a key is live, and not after", () => {
    expect(followBlock(e())).toBeNull();
    expect(followBlock(e({ live_key: false }))).toBe("evaluation_ended");
  });
  it("paid plans do not depend on a live key (a paid follow is not an evaluation)", () => {
    for (const plan of ["payg", "builder", "growth", "platform"] as const) expect(followBlock(e({ plan, live_key: false }))).toBeNull();
  });
  it("rank within the cap delivers; above it does not (a lowered plan); Platform has no cap", () => {
    expect(followBlock(e({ plan: "builder", open_rank: 50 }))).toBeNull();
    expect(followBlock(e({ plan: "builder", open_rank: 51 }))).toBe("over_follow_limit");
    expect(followBlock(e({ plan: "growth", open_rank: 500 }))).toBeNull();
    expect(followBlock(e({ plan: "growth", open_rank: 501 }))).toBe("over_follow_limit");
    expect(followBlock(e({ plan: "platform", open_rank: 100_000 }))).toBeNull();
  });
  it("an unreadable or malformed follow_entitlements answer is an error, never an empty follower list", async () => {
    const client = (data: unknown, error: { message: string } | null = null) => ({ rpc: async () => ({ data, error }) }) as never;
    expect(await followerTenants(client(null, { message: "timeout" }), "m1")).toEqual({ tenants: [], error: "timeout" });
    expect((await followEntitlements(client([{ tenant_id: "t1", follow_id: "f1", plan: "gold", live_key: true, open_rank: 1 }]), "m1")).error).toContain("follow_entitlements answered");
    expect(await followerTenants(client([]), "m1")).toEqual({ tenants: [], error: null });
  });
});

describe("parseMarketRef: a uuid, or a venue id <platform>:<external_id> as /record prints it", () => {
  it("a uuid is a uuid; a venue id names a known platform and an external_id of 1-200 characters, taken as registered", () => {
    expect(parseMarketRef(M)).toEqual({ kind: "uuid", id: M });
    expect(parseMarketRef("polymarket:551234")).toEqual({ kind: "venue", platform: "polymarket", externalId: "551234" });
    expect(parseMarketRef("limitless:september-inflation-us-annual-1789462576803")).toEqual({ kind: "venue", platform: "limitless", externalId: "september-inflation-us-annual-1789462576803" });
    // only the first colon splits: an external_id may itself hold one, or a slash (sent %2F-encoded in the path)
    expect(parseMarketRef("custom:a:b/c")).toEqual({ kind: "venue", platform: "custom", externalId: "a:b/c" });
    expect(parseMarketRef(`custom:${"x".repeat(200)}`)).toMatchObject({ kind: "venue" });
  });
  it("anything else is refused (never guessed): another platform, no external_id, one too long, a bare id", () => {
    for (const bad of ["kalshi:123", "Polymarket:551234", "polymarket:", "polymarket", "551234", ":551234", `custom:${"x".repeat(201)}`, "not-a-uuid", "export"]) expect(parseMarketRef(bad), bad).toBeNull();
  });
  it("onlyMatch: exactly one row, else null (none, or two that would have to be guessed between)", () => {
    expect(onlyMatch([{ id: "a" }])).toEqual({ id: "a" });
    for (const rows of [[], [{ id: "a" }, { id: "b" }], null, undefined]) expect(onlyMatch(rows)).toBeNull();
  });
});

describe("followRefusal: only open, non-test shadow markets", () => {
  const target = (over: Partial<FollowTarget> = {}): FollowTarget => ({ id: M, tenant_id: null, is_test: false, status: "open", deleted_at: null, ...over });
  it("an open public shadow market can be followed", () => expect(followRefusal(target(), "t1")).toBeNull());
  it("missing, deleted, another tenant's and test markets all answer 404 (a private market's existence is never confirmed)", () => {
    for (const m of [null, target({ deleted_at: "2026-09-01T00:00:00Z" }), target({ tenant_id: "t2" }), target({ is_test: true })]) {
      expect(followRefusal(m, "t1")).toMatchObject({ status: 404, code: "not_found", message: "market not found" });
    }
  });
  it("the tenant's own market is a 400 that points at market.* events", () => {
    expect(followRefusal(target({ tenant_id: "t1" }), "t1")).toMatchObject({ status: 400, code: "validation_error" });
    expect(followRefusal(target({ tenant_id: "t1" }), "t1")!.message).toContain("market.* webhooks");
  });
  it("a settled market is a 400 naming its status", () => {
    for (const status of ["resolved", "void", "closed_unresolved", "unsupported_source"]) {
      expect(followRefusal(target({ status }), "t1")).toMatchObject({ status: 400, message: expect.stringContaining(`market is ${status}`) });
    }
  });
});

describe("shadow response and event payloads never carry the nonce or the preimage before the reveal", () => {
  const row = (id: string, createdAt: string, c: CommittedVerdict, channel = "telegram"): ShadowCommitRow => ({
    id, commitment_sha256: "e".repeat(64), created_at: createdAt, channel, telegram_date: channel === "telegram" ? createdAt : null,
    payload: { text: "t", committed: c, evidence_raw_sha256: c.raw_sha256, canonical_sha256: c.canonical_sha256 },
  });

  it("shapeShadow: newest commit first as latest, labeled, verdict + hashes only", () => {
    const early = committed({ resolution_status: "UNRESOLVED", winning_outcome: "NONE", caveats: ["no_anchor"] });
    const late = committed();
    const out = shapeShadow(MARKET, [row("c1", "2026-10-01T00:00:00.000Z", early), row("c2", "2026-10-02T00:00:00.000Z", late, "pending")]);
    expect(out).toMatchObject({ market_id: M, market: "polymarket:551234", status: "open", label: EARLY_REVEAL_LABEL, disclaimer: DISCLAIMER });
    expect(out.latest).toEqual({
      commitment_sha256: "e".repeat(64), committed_at: "2026-10-02T00:00:00.000Z", posted: false, posted_at: null,
      verdict: { resolution_status: "RESOLVED", winning_outcome: "OPTION_A", confidence_score: 0.95, caveats: ["claimed_at_display_only"], determination_basis: "structured", thresholds_version: "v1" },
      locked: false,
      evidence: { raw_sha256: "d".repeat(64), canonical_sha256: "c".repeat(64) },
    });
    expect(out).toMatchObject({ reveal: null, locked: null });
    expect((out.commits as Row[]).map((c) => c.committed_at)).toEqual(["2026-10-02T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
    const json = JSON.stringify(out);
    expect(json).not.toContain(NONCE);
    expect(json).not.toContain("preimage\"");
    expect(json).not.toContain(late.preimage);
  });

  it("a commit recorded before preimage v2 shows its hashes and no verdict; a bad hash is dropped", () => {
    const v1 = { id: "c0", commitment_sha256: "f".repeat(64), created_at: "2026-09-22T00:00:00.000Z", channel: "telegram", telegram_date: "2026-09-22T00:00:01.000Z", payload: { evidence_raw_sha256: "n/a", canonical_sha256: "c".repeat(64) } };
    expect(shapeShadowCommit(v1)).toMatchObject({ verdict: null, posted: true, evidence: { raw_sha256: null, canonical_sha256: "c".repeat(64) } });
    expect(shapeShadow(MARKET, [])).toMatchObject({ latest: null, commits: [] });
  });

  it("shadow.committed: market, commitment, the committed verdict and evidence hashes, labeled and disclaimed", () => {
    const c = committed();
    const p = shadowCommittedPayload(MARKET, { commitment_sha256: "e".repeat(64), committed_at: "2026-10-02T00:00:00.000Z", committed: c });
    expect(p).toEqual({
      market_id: M, platform: "polymarket", external_id: "551234", market: "polymarket:551234",
      commitment_sha256: "e".repeat(64), committed_at: "2026-10-02T00:00:00.000Z",
      verdict: { resolution_status: "RESOLVED", winning_outcome: "OPTION_A", confidence_score: 0.95, caveats: ["claimed_at_display_only"], determination_basis: "structured", thresholds_version: "v1" },
      evidence: { raw_sha256: "d".repeat(64), canonical_sha256: "c".repeat(64) },
      venue: { platform: "polymarket", condition_id: CID, slug: "cpi-above-3", event_id: "60182", proposed_outcome_label: "Yes" },
      reveal: null, locked: null,
      label: EARLY_REVEAL_LABEL, disclaimer: DISCLAIMER,
    });
    expect(JSON.stringify(p)).not.toContain(NONCE);
  });

  it("shadow.revealed: official outcome, the final agreement, and a preimage only for commits revealed publicly", async () => {
    const early = committed({ resolution_status: "UNRESOLVED", winning_outcome: "NONE", caveats: ["no_anchor"] });
    const late = committed();
    const official: OfficialRecord = { outcome: "OPTION_A", label: "Yes", at: "2026-10-20T01:00:00.000Z", at_source: "gamma_closed_time", source_url: "https://polymarket.com/event/x" };
    const p = shadowRevealedPayload(MARKET, official, [
      { commitment_sha256: await sha256Hex(early.preimage), committed_at: "2026-10-01T00:00:00.000Z", agreement: "abstained", final: false, committed: early },
      { commitment_sha256: "0".repeat(64), committed_at: "2026-10-02T00:00:00.000Z", agreement: "agree", final: true, committed: null }, // unprovable: never revealed
    ]);
    expect(p).toMatchObject({ market: "polymarket:551234", official, agreement: "agree", disclaimer: DISCLAIMER });
    // the final commit is unprovable: nothing of it is revealed, so the venue object proposes nothing
    expect(p.venue).toEqual({ platform: "polymarket", condition_id: CID, slug: "cpi-above-3", event_id: "60182", proposed_outcome_label: null });
    const [a, b] = p.commits as Row[];
    expect(a).toMatchObject({ agreement: "abstained", final: false, revealed: true, preimage: early.preimage, verdict: { resolution_status: "UNRESOLVED" }, evidence: { raw_sha256: "d".repeat(64), canonical_sha256: "c".repeat(64) } });
    expect(await sha256Hex(String(a!.preimage))).toBe(a!.commitment_sha256);
    expect(b).toMatchObject({ agreement: "agree", final: true, revealed: false, preimage: null, verdict: null, evidence: null });
    expect(JSON.stringify(p)).not.toContain(late.preimage);
  });
});

// ---- the routes -----------------------------------------------------------------------------------------------------

const env = { JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "60", SPOTLIGHT_SECRET: "eval-spotlight-v1", SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized", INTERNAL_HMAC_SECRET: "x", ADMIN_API_KEY: "x", EVAL_REPORT_KEY: "x" } as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = async (method: string, path: string) => {
  const res = await v1.request(path, { method }, env, ctx);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const market = (id: string, over: Row = {}): Row => ({ id, tenant_id: null, is_test: false, status: "open", deleted_at: null, platform: "polymarket", external_id: `ext-${id.slice(0, 4)}`, deadline_utc: "2026-10-20T00:00:00.000Z", ...over });
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

describe("POST/DELETE /v1/markets/:id/follow, GET /v1/follows, GET /v1/shadow/:market_id", () => {
  let caps: Array<number | null>;
  beforeEach(() => {
    h.plan = "free";
    caps = [];
    h.db = fakeDb({
      // created after the priced reveal's cut-over, with credits: a RESOLVED read is charged 25 (tests/reveal.test.ts prices it)
      tenants: [{ id: "t1", plan: "free", deleted_at: null, created_at: "2026-10-20T00:00:00.000Z", credits_balance: 300 }, { id: "t2", plan: "free", deleted_at: null, created_at: "2026-10-20T00:00:00.000Z", credits_balance: 300 }],
      // the calling key (the auth mock's k1): an authenticated tenant holds a live key
      api_keys: [{ id: "k1", tenant_id: "t1", revoked_at: null, deleted_at: null, expires_at: null }],
      markets: [market(M), market(uuid(1), { tenant_id: "t2" }), market(uuid(2), { is_test: true }), market(uuid(3), { status: "resolved" }), market(uuid(4), { tenant_id: "t1" })],
      market_follows: [], bot_posts: [], api_request_log: [], webhook_endpoints: [],
    }, {}, { rpc: { ...REVEAL_RPCS, follow_market: async (db, a) => { caps.push(a.p_cap); return followMarketStandIn(db, a); }, follow_entitlements: followEntitlementsStandIn } });
  });
  const hook = (id: string, events: string[], over: Row = {}): Row => ({ id, tenant_id: "t1", url: `https://hooks.example/${id}`, active: true, deleted_at: null, events, ...over });
  /** n follows by t1 of open markets that exist, older than anything the test creates. */
  const openFollows = (n: number, status = "open") => {
    for (let i = 0; i < n; i++) {
      h.db.tables.markets!.push(market(uuid(100 + i), { status }));
      h.db.tables.market_follows!.push({ id: `f${String(i).padStart(3, "0")}`, tenant_id: "t1", market_id: uuid(100 + i), created_at: new Date(Date.parse("2026-09-01T00:00:00Z") + i * 1000).toISOString(), deleted_at: null, markets: { status, deleted_at: null } });
    }
  };

  it("follows an open shadow market once (201, then 200 already_following) with the plan's cap", async () => {
    h.db.tables.webhook_endpoints = [hook("e1", ["shadow.committed", "shadow.revealed"])];
    const a = await call("POST", `/markets/${M}/follow`);
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ market_id: M, following: true, already_following: false, follows_counted: 1, follow_limit: 50, events: ["shadow.committed", "shadow.revealed"], read: `/v1/shadow/${M}`, endpoints_subscribed: 1 });
    expect(a.body.data.warning).toBeUndefined();
    const b = await call("POST", `/markets/${M}/follow`);
    expect(b.status).toBe(200);
    expect(b.body.data).toMatchObject({ follow_id: a.body.data.follow_id, already_following: true, follows_counted: 1 });
    expect(h.db.tables.market_follows).toHaveLength(1);
    expect(caps).toEqual([50, 50]);
  });

  it("says so when no endpoint will receive shadow.committed: none, the old defaults, inactive or deleted ones", async () => {
    const OLD_DEFAULTS = ["market.resolved", "market.unresolved_update", "market.error", "credits.low", "payment.credited"]; // migration 009's default
    h.db.tables.webhook_endpoints = [
      hook("e1", OLD_DEFAULTS), hook("e2", ["shadow.committed"], { active: false }), hook("e3", ["shadow.committed"], { deleted_at: "2026-09-01T00:00:00Z" }),
      hook("e4", ["shadow.committed"], { tenant_id: "t2" }), // another tenant's
    ];
    const r = await call("POST", `/markets/${M}/follow`);
    expect(r.status).toBe(201); // the follow is recorded: GET /v1/shadow still reads it
    expect(r.body.data.endpoints_subscribed).toBe(0);
    expect(r.body.data.warning).toContain("No active webhook endpoint of this account is subscribed to shadow.committed");
    expect(r.body.data.warning).toContain("POST /v1/webhooks");
    h.db.tables.webhook_endpoints.push(hook("e5", [...OLD_DEFAULTS, "shadow.committed"]));
    const again = await call("POST", `/markets/${M}/follow`);
    expect([again.body.data.endpoints_subscribed, again.body.data.warning]).toEqual([1, undefined]);
  });

  it("a webhook store error is a 503 before anything is written", async () => {
    const from = h.db.client.from;
    h.db.client.from = ((t: string) => (t === "webhook_endpoints" ? { select: () => { const q: any = { eq: () => q, is: () => q, then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "timeout" } }).then(ok) }; return q; } } : from(t))) as never;
    const r = await call("POST", `/markets/${M}/follow`);
    expect([r.status, r.body.error.code]).toEqual([503, "UPSTREAM_UNAVAILABLE"]);
    expect(caps).toEqual([]);
    expect(h.db.tables.market_follows).toHaveLength(0);
  });

  it("reads tenants.plan for the cap, not the key's cached plan: growth 500, platform unlimited", async () => {
    h.db.tables.tenants![0]!.plan = "growth";
    await call("POST", `/markets/${M}/follow`);
    h.db.tables.market_follows = [];
    h.db.tables.tenants![0]!.plan = "platform";
    const r = await call("POST", `/markets/${M}/follow`);
    expect(caps).toEqual([500, null]);
    expect(r.body.data.follow_limit).toBeNull();
  });

  it("refuses past the cap with 403 and the limit", async () => {
    openFollows(50);
    const r = await call("POST", `/markets/${M}/follow`);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, error: { code: "validation_error" }, follow_limit: 50, follows_counted: 50 });
    expect(r.body.error.message).toContain("a follow stops counting when its market settles");
    expect(h.db.tables.market_follows).toHaveLength(50);
  });

  it("follows of settled markets hold no slot: 50 of them do not stop a new follow", async () => {
    openFollows(50, "resolved");
    const r = await call("POST", `/markets/${M}/follow`);
    expect([r.status, r.body.data.follows_counted]).toEqual([201, 1]);
    const list = await call("GET", "/follows");
    expect(list.body.data).toMatchObject({ active_follows: 51, follows_counted: 1, follow_limit: 50 });
    expect(list.body.data.warning).toBeUndefined();
  });

  it("another tenant's, a test and a missing market are 404; the tenant's own and a settled one are 400; a bad id is 400", async () => {
    expect((await call("POST", `/markets/${uuid(1)}/follow`)).status).toBe(404);
    expect((await call("POST", `/markets/${uuid(2)}/follow`)).status).toBe(404);
    expect((await call("POST", `/markets/${uuid(9)}/follow`)).status).toBe(404);
    expect((await call("POST", `/markets/${uuid(4)}/follow`)).status).toBe(400);
    const settled = await call("POST", `/markets/${uuid(3)}/follow`);
    expect([settled.status, settled.body.error.message]).toEqual([400, expect.stringContaining("market is resolved")]);
    expect((await call("POST", "/markets/not-a-uuid/follow")).status).toBe(400);
    expect(caps).toEqual([]); // refused before the write
    expect(h.db.tables.market_follows).toHaveLength(0);
  });

  it("a follow store error is a 503 and records nothing", async () => {
    h.db.options.rpc!.follow_market = async () => ({ data: null, error: { code: "57014", message: "statement timeout" } });
    const r = await call("POST", `/markets/${M}/follow`);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("unfollow is a soft delete; a second unfollow is 404; following again creates a new row", async () => {
    await call("POST", `/markets/${M}/follow`);
    const del = await call("DELETE", `/markets/${M}/follow`);
    expect([del.status, del.body.data]).toEqual([200, { unfollowed: M }]);
    expect(h.db.tables.market_follows![0]!.deleted_at).toEqual(expect.any(String));
    expect((await call("DELETE", `/markets/${M}/follow`)).status).toBe(404);
    expect((await call("POST", `/markets/${M}/follow`)).status).toBe(201);
    expect(h.db.tables.market_follows).toHaveLength(2);
  });

  it("GET /v1/follows lists active follows with the market reference and the limit", async () => {
    await call("POST", `/markets/${M}/follow`);
    h.db.tables.market_follows!.push({ id: "gone", tenant_id: "t1", market_id: uuid(7), deleted_at: "2026-09-01T00:00:00Z" }, { id: "other", tenant_id: "t2", market_id: M, deleted_at: null });
    const r = await call("GET", "/follows");
    expect(r.body.data).toMatchObject({ active_follows: 1, follows_counted: 1, follow_limit: 50, truncated: false });
    expect(r.body.data.follows).toEqual([{ follow_id: expect.any(String), market_id: M, followed_at: expect.any(String), market: `polymarket:ext-${M.slice(0, 4)}`, status: "open", deadline_utc: "2026-10-20T00:00:00.000Z" }]);
  });

  it("GET /v1/shadow/:market_id: 404 unless following; then the committed verdicts, labeled, without nonce or preimage", async () => {
    const c = committed();
    h.db.tables.bot_posts = [
      { id: "c1", market_id: M, kind: "commit", commitment_sha256: await sha256Hex(c.preimage), nonce: NONCE, created_at: "2026-10-02T00:00:00.000Z", channel: "telegram", telegram_date: "2026-10-02T00:00:01.000Z", payload: { committed: c, text: "t" } },
      { id: "r1", market_id: M, kind: "reveal", created_at: "2026-10-21T00:00:00.000Z", channel: "pending", payload: { committed: c } },
      { id: "cx", market_id: uuid(1), kind: "commit", commitment_sha256: "9".repeat(64), created_at: "2026-10-02T00:00:00.000Z", channel: "telegram", payload: {} },
    ];
    expect((await call("GET", `/shadow/${M}`)).status).toBe(404);
    await call("POST", `/markets/${M}/follow`);
    const r = await call("GET", `/shadow/${M}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ market_id: M, label: EARLY_REVEAL_LABEL, latest: { commitment_sha256: await sha256Hex(c.preimage), posted: true, verdict: { winning_outcome: "OPTION_A" } } });
    expect(r.body.data.commits).toHaveLength(1); // commits of this market only, reveals excluded
    expect(JSON.stringify(r.body)).not.toContain(NONCE);
    await call("DELETE", `/markets/${M}/follow`);
    expect((await call("GET", `/shadow/${M}`)).status).toBe(404);
    expect((await call("GET", "/shadow/nope")).status).toBe(400);
  });

  it("after a plan is lowered, a follow above the new limit reads nothing and GET /v1/follows says why", async () => {
    h.db.tables.tenants![0]!.plan = "growth";
    openFollows(50);
    expect((await call("POST", `/markets/${M}/follow`)).status).toBe(201); // number 51, inside Growth's 500
    expect((await call("GET", `/shadow/${M}`)).status).toBe(200);
    h.db.tables.tenants![0]!.plan = "builder"; // cap 50
    const r = await call("GET", `/shadow/${M}`);
    expect([r.status, r.body.error.code]).toEqual([403, "validation_error"]);
    expect(r.body.error.message).toContain("number 51 of your follows of open markets, above this plan's limit of 50");
    expect((await call("GET", `/shadow/${uuid(100)}`)).status).toBe(200); // the oldest still read
    const list = await call("GET", "/follows");
    expect(list.body.data).toMatchObject({ follows_counted: 51, follow_limit: 50 });
    expect(list.body.data.warning).toContain("only the 50 oldest receive early reveals");
  });

  describe("by venue id (plan §22.3 #4): only the one public shadow market with that id", () => {
    const V = "33333333-3333-4333-8333-333333333333";
    const venueMarkets = () => h.db.tables.markets!.push(
      market(V, { external_id: "551234" }),
      // the same venue id registered by a tenant (markets_unique_per_tenant allows it): never what a venue id names
      market(uuid(21), { tenant_id: "t2", external_id: "551234" }),
      market(uuid(22), { tenant_id: "t2", external_id: "t2-only" }),
      market(uuid(23), { tenant_id: "t1", external_id: "mine-only" }),
      market(uuid(24), { is_test: true, external_id: "test-only" }),
      market(uuid(25), { deleted_at: "2026-09-01T00:00:00Z", external_id: "gone" }),
      market(uuid(26), { platform: "limitless", external_id: "fed-oct-hold" }),
      market(uuid(27), { status: "resolved", external_id: "settled-1" }),
      // two public rows for one venue id cannot exist in the database (unique nulls not distinct); if they ever did,
      // neither is guessed
      market(uuid(28), { external_id: "twice" }), market(uuid(29), { external_id: "twice" }),
    );

    it("POST by venue id follows the public market: the same follow row as the uuid form, the market named in the answer", async () => {
      venueMarkets();
      const a = await call("POST", "/markets/polymarket:551234/follow");
      expect(a.status).toBe(201);
      expect(a.body.data).toMatchObject({ market_id: V, market: "polymarket:551234", read: `/v1/shadow/${V}` });
      const b = await call("POST", `/markets/${V}/follow`);
      expect(b.status).toBe(200);
      expect(b.body.data).toMatchObject({ follow_id: a.body.data.follow_id, market_id: V, market: "polymarket:551234", already_following: true });
      expect(h.db.tables.market_follows!.map((f) => f.market_id)).toEqual([V]); // never the tenant t2's market of the same id
      expect((await call("POST", "/markets/limitless:fed-oct-hold/follow")).body.data).toMatchObject({ market_id: uuid(26), market: "limitless:fed-oct-hold" });
      // percent-encoded in the path, as a client may send it
      expect((await call("POST", "/markets/polymarket%3A551234/follow")).body.data.follow_id).toBe(a.body.data.follow_id);
    });

    it("another tenant's, the caller's own, a test, a deleted, a missing and a doubled venue id: 404, nothing recorded", async () => {
      venueMarkets();
      for (const id of ["polymarket:t2-only", "polymarket:mine-only", "polymarket:test-only", "polymarket:gone", "polymarket:nope", "limitless:551234", "polymarket:twice"]) {
        const r = await call("POST", `/markets/${id}/follow`);
        expect([r.status, r.body.error.code, r.body.error.message], id).toEqual([404, "not_found", "market not found"]);
      }
      expect(caps).toEqual([]);
      expect(h.db.tables.market_follows).toHaveLength(0);
      // a settled public market is found, and refused as settled (400), exactly as by uuid
      expect((await call("POST", "/markets/polymarket:settled-1/follow")).body.error.message).toContain("market is resolved");
      const bad = await call("POST", "/markets/kalshi:551234/follow");
      expect([bad.status, bad.body.error.message]).toEqual([400, expect.stringContaining("uuid or a venue id <platform>:<external_id>")]);
    });

    it("GET /v1/shadow and DELETE the follow take the venue id too; one that names no public market is 404", async () => {
      venueMarkets();
      h.db.tables.bot_posts = [{ id: "c1", market_id: V, kind: "commit", commitment_sha256: "e".repeat(64), nonce: NONCE, created_at: "2026-10-02T12:30:41.000Z", channel: "telegram", telegram_date: "2026-10-02T12:30:42.000Z", payload: { committed: committed(), text: "t" } }];
      expect((await call("GET", "/shadow/polymarket:551234")).status).toBe(404); // not following yet
      await call("POST", "/markets/polymarket:551234/follow");
      const r = await call("GET", "/shadow/polymarket:551234");
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ market_id: V, market: "polymarket:551234", latest: { commitment_sha256: "e".repeat(64) } });
      expect(JSON.stringify(r.body)).not.toContain(NONCE);
      for (const id of ["polymarket:t2-only", "polymarket:mine-only", "polymarket:test-only", "polymarket:gone", "polymarket:twice"]) {
        expect((await call("GET", `/shadow/${id}`)).body.error.message, id).toBe("market not found");
        expect((await call("DELETE", `/markets/${id}/follow`)).status, id).toBe(404);
      }
      expect((await call("GET", "/shadow/kalshi:1")).status).toBe(400);
      const del = await call("DELETE", "/markets/polymarket:551234/follow");
      expect([del.status, del.body.data]).toEqual([200, { unfollowed: V }]);
      expect((await call("GET", "/shadow/polymarket:551234")).status).toBe(404);
      expect((await call("DELETE", "/markets/kalshi:1/follow")).status).toBe(400);
    });

    it("a market store error on the venue lookup is a 503, never a 404", async () => {
      venueMarkets();
      const from = h.db.client.from;
      h.db.client.from = ((t: string) => (t === "markets" ? { select: () => { const q: any = { eq: () => q, is: () => q, limit: () => Promise.resolve({ data: null, error: { message: "timeout" } }) }; return q; } } : from(t))) as never;
      for (const [method, path] of [["POST", "/markets/polymarket:551234/follow"], ["DELETE", "/markets/polymarket:551234/follow"], ["GET", "/shadow/polymarket:551234"]] as const) {
        const r = await call(method, path);
        expect([r.status, r.body.error.code], path).toEqual([503, "UPSTREAM_UNAVAILABLE"]);
      }
      expect(caps).toEqual([]);
    });
  });

  it("a free tenant with no live key left reads nothing (a revoked key the 60 s auth cache still admits)", async () => {
    await call("POST", `/markets/${M}/follow`);
    h.db.tables.api_keys![0]!.revoked_at = new Date(Date.now() - 1000).toISOString();
    const r = await call("GET", `/shadow/${M}`);
    expect([r.status, r.body.error.message]).toEqual([403, expect.stringContaining("the evaluation has ended")]);
  });
});

describe("venue-facing route names (plan §2.1: customer surfaces never name the model)", () => {
  it("the model route reads web_evidence; structured and null are unchanged", () => {
    expect(venueBasis("jev")).toBe("web_evidence");
    expect(venueBasis("structured")).toBe("structured");
    expect(venueBasis(null)).toBeNull();
  });
  it("a follower's verdict never carries the model's name", () => {
    const v = { resolution_status: "RESOLVED", winning_outcome: "OPTION_A", confidence_score: 0.95, caveats: [], evidence: null, thresholds_version: "v1", determination_basis: "jev" } as unknown as Verdict;
    const shaped = shadowVerdict(committedFields(v));
    expect(shaped.determination_basis).toBe("web_evidence");
    expect(JSON.stringify(shaped)).not.toMatch(/jev/i);
  });
});

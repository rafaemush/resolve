/**
 * POST /internal/markets with importer metadata (plan §16.4 P5 step 1): meta is merged into markets.meta through a
 * whitelist (unknown keys dropped and reported, wrong types refused), condition_id also lands in its column (012),
 * is_test in markets.is_test; a repeat registration writes nothing; a failed idempotency lookup never falls through to an
 * insert; a misspelled top-level field is a 400 that names the accepted shape (seed-shadow's preflight reads it). The
 * market and its watches are written by register_market (migration 019), emulated by tests/lib/fake-register.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb } from "./lib/fake-db";
import { registerMarketStandIn } from "./lib/fake-register";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", async (orig) => ({ db: () => h.db.client, rpc: (await orig<typeof import("../src/db/supabase")>()).rpc }));

import { internal } from "../src/api/internal";
import { mergeMeta, META_KEYS } from "../src/markets/meta";

const env = { JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "60", SPOTLIGHT_SECRET: "eval-spotlight-v1", SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized", INTERNAL_HMAC_SECRET: "x", ADMIN_API_KEY: "admin-test", EVAL_REPORT_KEY: "x" } as unknown as Env;
const CID = `0x${"AB".repeat(32)}`;
// github_api sources need no registration-time network check, so nothing here leaves the process.
const market = {
  platform: "polymarket", external_id: "637022", condition: "Resolves Yes if release v2.0.0 of acme/widget is published before the deadline.",
  event_statement: "acme/widget publishes release v2.0.0", option_a: "Yes", option_b: "No", positive_option: "OPTION_A", anchors: ["v2.0.0"],
  sources: [{ kind: "github_api", ref: "repos/acme/widget/releases/tags/v2.0.0" }], open_at: "2026-09-01T00:00:00Z", deadline_utc: "2026-10-20T00:00:00Z",
};
const post = (body: unknown, key = "admin-test") => internal.request("/markets", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) }, env);

describe("mergeMeta", () => {
  it("keeps whitelisted keys, drops and reports the rest, normalizes ids", () => {
    const r = mergeMeta({ condition_id: CID, slug: "s", group_id: 10014423, event_id: "60182", neg_risk: true, registration_reasons: ["forged"], volume: 12 });
    expect(r).toEqual({ ok: true, meta: { condition_id: CID.toLowerCase(), slug: "s", group_id: "10014423", event_id: "60182", neg_risk: true }, dropped: ["registration_reasons", "volume"] });
    expect(mergeMeta(undefined)).toEqual({ ok: true, meta: {}, dropped: [] });
    expect(META_KEYS).toEqual(["condition_id", "slug", "question_id", "neg_risk", "limitless_slug", "group_id", "group_slug", "event_id", "category"]);
  });

  it("refuses a whitelisted key of the wrong type and a non-object", () => {
    expect(mergeMeta({ condition_id: "0x12" })).toMatchObject({ ok: false });
    expect(mergeMeta({ neg_risk: "yes" })).toMatchObject({ ok: false });
    expect(mergeMeta(["slug"])).toMatchObject({ ok: false });
  });
});

describe("POST /internal/markets", () => {
  beforeEach(() => { h.db = fakeDb({ markets: [], watches: [] }, {}, { rpc: { register_market: registerMarketStandIn } }); });

  it("writes whitelisted meta, condition_id and is_test on the new market and reports what it dropped", async () => {
    const res = await post({ market, meta: { condition_id: CID, slug: "sudan-err", event_id: "60182", volume_num: 5 }, is_test: false });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ status: "open", existing: false, is_test: false, meta_applied: ["condition_id", "event_id", "slug"], meta_dropped: ["volume_num"] });
    const row = h.db.tables.markets![0]!;
    expect(row).toMatchObject({ platform: "polymarket", external_id: "637022", tenant_id: null, condition_id: CID.toLowerCase(), is_test: false });
    expect(row.meta).toEqual({ condition_id: CID.toLowerCase(), slug: "sudan-err", event_id: "60182", registration_reasons: [] });
    expect(h.db.tables.watches).toHaveLength(1);
  });

  it("stores is_test true when asked, and defaults to false", async () => {
    await post({ market: { ...market, external_id: "t1" }, is_test: true });
    await post({ market: { ...market, external_id: "t2" } });
    expect(h.db.tables.markets!.map((m) => [m.external_id, m.is_test, m.condition_id])).toEqual([["t1", true, null], ["t2", false, null]]);
  });

  it("returns an existing (platform, external_id) with 200 and writes nothing, meta included", async () => {
    await post({ market, meta: { slug: "first" } });
    const res = await post({ market, meta: { slug: "second", condition_id: CID }, is_test: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({ existing: true, meta_applied: [], is_test: false });
    expect(h.db.tables.markets).toHaveLength(1);
    expect(h.db.tables.markets![0]!.meta).toEqual({ slug: "first", registration_reasons: [] });
  });

  it("refuses a wrong meta type, an unknown top-level field and a missing market, naming the accepted shape", async () => {
    const badMeta = await post({ market, meta: { condition_id: 42 } });
    expect(badMeta.status).toBe(400);
    const typo = await post({ market, is_tset: false });
    expect(typo.status).toBe(400);
    const empty = await post({});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ ok: false, accepted_fields: ["market", "tenant_id", "meta", "is_test"], meta_keys: META_KEYS });
    expect(h.db.tables.markets).toHaveLength(0);
  });

  it("never inserts when the idempotency lookup itself fails", async () => {
    const inserts: unknown[] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is"]) chain[m] = () => chain;
    chain.maybeSingle = async () => ({ data: null, error: { message: "canceling statement due to statement timeout" } });
    chain.insert = (row: unknown) => { inserts.push(row); return chain; };
    h.db = { client: { from: () => chain } } as unknown as FakeDb;
    const res = await post({ market, meta: { slug: "x" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("markets lookup: canceling statement");
    expect(inserts).toHaveLength(0);
  });

  it("requires the admin key", async () => {
    expect((await post({ market }, "wrong")).status).toBe(403);
  });
});

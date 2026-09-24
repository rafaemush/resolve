/**
 * POST /internal/deposits/match (plan §16.4 P3 step 3): an unmatched USDC deposit is credited to the tenant the operator
 * names, at the tier rate for its amount, exactly once. Over the in-memory database with migration 020's match_deposit()
 * stand-in (tests/lib/fake-money.ts; the SQL is asserted by scripts/selftest/money.ts): the ledger row, the audit, the
 * payment.credited event and the operator alert happen on the first call only; a retry is the same answer with
 * replayed=true; anything but an unmatched deposit is refused with nothing written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { MIGRATION_020_CONFIG, MONEY_RPCS } from "./lib/fake-money";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", () => ({
  db: () => h.db.client,
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })), alertMany: vi.fn(async () => ({ sent: [], deduped: [] })) }));

import { internal } from "../src/api/internal";
import { alert } from "../src/ops/alerts";
import { matchRefusal } from "../src/billing/match";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const TX = "0x" + "ab".repeat(32);
const env = { ADMIN_API_KEY: "admin-test-key" } as unknown as Env;
const post = async (body: unknown, key: string | null = "admin-test-key") => {
  const res = await internal.request("/deposits/match", { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) }, env);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const good = { tx_hash: TX.toUpperCase().replace("0X", "0x"), log_index: 3, tenant_id: T1, reason: "tenant emailed the tx hash from their company domain", actor: "founder" };
const deposit = (over: Row = {}): Row => ({ tx_hash: TX, log_index: 3, from_address: "0x" + "cd".repeat(20), amount_usdc: "250", status: "unmatched", tenant_id: null, ledger_id: null, credits_per_usdc: null, ...over });

beforeEach(() => {
  vi.mocked(alert).mockClear();
  h.db = fakeDb({
    tenants: [{ id: T1, credits_balance: 40, deleted_at: null, low_credit_notified_at: "2026-09-20T00:00:00Z" }, { id: T2, credits_balance: 0, deleted_at: null }],
    usdc_deposits: [deposit()], credit_ledger: [], app_config: structuredClone(MIGRATION_020_CONFIG),
    webhook_endpoints: [{ id: "e1", tenant_id: T1, url: "https://hooks.example/e1", secret: "s", active: true, deleted_at: null, events: ["payment.credited"], consecutive_failures: 0 }],
    webhook_deliveries: [],
  }, {}, { rpc: MONEY_RPCS });
  vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 })); // the inline first attempt at the endpoint
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /internal/deposits/match", () => {
  it("requires the admin key and a complete body", async () => {
    expect((await post(good, null)).status).toBe(403);
    expect((await post(good, "wrong")).status).toBe(403);
    expect((await post({ ...good, reason: "short" })).status).toBe(400);
    expect((await post({ ...good, tx_hash: "0x1234" })).status).toBe(400);
    expect((await post({ ...good, log_index: -1 })).status).toBe(400);
    expect((await post({ ...good, tenant_id: "t1" })).status).toBe(400);
    expect(h.db.tables.credit_ledger).toHaveLength(0);
  });

  it("credits the tenant at the tier rate once: ledger row, audit, alert, payment.credited", async () => {
    const r = await post(good);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ tx_hash: TX, log_index: 3, status: "credited", tenant_id: T1, credits: 27_500, balance_after: 27_540, amount_usdc: "250", credits_per_usdc: 110, replayed: false, payment_event: "queued for 1 endpoint(s)" });
    expect(h.db.tables.credit_ledger).toEqual([expect.objectContaining({ tenant_id: T1, delta: 27_500, reason: "purchase", tx_hash: TX, log_index: 3, balance_after: 27_540 })]);
    expect(h.db.tables.usdc_deposits![0]).toMatchObject({ status: "credited", tenant_id: T1, matched_by: "admin_api:founder", match_reason: good.reason, credits_per_usdc: 110 });
    expect(h.db.tables.tenants![0]).toMatchObject({ credits_balance: 27_540, low_credit_notified_at: null }); // a purchase clears the notice
    expect(vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes])).toEqual([[`deposit_matched_${TX}_3`, 1440]]);
    expect(h.db.tables.webhook_deliveries).toEqual([expect.objectContaining({ tenant_id: T1, endpoint_id: "e1", event_type: "payment.credited", payload: { tx_hash: TX, log_index: 3, amount_usdc: "250", credits: 27_500, balance_after: 27_540 } })]);
  });

  it("a retry is the same answer, replayed, with nothing written, alerted or sent again", async () => {
    const first = await post(good);
    const again = await post(good);
    expect(again.status).toBe(200);
    const same = ["status", "tenant_id", "credits", "balance_after", "amount_usdc", "credits_per_usdc"];
    expect(Object.fromEntries(same.map((k) => [k, again.body.data[k]]))).toEqual(Object.fromEntries(same.map((k) => [k, first.body.data[k]])));
    expect(again.body.data.replayed).toBe(true);
    expect(h.db.tables.credit_ledger).toHaveLength(1);
    expect(h.db.tables.tenants![0]!.credits_balance).toBe(27_540);
    expect(vi.mocked(alert)).toHaveBeenCalledTimes(1);
    expect(h.db.tables.webhook_deliveries).toHaveLength(1);
  });

  it("refuses anything but an unmatched deposit, writing nothing", async () => {
    await post(good);
    const other = await post({ ...good, tenant_id: T2 });
    expect([other.status, other.body.error.message]).toEqual([409, expect.stringContaining("already credited to another tenant")]);
    h.db.tables.usdc_deposits!.push(deposit({ log_index: 4, amount_usdc: "0.000001", status: "dust" }), deposit({ log_index: 5, status: "seen" }));
    expect((await post({ ...good, log_index: 4 })).status).toBe(409);
    expect((await post({ ...good, log_index: 5 })).status).toBe(409);
    expect((await post({ ...good, log_index: 9 })).status).toBe(404);
    h.db.tables.usdc_deposits!.push(deposit({ log_index: 6 }));
    h.db.tables.tenants![1]!.deleted_at = "2026-09-01T00:00:00Z";
    expect((await post({ ...good, log_index: 6, tenant_id: T2 })).status).toBe(404);
    expect(h.db.tables.usdc_deposits!.find((d) => d.log_index === 6)!.status).toBe("unmatched");
    expect(h.db.tables.credit_ledger).toHaveLength(1);
    expect(h.db.tables.tenants![1]!.credits_balance).toBe(0);
  });

  it("without usable payg_tiers nothing is credited at a guessed rate: 503", async () => {
    h.db.tables.app_config = h.db.tables.app_config!.filter((r) => r.key !== "payg_tiers");
    const r = await post(good);
    expect(r.status).toBe(503);
    expect(h.db.tables.usdc_deposits![0]!.status).toBe("unmatched");
    expect(h.db.tables.credit_ledger).toHaveLength(0);
  });
});

describe("matchRefusal: SQLSTATE to HTTP", () => {
  it("P0002 404, RS003 409, 22023 400, RS004 and the rest 503", () => {
    expect(["P0002", "RS003", "22023", "RS004", "57014", undefined].map((s) => matchRefusal(s).status)).toEqual([404, 409, 400, 503, 503, 503]);
  });
});

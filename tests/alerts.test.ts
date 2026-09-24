/**
 * alert() / alertMany() (plan §16.4 P0 step 7): per-key dedup windows read in one query, one insert and one DM for any
 * number of alerts (so a fixed subrequest budget can carry them), redaction, and a lost DM reported as not sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, dm: { ok: true } as { ok: boolean; error?: string } }));
vi.mock("../src/db/supabase", () => ({ db: () => h.db.client }));
vi.mock("../src/bot/telegram", () => ({ alertOperator: vi.fn(async () => h.dm) }));

import { alert, alertMany } from "../src/ops/alerts";
import { alertOperator } from "../src/bot/telegram";

const env = {} as Env;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const dms = () => vi.mocked(alertOperator).mock.calls.map((c) => c[1]);

describe("alertMany", () => {
  beforeEach(() => { h.dm = { ok: true }; vi.mocked(alertOperator).mockClear(); });

  it("one dedup read, one insert, one DM for several fresh keys", async () => {
    h.db = fakeDb({ alerts: [] });
    const r = await alertMany(env, [{ key: "webhook_dlq_e1", text: "a", dedupMinutes: 360 }, { key: "webhook_claim_failed", text: "b" }]);
    expect(r).toEqual({ sent: ["webhook_dlq_e1", "webhook_claim_failed"], deduped: [] });
    expect(h.db.calls).toEqual([{ table: "alerts", action: "select" }, { table: "alerts", action: "insert" }]);
    expect(h.db.tables.alerts!.map((a) => a.key)).toEqual(["webhook_dlq_e1", "webhook_claim_failed"]);
    expect(dms()).toHaveLength(1);
    expect(dms()[0]).toContain("[resolve] webhook_dlq_e1\na");
    expect(dms()[0]).toContain("[resolve] webhook_claim_failed\nb");
  });

  it("each key keeps its own window", async () => {
    h.db = fakeDb({ alerts: [{ key: "k360", created_at: ago(120) }, { key: "k60", created_at: ago(120) }] });
    const r = await alertMany(env, [{ key: "k360", text: "x", dedupMinutes: 360 }, { key: "k60", text: "y", dedupMinutes: 60 }]);
    expect(r).toEqual({ sent: ["k60"], deduped: ["k360"] });
    expect(h.db.tables.alerts!.filter((a) => a.text)).toHaveLength(1);
  });

  it("all deduped: no insert, no DM", async () => {
    h.db = fakeDb({ alerts: [{ key: "k", created_at: ago(5) }] });
    expect(await alertMany(env, [{ key: "k", text: "again" }])).toEqual({ sent: [], deduped: ["k"] });
    expect(h.db.calls).toHaveLength(1);
    expect(dms()).toHaveLength(0);
  });

  it("a repeated key is alerted once, first text wins; nothing to alert costs nothing", async () => {
    h.db = fakeDb({ alerts: [] });
    await alertMany(env, [{ key: "k", text: "first" }, { key: "k", text: "second" }]);
    expect(h.db.tables.alerts!.map((a) => a.text)).toEqual(["first"]);
    h.db = fakeDb({ alerts: [] });
    expect(await alertMany(env, [])).toEqual({ sent: [], deduped: [] });
    expect(h.db.calls).toHaveLength(0);
  });

  it("text is redacted in the row and in the DM", async () => {
    h.db = fakeDb({ alerts: [] });
    await alert(env, "k", "failed with apikey_ABCDEFGH12345678 and https://base-mainnet.g.alchemy.com/v2/secretkey123");
    expect(h.db.tables.alerts![0]!.text).not.toMatch(/ABCDEFGH12345678|secretkey123/);
    expect(dms()[0]).not.toMatch(/ABCDEFGH12345678|secretkey123/);
  });

  it("a DM Telegram refused is not reported as sent, and the row is still written", async () => {
    h.db = fakeDb({ alerts: [] });
    h.dm = { ok: false, error: "Forbidden: bot was blocked by the user" };
    expect(await alert(env, "k", "t")).toEqual({ sent: false, deduped: false });
    expect(h.db.tables.alerts).toHaveLength(1);
  });
});

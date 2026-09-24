/**
 * alert() / alertMany() (plan §16.4 P0 step 7): per-key dedup windows read in one query, one insert and one DM for any
 * number of alerts (so a fixed subrequest budget can carry them), redaction, a lost DM reported as not sent, and the
 * in-isolate fallback when the alerts table itself cannot be read (a tick alerting every minute during the outage).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, dm: { ok: true } as { ok: boolean; error?: string } }));
vi.mock("../src/db/supabase", () => ({ db: () => h.db.client }));
vi.mock("../src/bot/telegram", () => ({ alertOperator: vi.fn(async () => h.dm) }));

import { alert, alertMany, redactMeta } from "../src/ops/alerts";
import { redact } from "../src/ops/redact";
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

  it("meta is redacted before it is stored: an Alchemy URL and an rsl_live_ key inside it, at any depth", async () => {
    h.db = fakeDb({ alerts: [] });
    await alert(env, "k", "rpc failed", { meta: {
      rpc: "https://base-mainnet.g.alchemy.com/v2/AbCdEf123456789secret",
      nested: { keys: ["rsl_live_ABCDEFGH12345678xyz", "fine"], depth: { note: "Bearer abcdefghijklmnop" } },
      authorization: "opaque-value-without-a-pattern",
      block: 123, ok: true, none: null,
    } });
    const meta = h.db.tables.alerts![0]!.meta;
    expect(JSON.stringify(meta)).not.toMatch(/AbCdEf123456789secret|ABCDEFGH12345678xyz|abcdefghijklmnop|opaque-value/);
    expect(meta).toEqual({
      rpc: "https://base-mainnet.g.alchemy.com/v2/[redacted]",
      nested: { keys: ["rsl_live_[redacted]", "fine"], depth: { note: "Bearer [redacted]" } },
      authorization: "[redacted]",
      block: 123, ok: true, none: null,
    });
  });

  it("redactMeta keeps the JSON valid where redacting the serialized text would not, and never throws", () => {
    // Serialized, the value ends in an escaped backslash and an escaped quote; the key= pattern swallows the escapes and
    // the text no longer parses. Walking the structure redacts the string itself.
    const tricky = { url: 'https://x.example/?key=abc\\"', n: 1 };
    expect(() => JSON.parse(redact(JSON.stringify(tricky)))).toThrow();
    expect(redactMeta(tricky)).toEqual({ url: 'https://x.example/?key=[redacted]"', n: 1 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(Object.keys(redactMeta(cyclic))).toEqual(["meta_unserializable"]);
    expect(redactMeta(undefined)).toEqual({});
  });

  it("an unreadable alerts table (the outage itself) still dedups per isolate: one DM, not one per tick", async () => {
    const down = { message: "connect ECONNREFUSED (database paused)" };
    const refused = () => { const q: any = { select: () => q, in: () => q, gte: () => Promise.resolve({ data: null, error: down }), insert: () => Promise.resolve({ error: down }) }; return q; };
    h.db = { client: { from: refused } } as unknown as FakeDb;
    const tick = { key: "tick_insert_failed_outage", text: "liveness row refused", dedupMinutes: 30 };
    expect(await alertMany(env, [tick])).toEqual({ sent: ["tick_insert_failed_outage"], deduped: [] });
    expect(await alertMany(env, [tick])).toEqual({ sent: [], deduped: ["tick_insert_failed_outage"] });
    expect(dms()).toHaveLength(1);
    // A different key in the same outage is news.
    expect((await alertMany(env, [{ key: "dispatch_absent_outage", text: "x" }])).sent).toEqual(["dispatch_absent_outage"]);
  });

  it("a DM that did not go out is not remembered: the next attempt in the outage tries again", async () => {
    const down = { message: "connect ECONNREFUSED" };
    const refused = () => { const q: any = { select: () => q, in: () => q, gte: () => Promise.resolve({ data: null, error: down }), insert: () => Promise.resolve({ error: down }) }; return q; };
    h.db = { client: { from: refused } } as unknown as FakeDb;
    h.dm = { ok: false, error: "Too Many Requests" };
    expect((await alertMany(env, [{ key: "k_unsent", text: "t" }])).sent).toEqual([]);
    h.dm = { ok: true };
    expect((await alertMany(env, [{ key: "k_unsent", text: "t" }])).sent).toEqual(["k_unsent"]);
  });

  it("a DM Telegram refused is not reported as sent, and the row is still written", async () => {
    h.db = fakeDb({ alerts: [] });
    h.dm = { ok: false, error: "Forbidden: bot was blocked by the user" };
    expect(await alert(env, "k", "t")).toEqual({ sent: false, deduped: false });
    expect(h.db.tables.alerts).toHaveLength(1);
  });
});

/**
 * POST /v1/keys/rotate never extends a key's life (docs/pricing.md: an evaluation key is valid 30 days from issue):
 * the new key keeps the old key's expiry, and the old key's 24 h overlap never outlives its own expiry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, expiresAt: null as string | null }));
vi.mock("../src/db/supabase", () => ({ db: () => h.db.client, rpc: async () => { throw new Error("no rpc in this test"); } }));
vi.mock("../src/api/auth", () => ({
  authenticate: async () => ({ ok: true, auth: { keyId: "k1", tenantId: "t1", plan: "free", strictV0: false, environment: "test", scopes: [], requestsToday: 0, dailyCap: 1000, expiresAt: h.expiresAt } }),
  rateLimit: async () => ({ allowed: true }),
  extractApiKey: () => null,
  invalidateKeyCache: async () => undefined,
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { v1 } from "../src/api/v1";
import { rotationExpiry, ROTATION_OVERLAP_MS } from "../src/api/keys";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("rotationExpiry", () => {
  it("a key without expiry: the new key has none, the old one works 24 h more", () => {
    expect(rotationExpiry(null, NOW)).toEqual({ newKey: null, oldKey: iso(NOW + ROTATION_OVERLAP_MS) });
  });
  it("an evaluation key on day 29: the new key keeps day 30, the old one ends at day 30 too", () => {
    const end = iso(NOW + 3600_000);
    expect(rotationExpiry(end, NOW)).toEqual({ newKey: end, oldKey: end });
  });
  it("an expiry further out than 24 h: the new key keeps it, the old one gets the 24 h overlap", () => {
    const end = iso(NOW + 10 * 86_400_000);
    expect(rotationExpiry(end, NOW)).toEqual({ newKey: end, oldKey: iso(NOW + ROTATION_OVERLAP_MS) });
  });
});

describe("POST /v1/keys/rotate", () => {
  const env = { SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized" } as unknown as Env;
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  beforeEach(() => {
    h.db = fakeDb({ api_keys: [{ id: "k1", tenant_id: "t1", environment: "test", expires_at: null }], api_request_log: [] });
    h.expiresAt = null;
  });

  it("an evaluation key rotated before its end: the new key ends when the old one would have", async () => {
    const end = iso(Date.now() + 2 * 86_400_000);
    h.expiresAt = end;
    h.db.tables.api_keys![0]!.expires_at = end;
    const res = await v1.request("/keys/rotate", { method: "POST" }, env, ctx);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(201);
    const [old, fresh] = h.db.tables.api_keys!;
    expect(fresh).toMatchObject({ tenant_id: "t1", environment: "test", expires_at: end });
    expect(Date.parse(old!.expires_at)).toBeLessThanOrEqual(Date.parse(end));
    expect(body.data).toMatchObject({ expires_at: end });
    expect(String(body.data.note)).toContain("rotation never extends a key");
  });

  it("a key without expiry rotates to a key without expiry", async () => {
    const res = await v1.request("/keys/rotate", { method: "POST" }, env, ctx);
    expect(res.status).toBe(201);
    expect(h.db.tables.api_keys![1]!.expires_at).toBeNull();
    expect(Date.parse(h.db.tables.api_keys![0]!.expires_at)).toBeGreaterThan(Date.now());
  });
});

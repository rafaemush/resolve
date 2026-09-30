/**
 * POST /internal/watch/:id (plan §16.4 P1 step 7, audit schema:D17): a signed pg_net dispatch is claimed once
 * (claim_watch_dispatch, migration 019, emulated here with its ledger and the watches' leases) before any work. A
 * replayed signature is refused with 409, so a duplicate never runs the watch twice; a lease that is null, past, or
 * taken after the signed minute (a later dispatch or a tenant fetch) is refused; a claim that cannot be recorded fails
 * closed (503); an admin bearer bypasses both checks and is marked dispatch=admin. runWatch is stubbed: its own
 * behaviour is covered by tests/watch-run.test.ts; the database side by scripts/selftest/dispatch.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { hmacHex } from "../src/resolve/text";

const h = vi.hoisted(() => ({
  used: new Set<string>(),
  leases: new Map<string, number | null>(),
  claims: [] as Array<{ p_watch: string; p_minute: string }>,
  failClaim: null as string | null,
  runs: [] as Array<{ id: string; dispatch: string | undefined; waitUntil?: boolean }>,
  bases: [] as Array<string | null | undefined>,
}));
vi.mock("../src/db/supabase", () => ({
  db: () => ({}),
  rpc: vi.fn(async (_c: unknown, fn: string, args: { p_watch: string; p_minute: string }) => {
    if (fn !== "claim_watch_dispatch") throw new Error(`unexpected rpc ${fn}`);
    h.claims.push(args);
    if (h.failClaim) throw new Error(h.failClaim);
    // claim_watch_dispatch: INSERT first, then the lease
    const key = `${args.p_watch}|${args.p_minute}`;
    if (h.used.has(key)) return "signature_used";
    h.used.add(key);
    if (!h.leases.has(args.p_watch)) return "watch_not_found";
    const lease = h.leases.get(args.p_watch)!;
    if (lease === null) return "lease_missing";
    if (lease <= Date.now()) return "lease_expired";
    // the lease the signed minute took ends before minute + 180 s; a later one belongs to another run
    if (lease >= Date.parse(`${args.p_minute}:00Z`) + 180_000) return "lease_superseded";
    h.leases.set(args.p_watch, Math.max(lease, Date.now() + 120_000));
    return "claimed";
  }),
}));
vi.mock("../src/ingest/watch", () => ({
  runWatch: vi.fn(async (_env: unknown, _cfg: unknown, id: string, opts: { dispatch?: string; waitUntil?: unknown; base?: string | null }) => {
    h.bases.push(opts.base);
    h.runs.push({ id, dispatch: opts.dispatch, ...(opts.waitUntil ? { waitUntil: typeof opts.waitUntil === "function" } : {}) });
    return { watch_id: id, outcome: "no_op", rows_written: 0, detail: "unchanged", recorded: true };
  }),
}));

import { internal } from "../src/api/internal";

const SECRET = "internal-hmac-test";
const env = { JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "60", SPOTLIGHT_SECRET: "eval-spotlight-v1", SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized", INTERNAL_HMAC_SECRET: SECRET, ADMIN_API_KEY: "admin-test", EVAL_REPORT_KEY: "x" } as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const W = "5b0f3c2e-8f1a-4c7e-9d2b-1a2b3c4d5e6f";
const minuteNow = () => new Date().toISOString().slice(0, 16);

async function dispatch(id = W, minute = minuteNow(), sig?: string) {
  const s = sig ?? (await hmacHex(SECRET, `${id}|${minute}`));
  return internal.request(`/watch/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-internal-signature": s, "x-internal-minute": minute }, body: JSON.stringify({ watch_id: id }) }, env, ctx);
}
const message = async (res: Response) => ((await res.json()) as { error?: { message: string } }).error?.message;

beforeEach(() => {
  h.used.clear(); h.leases.clear(); h.claims = []; h.failClaim = null; h.runs = []; h.bases = [];
  h.leases.set(W, Date.now() + 120_000); // select_due_watches() leased it 120 s ahead
});
afterEach(() => vi.restoreAllMocks());

describe("POST /internal/watch/:id: single-use signature and lease", () => {
  it("claims the signed (watch, minute) before running the poll, once, and still hands the poll its waitUntil", async () => {
    // waitUntil carries the official_release capture (and its release-minute burst) past the response pg_net waits for
    const minute = minuteNow();
    const res = await dispatch(W, minute);
    expect(res.status).toBe(200);
    expect(h.claims).toEqual([{ p_watch: W, p_minute: minute }]);
    expect(h.runs).toEqual([{ id: W, dispatch: "pg_net", waitUntil: true }]);
  });

  it("hands the poll the public origin for its credits.low pointers: RESOLVE_PUBLIC_URL, else the dispatching request's own (worker_base_url)", async () => {
    expect((await dispatch()).status).toBe(200);
    const res = await internal.request(`/watch/${W}`, { method: "POST", headers: { authorization: "Bearer admin-test" } }, { ...env, RESOLVE_PUBLIC_URL: "https://resolve.example.com/" } as Env, ctx);
    expect(res.status).toBe(200);
    expect(h.bases).toEqual(["http://localhost", "https://resolve.example.com"]);
  });

  it("refuses a replayed signature with 409 and never runs the watch a second time", async () => {
    const minute = minuteNow();
    expect((await dispatch(W, minute)).status).toBe(200);
    const replay = await dispatch(W, minute);
    expect(replay.status).toBe(409);
    expect(await message(replay)).toBe("signature already used");
    expect(h.runs).toHaveLength(1);
  });

  it("two identical requests racing: exactly one runs", async () => {
    const minute = minuteNow();
    const [a, b] = await Promise.all([dispatch(W, minute), dispatch(W, minute)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(h.runs).toHaveLength(1);
  });

  it("refuses an expired lease and a released (null) lease with 409, without running", async () => {
    h.leases.set(W, Date.now() - 1000);
    const expired = await dispatch();
    expect(expired.status).toBe(409);
    expect(await message(expired)).toContain("lease expired");
    h.leases.set(W, null);
    const released = await dispatch(W, new Date(Date.now() - 60_000).toISOString().slice(0, 16));
    expect(released.status).toBe(409);
    expect(await message(released)).toContain("not leased");
    expect(h.runs).toHaveLength(0);
  });

  it("refuses a late dispatch once the watch was leased again after its minute (a later dispatch or a tenant fetch): 409, not run", async () => {
    // signed two minutes ago, still inside the 3-minute signature window; the lease now held was taken just now
    h.leases.set(W, Date.now() + 120_000);
    const late = await dispatch(W, new Date(Date.now() - 2 * 60_000).toISOString().slice(0, 16));
    expect(late.status).toBe(409);
    expect(await message(late)).toContain("leased again");
    expect(h.runs).toHaveLength(0);
  });

  it("answers 404 for a signed dispatch of a watch that no longer exists", async () => {
    h.leases.clear();
    expect((await dispatch()).status).toBe(404);
    expect(h.runs).toHaveLength(0);
  });

  it("fails closed when the claim cannot be recorded: 503, and the poll does not run", async () => {
    h.failClaim = "rpc claim_watch_dispatch: 57014 canceling statement due to statement timeout";
    const res = await dispatch();
    expect(res.status).toBe(503);
    expect(await message(res)).toContain("the poll did not run");
    expect(h.runs).toHaveLength(0);
  });

  it("checks the HMAC and the minute before touching the database", async () => {
    expect((await dispatch(W, minuteNow(), "0".repeat(64))).status).toBe(403);
    expect((await dispatch(W, new Date(Date.now() - 10 * 60_000).toISOString().slice(0, 16))).status).toBe(403);
    expect((await dispatch("not-a-uuid")).status).toBe(400);
    expect(h.claims).toHaveLength(0);
  });

  it("an admin bearer bypasses the lease and the single-use check, and the run is marked dispatch=admin", async () => {
    h.leases.set(W, null);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (let i = 0; i < 2; i++) {
      const res = await internal.request(`/watch/${W}`, { method: "POST", headers: { authorization: "Bearer admin-test" } }, env, ctx);
      expect(res.status).toBe(200);
    }
    expect(h.claims).toHaveLength(0);
    expect(h.runs).toEqual([{ id: W, dispatch: "admin", waitUntil: true }, { id: W, dispatch: "admin", waitUntil: true }]);
    const logged = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(logged).toEqual([0, 1].map(() => expect.objectContaining({ job: "watch_dispatch", dispatch: "admin", watch_id: W })));
  });
});

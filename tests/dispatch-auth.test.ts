/**
 * The pg_net dispatch signature (src/api/dispatch-auth.ts), shared by POST /internal/watch/:id (select_due_watches,
 * signed with the watch id) and POST /internal/limitless/record (dispatch_internal, signed with limitless_record): the
 * same verifier behind both routes, the id inside the MAC so neither signature opens the other route, the ±3 minute
 * window, and the admin bearer for manual runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { Env } from "../src/env";

vi.mock("../src/ingest/watch", () => ({ runWatch: vi.fn(async () => ({ recorded: true, outcome: "no_op" })) }));
vi.mock("../src/jobs/limitless-recorder", () => ({ runLimitlessRecorder: vi.fn(async () => ({ recorded: true, errors: [] })) }));

import { verifyDispatchSignature } from "../src/api/dispatch-auth";
import { internal, LIMITLESS_RECORD_ID } from "../src/api/internal";
import { runWatch } from "../src/ingest/watch";
import { runLimitlessRecorder } from "../src/jobs/limitless-recorder";

const SECRET = "test-internal-hmac-secret";
/** What migrations 007/013 (select_due_watches) and 018 (dispatch_internal) compute in SQL. */
const sign = (id: string, minute: string, secret = SECRET) => createHmac("sha256", secret).update(`${id}|${minute}`, "utf8").digest("hex");
const minuteOf = (ms: number) => new Date(ms).toISOString().slice(0, 16);

describe("verifyDispatchSignature", () => {
  const now = Date.parse("2026-10-20T12:00:30.000Z");
  const minute = "2026-10-20T12:00";
  it("accepts the SQL scheme for the id it was signed for", async () => {
    expect(await verifyDispatchSignature(SECRET, "limitless_record", sign("limitless_record", minute), minute, now)).toEqual({ ok: true });
    expect(await verifyDispatchSignature(SECRET, "4a0c5f0e-8b1c-4f55-9d33-0d6b1b0a1f00", sign("4a0c5f0e-8b1c-4f55-9d33-0d6b1b0a1f00", minute), minute, now)).toEqual({ ok: true });
  });
  it("the id is in the MAC: another id, another secret or a tampered minute is invalid", async () => {
    expect(await verifyDispatchSignature(SECRET, "limitless_record", sign("some-watch-id", minute), minute, now)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyDispatchSignature(SECRET, "limitless_record", sign("limitless_record", minute, "other-secret"), minute, now)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyDispatchSignature(SECRET, "limitless_record", sign("limitless_record", minute), "2026-10-20T12:01", now)).toEqual({ ok: false, reason: "invalid" });
  });
  it("only within ±3 minutes of the dispatch minute (the literal spec, not the constant, so widening it goes red)", async () => {
    const t = Date.parse(minute + ":00Z");
    const threeMin = 180_000;
    expect(await verifyDispatchSignature(SECRET, "x", sign("x", minute), minute, t + threeMin)).toEqual({ ok: true });
    expect(await verifyDispatchSignature(SECRET, "x", sign("x", minute), minute, t - threeMin)).toEqual({ ok: true });
    expect(await verifyDispatchSignature(SECRET, "x", sign("x", minute), minute, t + threeMin + 1)).toEqual({ ok: false, reason: "stale" });
    expect(await verifyDispatchSignature(SECRET, "x", sign("x", minute), minute, t - threeMin - 1)).toEqual({ ok: false, reason: "stale" });
    expect(await verifyDispatchSignature(SECRET, "x", sign("x", "garbage"), "garbage", now)).toEqual({ ok: false, reason: "stale" });
  });
  it("missing headers, or no secret configured, never pass", async () => {
    expect(await verifyDispatchSignature(SECRET, "x", undefined, minute, now)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyDispatchSignature(SECRET, "x", sign("x", minute), undefined, now)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyDispatchSignature("", "x", sign("x", minute, ""), minute, now)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyDispatchSignature(undefined, "x", sign("x", minute, ""), minute, now)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("signed internal routes", () => {
  const env = {
    INTERNAL_HMAC_SECRET: SECRET, ADMIN_API_KEY: "admin-test-key", JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "1200", SPOTLIGHT_SECRET: "s",
    SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized", EVAL_REPORT_KEY: "e",
  } as unknown as Env;
  const WATCH = "4a0c5f0e-8b1c-4f55-9d33-0d6b1b0a1f00";
  const post = (path: string, headers: Record<string, string>) => internal.request(path, { method: "POST", headers }, env);
  const signed = (id: string, minute = minuteOf(Date.now())) => ({ "x-internal-signature": sign(id, minute), "x-internal-minute": minute });
  beforeEach(() => { vi.mocked(runWatch).mockClear(); vi.mocked(runLimitlessRecorder).mockClear(); });

  const routes = [
    { path: `/watch/${WATCH}`, id: WATCH, other: LIMITLESS_RECORD_ID, run: () => vi.mocked(runWatch) },
    { path: "/limitless/record", id: LIMITLESS_RECORD_ID, other: WATCH, run: () => vi.mocked(runLimitlessRecorder) },
  ];
  for (const r of routes) {
    describe(`POST ${r.path}`, () => {
      it("runs for a signature over its own id", async () => {
        const res = await post(r.path, signed(r.id));
        expect(res.status).toBe(200);
        expect(r.run()).toHaveBeenCalledTimes(1);
      });
      it("refuses the other route's signature, a stale minute and no signature, without running", async () => {
        const a = await post(r.path, signed(r.other));
        expect(a.status).toBe(403);
        expect(await a.text()).toContain("invalid internal signature");
        const b = await post(r.path, signed(r.id, minuteOf(Date.now() - 10 * 60_000)));
        expect(b.status).toBe(403);
        expect(await b.text()).toContain("bad or stale internal signature");
        expect((await post(r.path, {})).status).toBe(403);
        expect(r.run()).not.toHaveBeenCalled();
      });
      it("the admin bearer runs it by hand", async () => {
        expect((await post(r.path, { authorization: "Bearer admin-test-key" })).status).toBe(200);
        expect((await post(r.path, { authorization: "Bearer wrong" })).status).toBe(403);
        expect(r.run()).toHaveBeenCalledTimes(1);
      });
    });
  }

  it("the recorder run gets the invocation's waitUntil, so its alert goes out after the answer", async () => {
    const waitUntil = vi.fn();
    const ctx = { waitUntil, passThroughOnException: () => {}, props: {} };
    const res = await internal.request("/limitless/record", { method: "POST", headers: signed(LIMITLESS_RECORD_ID) }, env, ctx as never);
    expect(res.status).toBe(200);
    const opts = vi.mocked(runLimitlessRecorder).mock.calls[0]![1];
    const p = Promise.resolve();
    opts!.waitUntil!(p);
    expect(waitUntil).toHaveBeenCalledWith(p);
  });

  it("a recorder run that could not write its loop_runs row answers 500, so dispatch_failures() counts it", async () => {
    vi.mocked(runLimitlessRecorder).mockResolvedValueOnce({ recorded: false, errors: [] } as never);
    expect((await post("/limitless/record", signed(LIMITLESS_RECORD_ID))).status).toBe(500);
  });
});

import { describe, expect, it } from "vitest";
import { decideFailure, decideWatchAction, deferredNextPoll, needsDeadlineLookup, ERROR_STREAK_ALERT } from "../src/ingest/watch";

const A = "a".repeat(64), B = "b".repeat(64);

describe("decideWatchAction truth table", () => {
  // changeSha, last, afterDeadline, resolvedSinceDeadline -> store, reason
  it.each([
    [A, null, false, false, true, "first_observation"],
    [A, undefined, true, true, true, "first_observation"],
    [A, B, false, false, true, "changed"],
    [A, B, true, true, true, "changed"],
    [A, B, true, false, true, "changed"],
    [A, A, false, false, false, "unchanged"],
    [A, A, false, true, false, "unchanged"],
    [A, A, true, false, true, "post_deadline_observation"],
    [A, A, true, true, false, "unchanged"],
  ] as const)("change=%s last=%s after=%s resolved=%s -> store=%s (%s)", (changeSha, last, afterDeadline, resolvedSinceDeadline, store, reason) => {
    expect(decideWatchAction({ changeSha, lastCanonicalHash: last, afterDeadline, resolvedSinceDeadline })).toEqual({ store, reason });
  });

  it("the resolutions lookup is needed only for an unchanged projection after the deadline", () => {
    expect(needsDeadlineLookup({ changeSha: A, lastCanonicalHash: A, afterDeadline: true })).toBe(true);
    expect(needsDeadlineLookup({ changeSha: A, lastCanonicalHash: A, afterDeadline: false })).toBe(false);
    expect(needsDeadlineLookup({ changeSha: A, lastCanonicalHash: B, afterDeadline: true })).toBe(false);
    expect(needsDeadlineLookup({ changeSha: A, lastCanonicalHash: null, afterDeadline: true })).toBe(false);
  });
});

describe("decideFailure", () => {
  it("first HTTP failure after a 200 alerts once; the streak alert fires exactly at 3", () => {
    expect(decideFailure({ prevErrors: 0, prevHttpStatus: 200, httpStatus: 403 })).toEqual({ consecutiveErrors: 1, alertHttp: true, alertStreak: false });
    expect(decideFailure({ prevErrors: 1, prevHttpStatus: 403, httpStatus: 403 })).toEqual({ consecutiveErrors: 2, alertHttp: false, alertStreak: false });
    expect(decideFailure({ prevErrors: 2, prevHttpStatus: 403, httpStatus: 403 })).toEqual({ consecutiveErrors: ERROR_STREAK_ALERT, alertHttp: false, alertStreak: true });
    expect(decideFailure({ prevErrors: 3, prevHttpStatus: 403, httpStatus: 403 })).toEqual({ consecutiveErrors: 4, alertHttp: false, alertStreak: false });
  });
  it("a 304 (conditional GET) counts as an OK previous answer", () => {
    expect(decideFailure({ prevErrors: 0, prevHttpStatus: 304, httpStatus: 502 }).alertHttp).toBe(true);
  });
  it("a redirect gap keeps last_http_status at 200, so only the first failure of the streak alerts", () => {
    expect(decideFailure({ prevErrors: 0, prevHttpStatus: 200, httpStatus: 200 }).alertHttp).toBe(true);
    expect(decideFailure({ prevErrors: 1, prevHttpStatus: 200, httpStatus: 200 }).alertHttp).toBe(false);
  });
  it("no HTTP alert without an HTTP answer or without a known OK before", () => {
    expect(decideFailure({ prevErrors: 0, prevHttpStatus: 200 }).alertHttp).toBe(false);          // transport / RPC / resolve failure
    expect(decideFailure({ prevErrors: 0, prevHttpStatus: null, httpStatus: 403 }).alertHttp).toBe(false); // first poll after migration 011
    expect(decideFailure({ prevErrors: 0, prevHttpStatus: 404, httpStatus: 403 }).alertHttp).toBe(false);
  });
});

describe("deferredNextPoll", () => {
  const now = Date.parse("2026-09-23T06:00:00Z");
  it("pushes next_poll_at later when the source asks for longer than the lease schedule", () => {
    expect(deferredNextPoll(now, 900, "2026-09-23T06:05:00Z")).toBe("2026-09-23T06:15:00.000Z");
  });
  it("never pulls a poll earlier than already scheduled", () => {
    expect(deferredNextPoll(now, 60, "2026-09-23T06:05:00Z")).toBeUndefined();
    expect(deferredNextPoll(now, 300, "2026-09-23T06:05:00Z")).toBeUndefined();
  });
  it("no deferral requested -> nothing; unknown schedule -> now + defer", () => {
    expect(deferredNextPoll(now, undefined, "2026-09-23T06:05:00Z")).toBeUndefined();
    expect(deferredNextPoll(now, 0, undefined)).toBeUndefined();
    expect(deferredNextPoll(now, 120, undefined)).toBe("2026-09-23T06:02:00.000Z");
  });
});

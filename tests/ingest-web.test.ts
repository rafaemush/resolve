import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fetchWeb } from "../src/ingest/web";
import { retryAfterSeconds, clampDefer } from "../src/ingest/http";
import { sourceMatches, webUrlMatches } from "../src/resolve/precheck";
import type { MarketRegistration } from "../src/resolve/schema";
import type { WatchRow } from "../src/ingest/types";
import { __setRailsForMutationTesting } from "../src/resolve/rails";

const watch = (url: string): WatchRow => ({ id: "w1", market_id: "m1", source_kind: "web_fetch", source_ref: { url }, poll_interval_s: 300, etag: null, cursor: {}, coverage: [], last_evidence_hash: null, consecutive_errors: 0, backlog: false, active: true });

// text/plain keeps HTMLRewriter (workerd only) out of these node tests; the redirect rule runs before any parsing.
function respond(status: number, body: string | null, headers: Record<string, string> = {}, finalUrl?: string) {
  vi.stubGlobal("fetch", async () => {
    const res = new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });
    if (finalUrl) { Object.defineProperty(res, "redirected", { value: true }); Object.defineProperty(res, "url", { value: finalUrl }); }
    return res;
  });
}

afterEach(() => { vi.unstubAllGlobals(); __setRailsForMutationTesting([]); });

describe("webUrlMatches (precheck's web source rule, shared with the redirect guard)", () => {
  it.each([
    ["http://aurora.example/status", "https://aurora.example/status", true],
    ["https://aurora.example/blog", "https://aurora.example/blog/", true],
    ["https://aurora.example/", "https://www.aurora.example/", true],
    ["https://WWW.Aurora.example/", "https://aurora.example:8443/x", true],
    ["https://aurora.example/posts", "https://aurora.example/posts/v2-launch", true],
    ["https://blog.aurora.example/posts/v2-launch", "https://blog.aurora.example/", false],
    ["https://blog.aurora.example/posts/v2-launch", "https://blog.aurora.example/login?next=/posts/v2-launch", false],
    ["https://aurora.example/posts", "https://aurora.example/posts-archive", false],
    ["https://blog.aurora.example/", "https://aurora.example/", false],
    ["https://aurora.example/", "https://parked-domains.example/aurora", false],
    ["https://aurora.example/", "https://aurora.example.evil.test/", false],
    ["not a url", "https://aurora.example/", false],
  ])("%s -> %s = %s", (a, b, want) => {
    expect(webUrlMatches(a, b)).toBe(want);
  });
});

describe("retryAfterSeconds / clampDefer", () => {
  const now = Date.parse("2026-09-23T06:00:00Z");
  it("parses both forms and caps at an hour", () => {
    expect(retryAfterSeconds(new Headers({ "retry-after": "120" }), now)).toBe(120);
    expect(retryAfterSeconds(new Headers({ "retry-after": "Wed, 23 Sep 2026 07:30:00 GMT" }), now)).toBe(3600);
    expect(retryAfterSeconds(new Headers({}), now)).toBeUndefined();
  });
  it("rejects zero, negative and non-finite values", () => {
    expect(clampDefer(0)).toBeUndefined();
    expect(clampDefer(-1)).toBeUndefined();
    expect(clampDefer(Number.NaN)).toBeUndefined();
    expect(clampDefer(1.2)).toBe(2);
  });
});

describe("fetchWeb redirects and non-200", () => {
  it("a redirect to a different site is a gap with no evidence", async () => {
    respond(200, "Aurora v2 upgrade is live. Buy this domain.", {}, "https://parked-domains.example/aurora");
    const out = await fetchWeb({} as Env, watch("https://blog.aurora.example/"), "UA");
    expect(out.evidence).toBeUndefined();
    expect(out.rawBytes).toBeUndefined();
    expect(out.error).toBe("web https://blog.aurora.example/ redirected outside the registered source to https://parked-domains.example/aurora");
    expect(out.window?.status).toBe("gap");
    expect(out.httpStatus).toBe(200);
  });

  it("a same-site redirect (http -> https, www., trailing slash) is evidence and records final_url", async () => {
    respond(200, "Aurora status: v2 upgrade activated on mainnet.", {}, "https://www.aurora.example/status/");
    const out = await fetchWeb({} as Env, watch("http://aurora.example/status"), "UA");
    expect(out.error).toBeUndefined();
    expect(out.evidence?.source_url).toBe("https://www.aurora.example/status/");
    expect(out.evidence?.provenance).toMatchObject({ url: "http://aurora.example/status", final_url: "https://www.aurora.example/status/", redirected: true });
    expect(out.httpStatus).toBe(200);
  });

  it("a same-host redirect off the registered path (moved article -> homepage) is a gap, never a SOURCE_MISMATCH verdict", async () => {
    respond(200, "Aurora blog. Latest posts: community call notes, validator guide.", {}, "https://blog.aurora.example/");
    const out = await fetchWeb({} as Env, watch("https://blog.aurora.example/posts/v2-launch"), "UA");
    expect(out.evidence).toBeUndefined();
    expect(out.rawBytes).toBeUndefined();
    expect(out.error).toBe("web https://blog.aurora.example/posts/v2-launch redirected outside the registered source to https://blog.aurora.example/");
    expect(out.window?.status).toBe("gap");
  });

  it("a trailing-slash redirect on the registered path is evidence", async () => {
    respond(200, "Aurora v2 launch: the upgrade activated on mainnet.", {}, "https://blog.aurora.example/posts/v2-launch/");
    const out = await fetchWeb({} as Env, watch("https://blog.aurora.example/posts/v2-launch"), "UA");
    expect(out.error).toBeUndefined();
    expect(out.evidence?.source_url).toBe("https://blog.aurora.example/posts/v2-launch/");
    const market = { sources: [{ kind: "web_fetch", ref: "https://blog.aurora.example/posts/v2-launch" }] } as MarketRegistration;
    expect(sourceMatches(market, out.evidence!).pass).toBe(true); // accepted by the guard => accepted by precheck
  });

  it("no redirect: final_url is the registered URL", async () => {
    respond(200, "Aurora status: v2 upgrade activated on mainnet.");
    const out = await fetchWeb({} as Env, watch("https://aurora.example/status"), "UA");
    expect(out.evidence?.provenance).toMatchObject({ final_url: "https://aurora.example/status", redirected: false });
  });

  it("429 with Retry-After -> gap, status and deferral, no evidence", async () => {
    respond(429, "Too Many Requests", { "retry-after": "120" });
    const out = await fetchWeb({} as Env, watch("https://aurora.example/status"), "UA");
    expect(out.evidence).toBeUndefined();
    expect(out).toMatchObject({ httpStatus: 429, deferSeconds: 120, window: { status: "gap" } });
    expect(out.error).toBe("web 429 for https://aurora.example/status");
  });

  it("a page over the byte cap is a gap", async () => {
    respond(200, "x".repeat(512 * 1024 + 1));
    const out = await fetchWeb({} as Env, watch("https://aurora.example/status"), "UA");
    expect(out.evidence).toBeUndefined();
    expect(out.error).toMatch(/^page too large/);
  });

  it("rail off (mutation harness only): an off-site redirect is accepted as before", async () => {
    __setRailsForMutationTesting(["non200_never_evidence"]);
    respond(200, "Aurora v2 upgrade is live. Buy this domain.", {}, "https://parked-domains.example/aurora");
    const out = await fetchWeb({} as Env, watch("https://blog.aurora.example/"), "UA");
    expect(out.evidence?.source_url).toBe("https://parked-domains.example/aurora");
  });
});

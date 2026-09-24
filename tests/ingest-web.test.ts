import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fetchWeb, WEB_FETCH_SUBREQUESTS, WEB_MAX_REDIRECTS } from "../src/ingest/web";
import { retryAfterSeconds, clampDefer } from "../src/ingest/http";
import { sourceMatches, webUrlMatches } from "../src/resolve/precheck";
import type { MarketRegistration } from "../src/resolve/schema";
import type { WatchRow } from "../src/ingest/types";
import { __setRailsForMutationTesting } from "../src/resolve/rails";

const watch = (url: string): WatchRow => ({ id: "w1", market_id: "m1", source_kind: "web_fetch", source_ref: { url }, poll_interval_s: 300, etag: null, cursor: {}, coverage: [], last_evidence_hash: null, consecutive_errors: 0, backlog: false, active: true });

// text/plain keeps HTMLRewriter (workerd only) out of these node tests; the redirect rule runs before any parsing.
// fetchWeb follows redirects itself (redirect: "manual"): a finalUrl is played as one 301 hop to it, then the answer.
function respond(status: number, body: string | null, headers: Record<string, string> = {}, finalUrl?: string) {
  const calls: Array<{ url: string; redirect: string | undefined }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), redirect: init?.redirect });
    if (finalUrl && String(input) !== finalUrl) return new Response(null, { status: 301, headers: { location: finalUrl } });
    return new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });
  });
  return calls;
}
/** One answer per request, in order (the last one repeats). */
function answers(list: Array<{ status: number; location?: string; body?: string }>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const a = list[Math.min(calls.length - 1, list.length - 1)]!;
    return new Response(a.body ?? null, { status: a.status, headers: { "content-type": "text/plain", ...(a.location ? { location: a.location } : {}) } });
  });
  return calls;
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
  it("a redirect to a different site is a gap with no evidence, and the other site is never requested", async () => {
    const calls = respond(200, "Aurora v2 upgrade is live. Buy this domain.", {}, "https://parked-domains.example/aurora");
    const out = await fetchWeb({} as Env, watch("https://blog.aurora.example/"), "UA");
    expect(out.evidence).toBeUndefined();
    expect(out.rawBytes).toBeUndefined();
    expect(out.error).toBe("web https://blog.aurora.example/ redirected outside the registered source to https://parked-domains.example/aurora");
    expect(out.window?.status).toBe("gap");
    expect(out.httpStatus).toBe(301); // the answer we got; the page it points at was never fetched
    expect(calls).toEqual([{ url: "https://blog.aurora.example/", redirect: "manual" }]);
  });

  it("a same-site redirect (http -> https, www., trailing slash) is evidence and records final_url", async () => {
    const calls = respond(200, "Aurora status: v2 upgrade activated on mainnet.", {}, "https://www.aurora.example/status/");
    const out = await fetchWeb({} as Env, watch("http://aurora.example/status"), "UA");
    expect(out.error).toBeUndefined();
    expect(out.evidence?.source_url).toBe("https://www.aurora.example/status/");
    expect(out.evidence?.provenance).toMatchObject({ url: "http://aurora.example/status", final_url: "https://www.aurora.example/status/", redirected: true });
    expect(out.httpStatus).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["http://aurora.example/status", "https://www.aurora.example/status/"]);
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

describe("fetchWeb: the web URL policy on every poll and every redirect hop", () => {
  it("a stored URL the policy refuses (a row from before migration 019) is never requested", async () => {
    for (const url of ["https://169.254.169.254/latest/meta-data/", "http://127.0.0.1/admin", "https://user:pw@aurora.example/status", "https://aurora.example:8443/status", "https://metadata.google.internal/"]) {
      const calls = answers([{ status: 200, body: "secret" }]);
      const out = await fetchWeb({} as Env, watch(url), "UA");
      expect(out.error, url).toContain("refused by the URL policy");
      expect(out.evidence, url).toBeUndefined();
      expect(calls, url).toHaveLength(0);
    }
  });

  it("a redirect hop to a private, loopback or link-local address is refused before it is requested, rail on or off", async () => {
    for (const rails of [[], ["non200_never_evidence"]] as const) {
      __setRailsForMutationTesting([...rails]);
      for (const location of ["http://169.254.169.254/latest/meta-data/", "https://127.0.0.1/", "https://[::1]/", "https://10.0.0.7/status"]) {
        const calls = answers([{ status: 302, location }, { status: 200, body: "secret" }]);
        const out = await fetchWeb({} as Env, watch("https://aurora.example/status"), "UA");
        expect(out.error, location).toContain("which is not fetched");
        expect(out).toMatchObject({ httpStatus: 302, window: { status: "gap" } });
        expect(calls, location).toEqual(["https://aurora.example/status"]);
      }
    }
  });

  it("an https page is never downgraded to http, even on its own host", async () => {
    const calls = answers([{ status: 301, location: "http://aurora.example/status" }, { status: 200, body: "Aurora status" }]);
    const out = await fetchWeb({} as Env, watch("https://aurora.example/status"), "UA");
    expect(out.error).toContain("is not https");
    expect(calls).toHaveLength(1);
  });

  it("follows a relative Location on the same site", async () => {
    const calls = answers([{ status: 308, location: "/status/" }, { status: 200, body: "Aurora status: v2 upgrade activated on mainnet." }]);
    const out = await fetchWeb({} as Env, watch("https://aurora.example/status"), "UA");
    expect(out.evidence?.source_url).toBe("https://aurora.example/status/");
    expect(calls).toEqual(["https://aurora.example/status", "https://aurora.example/status/"]);
  });

  it("a 3xx without Location, or more than WEB_MAX_REDIRECTS hops, is a gap in at most WEB_FETCH_SUBREQUESTS requests", async () => {
    answers([{ status: 302 }]);
    expect((await fetchWeb({} as Env, watch("https://aurora.example/status"), "UA")).error).toContain("without a usable Location");
    const calls = answers([{ status: 301, location: "https://aurora.example/status/loop" }]);
    const out = await fetchWeb({} as Env, watch("https://aurora.example/status"), "UA");
    expect(out.error).toContain(`more than ${WEB_MAX_REDIRECTS}`);
    expect(out.evidence).toBeUndefined();
    expect(calls).toHaveLength(WEB_FETCH_SUBREQUESTS);
  });

  it("304 is not a redirect: an unchanged page", async () => {
    answers([{ status: 304 }]);
    const out = await fetchWeb({} as Env, { ...watch("https://aurora.example/status"), etag: "\"v1\"" }, "UA");
    expect(out).toMatchObject({ notModified: true, httpStatus: 304 });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fetchGithub, githubDeferSeconds } from "../src/ingest/github";
import type { WatchRow } from "../src/ingest/types";
import { __setRailsForMutationTesting } from "../src/resolve/rails";

// The body production stored as evidence 28 times (plan §16.2).
const RATE_LIMIT_403 = '{"message":"API rate limit exceeded for 162.158.0.1. (But here\'s the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)","documentation_url":"https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting"}';
const PR = { number: 4821, state: "open", merged_at: null, head: { repo: {} }, base: { repo: { full_name: "openai/openai-python" } }, updated_at: "2026-09-23T06:00:00Z" };

const watch = (over: Partial<WatchRow> = {}): WatchRow => ({ id: "w1", market_id: "m1", source_kind: "github_api", source_ref: { ref: "repos/openai/openai-python/pulls/4821" }, poll_interval_s: 300, etag: null, cursor: { last_to: "2026-09-23T06:00:00.000Z" }, coverage: [], last_evidence_hash: null, consecutive_errors: 0, backlog: false, active: true, ...over });

function respond(status: number, body: string | null, headers: Record<string, string> = {}, redirect?: { url: string }) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const res = new Response(body, { status, headers: { date: "Wed, 23 Sep 2026 06:05:00 GMT", ...headers } });
    if (redirect) { Object.defineProperty(res, "redirected", { value: true }); Object.defineProperty(res, "url", { value: redirect.url }); }
    return res;
  });
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); __setRailsForMutationTesting([]); });

describe("fetchGithub: only a 200 from the registered URL is evidence", () => {
  it("403 rate-limit body -> gap, no evidence, no raw bytes, status and reset recorded", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    respond(403, RATE_LIMIT_403, { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
    const out = await fetchGithub({} as Env, watch(), "github_pr_merged", "UA");
    expect(out.evidence).toBeUndefined();
    expect(out.rawBytes).toBeUndefined();
    expect(out.error).toContain("github 403");
    expect(out.error).toContain("API rate limit exceeded");
    expect(out.httpStatus).toBe(403);
    expect(out.window).toEqual({ from: "2026-09-23T06:00:00.000Z", to: "2026-09-23T06:05:00.000Z", status: "gap" });
    expect(out.cursor).toMatchObject({ last_to: "2026-09-23T06:05:00.000Z" });
    expect(out.deferSeconds).toBeGreaterThanOrEqual(599);
    expect(out.deferSeconds).toBeLessThanOrEqual(600);
    expect(out.etag).toBeUndefined(); // the stored etag survives the error
  });

  it.each([404, 410, 451, 500, 502, 503])("%i -> gap without evidence", async (status) => {
    respond(status, status >= 500 ? "<html>502 Bad Gateway</html>" : '{"message":"Not Found"}', { "content-type": status >= 500 ? "text/html" : "application/json" });
    const out = await fetchGithub({} as Env, watch(), "github_pr_merged", "UA");
    expect(out.evidence).toBeUndefined();
    expect(out.rawBytes).toBeUndefined();
    expect(out.httpStatus).toBe(status);
    expect(out.window?.status).toBe("gap");
    expect(out.error).toMatch(new RegExp(`^github ${status} for repos/openai/openai-python/pulls/4821`));
  });

  it("a redirect (repo renamed or transferred) is a gap even when the final answer is 200", async () => {
    respond(200, JSON.stringify(PR), { "content-type": "application/json" }, { url: "https://api.github.com/repositories/188613327/pulls/4821" });
    const out = await fetchGithub({} as Env, watch(), "github_pr_merged", "UA");
    expect(out.evidence).toBeUndefined();
    expect(out.error).toBe("github repos/openai/openai-python/pulls/4821 redirected to https://api.github.com/repositories/188613327/pulls/4821 (repo renamed or transferred?)");
    expect(out.window?.status).toBe("gap");
    expect(out.httpStatus).toBe(200);
  });

  it("304 -> notModified with the stored etag, ok window", async () => {
    const calls = respond(304, null, { etag: 'W/"abc"' });
    const out = await fetchGithub({} as Env, watch({ etag: 'W/"abc"' }), "github_pr_merged", "UA");
    expect(calls[0]!.headers["If-None-Match"]).toBe('W/"abc"');
    expect(out).toMatchObject({ notModified: true, etag: 'W/"abc"', httpStatus: 304, window: { status: "ok" } });
    expect(out.evidence).toBeUndefined();
  });

  it("200 -> evidence with raw bytes, status 200 and the ok window", async () => {
    respond(200, JSON.stringify(PR), { "content-type": "application/json", etag: 'W/"def"', "x-ratelimit-remaining": "4999" });
    const out = await fetchGithub({} as Env, watch(), "github_pr_merged", "UA");
    expect(out.error).toBeUndefined();
    expect(out.httpStatus).toBe(200);
    expect(out.deferSeconds).toBeUndefined();
    expect(out.rawBytes?.byteLength).toBe(JSON.stringify(PR).length);
    expect(out.evidence).toMatchObject({ source_kind: "github_api", http_status: 200, coverage: { snapshot_status: 200, deciding_field_present: true } });
    expect(out.window?.status).toBe("ok");
  });

  it("rail off (mutation harness only): the pre-P1a behaviour returns the 403 body as evidence", async () => {
    __setRailsForMutationTesting(["non200_never_evidence"]);
    respond(403, RATE_LIMIT_403, { "content-type": "application/json" });
    const out = await fetchGithub({} as Env, watch(), "github_pr_merged", "UA");
    expect(out.evidence?.http_status).toBe(403);
    expect(out.rawBytes).toBeDefined();
  });
});

describe("githubDeferSeconds", () => {
  const now = Date.parse("2026-09-23T06:00:00Z");
  const h = (x: Record<string, string>) => new Headers(x);
  it("Retry-After as delta-seconds and as an HTTP-date", () => {
    expect(githubDeferSeconds(h({ "retry-after": "90" }), now)).toBe(90);
    expect(githubDeferSeconds(h({ "retry-after": "Wed, 23 Sep 2026 06:02:00 GMT" }), now)).toBe(120);
  });
  it("primary rate limit: only when remaining is 0, until the reset", () => {
    const reset = String(now / 1000 + 754);
    expect(githubDeferSeconds(h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), now)).toBe(754);
    expect(githubDeferSeconds(h({ "x-ratelimit-remaining": "12", "x-ratelimit-reset": reset }), now)).toBeUndefined();
  });
  it("X-Poll-Interval (events API)", () => {
    expect(githubDeferSeconds(h({ "x-poll-interval": "60" }), now)).toBe(60);
  });
  it("the largest signal wins and everything is capped at 3600 s", () => {
    expect(githubDeferSeconds(h({ "retry-after": "30", "x-poll-interval": "60" }), now)).toBe(60);
    expect(githubDeferSeconds(h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 86_400) }), now)).toBe(3600);
    expect(githubDeferSeconds(h({ "retry-after": "999999" }), now)).toBe(3600);
  });
  it("absent, past or malformed values defer nothing", () => {
    expect(githubDeferSeconds(h({}), now)).toBeUndefined();
    expect(githubDeferSeconds(h({ "retry-after": "Wed, 23 Sep 2026 05:00:00 GMT" }), now)).toBeUndefined();
    expect(githubDeferSeconds(h({ "retry-after": "soon", "x-poll-interval": "-5" }), now)).toBeUndefined();
    expect(githubDeferSeconds(h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 - 10) }), now)).toBeUndefined();
  });
});

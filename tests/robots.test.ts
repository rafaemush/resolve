/**
 * robots.txt: the rule matcher, the verdict of a body, and robotsAllows() per RFC 9309 against a stubbed fetch:
 * 4xx unavailable = allow (429 aside), 5xx / 429 / timeout / network error unreachable = complete disallow, redirects
 * followed up to five hops through the web URL policy, and the pre-P1a reading with the rail off.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { ruleToRegex, robotsAllows, robotsVerdict, ROBOTS_MAX_REDIRECTS, ROBOTS_SUBREQUESTS } from "../src/ingest/robots";
import { __setRailsForMutationTesting } from "../src/resolve/rails";

const UA = "ResolveBot/1.0 (+test)";
const PAGE = "https://status.acme-widget.example/v2/status";

type Answer = { status: number; body?: string; headers?: Record<string, string> } | "timeout" | "network";
function stub(answers: Answer[]) {
  const calls: Array<{ url: string; redirect: string | undefined }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), redirect: init?.redirect });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (a === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (a === "network") throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
    return new Response(a.body ?? null, { status: a.status, headers: a.headers ?? {} });
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); __setRailsForMutationTesting([]); });

describe("robots rule matching", () => {
  it("treats wildcards as runs, not as a prefix cut", () => {
    expect(ruleToRegex("/*/pulse").test("/vercel/pulse")).toBe(true);
    expect(ruleToRegex("/*/pulse").test("/vercel/next.js/releases")).toBe(false);
    expect(ruleToRegex("/*/*/pull/*/").test("/openai/openai-python/pull/4821/files")).toBe(true);
    expect(ruleToRegex("/").test("/anything")).toBe(true);
    expect(ruleToRegex("/blog$").test("/blog")).toBe(true);
    expect(ruleToRegex("/blog$").test("/blog/next-15")).toBe(false);
    expect(ruleToRegex("/api/").test("/apiary")).toBe(false);
  });

  it("picks our UA's group over '*', and the longest rule wins with Allow on a tie", () => {
    const body = "User-agent: *\nDisallow: /\n\nUser-agent: ResolveBot\nDisallow: /v2/\nAllow: /v2/status\n";
    expect(robotsVerdict(body, new URL(PAGE), UA).allowed).toBe(true);
    expect(robotsVerdict(body, new URL("https://status.acme-widget.example/v2/admin"), UA)).toMatchObject({ allowed: false, reason: expect.stringContaining("/v2/") });
    expect(robotsVerdict("User-agent: *\nDisallow: /v2/\n", new URL(PAGE), UA).allowed).toBe(false);
    expect(robotsVerdict("User-agent: other\nDisallow: /\n", new URL(PAGE), UA)).toEqual({ allowed: true, reason: "no matching group" });
  });
});

describe("robotsAllows (RFC 9309)", () => {
  it("asks the page's origin, never following redirects blindly", async () => {
    const calls = stub([{ status: 200, body: "User-agent: *\nAllow: /\n" }]);
    expect((await robotsAllows(PAGE, UA)).allowed).toBe(true);
    expect(calls).toEqual([{ url: "https://status.acme-widget.example/robots.txt", redirect: "manual" }]);
  });

  it("allows on 4xx (unavailable), 404 and 403 alike", async () => {
    for (const status of [400, 401, 403, 404, 410]) {
      stub([{ status }]);
      expect(await robotsAllows(PAGE, UA), String(status)).toMatchObject({ allowed: true, reason: expect.stringContaining("unavailable") });
    }
  });

  it("disallows on 5xx and 429, flagged unreachable (complete disallow for now, not a verdict on the page)", async () => {
    for (const status of [500, 502, 503, 504, 429]) {
      stub([{ status }]);
      expect(await robotsAllows(PAGE, UA), String(status)).toMatchObject({ allowed: false, unreachable: true, reason: expect.stringContaining("complete disallow") });
    }
  });

  it("disallows on a timeout and on a network error, flagged unreachable: found nothing is not could not look", async () => {
    stub(["timeout"]);
    expect(await robotsAllows(PAGE, UA)).toMatchObject({ allowed: false, unreachable: true, reason: expect.stringContaining("timed out") });
    stub(["network"]);
    expect(await robotsAllows(PAGE, UA)).toMatchObject({ allowed: false, unreachable: true, reason: expect.stringContaining("unreachable") });
  });

  it("a rule, a refused redirect or a 3xx without Location is a disallow the server gave: not unreachable", async () => {
    stub([{ status: 200, body: "User-agent: *\nDisallow: /v2/\n" }]);
    expect((await robotsAllows(PAGE, UA)).unreachable).toBeUndefined();
    stub([{ status: 301, headers: { location: "http://127.0.0.1/robots.txt" } }]);
    expect((await robotsAllows(PAGE, UA)).unreachable).toBeUndefined();
    stub([{ status: 302 }]);
    expect((await robotsAllows(PAGE, UA)).unreachable).toBeUndefined();
  });

  it("follows a redirect to another public https host and reads the rules there", async () => {
    const calls = stub([{ status: 301, headers: { location: "https://www.acme-widget.example/robots.txt" } }, { status: 200, body: "User-agent: *\nDisallow: /v2/\n" }]);
    expect(await robotsAllows(PAGE, UA)).toMatchObject({ allowed: false, reason: expect.stringContaining("/v2/") });
    expect(calls.map((c) => c.url)).toEqual(["https://status.acme-widget.example/robots.txt", "https://www.acme-widget.example/robots.txt"]);
  });

  it("resolves a relative Location against the robots.txt URL", async () => {
    const calls = stub([{ status: 302, headers: { location: "/robots-live.txt" } }, { status: 404 }]);
    expect((await robotsAllows(PAGE, UA)).allowed).toBe(true);
    expect(calls[1]!.url).toBe("https://status.acme-widget.example/robots-live.txt");
  });

  it("never follows a redirect to a private, loopback or plain-http URL, and never requests it", async () => {
    for (const location of ["http://127.0.0.1/robots.txt", "https://169.254.169.254/latest", "https://[::1]/robots.txt", "https://printer.local/robots.txt"]) {
      const calls = stub([{ status: 301, headers: { location } }, { status: 200, body: "" }]);
      expect(await robotsAllows(PAGE, UA), location).toMatchObject({ allowed: false, reason: expect.stringContaining("is not fetched") });
      expect(calls, location).toHaveLength(1);
    }
  });

  it("a 3xx without Location is a disallow; more than five hops is unavailable = allow, in at most ROBOTS_SUBREQUESTS requests", async () => {
    stub([{ status: 302 }]);
    expect((await robotsAllows(PAGE, UA)).allowed).toBe(false);
    const calls = stub([{ status: 301, headers: { location: "https://status.acme-widget.example/robots.txt" } }]);
    expect(await robotsAllows(PAGE, UA)).toMatchObject({ allowed: true, reason: expect.stringContaining(`more than ${ROBOTS_MAX_REDIRECTS}`) });
    expect(calls).toHaveLength(ROBOTS_SUBREQUESTS);
  });

  it("an invalid page URL is never allowed", async () => {
    const calls = stub([{ status: 404 }]);
    expect((await robotsAllows("not a url", UA)).allowed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("with the rail off reads robots.txt the pre-P1a way: failures allowed, redirects followed blindly", async () => {
    __setRailsForMutationTesting(["registration_policy"]);
    stub([{ status: 503 }]);
    expect((await robotsAllows(PAGE, UA)).allowed).toBe(true);
    stub(["timeout"]);
    expect((await robotsAllows(PAGE, UA)).allowed).toBe(true);
    const calls = stub([{ status: 200, body: "User-agent: *\nDisallow: /v2/\n" }]);
    expect((await robotsAllows(PAGE, UA)).allowed).toBe(false);
    expect(calls[0]!.redirect).toBe("follow");
  });
});

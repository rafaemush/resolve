/**
 * The registration policy (src/markets/policy.ts), pure: the web URL policy (scheme, userinfo, port, non-public names,
 * IPv4 and IPv6 literals in every refused range, spellings WHATWG URL normalizes), the per-kind ref grammar, the
 * resolver <-> source cross-check, web_render, and the rail switch.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ipv4Problem, ipv6Problem, parseGithubRef, registrationPolicyIssues, resolverSourceProblems, sourceRefProblem, webRenderRefusal, webUrlProblem } from "../src/markets/policy";
import { __setRailsForMutationTesting } from "../src/resolve/rails";
import type { MarketRegistration } from "../src/resolve/schema";

afterEach(() => __setRailsForMutationTesting([]));

type Sources = MarketRegistration["sources"];
const reg = (sources: Sources, resolver?: MarketRegistration["resolver"]) => ({ sources, resolver });
const ADDR = "0x000000000000000000000000000000000000beef";
const ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const TOPIC = `0x${"a".repeat(64)}`;

describe("webUrlProblem", () => {
  it("allows a public https URL, a public address literal and an uppercase host", () => {
    for (const u of ["https://www.bls.gov/news.release/cpi.nr0.htm", "https://Arena.AI/leaderboard", "https://8.8.8.8/", "https://[2001:4860:4860::8888]/", "https://example.com:443/x", "https://[::ffff:8.8.8.8]/"]) expect(webUrlProblem(u), u).toBeNull();
  });

  it("refuses another scheme, credentials, a non-default port and a relative URL", () => {
    expect(webUrlProblem("http://www.bls.gov/cpi/")).toContain("is not https");
    expect(webUrlProblem("ftp://example.com/x")).toContain("is not https");
    expect(webUrlProblem("https://user:pw@example.com/")).toContain("credentials");
    expect(webUrlProblem("https://user@example.com/")).toContain("credentials");
    expect(webUrlProblem("https://example.com:8443/")).toContain("port 8443");
    expect(webUrlProblem("/relative/path")).toContain("not an absolute URL");
  });

  it("refuses localhost and the non-public suffixes, a trailing dot included, and single-label hosts", () => {
    for (const u of ["https://localhost/", "https://LOCALHOST./", "https://printer.local/", "https://metadata.google.internal/", "https://app.localhost/", "https://intranet/"]) expect(webUrlProblem(u), u).not.toBeNull();
  });

  it("refuses every IPv4 range in the policy, at both edges, and keeps the neighbours", () => {
    const refused = ["0.0.0.0", "0.255.255.255", "10.0.0.1", "10.255.255.255", "100.64.0.0", "100.127.255.255", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255",
      "192.168.0.1", "198.18.0.0", "198.19.255.255", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255"];
    for (const ip of refused) expect(ipv4Problem(ip), ip).not.toBeNull();
    for (const ip of ["1.1.1.1", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0", "169.253.255.255", "172.15.255.255", "172.32.0.0", "192.167.255.255", "198.17.255.255", "198.20.0.0", "223.255.255.255"]) expect(ipv4Problem(ip), ip).toBeNull();
    expect(ipv4Problem("169.254.1.1")).toContain("link-local");
  });

  it("reads hosts after WHATWG normalization: hex, integer and short IPv4 spellings are the loopback", () => {
    for (const u of ["https://0x7f.1/", "https://2130706433/", "https://127.1/", "https://0177.0.0.1/"]) expect(webUrlProblem(u), u).toContain("loopback");
  });

  it("refuses the IPv6 ranges and IPv4-mapped or -compatible private addresses", () => {
    expect(ipv6Problem("::1")).toContain("loopback");
    expect(ipv6Problem("::")).toContain("unspecified");
    expect(ipv6Problem("fc00::1")).toContain("unique-local");
    expect(ipv6Problem("fdff:ffff::1")).toContain("unique-local");
    expect(ipv6Problem("fe80::1")).toContain("link-local");
    expect(ipv6Problem("febf::1")).toContain("link-local");
    expect(ipv6Problem("ff02::1")).toContain("multicast");
    expect(ipv6Problem("::ffff:127.0.0.1")).toContain("loopback");
    expect(ipv6Problem("::ffff:c0a8:101")).toContain("private");
    expect(ipv6Problem("::10.0.0.1")).toContain("private");
    expect(ipv6Problem("2001:db8::1")).toBeNull();
    expect(ipv6Problem("fec0::1")).toBeNull();
    expect(ipv6Problem("1:2:3:4:5:6:7:8:9")).toContain("not an IPv6 address");
    expect(webUrlProblem("https://[::ffff:10.0.0.7]/admin")).toContain("maps to 10.0.0.7 is a private address");
    expect(webUrlProblem("https://[fe80::1]/")).toContain("link-local");
  });
});

describe("source ref grammar", () => {
  it("parses the whitelisted GitHub resources", () => {
    expect(parseGithubRef("github_api", "repos/openai/openai-python/pulls/4821")).toEqual({ repo: "openai/openai-python", resource: "pulls", number: 4821 });
    expect(parseGithubRef("github_api", "/repos/o/r/issues/7")).toEqual({ repo: "o/r", resource: "issues", number: 7 });
    expect(parseGithubRef("github_api", "repos/vercel/next.js/releases")).toEqual({ repo: "vercel/next.js", resource: "releases" });
    expect(parseGithubRef("github_api", "repos/acme/widget/releases/tags/v2.0.0-rc.1+build")).toEqual({ repo: "acme/widget", resource: "release_tag", tag: "v2.0.0-rc.1+build" });
    expect(parseGithubRef("github_api", "repos/acme/widget")).toEqual({ repo: "acme/widget", resource: "repo" });
    expect(parseGithubRef("github_events", "repos/acme/widget/events")).toEqual({ repo: "acme/widget", resource: "events" });
  });

  it("refuses any other GitHub path, a query, percent-encoding, dot segments and out-of-range numbers", () => {
    for (const ref of ["user", "user/repos", "search/issues?q=repo:o/r", "repos/o/r/pulls", "repos/o/r/pulls/0", "repos/o/r/pulls/12345678901", "repos/o/r/pulls/1?per_page=100",
      "repos/o/r/releases/latest", "repos/o/r/releases/tags/..", "repos/o/r/releases/tags/../../../../user", "repos/o/r/releases/tags/v1%2F2", "repos/o/../../user", "repos/o/./pulls/1",
      "repos/-o/r/pulls/1", "repos/o/r/actions/secrets", "repos/o/r/events", "https://api.github.com/repos/o/r/pulls/1"]) {
      expect(sourceRefProblem({ kind: "github_api", ref }, undefined), ref).not.toBeNull();
    }
    expect(sourceRefProblem({ kind: "github_events", ref: "repos/o/r/pulls/1" }, undefined)).toContain("repos/{owner}/{repo}/events");
  });

  it("allows the repository document only under a numeric_threshold resolver", () => {
    expect(sourceRefProblem({ kind: "github_api", ref: "repos/acme/widget" }, undefined)).toContain("only a numeric_threshold");
    expect(sourceRefProblem({ kind: "github_api", ref: "repos/acme/widget" }, { kind: "numeric_threshold", path: "stargazers_count", op: ">=", value: 10000 })).toBeNull();
  });

  it("checks base_log and solana_log refs, and leaves official_release to its own rail", () => {
    expect(sourceRefProblem({ kind: "base_log", ref: `base:${ADDR}` }, undefined)).toBeNull();
    expect(sourceRefProblem({ kind: "base_log", ref: `base:${ADDR.toUpperCase().replace("0X", "0x")}` }, undefined)).toBeNull();
    for (const ref of [`base:${ADDR}00`, "base:0x1234", ADDR, `ethereum:${ADDR}`, `base:${ADDR} `]) expect(sourceRefProblem({ kind: "base_log", ref }, undefined), ref).not.toBeNull();
    expect(sourceRefProblem({ kind: "solana_log", ref: `solana:${ACCOUNT}` }, undefined)).toBeNull();
    for (const ref of ["solana:short", `solana:${ACCOUNT}0OIl`, `solana:${"1".repeat(45)}`, ACCOUNT]) expect(sourceRefProblem({ kind: "solana_log", ref }, undefined), ref).not.toBeNull();
    expect(sourceRefProblem({ kind: "official_release", ref: "official:us_cpi_u_nsa_yoy:2026-09" }, undefined)).toBeNull();
    expect(sourceRefProblem({ kind: "web_fetch", ref: "http://169.254.169.254/latest" }, undefined)).toContain("is not https");
  });
});

describe("resolverSourceProblems", () => {
  const pr = { kind: "github_pr_merged", repo: "acme/widget", pr: 42 } as const;
  it("accepts the resolver's own subject, repo compared case-insensitively, events on the same repo, web sources beside it", () => {
    expect(resolverSourceProblems(reg([{ kind: "github_api", ref: "repos/Acme/Widget/pulls/42" }, { kind: "github_events", ref: "repos/acme/widget/events" }, { kind: "web_fetch", ref: "https://github.com/acme/widget" }], pr))).toEqual([]);
  });

  it("refuses another repo, another PR, the issues view of a PR, and a PR resolver without a GitHub source", () => {
    expect(resolverSourceProblems(reg([{ kind: "github_api", ref: "repos/acme/other/pulls/42" }], pr))).toEqual([expect.stringContaining("is on acme/other")]);
    expect(resolverSourceProblems(reg([{ kind: "github_api", ref: "repos/acme/widget/pulls/43" }], pr))).toEqual([expect.stringContaining("another resource")]);
    expect(resolverSourceProblems(reg([{ kind: "github_api", ref: "repos/acme/widget/issues/42" }], pr))).toEqual([expect.stringContaining("reads merged_at")]);
    expect(resolverSourceProblems(reg([{ kind: "github_events", ref: "repos/acme/other/events" }, { kind: "github_api", ref: "repos/acme/widget/pulls/42" }], pr))).toEqual([expect.stringContaining("is on acme/other")]);
    expect(resolverSourceProblems(reg([{ kind: "web_fetch", ref: "https://github.com/acme/widget/pull/42" }], pr))).toEqual([expect.stringContaining("needs a github_api source")]);
  });

  it("holds issue_closed to its issue and release_published to the release list or its own tag", () => {
    const issue = { kind: "github_issue_closed", repo: "acme/widget", issue: 7 } as const;
    expect(resolverSourceProblems(reg([{ kind: "github_api", ref: "repos/acme/widget/issues/7" }], issue))).toEqual([]);
    expect(resolverSourceProblems(reg([{ kind: "github_api", ref: "repos/acme/widget/issues/8" }], issue))).toHaveLength(1);
    const rel = { kind: "github_release_published", repo: "acme/widget", tag: "v2.0.0" } as const;
    expect(resolverSourceProblems(reg([{ kind: "github_api", ref: "repos/acme/widget/releases" }], rel))).toEqual([]);
    expect(resolverSourceProblems(reg([{ kind: "github_api", ref: "repos/acme/widget/releases/tags/v2.0.0" }], rel))).toEqual([]);
    expect(resolverSourceProblems(reg([{ kind: "github_api", ref: "repos/acme/widget/releases/tags/v2.0.1" }], rel))).toHaveLength(1);
  });

  it("holds evm_log_present to its address (case-insensitive) and solana_sig_present to its account (exact)", () => {
    const evm = { kind: "evm_log_present", chain: "base", address: ADDR, topic0: TOPIC } as const;
    expect(resolverSourceProblems(reg([{ kind: "base_log", ref: `base:0x000000000000000000000000000000000000BEEF` }], evm))).toEqual([]);
    expect(resolverSourceProblems(reg([{ kind: "base_log", ref: "base:0x000000000000000000000000000000000000cafe" }], evm))).toEqual([expect.stringContaining("the resolver evm_log_present reads")]);
    expect(resolverSourceProblems(reg([{ kind: "web_fetch", ref: "https://basescan.org/" }], evm))).toEqual([expect.stringContaining("needs a base_log source")]);
    const sol = { kind: "solana_sig_present", account: ACCOUNT } as const;
    expect(resolverSourceProblems(reg([{ kind: "solana_log", ref: `solana:${ACCOUNT}` }], sol))).toEqual([]);
    expect(resolverSourceProblems(reg([{ kind: "solana_log", ref: `solana:${ACCOUNT.toLowerCase()}` }], sol))).toHaveLength(1);
    expect(resolverSourceProblems(reg([], sol))).toEqual([expect.stringContaining("needs a solana_log source")]);
  });

  it("has nothing to say about numeric_threshold, official_release or no resolver", () => {
    expect(resolverSourceProblems(reg([{ kind: "web_fetch", ref: "https://api.example.org/stats" }], { kind: "numeric_threshold", path: "tvl", op: ">=", value: 1 }))).toEqual([]);
    expect(resolverSourceProblems(reg([{ kind: "web_fetch", ref: "https://api.example.org/stats" }]))).toEqual([]);
  });
});

describe("registrationPolicyIssues and web_render", () => {
  it("collects every ref and cross-check problem, and none with the rail off", () => {
    const bad = reg([{ kind: "web_fetch", ref: "http://10.0.0.1/" }, { kind: "github_api", ref: "repos/acme/other/pulls/42" }], { kind: "github_pr_merged", repo: "acme/widget", pr: 42 });
    expect(registrationPolicyIssues(bad)).toEqual([expect.stringContaining("is not https"), expect.stringContaining("is on acme/other")]);
    __setRailsForMutationTesting(["registration_policy"]);
    expect(registrationPolicyIssues(bad)).toEqual([]);
  });

  it("refuses web_render whatever the rail says (Browser Rendering ships in P6)", () => {
    expect(webRenderRefusal(reg([{ kind: "web_render", ref: "https://example.org/" }]))).toContain("Browser Rendering");
    __setRailsForMutationTesting(["registration_policy"]);
    expect(webRenderRefusal(reg([{ kind: "web_render", ref: "https://example.org/" }]))).toContain("Browser Rendering");
    expect(webRenderRefusal(reg([{ kind: "web_fetch", ref: "https://example.org/" }]))).toBeNull();
  });
});

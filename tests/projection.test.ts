import { afterEach, describe, expect, it } from "vitest";
import { githubShape, projectForChange, stableStringify, stripVolatile } from "../src/ingest/projection";
import { canonicalize } from "../src/resolve/text";
import type { EvidenceInput } from "../src/resolve/schema";
import { __setRailsForMutationTesting } from "../src/resolve/rails";

afterEach(() => __setRailsForMutationTesting([]));

const repo = (n: number) => ({ id: 1, full_name: "openai/openai-python", stargazers_count: 27_000 + n, watchers_count: 27_000 + n, watchers: 27_000 + n, forks_count: 4_000 + n, forks: 4_000 + n, open_issues_count: 300 + n, open_issues: 300 + n, pushed_at: `2026-09-23T06:0${n}:00Z`, updated_at: `2026-09-23T06:0${n}:30Z`, size: 12_000 + n, html_url: "https://github.com/openai/openai-python" });
const pr = (n: number, over: Record<string, unknown> = {}) => ({
  url: "https://api.github.com/repos/openai/openai-python/pulls/4821", number: 4821, state: "open", title: "retry on 529", merged: false, merged_at: null, closed_at: null, draft: false,
  merge_commit_sha: "9f1c", updated_at: `2026-09-23T06:0${n}:59Z`, comments: n, mergeable_state: "clean",
  head: { ref: "retry-529", sha: `head${n}`, repo: repo(n) }, base: { ref: "main", sha: "base0", repo: repo(n) }, ...over,
});
const gh = (structured: unknown): EvidenceInput => ({ source_kind: "github_api", source_url: "https://api.github.com/repos/o/r/pulls/1", text: JSON.stringify(structured), structured, fetched_at: "2026-09-23T06:00:00Z" });
const p = (structured: unknown, kind = "github_pr_merged") => projectForChange("github_api", kind, gh(structured));

describe("GitHub PR projection", () => {
  it("ignores head/base repo counters, updated_at, head sha and activity counts", () => {
    expect(p(pr(1))).toBe(p(pr(7)));
  });
  it.each([
    ["merged_at", { merged_at: "2026-09-23T06:03:00Z" }],
    ["merged", { merged: true }],
    ["state", { state: "closed" }],
    ["closed_at", { closed_at: "2026-09-23T06:03:00Z" }],
    ["draft", { draft: true }],
    ["title", { title: "retry on 529 and 503" }],
    ["merge_commit_sha", { merge_commit_sha: "aaaa" }],
    ["number", { number: 4822 }],
  ])("changes when %s changes", (_f, over) => {
    expect(p(pr(1, over))).not.toBe(p(pr(1)));
  });
  it("changes when the base branch or the base repo identity changes", () => {
    expect(p(pr(1, { base: { ref: "release", sha: "base0", repo: repo(1) } }))).not.toBe(p(pr(1)));
    expect(p(pr(1, { base: { ref: "main", sha: "base0", repo: { ...repo(1), full_name: "other/repo" } } }))).not.toBe(p(pr(1)));
  });
  it("is the same PR shape without a resolver (a Jev-routed market)", () => {
    expect(githubShape(undefined, pr(1))).toBe("pr");
    expect(projectForChange("github_api", undefined, gh(pr(1)))).toBe(projectForChange("github_api", undefined, gh(pr(5))));
  });
});

describe("GitHub issue and release projections", () => {
  const issue = (labels: string[], comments: number, over: Record<string, unknown> = {}) => ({ number: 7, state: "open", state_reason: null, title: "hang", closed_at: null, comments, updated_at: `2026-09-2${comments}T00:00:00Z`, labels: labels.map((name) => ({ name, color: "fff", url: `u/${name}` })), ...over });
  it("issue: sorted label names; comments and updated_at ignored", () => {
    expect(p(issue(["b", "a"], 1), "github_issue_closed")).toBe(p(issue(["a", "b"], 5), "github_issue_closed"));
  });
  it("issue: closing, state_reason and labels are changes", () => {
    const base = p(issue(["a"], 1), "github_issue_closed");
    expect(p(issue(["a"], 1, { state: "closed", closed_at: "2026-09-23T00:00:00Z", state_reason: "completed" }), "github_issue_closed")).not.toBe(base);
    expect(p(issue(["a", "wontfix"], 1), "github_issue_closed")).not.toBe(base);
  });
  const rel = (id: number, tag: string, over: Record<string, unknown> = {}) => ({ id, tag_name: tag, name: tag, draft: false, prerelease: false, published_at: "2026-09-10T00:00:00Z", assets: [{ download_count: id }], url: `u/${id}`, ...over });
  it("release list: order and asset download counts are ignored", () => {
    expect(p([rel(3, "v3"), rel(1, "v1"), rel(2, "v2")], "github_release_published")).toBe(p([rel(1, "v1", { assets: [{ download_count: 99 }] }), rel(2, "v2"), rel(3, "v3")], "github_release_published"));
  });
  it("release list: a new release, a publish and a prerelease flag are changes", () => {
    const base = p([rel(1, "v1"), rel(2, "v2", { draft: true, published_at: null })], "github_release_published");
    expect(p([rel(1, "v1"), rel(2, "v2")], "github_release_published")).not.toBe(base);
    expect(p([rel(1, "v1"), rel(2, "v2", { draft: true, published_at: null }), rel(3, "v3")], "github_release_published")).not.toBe(base);
    expect(p([rel(1, "v1", { prerelease: true }), rel(2, "v2", { draft: true, published_at: null })], "github_release_published")).not.toBe(base);
  });
  it("single release uses the same fields", () => {
    expect(githubShape("github_release_published", rel(1, "v1"))).toBe("release");
    expect(p(rel(1, "v1", { assets: [{ download_count: 5 }] }))).toBe(p(rel(1, "v1")));
    expect(p(rel(1, "v1", { draft: true }))).not.toBe(p(rel(1, "v1")));
  });
});

describe("other GitHub JSON: volatile keys stripped recursively, keys sorted", () => {
  it("strips counters, urls, activity timestamps and size at any depth", () => {
    expect(stripVolatile({ b: 1, a: { url: "x", html_url: "y", stargazers_count: 3, pushed_at: "t", size: 9, name: "n" }, forks: 2, list: [{ watchers: 1, id: 5 }] }))
      .toEqual({ a: { name: "n" }, b: 1, list: [{ id: 5 }] });
  });
  it("an events list keeps its order and ignores actor urls", () => {
    const ev = (id: string, avatar: string) => ({ id, type: "PushEvent", actor: { login: "x", avatar_url: avatar, url: "u" }, created_at: "2026-09-23T00:00:00Z" });
    expect(projectForChange("github_events", undefined, gh([ev("2", "a1"), ev("1", "a1")]))).toBe(projectForChange("github_events", undefined, gh([ev("2", "a2"), ev("1", "a3")])));
    expect(projectForChange("github_events", undefined, gh([ev("3", "a"), ev("2", "a")]))).not.toBe(projectForChange("github_events", undefined, gh([ev("2", "a"), ev("1", "a")])));
  });
  it("stableStringify sorts object keys and keeps array order", () => {
    expect(stableStringify({ b: [2, 1], a: { d: null, c: true } })).toBe('{"a":{"c":true,"d":null},"b":[2,1]}');
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("web and chain projections", () => {
  const web = (text: string): EvidenceInput => ({ source_kind: "web_fetch", source_url: "https://a.example/", text, fetched_at: "2026-09-23T06:00:00Z" });
  it("web: canonical text (whitespace, CRLF, zero-width insensitive; wording sensitive)", () => {
    expect(projectForChange("web_fetch", undefined, web("Aurora v2\nlive."))).toBe(canonicalize("Aurora v2\nlive.").text);
    expect(projectForChange("web_fetch", undefined, web("Aurora  v2\r\n​live. "))).toBe(projectForChange("web_fetch", undefined, web("Aurora v2\nlive.")));
    expect(projectForChange("web_fetch", undefined, web("Aurora v2 not live."))).not.toBe(projectForChange("web_fetch", undefined, web("Aurora v2 live.")));
  });
  const log = (tx: string) => ({ address: "0x11", topics: ["0xaa"], data: "0x", block_number: 5, tx_hash: tx, log_index: 0, timestamp: "2026-09-20T00:00:00Z" });
  const base = (logs: unknown[], to: number): EvidenceInput => ({ source_kind: "base_log", structured: { chain: "base", from_block: to - 100, to_block: to, safe_block: to + 3, logs, has_code: true }, fetched_at: "2026-09-23T06:00:00Z" });
  it("base_log: only the ordered matching logs count; the window and safe block do not", () => {
    expect(projectForChange("base_log", "evm_log_present", base([], 100))).toBe(projectForChange("base_log", "evm_log_present", base([], 2100)));
    expect(projectForChange("base_log", "evm_log_present", base([log("0x1")], 100))).toBe(projectForChange("base_log", "evm_log_present", base([log("0x1")], 4100)));
    expect(projectForChange("base_log", "evm_log_present", base([log("0x1")], 100))).not.toBe(projectForChange("base_log", "evm_log_present", base([], 100)));
  });
  const sol = (sigs: unknown[], backlog: boolean): EvidenceInput => ({ source_kind: "solana_log", structured: { chain: "solana", account: "acc", account_exists: true, signatures: sigs, backlog }, fetched_at: "2026-09-23T06:00:00Z" });
  it("solana_log: only the ordered signatures count", () => {
    const s = { signature: "5x", slot: 1, blockTime: 1, err: null, discriminator: "settle", instructions: ["settle"], logs: [] };
    expect(projectForChange("solana_log", "solana_sig_present", sol([s], false))).toBe(projectForChange("solana_log", "solana_sig_present", sol([s], true)));
    expect(projectForChange("solana_log", "solana_sig_present", sol([s], false))).not.toBe(projectForChange("solana_log", "solana_sig_present", sol([], false)));
  });
  it("unstructured GitHub text falls back to canonical text", () => {
    const ev: EvidenceInput = { source_kind: "github_api", text: "not json  here", fetched_at: "2026-09-23T06:00:00Z" };
    expect(projectForChange("github_api", undefined, ev)).toBe("not json here");
  });
});

describe("rail stable_projection off (mutation harness only)", () => {
  it("returns the unprojected text, so counter noise is a change again", () => {
    __setRailsForMutationTesting(["stable_projection"]);
    expect(p(pr(1))).not.toBe(p(pr(7)));
    expect(p(pr(1))).toBe(JSON.stringify(pr(1)));
  });
});

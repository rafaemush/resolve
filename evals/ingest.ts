/**
 * Frozen ingestion cases: the github/web adapters and the change projection, run in node against a stubbed
 * global fetch (no network, no credentials, no database). Grader = equality only.
 *   npx tsx evals/ingest.ts            run the frozen cases (exit 1 on any failure)
 *   npx tsx evals/ingest.ts --build    freeze the authored cases to evals/ingest-cases/cases.jsonl + manifest.sha256
 *   npx tsx evals/ingest.ts --check    fail if the frozen files differ from the authored cases (CI guard)
 * Groups: non200 (rail non200_never_evidence), projection (rail stable_projection). evals/mutate.ts switches
 * each rail off and requires its group to go red while a control with every rail on stays green.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Env } from "../src/env";
import { EvidenceInput } from "../src/resolve/schema";
import { fetchGithub } from "../src/ingest/github";
import { fetchWeb } from "../src/ingest/web";
import { projectForChange } from "../src/ingest/projection";
import type { FetchOutcome, WatchRow } from "../src/ingest/types";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const DIR = resolve(process.cwd(), "evals/ingest-cases");
const CASES_FILE = resolve(DIR, "cases.jsonl");
const MANIFEST = resolve(DIR, "manifest.sha256");
const UA = "ResolveBot/1.0 (+eval)";

export type IngestGroup = "non200" | "projection";
interface StubResponse { status: number; headers?: Record<string, string>; body?: string | null; redirected?: boolean; url?: string }
interface AdapterExpect { evidence: boolean; raw_bytes: boolean; error: boolean; window_status: "ok" | "gap" | null; http_status: number | null }
interface AdapterCase { id: string; group: "non200"; title: string; adapter: "github" | "web"; source_ref: Record<string, unknown>; resolver_kind?: string; response: StubResponse; expect: AdapterExpect }
interface ProjectionCase { id: string; group: "projection"; title: string; source_kind: string; resolver_kind?: string; a: EvidenceInput; b: EvidenceInput; expect: "equal" | "different" }
export type IngestCase = AdapterCase | ProjectionCase;

// ---- authored cases ---------------------------------------------------------------------------------------

const RATE_LIMIT_403 = '{"message":"API rate limit exceeded for 162.158.0.1. (But here\'s the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)","documentation_url":"https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting"}';
const PR_REF = { ref: "repos/openai/openai-python/pulls/4821" };
const NO_EVIDENCE_GAP = (http_status: number): AdapterExpect => ({ evidence: false, raw_bytes: false, error: true, window_status: "gap", http_status });

function repo(counters: { stars: number; forks: number; issues: number; pushed: string; updated: string }) {
  return {
    id: 188613327, name: "openai-python", full_name: "openai/openai-python", private: false,
    html_url: "https://github.com/openai/openai-python", url: "https://api.github.com/repos/openai/openai-python",
    size: 12040, stargazers_count: counters.stars, watchers_count: counters.stars, watchers: counters.stars,
    forks_count: counters.forks, forks: counters.forks, open_issues_count: counters.issues, open_issues: counters.issues,
    pushed_at: counters.pushed, updated_at: counters.updated, default_branch: "main", visibility: "public",
  };
}
function pr(over: { counters: Parameters<typeof repo>[0]; updated_at: string; merged_at?: string | null }) {
  const r = repo(over.counters);
  return {
    url: "https://api.github.com/repos/openai/openai-python/pulls/4821", id: 2890112233, number: 4821, state: "open", locked: false,
    title: "feat(client): retry on 529", user: { login: "octo-dev", id: 5501, avatar_url: "https://avatars.githubusercontent.com/u/5501?v=4" },
    body: "Adds a bounded retry for HTTP 529.", created_at: "2026-09-02T10:00:00Z", updated_at: over.updated_at, closed_at: null,
    merged_at: over.merged_at ?? null, merge_commit_sha: "9f1c0de5a2b3c4d5e6f708192a3b4c5d6e7f8091", draft: false,
    head: { label: "octo-dev:retry-529", ref: "retry-529", sha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", repo: r },
    base: { label: "openai:main", ref: "main", sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", repo: r },
    merged: false, mergeable: true, mergeable_state: "clean", comments: 3, review_comments: 5, commits: 4, additions: 120, deletions: 8, changed_files: 3,
  };
}
const C1 = { stars: 27411, forks: 4102, issues: 318, pushed: "2026-09-23T06:01:12Z", updated: "2026-09-23T06:01:40Z" };
const C2 = { stars: 27414, forks: 4103, issues: 321, pushed: "2026-09-23T06:04:55Z", updated: "2026-09-23T06:05:02Z" };

function release(id: number, tag: string, draft = false) {
  return { url: `https://api.github.com/repos/vercel/next.js/releases/${id}`, html_url: `https://github.com/vercel/next.js/releases/tag/${tag}`, id, tag_name: tag, name: tag, draft, prerelease: false, created_at: "2026-09-10T00:00:00Z", published_at: draft ? null : "2026-09-10T01:00:00Z", assets: [{ id: id * 10, name: "notes.txt", download_count: id % 97, size: 2048 }] };
}
function issue(labels: string[], comments: number) {
  return { url: "https://api.github.com/repos/openai/openai-python/issues/1200", number: 1200, state: "open", state_reason: null, title: "Client hangs on 529", closed_at: null, comments, updated_at: `2026-09-23T06:0${comments % 10}:00Z`, labels: labels.map((name, i) => ({ id: 900 + i, name, color: "ededed", url: `https://api.github.com/repos/openai/openai-python/labels/${name}` })) };
}
const ghEv = (structured: unknown): EvidenceInput => ({ source_kind: "github_api", source_url: "https://api.github.com/repos/x/y", text: JSON.stringify(structured), structured, observed_at: "2026-09-23T06:05:00Z", fetched_at: "2026-09-23T06:05:00Z", http_status: 200, coverage: { snapshot_status: 200, deciding_field_present: true } });
const webEv = (text: string): EvidenceInput => ({ source_kind: "web_fetch", source_url: "https://blog.aurora-protocol.example/", text, fetched_at: "2026-09-23T06:05:00Z", http_status: 200 });
const LOG = { address: "0x1111111111111111111111111111111111111111", topics: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], data: "0x", block_number: 22_000_100, tx_hash: "0xbeef", log_index: 3, timestamp: "2026-09-20T10:00:00.000Z" };
const baseEv = (to: number, safe: number): EvidenceInput => {
  const structured = { chain: "base", address: LOG.address, topic0: LOG.topics[0], from_block: to - 1999, to_block: to, safe_block: safe, logs: [LOG], has_code: true };
  return { source_kind: "base_log", text: JSON.stringify(structured), structured, observed_at: "2026-09-23T06:05:00Z", fetched_at: "2026-09-23T06:05:00Z", provenance: { chain: "base", address: LOG.address, from_block: to - 1999, to_block: to, safe_block: safe } };
};

export function authorCases(): IngestCase[] {
  return [
    { id: "ING-001", group: "non200", title: "GitHub 403 rate-limit body (the §16.2 production body) is a gap, never evidence", adapter: "github", source_ref: PR_REF, resolver_kind: "github_pr_merged",
      response: { status: 403, headers: { "content-type": "application/json; charset=utf-8", "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" }, body: RATE_LIMIT_403 }, expect: NO_EVIDENCE_GAP(403) },
    { id: "ING-002", group: "non200", title: "GitHub 404 on the post-deadline snapshot (repo went private) is a gap, never evidence", adapter: "github", source_ref: PR_REF, resolver_kind: "github_pr_merged",
      response: { status: 404, headers: { "content-type": "application/json; charset=utf-8" }, body: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/pulls/pulls#get-a-pull-request","status":"404"}' }, expect: NO_EVIDENCE_GAP(404) },
    { id: "ING-003", group: "non200", title: "GitHub 502 HTML error page is a gap, never evidence", adapter: "github", source_ref: PR_REF, resolver_kind: "github_pr_merged",
      response: { status: 502, headers: { "content-type": "text/html" }, body: "<html><body><h1>502 Bad Gateway</h1><p>openai/openai-python #4821 merged</p></body></html>" }, expect: NO_EVIDENCE_GAP(502) },
    { id: "ING-004", group: "non200", title: "GitHub 200 reached through a redirect (repo renamed or transferred) is a gap", adapter: "github", source_ref: PR_REF, resolver_kind: "github_pr_merged",
      response: { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(pr({ counters: C1, updated_at: "2026-09-23T06:01:40Z" })), redirected: true, url: "https://api.github.com/repositories/188613327/pulls/4821" }, expect: NO_EVIDENCE_GAP(200) },
    { id: "ING-005", group: "non200", title: "Web redirect to a different site is a gap, never evidence", adapter: "web", source_ref: { url: "https://blog.aurora-protocol.example/" },
      response: { status: 200, headers: { "content-type": "text/plain" }, body: "Aurora v2 upgrade is live on mainnet. Buy this domain today.", redirected: true, url: "https://parked-domains.example/aurora" }, expect: NO_EVIDENCE_GAP(200) },
    { id: "ING-006", group: "non200", title: "Web 429 with Retry-After is a gap, never evidence", adapter: "web", source_ref: { url: "https://blog.aurora-protocol.example/" },
      response: { status: 429, headers: { "content-type": "text/plain", "retry-after": "120" }, body: "Too Many Requests" }, expect: NO_EVIDENCE_GAP(429) },
    { id: "ING-007", group: "non200", title: "control: GitHub 200 from the registered URL is evidence", adapter: "github", source_ref: PR_REF, resolver_kind: "github_pr_merged",
      response: { status: 200, headers: { "content-type": "application/json; charset=utf-8", etag: 'W/"abc"' }, body: JSON.stringify(pr({ counters: C1, updated_at: "2026-09-23T06:01:40Z" })) }, expect: { evidence: true, raw_bytes: true, error: false, window_status: "ok", http_status: 200 } },
    { id: "ING-008", group: "non200", title: "control: same-site web redirect (http -> https, www.) is evidence", adapter: "web", source_ref: { url: "http://aurora-protocol.example/status" },
      response: { status: 200, headers: { "content-type": "text/plain" }, body: "Aurora status: v2 upgrade activated on mainnet at block 1,200,000.", redirected: true, url: "https://www.aurora-protocol.example/status/" }, expect: { evidence: true, raw_bytes: true, error: false, window_status: "ok", http_status: 200 } },

    { id: "ING-101", group: "projection", title: "PR payloads differing only in head/base repo counters and updated_at project equal", source_kind: "github_api", resolver_kind: "github_pr_merged",
      a: ghEv(pr({ counters: C1, updated_at: "2026-09-23T06:01:40Z" })), b: ghEv(pr({ counters: C2, updated_at: "2026-09-23T06:05:02Z" })), expect: "equal" },
    { id: "ING-102", group: "projection", title: "the same PR with merged_at set projects different", source_kind: "github_api", resolver_kind: "github_pr_merged",
      a: ghEv(pr({ counters: C1, updated_at: "2026-09-23T06:01:40Z" })), b: ghEv(pr({ counters: C1, updated_at: "2026-09-23T06:01:40Z", merged_at: "2026-09-23T06:03:00Z" })), expect: "different" },
    { id: "ING-103", group: "projection", title: "a reordered release list projects equal", source_kind: "github_api", resolver_kind: "github_release_published",
      a: ghEv([release(301, "v15.5.0"), release(299, "v15.4.9"), release(305, "v16.0.0-canary.1")]), b: ghEv([release(305, "v16.0.0-canary.1"), release(301, "v15.5.0"), release(299, "v15.4.9")]), expect: "equal" },
    { id: "ING-104", group: "projection", title: "a draft release that gets published projects different", source_kind: "github_api", resolver_kind: "github_release_published",
      a: ghEv([release(310, "v16.0.0", true), release(301, "v15.5.0")]), b: ghEv([release(310, "v16.0.0", false), release(301, "v15.5.0")]), expect: "different" },
    { id: "ING-105", group: "projection", title: "an issue with labels reordered and a new comment count projects equal", source_kind: "github_api", resolver_kind: "github_issue_closed",
      a: ghEv(issue(["bug", "sdk"], 4)), b: ghEv(issue(["sdk", "bug"], 7)), expect: "equal" },
    { id: "ING-106", group: "projection", title: "web text differing only in whitespace and zero-width characters projects equal", source_kind: "web_fetch",
      a: webEv("Aurora v2 upgrade\nactivated on mainnet."), b: webEv("Aurora  v2 upgrade\r\n​activated on   mainnet. "), expect: "equal" },
    { id: "ING-107", group: "projection", title: "base logs with the same matching logs but a moved window/safe block project equal", source_kind: "base_log", resolver_kind: "evm_log_present",
      a: baseEv(22_001_000, 22_001_000), b: baseEv(22_003_000, 22_003_010), expect: "equal" },
  ];
}

// ---- frozen file + manifest --------------------------------------------------------------------------------

export function renderCases(): { body: string; manifest: string } {
  const authored = authorCases();
  const ids = new Set<string>();
  const lines = authored.map((k) => {
    if (ids.has(k.id)) throw new Error(`duplicate case id ${k.id}`);
    ids.add(k.id);
    if (k.group === "projection") {
      for (const [side, ev] of [["a", k.a], ["b", k.b]] as const) {
        const r = EvidenceInput.safeParse(ev);
        if (!r.success) throw new Error(`${k.id}.${side}: evidence invalid: ${r.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
      }
    }
    return JSON.stringify(k);
  });
  const body = lines.join("\n") + "\n";
  return { body, manifest: `${sha(body)}  cases.jsonl\n` };
}

export function loadIngestCases(): { cases: IngestCase[]; suite: string } {
  const manifest = readFileSync(MANIFEST, "utf8").trim();
  const [h] = manifest.split("  ");
  const body = readFileSync(CASES_FILE, "utf8");
  if (sha(body) !== h) throw new Error("evals/ingest-cases/cases.jsonl does not match its manifest — run npx tsx evals/ingest.ts --build and commit");
  return { cases: body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as IngestCase), suite: h! };
}

// ---- runner --------------------------------------------------------------------------------------------------

export interface IngestOutcome { id: string; group: string; result: "pass" | "grader_fail" | "harness_error"; failures: string[] }
export interface IngestSummary { suite_sha256: string; cases: number; passed: number; grader_fail: number; harness_error: number; skipped: number; outcomes: IngestOutcome[]; label?: string }

function stubResponse(s: StubResponse): Response {
  const res = new Response(s.body ?? null, { status: s.status, headers: s.headers ?? {} });
  // Response.redirected/url are read-only getters; an own property shadows them for this instance only.
  if (s.redirected) Object.defineProperty(res, "redirected", { value: true });
  if (s.url) Object.defineProperty(res, "url", { value: s.url });
  return res;
}

async function runAdapterCase(k: AdapterCase): Promise<string[]> {
  const watch = { id: `eval-${k.id}`, market_id: "eval", source_kind: k.adapter === "github" ? "github_api" : "web_fetch", source_ref: k.source_ref, poll_interval_s: 300, etag: null, cursor: {}, coverage: [], last_evidence_hash: null, consecutive_errors: 0, backlog: false, active: true } as WatchRow;
  const expectedHost = k.adapter === "github" ? "api.github.com" : new URL(String(k.source_ref.url)).host;
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).host !== expectedHost) throw new Error(`ingest eval: unexpected fetch to ${url}`);
    return stubResponse(k.response);
  }) as typeof fetch;
  let out: FetchOutcome;
  try {
    out = k.adapter === "github" ? await fetchGithub({} as Env, watch, k.resolver_kind, UA) : await fetchWeb({} as Env, watch, UA);
  } finally { globalThis.fetch = saved; }
  if (calls !== 1) throw new Error(`expected exactly one fetch, saw ${calls}`);
  const got: AdapterExpect = { evidence: out.evidence !== undefined, raw_bytes: out.rawBytes !== undefined, error: out.error !== undefined, window_status: out.window?.status ?? null, http_status: out.httpStatus ?? null };
  return (Object.keys(k.expect) as Array<keyof AdapterExpect>).filter((f) => got[f] !== k.expect[f]).map((f) => `${f} ${String(got[f])} != ${String(k.expect[f])}`);
}

function runProjectionCase(k: ProjectionCase): string[] {
  const equal = projectForChange(k.source_kind, k.resolver_kind, k.a) === projectForChange(k.source_kind, k.resolver_kind, k.b);
  const got = equal ? "equal" : "different";
  return got === k.expect ? [] : [`projection ${got} != ${k.expect}`];
}

export async function runIngestSuite(opts: { groups?: string[] | null; quiet?: boolean; label?: string } = {}): Promise<IngestSummary> {
  const { cases: all, suite } = loadIngestCases();
  const cases = opts.groups ? all.filter((k) => opts.groups!.includes(k.group)) : all;
  const outcomes: IngestOutcome[] = [];
  for (const k of cases) {
    try {
      const failures = k.group === "non200" ? await runAdapterCase(k) : runProjectionCase(k);
      outcomes.push({ id: k.id, group: k.group, result: failures.length ? "grader_fail" : "pass", failures });
    } catch (e) {
      outcomes.push({ id: k.id, group: k.group, result: "harness_error", failures: [`exception: ${String(e).slice(0, 160)}`] });
    }
  }
  const s: IngestSummary = {
    suite_sha256: suite, cases: outcomes.length, passed: outcomes.filter((o) => o.result === "pass").length,
    grader_fail: outcomes.filter((o) => o.result === "grader_fail").length, harness_error: outcomes.filter((o) => o.result === "harness_error").length,
    skipped: 0, outcomes, label: opts.label,
  };
  if (!opts.quiet) {
    for (const o of outcomes) if (o.result !== "pass") console.log(`${o.result.toUpperCase().padEnd(13)} ${o.id.padEnd(8)} ${o.failures.join("; ")}`);
    console.log(`${opts.label ? `[${opts.label}] ` : ""}ingest: cases=${s.cases} passed=${s.passed} grader_fail=${s.grader_fail} harness_error=${s.harness_error} suite ${suite.slice(0, 16)}`);
  }
  return s;
}

async function main() {
  const a = process.argv.slice(2);
  if (a.includes("--build") || a.includes("--check")) {
    const { body, manifest } = renderCases();
    if (a.includes("--check")) {
      const drift = [[CASES_FILE, body], [MANIFEST, manifest]].filter(([p, want]) => !existsSync(p!) || readFileSync(p!, "utf8") !== want).map(([p]) => p);
      for (const p of drift) console.log(`DRIFT ${p}`);
      if (drift.length) { console.log("frozen ingestion cases differ from the authored cases — run npx tsx evals/ingest.ts --build and commit"); process.exit(1); }
      console.log(`checked ${body.trim().split("\n").length} ingestion cases`);
      return;
    }
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CASES_FILE, body);
    writeFileSync(MANIFEST, manifest);
    console.log(`froze ${body.trim().split("\n").length} ingestion cases; suite ${manifest.slice(0, 16)}`);
    return;
  }
  const s = await runIngestSuite();
  process.exit(s.grader_fail || s.harness_error ? 1 : 0);
}
if (process.argv[1] && process.argv[1].endsWith("ingest.ts")) main().catch((e) => { console.error(String(e)); process.exit(1); });

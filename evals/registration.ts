/**
 * Frozen registration cases: validateRegistration + planRegistration (src/markets/register.ts: the policy of
 * src/markets/policy.ts, web_render, and the source checks of src/markets/source-checks.ts) against a stubbed global
 * fetch that plays robots.txt and the Base and Solana JSON-RPC endpoints. No network, no credentials, no database.
 * Grader = equality only: the outcome, a substring of the reason, the watch count and how many upstream requests were
 * made (a source the policy refuses must never be requested, not even its robots.txt).
 *   npx tsx evals/registration.ts            run the frozen cases (exit 1 on any failure)
 *   npx tsx evals/registration.ts --build    freeze the authored cases to evals/registration-cases/cases.jsonl + manifest.sha256
 *   npx tsx evals/registration.ts --check    fail if the frozen files differ from the authored cases (CI guard)
 * Group: policy (rail registration_policy). evals/mutate.ts switches the rail off and requires the group to go red while
 * the same group with every rail on stays green; the control cases decide the same way with the rail on or off.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Env } from "../src/env";
import { planRegistration, validateRegistration } from "../src/markets/register";
import { RegistrationError } from "../src/markets/policy";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const DIR = resolve(process.cwd(), "evals/registration-cases");
const CASES_FILE = resolve(DIR, "cases.jsonl");
const MANIFEST = resolve(DIR, "manifest.sha256");
const UA = "ResolveBot/1.0 (+eval)";
const SOLANA_RPC = "https://solana-rpc.eval.invalid/";
const BASE_RPC = "https://base-rpc.eval.invalid/";
const ENV = { SOLANA_FALLBACK_HTTP_URL: SOLANA_RPC, BASE_FALLBACK_HTTP_URL: BASE_RPC } as unknown as Env;
/** Registration runs "now" = the time the cases were written, so the near-deadline cadence never depends on the day. */
const NOW = Date.parse("2026-09-24T12:00:00Z");

export type RegistrationGroup = "policy";
/** One stubbed upstream answer: matched on the URL's host (and path), and on the JSON-RPC method for POSTs. */
interface Upstream { host: string; path?: string; rpc?: string; status?: number; headers?: Record<string, string>; body?: string; json?: unknown; timeout?: boolean }
type Outcome = "open" | "unsupported_source" | "refused" | "unverified";
interface Expect { outcome: Outcome; reason_includes?: string; watches?: number; fetches?: number }
export interface RegistrationCase { id: string; group: RegistrationGroup; control: boolean; title: string; market: Record<string, unknown>; upstream: Upstream[]; expect: Expect }

// ---- authored cases (structure only: no platform market text) ------------------------------------------------------------

const PR_REPO = "acme/widget";
const ADDR = "0x000000000000000000000000000000000000beef";
const OTHER_ADDR = "0x000000000000000000000000000000000000cafe";
const TOPIC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/** A well-known program id (SPL Token), the kind of account plan §8 forbids watching. */
const PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function market(id: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    platform: "custom", external_id: `eval-reg-${id}`, condition: "Resolves Yes if the watched source shows the event before the deadline.",
    event_statement: "The watched event happened", option_a: "Yes", option_b: "No", positive_option: "OPTION_A", anchors: ["event"],
    open_at: "2026-09-01T00:00:00Z", deadline_utc: "2026-12-31T00:00:00Z", ...over,
  };
}
const web = (url: string) => ({ sources: [{ kind: "web_fetch", ref: url }] });
const robots = (host: string, status: number, extra: Partial<Upstream> = {}): Upstream => ({ host, path: "/robots.txt", status, ...extra });
const rpcOk = (host: string, rpc: string, result: unknown): Upstream => ({ host, rpc, json: { jsonrpc: "2.0", id: 1, result } });
/** The safe block predates open_at, so blockAtOrAfter() answers safe + 1 without bisecting: two requests per base_log. */
const BASE_OK = [rpcOk("base-rpc.eval.invalid", "eth_getBlockByNumber", { number: "0x1000", timestamp: "0x68000000" }), rpcOk("base-rpc.eval.invalid", "eth_getCode", "0x6080604052")];
const solanaAccount = (value: unknown): Upstream => rpcOk("solana-rpc.eval.invalid", "getAccountInfo", { context: { slot: 1 }, value });
const prResolver = (repo: string, pr: number) => ({ kind: "github_pr_merged", repo, pr });
const OPEN1 = (fetches?: number): Expect => ({ outcome: "open", watches: 1, ...(fetches !== undefined ? { fetches } : {}) });

export function authorCases(): RegistrationCase[] {
  return [
    // --- refused or unsupported only with the rail on (red when it is off) -------------------------------------------------
    { id: "REG-001", group: "policy", control: false, title: "web source on the cloud metadata address (http, 169.254/16) is refused before any request",
      market: market("001", web("http://169.254.169.254/latest/meta-data/")), upstream: [robots("169.254.169.254", 404)], expect: { outcome: "refused", reason_includes: "is not https", fetches: 0 } },
    { id: "REG-002", group: "policy", control: false, title: "https web source on a link-local literal is refused before any request",
      market: market("002", web("https://169.254.169.254/latest/meta-data/")), upstream: [robots("169.254.169.254", 404)], expect: { outcome: "refused", reason_includes: "link-local", fetches: 0 } },
    { id: "REG-003", group: "policy", control: false, title: "a *.internal host is refused",
      market: market("003", web("https://metadata.google.internal/computeMetadata/v1/")), upstream: [robots("metadata.google.internal", 404)], expect: { outcome: "refused", reason_includes: "not a public host", fetches: 0 } },
    { id: "REG-004", group: "policy", control: false, title: "an IPv4-mapped IPv6 literal of a private address is refused",
      market: market("004", web("https://[::ffff:10.0.0.7]/admin")), upstream: [robots("[::ffff:a00:7]", 404)], expect: { outcome: "refused", reason_includes: "private", fetches: 0 } },
    { id: "REG-005", group: "policy", control: false, title: "credentials in a web source URL are refused",
      market: market("005", web("https://user:secret@status.acme-widget.example/")), upstream: [robots("status.acme-widget.example", 404)], expect: { outcome: "refused", reason_includes: "credentials", fetches: 0 } },
    { id: "REG-006", group: "policy", control: false, title: "a github_pr_merged resolver on repo A with its source on repo B is refused",
      market: market("006", { sources: [{ kind: "github_api", ref: "repos/acme/other-widget/pulls/42" }], resolver: prResolver(PR_REPO, 42) }), upstream: [], expect: { outcome: "refused", reason_includes: "is on acme/other-widget", fetches: 0 } },
    { id: "REG-007", group: "policy", control: false, title: "a github_pr_merged resolver on PR 42 with its source on PR 43 of the same repo is refused",
      market: market("007", { sources: [{ kind: "github_api", ref: "repos/acme/widget/pulls/43" }], resolver: prResolver(PR_REPO, 42) }), upstream: [], expect: { outcome: "refused", reason_includes: "another resource", fetches: 0 } },
    { id: "REG-008", group: "policy", control: false, title: "a github_api ref outside the whitelisted resources (the token's own user) is refused",
      market: market("008", { sources: [{ kind: "github_api", ref: "user/repos" }] }), upstream: [], expect: { outcome: "refused", reason_includes: "is not one of", fetches: 0 } },
    { id: "REG-009", group: "policy", control: false, title: "a release tag that walks up the API path (..) is refused",
      market: market("009", { sources: [{ kind: "github_api", ref: "repos/acme/widget/releases/tags/../../../../user" }] }), upstream: [], expect: { outcome: "refused", reason_includes: "is not one of", fetches: 0 } },
    { id: "REG-010", group: "policy", control: false, title: "an evm_log_present resolver on another address than its base_log source is refused before any RPC",
      market: market("010", { sources: [{ kind: "base_log", ref: `base:${OTHER_ADDR}` }], resolver: { kind: "evm_log_present", chain: "base", address: ADDR, topic0: TOPIC } }), upstream: BASE_OK, expect: { outcome: "refused", reason_includes: "the resolver evm_log_present reads", fetches: 0 } },
    { id: "REG-011", group: "policy", control: false, title: "a Solana program id (executable) as the watched account is refused (plan §8)",
      market: market("011", { sources: [{ kind: "solana_log", ref: `solana:${PROGRAM_ID}` }], resolver: { kind: "solana_sig_present", account: PROGRAM_ID } }),
      upstream: [solanaAccount({ executable: true, owner: "BPFLoader2111111111111111111111111111111111", lamports: 1, data: ["", "base64"] })], expect: { outcome: "refused", reason_includes: "executable program id" } },
    { id: "REG-012", group: "policy", control: false, title: "a Solana account that does not exist is refused",
      market: market("012", { sources: [{ kind: "solana_log", ref: `solana:${ACCOUNT}` }], resolver: { kind: "solana_sig_present", account: ACCOUNT } }), upstream: [solanaAccount(null)], expect: { outcome: "refused", reason_includes: "does not exist" } },
    { id: "REG-013", group: "policy", control: false, title: "a Solana RPC answering 503 is 'could not verify', never accepted unverified",
      market: market("013", { sources: [{ kind: "solana_log", ref: `solana:${ACCOUNT}` }], resolver: { kind: "solana_sig_present", account: ACCOUNT } }), upstream: [{ host: "solana-rpc.eval.invalid", rpc: "getAccountInfo", status: 503, body: "upstream unavailable" }], expect: { outcome: "unverified", reason_includes: "could not verify" } },
    { id: "REG-014", group: "policy", control: false, title: "a Solana RPC timeout is 'could not verify'",
      market: market("014", { sources: [{ kind: "solana_log", ref: `solana:${ACCOUNT}` }] }), upstream: [{ host: "solana-rpc.eval.invalid", rpc: "getAccountInfo", timeout: true }], expect: { outcome: "unverified", reason_includes: "timed out" } },
    { id: "REG-015", group: "policy", control: false, title: "robots.txt answering 503 is unreachable: complete disallow (RFC 9309 2.3.1.4)",
      market: market("015", web("https://status.acme-widget.example/v2")), upstream: [robots("status.acme-widget.example", 503)], expect: { outcome: "unsupported_source", reason_includes: "complete disallow", fetches: 1 } },
    { id: "REG-016", group: "policy", control: false, title: "robots.txt timing out is unreachable: complete disallow",
      market: market("016", web("https://status.acme-widget.example/v2")), upstream: [robots("status.acme-widget.example", 0, { timeout: true })], expect: { outcome: "unsupported_source", reason_includes: "timed out", fetches: 1 } },
    { id: "REG-017", group: "policy", control: false, title: "robots.txt redirecting to a loopback address is not followed: complete disallow",
      market: market("017", web("https://status.acme-widget.example/v2")), upstream: [robots("status.acme-widget.example", 301, { headers: { location: "http://127.0.0.1/robots.txt" } }), robots("127.0.0.1", 404)], expect: { outcome: "unsupported_source", reason_includes: "is not fetched", fetches: 1 } },

    // --- controls: the same verdict with the rail on or off ----------------------------------------------------------------
    { id: "REG-C01", group: "policy", control: true, title: "control: a github_pr_merged resolver and its pulls source on the same repo (case-insensitive) register, nothing probed",
      market: market("c01", { sources: [{ kind: "github_api", ref: "repos/Acme/Widget/pulls/42" }], resolver: prResolver(PR_REPO, 42) }), upstream: [], expect: OPEN1(0) },
    { id: "REG-C02", group: "policy", control: true, title: "control: a public https page whose robots.txt is 404 registers",
      market: market("c02", web("https://status.acme-widget.example/v2")), upstream: [robots("status.acme-widget.example", 404)], expect: OPEN1(1) },
    { id: "REG-C03", group: "policy", control: true, title: "control: a robots.txt that disallows the page makes the market unsupported_source",
      market: market("c03", web("https://status.acme-widget.example/private/v2")), upstream: [robots("status.acme-widget.example", 200, { body: "User-agent: *\nDisallow: /private/\n" })], expect: { outcome: "unsupported_source", reason_includes: "disallows /private/", watches: 0, fetches: 1 } },
    { id: "REG-C04", group: "policy", control: true, title: "control: robots.txt 403 is unavailable: allowed (RFC 9309 2.3.1.3)",
      market: market("c04", web("https://status.acme-widget.example/v2")), upstream: [robots("status.acme-widget.example", 403)], expect: OPEN1(1) },
    { id: "REG-C05", group: "policy", control: true, title: "control: an existing, non-executable Solana account registers",
      market: market("c05", { sources: [{ kind: "solana_log", ref: `solana:${ACCOUNT}` }], resolver: { kind: "solana_sig_present", account: ACCOUNT } }),
      upstream: [solanaAccount({ executable: false, owner: "11111111111111111111111111111111", lamports: 5000, data: ["", "base64"] })], expect: OPEN1() },
    { id: "REG-C06", group: "policy", control: true, title: "control: an evm_log_present resolver on its base_log address (case-insensitive) registers after the code check",
      market: market("c06", { sources: [{ kind: "base_log", ref: `base:${ADDR.toUpperCase().replace("0X", "0x")}` }], resolver: { kind: "evm_log_present", chain: "base", address: ADDR, topic0: TOPIC } }), upstream: BASE_OK, expect: OPEN1(2) },
    { id: "REG-C07", group: "policy", control: true, title: "control: a base_log address without contract code is unsupported_source",
      market: market("c07", { sources: [{ kind: "base_log", ref: `base:${ADDR}` }] }), upstream: [BASE_OK[0]!, rpcOk("base-rpc.eval.invalid", "eth_getCode", "0x")], expect: { outcome: "unsupported_source", reason_includes: "no contract code", watches: 0, fetches: 2 } },
    { id: "REG-C08", group: "policy", control: true, title: "control: web_render is refused until Browser Rendering ships",
      market: market("c08", { sources: [{ kind: "web_render", ref: "https://status.acme-widget.example/v2" }] }), upstream: [], expect: { outcome: "refused", reason_includes: "Browser Rendering", fetches: 0 } },
    { id: "REG-C09", group: "policy", control: true, title: "control: a github_release_published resolver with the repo's release list registers",
      market: market("c09", { sources: [{ kind: "github_api", ref: "repos/acme/widget/releases" }], resolver: { kind: "github_release_published", repo: PR_REPO, tag: "v2.0.0" } }), upstream: [], expect: OPEN1(0) },
  ];
}

// ---- frozen file + manifest ------------------------------------------------------------------------------------------------

export function renderCases(): { body: string; manifest: string } {
  const ids = new Set<string>();
  const lines = authorCases().map((k) => {
    if (ids.has(k.id)) throw new Error(`duplicate case id ${k.id}`);
    ids.add(k.id);
    // every case must pass the schema, so a red can only come from the policy or the checks
    validateRegistration(k.market);
    return JSON.stringify(k);
  });
  const body = lines.join("\n") + "\n";
  return { body, manifest: `${sha(body)}  cases.jsonl\n` };
}

export function loadRegistrationCases(): { cases: RegistrationCase[]; suite: string } {
  const [h] = readFileSync(MANIFEST, "utf8").trim().split("  ");
  const body = readFileSync(CASES_FILE, "utf8");
  if (sha(body) !== h) throw new Error("evals/registration-cases/cases.jsonl does not match its manifest — run npx tsx evals/registration.ts --build and commit");
  return { cases: body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RegistrationCase), suite: h! };
}

// ---- runner ------------------------------------------------------------------------------------------------------------

export interface RegistrationOutcome { id: string; group: string; control: boolean; result: "pass" | "grader_fail" | "harness_error"; failures: string[] }
export interface RegistrationSummary { suite_sha256: string; cases: number; passed: number; grader_fail: number; harness_error: number; skipped: number; outcomes: RegistrationOutcome[]; label?: string }

function answer(u: Upstream, url: string): Response {
  const res = new Response(u.json !== undefined ? JSON.stringify(u.json) : (u.body ?? null), { status: u.status ?? 200, headers: { "content-type": u.json !== undefined ? "application/json" : "text/plain", ...(u.headers ?? {}) } });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

async function runCase(k: RegistrationCase): Promise<string[]> {
  const unexpected: string[] = [];
  let fetches = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetches++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    let method: string | undefined;
    if (typeof init?.body === "string") { try { method = (JSON.parse(init.body) as { method?: string }).method; } catch { /* not JSON-RPC */ } }
    const hit = k.upstream.find((x) => x.host === u.hostname && (x.path === undefined || x.path === u.pathname) && (x.rpc === undefined || x.rpc === method));
    if (!hit) { unexpected.push(`${url}${method ? ` ${method}` : ""}`); throw new Error(`registration eval: no stubbed answer for ${url}`); }
    if (hit.timeout) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return answer(hit, url);
  }) as typeof fetch;
  let outcome: Outcome, reason = "", watches = 0;
  try {
    const reg = validateRegistration(k.market);
    const plan = await planRegistration(ENV, { botUa: UA }, reg, NOW);
    outcome = plan.status; reason = plan.reasons.join(" | "); watches = plan.watches.length;
  } catch (e) {
    // watch_limit and base_watch_cap come from the database, which this suite never reaches
    if (!(e instanceof RegistrationError) || (e.refusal.kind !== "invalid" && e.refusal.kind !== "unverified")) throw e;
    outcome = e.refusal.kind === "invalid" ? "refused" : "unverified";
    reason = e.message;
  } finally { globalThis.fetch = saved; }
  if (unexpected.length) throw new Error(`unexpected upstream request(s): ${unexpected.join(", ")}`);
  const f: string[] = [];
  if (outcome !== k.expect.outcome) f.push(`outcome ${outcome} != ${k.expect.outcome} (${reason.slice(0, 120) || "no reason"})`);
  if (k.expect.reason_includes !== undefined && !reason.includes(k.expect.reason_includes)) f.push(`reason lacks "${k.expect.reason_includes}": ${reason.slice(0, 160) || "(none)"}`);
  if (k.expect.watches !== undefined && watches !== k.expect.watches) f.push(`watches ${watches} != ${k.expect.watches}`);
  if (k.expect.fetches !== undefined && fetches !== k.expect.fetches) f.push(`upstream requests ${fetches} != ${k.expect.fetches}`);
  return f;
}

export async function runRegistrationSuite(opts: { groups?: string[] | null; quiet?: boolean; label?: string } = {}): Promise<RegistrationSummary> {
  const { cases: all, suite } = loadRegistrationCases();
  const cases = opts.groups ? all.filter((k) => opts.groups!.includes(k.group)) : all;
  const outcomes: RegistrationOutcome[] = [];
  for (const k of cases) {
    try {
      const failures = await runCase(k);
      outcomes.push({ id: k.id, group: k.group, control: k.control, result: failures.length ? "grader_fail" : "pass", failures });
    } catch (e) {
      outcomes.push({ id: k.id, group: k.group, control: k.control, result: "harness_error", failures: [`exception: ${String(e).slice(0, 200)}`] });
    }
  }
  const s: RegistrationSummary = {
    suite_sha256: suite, cases: outcomes.length, passed: outcomes.filter((o) => o.result === "pass").length,
    grader_fail: outcomes.filter((o) => o.result === "grader_fail").length, harness_error: outcomes.filter((o) => o.result === "harness_error").length,
    skipped: 0, outcomes, label: opts.label,
  };
  if (!opts.quiet) {
    for (const o of outcomes) if (o.result !== "pass") console.log(`${o.result.toUpperCase().padEnd(13)} ${o.id.padEnd(8)} ${o.failures.join("; ")}`);
    console.log(`${opts.label ? `[${opts.label}] ` : ""}registration: cases=${s.cases} passed=${s.passed} grader_fail=${s.grader_fail} harness_error=${s.harness_error} suite ${suite.slice(0, 16)}`);
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
      if (drift.length) { console.log("frozen registration cases differ from the authored cases — run npx tsx evals/registration.ts --build and commit"); process.exit(1); }
      console.log(`checked ${body.trim().split("\n").length} registration cases`);
      return;
    }
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CASES_FILE, body);
    writeFileSync(MANIFEST, manifest);
    console.log(`froze ${body.trim().split("\n").length} registration cases; suite ${manifest.slice(0, 16)}`);
    return;
  }
  const s = await runRegistrationSuite();
  process.exit(s.grader_fail || s.harness_error ? 1 : 0);
}
if (process.argv[1] && process.argv[1].endsWith("registration.ts")) main().catch((e) => { console.error(String(e)); process.exit(1); });

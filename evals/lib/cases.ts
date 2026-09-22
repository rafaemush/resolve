/** Case authoring helpers. Cases are authored in TypeScript, frozen to JSONL by build.ts, and graded deterministically. */
import type { MarketRegistration, EvidenceInput } from "../../src/resolve/schema";

export type CaseClass = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I";
export type JevMode = "none" | "required" | "simulated";

export interface Expect {
  status: "RESOLVED" | "UNRESOLVED" | "ERROR";
  outcome?: "OPTION_A" | "OPTION_B" | "NONE";
  error_code?: string | null;
  error_reason?: string | null;
  caveats_include?: string[];
  confidence_min?: number;
  basis?: "structured" | "jev" | null;
  jev_calls?: 0 | 1;
  /** Alternative acceptable statuses (e.g. UNRESOLVED or ERROR) for genuinely ambiguous inputs; RESOLVED is never in this list for C-I. */
  status_any?: Array<"RESOLVED" | "UNRESOLVED" | "ERROR">;
}

export interface EvalCase {
  id: string;
  class: CaseClass;
  title: string;
  market: MarketRegistration;
  evidence: EvidenceInput;
  now: string;
  jev: JevMode;
  /** For jev=simulated: the fault the harness injects. */
  fault?: "529" | "401" | "422" | "timeout" | "off_contract" | "PAID_JEV_DISABLED" | "BUDGET_EXCEEDED";
  expect: Expect;
  /** Lead-correct label for calibration (A/B/E): which option is actually true, if known. */
  truth?: "OPTION_A" | "OPTION_B";
}

export const NOW_IN = "2026-09-22T12:00:00Z";
export const NOW_AFTER = "2026-10-02T12:00:00Z";
export const OPEN = "2026-09-01T00:00:00Z";
export const DEADLINE = "2026-10-01T00:00:00Z";

export function prMarket(over: Partial<MarketRegistration> = {}): MarketRegistration {
  return {
    platform: "custom", external_id: "eval-pr-4821",
    condition: "Will PR #4821 in openai/openai-python be merged before 2026-10-01 00:00 UTC?",
    event_statement: "PR #4821 in openai/openai-python is merged",
    option_a: "Yes, merged before the deadline", option_b: "No, not merged before the deadline", positive_option: "OPTION_A",
    anchors: ["openai/openai-python", "#4821"],
    sources: [{ kind: "github_api", ref: "repos/openai/openai-python/pulls/4821" }, { kind: "web_fetch", ref: "https://github.com/openai/openai-python" }],
    open_at: OPEN, deadline_utc: DEADLINE, grace_seconds: 3600,
    resolver: { kind: "github_pr_merged", repo: "openai/openai-python", pr: 4821 },
    negative_rule: "absence_after_deadline", allow_prerelease: false, ...over,
  };
}
export function releaseMarket(over: Partial<MarketRegistration> = {}): MarketRegistration {
  return {
    platform: "custom", external_id: "eval-next-16",
    condition: "Will vercel/next.js publish release v16.0.0 before 2026-10-01 00:00 UTC?",
    event_statement: "vercel/next.js publishes the release tagged v16.0.0",
    option_a: "Yes, v16.0.0 published before the deadline", option_b: "No", positive_option: "OPTION_A",
    anchors: ["vercel/next.js", "v16.0.0"],
    sources: [{ kind: "github_api", ref: "repos/vercel/next.js/releases" }, { kind: "web_fetch", ref: "https://github.com/vercel/next.js" }, { kind: "web_fetch", ref: "https://nextjs.org/blog" }],
    open_at: OPEN, deadline_utc: DEADLINE, grace_seconds: 3600,
    resolver: { kind: "github_release_published", repo: "vercel/next.js", tag: "v16.0.0" },
    negative_rule: "absence_after_deadline", allow_prerelease: false, ...over,
  };
}
export function webMarket(over: Partial<MarketRegistration> = {}): MarketRegistration {
  return {
    platform: "custom", external_id: "eval-web-upgrade",
    condition: "Will the Aurora protocol's v2 upgrade activate on mainnet before 2026-10-01 00:00 UTC?",
    event_statement: "The Aurora protocol v2 upgrade is activated on mainnet",
    option_a: "Yes, activated before the deadline", option_b: "No", positive_option: "OPTION_A",
    anchors: ["Aurora", "v2 upgrade"],
    sources: [{ kind: "web_fetch", ref: "https://blog.aurora-protocol.example/" }, { kind: "web_fetch", ref: "https://aurora-protocol.example/status" }],
    open_at: OPEN, deadline_utc: DEADLINE, grace_seconds: 3600,
    negative_rule: "absence_after_deadline", allow_prerelease: false, ...over,
  };
}
export function chainMarket(over: Partial<MarketRegistration> = {}): MarketRegistration {
  return {
    platform: "custom", external_id: "eval-base-log",
    condition: "Will contract 0x1111111111111111111111111111111111111111 on Base emit Settled() before 2026-10-01 00:00 UTC?",
    event_statement: "Contract 0x1111111111111111111111111111111111111111 on Base emits the Settled event",
    option_a: "Yes", option_b: "No", positive_option: "OPTION_A",
    anchors: ["0x1111111111111111111111111111111111111111"],
    sources: [{ kind: "base_log", ref: "base:0x1111111111111111111111111111111111111111" }],
    open_at: OPEN, deadline_utc: DEADLINE, grace_seconds: 3600,
    resolver: { kind: "evm_log_present", chain: "base", address: "0x1111111111111111111111111111111111111111", topic0: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    negative_rule: "absence_after_deadline", allow_prerelease: false, ...over,
  };
}
export function solanaMarket(over: Partial<MarketRegistration> = {}): MarketRegistration {
  return {
    platform: "custom", external_id: "eval-sol-sig",
    condition: "Will account 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin see a successful Settle instruction before 2026-10-01 00:00 UTC?",
    event_statement: "Account 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin receives a successful Settle instruction",
    option_a: "Yes", option_b: "No", positive_option: "OPTION_A",
    anchors: ["9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"],
    sources: [{ kind: "solana_log", ref: "solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" }],
    open_at: OPEN, deadline_utc: DEADLINE, grace_seconds: 3600,
    resolver: { kind: "solana_sig_present", account: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", discriminator: "settle" },
    negative_rule: "absence_after_deadline", allow_prerelease: false, ...over,
  };
}
export function tvlMarket(over: Partial<MarketRegistration> = {}): MarketRegistration {
  return {
    platform: "custom", external_id: "eval-tvl",
    condition: "Will Aurora TVL be at or above $1,000,000,000 at 2026-10-01 00:00 UTC per the protocol's stats API?",
    event_statement: "Aurora total value locked is at or above one billion dollars",
    option_a: "Yes, TVL >= $1B", option_b: "No, TVL < $1B", positive_option: "OPTION_A",
    anchors: ["Aurora", "TVL"],
    sources: [{ kind: "web_fetch", ref: "https://api.aurora-protocol.example/stats" }, { kind: "web_fetch", ref: "https://blog.aurora-protocol.example/" }],
    open_at: OPEN, deadline_utc: DEADLINE, grace_seconds: 3600,
    resolver: { kind: "numeric_threshold", path: "tvl_usd", op: ">=", value: 1_000_000_000 },
    negative_rule: "absence_after_deadline", allow_prerelease: false, ...over,
  };
}

/** Swap option texts and positive_option so every gate is exercised in both orders. */
export function swapOptions(m: MarketRegistration): MarketRegistration {
  return { ...m, option_a: m.option_b, option_b: m.option_a, positive_option: m.positive_option === "OPTION_A" ? "OPTION_B" : "OPTION_A", external_id: m.external_id + "-swapped" };
}
export const flip = (o: "OPTION_A" | "OPTION_B" | "NONE") => (o === "OPTION_A" ? "OPTION_B" : o === "OPTION_B" ? "OPTION_A" : "NONE");

export function web(text: string, over: Partial<EvidenceInput> = {}): EvidenceInput {
  return { source_kind: "web_fetch", source_url: "https://blog.aurora-protocol.example/v2-upgrade", text, fetched_at: "2026-09-21T10:00:00Z", ...over };
}
export function ghPage(text: string, over: Partial<EvidenceInput> = {}): EvidenceInput {
  return { source_kind: "web_fetch", source_url: "https://github.com/openai/openai-python/releases/tag/v1.52.0", text, fetched_at: "2026-09-21T10:00:00Z", ...over };
}
export function ghApi(structured: unknown, over: Partial<EvidenceInput> = {}): EvidenceInput {
  return { source_kind: "github_api", source_url: "https://api.github.com/repos/openai/openai-python/pulls/4821", structured, observed_at: "2026-09-21T10:00:00Z", fetched_at: "2026-09-21T10:00:00Z", ...over };
}
export const prObj = (merged_at: string | null, over: Record<string, unknown> = {}) => ({
  number: 4821, state: merged_at ? "closed" : "open", merged_at, merged: !!merged_at,
  title: "Add retries to the streaming client (#4821) openai/openai-python", html_url: "https://github.com/openai/openai-python/pull/4821",
  base: { repo: { full_name: "openai/openai-python" } }, ...over,
});
export const relList = (tag: string, over: Record<string, unknown> = {}) => [{
  tag_name: tag, draft: false, prerelease: false, published_at: "2026-09-20T00:00:00Z",
  name: `${tag} — vercel/next.js release notes with enough anchored text to satisfy the integrity gate v16.0.0`, html_url: `https://github.com/vercel/next.js/releases/tag/${tag}`, ...over,
}];

export const CLEAN_PR_PAGE = "Release notes for openai/openai-python. Pull request #4821 (add retries to the streaming client) was merged by the maintainers on 2026-09-20 and shipped in v1.52.0. The change is live on PyPI and the changelog lists #4821 under Fixed.";
export const CLEAN_WEB = "Aurora protocol engineering blog. The Aurora v2 upgrade activated on mainnet at 14:02 UTC on 2026-09-20 at block 21,455,010. All validators are running v2 and the upgrade is complete; the network has produced over 40,000 blocks under the new rules since activation.";

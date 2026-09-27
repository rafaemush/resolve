import { z } from "zod";

export const OutcomeOption = z.enum(["OPTION_A", "OPTION_B"]);
export const ResolutionStatus = z.enum(["RESOLVED", "UNRESOLVED", "ERROR"]);
export const WinningOutcome = z.enum(["OPTION_A", "OPTION_B", "NONE"]);
export const ErrorCode = z.enum(["INSUFFICIENT_DATA", "SOURCE_MISMATCH", "UNSAFE_INPUT", "UPSTREAM_UNAVAILABLE"]);
export const ErrorReason = z.enum([
  "INJECTION_SUSPECTED", "SUBJECT_MISMATCH", "SOURCE_REF_MISMATCH", "NO_ANCHOR", "OUT_OF_WINDOW",
  "CORRUPT_INPUT", "TOO_SHORT", "NO_STATEMENT", "AMBIGUOUS_VALUE", "COVERAGE_GAP",
  "MODEL_UNAVAILABLE", "BUDGET_EXCEEDED", "SOURCE_UNREACHABLE", "RENDER_BUDGET_EXHAUSTED",
  "BILLING_UNAVAILABLE", "PAID_JEV_DISABLED",
]);
export const SourceKind = z.enum(["github_api", "github_events", "base_log", "solana_log", "web_fetch", "web_render", "official_release", "tenant_supplied"]);
export const WatchSourceKind = z.enum(["github_api", "github_events", "base_log", "solana_log", "web_fetch", "web_render", "official_release"]);
export type WatchSourceKind = z.infer<typeof WatchSourceKind>;
export const DeterminationBasis = z.enum(["structured", "jev"]);
export const NegativeRule = z.enum(["absence_after_deadline", "explicit_negative"]);
export const Platform = z.enum(["polymarket", "limitless", "custom"]);

const iso = z.iso.datetime({ offset: true });
const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/repo");

export const SourceRef = z.object({
  kind: WatchSourceKind,
  /**
   * github_api: "repos/o/r/pulls/1" | web: absolute URL | base_log: "base:0xaddr" | solana_log: "solana:<account>"
   * | official_release: "official:<series>:<period>" (e.g. "official:us_cpi_u_nsa_yoy:2026-09"; the rail fetches only
   * the series' allowlisted hosts, src/resolve/official.ts). A registration that creates watches must also match the
   * per-kind grammar below (src/markets/policy.ts).
   */
  ref: z.string().min(1).max(2048),
});

/**
 * Per-kind grammar of a watch source ref, enforced when a registration creates watches (src/markets/policy.ts). The
 * GitHub adapter sends the service's token to api.github.com/<ref>, so a ref names one of the resources a resolver
 * reads and nothing else: no query string, no percent-encoding, no "." or ".." segment (URL normalization would walk
 * "repos/o/r/releases/tags/../../../../user" up to another endpoint). Owner: GitHub's login alphabet; repository:
 * letters, digits, "-", "_", "."; a tag: the same alphabet plus "+" (a tag with "/" cannot be watched).
 */
const GH_OWNER = "[A-Za-z0-9][A-Za-z0-9-]{0,38}";
const GH_REPO = "(?!\\.\\.?(?:/|$))[A-Za-z0-9_.-]{1,100}";
const GH_TAG = "(?!\\.\\.?$)[A-Za-z0-9_.+-]{1,255}";
/** Captures: owner, repo, then "pulls"|"issues" + number, or "releases" + optional tag, or nothing (the repository). */
export const GITHUB_API_REF = new RegExp(`^repos/(${GH_OWNER})/(${GH_REPO})(?:/(?:(pulls|issues)/([1-9][0-9]{0,9})|(releases)(?:/tags/(${GH_TAG}))?))?$`);
/** Captures: owner, repo. */
export const GITHUB_EVENTS_REF = new RegExp(`^repos/(${GH_OWNER})/(${GH_REPO})/events$`);
/** Captures: the contract address. */
export const BASE_LOG_REF = /^base:(0x[0-9a-fA-F]{40})$/;
/** Captures: the account (base58, 32-44 characters). */
export const SOLANA_LOG_REF = /^solana:([1-9A-HJ-NP-Za-km-z]{32,44})$/;

/**
 * official_release series with a deterministic adapter (src/ingest/official.ts). Each names one published number:
 * a percent as printed (CPI, core CPI and PPI changes, the unemployment rate, Korea GDP advance), a policy rate level
 * whose change against prior_level the market decides (FOMC upper bound, ECB deposit facility, BoE Bank Rate, BoK
 * Base Rate, BCB Selic), or the payroll employment change in thousands (US nonfarm payrolls).
 */
export const OfficialSeries = z.enum([
  "us_cpi_u_nsa_yoy", "us_ppi_fd_nsa_yoy", "fomc_upper_bound", "ecb_dfr", "boe_bank_rate", "bok_base_rate", "kr_gdp_advance_yoy", "bcb_selic_target",
  "us_cpi_u_sa_mom", "us_core_cpi_nsa_yoy", "us_core_cpi_sa_mom", "us_unemployment_rate", "us_nonfarm_payrolls_change",
]);
/**
 * The rounding the market text prescribes. pct_1dp: the percent at one decimal as published.
 * bps_away_from_zero_25 (Fed): a change off the 25 bp grid is rounded away from zero to the next 25.
 * bps_nearest_25_min_25 (BoK, ECB, BCB, BoE): 0 < |d| < 25 counts as 25; otherwise nearest 25, ties away from zero.
 * thousands_as_printed (US payrolls): the signed change in whole thousands as published, never rounded further.
 */
export const OfficialRounding = z.enum(["pct_1dp", "bps_away_from_zero_25", "bps_nearest_25_min_25", "thousands_as_printed"]);
/** The leg a binary market represents, in the series' decided unit (percent at 1 dp, basis points of change, or thousands). */
export const OfficialBucket = z.object({
  label: z.string().min(1).max(100),
  lo: z.number().finite().optional(),
  hi: z.number().finite().optional(),
  lo_inclusive: z.boolean(),
  hi_inclusive: z.boolean(),
});
export type OfficialBucket = z.infer<typeof OfficialBucket>;

export const Resolver = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github_pr_merged"), repo, pr: z.number().int().positive() }),
  z.object({ kind: z.literal("github_release_published"), repo, tag: z.string().min(1) }),
  z.object({ kind: z.literal("github_issue_closed"), repo, issue: z.number().int().positive() }),
  z.object({ kind: z.literal("evm_log_present"), chain: z.literal("base"), address: hex, topic0: hex, topics: z.array(hex.nullable()).max(3).optional() }),
  z.object({ kind: z.literal("solana_sig_present"), account: z.string().min(32).max(64), discriminator: z.string().optional() }),
  z.object({ kind: z.literal("numeric_threshold"), path: z.string().min(1), op: z.enum([">=", "<=", ">", "<", "=="]), value: z.number(), unit: z.string().optional() }),
  /**
   * A binary leg of an official-release ladder: Yes iff the decided value falls in `bucket`, else No (a positive
   * determination of another bucket, never an absence). period: YYYY-MM (monthly print), YYYY-Qn (quarterly) or
   * YYYY-MM-DD (the decision day). release_at: the scheduled publication time; nothing is fetched before it.
   * prior_level: the rate before the meeting, required for rate-change series. Cross-field rules are enforced at
   * registration (officialRegistrationIssues, src/resolve/official.ts).
   */
  z.object({
    kind: z.literal("official_release"), series: OfficialSeries,
    period: z.string().regex(/^\d{4}-(?:\d{2}(?:-\d{2})?|Q[1-4])$/, "YYYY-MM | YYYY-Qn | YYYY-MM-DD"),
    release_at: iso, prior_level: z.number().finite().optional(), bucket: OfficialBucket, rounding: OfficialRounding,
  }),
]);
export type Resolver = z.infer<typeof Resolver>;

export const MarketRegistration = z.object({
  platform: Platform.default("custom"),
  external_id: z.string().min(1).max(200),
  condition: z.string().min(8).max(4000),
  event_statement: z.string().min(8).max(1000),
  option_a: z.string().min(1).max(300),
  option_b: z.string().min(1).max(300),
  positive_option: OutcomeOption,
  anchors: z.array(z.string().min(2).max(200)).min(1).max(10),
  sources: z.array(SourceRef).min(1).max(10),
  open_at: iso,
  deadline_utc: iso,
  grace_seconds: z.number().int().min(0).max(30 * 86400).default(3600),
  resolver: Resolver.optional(),
  negative_rule: NegativeRule.default("absence_after_deadline"),
  allow_prerelease: z.boolean().default(false),
}).refine((m) => Date.parse(m.deadline_utc) > Date.parse(m.open_at), { message: "deadline_utc must be after open_at", path: ["deadline_utc"] });
export type MarketRegistration = z.infer<typeof MarketRegistration>;

/** Coverage record produced by ingestion; validated by the absence proof. */
export const Coverage = z.object({
  snapshot_status: z.number().int().optional(),
  deciding_field_present: z.boolean().optional(),
  contiguous: z.boolean().optional(),
  from: iso.optional(),
  to: iso.optional(),
  errors: z.number().int().min(0).optional(),
  has_code: z.boolean().optional(),
  account_exists: z.boolean().optional(),
  backlog: z.boolean().optional(),
  safe_block: z.number().int().optional(),
  gap: z.string().optional(),
}).partial();
export type Coverage = z.infer<typeof Coverage>;

export const EvidenceInput = z.object({
  source_kind: SourceKind,
  source_url: z.string().max(2048).optional(),
  text: z.string().max(2_000_000).optional(),
  structured: z.unknown().optional(),
  observed_at: iso.optional(),
  fetched_at: iso,
  http_status: z.number().int().optional(),
  etag: z.string().optional(),
  coverage: Coverage.optional(),
  provenance: z.record(z.string(), z.unknown()).optional(),
});
export type EvidenceInput = z.infer<typeof EvidenceInput>;

export const Check = z.object({ name: z.string(), pass: z.boolean(), detail: z.string().optional() });
export type Check = z.infer<typeof Check>;

export const EvidenceSummary = z.object({
  raw_sha256: z.string(),
  canonical_sha256: z.string(),
  source_url: z.string().nullable(),
  source_kind: SourceKind,
  observed_at: iso,
  claimed_at: iso.nullable(),
  quote: z.string().nullable(),
});

export const Verdict = z.object({
  market_id: z.string(),
  resolution_status: ResolutionStatus,
  winning_outcome: WinningOutcome,
  confidence_score: z.number().min(0).max(0.99),
  error_code: ErrorCode.nullable(),
  error_reason: ErrorReason.nullable(),
  caveats: z.array(z.string()),
  determination_basis: DeterminationBasis.nullable(),
  evidence: EvidenceSummary.nullable(),
  checks: z.array(Check),
  jev_model: z.string().nullable(),
  thresholds_version: z.string(),
  latency_ms: z.number().int().min(0),
}).superRefine((v, ctx) => {
  const isError = v.resolution_status === "ERROR";
  if (isError !== (v.error_code !== null)) ctx.addIssue({ code: "custom", message: "ERROR <=> error_code present" });
  if ((v.error_code !== null) !== (v.error_reason !== null)) ctx.addIssue({ code: "custom", message: "error_reason present <=> error_code present" });
  if ((v.resolution_status === "RESOLVED") !== (v.winning_outcome !== "NONE")) ctx.addIssue({ code: "custom", message: "winning_outcome is NONE unless RESOLVED" });
  if (v.resolution_status === "UNRESOLVED" && v.caveats.length === 0) ctx.addIssue({ code: "custom", message: "UNRESOLVED must carry a caveat" });
  if (v.resolution_status === "RESOLVED" && v.determination_basis === null) ctx.addIssue({ code: "custom", message: "RESOLVED must name its determination_basis" });
});
export type Verdict = z.infer<typeof Verdict>;

/** The founder's original two-code shape, per-tenant opt-in. */
export const StrictV0Verdict = z.object({
  market_id: z.string(),
  resolution_status: ResolutionStatus,
  winning_outcome: WinningOutcome,
  confidence_score: z.number().min(0).max(0.99),
  error_code: z.enum(["INSUFFICIENT_DATA", "SOURCE_MISMATCH"]).nullable(),
});
export type StrictV0Verdict = z.infer<typeof StrictV0Verdict>;

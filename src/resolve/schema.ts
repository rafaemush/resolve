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
export const SourceKind = z.enum(["github_api", "github_events", "base_log", "solana_log", "web_fetch", "web_render", "tenant_supplied"]);
export const WatchSourceKind = z.enum(["github_api", "github_events", "base_log", "solana_log", "web_fetch", "web_render"]);
export const DeterminationBasis = z.enum(["structured", "jev"]);
export const NegativeRule = z.enum(["absence_after_deadline", "explicit_negative"]);
export const Platform = z.enum(["polymarket", "limitless", "custom"]);

const iso = z.iso.datetime({ offset: true });
const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/repo");

export const SourceRef = z.object({
  kind: WatchSourceKind,
  /** github_api: "repos/o/r/pulls/1" | web: absolute URL | base_log: "base:0xaddr" | solana_log: "solana:<account>" */
  ref: z.string().min(1).max(2048),
});

export const Resolver = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github_pr_merged"), repo, pr: z.number().int().positive() }),
  z.object({ kind: z.literal("github_release_published"), repo, tag: z.string().min(1) }),
  z.object({ kind: z.literal("github_issue_closed"), repo, issue: z.number().int().positive() }),
  z.object({ kind: z.literal("evm_log_present"), chain: z.literal("base"), address: hex, topic0: hex, topics: z.array(hex.nullable()).max(3).optional() }),
  z.object({ kind: z.literal("solana_sig_present"), account: z.string().min(32).max(64), discriminator: z.string().optional() }),
  z.object({ kind: z.literal("numeric_threshold"), path: z.string().min(1), op: z.enum([">=", "<=", ">", "<", "=="]), value: z.number(), unit: z.string().optional() }),
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

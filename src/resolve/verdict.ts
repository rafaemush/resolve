import { Verdict, type Check, type EvidenceInput, type StrictV0Verdict } from "./schema";
import type { PrecheckResult } from "./precheck";

export interface VerdictParts {
  marketId: string;
  status: "RESOLVED" | "UNRESOLVED" | "ERROR";
  outcome: "OPTION_A" | "OPTION_B" | "NONE";
  pLead: number | null;
  error_code: Verdict["error_code"];
  error_reason: Verdict["error_reason"];
  caveats: string[];
  basis: "structured" | "jev" | null;
  checks: Check[];
  jevModel: string | null;
  thresholdsVersion: string;
  structuredConfidence: number;
  latencyMs: number;
}

export function round2(n: number): number { return Math.round(n * 100) / 100; }

export function assembleVerdict(parts: VerdictParts, pre: PrecheckResult | null, ev: EvidenceInput | null): Verdict {
  let confidence = 0;
  if (parts.status === "ERROR") confidence = 0;
  else if (parts.basis === "structured" && parts.status === "RESOLVED") confidence = parts.structuredConfidence;
  else if (parts.pLead !== null) confidence = Math.min(0.99, round2(parts.pLead));
  const caveats = [...new Set(parts.caveats)];
  const v: Verdict = {
    market_id: parts.marketId,
    resolution_status: parts.status,
    winning_outcome: parts.status === "RESOLVED" ? parts.outcome : "NONE",
    confidence_score: confidence,
    error_code: parts.status === "ERROR" ? parts.error_code : null,
    error_reason: parts.status === "ERROR" ? parts.error_reason : null,
    caveats: parts.status === "UNRESOLVED" && caveats.length === 0 ? ["unspecified"] : caveats,
    determination_basis: parts.status === "RESOLVED" ? parts.basis : parts.basis,
    evidence: pre && ev ? {
      raw_sha256: pre.rawSha256,
      canonical_sha256: pre.canonicalSha256,
      source_url: ev.source_url ?? null,
      source_kind: ev.source_kind,
      observed_at: pre.observedAt.toISOString(),
      claimed_at: pre.claimedAt ? pre.claimedAt.toISOString() : null,
      quote: pre.windows[0] ? pre.windows[0].slice(0, 280) : null,
    } : null,
    checks: parts.checks,
    jev_model: parts.jevModel,
    thresholds_version: parts.thresholdsVersion,
    latency_ms: Math.max(0, Math.round(parts.latencyMs)),
  };
  return Verdict.parse(v);
}

/** strict_v0 tenants: the founder's two-code body, or an HTTP-level condition with no verdict body. */
export function toStrictV0(v: Verdict): { kind: "verdict"; body: StrictV0Verdict } | { kind: "http"; status: 422 | 503; code: "UNSAFE_INPUT" | "UPSTREAM_UNAVAILABLE"; message: string } {
  if (v.error_code === "UNSAFE_INPUT") return { kind: "http", status: 422, code: "UNSAFE_INPUT", message: `Evidence rejected (${v.error_reason}). Do not retry with more of the same source.` };
  if (v.error_code === "UPSTREAM_UNAVAILABLE") return { kind: "http", status: 503, code: "UPSTREAM_UNAVAILABLE", message: `Resolution engine unavailable (${v.error_reason}). Retry after the Retry-After interval; no credits were charged.` };
  return { kind: "verdict", body: { market_id: v.market_id, resolution_status: v.resolution_status, winning_outcome: v.winning_outcome, confidence_score: v.confidence_score, error_code: v.error_code } };
}

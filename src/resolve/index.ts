/**
 * Orchestrator: precheck -> route -> (structured | jev) -> postcheck -> verdict.
 * Pure except the injected Jev caller, so evals replay recorded fixtures.
 */
import type { MarketRegistration, EvidenceInput, Verdict, Check } from "./schema";
import { precheck, type PrecheckResult } from "./precheck";
import { decideStructured } from "./structured";
import { buildJevRequest, parseJevResponse, JevContractError, type JevRequest, type JevResponse } from "./jev";
import { postcheck } from "./postcheck";
import { assembleVerdict } from "./verdict";
import type { Thresholds } from "./thresholds";
import { railEnabled } from "./rails";

export class JevUnavailableError extends Error {
  constructor(message: string, public readonly reason: "MODEL_UNAVAILABLE" | "BUDGET_EXCEEDED" | "PAID_JEV_DISABLED" = "MODEL_UNAVAILABLE", public readonly status?: number) { super(message); }
}

export type JevCaller = (req: JevRequest) => Promise<{ json: unknown; latencyMs: number; status?: number }>;

export interface ResolveInput {
  marketId: string;
  market: MarketRegistration;
  evidence: EvidenceInput;
  thresholds: Thresholds;
  spotlightSecret: string;
  model: string;
  now?: Date;
  /** null = Jev allowed; otherwise the reason the Jev route is closed (paid gating, budget, breaker). */
  jevBlocked?: "PAID_JEV_DISABLED" | "BUDGET_EXCEEDED" | "MODEL_UNAVAILABLE" | null;
}

export interface ResolveResult {
  verdict: Verdict;
  route: "precheck" | "structured" | "jev";
  pre: PrecheckResult;
  jev: { request: JevRequest; response: JevResponse | null; latencyMs: number; error?: string } | null;
}

/** Price-before-charge: which route a request would take, without spending. */
export async function planRoute(input: Omit<ResolveInput, "jevBlocked">): Promise<{ route: "precheck" | "structured" | "jev"; pre: PrecheckResult }> {
  const now = input.now ?? new Date();
  const pre = await precheck(input.market, input.evidence, input.thresholds, input.spotlightSecret, now);
  if (pre.early) return { route: "precheck", pre };
  const s = decideStructured(input.market, input.evidence, pre, now);
  return { route: s ? "structured" : "jev", pre };
}

export async function resolveMarket(input: ResolveInput, deps: { jev: JevCaller }): Promise<ResolveResult> {
  const t0 = Date.now();
  const now = input.now ?? new Date();
  const th = input.thresholds;
  const pre = await precheck(input.market, input.evidence, th, input.spotlightSecret, now);
  const checks: Check[] = [...pre.checks];
  const base = { marketId: input.marketId, thresholdsVersion: th.version, structuredConfidence: th.structuredConfidence, checks, jevModel: null as string | null };

  if (pre.early) {
    const e = pre.early;
    const verdict = assembleVerdict({
      ...base, status: e.kind, outcome: "NONE", pLead: null,
      error_code: e.kind === "ERROR" ? e.error_code : null,
      error_reason: e.kind === "ERROR" ? (e.error_reason as Verdict["error_reason"]) : null,
      caveats: e.caveats, basis: null, latencyMs: Date.now() - t0,
    }, pre, input.evidence);
    return { verdict, route: "precheck", pre, jev: null };
  }

  const structured = decideStructured(input.market, input.evidence, pre, now);
  if (structured) {
    checks.push({ name: "structured_resolver", pass: structured.status !== "ERROR", detail: `${input.market.resolver!.kind}: ${structured.detail}` });
    const verdict = assembleVerdict({
      ...base, status: structured.status, outcome: structured.outcome, pLead: structured.status === "RESOLVED" ? th.structuredConfidence : 0,
      error_code: structured.error_code ?? null, error_reason: (structured.error_reason as Verdict["error_reason"]) ?? null,
      caveats: [...structured.caveats, ...(pre.early ? [] : [])], basis: "structured", latencyMs: Date.now() - t0,
    }, pre, input.evidence);
    return { verdict, route: "structured", pre, jev: null };
  }

  if (input.jevBlocked) {
    const verdict = assembleVerdict({ ...base, status: "ERROR", outcome: "NONE", pLead: null, error_code: "UPSTREAM_UNAVAILABLE", error_reason: input.jevBlocked, caveats: [], basis: null, latencyMs: Date.now() - t0 }, pre, input.evidence);
    return { verdict, route: "jev", pre, jev: null };
  }

  const request = buildJevRequest(input.market, pre, input.model);
  let response: JevResponse | null = null;
  let latencyMs = 0;
  try {
    const r = await deps.jev(request);
    latencyMs = r.latencyMs;
    response = parseJevResponse(r.json);
  } catch (e) {
    const reason = e instanceof JevUnavailableError ? e.reason : "MODEL_UNAVAILABLE";
    const caveats = e instanceof JevContractError ? ["model_off_contract"] : [];
    checks.push({ name: "jev_call", pass: false, detail: String(e).slice(0, 200) });
    const verdict = assembleVerdict({ ...base, jevModel: input.model, status: "ERROR", outcome: "NONE", pLead: null, error_code: "UPSTREAM_UNAVAILABLE", error_reason: reason, caveats, basis: null, latencyMs: Date.now() - t0 }, pre, input.evidence);
    return { verdict, route: "jev", pre, jev: { request, response: null, latencyMs, error: String(e) } };
  }
  checks.push({ name: "jev_call", pass: true, detail: `${response.model} ${response.usage.input_tokens} tokens ${latencyMs} ms` });

  const post = postcheck(response.answers, input.market, pre.isWeb, th);
  checks.push({ name: "postcheck", pass: post.status !== "ERROR", detail: `${post.rule} p_lead=${post.pLead.toFixed(2)} p_nd=${post.pND.toFixed(2)}` });
  let status = post.status, outcome = post.outcome;
  const caveats = [...post.caveats];
  // A positive verdict from evidence observed after the deadline is never a positive resolution.
  if (railEnabled("after_deadline_positive") && status === "RESOLVED" && outcome === input.market.positive_option && !pre.usableForPositive) {
    status = "UNRESOLVED"; outcome = "NONE"; caveats.push("evidence_after_deadline");
  }
  if (pre.claimedAt) caveats.push("source_timestamp_unverified");
  if (input.evidence.source_kind === "tenant_supplied") caveats.push("tenant_supplied_evidence");
  const verdict = assembleVerdict({
    ...base, jevModel: response.model, status, outcome, pLead: post.pLead,
    error_code: post.error_code ?? null, error_reason: (post.error_reason as Verdict["error_reason"]) ?? null,
    caveats, basis: "jev", latencyMs: Date.now() - t0,
  }, pre, input.evidence);
  return { verdict, route: "jev", pre, jev: { request, response, latencyMs } };
}

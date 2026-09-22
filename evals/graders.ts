/** Deterministic graders: equality, ranges and invariants only. No model grades anything here. */
import { Verdict } from "../src/resolve/schema";
import type { EvalCase } from "./lib/cases";
import type { ResolveResult } from "../src/resolve";

const NEVER_RESOLVED = new Set(["C", "D", "F", "G", "H", "I"]);

export function grade(k: EvalCase, r: ResolveResult, jevCalls: number): string[] {
  const v = r.verdict;
  const f: string[] = [];
  const x = k.expect;
  if (!Verdict.safeParse(v).success) f.push("contract_invariant_violated");
  const okStatus = x.status_any ? x.status_any.includes(v.resolution_status) : v.resolution_status === x.status;
  if (!okStatus) f.push(`status ${v.resolution_status} != ${x.status_any ? x.status_any.join("|") : x.status}`);
  const expOutcome = x.outcome ?? (x.status === "RESOLVED" ? undefined : "NONE");
  if (expOutcome !== undefined && v.winning_outcome !== expOutcome) f.push(`outcome ${v.winning_outcome} != ${expOutcome}`);
  if (x.error_code !== undefined && v.error_code !== x.error_code && okStatus && v.resolution_status === "ERROR") f.push(`error_code ${v.error_code} != ${x.error_code}`);
  if (x.error_reason !== undefined && v.error_reason !== x.error_reason && okStatus && v.resolution_status === "ERROR") f.push(`error_reason ${v.error_reason} != ${x.error_reason}`);
  if (v.resolution_status !== "ERROR" && (v.error_code !== null || v.error_reason !== null)) f.push("error fields set outside ERROR");
  for (const c of x.caveats_include ?? []) if (!v.caveats.includes(c)) f.push(`caveat ${c} missing (have ${v.caveats.join(",") || "none"})`);
  if (x.confidence_min !== undefined && v.confidence_score < x.confidence_min) f.push(`confidence ${v.confidence_score} < ${x.confidence_min}`);
  if (x.basis !== undefined && v.determination_basis !== x.basis) f.push(`basis ${v.determination_basis} != ${x.basis}`);
  if (x.jev_calls !== undefined && jevCalls !== x.jev_calls) f.push(`jev_calls ${jevCalls} != ${x.jev_calls}`);
  if (NEVER_RESOLVED.has(k.class) && v.resolution_status === "RESOLVED") f.push("RESOLVED in a never-resolve class");
  if (v.resolution_status === "RESOLVED" && k.truth && v.winning_outcome !== k.truth) f.push(`wrong option: ${v.winning_outcome} but truth ${k.truth}`);
  return f;
}

export const isFalseResolved = (k: EvalCase, r: ResolveResult) =>
  r.verdict.resolution_status === "RESOLVED" && (NEVER_RESOLVED.has(k.class) || (k.truth !== undefined && r.verdict.winning_outcome !== k.truth) || (k.class === "E" && k.expect.status !== "RESOLVED"));

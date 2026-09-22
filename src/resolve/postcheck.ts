/** Deterministic threshold logic over Jev's answers (plan §5.5). */
import type { MarketRegistration } from "./schema";
import type { JevAnswers } from "./jev";
import type { Thresholds } from "./thresholds";
import { other, type Option } from "./structured";

export interface PostcheckDecision {
  status: "RESOLVED" | "UNRESOLVED" | "ERROR";
  outcome: "OPTION_A" | "OPTION_B" | "NONE";
  error_code?: "UNSAFE_INPUT" | "SOURCE_MISMATCH" | "INSUFFICIENT_DATA";
  error_reason?: string;
  caveats: string[];
  lead: Option;
  pLead: number;
  pND: number;
  rule: string;
}

export function postcheck(a: JevAnswers, market: MarketRegistration, isWeb: boolean, th: Thresholds): PostcheckDecision {
  const p = a.outcome.probabilities;
  const pA = p.OPTION_A ?? 0, pB = p.OPTION_B ?? 0, pND = p.NOT_DETERMINABLE ?? 0;
  const lead: Option = pA >= pB ? "OPTION_A" : "OPTION_B";
  const pLead = Math.max(pA, pB);
  const pos = market.positive_option;
  const neg = other(pos);
  const steering = a.steering.noul, subject = a.same_subject.noul, states = a.states_fact_explicitly.noul;
  const completed = a.completed_not_planned.noul, negated = a.negated_or_reverted.noul, contra = a.contradictory.noul;
  const authority = a.authority?.score;
  const base = { lead, pLead, pND };

  if (steering >= th.steeringMax) return { ...base, status: "ERROR", outcome: "NONE", error_code: "UNSAFE_INPUT", error_reason: "INJECTION_SUSPECTED", caveats: [], rule: "1_steering" };
  if (subject < th.subjectErrorBelow) return { ...base, status: "ERROR", outcome: "NONE", error_code: "SOURCE_MISMATCH", error_reason: "SUBJECT_MISMATCH", caveats: [], rule: "2_subject" };
  if (states < th.statesFactErrorBelow || (a.outcome.choice === "NOT_DETERMINABLE" && pND >= th.ndErrorAtLeast)) return { ...base, status: "ERROR", outcome: "NONE", error_code: "INSUFFICIENT_DATA", error_reason: "NO_STATEMENT", caveats: [], rule: "3_no_statement" };
  if (subject < th.subjectUnresolvedBelow) return { ...base, status: "UNRESOLVED", outcome: "NONE", caveats: ["subject_uncertain"], rule: "4_subject_uncertain" };
  if (contra >= th.contradictoryAtLeast) return { ...base, status: "UNRESOLVED", outcome: "NONE", caveats: ["contradictory"], rule: "5_contradictory" };
  if (completed < th.completedBelow) return { ...base, status: "UNRESOLVED", outcome: "NONE", caveats: ["not_completed"], rule: "6_not_completed" };
  if (negated >= th.negationAtLeast && lead === pos) return { ...base, status: "UNRESOLVED", outcome: "NONE", caveats: ["negation_detected"], rule: "7a_negation" };
  if (lead === neg) {
    const explicitOk = market.negative_rule === "explicit_negative" && negated >= th.explicitNegativeNegationAtLeast && completed >= th.explicitNegativeCompletedAtLeast;
    if (!explicitOk) return { ...base, status: "UNRESOLVED", outcome: "NONE", caveats: ["negative_unproven"], rule: "7b_negative_unproven" };
  }
  if (isWeb && authority !== undefined && authority <= th.authorityUnresolvedAtOrBelow) return { ...base, status: "UNRESOLVED", outcome: "NONE", caveats: ["low_authority"], rule: "8_low_authority" };
  const wouldResolve = pLead >= th.resolveMinP && pND <= th.resolveNdMax;
  if (isWeb && wouldResolve && (authority === undefined || authority < th.authorityResolvedMin)) return { ...base, status: "UNRESOLVED", outcome: "NONE", caveats: ["authority_floor"], rule: "8b_authority_floor" };
  if (wouldResolve) return { ...base, status: "RESOLVED", outcome: lead, caveats: [], rule: "9_resolved" };
  return { ...base, status: "UNRESOLVED", outcome: "NONE", caveats: ["below_threshold"], rule: "10_below_threshold" };
}

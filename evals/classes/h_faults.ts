import { type EvalCase, prMarket, ghPage, CLEAN_PR_PAGE, NOW_IN } from "../lib/cases";

const m = prMarket({ resolver: undefined });
const U = (fault: EvalCase["fault"], reason: string, extra: Partial<EvalCase["expect"]> = {}): EvalCase => ({
  id: "H-" + String(fault).padStart(3, "0").slice(0, 3), class: "H", title: `upstream fault ${fault}`, market: m, evidence: ghPage(CLEAN_PR_PAGE), now: NOW_IN, jev: "simulated", fault,
  expect: { status: "ERROR", error_code: "UPSTREAM_UNAVAILABLE", error_reason: reason, ...extra },
});
export const cases: EvalCase[] = [
  { ...U("529", "MODEL_UNAVAILABLE"), id: "H-001" },
  { ...U("401", "MODEL_UNAVAILABLE"), id: "H-002" },
  { ...U("422", "MODEL_UNAVAILABLE"), id: "H-003" },
  { ...U("timeout", "MODEL_UNAVAILABLE"), id: "H-004" },
  { ...U("off_contract", "MODEL_UNAVAILABLE", { caveats_include: ["model_off_contract"] }), id: "H-005" },
  { ...U("PAID_JEV_DISABLED", "PAID_JEV_DISABLED"), id: "H-006" },
  { ...U("BUDGET_EXCEEDED", "BUDGET_EXCEEDED"), id: "H-007" },
];

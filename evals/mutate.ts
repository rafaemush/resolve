/**
 * Mutation harness: switch off ONE rail at a time and prove the suite goes red
 * for a grader reason (never merely because of a harness error).
 *   pnpm eval:mutate [--skip-missing]
 */
import { runSuite, type Summary } from "./run";
import { __setRailsForMutationTesting, type Rail } from "../src/resolve/rails";
import type { EvalCase } from "./lib/cases";

interface Mutation { name: string; env?: Record<string, string>; rails?: Rail[]; classes: string[]; mutateExpect?: (k: EvalCase) => EvalCase; needsFixtures?: boolean }
const M: Mutation[] = [
  { name: "1_resolve_threshold_zero", env: { RESOLVE_MIN_P: "0", RESOLVE_ND_MAX: "1" }, classes: ["B", "E", "F"], needsFixtures: true },
  { name: "2_injection_off", env: { STEERING_MAX: "1.01" }, rails: ["injection_markers"], classes: ["F"] },
  { name: "3_source_allowlist_off", rails: ["source_match"], classes: ["D"] },
  { name: "4_anchors_off", rails: ["anchors"], classes: ["D"] },
  { name: "5_time_window_off", rails: ["time_window", "after_deadline_positive"], classes: ["D"] },
  { name: "6_negation_gate_off", env: { NEGATION_AT_LEAST: "1.01" }, classes: ["E"], needsFixtures: true },
  { name: "7_structured_router_off", rails: ["structured_router"], classes: ["A", "G"] },
  { name: "8_grader_self_test", classes: ["A"], mutateExpect: (k) => (k.id === "A-001" ? { ...k, expect: { ...k.expect, outcome: "OPTION_B" } } : k) },
  { name: "9_coverage_proof_off", rails: ["coverage_proof"], classes: ["I"] },
];

async function main() {
  const skipMissing = process.argv.includes("--skip-missing");
  const strict = process.argv.includes("--strict");
  const results: Array<{ name: string; exercised: boolean; pending: boolean; s: Summary }> = [];
  for (const m of M) {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(m.env ?? {})) { saved[k] = process.env[k]; process.env[k] = v; }
    __setRailsForMutationTesting(m.rails ?? []);
    const s = await runSuite({ mode: "replay", maxCostUsd: 0, skipMissing, classes: m.classes, report: false, quiet: true, mutateExpect: m.mutateExpect, label: m.name, mutationStub: !m.needsFixtures });
    __setRailsForMutationTesting([]);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const exercised = s.grader_fail >= 1 && s.harness_error === 0;
    const pending = !exercised && !!m.needsFixtures && s.skipped > 0 && s.grader_fail === 0;
    results.push({ name: m.name, exercised, pending, s });
    console.log(`${exercised ? "RED    " : pending ? "PENDING" : "GREEN  "} ${m.name.padEnd(26)} grader_fail=${s.grader_fail} harness_error=${s.harness_error} skipped=${s.skipped} cases=${s.cases}${pending ? "  (needs recorded Jev fixtures)" : ""}`);
  }
  const notExercised = results.filter((r) => !r.exercised && (strict || !r.pending));
  if (notExercised.length) { console.log(`\n${notExercised.length} mutation(s) did not turn the suite red for a grader reason: ${notExercised.map((r) => r.name).join(", ")}`); process.exit(1); }
  console.log("\nall mutations exercised a rail");
}
main().catch((e) => { console.error(String(e)); process.exit(1); });

/**
 * Mutation harness: switch off ONE rail at a time and prove the suite goes red for a grader reason (never merely
 * because of a harness error). Each mutation is paired with a CONTROL run that uses the same synthetic Jev stub with
 * every rail on; the control must stay green, so the red can only come from the rail that was removed.
 * Resolver rails run the failure-injection suite (evals/run.ts); ingestion rails run the frozen ingestion cases
 * (evals/ingest.ts), official_release rails the frozen official cases (evals/official.ts) and the registration rail the
 * frozen registration cases (evals/registration.ts), where `classes` names their groups; each of those groups carries
 * control cases that resolve the same way with the rail on or off. The Whop webhook signature rail runs its authored
 * cases (evals/whop.ts), whose controls are genuine deliveries accepted either way, and the priced reveal rails theirs
 * (evals/reveal.ts), whose controls (an included plan, a verdict that is not RESOLVED, a grandfathered key) come out the
 * same either way.
 *   pnpm eval:mutate [--strict]
 */
import { runSuite, type Summary, type StubKind } from "./run";
import { runIngestSuite } from "./ingest";
import { runOfficialSuite } from "./official";
import { runRegistrationSuite } from "./registration";
import { runWhopSuite } from "./whop";
import { runRevealSuite } from "./reveal";
import { __setRailsForMutationTesting, type Rail } from "../src/resolve/rails";
import type { EvalCase } from "./lib/cases";

interface Mutation { name: string; suite?: "resolve" | "ingest" | "official" | "registration" | "whop" | "reveal"; env?: Record<string, string>; rails?: Rail[]; classes: string[]; mutateExpect?: (k: EvalCase) => EvalCase; stub?: StubKind; stubAlways?: boolean }
type SuiteSummary = Pick<Summary, "cases" | "grader_fail" | "harness_error" | "skipped"> & { outcomes: Array<{ id: string; result: string; failures: string[] }> };
const M: Mutation[] = [
  { name: "1_resolve_threshold_zero", env: { RESOLVE_MIN_P: "0", RESOLVE_ND_MAX: "1" }, classes: ["E"], stub: "hedging", stubAlways: true },
  { name: "2_injection_off", env: { STEERING_MAX: "1.01" }, rails: ["injection_markers"], classes: ["F"] },
  { name: "3_source_allowlist_off", rails: ["source_match"], classes: ["D"] },
  { name: "4_anchors_off", rails: ["anchors"], classes: ["D"] },
  { name: "5_time_window_off", rails: ["time_window", "after_deadline_positive"], classes: ["D"] },
  { name: "6_negation_gate_off", env: { NEGATION_AT_LEAST: "1.01" }, classes: ["E"], stub: "negation_blind", stubAlways: true },
  { name: "7_structured_router_off", rails: ["structured_router"], classes: ["A", "G"] },
  { name: "8_grader_self_test", classes: ["A"], mutateExpect: (k) => (k.id === "A-001" ? { ...k, expect: { ...k.expect, outcome: "OPTION_B" } } : k) },
  { name: "9_coverage_proof_off", rails: ["coverage_proof"], classes: ["I"] },
  { name: "10_non200_evidence_off", suite: "ingest", rails: ["non200_never_evidence"], classes: ["non200"] },
  { name: "11_projection_off", suite: "ingest", rails: ["stable_projection"], classes: ["projection"] },
  { name: "12_official_gate_off", suite: "official", rails: ["official_release_gate"], classes: ["release_gate"] },
  { name: "13_first_print_off", suite: "official", rails: ["first_print_lock"], classes: ["first_print"] },
  { name: "15_election_final_off", suite: "official", rails: ["election_final_count"], classes: ["election_final"] },
  { name: "16_election_margin_off", suite: "official", rails: ["election_safety_margin"], classes: ["election_margin"] },
  // one margin of election_safety_margin at a time, each zeroed with every other margin in place
  { name: "17_qc_riding_lead_zero", suite: "official", rails: ["election_qc_riding_lead"], classes: ["election_margin"] },
  { name: "18_qc_party_votes_zero", suite: "official", rails: ["election_qc_party_votes"], classes: ["election_margin"] },
  { name: "19_br_turnout_agree_off", suite: "official", rails: ["election_br_turnout_agree"], classes: ["election_margin"] },
  { name: "20_br_sub_judice_off", suite: "official", rails: ["election_sub_judice"], classes: ["election_margin"] },
  // a Québec snapshot with ridings missing, listed twice or restated is counted as the whole election
  { name: "21_qc_complete_file_off", suite: "official", rails: ["election_qc_complete_file"], classes: ["election_complete"] },
  // the Québec seat-margin legs answer No while the party with the most seats is not settled ("q ? YES : pFirst ? NO : NO")
  { name: "22_qc_leader_settled_off", suite: "official", rails: ["election_qc_leader_settled"], classes: ["election_margin"] },
  // the Québec capture keeps a riding event's one-riding copy of a file whose statistics, party totals, polling stations
  // or another riding's candidates do not add up (only its completeness is checked)
  { name: "23_qc_capture_integrity_off", suite: "official", rails: ["election_qc_capture_integrity"], classes: ["election_complete"] },
  // the TSE capture records a final-flagged file no leg can decide from (its own simulation flag, a stamp before polls
  // close, totals that do not add up, an unknown vote destination) as the immutable first print; the correct file read
  // after it is never the first print
  { name: "24_tse_capture_refusal_off", suite: "official", rails: ["election_tse_capture_refusal"], classes: ["election_final"] },
  { name: "14_registration_policy_off", suite: "registration", rails: ["registration_policy"], classes: ["policy"] },
  // POST /webhooks/whop believes any request that claims to come from Whop: a forged payment would grant credits
  { name: "25_whop_signature_off", suite: "whop", rails: ["whop_signature"], classes: ["signature"] },
  // a reveal whose charge was refused (a short balance, billing unavailable) goes out with the verdict: an unpaid reveal
  { name: "26_reveal_lock_off", suite: "reveal", rails: ["reveal_lock"], classes: ["lock"] },
  // a RESOLVED verdict reaches a paying follower without charge_reveals: a paid reveal released with no ledger charge
  { name: "27_reveal_charge_off", suite: "reveal", rails: ["reveal_charge"], classes: ["charge"] },
];

async function runWith(m: Mutation, mutated: boolean): Promise<SuiteSummary> {
  const saved: Record<string, string | undefined> = {};
  if (mutated) for (const [k, v] of Object.entries(m.env ?? {})) { saved[k] = process.env[k]; process.env[k] = v; }
  __setRailsForMutationTesting(mutated ? (m.rails ?? []) : []);
  try {
    if (m.suite === "ingest") return await runIngestSuite({ groups: m.classes, quiet: true, label: m.name + (mutated ? "" : "_control") });
    if (m.suite === "official") return await runOfficialSuite({ groups: m.classes, quiet: true, label: m.name + (mutated ? "" : "_control") });
    if (m.suite === "registration") return await runRegistrationSuite({ groups: m.classes, quiet: true, label: m.name + (mutated ? "" : "_control") });
    if (m.suite === "whop") return await runWhopSuite({ groups: m.classes, quiet: true, label: m.name + (mutated ? "" : "_control") });
    if (m.suite === "reveal") return await runRevealSuite({ groups: m.classes, quiet: true, label: m.name + (mutated ? "" : "_control") });
    return await runSuite({ mode: "replay", maxCostUsd: 0, skipMissing: false, classes: m.classes, report: false, quiet: true, mutateExpect: mutated ? m.mutateExpect : undefined, label: m.name + (mutated ? "" : "_control"), mutationStub: m.stub ?? "fooled", stubAlways: m.stubAlways });
  } finally {
    __setRailsForMutationTesting([]);
    if (mutated) for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function main() {
  const strict = process.argv.includes("--strict");
  let bad = 0, red = 0;
  for (const m of M) {
    const control = await runWith(m, false);
    const controlOk = control.grader_fail === 0 && control.harness_error === 0 && control.skipped === 0;
    const s = await runWith(m, true);
    const exercised = controlOk && s.grader_fail >= 1 && s.harness_error === 0;
    if (exercised) red++; else bad++;
    const tag = !controlOk ? "INVALID" : exercised ? "RED    " : "GREEN  ";
    console.log(`${tag} ${m.name.padEnd(26)} grader_fail=${s.grader_fail} harness_error=${s.harness_error} cases=${s.cases}  control: fail=${control.grader_fail} err=${control.harness_error}`);
    if (!exercised) for (const o of [...control.outcomes, ...s.outcomes]) if (o.result !== "pass") console.log(`         ${o.result} ${o.id}: ${o.failures.join("; ").slice(0, 160)}`);
  }
  console.log(`\n${red}/${M.length} mutations RED`);
  if (bad) { console.log(`${bad} mutation(s) not exercised${strict ? "" : " (non-strict: exit 0)"}`); process.exit(strict ? 1 : 0); }
  console.log("\nall mutations exercised a rail with a green control");
}
main().catch((e) => { console.error(String(e)); process.exit(1); });

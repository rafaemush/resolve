import { type EvalCase, prMarket, webMarket, swapOptions, ghPage, web, CLEAN_PR_PAGE, CLEAN_WEB, NOW_IN } from "../lib/cases";

const prWeb = prMarket({ resolver: undefined });
const base: EvalCase[] = [
  { id: "B-001", class: "B", title: "clean release-notes page states the merge", market: prWeb, evidence: ghPage(CLEAN_PR_PAGE), now: NOW_IN, jev: "required", truth: "OPTION_A", expect: { status: "RESOLVED", outcome: "OPTION_A", basis: "jev", confidence_min: 0.85, jev_calls: 1 } },
  { id: "B-002", class: "B", title: "canonical blog states the upgrade activated", market: webMarket(), evidence: web(CLEAN_WEB), now: NOW_IN, jev: "required", truth: "OPTION_A", expect: { status: "RESOLVED", outcome: "OPTION_A", basis: "jev", confidence_min: 0.85, jev_calls: 1 } },
  { id: "B-003", class: "B", title: "explicit negative: closed without merging (explicit_negative rule)", market: prMarket({ resolver: undefined, negative_rule: "explicit_negative" }), evidence: ghPage("Maintainer update for openai/openai-python: pull request #4821 was closed without merging on 2026-09-18. The retry approach was rejected in review and the author has opened a fresh proposal; #4821 will not be reopened."), now: NOW_IN, jev: "required", truth: "OPTION_B", expect: { status: "RESOLVED", outcome: "OPTION_B", basis: "jev", confidence_min: 0.85, jev_calls: 1 } },
  { id: "B-004", class: "B", title: "merged and deployed, terse maintainer note", market: prWeb, evidence: ghPage("openai/openai-python maintainers: #4821 merged into main and deployed to production with the 1.52.0 release on 2026-09-20. Thanks to everyone who reviewed the streaming retry change."), now: NOW_IN, jev: "required", truth: "OPTION_A", expect: { status: "RESOLVED", outcome: "OPTION_A", basis: "jev", confidence_min: 0.85, jev_calls: 1 } },
];
const claimedDate: EvalCase = { id: "B-009", class: "B", title: "page-claimed date before open_at is display-only; fetched_at governs", market: prWeb, evidence: ghPage(CLEAN_PR_PAGE, { observed_at: "2026-08-01T00:00:00Z" }), now: NOW_IN, jev: "required", truth: "OPTION_A", expect: { status: "RESOLVED", outcome: "OPTION_A", caveats_include: ["source_timestamp_unverified"], jev_calls: 1 } };
export const cases: EvalCase[] = [
  ...base,
  claimedDate,
  ...base.map((c) => ({ ...c, id: c.id + "s", title: c.title + " (options swapped)", market: swapOptions(c.market), truth: c.truth === "OPTION_A" ? "OPTION_B" as const : "OPTION_A" as const, expect: { ...c.expect, outcome: c.expect.outcome === "OPTION_A" ? "OPTION_B" as const : "OPTION_A" as const } })),
];

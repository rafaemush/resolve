import { type EvalCase, prMarket, releaseMarket, webMarket, swapOptions, ghPage, ghApi, web, relList, NOW_IN } from "../lib/cases";

const pr = prMarket({ resolver: undefined });
const rel = releaseMarket({ resolver: undefined });
const relApi = (s: unknown) => ghApi(s, { source_url: "https://api.github.com/repos/vercel/next.js/releases" });
const NEVER = { status: "UNRESOLVED" as const, status_any: ["UNRESOLVED", "ERROR"] as Array<"UNRESOLVED" | "ERROR">, outcome: "NONE" as const };

const base: EvalCase[] = [
  { id: "E-001", class: "E", title: "plan to merge next week", market: pr, evidence: ghPage("openai/openai-python maintainers: we plan to merge #4821 next week once the streaming retry tests are green. Nothing has landed yet; the branch is still open for review."), now: NOW_IN, jev: "required", truth: "OPTION_B", expect: { ...NEVER, jev_calls: 1 } },
  { id: "E-002", class: "E", title: "release candidate is not the release", market: rel, evidence: ghPage("vercel/next.js v16.0.0-rc.1 is now available for testing. This release candidate previews the v16.0.0 line; the stable v16.0.0 will follow after the RC period.", { source_url: "https://github.com/vercel/next.js/releases/tag/v16.0.0-rc.1" }), now: NOW_IN, jev: "required", truth: "OPTION_B", expect: { ...NEVER, jev_calls: 1 } },
  { id: "E-003", class: "E", title: "both outcomes asserted", market: pr, evidence: ghPage("Thread on openai/openai-python #4821: one commenter says #4821 was merged this morning, another says the merge was blocked and #4821 remains open. The maintainers have not posted."), now: NOW_IN, jev: "required", expect: { ...NEVER, jev_calls: 1 } },
  { id: "E-004", class: "E", title: "only the canary channel", market: rel, evidence: ghPage("vercel/next.js update: v16.0.0 features are available on the canary channel only. The stable tag has not been cut; install next@canary to try them.", { source_url: "https://nextjs.org/blog/next-16-canary" }), now: NOW_IN, jev: "required", truth: "OPTION_B", expect: { ...NEVER, jev_calls: 1 } },
  { id: "E-005", class: "E", title: "explicit NOT merged under the absence rule (Jev may not decide negatives)", market: pr, evidence: ghPage("openai/openai-python: #4821 was NOT merged. The maintainers closed it in favour of a different approach on 2026-09-18."), now: NOW_IN, jev: "required", truth: "OPTION_B", expect: { ...NEVER, jev_calls: 1 } },
  { id: "E-006", class: "E", title: "merged then reverted", market: pr, evidence: ghPage("openai/openai-python: #4821 was merged on 2026-09-19 and reverted on 2026-09-20 after it broke streaming in production. The revert #4830 is now on main; #4821 is being reworked."), now: NOW_IN, jev: "required", expect: { ...NEVER, jev_calls: 1 } },
  { id: "E-007", class: "E", title: "vague future timing", market: webMarket(), evidence: web("Aurora roadmap: the v2 upgrade is targeted for late Q4 pending audit sign-off. Validators should prepare their nodes; the activation block will be announced two weeks ahead."), now: NOW_IN, jev: "required", truth: "OPTION_B", expect: { ...NEVER, jev_calls: 1 } },
  { id: "E-008", class: "E", title: "testnet activation, not mainnet", market: webMarket(), evidence: web("Aurora v2 upgrade activated on the public testnet at 14:02 UTC on 2026-09-20. Mainnet activation remains scheduled and will be confirmed separately."), now: NOW_IN, jev: "required", truth: "OPTION_B", expect: { ...NEVER, jev_calls: 1 } },
];

export const cases: EvalCase[] = [
  ...base,
  ...base.map((c) => ({ ...c, id: c.id + "s", title: c.title + " (options swapped)", market: swapOptions(c.market), truth: c.truth ? (c.truth === "OPTION_A" ? "OPTION_B" as const : "OPTION_A" as const) : undefined })),
  { id: "E-100", class: "E", title: "prerelease tagged exactly v16.0.0 (structured, no Jev)", market: releaseMarket(), evidence: relApi(relList("v16.0.0", { prerelease: true })), now: NOW_IN, jev: "none", truth: "OPTION_B", expect: { status: "UNRESOLVED", caveats_include: ["disqualified_prerelease"], jev_calls: 0 } },
  { id: "E-101", class: "E", title: "draft release tagged v16.0.0 (structured, no Jev)", market: releaseMarket(), evidence: relApi(relList("v16.0.0", { draft: true })), now: NOW_IN, jev: "none", truth: "OPTION_B", expect: { status: "UNRESOLVED", caveats_include: ["disqualified_draft"], jev_calls: 0 } },
];

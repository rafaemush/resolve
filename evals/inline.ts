/**
 * The inline commit window (src/ingest/official-watch.ts inlineCommitDue; rail inline_commit_window): authored cases graded
 * by equality on whether the release-minute capture commits the holder's own leg in its own invocation. A first print
 * recorded more than INLINE_COMMIT_WINDOW_S (15 s) after release_at must not commit inline: its inline poll and the
 * deferred siblings might not finish inside waitUntil's 30 s after the response, so those legs are left to their next
 * minute poll. The end-to-end path
 * (the inline poll, the redispatch, the budget, the races) is tests/official-inline-commit.test.ts. No network.
 *   npx tsx evals/inline.ts     run the cases (exit 1 on any failure)
 * Group: window. evals/mutate.ts switches the rail off and requires the group to go red while the same group with every
 * rail on stays green; the control cases (a first print inside the window, one this capture did not insert, one stamped
 * before release_at) come out the same either way.
 */
import { inlineCommitDue } from "../src/ingest/official-watch";

export type InlineGroup = "window";
export interface InlineCase {
  id: string; group: InlineGroup; control: boolean; title: string;
  /** ms from release_at to the first print's observed_at, as official_observations records it. */
  afterMs: number; inserted?: boolean; ownCapture?: boolean;
  expect: { inline: boolean };
}
interface Outcome { id: string; group: InlineGroup; control: boolean; result: "pass" | "grader_fail" | "harness_error"; failures: string[] }
export interface InlineSummary { cases: number; passed: number; grader_fail: number; harness_error: number; skipped: number; outcomes: Outcome[]; label?: string }

/** The 2026-10-02 Employment Situation release, the one measured at +8 s observed and +61 s committed. */
const RELEASE = "2026-10-02T12:30:00.000Z";

const CASES: InlineCase[] = [
  // --- controls: the same with the rail on or off --------------------------------------------------------------------------
  { id: "IW-001", group: "window", control: true, title: "observed at +8 s (the 2026-10-02 first print): committed inline", afterMs: 8000, expect: { inline: true } },
  { id: "IW-002", group: "window", control: true, title: "observed at exactly +15 s: committed inline", afterMs: 15_000, expect: { inline: true } },
  { id: "IW-003", group: "window", control: true, title: "a first print another leg inserted first (this record answered inserted false): never inline", afterMs: 3000, inserted: false, expect: { inline: false } },
  { id: "IW-004", group: "window", control: true, title: "a row stamped before release_at: never inline", afterMs: -1, expect: { inline: false } },
  // --- red when the window is switched off ---------------------------------------------------------------------------------
  { id: "IW-101", group: "window", control: false, title: "observed at +15.001 s: left to the next poll", afterMs: 15_001, expect: { inline: false } },
  { id: "IW-102", group: "window", control: false, title: "observed at +20 s (a burst's fourth attempt and more): left to the next poll", afterMs: 20_000, expect: { inline: false } },
  { id: "IW-103", group: "window", control: false, title: "observed at +45 s, late in the release minute: left to the next poll", afterMs: 45_000, expect: { inline: false } },
];

function runCase(k: InlineCase): string[] {
  const rel = Date.parse(RELEASE);
  const got = inlineCommitDue({ inserted: k.inserted ?? true, ownCapture: k.ownCapture ?? true, observedAt: new Date(rel + k.afterMs).toISOString() }, rel);
  return got === k.expect.inline ? [] : [`expected ${k.expect.inline ? "an inline commit" : "no inline commit"} at ${k.afterMs} ms after release_at, got ${got ? "one" : "none"}`];
}

export async function runInlineSuite(opts: { groups?: string[] | null; quiet?: boolean; label?: string } = {}): Promise<InlineSummary> {
  const cases = opts.groups ? CASES.filter((k) => opts.groups!.includes(k.group)) : CASES;
  const outcomes: Outcome[] = [];
  for (const k of cases) {
    try {
      const failures = runCase(k);
      outcomes.push({ id: k.id, group: k.group, control: k.control, result: failures.length ? "grader_fail" : "pass", failures });
    } catch (e) {
      outcomes.push({ id: k.id, group: k.group, control: k.control, result: "harness_error", failures: [`exception: ${String(e).slice(0, 200)}`] });
    }
  }
  const s: InlineSummary = {
    cases: outcomes.length, passed: outcomes.filter((o) => o.result === "pass").length,
    grader_fail: outcomes.filter((o) => o.result === "grader_fail").length, harness_error: outcomes.filter((o) => o.result === "harness_error").length,
    skipped: 0, outcomes, label: opts.label,
  };
  if (!opts.quiet) {
    for (const o of outcomes) if (o.result !== "pass") console.log(`${o.result.toUpperCase().padEnd(13)} ${o.id.padEnd(8)} ${o.failures.join("; ")}`);
    console.log(`${opts.label ? `[${opts.label}] ` : ""}inline: cases=${s.cases} passed=${s.passed} grader_fail=${s.grader_fail} harness_error=${s.harness_error}`);
  }
  return s;
}

if (process.argv[1] && process.argv[1].endsWith("inline.ts")) {
  runInlineSuite().then((s) => process.exit(s.grader_fail || s.harness_error ? 1 : 0)).catch((e) => { console.error(String(e)); process.exit(1); });
}

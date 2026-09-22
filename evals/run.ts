/**
 * Failure-injection suite runner.
 *   pnpm eval --mode replay                 fixtures only; a missing fixture is a harness error
 *   pnpm eval --mode replay --skip-missing  (pre-key) report progress, misses are 'skipped'
 *   pnpm eval --mode live --max-cost-usd 0.05   real Jev calls, records fixtures, cost-capped
 *   --classes A,B,C   --report (POST to /internal/eval-report)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadEnv } from "../scripts/lib/env";
import { resolveMarket, JevUnavailableError, type JevCaller, type ResolveResult } from "../src/resolve";
import { thresholdsFromEnv } from "../src/resolve/thresholds";
import { makeJevCaller } from "../src/jev/client";
import { grade, isFalseResolved } from "./graders";
import type { EvalCase } from "./lib/cases";

const SPOTLIGHT_EVAL = "eval-spotlight-v1";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface RunOptions {
  mode: "replay" | "live";
  maxCostUsd: number;
  skipMissing: boolean;
  classes: string[] | null;
  report: boolean;
  quiet?: boolean;
  /** In-memory expectation override used by the grader self-test mutation. */
  mutateExpect?: (k: EvalCase) => EvalCase;
  label?: string;
  /** Mutation testing: a case that reaches Jev without a fixture gets a "fooled" answer favouring the positive option, so a removed rail shows up as a grader failure rather than a harness error. */
  mutationStub?: boolean;
}

function fooledAnswer(k: EvalCase, model: string) {
  const pos = k.market.positive_option, neg = pos === "OPTION_A" ? "OPTION_B" : "OPTION_A";
  return { model, answers: {
    outcome: { type: "choice", choice: pos, confidence: 0.93, probabilities: { [pos]: 0.95, [neg]: 0.03, NOT_DETERMINABLE: 0.02 } },
    same_subject: { type: "noul", noul: 0.96 }, states_fact_explicitly: { type: "noul", noul: 0.95 }, completed_not_planned: { type: "noul", noul: 0.94 },
    negated_or_reverted: { type: "noul", noul: 0.03 }, contradictory: { type: "noul", noul: 0.02 }, steering: { type: "noul", noul: 0.04 },
    authority: { type: "score", score: 3, confidence: 0.9 } }, usage: { input_tokens: 800, output_tokens: 40 } };
}
export interface CaseOutcome { id: string; class: string; result: "pass" | "grader_fail" | "harness_error" | "skipped"; failures: string[]; jevCalls: number; latencyMs: number | null; falseResolved: boolean; status: string; p?: number; y?: boolean }
export interface Summary {
  mode: string; suite_sha256: string; cases: number; passed: number; grader_fail: number; harness_error: number; skipped: number;
  false_resolved: number; recall_ab: number | null; brier: number | null; ece: number | null; calib_n: number; p50_ms: number | null; cost_usd: number; jev_calls: number;
  by_class: Record<string, { n: number; pass: number; fail: number; error: number; skipped: number }>; outcomes: CaseOutcome[]; label?: string;
}

export function loadCases(): { cases: EvalCase[]; suite: string } {
  const dir = resolve(process.cwd(), "evals/cases");
  const manifest = readFileSync(resolve(process.cwd(), "evals/manifest.sha256"), "utf8").trim().split("\n");
  const suite = manifest[manifest.length - 1]!.split("  ")[0]!;
  const cases: EvalCase[] = [];
  for (const line of manifest.slice(0, -1)) {
    const [h, f] = line.split("  ") as [string, string];
    const body = readFileSync(resolve(dir, f), "utf8");
    if (sha(body) !== h) throw new Error(`frozen file ${f} does not match manifest — run pnpm eval:build and commit`);
    for (const l of body.split("\n")) if (l.trim()) cases.push(JSON.parse(l) as EvalCase);
  }
  return { cases, suite };
}

function fixturePath(key: string) { return resolve(process.cwd(), "evals/fixtures", `${key}.json`); }

export async function runSuite(opts: RunOptions): Promise<Summary> {
  loadEnv();
  const { cases: all, suite } = loadCases();
  const cases = (opts.classes ? all.filter((c) => opts.classes!.includes(c.class)) : all).map((c) => (opts.mutateExpect ? opts.mutateExpect(c) : c));
  const th = thresholdsFromEnv(process.env as Record<string, string | undefined>);
  const model = process.env.JEV_MODEL ?? "jev-1.13.0";
  const price = Number(process.env.JEV_USD_PER_MTOK ?? "0.042");
  const live = makeJevCaller({ apiKey: process.env.TYPESAFE_API_KEY ?? "", timeoutMs: Number(process.env.JEV_TIMEOUT_MS ?? "4000") });
  let cost = 0, jevCallsTotal = 0;
  const outcomes: CaseOutcome[] = [];
  const latencies: number[] = [];
  mkdirSync(resolve(process.cwd(), "evals/fixtures"), { recursive: true });

  for (const k of cases) {
    let jevCalls = 0, harness: string | null = null, latency: number | null = null;
    const caller: JevCaller = async (req) => {
      jevCalls++;
      if (k.jev === "simulated") {
        switch (k.fault) {
          case "529": case "401": case "422": throw new JevUnavailableError(`HTTP ${k.fault} (simulated)`, "MODEL_UNAVAILABLE", Number(k.fault));
          case "timeout": throw new JevUnavailableError("timeout (simulated)", "MODEL_UNAVAILABLE");
          case "off_contract": return { json: { model, answers: { outcome: { type: "choice", choice: "YES" } } }, latencyMs: 5 };
          default: throw new JevUnavailableError("unexpected simulated fault", "MODEL_UNAVAILABLE");
        }
      }
      const key = sha(JSON.stringify(req));
      const fp = fixturePath(key);
      if (opts.mutationStub && !existsSync(fp)) return { json: fooledAnswer(k, model), latencyMs: 1 };
      if (k.jev === "none") { harness = "jev called on a jev=none case"; throw new JevUnavailableError("jev=none case reached Jev", "MODEL_UNAVAILABLE"); }
      if (opts.mode === "replay" || existsSync(fp)) {
        if (!existsSync(fp)) { harness = `fixture miss ${key.slice(0, 12)}`; throw new JevUnavailableError("fixture miss", "MODEL_UNAVAILABLE"); }
        const fx = JSON.parse(readFileSync(fp, "utf8")) as { response: unknown; latency_ms: number };
        latency = fx.latency_ms;
        return { json: fx.response, latencyMs: fx.latency_ms };
      }
      if (cost >= opts.maxCostUsd) { harness = `cost cap ${opts.maxCostUsd} reached`; throw new JevUnavailableError("cost cap", "BUDGET_EXCEEDED"); }
      const r = await live(req);
      const usage = (r.json as { usage?: { input_tokens?: number } }).usage;
      cost += ((usage?.input_tokens ?? 0) / 1e6) * price;
      latency = r.latencyMs;
      latencies.push(r.latencyMs);
      writeFileSync(fp, JSON.stringify({ key, case_id: k.id, model, recorded_at: new Date().toISOString(), latency_ms: r.latencyMs, request: req, response: r.json }, null, 1));
      return r;
    };
    let result: ResolveResult | null = null;
    try {
      result = await resolveMarket({
        marketId: k.id, market: k.market, evidence: k.evidence, thresholds: th, spotlightSecret: SPOTLIGHT_EVAL, model, now: new Date(k.now),
        jevBlocked: k.jev === "simulated" && (k.fault === "PAID_JEV_DISABLED" || k.fault === "BUDGET_EXCEEDED") ? k.fault : null,
      }, { jev: caller });
    } catch (e) { harness = `exception: ${String(e).slice(0, 160)}`; }
    jevCallsTotal += jevCalls;
    if (harness && harness.startsWith("fixture miss") && opts.skipMissing) { outcomes.push({ id: k.id, class: k.class, result: "skipped", failures: [harness], jevCalls, latencyMs: null, falseResolved: false, status: "-" }); continue; }
    if (harness || !result) { outcomes.push({ id: k.id, class: k.class, result: "harness_error", failures: [harness ?? "no result"], jevCalls, latencyMs: null, falseResolved: false, status: result?.verdict.resolution_status ?? "-" }); continue; }
    const failures = grade(k, result, jevCalls);
    const o: CaseOutcome = { id: k.id, class: k.class, result: failures.length ? "grader_fail" : "pass", failures, jevCalls, latencyMs: latency, falseResolved: isFalseResolved(k, result), status: result.verdict.resolution_status };
    if (k.truth && result.verdict.resolution_status !== "ERROR") {
      const probs = result.jev?.response?.answers.outcome.probabilities;
      if (probs) { const lead = (probs.OPTION_A ?? 0) >= (probs.OPTION_B ?? 0) ? "OPTION_A" : "OPTION_B"; o.p = Math.max(probs.OPTION_A ?? 0, probs.OPTION_B ?? 0); o.y = lead === k.truth; }
      else if (result.verdict.resolution_status === "RESOLVED") { o.p = result.verdict.confidence_score; o.y = result.verdict.winning_outcome === k.truth; }
    }
    outcomes.push(o);
  }

  const by: Summary["by_class"] = {};
  for (const o of outcomes) { const b = (by[o.class] ??= { n: 0, pass: 0, fail: 0, error: 0, skipped: 0 }); b.n++; if (o.result === "pass") b.pass++; else if (o.result === "grader_fail") b.fail++; else if (o.result === "harness_error") b.error++; else b.skipped++; }
  const ab = outcomes.filter((o) => (o.class === "A" || o.class === "B") && o.result !== "skipped");
  const calib = outcomes.filter((o) => o.p !== undefined && o.y !== undefined);
  let brier: number | null = null, ece: number | null = null;
  if (calib.length) {
    brier = calib.reduce((s, o) => s + (o.p! - (o.y ? 1 : 0)) ** 2, 0) / calib.length;
    const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
    for (const o of calib) { const b = bins[Math.min(9, Math.floor(o.p! * 10))]!; b.n++; b.p += o.p!; b.y += o.y ? 1 : 0; }
    ece = bins.reduce((s, b) => (b.n ? s + (b.n / calib.length) * Math.abs(b.p / b.n - b.y / b.n) : s), 0);
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const summary: Summary = {
    mode: opts.mode, suite_sha256: suite, cases: outcomes.length,
    passed: outcomes.filter((o) => o.result === "pass").length,
    grader_fail: outcomes.filter((o) => o.result === "grader_fail").length,
    harness_error: outcomes.filter((o) => o.result === "harness_error").length,
    skipped: outcomes.filter((o) => o.result === "skipped").length,
    false_resolved: outcomes.filter((o) => o.falseResolved).length,
    recall_ab: ab.length ? ab.filter((o) => o.result === "pass").length / ab.length : null,
    brier: brier === null ? null : Math.round(brier * 1e4) / 1e4, ece: ece === null ? null : Math.round(ece * 1e4) / 1e4, calib_n: calib.length,
    p50_ms: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null, cost_usd: Math.round(cost * 1e6) / 1e6, jev_calls: jevCallsTotal, by_class: by, outcomes, label: opts.label,
  };
  if (!opts.quiet) {
    for (const o of outcomes) if (o.result !== "pass") console.log(`${o.result.toUpperCase().padEnd(13)} ${o.id.padEnd(7)} ${o.failures.join("; ")}`);
    console.log(`\n${opts.label ? `[${opts.label}] ` : ""}${opts.mode}: cases=${summary.cases} passed=${summary.passed} grader_fail=${summary.grader_fail} harness_error=${summary.harness_error} skipped=${summary.skipped} false_resolved=${summary.false_resolved} recall_ab=${summary.recall_ab?.toFixed(3) ?? "n/a"} brier=${summary.brier ?? "n/a"} ece=${summary.ece ?? "n/a"} (n=${summary.calib_n}) p50_ms=${summary.p50_ms ?? "n/a"} cost=$${summary.cost_usd} jev_calls=${summary.jev_calls}`);
    console.log("by class: " + Object.entries(by).map(([c, b]) => `${c}=${b.pass}/${b.n}${b.error ? `!${b.error}` : ""}${b.skipped ? `~${b.skipped}` : ""}`).join(" "));
  }
  return summary;
}

async function main() {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const opts: RunOptions = { mode: (get("--mode") as "replay" | "live") ?? "replay", maxCostUsd: Number(get("--max-cost-usd") ?? process.env.EVAL_MAX_COST_USD ?? "0.05"), skipMissing: a.includes("--skip-missing"), classes: get("--classes")?.split(",") ?? null, report: a.includes("--report") };
  if (opts.mode === "live" && process.env.EVAL_LIVE !== "1") { console.error("live mode requires EVAL_LIVE=1 (spends money)"); process.exit(2); }
  const s = await runSuite(opts);
  mkdirSync(resolve(process.cwd(), "evals/reports"), { recursive: true });
  const rp = resolve(process.cwd(), "evals/reports", `${opts.mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(rp, JSON.stringify(s, null, 1));
  console.log("report:", rp);
  if (opts.report && process.env.RESOLVE_PUBLIC_URL && process.env.EVAL_REPORT_KEY) {
    const body = { suite_sha256: s.suite_sha256, git_sha: process.env.GITHUB_SHA ?? null, mode: s.mode, model: process.env.JEV_MODEL, cases: s.cases, passed: s.passed, false_resolved: s.false_resolved, recall: s.recall_ab, brier: s.brier, ece: s.ece, p50_ms: s.p50_ms, cost_usd: s.cost_usd, runner_region: process.env.EVAL_RUNNER_REGION ?? "unknown", grader_fail: s.grader_fail, harness_error: s.harness_error, meta: { by_class: s.by_class, skipped: s.skipped } };
    const r = await fetch(`${process.env.RESOLVE_PUBLIC_URL}/internal/eval-report`, { method: "POST", headers: { Authorization: `Bearer ${process.env.EVAL_REPORT_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    console.log("eval-report:", r.status, (await r.text()).slice(0, 200));
  }
  process.exit(s.grader_fail || s.harness_error || s.false_resolved ? 1 : 0);
}
if (process.argv[1] && process.argv[1].endsWith("run.ts")) main().catch((e) => { console.error(String(e)); process.exit(1); });

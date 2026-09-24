/**
 * The pure resolver wrapped with I/O: gates (paid-route flag, breaker, daily ceiling),
 * Jev accounting (jev_calls, jev_spend_daily, breaker updates) and the resolutions row.
 * The breaker opening, the ceiling refusing a Jev call and a gate or accounting write that failed are operator alerts:
 * each turns every Jev-routed verdict into "could not look" (or leaves spend unenforced) until someone acts.
 */
import type { Env, Config } from "../env";
import { db, rpc } from "../db/supabase";
import { resolveMarket, JevUnavailableError, type ResolveResult } from "./index";
import { thresholdsFromEnv } from "./thresholds";
import { makeJevCaller, jevCostUsd } from "../jev/client";
import type { EvidenceInput, MarketRegistration } from "./schema";
import { alertMany, type AlertItem } from "../ops/alerts";
import { redact } from "../ops/redact";

/** upstream_record_failure(): consecutive failed Jev calls that open the breaker, and how long it stays open. */
export const BREAKER_THRESHOLD = 5;
export const BREAKER_OPEN_SECONDS = 60;
export const JEV_ALERT_DEDUP_MINUTES = 60;

type RuntimeGate = "PAID_JEV_DISABLED" | "BUDGET_EXCEEDED" | "MODEL_UNAVAILABLE" | null;

export interface JevAlertInput {
  gate: RuntimeGate;
  route: ResolveResult["route"];
  /** check_gates failed: breaker and ceiling were not enforced. */
  gatesError: string | null;
  /** upstream_record_failure answered true: this failure opened the breaker. */
  breakerOpened: boolean;
  spendTodayUsd: number | null;
  ceilingUsd: number;
  lastJevError: string | null;
  /** jev_calls / record_jev_spend / breaker RPC failures after a call. */
  accountingErrors: string[];
}

/** Which operator alerts one resolution raises (pure; keys are stable for dedup). */
export function jevAlerts(i: JevAlertInput): AlertItem[] {
  const out: AlertItem[] = [];
  const item = (key: string, text: string, meta: Record<string, unknown> = {}) => out.push({ key, text, dedupMinutes: JEV_ALERT_DEDUP_MINUTES, meta });
  if (i.breakerOpened) item("jev_breaker_open", `Jev breaker opened after ${BREAKER_THRESHOLD} consecutive failed calls: every Jev-routed verdict answers MODEL_UNAVAILABLE (could not look) for ${BREAKER_OPEN_SECONDS} s, then calls resume and reopen it if they keep failing. Last error: ${i.lastJevError ?? "unknown"}`, { threshold: BREAKER_THRESHOLD, open_seconds: BREAKER_OPEN_SECONDS });
  // Only when the ceiling actually refused a Jev call: a structured verdict under the ceiling lost nothing.
  if (i.gate === "BUDGET_EXCEEDED" && i.route === "jev") item("jev_daily_ceiling", `Jev daily USD ceiling reached: $${i.spendTodayUsd?.toFixed(4) ?? "?"} spent of $${i.ceilingUsd.toFixed(2)} today (UTC). Jev-routed verdicts answer BUDGET_EXCEEDED (could not look) until 00:00 UTC or until JEV_DAILY_USD_CEILING is raised.`, { spend_today_usd: i.spendTodayUsd, ceiling_usd: i.ceilingUsd });
  if (i.gatesError && i.route === "jev") item("jev_gates_unreadable", `check_gates failed, so the Jev breaker and the daily USD ceiling were not enforced for a Jev-routed resolution: ${i.gatesError}`);
  if (i.accountingErrors.length) item("jev_accounting_failed", `Jev accounting write(s) failed after a call; spend (the daily ceiling) or breaker state is understated: ${i.accountingErrors.join("; ")}`);
  return out;
}

export interface RuntimeInput {
  marketId: string;
  market: MarketRegistration;
  evidence: EvidenceInput;
  evidenceId: string | null;
  mode: "tenant" | "shadow";
  tenantId: string | null;
  apiKeyId: string | null;
  /** Pre-created stub id from begin_resolution (tenant queries); null => a new row is inserted. */
  requestId: string | null;
  creditsCharged: number;
  now?: Date;
  /** Called right before Jev is used; may throw JevUnavailableError to refuse (e.g. bill-then-run for watch-driven tenant resolutions). */
  beforeJev?: () => Promise<void>;
}

export interface RuntimeOutput { result: ResolveResult; resolutionId: string; jevCalls: number; jevCostUsd: number }

export async function resolveWithRuntime(env: Env, cfg: Config, o: RuntimeInput): Promise<RuntimeOutput> {
  const client = db(env);
  const th = thresholdsFromEnv(env as unknown as Record<string, string | undefined>, cfg.thresholdsVersion);
  let jevBlocked: RuntimeGate = null;
  let gatesError: string | null = null;
  let spendTodayUsd: number | null = null;
  if (o.mode === "tenant" && !cfg.jevPaidRoutesEnabled) jevBlocked = "PAID_JEV_DISABLED";
  else {
    try {
      const g = await rpc<{ jev_breaker_open: boolean; jev_spend_today_usd: number | string }>(client, "check_gates", { p_keys: [], p_window_ms: [], p_limits: [] });
      spendTodayUsd = Number(g.jev_spend_today_usd);
      if (g.jev_breaker_open) jevBlocked = "MODEL_UNAVAILABLE";
      else if (spendTodayUsd >= cfg.jevDailyUsdCeiling) jevBlocked = "BUDGET_EXCEEDED";
    } catch (e) {
      // Unknown spend never blocks (the charge gate behind it is fail-closed); it is alerted when a Jev call follows.
      gatesError = redact(String(e)).slice(0, 200);
    }
  }
  const attempts: Array<{ status: number | null; latencyMs: number; inputTokens: number; outputTokens: number; error?: string }> = [];
  const live = makeJevCaller({ apiKey: env.TYPESAFE_API_KEY ?? "", timeoutMs: cfg.jevTimeoutMs, onAttempt: (i) => attempts.push(i) });
  const caller = async (req: Parameters<typeof live>[0]) => { if (o.beforeJev) await o.beforeJev(); return live(req); };

  const result = await resolveMarket({ marketId: o.marketId, market: o.market, evidence: o.evidence, thresholds: th, spotlightSecret: env.SPOTLIGHT_SECRET, model: cfg.jevModel, now: o.now, jevBlocked }, { jev: caller });

  const v = result.verdict;
  const resolutionId = o.requestId ?? crypto.randomUUID().replace(/-/g, "");
  const row = {
    tenant_id: o.tenantId, api_key_id: o.apiKeyId, market_id: o.marketId, evidence_id: o.evidenceId, mode: o.mode, status_row: "complete",
    resolution_status: v.resolution_status, winning_outcome: v.winning_outcome, confidence_score: v.confidence_score,
    error_code: v.error_code, error_reason: v.error_reason, caveats: v.caveats, determination_basis: v.determination_basis, checks: v.checks,
    jev_answers: result.jev?.response?.answers ?? null, jev_model: v.jev_model, thresholds_version: v.thresholds_version,
    credits_charged: o.creditsCharged, duration_ms: v.latency_ms, jev_ms: result.jev?.latencyMs ?? null, completed_at: new Date().toISOString(),
  };
  if (o.requestId) {
    const { error } = await client.from("resolutions").update(row).eq("id", o.requestId);
    if (error) throw new Error(`resolutions update: ${error.message}`);
  } else {
    const { error } = await client.from("resolutions").insert({ id: resolutionId, ...row });
    if (error) throw new Error(`resolutions insert: ${error.message}`);
  }

  let cost = 0;
  let breakerOpened = false;
  const accountingErrors: string[] = [];
  const failedStep = (step: string) => (e: unknown) => { accountingErrors.push(`${step}: ${redact(String(e)).slice(0, 160)}`); };
  if (attempts.length) {
    const rows = attempts.map((a) => {
      const c = jevCostUsd(result.jev?.response?.model ?? cfg.jevModel, cfg.jevModel, a.inputTokens, cfg.jevUsdPerMtok);
      cost += c;
      return { resolution_id: resolutionId, surface: o.mode === "shadow" ? "shadow" : "resolve", model: result.jev?.response?.model ?? cfg.jevModel, input_tokens: a.inputTokens, output_tokens: a.outputTokens, cost_usd: c, http_status: a.status, latency_ms: a.latencyMs, error: a.error ?? null };
    });
    const { error: callsError } = await client.from("jev_calls").insert(rows);
    if (callsError) accountingErrors.push(`jev_calls insert: ${redact(callsError.message).slice(0, 160)}`);
    const tokens = attempts.reduce((n, a) => n + a.inputTokens, 0);
    if (tokens > 0 || cost > 0) await rpc(client, "record_jev_spend", { p_input_tokens: tokens, p_usd: cost }).catch(failedStep("record_jev_spend"));
    const failed = result.jev?.error !== undefined && !(result.jev?.error?.includes("BUDGET") ?? false);
    if (failed) breakerOpened = (await rpc<boolean>(client, "upstream_record_failure", { p_name: "jev", p_threshold: BREAKER_THRESHOLD, p_open_seconds: BREAKER_OPEN_SECONDS }).catch(failedStep("upstream_record_failure"))) === true;
    else if (result.jev?.response) await rpc(client, "upstream_record_success", { p_name: "jev" }).catch(failedStep("upstream_record_success"));
  }
  const alerts = jevAlerts({
    gate: jevBlocked, route: result.route, gatesError, breakerOpened, spendTodayUsd, ceilingUsd: cfg.jevDailyUsdCeiling,
    lastJevError: result.jev?.error ? redact(result.jev.error).slice(0, 200) : null, accountingErrors,
  });
  if (alerts.length) await alertMany(env, alerts);
  return { result, resolutionId, jevCalls: attempts.length, jevCostUsd: cost };
}

export { JevUnavailableError };

/**
 * The pure resolver wrapped with I/O: gates (paid-route flag, breaker, daily ceiling),
 * Jev accounting (jev_calls, jev_spend_daily, breaker updates) and the resolutions row.
 */
import type { Env, Config } from "../env";
import { db, rpc } from "../db/supabase";
import { resolveMarket, JevUnavailableError, type ResolveResult } from "./index";
import { thresholdsFromEnv } from "./thresholds";
import { makeJevCaller, jevCostUsd } from "../jev/client";
import type { EvidenceInput, MarketRegistration } from "./schema";

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
  if (o.mode === "tenant" && !cfg.jevPaidRoutesEnabled) jevBlocked = "PAID_JEV_DISABLED";
  else {
    try {
      const g = await rpc<{ jev_breaker_open: boolean; jev_spend_today_usd: number | string }>(client, "check_gates", { p_keys: [], p_window_ms: [], p_limits: [] });
      if (g.jev_breaker_open) jevBlocked = "MODEL_UNAVAILABLE";
      else if (Number(g.jev_spend_today_usd) >= cfg.jevDailyUsdCeiling) jevBlocked = "BUDGET_EXCEEDED";
    } catch { /* unknown spend never blocks; the charge gate behind it is fail-closed */ }
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
  if (attempts.length) {
    const rows = attempts.map((a) => {
      const c = jevCostUsd(result.jev?.response?.model ?? cfg.jevModel, cfg.jevModel, a.inputTokens, cfg.jevUsdPerMtok);
      cost += c;
      return { resolution_id: resolutionId, surface: o.mode === "shadow" ? "shadow" : "resolve", model: result.jev?.response?.model ?? cfg.jevModel, input_tokens: a.inputTokens, output_tokens: a.outputTokens, cost_usd: c, http_status: a.status, latency_ms: a.latencyMs, error: a.error ?? null };
    });
    await client.from("jev_calls").insert(rows);
    const tokens = attempts.reduce((n, a) => n + a.inputTokens, 0);
    if (tokens > 0 || cost > 0) await rpc(client, "record_jev_spend", { p_input_tokens: tokens, p_usd: cost }).catch(() => undefined);
    const failed = result.jev?.error !== undefined && !(result.jev?.error?.includes("BUDGET") ?? false);
    if (failed) await rpc(client, "upstream_record_failure", { p_name: "jev", p_threshold: 5, p_open_seconds: 60 }).catch(() => undefined);
    else if (result.jev?.response) await rpc(client, "upstream_record_success", { p_name: "jev" }).catch(() => undefined);
  }
  return { result, resolutionId, jevCalls: attempts.length, jevCostUsd: cost };
}

type RuntimeGate = "PAID_JEV_DISABLED" | "BUDGET_EXCEEDED" | "MODEL_UNAVAILABLE" | null;
export { JevUnavailableError };

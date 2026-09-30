/**
 * The pure resolver wrapped with I/O: gates (paid-route flag, the tenant's plan, breaker, daily ceiling),
 * Jev accounting (jev_calls, jev_spend_daily, breaker updates) and the resolutions row.
 * The breaker opening, the ceiling refusing a Jev call and a gate or accounting write that failed are operator alerts:
 * each turns every Jev-routed verdict into "could not look" (or leaves spend unenforced) until someone acts.
 * The Jev accounting runs whether or not the resolutions row could be written: a call that was made is spend and
 * breaker state even when its verdict was lost. A lost verdict is alerted and thrown as ResolutionNotRecordedError, so
 * the caller refunds the charge instead of answering a verdict that does not exist.
 */
import type { Env, Config } from "../env";
import { db, rpc, type Db } from "../db/supabase";
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
  /**
   * tenants.plan of a tenant resolution when the caller already has it (POST /v1/resolve: the key's auth); omitted, the
   * runtime reads it. The free plan has structured verdicts only (docs/pricing.md, the evaluation key's page).
   */
  tenantPlan?: string;
  apiKeyId: string | null;
  /** Pre-created stub id from begin_resolution (tenant queries); null => a new row is inserted. */
  requestId: string | null;
  creditsCharged: number;
  now?: Date;
  /** Called right before Jev is used; may throw JevUnavailableError to refuse (e.g. bill-then-run for watch-driven tenant resolutions). */
  beforeJev?: () => Promise<void>;
}

export interface RuntimeOutput { result: ResolveResult; resolutionId: string; jevCalls: number; jevCostUsd: number }

/** No verdict row exists for this resolution (the write failed, or the resolver threw); already alerted. */
export class ResolutionNotRecordedError extends Error {
  constructor(message: string) { super(message); this.name = "ResolutionNotRecordedError"; }
}

/** The operator alert for a verdict that was computed (or attempted) and not recorded (pure). */
function notRecordedAlert(o: Pick<RuntimeInput, "tenantId" | "marketId" | "mode">, resolutionId: string, why: string, stub: string | null): AlertItem {
  return {
    key: "resolution_write_failed", dedupMinutes: JEV_ALERT_DEDUP_MINUTES,
    text: `A ${o.mode} resolution for market ${o.marketId}${o.tenantId ? ` (tenant ${o.tenantId})` : ""} was not recorded: ${why}. No verdict exists for request ${resolutionId}; the caller refunds its charge${stub ? `; ${stub}` : ""}.`,
    meta: { request_id: resolutionId, tenant_id: o.tenantId, market_id: o.marketId, mode: o.mode },
  };
}

/** Plans whose tenant resolutions may use web evidence while JEV_PAID_ROUTES_ENABLED is on. The free plan is not one. */
const WEB_EVIDENCE_PLANS = new Set(["payg", "builder", "growth", "platform"]);

/**
 * Whether a tenant resolution may use web evidence by its plan. The free plan's evaluation key is for structured
 * verdicts only, whatever JEV_PAID_ROUTES_ENABLED says, so a stranger's key from POST /v1/request-key never reaches the
 * model. Fail-closed: a plan that cannot be read is not a paid plan (the verdict is PAID_JEV_DISABLED, refunded).
 */
async function planAllowsWebEvidence(client: Db, o: RuntimeInput): Promise<boolean> {
  let plan = o.tenantPlan;
  if (plan === undefined && o.tenantId) {
    try {
      const { data, error } = await client.from("tenants").select("plan").eq("id", o.tenantId).maybeSingle();
      if (!error && typeof data?.plan === "string") plan = data.plan;
    } catch { /* unread: not a paid plan */ }
  }
  return plan !== undefined && WEB_EVIDENCE_PLANS.has(plan);
}

export async function resolveWithRuntime(env: Env, cfg: Config, o: RuntimeInput): Promise<RuntimeOutput> {
  const client = db(env);
  const th = thresholdsFromEnv(env as unknown as Record<string, string | undefined>, cfg.thresholdsVersion);
  let jevBlocked: RuntimeGate = null;
  let gatesError: string | null = null;
  let spendTodayUsd: number | null = null;
  if (o.mode === "tenant" && (!cfg.jevPaidRoutesEnabled || !(await planAllowsWebEvidence(client, o)))) jevBlocked = "PAID_JEV_DISABLED";
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

  const resolutionId = o.requestId ?? crypto.randomUUID().replace(/-/g, "");
  let result: ResolveResult | null = null;
  let notRecorded: string | null = null;
  try {
    result = await resolveMarket({ marketId: o.marketId, market: o.market, evidence: o.evidence, thresholds: th, spotlightSecret: env.SPOTLIGHT_SECRET, model: cfg.jevModel, now: o.now, jevBlocked }, { jev: caller });
    const v = result.verdict;
    const row = {
      tenant_id: o.tenantId, api_key_id: o.apiKeyId, market_id: o.marketId, evidence_id: o.evidenceId, mode: o.mode, status_row: "complete",
      resolution_status: v.resolution_status, winning_outcome: v.winning_outcome, confidence_score: v.confidence_score,
      error_code: v.error_code, error_reason: v.error_reason, caveats: v.caveats, determination_basis: v.determination_basis, checks: v.checks,
      jev_answers: result.jev?.response?.answers ?? null, jev_model: v.jev_model, thresholds_version: v.thresholds_version,
      credits_charged: o.creditsCharged, duration_ms: v.latency_ms, jev_ms: result.jev?.latencyMs ?? null, completed_at: new Date().toISOString(),
    };
    const { error } = o.requestId
      ? await client.from("resolutions").update(row).eq("id", o.requestId)
      : await client.from("resolutions").insert({ id: resolutionId, ...row });
    if (error) notRecorded = `resolutions ${o.requestId ? "update" : "insert"}: ${redact(error.message).slice(0, 200)}`;
  } catch (e) {
    notRecorded = `${result ? "resolutions write" : "resolver"} threw: ${redact(String(e)).slice(0, 200)}`;
  }

  // A stub left 'pending' makes every replay of its Idempotency-Key answer "still in flight"; 'failed' is the truth.
  let stub: string | null = null;
  if (notRecorded && o.requestId) {
    try {
      const { error } = await client.from("resolutions").update({ status_row: "failed", completed_at: new Date().toISOString() }).eq("id", o.requestId).eq("status_row", "pending");
      stub = error ? `the pending stub could not be marked failed either (${redact(error.message).slice(0, 120)}), so replays of its Idempotency-Key answer 202 until it is` : "the stub is marked failed";
    } catch (e) {
      stub = `marking the stub failed threw (${redact(String(e)).slice(0, 120)})`;
    }
  }

  let cost = 0;
  let breakerOpened = false;
  const accountingErrors: string[] = [];
  const failedStep = (step: string) => (e: unknown) => { accountingErrors.push(`${step}: ${redact(String(e)).slice(0, 160)}`); };
  if (attempts.length) {
    const model = result?.jev?.response?.model ?? cfg.jevModel;
    // jev_calls.resolution_id references resolutions(id): no row was inserted when the insert itself failed.
    const callsResolutionId = notRecorded && !o.requestId ? null : resolutionId;
    const rows = attempts.map((a) => {
      const c = jevCostUsd(model, cfg.jevModel, a.inputTokens, cfg.jevUsdPerMtok);
      cost += c;
      return { resolution_id: callsResolutionId, surface: o.mode === "shadow" ? "shadow" : "resolve", model, input_tokens: a.inputTokens, output_tokens: a.outputTokens, cost_usd: c, http_status: a.status, latency_ms: a.latencyMs, error: a.error ?? null };
    });
    const { error: callsError } = await client.from("jev_calls").insert(rows);
    if (callsError) accountingErrors.push(`jev_calls insert: ${redact(callsError.message).slice(0, 160)}`);
    const tokens = attempts.reduce((n, a) => n + a.inputTokens, 0);
    if (tokens > 0 || cost > 0) await rpc(client, "record_jev_spend", { p_input_tokens: tokens, p_usd: cost }).catch(failedStep("record_jev_spend"));
    // Without a result (the resolver threw) the last attempt says how the call went.
    const failed = result ? result.jev?.error !== undefined && !result.jev.error.includes("BUDGET") : attempts.at(-1)?.error !== undefined;
    const succeeded = result ? !!result.jev?.response : !failed;
    if (failed) breakerOpened = (await rpc<boolean>(client, "upstream_record_failure", { p_name: "jev", p_threshold: BREAKER_THRESHOLD, p_open_seconds: BREAKER_OPEN_SECONDS }).catch(failedStep("upstream_record_failure"))) === true;
    else if (succeeded) await rpc(client, "upstream_record_success", { p_name: "jev" }).catch(failedStep("upstream_record_success"));
  }
  const alerts = jevAlerts({
    gate: jevBlocked, route: result?.route ?? (attempts.length ? "jev" : "precheck"), gatesError, breakerOpened, spendTodayUsd, ceilingUsd: cfg.jevDailyUsdCeiling,
    lastJevError: result?.jev?.error ? redact(result.jev.error).slice(0, 200) : (attempts.at(-1)?.error ? redact(attempts.at(-1)!.error!).slice(0, 200) : null), accountingErrors,
  });
  if (notRecorded) alerts.push(notRecordedAlert(o, resolutionId, notRecorded, stub));
  if (alerts.length) await alertMany(env, alerts);
  if (notRecorded || !result) throw new ResolutionNotRecordedError(`request ${resolutionId}: ${notRecorded ?? "no result"}`);
  return { result, resolutionId, jevCalls: attempts.length, jevCostUsd: cost };
}

export { JevUnavailableError };

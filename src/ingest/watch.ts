/** One watch poll = one Worker invocation: fetch -> change detection -> (store + resolve) -> bookkeeping -> loop_runs. */
import type { Env, Config } from "../env";
import { db, rpc } from "../db/supabase";
import { fetchGithub } from "./github";
import { fetchBaseLogs } from "./base";
import { fetchSolanaSignatures } from "./solana";
import { fetchWeb } from "./web";
import { projectForChange } from "./projection";
import { appendWindow, summarizeCoverage, type WatchRow, type MarketRow, type FetchOutcome, type CoverageWindow } from "./types";
import { canonicalize, sha256Hex } from "../resolve/text";
import { railEnabled } from "../resolve/rails";
import { resolveWithRuntime, JevUnavailableError } from "../resolve/runtime";
import type { EvidenceInput } from "../resolve/schema";
import { commitVerdict } from "../bot/commit";
import { enqueueEvent } from "../webhooks/deliver";
import { alert } from "../ops/alerts";

export interface WatchRunSummary { watch_id: string; outcome: "success" | "no_op" | "failure" | "skipped"; rows_written: number; detail: string; verdict?: string; resolution_id?: string }

// ---- pure decisions (unit-tested in tests/watch-decision.test.ts) -------------------------------------------

export type WatchAction =
  | { store: true; reason: "first_observation" | "changed" | "post_deadline_observation" }
  | { store: false; reason: "unchanged" };

export interface WatchActionInput {
  /** sha256 of projectForChange(...) (raw bytes when the stable_projection rail is off). */
  changeSha: string;
  lastCanonicalHash: string | null | undefined;
  /** now > deadline + grace */
  afterDeadline: boolean;
  /** A complete resolution exists for the market created after deadline + grace. Only read when needsDeadlineLookup. */
  resolvedSinceDeadline: boolean;
}

/** The unchanged-after-deadline branch is the only one that needs the resolutions lookup; skip the query otherwise. */
export function needsDeadlineLookup(i: Pick<WatchActionInput, "changeSha" | "lastCanonicalHash" | "afterDeadline">): boolean {
  return i.afterDeadline && !!i.lastCanonicalHash && i.changeSha === i.lastCanonicalHash;
}

/**
 * Store evidence and resolve only when the projection changed, or once after deadline + grace so the absence
 * proof has a post-deadline observation (stored even though the projection is unchanged). Everything else is a
 * no_op: coverage/cursor/etag advance, no evidence row, no R2 object, no resolution.
 */
export function decideWatchAction(i: WatchActionInput): WatchAction {
  if (!i.lastCanonicalHash) return { store: true, reason: "first_observation" };
  if (i.changeSha !== i.lastCanonicalHash) return { store: true, reason: "changed" };
  if (i.afterDeadline && !i.resolvedSinceDeadline) return { store: true, reason: "post_deadline_observation" };
  return { store: false, reason: "unchanged" };
}

export const ERROR_STREAK_ALERT = 3;
const httpOk = (s: number | null | undefined) => s === 200 || s === 304;

export interface FailureInput {
  prevErrors: number;
  prevHttpStatus: number | null | undefined;
  /** Status of the HTTP answer behind this failure; undefined for transport, RPC and internal failures. */
  httpStatus?: number;
}
export interface FailureDecision { consecutiveErrors: number; alertHttp: boolean; alertStreak: boolean }

/**
 * A failed poll: the streak grows; alert once when a source that last answered OK (200, or 304 on a conditional
 * GET) starts failing at the HTTP level, and once when the streak reaches ERROR_STREAK_ALERT.
 */
export function decideFailure(i: FailureInput): FailureDecision {
  const consecutiveErrors = Math.max(0, i.prevErrors) + 1;
  return {
    consecutiveErrors,
    alertHttp: i.httpStatus !== undefined && httpOk(i.prevHttpStatus) && i.prevErrors === 0,
    alertStreak: consecutiveErrors === ERROR_STREAK_ALERT,
  };
}

/** next_poll_at when the source asked us to wait: only ever pushed later than the leased schedule, never earlier. */
export function deferredNextPoll(nowMs: number, deferSeconds: number | undefined, scheduledIso: string | undefined): string | undefined {
  if (deferSeconds === undefined || deferSeconds <= 0) return undefined;
  const until = nowMs + deferSeconds * 1000;
  const scheduled = scheduledIso ? Date.parse(scheduledIso) : NaN;
  return Number.isFinite(scheduled) && scheduled >= until ? undefined : new Date(until).toISOString();
}

// ---- the poll -------------------------------------------------------------------------------------------

/** alert() never throws; the guard keeps it that way for the watch run whatever alert() becomes. */
async function safeAlert(env: Env, key: string, text: string, dedupMinutes: number, meta: Record<string, unknown>): Promise<void> {
  try { await alert(env, key, text, { dedupMinutes, meta }); }
  catch (e) { console.error(JSON.stringify({ level: "error", job: "watch_alert", key, error: String(e).slice(0, 200) })); }
}

export async function runWatch(env: Env, cfg: Config, watchId: string): Promise<WatchRunSummary> {
  const started = Date.now();
  const client = db(env);
  const summary: WatchRunSummary = { watch_id: watchId, outcome: "skipped", rows_written: 0, detail: "" };
  const finish = async (s: WatchRunSummary, meta: Record<string, unknown> = {}) => {
    await client.from("loop_runs").insert({ loop_name: "watch", outcome: s.outcome, rows_written: s.rows_written, duration_ms: Date.now() - started, error: s.outcome === "failure" ? s.detail.slice(0, 500) : null, meta: { watch_id: watchId, ...meta, verdict: s.verdict ?? null, detail: s.detail.slice(0, 200) } });
    return s;
  };
  const { data: w, error } = await client.from("watches").select("*, markets(*)").eq("id", watchId).single();
  if (error || !w) { summary.outcome = "failure"; summary.detail = `watch load: ${error?.message ?? "not found"}`; return finish(summary); }
  const watch = w as unknown as WatchRow;
  const market = watch.markets as MarketRow;
  if (!watch.active || !market || market.status !== "open") { summary.detail = `inactive watch or market status ${market?.status}`; await client.from("watches").update({ lease_until: null, last_polled_at: new Date().toISOString() }).eq("id", watchId); return finish(summary); }

  const deadlineGrace = new Date(Date.parse(market.deadline_utc) + market.grace_seconds * 1000);
  const afterDeadline = Date.now() > deadlineGrace.getTime();
  if (afterDeadline) watch.etag = null; // always take a full post-deadline snapshot (absence proof needs an observation, not a 304)
  const resolverKind = market.resolver?.kind;

  let out: FetchOutcome;
  switch (watch.source_kind) {
    case "github_api": case "github_events": out = await fetchGithub(env, watch, resolverKind, cfg.botUa); break;
    case "base_log": out = await fetchBaseLogs(env, watch); break;
    case "solana_log": out = await fetchSolanaSignatures(env, watch); break;
    case "web_fetch": out = await fetchWeb(env, watch, cfg.botUa); break;
    default: out = { error: `${watch.source_kind} not implemented yet` };
  }
  const nowIso = new Date().toISOString();
  const window: CoverageWindow = out.window ?? { from: String(watch.cursor.last_to ?? watch.cursor.to_ts ?? nowIso), to: nowIso, status: out.error ? "gap" : "ok" };
  const coverage = appendWindow(watch.coverage ?? [], window);
  const meta = { market_id: market.id, source_kind: watch.source_kind, platform: market.platform };
  const alertMeta = { watch_id: watchId, ...meta, external_id: market.external_id };

  const update: Record<string, unknown> = { lease_until: null, last_polled_at: nowIso, coverage, cursor: out.cursor ?? watch.cursor, backlog: out.backlog ?? false };
  if (out.etag !== undefined) update.etag = out.etag;
  if (out.httpStatus !== undefined) update.last_http_status = out.httpStatus;
  const deferred = deferredNextPoll(Date.now(), out.deferSeconds, watch.next_poll_at);
  if (deferred) update.next_poll_at = deferred;

  const save = async (): Promise<string | null> => {
    const { error: ue } = await client.from("watches").update(update).eq("id", watchId);
    return ue ? `watch update: ${ue.message}` : null;
  };
  /** Every failing path: streak + alerts + bookkeeping. The hashes are not advanced, so the next poll retries. */
  const fail = async (detail: string, httpStatus?: number): Promise<WatchRunSummary> => {
    const d = decideFailure({ prevErrors: watch.consecutive_errors ?? 0, prevHttpStatus: watch.last_http_status, httpStatus });
    update.consecutive_errors = d.consecutiveErrors; update.last_error = detail.slice(0, 500);
    const ue = await save();
    summary.outcome = "failure"; summary.detail = ue ? `${detail} | ${ue}` : detail;
    const where = `watch ${watchId} (${watch.source_kind}) for ${market.platform}:${market.external_id}`;
    if (d.alertHttp) await safeAlert(env, `watch_http_${watchId}`, `${where}: HTTP ${watch.last_http_status} -> ${httpStatus}. ${detail}`, 360, alertMeta);
    if (d.alertStreak) await safeAlert(env, `watch_errors_${watchId}`, `${where} failed ${d.consecutiveErrors} polls in a row. Last: ${detail}`, 360, alertMeta);
    return finish(summary, meta);
  };

  // With the non200_never_evidence rail on, every fetch error arrives here without evidence.
  if (out.error && !out.evidence) return fail(out.error, out.httpStatus);
  if (out.notModified) {
    update.consecutive_errors = 0; update.last_error = null;
    const ue = await save();
    summary.outcome = ue ? "failure" : "no_op"; summary.detail = ue ?? "not modified";
    return finish(summary, meta);
  }

  const ev = out.evidence!;
  const rawBytes = out.rawBytes ?? new TextEncoder().encode(ev.text ?? "");
  const rawSha = await sha256Hex(rawBytes);
  const changeSha = railEnabled("stable_projection") ? await sha256Hex(projectForChange(watch.source_kind, resolverKind, ev)) : rawSha;
  let resolvedSinceDeadline = false;
  if (needsDeadlineLookup({ changeSha, lastCanonicalHash: watch.last_canonical_hash, afterDeadline })) {
    // A failed lookup reads as "not resolved": one extra post-deadline resolution is better than never taking one.
    const { count, error: ce } = await client.from("resolutions").select("id", { count: "exact", head: true }).eq("market_id", market.id).gte("created_at", deadlineGrace.toISOString()).eq("status_row", "complete");
    resolvedSinceDeadline = !ce && (count ?? 0) > 0;
  }
  const action = decideWatchAction({ changeSha, lastCanonicalHash: watch.last_canonical_hash, afterDeadline, resolvedSinceDeadline });
  if (!action.store) {
    update.consecutive_errors = 0; update.last_error = null;
    const ue = await save();
    summary.outcome = ue ? "failure" : "no_op"; summary.detail = ue ?? `unchanged projection ${changeSha.slice(0, 12)}`;
    return finish(summary, meta);
  }

  const canon = canonicalize(ev.text ?? (ev.structured !== undefined ? JSON.stringify(ev.structured) : ""));
  const canonicalSha = await sha256Hex(canon.text);
  const cov = summarizeCoverage(coverage, market.open_at, deadlineGrace.toISOString());
  ev.coverage = { ...(ev.coverage ?? {}), contiguous: cov.contiguous, from: cov.from, to: cov.to, errors: cov.errors };

  // R2 first: an evidence row may only name an object that exists.
  const key = `raw/${rawSha}`;
  let r2Error: string | null = null;
  try { await env.RAW.put(key, rawBytes, { httpMetadata: { contentType: ev.source_kind.startsWith("web") ? "text/plain" : "application/json" } }); }
  catch (e) {
    r2Error = String(e).slice(0, 200);
    await safeAlert(env, "r2_put_failed", `R2 put ${key} failed for watch ${watchId}; evidence is stored without raw_r2_key. ${r2Error}`, 60, alertMeta);
  }
  let evidenceId: string | null = null;
  let rows = 0;
  const { data: er, error: ee } = await client.from("evidence").insert({
    market_id: market.id, watch_id: watchId, source_kind: ev.source_kind, source_url: ev.source_url ?? null,
    // web sources: observed_at is OUR fetch time; a page's own timestamp is display-only (claimed_at)
    observed_at: ev.source_kind.startsWith("web") ? ev.fetched_at : (ev.observed_at ?? ev.fetched_at), claimed_at: ev.source_kind.startsWith("web") ? (ev.observed_at ?? null) : null,
    fetched_at: ev.fetched_at, http_status: ev.http_status ?? null, etag: ev.etag ?? null, raw_sha256: rawSha, canonical_sha256: canonicalSha, raw_bytes: rawBytes.byteLength, raw_r2_key: r2Error ? null : key,
    excerpt: (ev.text ?? "").slice(0, 16384), provenance: ev.provenance ?? {}, coverage: ev.coverage,
  }).select("id").single();
  if (ee) {
    if (ee.code !== "23505") return fail(`evidence insert: ${ee.message}`);
    // identical bytes were stored before (e.g. a post-deadline snapshot of an unchanged page): reuse that row
    const { data: ex } = await client.from("evidence").select("id").eq("market_id", market.id).eq("raw_sha256", rawSha).maybeSingle();
    evidenceId = (ex?.id as string) ?? null;
  } else { evidenceId = er?.id as string; rows++; }

  const mode = market.tenant_id ? "tenant" : "shadow";
  let charged = 0;
  const beforeJev = market.tenant_id ? async () => {
    type BR = { request_id: string; ok: boolean; charged: number };
    const r = await rpc<BR[] | BR>(client, "begin_resolution", { p_tenant: market.tenant_id, p_api_key: null, p_idempotency_key: null, p_amount: 5, p_market: market.id, p_mode: "tenant" });
    const row: BR | undefined = Array.isArray(r) ? r[0] : r;
    if (!row || !row.ok) throw new JevUnavailableError("insufficient credits for a Jev-backed watch resolution", "BUDGET_EXCEEDED");
    charged = row.charged;
    // the stub row is superseded by the runtime insert; mark it complete-failed to keep the ledger reference
    await client.from("resolutions").update({ status_row: "failed", caveats: ["superseded_by_watch_resolution"] }).eq("id", row.request_id);
  } : undefined;
  try {
    const evInput: EvidenceInput = { ...ev }; // precheck treats a web observed_at as claimed_at and uses fetched_at
    const rt = await resolveWithRuntime(env, cfg, { marketId: market.id, market, evidence: evInput, evidenceId, mode, tenantId: market.tenant_id, apiKeyId: null, requestId: null, creditsCharged: charged, beforeJev });
    rows++;
    summary.verdict = `${rt.result.verdict.resolution_status}/${rt.result.verdict.winning_outcome}${rt.result.verdict.error_reason ? "/" + rt.result.verdict.error_reason : ""}`;
    summary.resolution_id = rt.resolutionId;
    if (evidenceId) await client.from("evidence").update({ windows: rt.result.pre.windows, injection_markers: rt.result.pre.markers }).eq("id", evidenceId);
    const v = rt.result.verdict;
    if (mode === "shadow") {
      const cm = await commitVerdict(env, market, rt.resolutionId, v);
      summary.detail += ` | commit: ${cm.reason}`;
    } else if (market.tenant_id) {
      const type = v.resolution_status === "RESOLVED" ? "market.resolved" : v.resolution_status === "ERROR" ? "market.error" : "market.unresolved_update";
      await enqueueEvent(env, market.tenant_id, type, { market_id: market.id, external_id: market.external_id, request_id: rt.resolutionId, verdict: v });
    }
  } catch (e) {
    return fail(`resolve: ${String(e).slice(0, 300)}`);
  }
  update.consecutive_errors = 0; update.last_error = null; update.last_evidence_hash = rawSha; update.last_canonical_hash = changeSha;
  if (out.backlog && !deferred) update.next_poll_at = new Date(Date.now() + 5000).toISOString();
  const ue = await save();
  const stored = `${action.reason} ${changeSha.slice(0, 12)}${summary.detail}`;
  summary.rows_written = rows;
  if (r2Error || ue) {
    summary.outcome = "failure";
    summary.detail = [r2Error ? `r2 put failed (evidence ${evidenceId ?? "?"} stored without raw_r2_key): ${r2Error}` : null, ue, stored].filter(Boolean).join(" | ");
  } else {
    summary.outcome = rows > 0 ? "success" : "no_op"; summary.detail = stored;
  }
  return finish(summary, meta);
}

/** One watch poll = one Worker invocation: fetch -> evidence -> (resolve) -> bookkeeping -> loop_runs. */
import type { Env, Config } from "../env";
import { db, rpc } from "../db/supabase";
import { fetchGithub } from "./github";
import { fetchBaseLogs } from "./base";
import { fetchSolanaSignatures } from "./solana";
import { fetchWeb } from "./web";
import { appendWindow, summarizeCoverage, type WatchRow, type MarketRow, type FetchOutcome, type CoverageWindow } from "./types";
import { canonicalize, sha256Hex } from "../resolve/text";
import { resolveWithRuntime, JevUnavailableError } from "../resolve/runtime";
import type { EvidenceInput } from "../resolve/schema";
import { commitVerdict } from "../bot/commit";
import { enqueueEvent } from "../webhooks/deliver";

export interface WatchRunSummary { watch_id: string; outcome: "success" | "no_op" | "failure" | "skipped"; rows_written: number; detail: string; verdict?: string; resolution_id?: string }

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

  const update: Record<string, unknown> = { lease_until: null, last_polled_at: nowIso, coverage, cursor: out.cursor ?? watch.cursor, backlog: out.backlog ?? false };
  if (out.etag !== undefined) update.etag = out.etag;

  if (out.error && !out.evidence) {
    update.consecutive_errors = (watch.consecutive_errors ?? 0) + 1; update.last_error = out.error.slice(0, 500);
    await client.from("watches").update(update).eq("id", watchId);
    summary.outcome = "failure"; summary.detail = out.error;
    return finish(summary, meta);
  }
  if (out.notModified) {
    update.consecutive_errors = 0; update.last_error = null;
    await client.from("watches").update(update).eq("id", watchId);
    summary.outcome = "no_op"; summary.detail = "not modified";
    return finish(summary, meta);
  }

  const ev = out.evidence!;
  const rawBytes = out.rawBytes ?? new TextEncoder().encode(ev.text ?? "");
  const rawSha = await sha256Hex(rawBytes);
  const canon = canonicalize(ev.text ?? (ev.structured !== undefined ? JSON.stringify(ev.structured) : ""));
  const canonicalSha = await sha256Hex(canon.text);
  const cov = summarizeCoverage(coverage, market.open_at, deadlineGrace.toISOString());
  ev.coverage = { ...(ev.coverage ?? {}), contiguous: cov.contiguous, from: cov.from, to: cov.to, errors: cov.errors };

  let evidenceId: string | null = null;
  let rows = 0;
  const sameAsLast = watch.last_evidence_hash === rawSha;
  if (!sameAsLast) {
    const key = `raw/${rawSha}`;
    try { await env.RAW.put(key, rawBytes, { httpMetadata: { contentType: ev.source_kind.startsWith("web") ? "text/plain" : "application/json" } }); } catch (e) { console.error("r2 put failed", String(e)); }
    const { data: er, error: ee } = await client.from("evidence").insert({
      market_id: market.id, watch_id: watchId, source_kind: ev.source_kind, source_url: ev.source_url ?? null,
      // web sources: observed_at is OUR fetch time; a page's own timestamp is display-only (claimed_at)
      observed_at: ev.source_kind.startsWith("web") ? ev.fetched_at : (ev.observed_at ?? ev.fetched_at), claimed_at: ev.source_kind.startsWith("web") ? (ev.observed_at ?? null) : null,
      fetched_at: ev.fetched_at, http_status: ev.http_status ?? null, etag: ev.etag ?? null, raw_sha256: rawSha, canonical_sha256: canonicalSha, raw_bytes: rawBytes.byteLength, raw_r2_key: key,
      excerpt: (ev.text ?? "").slice(0, 16384), provenance: ev.provenance ?? {}, coverage: ev.coverage,
    }).select("id").single();
    if (ee) {
      if (ee.code === "23505") { const { data: ex } = await client.from("evidence").select("id").eq("market_id", market.id).eq("raw_sha256", rawSha).single(); evidenceId = (ex?.id as string) ?? null; }
      else { summary.outcome = "failure"; summary.detail = `evidence insert: ${ee.message}`; await client.from("watches").update(update).eq("id", watchId); return finish(summary, meta); }
    } else { evidenceId = er?.id as string; rows++; }
  } else {
    const { data: ex } = await client.from("evidence").select("id").eq("market_id", market.id).eq("raw_sha256", rawSha).order("created_at", { ascending: false }).limit(1).maybeSingle();
    evidenceId = (ex?.id as string) ?? null;
  }

  // Resolve when the evidence changed, or when a post-deadline observation is needed for the absence proof.
  let needResolve = !sameAsLast;
  if (!needResolve && afterDeadline) {
    const { count } = await client.from("resolutions").select("id", { count: "exact", head: true }).eq("market_id", market.id).gte("created_at", deadlineGrace.toISOString()).eq("status_row", "complete");
    needResolve = (count ?? 0) === 0;
  }
  if (needResolve) {
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
      summary.outcome = "failure"; summary.detail = `resolve: ${String(e).slice(0, 300)}`;
      update.consecutive_errors = (watch.consecutive_errors ?? 0) + 1; update.last_error = summary.detail;
      await client.from("watches").update(update).eq("id", watchId);
      return finish(summary, meta);
    }
  }
  update.consecutive_errors = 0; update.last_error = null; update.last_evidence_hash = rawSha;
  if (out.backlog) update.next_poll_at = new Date(Date.now() + 5000).toISOString();
  await client.from("watches").update(update).eq("id", watchId);
  summary.outcome = rows > 0 ? "success" : "no_op"; summary.rows_written = rows; summary.detail = sameAsLast ? "unchanged evidence" : `new evidence ${rawSha.slice(0, 12)}`;
  return finish(summary, meta);
}

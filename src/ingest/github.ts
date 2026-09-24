import type { Env } from "../env";
import type { WatchRow, FetchOutcome } from "./types";
import { railEnabled } from "../resolve/rails";
import { clampDefer, discardBody, maxDefer, retryAfterSeconds } from "./http";

const API = "https://api.github.com";

function decidingFieldPresent(kind: string | undefined, json: unknown): boolean {
  if (Array.isArray(json)) return true; // release list
  const o = (json ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "github_pr_merged": return "merged_at" in o && "state" in o;
    case "github_issue_closed": return "state" in o;
    default: return typeof json === "object" && json !== null;
  }
}

/**
 * How long GitHub asked us to wait, in seconds (capped): Retry-After (secondary rate limits),
 * the primary-limit reset when X-RateLimit-Remaining is 0, and X-Poll-Interval (events API).
 * The largest wins. Read on every answer: a 200 with remaining=0 means the next poll would be a 403.
 */
export function githubDeferSeconds(headers: Headers, nowMs: number): number | undefined {
  const retry = retryAfterSeconds(headers, nowMs);
  let reset: number | undefined;
  if (headers.get("x-ratelimit-remaining")?.trim() === "0") {
    const r = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(r) && r > 0) reset = clampDefer(r - nowMs / 1000);
  }
  const pi = headers.get("x-poll-interval");
  const poll = pi && /^\d+$/.test(pi.trim()) ? clampDefer(Number(pi)) : undefined;
  return maxDefer(retry, reset, poll);
}

/** GitHub's error JSON carries a short `message`; anything else (HTML 5xx pages) is not worth storing. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const j = JSON.parse(await res.text()) as { message?: unknown };
    return typeof j.message === "string" ? j.message.slice(0, 160) : "";
  } catch { return ""; }
}

/**
 * Conditional GET of a GitHub REST resource named by source_ref.ref ("repos/o/r/pulls/1", "repos/o/r/releases", ...).
 * Only a 200 from the registered URL is evidence. Any other status, and any redirect (a renamed or transferred
 * repo answers from a different URL, so the subject may have changed), is a coverage gap with no evidence:
 * a rate-limit page must never reach the resolver (§16.2: 28 HTTP 403 bodies became ERROR/NO_ANCHOR verdicts).
 */
export async function fetchGithub(env: Env, watch: WatchRow, resolverKind: string | undefined, botUa: string): Promise<FetchOutcome> {
  const ref = String(watch.source_ref.ref ?? "").replace(/^\/+/, "");
  if (!ref) return { error: "source_ref.ref missing" };
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": botUa, "X-GitHub-Api-Version": "2022-11-28" };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  if (watch.etag) headers["If-None-Match"] = watch.etag;
  const t0 = new Date();
  let res: Response;
  try { res = await fetch(`${API}/${ref}`, { headers, signal: AbortSignal.timeout(8000) }); }
  catch (e) { return { error: `github fetch failed: ${String(e).slice(0, 120)}` }; }
  const now = new Date().toISOString();
  const serverDate = res.headers.get("date");
  const observed = serverDate ? new Date(serverDate).toISOString() : now;
  const windowFrom = String(watch.cursor.last_to ?? observed);
  const status = res.status;
  const deferSeconds = githubDeferSeconds(res.headers, Date.now());
  const answered = { httpStatus: status, ...(deferSeconds !== undefined ? { deferSeconds } : {}) };
  const cursor = { ...watch.cursor, last_to: observed };
  const gap = (error: string): FetchOutcome => ({ error, window: { from: windowFrom, to: observed, status: "gap" }, cursor, ...answered });
  const strict = railEnabled("non200_never_evidence");

  if (strict && res.redirected) { await discardBody(res); return gap(`github ${ref} redirected to ${res.url} (repo renamed or transferred?)`); }
  if (status === 304) return { notModified: true, etag: watch.etag, window: { from: windowFrom, to: observed, status: "ok" }, cursor, ...answered };
  if (strict && status !== 200) { const msg = await errorMessage(res); return gap(`github ${status} for ${ref}${msg ? `: ${msg}` : ""}`); }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  const etag = res.headers.get("etag");
  if (status !== 200) {
    // Reached only with the non200_never_evidence rail off (mutation harness): the pre-P1a behaviour.
    return {
      error: `github ${status} for ${ref}`,
      evidence: { source_kind: "github_api", source_url: `${API}/${ref}`, text: text.slice(0, 4000), structured: json ?? undefined, observed_at: observed, fetched_at: t0.toISOString(), http_status: status, coverage: { snapshot_status: status, deciding_field_present: false }, provenance: { ref, status } },
      rawBytes: bytes, etag, window: { from: windowFrom, to: observed, status: "gap" }, cursor, ...answered,
    };
  }
  const o = (json ?? {}) as Record<string, unknown>;
  const updated = typeof o.updated_at === "string" ? o.updated_at : observed;
  return {
    evidence: { source_kind: "github_api", source_url: `${API}/${ref}`, text, structured: json ?? undefined, observed_at: observed, fetched_at: t0.toISOString(), http_status: 200, etag: etag ?? undefined, coverage: { snapshot_status: 200, deciding_field_present: decidingFieldPresent(resolverKind, json) }, provenance: { ref, etag, updated_at: updated, rate_remaining: res.headers.get("x-ratelimit-remaining") } },
    rawBytes: bytes, etag, window: { from: windowFrom, to: observed, status: "ok" }, cursor: { ...cursor, updated_at: updated }, ...answered,
  };
}

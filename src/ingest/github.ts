import type { Env } from "../env";
import type { WatchRow, FetchOutcome } from "./types";

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

/** Conditional GET of a GitHub REST resource named by source_ref.ref ("repos/o/r/pulls/1", "repos/o/r/releases", ...). */
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
  if (res.status === 304) return { notModified: true, etag: watch.etag, window: { from: windowFrom, to: observed, status: "ok" }, cursor: { ...watch.cursor, last_to: observed } };
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  const etag = res.headers.get("etag");
  if (res.status !== 200) {
    return {
      error: `github ${res.status} for ${ref}`,
      evidence: { source_kind: "github_api", source_url: `${API}/${ref}`, text: text.slice(0, 4000), structured: json ?? undefined, observed_at: observed, fetched_at: t0.toISOString(), http_status: res.status, coverage: { snapshot_status: res.status, deciding_field_present: false }, provenance: { ref, status: res.status } },
      rawBytes: bytes, etag, window: { from: windowFrom, to: observed, status: "gap" }, cursor: { ...watch.cursor, last_to: observed },
    };
  }
  const o = (json ?? {}) as Record<string, unknown>;
  const updated = typeof o.updated_at === "string" ? o.updated_at : observed;
  return {
    evidence: { source_kind: "github_api", source_url: `${API}/${ref}`, text, structured: json ?? undefined, observed_at: observed, fetched_at: t0.toISOString(), http_status: 200, etag: etag ?? undefined, coverage: { snapshot_status: 200, deciding_field_present: decidingFieldPresent(resolverKind, json) }, provenance: { ref, etag, updated_at: updated, rate_remaining: res.headers.get("x-ratelimit-remaining") } },
    rawBytes: bytes, etag, window: { from: windowFrom, to: observed, status: "ok" }, cursor: { ...watch.cursor, last_to: observed, updated_at: updated },
  };
}

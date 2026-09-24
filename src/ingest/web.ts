import type { Env } from "../env";
import type { WatchRow, FetchOutcome } from "./types";
import { railEnabled } from "../resolve/rails";
import { discardBody, retryAfterSeconds } from "./http";
import { webUrlMatches } from "../resolve/precheck";

const MAX_BYTES = 512 * 1024;
const MAX_TEXT = 64 * 1024;

/** Streaming HTML -> text with HTMLRewriter (CPU-cheap). Captures <time datetime> and published_time meta as claimed_at. */
export async function htmlToText(res: Response): Promise<{ text: string; claimedAt: string | null; title: string | null }> {
  const parts: string[] = [];
  let claimedAt: string | null = null;
  let title: string | null = null;
  let total = 0;
  const push = (s: string) => { if (total < MAX_TEXT) { parts.push(s); total += s.length; } };
  const rewriter = new HTMLRewriter()
    .on("script, style, nav, footer, aside, noscript, svg, iframe, form", { element(e) { e.remove(); } })
    .on("meta", { element(e) { const p = (e.getAttribute("property") ?? e.getAttribute("name") ?? "").toLowerCase(); if (!claimedAt && (p === "article:published_time" || p === "datepublished" || p === "date")) claimedAt = e.getAttribute("content"); } })
    .on("time", { element(e) { const d = e.getAttribute("datetime"); if (!claimedAt && d) claimedAt = d; } })
    .on("title", { text(t) { title = (title ?? "") + t.text; } })
    .on("h1, h2, h3, h4, p, li, td, th, blockquote, pre, figcaption, summary", { element(e) { e.append("\n", { html: false }); }, text(t) { push(t.text); } })
    .on("body", { text(t) { /* text outside block elements is captured by the block handlers; keep stream flowing */ } });
  await rewriter.transform(res).text();
  const raw = parts.join("");
  const text = raw.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  let claimedIso: string | null = null;
  if (claimedAt) { const d = new Date(claimedAt); if (!Number.isNaN(d.getTime())) claimedIso = d.toISOString(); }
  return { text, claimedAt: claimedIso, title: title ? String(title).trim() : null };
}

/**
 * Fetch a page with a declared UA and hard caps. observed_at is always our fetch time for web sources.
 * Only a 200 is evidence. Redirects are followed; one whose final URL fails precheck's source rule (same host
 * without "www.", path equal to or under the registered path: webUrlMatches) is a coverage gap: another site,
 * or a moved or deleted article that lands on the homepage or a login page, would otherwise be judged against a
 * source it did not come from and become a SOURCE_MISMATCH verdict. Redirects inside the rule (http -> https,
 * www., a trailing slash) are evidence with final_url recorded.
 */
export async function fetchWeb(env: Env, watch: WatchRow, botUa: string): Promise<FetchOutcome> {
  const url = String(watch.source_ref.url ?? watch.source_ref.ref ?? "");
  if (!/^https?:\/\//.test(url)) return { error: "source_ref.url invalid" };
  const headers: Record<string, string> = { "User-Agent": botUa, Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5", "Accept-Language": "en" };
  if (watch.etag) headers["If-None-Match"] = watch.etag;
  const t0 = new Date().toISOString();
  let res: Response;
  try { res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(8000), cf: { cacheTtl: 30, cacheEverything: false } } as RequestInit); }
  catch (e) { return { error: `web fetch failed: ${String(e).slice(0, 120)}` }; }
  const now = new Date().toISOString();
  const from = String(watch.cursor.last_to ?? now);
  const cursor = { ...watch.cursor, last_to: now };
  const deferSeconds = retryAfterSeconds(res.headers, Date.now());
  const answered = { httpStatus: res.status, ...(deferSeconds !== undefined ? { deferSeconds } : {}) };
  const gap = (error: string): FetchOutcome => ({ error, window: { from, to: now, status: "gap" }, cursor, ...answered });
  if (railEnabled("non200_never_evidence") && res.redirected && res.url && !webUrlMatches(url, res.url)) { await discardBody(res); return gap(`web ${url} redirected outside the registered source to ${res.url}`); }
  if (res.status === 304) return { notModified: true, etag: watch.etag, window: { from, to: now, status: "ok" }, cursor, ...answered };
  if (res.status !== 200) { await discardBody(res); return gap(`web ${res.status} for ${url}`); }
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  const buf = new Uint8Array(await res.clone().arrayBuffer());
  if (buf.byteLength > MAX_BYTES) return gap(`page too large (${buf.byteLength} bytes)`);
  let text: string, claimedAt: string | null = null, structured: unknown = undefined;
  if (ct.includes("json")) { text = new TextDecoder().decode(buf); try { structured = JSON.parse(text); } catch { /* keep text */ } }
  else if (ct.includes("html")) { const h = await htmlToText(res); text = h.text; claimedAt = h.claimedAt; }
  else text = new TextDecoder().decode(buf).slice(0, MAX_TEXT);
  const etag = res.headers.get("etag");
  return {
    evidence: { source_kind: "web_fetch", source_url: res.url || url, text, structured, observed_at: claimedAt ?? undefined, fetched_at: t0, http_status: 200, etag: etag ?? undefined, coverage: { snapshot_status: 200, deciding_field_present: text.length > 0 }, provenance: { url, final_url: res.url || url, redirected: res.redirected, content_type: ct, bytes: buf.byteLength, last_modified: res.headers.get("last-modified") } },
    rawBytes: buf, etag, window: { from, to: now, status: "ok" }, cursor, ...answered,
  };
}

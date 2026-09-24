import type { Env } from "../env";
import type { WatchRow, FetchOutcome } from "./types";
import { railEnabled } from "../resolve/rails";
import { discardBody, retryAfterSeconds } from "./http";
import { webUrlMatches } from "../resolve/precheck";
import { webUrlProblem } from "../markets/policy";

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

/** Redirects fetchWeb follows, each checked before it is requested. */
export const WEB_MAX_REDIRECTS = 5;
/** Worst-case subrequests of one fetchWeb(): the page plus every redirect hop (each hop is a fetch). */
export const WEB_FETCH_SUBREQUESTS = 1 + WEB_MAX_REDIRECTS;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch a page with a declared UA and hard caps. observed_at is always our fetch time for web sources.
 * Only a 200 is evidence. The stored URL passes the web URL policy on every poll (src/markets/policy.ts: public host,
 * no credentials, default port), so a row stored before migration 019 is held to it too; its scheme is kept (019
 * registers https only; an older http row still polls) and never downgraded. Redirects are followed by hand, at most
 * WEB_MAX_REDIRECTS, and each Location is checked before it is requested, as robots.txt's are (src/ingest/robots.ts):
 * a hop the policy refuses is never requested. A hop outside precheck's source rule (same host without "www.", path
 * equal to or under the registered path: webUrlMatches) is a coverage gap: another site, or a moved or deleted article
 * that lands on the homepage or a login page, would otherwise be judged against a source it did not come from and
 * become a SOURCE_MISMATCH verdict. Redirects inside the rule (http -> https, www., a trailing slash) are evidence with
 * final_url recorded. One 8 s timeout covers every hop.
 */
export async function fetchWeb(env: Env, watch: WatchRow, botUa: string): Promise<FetchOutcome> {
  const url = String(watch.source_ref.url ?? watch.source_ref.ref ?? "");
  if (!/^https?:\/\//.test(url)) return { error: "source_ref.url invalid" };
  const allowHttp = url.startsWith("http://");
  const refused = webUrlProblem(url, { allowHttp });
  if (refused) return { error: `web source refused by the URL policy, not fetched: ${refused}` };
  const headers: Record<string, string> = { "User-Agent": botUa, Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5", "Accept-Language": "en" };
  if (watch.etag) headers["If-None-Match"] = watch.etag;
  const t0 = new Date().toISOString();
  const signal = AbortSignal.timeout(8000);
  let target = url;
  let res: Response;
  let hopRefusal: string | null = null;
  let hop = 0;
  for (; ; hop++) {
    try { res = await fetch(target, { headers, redirect: "manual", signal, cf: { cacheTtl: 30, cacheEverything: false } } as RequestInit); }
    catch (e) { return { error: `web fetch failed: ${String(e).slice(0, 120)}` }; }
    if (!REDIRECT_STATUSES.has(res.status)) break;
    const loc = res.headers.get("location");
    let next = "";
    try { next = loc ? new URL(loc, target).href : ""; } catch { /* unusable Location */ }
    await discardBody(res);
    if (!next) { hopRefusal = `web ${url}: ${res.status} from ${target} without a usable Location`; break; }
    if (hop >= WEB_MAX_REDIRECTS) { hopRefusal = `web ${url} redirected more than ${WEB_MAX_REDIRECTS} times`; break; }
    const bad = webUrlProblem(next, { allowHttp });
    if (bad) { hopRefusal = `web ${url} redirected to ${next}, which is not fetched (${bad})`; break; }
    if (railEnabled("non200_never_evidence") && !webUrlMatches(url, next)) { hopRefusal = `web ${url} redirected outside the registered source to ${next}`; break; }
    target = next;
  }
  const now = new Date().toISOString();
  const from = String(watch.cursor.last_to ?? now);
  const cursor = { ...watch.cursor, last_to: now };
  const deferSeconds = retryAfterSeconds(res.headers, Date.now());
  const answered = { httpStatus: res.status, ...(deferSeconds !== undefined ? { deferSeconds } : {}) };
  const gap = (error: string): FetchOutcome => ({ error, window: { from, to: now, status: "gap" }, cursor, ...answered });
  if (hopRefusal) return gap(hopRefusal);
  if (res.status === 304) return { notModified: true, etag: watch.etag, window: { from, to: now, status: "ok" }, cursor, ...answered };
  if (res.status !== 200) { await discardBody(res); return gap(`web ${res.status} for ${url}`); }
  const redirected = hop > 0;
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  const buf = new Uint8Array(await res.clone().arrayBuffer());
  if (buf.byteLength > MAX_BYTES) return gap(`page too large (${buf.byteLength} bytes)`);
  let text: string, claimedAt: string | null = null, structured: unknown = undefined;
  if (ct.includes("json")) { text = new TextDecoder().decode(buf); try { structured = JSON.parse(text); } catch { /* keep text */ } }
  else if (ct.includes("html")) { const h = await htmlToText(res); text = h.text; claimedAt = h.claimedAt; }
  else text = new TextDecoder().decode(buf).slice(0, MAX_TEXT);
  const etag = res.headers.get("etag");
  return {
    evidence: { source_kind: "web_fetch", source_url: target, text, structured, observed_at: claimedAt ?? undefined, fetched_at: t0, http_status: 200, etag: etag ?? undefined, coverage: { snapshot_status: 200, deciding_field_present: text.length > 0 }, provenance: { url, final_url: target, redirected, content_type: ct, bytes: buf.byteLength, last_modified: res.headers.get("last-modified") } },
    rawBytes: buf, etag, window: { from, to: now, status: "ok" }, cursor, ...answered,
  };
}

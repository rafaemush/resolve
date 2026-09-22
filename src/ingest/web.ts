import type { Env } from "../env";
import type { WatchRow, FetchOutcome } from "./types";
import { ruleToRegex } from "./robots";

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

/** Fetch a page with a declared UA and hard caps. observed_at is always our fetch time for web sources. */
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
  if (res.status === 304) return { notModified: true, etag: watch.etag, window: { from, to: now, status: "ok" }, cursor: { ...watch.cursor, last_to: now } };
  if (res.status !== 200) return { error: `web ${res.status} for ${url}`, window: { from, to: now, status: "gap" }, cursor: { ...watch.cursor, last_to: now } };
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  const buf = new Uint8Array(await res.clone().arrayBuffer());
  if (buf.byteLength > MAX_BYTES) return { error: `page too large (${buf.byteLength} bytes)`, window: { from, to: now, status: "gap" }, cursor: { ...watch.cursor, last_to: now } };
  let text: string, claimedAt: string | null = null, structured: unknown = undefined;
  if (ct.includes("json")) { text = new TextDecoder().decode(buf); try { structured = JSON.parse(text); } catch { /* keep text */ } }
  else if (ct.includes("html")) { const h = await htmlToText(res); text = h.text; claimedAt = h.claimedAt; }
  else text = new TextDecoder().decode(buf).slice(0, MAX_TEXT);
  const etag = res.headers.get("etag");
  return {
    evidence: { source_kind: "web_fetch", source_url: res.url || url, text, structured, observed_at: claimedAt ?? undefined, fetched_at: t0, http_status: 200, etag: etag ?? undefined, coverage: { snapshot_status: 200, deciding_field_present: text.length > 0 }, provenance: { url, final_url: res.url, content_type: ct, bytes: buf.byteLength, last_modified: res.headers.get("last-modified") } },
    rawBytes: buf, etag, window: { from, to: now, status: "ok" }, cursor: { ...watch.cursor, last_to: now },
  };
}

/** Minimal robots.txt check")).join(".*");
  return new RegExp("^" + body + (endAnchored ? "$" : ""));
}

/** Minimal robots.txt check for our UA and '*'. Disallowed => the market registers as unsupported_source. */
export async function robotsAllows(url: string, botUa: string): Promise<{ allowed: boolean; reason: string }> {
  let u: URL;
  try { u = new URL(url); } catch { return { allowed: false, reason: "invalid url" }; }
  let body = "";
  try {
    const res = await fetch(`${u.origin}/robots.txt`, { headers: { "User-Agent": botUa }, signal: AbortSignal.timeout(5000), cf: { cacheTtl: 86400, cacheEverything: true } } as RequestInit);
    if (res.status === 404) return { allowed: true, reason: "no robots.txt" };
    if (!res.ok) return { allowed: true, reason: `robots.txt ${res.status} (treated as allow)` };
    body = (await res.text()).slice(0, 200_000);
  } catch { return { allowed: true, reason: "robots.txt unreachable (treated as allow)" }; }
  const botName = botUa.split("/")[0]!.toLowerCase();
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[] }> = [];
  let cur: { agents: string[]; disallow: string[]; allow: string[] } | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const v = rest.join(":").trim();
    const key = (k ?? "").trim().toLowerCase();
    if (key === "user-agent") { if (!cur || cur.disallow.length || cur.allow.length) { cur = { agents: [], disallow: [], allow: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); }
    else if (cur && key === "disallow") cur.disallow.push(v);
    else if (cur && key === "allow") cur.allow.push(v);
  }
  const g = groups.find((x) => x.agents.some((a) => a === botName)) ?? groups.find((x) => x.agents.includes("*"));
  if (!g) return { allowed: true, reason: "no matching group" };
  const path = u.pathname + u.search;
  const matches = (rule: string) => rule !== "" && ruleToRegex(rule).test(path);
  const dis = g.disallow.filter(matches).sort((a, b) => b.length - a.length)[0];
  const al = g.allow.filter(matches).sort((a, b) => b.length - a.length)[0];
  if (dis && (!al || al.length < dis.length)) return { allowed: false, reason: `robots.txt disallows ${dis} for ${g.agents.join(",")}` };
  return { allowed: true, reason: "allowed" };
}

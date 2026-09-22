/**
 * Deterministic pre-checks that run before any spend. Each yields a named
 * Check; the first failing gate produces an early verdict so poisoned,
 * corrupt, off-source or out-of-window evidence never reaches Jev.
 */
import type { MarketRegistration, EvidenceInput, Check } from "./schema";
import type { Thresholds } from "./thresholds";
import { canonicalize, findAnchor, fuzzyIndex, windowsAround, sha256Hex, hmacHex, type AnchorHit } from "./text";

export type EarlyStatus =
  | { kind: "ERROR"; error_code: "UNSAFE_INPUT" | "SOURCE_MISMATCH" | "INSUFFICIENT_DATA"; error_reason: string; caveats: string[] }
  | { kind: "UNRESOLVED"; caveats: string[] };

export interface PrecheckResult {
  checks: Check[];
  early: EarlyStatus | null;
  canonical: string;
  rawSha256: string;
  canonicalSha256: string;
  delimiter: string;
  windows: string[];
  anchorHits: AnchorHit[];
  markers: string[];
  observedAt: Date;
  claimedAt: Date | null;
  usableForPositive: boolean;
  afterDeadline: boolean;
  language: "en" | "other" | "unknown";
  isWeb: boolean;
  isStructuredKind: boolean;
}

const MARKERS: Array<[string, RegExp]> = [
  ["ignore_instructions", /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|these|the)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|guidelines?|constraints?|checks?)\b/i],
  ["role_prefix", /^\s*(system|assistant|developer)\s*:/im],
  ["role_claim", /\byou are (now )?(an? |the )?(ai|assistant|oracle|resolver|model|llm|judge|arbiter)\b/i],
  ["forced_output", /\b(output|respond|answer|return|reply|emit|set)\b[^.\n]{0,40}\b(OPTION_A|OPTION_B|RESOLVED|UNRESOLVED|winning_outcome|resolution_status|confidence_score)\b/i],
  ["schema_echo", /["']?(resolution_status|winning_outcome|confidence_score|error_code)["']?\s*[:=]/i],
  ["official_resolution", /\bofficial (resolution|outcome|result|verdict|answer)\s*[:=]/i],
  ["authority_claim", /\b(as|i am|we are|this is|speaking as) (the |an? )?(official )?(oracle|resolver|adjudicator|arbiter|resolution (bot|source|authority))\b/i],
  ["confidence_literal", /\bconfidence(_score)?\s*(is|[:=])\s*(1(\.0+)?|0?\.9\d)\b/i],
  ["deadline_override", /\b(ignore|extend|disregard|move|waive)\b[^.\n]{0,20}\b(the )?deadline\b/i],
  ["html_comment_directive", /<!--[\s\S]{0,300}?\b(ignore|output|resolve[sd]?|OPTION_A|OPTION_B|system|instruction)\b[\s\S]{0,300}?-->/i],
];

const STRUCTURED_KINDS = new Set(["github_api", "github_events", "base_log", "solana_log"]);
const EN_STOP = new Set(["the", "and", "of", "to", "in", "is", "that", "for", "was", "with", "on", "as", "by", "at", "it", "this", "from", "are", "be", "or"]);

function detectLanguage(text: string): "en" | "other" | "unknown" {
  const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (tokens.length < 40) return "unknown";
  let stop = 0;
  for (const t of tokens) if (EN_STOP.has(t)) stop++;
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters > 0 && latin / letters < 0.5) return "other";
  return stop / tokens.length >= 0.02 ? "en" : "other";
}

function normalizeUrl(u: string): { host: string; path: string } | null {
  try {
    const x = new URL(u);
    return { host: x.hostname.toLowerCase().replace(/^www\./, ""), path: x.pathname.replace(/\/+$/, "") };
  } catch { return null; }
}

export function sourceMatches(market: MarketRegistration, ev: EvidenceInput): { pass: boolean; detail: string } {
  const prov = (ev.provenance ?? {}) as Record<string, unknown>;
  for (const s of market.sources) {
    if (s.kind === "base_log" || s.kind === "solana_log") {
      const [, addr] = s.ref.split(":");
      const evAddr = String(prov.address ?? prov.account ?? "").toLowerCase();
      if (ev.source_kind === s.kind && addr && evAddr && evAddr === addr.toLowerCase()) return { pass: true, detail: `${s.kind} ${addr}` };
      continue;
    }
    if (s.kind === "github_api" || s.kind === "github_events") {
      if (!ev.source_url) continue;
      const n = normalizeUrl(ev.source_url);
      if (n && n.host === "api.github.com" && (n.path === "/" + s.ref.replace(/^\/+/, "") || n.path.startsWith("/" + s.ref.replace(/^\/+/, "") + "/"))) return { pass: true, detail: `github ${s.ref}` };
      continue;
    }
    // web sources: same host and path prefix
    if (!ev.source_url) continue;
    const a = normalizeUrl(ev.source_url);
    const b = normalizeUrl(s.ref);
    if (a && b && a.host === b.host && (a.path === b.path || a.path.startsWith(b.path + "/") || b.path === "")) return { pass: true, detail: `${b.host}${b.path}` };
  }
  if (ev.source_kind === "tenant_supplied" && !ev.source_url) return { pass: true, detail: "tenant_supplied without url (labeled, excluded from track record)" };
  return { pass: false, detail: `evidence source ${ev.source_url ?? "(none)"} matches no registered source` };
}

export async function precheck(market: MarketRegistration, ev: EvidenceInput, th: Thresholds, spotlightSecret: string, now: Date): Promise<PrecheckResult> {
  const checks: Check[] = [];
  const caveats: string[] = [];
  const isWeb = ev.source_kind === "web_fetch" || ev.source_kind === "web_render" || ev.source_kind === "tenant_supplied";
  const isStructuredKind = STRUCTURED_KINDS.has(ev.source_kind);
  const rawText = ev.text ?? (ev.structured !== undefined ? JSON.stringify(ev.structured) : "");
  const rawSha256 = await sha256Hex(rawText);
  const canon = canonicalize(rawText);
  const canonicalSha256 = await sha256Hex(canon.text);
  const delimiter = (await hmacHex(spotlightSecret, canonicalSha256)).slice(0, 12);
  let early: EarlyStatus | null = null;
  const markers: string[] = [];

  // 1. hidden unicode + injection markers ------------------------------------
  if (canon.bidiOrTagRemoved > 0) markers.push("hidden_bidi_or_tag");
  if (canon.zeroWidthRemoved > th.hiddenZeroWidthMax) markers.push("hidden_zero_width");
  for (const [name, re] of MARKERS) if (re.test(canon.text) || re.test(rawText)) markers.push(name);
  checks.push({ name: "injection_markers", pass: markers.length === 0, detail: markers.length ? markers.join(",") : `zero_width=${canon.zeroWidthRemoved}` });
  if (markers.length && !early) early = { kind: "ERROR", error_code: "UNSAFE_INPUT", error_reason: "INJECTION_SUSPECTED", caveats: [] };

  // 2. integrity --------------------------------------------------------------
  const text = canon.text;
  const ctrl = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) ?? []).length;
  const repl = (text.match(/�/g) ?? []).length;
  const moji = (text.match(/Ã.|Â.|â€/g) ?? []).length;
  let integrity: string | null = null;
  if (text.length === 0) integrity = "TOO_SHORT";
  else if (text.length < th.minAnchoredChars) integrity = "TOO_SHORT";
  else if (ctrl / text.length > 0.05) integrity = "CORRUPT_INPUT";
  else if (repl / text.length > 0.01) integrity = "CORRUPT_INPUT";
  else if (moji / text.length > 0.02) integrity = "CORRUPT_INPUT";
  if (isStructuredKind) {
    const s = ev.structured;
    if (s === undefined || s === null || typeof s !== "object") integrity = integrity ?? "CORRUPT_INPUT";
  }
  if (moji / Math.max(1, text.length) > 0.005 && !integrity) caveats.push("mojibake_suspected");
  checks.push({ name: "integrity", pass: integrity === null, detail: integrity ?? `chars=${text.length}` });
  if (integrity && !early) early = { kind: "ERROR", error_code: "INSUFFICIENT_DATA", error_reason: integrity, caveats: [] };

  // 3. source match -----------------------------------------------------------
  const src = sourceMatches(market, ev);
  checks.push({ name: "source_match", pass: src.pass, detail: src.detail });
  if (!src.pass && !early) early = { kind: "ERROR", error_code: "SOURCE_MISMATCH", error_reason: "SOURCE_REF_MISMATCH", caveats: [] };
  if (ev.source_kind === "tenant_supplied") caveats.push("tenant_supplied_evidence");

  // 4. anchors + windows ------------------------------------------------------
  const fz = fuzzyIndex(text);
  const hits: AnchorHit[] = [];
  const missing: string[] = [];
  for (const a of market.anchors) {
    const h = findAnchor(text, a, fz);
    if (h) hits.push(h); else missing.push(a);
  }
  checks.push({ name: "anchor_localization", pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(" | ")}` : hits.map((h) => h.mode).join(",") });
  if (missing.length && !early) early = { kind: "ERROR", error_code: "SOURCE_MISMATCH", error_reason: "NO_ANCHOR", caveats: [] };
  let windows = windowsAround(hits, text).map((w) => text.slice(w.start, w.end));
  let total = windows.reduce((n, w) => n + w.length, 0);
  if (total > th.maxStateChars) {
    const scale = th.maxStateChars / total;
    windows = windows.map((w) => w.slice(0, Math.max(200, Math.floor(w.length * scale))));
    total = windows.reduce((n, w) => n + w.length, 0);
    caveats.push("evidence_trimmed");
  }
  checks.push({ name: "state_size", pass: total <= th.maxStateChars, detail: `chars=${total}` });

  // 5. time window ------------------------------------------------------------
  const fetchedAt = new Date(ev.fetched_at);
  let observedAt: Date;
  let claimedAt: Date | null = null;
  if (isStructuredKind && ev.observed_at) observedAt = new Date(ev.observed_at);
  else {
    observedAt = fetchedAt;
    if (ev.observed_at) claimedAt = new Date(ev.observed_at);
    if (isWeb) caveats.push("source_timestamp_unverified");
  }
  const openAt = new Date(market.open_at);
  const deadline = new Date(Date.parse(market.deadline_utc) + market.grace_seconds * 1000);
  const beforeOpen = observedAt.getTime() < openAt.getTime();
  const usableForPositive = !beforeOpen && observedAt.getTime() <= deadline.getTime();
  const afterDeadline = now.getTime() > deadline.getTime();
  checks.push({ name: "time_window", pass: !beforeOpen, detail: beforeOpen ? `observed ${observedAt.toISOString()} before open_at` : usableForPositive ? "in window" : "after deadline+grace (negative paths only)" });
  if (beforeOpen && !early) early = { kind: "ERROR", error_code: "SOURCE_MISMATCH", error_reason: "OUT_OF_WINDOW", caveats: [] };

  // 6. language ---------------------------------------------------------------
  const language = isStructuredKind ? "unknown" : detectLanguage(text);
  checks.push({ name: "language", pass: language !== "other", detail: language });
  if (language === "other" && !early) early = { kind: "UNRESOLVED", caveats: ["non_english"] };

  if (early && early.kind === "ERROR") early.caveats = caveats;
  if (early && early.kind === "UNRESOLVED") early.caveats = [...new Set([...early.caveats, ...caveats])];

  return { checks, early, canonical: text, rawSha256, canonicalSha256, delimiter, windows, anchorHits: hits, markers, observedAt, claimedAt, usableForPositive, afterDeadline, language, isWeb, isStructuredKind };
}

export { canonicalize };

/**
 * Structured resolvers: decide from machine-readable evidence without Jev.
 * Positive findings resolve when they fall inside the market window. A negative
 * verdict is NEVER a non-observation: it requires the coverage proof.
 */
import type { MarketRegistration, EvidenceInput, Coverage } from "./schema";
import type { PrecheckResult } from "./precheck";
import { railEnabled } from "./rails";

export type Option = "OPTION_A" | "OPTION_B";
export const other = (o: Option): Option => (o === "OPTION_A" ? "OPTION_B" : "OPTION_A");

export interface StructuredDecision {
  status: "RESOLVED" | "UNRESOLVED" | "ERROR";
  outcome: "OPTION_A" | "OPTION_B" | "NONE";
  error_code?: "INSUFFICIENT_DATA" | "SOURCE_MISMATCH";
  error_reason?: string;
  caveats: string[];
  detail: string;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

interface Positive { found: boolean; at?: Date; disqualified?: string; wrongSubject?: string; detail: string }

const MONOTONIC = new Set(["github_pr_merged", "github_release_published"]);

function parseDate(v: unknown): Date | undefined {
  if (typeof v === "string") { const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d; }
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  return undefined;
}

export function parseNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return undefined;
  const m = v.replace(/[,\s_]/g, "").match(/^-?\$?(\d+(?:\.\d+)?)(e[+-]?\d+)?\s*([kKmMbB])?$/);
  if (!m) return undefined;
  let n = Number(m[1] + (m[2] ?? ""));
  const suf = (m[3] ?? "").toLowerCase();
  if (suf === "k") n *= 1e3; else if (suf === "m") n *= 1e6; else if (suf === "b") n *= 1e9;
  return Number.isFinite(n) ? n : undefined;
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) { case ">=": return a >= b; case "<=": return a <= b; case ">": return a > b; case "<": return a < b; case "==": return a === b; default: return false; }
}

/** Numbers near an anchor in free text; returns the distinct candidate values. */
export function numbersNearAnchors(text: string, anchors: string[]): number[] {
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  const out = new Set<number>();
  for (const s of sentences) {
    if (!anchors.some((a) => s.toLowerCase().includes(a.toLowerCase()))) continue;
    for (const m of s.matchAll(/(?<![\w.])\$?\d[\d,]*(?:\.\d+)?\s?[kKmMbB]?(?![\w.])/g)) {
      const n = parseNumber(m[0].trim());
      if (n !== undefined) out.add(n);
    }
  }
  return [...out];
}

function findPositive(market: MarketRegistration, s: unknown, text: string): Positive {
  const r = market.resolver!;
  const obj = (s ?? {}) as Record<string, unknown>;
  switch (r.kind) {
    case "github_pr_merged": {
      const num = obj.number; const full = String(getPath(obj, "base.repo.full_name") ?? "");
      if ((num !== undefined && Number(num) !== r.pr) || (full && full.toLowerCase() !== r.repo.toLowerCase())) return { found: false, wrongSubject: `pr ${num} in ${full || "?"} != ${r.repo}#${r.pr}`, detail: "wrong pr/repo" };
      const at = parseDate(obj.merged_at);
      return at ? { found: true, at, detail: `merged_at=${at.toISOString()}` } : { found: false, detail: `merged_at=${String(obj.merged_at)} state=${String(obj.state)}` };
    }
    case "github_release_published": {
      const list = Array.isArray(s) ? (s as Record<string, unknown>[]) : [obj];
      const rel = list.find((x) => String(x.tag_name) === r.tag);
      if (!rel) return { found: false, detail: `no release tagged ${r.tag} among ${list.length}` };
      if (rel.draft === true) return { found: false, disqualified: "draft", detail: "release is a draft" };
      if (rel.prerelease === true && !market.allow_prerelease) return { found: false, disqualified: "prerelease", detail: "release is a prerelease and allow_prerelease=false" };
      const at = parseDate(rel.published_at);
      return at ? { found: true, at, detail: `published_at=${at.toISOString()}` } : { found: false, detail: "published_at missing" };
    }
    case "github_issue_closed": {
      const num = obj.number;
      if (num !== undefined && Number(num) !== r.issue) return { found: false, wrongSubject: `issue ${num} != ${r.issue}`, detail: "wrong issue" };
      const at = obj.state === "closed" ? parseDate(obj.closed_at) : undefined;
      return at ? { found: true, at, detail: `closed_at=${at.toISOString()}` } : { found: false, detail: `state=${String(obj.state)}` };
    }
    case "evm_log_present": {
      const logs = (Array.isArray(obj.logs) ? obj.logs : []) as Record<string, unknown>[];
      const safe = typeof obj.safe_block === "number" ? obj.safe_block : undefined;
      for (const l of logs) {
        const topics = (Array.isArray(l.topics) ? l.topics : []).map((t) => String(t).toLowerCase());
        if (String(l.address ?? "").toLowerCase() !== r.address.toLowerCase()) continue;
        if (topics[0] !== r.topic0.toLowerCase()) continue;
        if (r.topics && r.topics.some((t, i) => t !== null && topics[i + 1] !== t.toLowerCase())) continue;
        const bn = Number(l.block_number ?? l.blockNumber);
        if (safe === undefined || !Number.isFinite(bn) || bn > safe) return { found: false, disqualified: "unsafe_block", detail: `log at block ${bn} above safe ${safe ?? "?"}` };
        const at = parseDate(l.timestamp ?? l.block_time ?? l.blockTime);
        return { found: true, at, detail: `log tx=${String(l.tx_hash ?? l.transactionHash)} block=${bn}` };
      }
      return { found: false, detail: `no matching log in ${logs.length}` };
    }
    case "solana_sig_present": {
      const sigs = (Array.isArray(obj.signatures) ? obj.signatures : []) as Record<string, unknown>[];
      for (const sg of sigs) {
        if (sg.err !== null && sg.err !== undefined) continue;
        if (r.discriminator && String(sg.discriminator ?? "") !== r.discriminator) continue;
        return { found: true, at: parseDate(sg.blockTime ?? sg.block_time), detail: `sig=${String(sg.signature)}` };
      }
      return { found: false, detail: `no matching signature in ${sigs.length}` };
    }
    case "numeric_threshold": {
      let value: number | undefined;
      if (s !== undefined && s !== null) value = parseNumber(getPath(s, r.path));
      if (value === undefined && text) {
        const cands = numbersNearAnchors(text, market.anchors);
        if (cands.length === 1) value = cands[0];
        else if (cands.length > 1) return { found: false, disqualified: "AMBIGUOUS_VALUE", detail: `candidates=${cands.join(",")}` };
      }
      if (value === undefined) return { found: false, disqualified: "AMBIGUOUS_VALUE", detail: "no value found" };
      const ok = compare(value, r.op, r.value);
      return { found: ok, detail: `value=${value} ${r.op} ${r.value} -> ${ok}` };
    }
  }
}

export function resolverAppliesTo(market: MarketRegistration, ev: EvidenceInput): boolean {
  const r = market.resolver;
  if (!r) return false;
  if (r.kind.startsWith("github_")) return ev.source_kind === "github_api" || ev.source_kind === "github_events";
  if (r.kind === "evm_log_present") return ev.source_kind === "base_log";
  if (r.kind === "solana_sig_present") return ev.source_kind === "solana_log";
  return true; // numeric_threshold reads structured or text
}

function coverageProof(kind: string, cov: Coverage | undefined, market: MarketRegistration, deadline: Date, observedAt: Date): { ok: boolean; gap: string; caveats: string[] } {
  const caveats: string[] = [];
  const c = cov ?? {};
  const errors = c.errors ?? 0;
  if (errors > 0) return { ok: false, gap: `${errors} polling errors in range`, caveats };
  if (c.backlog === true) return { ok: false, gap: "watch in backlog (partial view)", caveats };
  const rangeOk = c.contiguous === true && !!c.from && !!c.to && Date.parse(c.from) <= Date.parse(market.open_at) && Date.parse(c.to) >= deadline.getTime();
  if (kind === "evm_log_present") {
    if (c.has_code !== true) return { ok: false, gap: "registered address has no code at safe tag", caveats };
    if (typeof c.safe_block !== "number") return { ok: false, gap: "no safe block observed", caveats };
    return rangeOk ? { ok: true, gap: "", caveats } : { ok: false, gap: `log range not contiguous over [open_at, deadline+grace] (${c.from ?? "?"}..${c.to ?? "?"})`, caveats };
  }
  if (kind === "solana_sig_present") {
    if (c.account_exists !== true) return { ok: false, gap: "watched account does not exist", caveats };
    return rangeOk ? { ok: true, gap: "", caveats } : { ok: false, gap: "signature range not contiguous over the market window", caveats };
  }
  // GitHub snapshot kinds
  const snapshotOk = c.snapshot_status === 200 && c.deciding_field_present === true && observedAt.getTime() >= deadline.getTime();
  if (MONOTONIC.has(kind)) {
    if (snapshotOk) { if (kind === "github_release_published") caveats.push("release_deletion_possible"); return { ok: true, gap: "", caveats }; }
    if (rangeOk && c.snapshot_status === 200 && c.deciding_field_present === true) return { ok: true, gap: "", caveats };
    return { ok: false, gap: `post-deadline snapshot missing or not 200 (status=${c.snapshot_status ?? "?"}, deciding_field=${String(c.deciding_field_present)})`, caveats };
  }
  if (kind === "numeric_threshold") {
    if (snapshotOk) { caveats.push("numeric_snapshot_at_deadline"); return { ok: true, gap: "", caveats }; }
    return { ok: false, gap: "no post-deadline value snapshot", caveats };
  }
  if (snapshotOk && rangeOk) return { ok: true, gap: "", caveats };
  return { ok: false, gap: "non-monotonic fact needs contiguous coverage plus a post-deadline snapshot", caveats };
}

export function decideStructured(market: MarketRegistration, ev: EvidenceInput, pre: PrecheckResult, now: Date): StructuredDecision | null {
  const r = market.resolver;
  if (!railEnabled("structured_router")) return null;
  if (!r || !resolverAppliesTo(market, ev)) return null;
  if (ev.structured === undefined && r.kind !== "numeric_threshold") return null;
  const pos = market.positive_option;
  const neg = other(pos);
  const deadline = new Date(Date.parse(market.deadline_utc) + market.grace_seconds * 1000);
  const openAt = new Date(market.open_at);
  const p = findPositive(market, ev.structured, pre.canonical);
  const caveats: string[] = [];

  if (p.wrongSubject) return { status: "ERROR", outcome: "NONE", error_code: "SOURCE_MISMATCH", error_reason: "SUBJECT_MISMATCH", caveats, detail: p.wrongSubject };
  if (p.disqualified === "AMBIGUOUS_VALUE") return { status: "ERROR", outcome: "NONE", error_code: "INSUFFICIENT_DATA", error_reason: "AMBIGUOUS_VALUE", caveats, detail: p.detail };

  if (p.found) {
    const at = p.at ?? pre.observedAt;
    if (at.getTime() < openAt.getTime()) return { status: "UNRESOLVED", outcome: "NONE", caveats: ["occurred_before_open_at"], detail: p.detail };
    if (at.getTime() <= deadline.getTime()) return { status: "RESOLVED", outcome: pos, caveats, detail: p.detail };
    if (MONOTONIC.has(r.kind)) return { status: "RESOLVED", outcome: neg, caveats: ["occurred_after_deadline"], detail: p.detail };
    return { status: "UNRESOLVED", outcome: "NONE", caveats: ["occurred_after_deadline"], detail: p.detail };
  }

  if (p.disqualified) caveats.push(`disqualified_${p.disqualified}`);
  const afterDeadline = now.getTime() > deadline.getTime();
  if (!afterDeadline) return { status: "UNRESOLVED", outcome: "NONE", caveats: ["awaiting_deadline", ...caveats], detail: p.detail };
  if (market.negative_rule !== "absence_after_deadline") return { status: "UNRESOLVED", outcome: "NONE", caveats: ["negative_unproven", ...caveats], detail: p.detail };
  const proof = railEnabled("coverage_proof") ? coverageProof(r.kind, ev.coverage, market, deadline, pre.observedAt) : { ok: true, gap: "", caveats: [] as string[] };
  if (!proof.ok) return { status: "ERROR", outcome: "NONE", error_code: "INSUFFICIENT_DATA", error_reason: "COVERAGE_GAP", caveats, detail: proof.gap };
  return { status: "RESOLVED", outcome: neg, caveats: [...caveats, ...proof.caveats], detail: `absence proven: ${p.detail}` };
}

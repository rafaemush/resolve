/**
 * Rules of scripts/log-touch.ts and scripts/leads.ts (pure; tests/touch.test.ts). Every sales and vendor contact is a
 * gtm_touches row written through log_touch() (migration 014), whose trigger enforces the no-cold-pitch gate: an
 * outbound dm, email or call to a lead is refused (SQLSTATE RS002) until a reconciled row exists on the lead's platform,
 * unless the touch carries an override reason, which is then on the record.
 */
import { createHash } from "node:crypto";

export const TOUCH_KINDS = ["dm", "email", "call", "reply", "ops"] as const;
export const DIRECTIONS = ["out", "in"] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];
export type Direction = (typeof DIRECTIONS)[number];

export class UsageError extends Error {}

export const TOUCH_USAGE = `usage: npx tsx scripts/log-touch.ts --lead "<lead name>" --kind ${TOUCH_KINDS.join("|")} --direction ${DIRECTIONS.join("|")} --summary "<what was said, with the dated ask>"
       [--evidence-url <https url>] [--override-reason "<why a pitch goes out without a reconciled row>"] [--request-id <id>] [--dry-run (default) | --apply]`;

export interface TouchArgs {
  lead: string;
  kind: TouchKind;
  direction: Direction;
  summary: string;
  evidenceUrl: string | null;
  overrideReason: string | null;
  /** log_touch p_request_id: given, or touchRequestId() of lead|kind|direction|summary|today (UTC), so a retry the same day is the same touch. */
  requestId: string;
  /** true when --request-id was not given and requestId was derived. */
  derivedRequestId: boolean;
  apply: boolean;
}

const FLAGS = new Set(["--lead", "--kind", "--direction", "--summary", "--evidence-url", "--override-reason", "--request-id", "--dry-run", "--apply"]);
const BOOLEAN = new Set(["--dry-run", "--apply"]);

/** Pure. The idempotency key a touch gets when none is given: sha256 hex of lead|kind|direction|summary|day. */
export function touchRequestId(p: { lead: string; kind: string; direction: string; summary: string; day: string }): string {
  return createHash("sha256").update([p.lead, p.kind, p.direction, p.summary, p.day].join("|"), "utf8").digest("hex");
}

/** Pure. `today` is the UTC day (YYYY-MM-DD) the derived request id is keyed on. Throws UsageError for anything unexpected. */
export function parseTouchArgs(argv: readonly string[], today: string): TouchArgs {
  const v: Record<string, string> = {};
  let apply = false, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf("=");
    const flag = raw.startsWith("--") && eq > 0 ? raw.slice(0, eq) : raw;
    if (!FLAGS.has(flag)) throw new UsageError(`unknown argument "${raw}"`);
    if (BOOLEAN.has(flag)) {
      if (eq > 0) throw new UsageError(`${flag} takes no value`);
      if (flag === "--apply") apply = true; else dryRun = true;
      continue;
    }
    const value = eq > 0 ? raw.slice(eq + 1) : argv[++i];
    if (value === undefined || (value.startsWith("--") && FLAGS.has(value.split("=")[0]!))) throw new UsageError(`${flag} needs a value`);
    if (flag in v) throw new UsageError(`${flag} given twice`);
    v[flag] = value;
  }
  if (apply && dryRun) throw new UsageError("--apply and --dry-run are exclusive");
  const need = (f: string) => { const x = v[f]?.trim(); if (!x) throw new UsageError(`${f} is required and cannot be blank`); return x; };
  const lead = need("--lead");
  const kind = need("--kind");
  if (!(TOUCH_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind must be one of ${TOUCH_KINDS.join(", ")}, got "${kind}"`);
  const direction = need("--direction");
  if (!(DIRECTIONS as readonly string[]).includes(direction)) throw new UsageError(`--direction must be ${DIRECTIONS.join(" or ")}, got "${direction}"`);
  const summary = need("--summary");
  if (summary.length > 4000) throw new UsageError("--summary is longer than 4,000 characters");
  const opt = (f: string) => (f in v ? (v[f]!.trim() || null) : null);
  if ("--override-reason" in v && !opt("--override-reason")) throw new UsageError("--override-reason cannot be blank: a reason nobody wrote is not a reason");
  const evidenceUrl = opt("--evidence-url");
  if (evidenceUrl) {
    let u: URL | null = null;
    try { u = new URL(evidenceUrl); } catch { /* checked below */ }
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) throw new UsageError(`--evidence-url must be an http(s) URL, got "${evidenceUrl}"`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`today must be YYYY-MM-DD, got "${today}"`);
  const given = opt("--request-id");
  if ("--request-id" in v && !given) throw new UsageError("--request-id cannot be blank");
  return {
    lead, kind: kind as TouchKind, direction: direction as Direction, summary, evidenceUrl, overrideReason: opt("--override-reason"),
    requestId: given ?? touchRequestId({ lead, kind, direction, summary, day: today }), derivedRequestId: !given, apply,
  };
}

/** Pure. The gtm_touch_gate rule (migration 014): an outbound dm, email or call is a pitch; reply and ops never are. */
export function isPitch(a: Pick<TouchArgs, "kind" | "direction">): boolean {
  return a.direction === "out" && (a.kind === "dm" || a.kind === "email" || a.kind === "call");
}

export interface LeadRow { id: string; name: string; org: string | null; platform: string | null; fit_rank: number | null; status: string }

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Pure. Leads to suggest when --lead matched none exactly: case-insensitive containment either way, or a shared word of
 * three letters or more; at most `max`, best first (containment, then shared words, then name).
 */
export function leadCandidates(leads: readonly LeadRow[], name: string, max = 10): LeadRow[] {
  const q = fold(name);
  const words = new Set(q.split(" ").filter((w) => w.length >= 3));
  const scored = leads.map((l) => {
    const n = fold(l.name), org = fold(l.org ?? "");
    const contains = n.includes(q) || q.includes(n) || (!!org && (org.includes(q) || q.includes(org)));
    const shared = [...new Set(`${n} ${org}`.split(" "))].filter((w) => words.has(w)).length;
    return { l, score: (contains ? 100 : 0) + shared };
  }).filter((x) => x.score > 0);
  return scored.sort((a, b) => b.score - a.score || a.l.name.localeCompare(b.l.name)).slice(0, max).map((x) => x.l);
}

/** Pure. One line naming a lead for the terminal (never its contact: personal data). */
export function leadLine(l: LeadRow): string {
  return `${l.name}${l.org ? ` (${l.org})` : ""} — platform ${l.platform ?? "none"}, fit_rank ${l.fit_rank ?? "-"}, status ${l.status}, id ${l.id}`;
}

/** Pure. What a refused log_touch() means, in plain words; null when the error is something else. */
export function touchRefusal(error: { code?: string | null; message: string }, a: Pick<TouchArgs, "kind" | "overrideReason">): string | null {
  if (error.code === "RS002") {
    if (/is deleted/.test(error.message)) return `REFUSED (RS002): ${error.message}. A deleted lead accepts no new touch.`;
    return `REFUSED by the no-cold-pitch gate (RS002): ${error.message}.\n` +
      `An outbound ${a.kind} needs a reconciled row (agree, disagree, abstained or void) on the lead's platform first. If this pitch must go out anyway, ` +
      `rerun with --override-reason "<why>": the reason is stored with the touch, on the record.`;
  }
  if (error.code === "23505") return `REFUSED (23505): ${error.message}. The request id already records a different touch; rerun with --request-id <new id> if this is a new touch.`;
  if (error.code === "23503") return `REFUSED (23503): ${error.message}.`;
  return null;
}

export interface TouchRow { lead_id: string; kind: string; direction: string; touched_at: string }

/** Pure. scripts/leads.ts: one line per lead (best fit_rank first, unranked last, then name) with its last touch. */
export function leadsTable(leads: readonly LeadRow[], touches: readonly TouchRow[]): string {
  const last = new Map<string, TouchRow>();
  for (const t of touches) {
    const prev = last.get(t.lead_id);
    if (!prev || Date.parse(t.touched_at) > Date.parse(prev.touched_at)) last.set(t.lead_id, t);
  }
  const rows = [...leads]
    .sort((a, b) => (a.fit_rank ?? Infinity) - (b.fit_rank ?? Infinity) || a.name.localeCompare(b.name))
    .map((l) => {
      const t = last.get(l.id);
      return [l.name, l.platform ?? "-", l.fit_rank === null ? "-" : String(l.fit_rank), l.status, t ? `${t.touched_at.slice(0, 10)} ${t.kind} ${t.direction}` : "never"];
    });
  const head = ["name", "platform", "fit_rank", "status", "last touch"];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(width[i]!)).join("  ").trimEnd();
  return [line(head), line(width.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n") + `\n${leads.length} lead(s)`;
}

export const LEADS_USAGE = "usage: npx tsx scripts/leads.ts   (read-only: name, platform, fit_rank, status, last touch of every lead that is not deleted)";

/** Pure. scripts/leads.ts takes no argument. */
export function parseLeadsArgs(argv: readonly string[]): void {
  if (argv.length) throw new UsageError(`unknown argument "${argv[0]}"`);
}

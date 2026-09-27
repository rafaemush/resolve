/**
 * The names a customer-facing surface uses (plan §2.1; the model vendor's Master Customer Agreement §2.3(a)): a response
 * body or header, a webhook payload, the OpenAPI document, a venue report or a public post never names the model or
 * its vendor. Internal code, database columns and enum values, evals and the admin-only /internal/* routes keep their
 * names; the mapping happens only where data leaves to a tenant or the public. Every function here is pure.
 *
 *   internal                                public
 *   determination_basis "jev"               "web_evidence"
 *   jev_model "jev-1.13.0"                  engine_version "e" + FNV-1a 32 of the model id (opaque; changes with it)
 *   error_reason PAID_JEV_DISABLED          WEB_EVIDENCE_DISABLED
 *   route "jev"                             "web_evidence"
 *   checks[] jev_call                       web_evidence_call (model id -> engine_version; a failure's detail is generic)
 *   v_track_record.jev_share                web_evidence_share
 *
 * The mappers are idempotent, so a payload stored before this mapping (a queued webhook) and one stored after both
 * leave in the public shape.
 */
import { z } from "zod";
import { Check, ErrorCode, ErrorReason, EvidenceSummary, ResolutionStatus, WinningOutcome, type DeterminationBasis, type Verdict } from "../resolve/schema";

export type PublicBasis = "structured" | "web_evidence" | null;

/** How a customer-facing surface names the route: "web_evidence" for the model route. */
export function venueBasis(basis: z.infer<typeof DeterminationBasis> | null): PublicBasis {
  return basis === "jev" ? "web_evidence" : basis;
}

/** venueBasis over a stored value (a database row, a stored payload). Anything outside the public enum is null. */
export function publicBasis(v: unknown): PublicBasis {
  if (v === "jev" || v === "web_evidence") return "web_evidence";
  return v === "structured" ? "structured" : null;
}

/**
 * Opaque, deterministic label of the configured model id: "e" + FNV-1a 32-bit (8 hex characters) of its UTF-8 bytes.
 * It changes whenever the model id changes, so a tenant can tell two engine versions apart without learning the name;
 * null when there is no model id (structured and pre-check verdicts).
 */
export function engineVersion(model: string | null): string | null {
  if (model === null) return null;
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(model)) h = Math.imul(h ^ b, 0x01000193);
  return `e${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** The public error_reason: PAID_JEV_DISABLED is WEB_EVIDENCE_DISABLED; every other reason keeps its name. */
export function publicErrorReason(r: string): string {
  return r === "PAID_JEV_DISABLED" ? "WEB_EVIDENCE_DISABLED" : publicText(r);
}

/** The route a /v1/resolve answer names (the price class): "web_evidence" for the model route. */
export function publicRoute(route: "precheck" | "structured" | "jev"): "precheck" | "structured" | "web_evidence" {
  return route === "jev" ? "web_evidence" : route;
}

/** A model id in free text ("jev-1.13.0"): a version starts with a digit, so prose such as "Jev-backed" is not one. */
const MODEL_ID = /\bjev-\d[A-Za-z0-9]*(?:[._+-][A-Za-z0-9]+)*/gi;

/**
 * Free text we generate that may carry an internal name (an error string, a run summary) as a customer may read it: the
 * gated reason and a model id become their public names, and any remaining vendor name or standalone model name
 * (Jev, jev_call, upstream:jev) is replaced. A word that merely contains the letters is left alone, and evidence and
 * check text is never passed through this: a quote, a URL or an anchor is the source's words.
 */
export function publicText(s: string): string {
  return s
    .replace(/PAID_JEV_DISABLED/g, "WEB_EVIDENCE_DISABLED")
    .replace(MODEL_ID, (m) => engineVersion(m)!)
    .replace(/TYPESAFE/g, "UPSTREAM")
    .replace(/typesafe/gi, "upstream")
    .replace(/\bJev\b/g, "web evidence")
    .replace(/\bjev(?=\b|_)/gi, "web_evidence");
}

const FAILED_CALL = "the web-evidence call did not complete; error_reason says why";

/**
 * One verdict check as a customer reads it. jev_call is web_evidence_call: a passing call's detail ("<model> N tokens
 * M ms") names the engine_version instead of the model id; a failed call's detail (the upstream's own error text) is
 * replaced by a generic line, since error_reason already classifies it. Every other check (precheck, structured,
 * postcheck) names no model and passes through unchanged: its detail can quote the market's own sources and anchors.
 */
export function publicCheck(c: unknown): Check {
  const o = (c !== null && typeof c === "object" ? c : {}) as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "unknown";
  const pass = o.pass === true;
  const detail = typeof o.detail === "string" ? o.detail : undefined;
  if (name === "jev_call") {
    if (!pass) return { name: "web_evidence_call", pass, detail: FAILED_CALL };
    if (detail === undefined) return { name: "web_evidence_call", pass };
    const [model = "", ...rest] = detail.split(" ");
    return { name: "web_evidence_call", pass, detail: publicText([engineVersion(model), ...rest].join(" ")) };
  }
  return detail === undefined ? { name, pass } : { name, pass, detail };
}

export const PublicErrorReason = z.enum([...ErrorReason.exclude(["PAID_JEV_DISABLED"]).options, "WEB_EVIDENCE_DISABLED"]);
export const PublicDeterminationBasis = z.enum(["structured", "web_evidence"]);

/**
 * The verdict contract every customer-facing surface serves (POST /v1/resolve, GET /v1/resolutions/:id, replays, the
 * market.* webhooks) and the OpenAPI document publishes as components.schemas.Verdict. The internal Verdict
 * (src/resolve/schema.ts) is what the runtime, the database and the evals use; toPublicVerdict maps one to the other.
 */
export const PublicVerdict = z.object({
  market_id: z.string(),
  resolution_status: ResolutionStatus,
  winning_outcome: WinningOutcome,
  confidence_score: z.number().min(0).max(0.99),
  error_code: ErrorCode.nullable(),
  error_reason: PublicErrorReason.nullable(),
  caveats: z.array(z.string()),
  determination_basis: PublicDeterminationBasis.nullable(),
  evidence: EvidenceSummary.nullable(),
  checks: z.array(Check),
  engine_version: z.string().nullable().describe("Opaque label of the resolution engine version behind a web-evidence verdict; it changes when the engine changes. null when no web-evidence call was made."),
  thresholds_version: z.string(),
  latency_ms: z.number().int().min(0),
}).superRefine((v, ctx) => {
  const isError = v.resolution_status === "ERROR";
  if (isError !== (v.error_code !== null)) ctx.addIssue({ code: "custom", message: "ERROR <=> error_code present" });
  if ((v.error_code !== null) !== (v.error_reason !== null)) ctx.addIssue({ code: "custom", message: "error_reason present <=> error_code present" });
  if ((v.resolution_status === "RESOLVED") !== (v.winning_outcome !== "NONE")) ctx.addIssue({ code: "custom", message: "winning_outcome is NONE unless RESOLVED" });
  if (v.resolution_status === "UNRESOLVED" && v.caveats.length === 0) ctx.addIssue({ code: "custom", message: "UNRESOLVED must carry a caveat" });
  if (v.resolution_status === "RESOLVED" && v.determination_basis === null) ctx.addIssue({ code: "custom", message: "RESOLVED must name its determination_basis" });
});
export type PublicVerdict = z.infer<typeof PublicVerdict>;

/**
 * A verdict-shaped record (an internal Verdict, a stored resolutions row, a stored webhook payload's verdict) in the
 * public shape, key order kept: jev_model becomes engine_version in its place, the basis, the error_reason and the checks
 * take their public names, and any other key naming the model (jev_answers, jev_ms) is dropped. Caveats are fixed
 * identifiers that name no model, and pass unchanged like every other field.
 */
export function publicVerdictRecord(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    switch (k) {
      case "jev_model": out.engine_version = engineVersion(typeof val === "string" ? val : null); break;
      case "determination_basis": out[k] = publicBasis(val); break;
      case "error_reason": out[k] = typeof val === "string" ? publicErrorReason(val) : (val ?? null); break;
      case "checks": out[k] = Array.isArray(val) ? val.map(publicCheck) : []; break;
      default: if (!/jev/i.test(k)) out[k] = val;
    }
  }
  return out;
}

/** The internal Verdict as the public contract (PublicVerdict). */
export function toPublicVerdict(v: Verdict): PublicVerdict {
  return publicVerdictRecord(v) as PublicVerdict;
}

/** Webhook events whose payload carries one verdict at payload.verdict: a tenant's (market.*) or a follower's (shadow.committed). */
const VERDICT_EVENTS: ReadonlySet<string> = new Set(["market.resolved", "market.unresolved_update", "market.error", "shadow.committed"]);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const withPublicVerdict = (o: Record<string, unknown>): Record<string, unknown> => (isRecord(o.verdict) ? { ...o, verdict: publicVerdictRecord(o.verdict) } : o);

/**
 * A webhook payload as it is sent: every verdict it carries in the public shape (a market.* or shadow.committed
 * payload's verdict, each shadow.revealed commit's verdict). Applied when the event is queued and again at every
 * attempt, because a payload queued before the mapping keeps its stored form through retries and replays (stored values
 * never change): a market.* row queued before this change, and a shadow.* row queued before shadowVerdict named the
 * basis by venueBasis (a990848), both carry determination_basis "jev". Idempotent, so a payload built public leaves
 * byte for byte as it was stored. Events without a verdict (credits.low, payment.credited) pass unchanged.
 */
export function publicEventPayload(eventType: string, payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if (VERDICT_EVENTS.has(eventType)) return withPublicVerdict(payload);
  if (eventType === "shadow.revealed" && Array.isArray(payload.commits)) return { ...payload, commits: payload.commits.map((c: unknown) => (isRecord(c) ? withPublicVerdict(c) : c)) };
  return payload;
}

/** One track-record row as served: a column or a text value naming the model is renamed (jev_share -> web_evidence_share). */
export function publicTrackRecordRow(r: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/jev/gi, "web_evidence"), typeof v === "string" ? publicText(v) : v]));
}

/** A watch run summary (the fetch:true answer) with its free text in public names. */
export function publicWatchSummary<T extends { detail: string; verdict?: string }>(s: T): T {
  return { ...s, detail: publicText(s.detail), ...(s.verdict !== undefined ? { verdict: publicText(s.verdict) } : {}) };
}

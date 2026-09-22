import type { EvidenceInput, MarketRegistration } from "../resolve/schema";

export interface MarketRow extends MarketRegistration {
  id: string;
  tenant_id: string | null;
  status: "open" | "resolved" | "void" | "unsupported_source";
  official_outcome: "OPTION_A" | "OPTION_B" | "VOID" | null;
  official_resolved_at: string | null;
  official_source_url: string | null;
}

export interface CoverageWindow { from: string; to: string; status: "ok" | "gap" }

export interface WatchRow {
  id: string;
  market_id: string;
  source_kind: "github_api" | "github_events" | "base_log" | "solana_log" | "web_fetch" | "web_render";
  source_ref: Record<string, unknown>;
  poll_interval_s: number;
  etag: string | null;
  cursor: Record<string, unknown>;
  coverage: CoverageWindow[];
  last_evidence_hash: string | null;
  consecutive_errors: number;
  backlog: boolean;
  active: boolean;
  markets?: MarketRow;
}

export interface FetchOutcome {
  /** Nothing changed (304 / same cursor); coverage still advances. */
  notModified?: boolean;
  evidence?: EvidenceInput;
  rawBytes?: Uint8Array;
  etag?: string | null;
  cursor?: Record<string, unknown>;
  /** The observed window this poll covers, for the coverage proof. */
  window?: CoverageWindow;
  backlog?: boolean;
  /** A transport or source error: recorded as a gap window and consecutive_errors++. */
  error?: string;
}

/** Append a window, extending the previous one when contiguous and same status. Keeps jsonb small. */
export function appendWindow(list: CoverageWindow[], w: CoverageWindow, max = 400): CoverageWindow[] {
  const out = list.slice();
  const last = out[out.length - 1];
  if (last && last.status === w.status && Date.parse(w.from) <= Date.parse(last.to) + 1000) last.to = w.to > last.to ? w.to : last.to;
  else out.push({ ...w });
  return out.length > max ? out.slice(out.length - max) : out;
}

/** Summarize windows into the coverage fields the structured resolver checks. */
export function summarizeCoverage(list: CoverageWindow[], openAt: string, deadlineWithGrace: string): { contiguous: boolean; from?: string; to?: string; errors: number } {
  if (!list.length) return { contiguous: false, errors: 0 };
  let errors = 0;
  let contiguous = true;
  for (let i = 0; i < list.length; i++) {
    const w = list[i]!;
    const overlaps = Date.parse(w.to) >= Date.parse(openAt) && Date.parse(w.from) <= Date.parse(deadlineWithGrace);
    if (w.status === "gap" && overlaps) errors++;
    if (i > 0 && Date.parse(w.from) > Date.parse(list[i - 1]!.to) + 1000) contiguous = false;
  }
  return { contiguous: contiguous && errors === 0, from: list[0]!.from, to: list[list.length - 1]!.to, errors };
}

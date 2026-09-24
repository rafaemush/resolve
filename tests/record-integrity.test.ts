/**
 * Migration 017 (static lint; it is never applied from here: scripts/selftest/fixes.ts proves it on a database) and the
 * public track record's distinct-event gate (src/api/public.ts).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GATED_COLUMNS, shapeTrackRecordRow } from "../src/api/public";

const read = (f: string) => readFileSync(resolve(import.meta.dirname, "../supabase/migrations", f), "utf8").replace(/--[^\n]*/g, "");
/** The output columns of the last select of a view definition: the alias after "as", or the bare column name. */
function viewColumns(sql: string): string[] {
  const def = sql.slice(sql.lastIndexOf("view public.v_track_record with"));
  const body = def.slice(0, def.indexOf("comment on view"));
  const list = body.slice(body.lastIndexOf("\nselect ") + 8, body.lastIndexOf("\n  from g"));
  const cols: string[] = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { cols.push(cur); cur = ""; } else cur += ch;
  }
  cols.push(cur);
  return cols.map((c) => { const t = c.trim().replace(/\s+/g, " "); const m = / as (\w+)$/.exec(t); return m ? m[1]! : t; });
}

describe("migration 017 (static lint; never applied from here)", () => {
  const body = read("017_record_integrity.sql");
  const topLevel = body.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");

  it("is one transaction; the only data change fills NULL event_keys", () => {
    expect(body.trim().startsWith("begin;")).toBe(true);
    expect(body.trim().endsWith("commit;")).toBe(true);
    expect(topLevel).not.toMatch(/\bdrop\s+table\b|\bdrop\s+column\b|\bdrop\s+view\b|(^|;)\s*(truncate|delete\s+from)\s/im);
    expect([...topLevel.matchAll(/(^|;)\s*update\s+([^;]+);/gim)].map((m) => m[2]!.replace(/\s+/g, " ").trim())).toEqual(["markets set event_key = market_event_key(platform, external_id, resolver, meta) where event_key is null"]);
  });

  it("v_track_record keeps every column of 012 in place and appends the distinct-event columns", () => {
    const before = viewColumns(read("012_track_record.sql"));
    const after = viewColumns(body);
    expect(before.length).toBeGreaterThan(20);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual(["n_events_committed", "n_events_reconciled", "n_events_reconciled_cumulative", "events_false_resolved", "event_precision", "event_wilson_low", "event_wilson_high", "n_events_decided_cumulative", "events_false_resolved_cumulative"]);
    expect(body).toContain("with (security_invoker = true)");
    expect(body).toMatch(/n_events_reconciled_cumulative >= 100 as is_reportable/);
    for (const c of after.slice(before.length)) expect(body, c).toContain(`comment on column public.v_track_record.${c} is`);
    expect(body).toContain("revoke all on public.v_track_record from public, anon, authenticated;");
  });

  it("every function is commented, sets search_path, is revoked from public/anon/authenticated and granted to service_role", () => {
    const fns = [...body.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]!);
    expect([...fns].sort()).toEqual(["claim_post_lease", "commit_context", "deny_event_key_change", "fill_market_event_key", "market_event_key", "note_post_failure", "release_post_lease"]);
    for (const name of fns) {
      const def = body.slice(body.indexOf(`create or replace function public.${name}(`));
      expect(def.slice(0, def.indexOf("$$")), name).toContain("set search_path = public");
      expect(def.slice(0, def.indexOf("$$")), name).not.toContain("security definer");
      expect(body, name).toMatch(new RegExp(`comment on function public\\.${name}\\(`));
      expect(body, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`));
      expect(body, name).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`));
    }
  });

  it("the new table and column are commented, the table under RLS; nothing in public stays granted to anon or authenticated", () => {
    expect(body).toContain("comment on table post_leases is");
    for (const c of ["channel", "holder", "lease_until", "updated_at"]) expect(body).toContain(`comment on column post_leases.${c} is`);
    expect(body).toContain("select apply_rls('post_leases');");
    expect(body).toContain("comment on column markets.event_key is");
    expect(body).toContain("revoke all on all tables in schema public from anon, authenticated;");
    expect(body).toContain("revoke all on all sequences in schema public from anon, authenticated;");
    // additive for the Worker at 8d67d16: the column is filled for inserts that omit it before NOT NULL is set
    expect(body.indexOf("create trigger markets_event_key_fill")).toBeLessThan(body.indexOf("alter column event_key set not null"));
    expect(body.indexOf("update markets set event_key")).toBeLessThan(body.indexOf("create trigger markets_event_key_locked"));
  });
});

describe("GET /v1/track-record rows (shapeTrackRecordRow)", () => {
  const row = { platform: "polymarket", week: "2026-10-12T00:00:00+00:00", n_reconciled: 24, n_reconciled_cumulative: 150, n_events_reconciled_cumulative: 7, reportable: false, precision: null, event_precision: null, wilson_low: null };
  it("before 100 reconciled events every percentage is the gate, naming events and markets", () => {
    const out = shapeTrackRecordRow(row);
    for (const k of GATED_COLUMNS) expect(out[k]).toBe("n_events=7 (150 markets), not yet reportable: percentages appear at 100 reconciled events");
    expect(out.n_events_reconciled_cumulative).toBe(7);
  });
  it("a reportable row is served as the view returned it", () => {
    const r = { ...row, n_events_reconciled_cumulative: 100, reportable: true, precision: 0.97, event_precision: 0.95 };
    expect(shapeTrackRecordRow(r)).toBe(r);
  });
});

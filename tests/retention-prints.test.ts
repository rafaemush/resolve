/**
 * Migration 022 (static lint; it is never applied from here: scripts/selftest/prints.ts proves it on a database):
 * charge_read (one ledger charge per request id, a replay free, a short balance refused, a "<kind>:" id that can never be
 * a verdict's), purge_retention (loop_runs and closed markets' evidence excerpts older than 30 days, nothing else, and
 * never a table of the record), database_size_bytes, the daily cron job, and the conventions of 019-021 (one
 * transaction, SECURITY DEFINER with a pinned search_path, comments, revoked from public/anon/authenticated, granted to
 * service_role). Also the self-test block itself: every expected key is produced, it rolls back, and it covers every
 * protected table.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PRINTS_BLOCK, PRINTS_EXPECT, PROTECTED_TABLES } from "../scripts/selftest/prints";

const raw = readFileSync(resolve(import.meta.dirname, "../supabase/migrations/022_retention_prints.sql"), "utf8");
const body = raw.replace(/--[^\n]*/g, "");
const topLevel = body.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
/** The body of one function (between its $$ ... $$). */
const fnBody = (name: string) => {
  const at = body.indexOf(`create or replace function public.${name}(`);
  const open = body.indexOf("$$", at);
  return body.slice(open + 2, body.indexOf("$$", open + 2));
};
/** The data-changing statements of a SQL text: [verb, table]. */
const writes = (sql: string) => [...sql.matchAll(/\b(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?([a-z_.]+)/gi)].map((m) => [m[1]!.toLowerCase().replace(/\s+/g, " "), m[2]!.toLowerCase()]);

describe("migration 022 (static lint; never applied from here)", () => {
  it("is one transaction, additive: no table, column or view dropped, no data changed at the top level", () => {
    expect(body.trim().startsWith("begin;")).toBe(true);
    expect(body.trim().endsWith("commit;")).toBe(true);
    expect(topLevel).not.toMatch(/\bdrop\s+(table|column|view|function)\b|\balter\s+table\b|(^|;)\s*(truncate|delete\s+from|update|insert\s+into)\s/im);
  });

  it("every function is SECURITY DEFINER with a pinned search_path, commented, revoked from public/anon/authenticated, granted to service_role only", () => {
    const fns = [...body.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]!);
    expect([...fns].sort()).toEqual(["charge_read", "database_size_bytes", "purge_retention"]);
    for (const name of fns) {
      const head = body.slice(body.indexOf(`create or replace function public.${name}(`));
      const decl = head.slice(0, head.indexOf("$$"));
      expect(decl, name).toContain("security definer");
      expect(decl, name).toMatch(/set search_path = (public|'')/);
      expect(body, name).toMatch(new RegExp(`comment on function public\\.${name}\\(`));
      expect(body, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`));
      expect(body, name).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`));
      expect([...body.matchAll(new RegExp(`grant [^;]*function public\\.${name}\\([^)]*\\) to (\\w+)`, "g"))].map((m) => m[1])).toEqual(["service_role"]);
    }
  });

  it("charge_read: writes one tenants debit and one credit_ledger 'charge' row, nothing else; a replay and a short balance write nothing", () => {
    const f = fnBody("charge_read");
    expect(writes(f)).toEqual([["update", "tenants"], ["insert into", "credit_ledger"]]);
    expect(f).toMatch(/values \(p_tenant, -p_amount, 'charge', p_request_id, v_balance, 'read'\)/);
    // the replay is found before anything is written, by the ledger's unique (reason, request_id)
    expect(f.indexOf("where l.reason = 'charge' and l.request_id = p_request_id")).toBeLessThan(f.indexOf("update tenants"));
    // the debit is conditional: a short balance or a deleted tenant updates nothing
    expect(f).toMatch(/where t\.id = p_tenant and t\.deleted_at is null and t\.credits_balance >= p_amount/);
    expect(f).toMatch(/if v_balance is null then\s+return query select false, false, 0,/);
    // a concurrent duplicate is a replay, its debit rolled back with the block
    expect(f).toMatch(/exception when unique_violation then/);
    // a "<kind>:" id only: begin_resolution's ids are bare hex, so a read never replays a verdict's charge
    expect(f).toContain("p_request_id !~ '^[a-z_]+:.+'");
    expect(f).toMatch(/p_amount is null or p_amount < 1/);
    expect(raw).toMatch(/returns table \(ok boolean, replayed boolean, charged integer, balance integer\)/);
  });

  it("purge_retention: deletes only loop_runs older than 30 days and nulls only evidence.excerpt older than 30 days of markets no longer open", () => {
    const f = fnBody("purge_retention");
    expect(writes(f)).toEqual([["delete from", "loop_runs"], ["update", "evidence"], ["insert into", "loop_runs"], ["insert into", "loop_runs"]]);
    expect(f).toContain("v_cutoff   timestamptz := now() - interval '30 days'");
    expect(f).toMatch(/delete from loop_runs r where r\.started_at < v_cutoff;/);
    expect(f).toMatch(/update evidence e set excerpt = null\s+from markets m\s+where m\.id = e\.market_id and e\.excerpt is not null and e\.created_at < v_cutoff\s+and \(m\.status <> 'open' or m\.deleted_at is not null\);/);
    // the record is never named in the purge at all
    for (const t of PROTECTED_TABLES) expect(f, t).not.toMatch(new RegExp(`\\b${t}\\b`));
    // one loop_runs row per run, success/no_op or failure, with the database size
    expect(f).toContain("'retention_purge'");
    expect(f).toContain("'database_bytes', v_bytes");
    expect(f).toMatch(/exception when others then/);
  });

  it("database_size_bytes is pg_database_size of this database, and the purge runs daily from pg_cron where it exists", () => {
    expect(fnBody("database_size_bytes").trim()).toBe("select pg_catalog.pg_database_size(pg_catalog.current_database());");
    expect(body).toMatch(/perform cron\.unschedule\(jobid\) from cron\.job where jobname = 'purge_retention';\s+perform cron\.schedule\('purge_retention', '23 3 \* \* \*', 'select public\.purge_retention\(\)'\);/);
    expect(body).toMatch(/if exists \(select 1 from pg_extension where extname = 'pg_cron'\) then/);
  });

  it("the retention and the new charge rows are written into the comments", () => {
    for (const c of ["comment on table loop_runs is", "comment on column evidence.excerpt is", "comment on table credit_ledger is"]) expect(body).toContain(c);
    expect(body).toMatch(/Kept 30 days: purge_retention \(migration 022\)/);
  });
});

describe("scripts/selftest/prints.ts (the rollback-only block for migration 022)", () => {
  it("rolls back: one DO block that always ends by raising its results", () => {
    expect(PRINTS_BLOCK.trim().startsWith("do $$")).toBe(true);
    expect(PRINTS_BLOCK.trim().endsWith("end $$;")).toBe(true);
    expect(PRINTS_BLOCK).toContain("raise exception 'SELFTEST_PRINTS %', out::text;");
    expect(PRINTS_BLOCK).not.toMatch(/(^|;)\s*(commit|rollback)\s*;/im);
  });
  it("produces every expected key", () => {
    const missing = Object.keys(PRINTS_EXPECT).filter((k) => !PRINTS_BLOCK.includes(`'${k}'`) && !PRINTS_BLOCK.includes(`"${k}"`));
    expect(missing).toEqual([]);
  });
  it("covers charging once, a free replay, a refused short balance, and a fingerprint of every protected table around the purge", () => {
    expect(PRINTS_EXPECT).toMatchObject({ first: [true, false, 1, 1], replay: [true, true, 0, 1], charge_rows_after_replay: 1, short: [false, false, 0, 0], short_rows: 0, protected_unchanged: true, protected_tables: 5 });
    expect([...PROTECTED_TABLES].sort()).toEqual(["bot_posts", "credit_ledger", "official_observations", "reconciliations", "resolutions"]);
    for (const t of PROTECTED_TABLES) expect(PRINTS_BLOCK.split(`from ${t} x`).length - 1, t).toBe(2);
    expect(PRINTS_BLOCK.indexOf("into fp_before")).toBeLessThan(PRINTS_BLOCK.indexOf("purge := purge_retention();"));
    expect(PRINTS_BLOCK.indexOf("purge := purge_retention();")).toBeLessThan(PRINTS_BLOCK.indexOf("into fp_after"));
  });
});

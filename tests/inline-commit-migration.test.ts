/**
 * Migration 024 (static lint; it is never applied from here: scripts/selftest/inline.ts proves it on a database):
 * redispatch_official_legs() leases each open leg as select_due_watches() does (FOR UPDATE SKIP LOCKED, a live lease never
 * run beside), for 30 s, signs a stamp to the second and never touches next_poll_at; claim_watch_dispatch() keeps every
 * answer of 019 and reads both stamps; used_dispatch_signatures.minute widens to the Worker's two stamp forms; the
 * conventions of 019-023 (one transaction, additive, SECURITY DEFINER with a pinned search_path, comments, revoked from
 * public/anon/authenticated, granted to service_role); and the self-test block (rolls back, produces every expected key).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INLINE_BLOCK, INLINE_EXPECT } from "../scripts/selftest/inline";
import { stampMs } from "../src/api/dispatch-auth";

const raw = readFileSync(resolve(import.meta.dirname, "../supabase/migrations/024_inline_commit.sql"), "utf8");
const body = raw.replace(/--[^\n]*/g, "");
const topLevel = body.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
const fnBody = (name: string) => {
  const at = body.indexOf(`create or replace function public.${name}(`);
  const open = body.indexOf("$$", at);
  return body.slice(open + 2, body.indexOf("$$", open + 2));
};
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("migration 024 (static lint; never applied from here)", () => {
  it("states why, its compatibility with the Worker deployed before it, and that it is idempotent", () => {
    const header = raw.slice(0, raw.indexOf("begin;"));
    for (const w of ["WHY:", "Compatibility with the Worker deployed before this migration", "Idempotent", "single-use", "MEASURED 2026-10-02"]) expect(header, w).toContain(w);
  });

  it("is one transaction, additive: nothing dropped but the one check it widens; no data changed at the top level", () => {
    expect(body.trim().startsWith("begin;")).toBe(true);
    expect(body.trim().endsWith("commit;")).toBe(true);
    expect(topLevel).not.toMatch(/\bdrop\s+(table|column|view|function|index)\b/i);
    const alters = [...topLevel.matchAll(/alter table ([a-z_]+) ([^;]+);/g)].map((m) => `${m[1]} ${flat(m[2]!)}`);
    expect(alters).toEqual([
      "used_dispatch_signatures drop constraint if exists used_dispatch_signatures_minute_check",
      "used_dispatch_signatures add constraint used_dispatch_signatures_minute_check check (minute ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?$')",
    ]);
    expect(topLevel).not.toMatch(/(^|;)\s*(truncate|delete\s+from|update|insert\s+into)\s/im);
  });

  it("every function is SECURITY DEFINER with a pinned search_path, commented, revoked from public/anon/authenticated, granted to service_role only", () => {
    const fns = [...body.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]!);
    expect([...fns].sort()).toEqual(["claim_watch_dispatch", "redispatch_official_legs"]);
    for (const name of fns) {
      const head = body.slice(body.indexOf(`create or replace function public.${name}(`));
      const decl = head.slice(0, head.indexOf("$$"));
      expect(decl, name).toContain("security definer");
      expect(decl, name).toMatch(/set search_path = public/);
      expect(body, name).toMatch(new RegExp(`comment on function public\\.${name}\\(`));
      expect(body, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`));
      expect([...body.matchAll(new RegExp(`grant [^;]*function public\\.${name}\\([^)]*\\) to (\\w+)`, "g"))].map((m) => m[1])).toEqual(["service_role"]);
    }
    expect(body).toContain("comment on column used_dispatch_signatures.minute is");
    expect(body).toContain("comment on constraint used_dispatch_signatures_minute_check on used_dispatch_signatures is");
  });

  it("the stamp the check accepts is exactly the stamp the Worker accepts on the watch route (minute, or second for a redispatch)", () => {
    const check = /check \(minute ~ '([^']+)'\)/.exec(body)![1]!;
    const re = new RegExp(check);
    for (const s of ["2026-10-14T12:30", "2026-10-14T12:30:09", "2026-10-14T12:30:9", "2026-10-14T12:30:09Z", "2026-10-14 12:30", "2026-10-14T12:30:09.000"]) {
      expect(re.test(s), s).toBe(Number.isFinite(stampMs(s, true)));
    }
  });

  it("redispatch_official_legs: the lease condition of select_due_watches, a 30 s lease, a stamp to the second, next_poll_at untouched", () => {
    const f = flat(fnBody("redispatch_official_legs"));
    expect(f).toContain("for update of w skip locked");
    expect(f).toContain("(w.lease_until is null or w.lease_until < now() or (p_holder_too and w.id = p_holder))");
    expect(f).toContain("(p_holder is null or w.id <> p_holder or p_holder_too)");
    expect(f).toContain("set lease_until = now() + interval '30 seconds'");
    expect(f).not.toMatch(/next_poll_at\s*=/);
    expect(f).toContain(`to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS')`);
    expect(f).toContain("r.id::text || '|' || v_stamp");
    expect(f).toContain("'X-Internal-Minute', v_stamp");
    expect(f).toContain("v_url || '/internal/watch/' || r.id::text");
    // only open legs of these series and period: an active official_release watch of an open, undeleted market
    expect(f).toContain("w.active and w.deleted_at is null and w.source_kind = 'official_release'");
    expect(f).toContain("m.status = 'open' and m.deleted_at is null and m.resolver->>'kind' = 'official_release'");
    expect(f).toContain("m.resolver->>'series' = any(p_series) and m.resolver->>'period' = p_period");
    // the daily cap, and a row for every outcome; "could not dispatch" answers skipped or failure, never 0 dispatched alone
    expect(f).toContain("v_today >= coalesce(v_cap, 50000)");
    for (const o of ["'skipped'", "'failure'", "case when n > 0 then 'success' else 'no_op' end"]) expect(f, o).toContain(o);
    expect(f).toContain("exception when others then");
    for (const k of ["'outcome', 'skipped'", "'outcome', 'failure'", "'outcome', 'dispatched'"]) expect(f, k).toContain(k);
  });

  it("claim_watch_dispatch: every answer of 019, the signed time read from either stamp, 019's 180 s for a minute stamp and 60 s for a second stamp", () => {
    const f = flat(fnBody("claim_watch_dispatch"));
    for (const a of ["signature_used", "watch_not_found", "lease_missing", "lease_expired", "lease_superseded", "claimed"]) expect(f, a).toContain(`'${a}'`);
    expect(f).toContain("case when length(p_minute) = 19 then (p_minute || '+00')::timestamptz else (p_minute || ':00+00')::timestamptz end");
    // A second stamp's threshold is its own: 180 s would let a late redispatch POST run beside a later 120 s lease
    // (taken at S + 30 s or after, ending at S + 150 s or after), the double run 019 refuses.
    expect(f).toContain("if v_lease >= v_signed + (case when length(p_minute) = 19 then interval '60 seconds' else interval '180 seconds' end) then return 'lease_superseded'; end if;");
    expect(f).not.toMatch(/v_lease >= v_signed \+ interval '180 seconds'/);
    expect(f).toContain("update watches set lease_until = greatest(lease_until, now() + interval '120 seconds') where id = p_watch;");
    // INSERT first, before any read
    expect(f.indexOf("insert into used_dispatch_signatures")).toBeLessThan(f.indexOf("select lease_until into v_lease"));
  });

  it("the self-test block rolls back and produces every expected key", () => {
    expect(INLINE_BLOCK.trim().startsWith("do $$")).toBe(true);
    expect(INLINE_BLOCK.trim().endsWith("end $$;")).toBe(true);
    expect(INLINE_BLOCK).toContain("raise exception 'SELFTEST_INLINE %', out::text;");
    expect(INLINE_BLOCK).not.toMatch(/(^|;)\s*(commit|rollback)\s*;/im);
    const missing = Object.keys(INLINE_EXPECT).filter((k) => !INLINE_BLOCK.includes(`'${k}'`) && !INLINE_BLOCK.includes(`"${k}"`));
    expect(missing).toEqual([]);
    // the POSTs it queues can never reach a Worker
    expect(INLINE_BLOCK).toContain("'worker_base_url', 'https://selftest.invalid'");
  });
});

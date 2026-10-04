/**
 * Migration 023 (static lint; it is never applied from here: scripts/selftest/reveal.ts proves it on a database):
 * charge_reveals (the tenant rows locked first in id order, a settled market public and free, each replay found before any
 * money moves and a read's replay recorded in reveal_reads, a short balance refused with nothing written, the event cap
 * net of refunds, one ledger charge per (tenant, market), no unique_violation handler), refund_late_reveals (webhook
 * charges only, past their deadline, their tenants locked first in id order, none attempted or delivered in time and none
 * read; refund_credits, once), claim_webhook_deliveries (priority first, then first attempts), follow_event (all or
 * nothing under the tenant lock), the new columns, table and indexes, storage_status's refund keys, the 5-minute cron
 * job, and the conventions of 019-022 (one transaction, additive,
 * SECURITY DEFINER with a pinned search_path, comments, revoked from public/anon/authenticated, granted to service_role).
 * Also the self-test block itself: every expected key is produced, it rolls back, and the concurrency probe races
 * charge_reveals.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REVEAL_BLOCK, REVEAL_EXPECT } from "../scripts/selftest/reveal";
import { REVEAL_LATE_MINUTES } from "../src/shadow/reveal";

const raw = readFileSync(resolve(import.meta.dirname, "../supabase/migrations/023_priced_reveal.sql"), "utf8");
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
/** Statement text collapsed to single spaces, for matching across lines. */
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("migration 023 (static lint; never applied from here)", () => {
  it("is one transaction, additive: no table, column, view or function dropped; alter table only adds columns and (re)adds constraints", () => {
    expect(body.trim().startsWith("begin;")).toBe(true);
    expect(body.trim().endsWith("commit;")).toBe(true);
    expect(topLevel).not.toMatch(/\bdrop\s+(table|column|view|function|index)\b/i);
    for (const m of topLevel.matchAll(/alter table ([a-z_]+) ([^;]+);/g)) {
      expect(m[1], m[0]).toBe("webhook_deliveries");
      expect(m[2], m[0]).toMatch(/^(add column if not exists \w+ |drop constraint if exists \w+$|add constraint \w+ check )/);
    }
    // no data is changed at the top level: rows the Worker deployed before 023 queues stand as they are
    expect(topLevel).not.toMatch(/(^|;)\s*(truncate|delete\s+from|update|insert\s+into)\s/im);
  });

  it("every function is SECURITY DEFINER with a pinned search_path, commented, revoked from public/anon/authenticated, granted to service_role only", () => {
    const fns = [...body.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]!);
    expect([...fns].sort()).toEqual(["charge_reveals", "claim_webhook_deliveries", "follow_event", "refund_late_reveals", "storage_status"]);
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

  it("the new columns: priority 0-3 defaulting to 0 (the old Worker's inserts stand), a reveal charge only with its deadline, each commented", () => {
    expect(body).toContain("alter table webhook_deliveries add column if not exists priority smallint not null default 0;");
    expect(body).toContain("alter table webhook_deliveries add column if not exists reveal_charge_id text;");
    expect(body).toContain("alter table webhook_deliveries add column if not exists reveal_due_at timestamptz;");
    expect(body).toContain("alter table webhook_deliveries add column if not exists first_attempt_at timestamptz;");
    expect(flat(body)).toContain("check (priority between 0 and 3)");
    expect(flat(body)).toContain("(reveal_charge_id is null and reveal_due_at is null) or (reveal_charge_id ~ '^reveal:[0-9a-f-]{36}:[0-9a-f-]{36}$' and reveal_due_at is not null and event_type = 'shadow.committed')");
    for (const c of ["priority", "reveal_charge_id", "reveal_due_at", "first_attempt_at"]) expect(body, c).toContain(`comment on column webhook_deliveries.${c} is`);
    for (const i of ["idx_webhook_deliveries_claim", "idx_webhook_deliveries_reveal_charge", "idx_ledger_reveal_webhook", "idx_markets_event_key"]) {
      expect(body, i).toMatch(new RegExp(`create index if not exists ${i} on `));
      expect(body, i).toContain(`comment on index ${i} is`);
    }
    // the refund sweep's index covers exactly the rows it scans
    expect(body).toContain("on credit_ledger (created_at) where reason = 'charge' and note = 'reveal webhook';");
  });

  it("reveal_reads: one row per reveal charge read back, the charge's id as key, RLS applied, revoked from the API roles, every column commented", () => {
    expect(flat(body)).toContain("create table if not exists reveal_reads ( request_id text primary key check (request_id ~ '^reveal:[0-9a-f-]{36}:[0-9a-f-]{36}$'), tenant_id uuid not null references tenants(id), first_read_at timestamptz not null default now() );");
    expect(body).toContain("select apply_rls('reveal_reads');");
    expect(body).toContain("revoke all on table reveal_reads from public, anon, authenticated;");
    expect(body).toContain("comment on table reveal_reads is");
    for (const c of ["request_id", "tenant_id", "first_read_at"]) expect(body, c).toContain(`comment on column reveal_reads.${c} is`);
    // written by charge_reveals only, read by refund_late_reveals only
    expect([...body.matchAll(/insert into reveal_reads/g)]).toHaveLength(1);
    expect(fnBody("charge_reveals")).toContain("insert into reveal_reads");
    expect(fnBody("refund_late_reveals")).toContain("from reveal_reads rr");
  });

  describe("charge_reveals", () => {
    const f = fnBody("charge_reveals");
    it("writes one tenants debit and one credit_ledger 'charge' row per charged pair and a read's replay receipt, nothing else (the low-credit claim is claim_low_credit_notice's)", () => {
      expect(writes(f)).toEqual([["insert into", "reveal_reads"], ["update", "tenants"], ["insert into", "credit_ledger"]]);
      expect(flat(f)).toContain("insert into credit_ledger (tenant_id, delta, reason, request_id, balance_after, note) values (v_pair.t, -v_due, 'charge', v_id, v_balance, 'reveal ' || p_source);");
      expect(f).toContain("v_id := 'reveal:' || v_pair.t::text || ':' || v_pair.m::text;");
      expect(raw).toMatch(/returns table \(tenant_id uuid, market_id uuid, plan text, entitled_full boolean, replayed boolean, charged integer,\s+price integer, balance integer, reason text, low_credit boolean, low_credit_threshold integer\)/);
    });
    it("locks every tenant row first, in id order, before the ledger is read at all (two publishes sharing followers cannot deadlock; a duplicate waits and replays)", () => {
      const lock = f.indexOf("perform 1 from tenants t where t.id = any(p_tenants) order by t.id for update;");
      expect(lock).toBeGreaterThan(0);
      expect(lock).toBeLessThan(f.indexOf("from credit_ledger"));
      expect(lock).toBeLessThan(f.indexOf("for v_pair in"));
      // pairs in (tenant, event_key, market) order, so an event's legs in one call add up under the cap deterministically
      expect(flat(f)).toContain("order by x.t, ek, x.m loop");
    });
    it("the rules in order: unknown tenant, included plan, grandfathered free key, replay, event cap, short balance, then the charge", () => {
      const at = (needle: string) => { const i = f.indexOf(needle); expect(i, needle).toBeGreaterThan(0); return i; };
      const order = [
        at("'unknown_tenant'::text"), at("if v_pair.settled then"), at("if v_ten.pl = any(p_included_plans) then"), at("if v_ten.pl = 'free' and v_ten.created < p_pricing_from then"),
        at("where l.reason = 'charge' and l.request_id = v_id;"), at("v_due := least(p_price, greatest(p_event_cap - v_spent, 0));"),
        at("if v_ten.bal < v_due then"), at("update tenants t set credits_balance"),
      ];
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
    it("a replay is answered free before any debit (without the branch a replay at a short balance would be locked, a paid reveal withheld); a read's replay leaves its receipt, nothing else", () => {
      expect(flat(f)).toMatch(/select l\.tenant_id into v_owner from credit_ledger l where l\.reason = 'charge' and l\.request_id = v_id; if found then if v_owner is distinct from v_pair\.t then raise exception using errcode = 'RS003'[^;]*; end if; if p_source = 'read' then insert into reveal_reads \(request_id, tenant_id\) values \(v_id, v_pair\.t\) on conflict \(request_id\) do nothing; end if; return query select v_pair\.t, v_pair\.m, v_ten\.pl, true, true, 0, 0, v_ten\.bal, 'replay'::text, null::boolean, null::integer; continue; end if;/);
      expect(f.indexOf("'replay'::text")).toBeLessThan(f.indexOf("if v_ten.bal < v_due then"));
    });
    it("a settled market (resolved, void, closed_unresolved) is public: free and entitled, before any plan rule or ledger read", () => {
      expect(flat(f)).toContain("mk.status in ('resolved', 'void', 'closed_unresolved') as settled");
      expect(flat(f)).toContain("if v_pair.settled then return query select v_pair.t, v_pair.m, v_ten.pl, true, false, 0, 0, v_ten.bal, 'public'::text, null::boolean, null::integer; continue; end if;");
      expect(f.indexOf("if v_pair.settled then")).toBeLessThan(f.indexOf("where l.reason = 'charge' and l.request_id = v_id;"));
    });
    it("the event cap sums what this tenant paid for the event's legs, net of refunds, by the ledger's unique ids", () => {
      expect(flat(f)).toContain("select coalesce(sum(-c.delta - coalesce(r.delta, 0)), 0)::integer into v_spent from markets mk join credit_ledger c on c.reason = 'charge' and c.request_id = 'reveal:' || v_pair.t::text || ':' || mk.id::text left join credit_ledger r on r.reason = 'refund' and r.request_id = c.request_id where mk.event_key = v_pair.ek;");
      expect(flat(f)).toContain("if v_due = 0 then return query select v_pair.t, v_pair.m, v_ten.pl, true, false, 0, 0, v_ten.bal, 'event_cap_reached'::text");
    });
    it("a short balance answers locked and writes nothing; only the charged branch reaches the debit", () => {
      expect(flat(f)).toMatch(/if v_ten\.bal < v_due then return query select v_pair\.t, v_pair\.m, v_ten\.pl, false, false, 0, v_due, v_ten\.bal, 'insufficient_credits'::text, null::boolean, null::integer; continue; end if; update tenants t set credits_balance = t\.credits_balance - v_due where t\.id = v_pair\.t/);
    });
    it("no unique_violation handler: the only exception block wraps the low-credit claim, after the ledger row", () => {
      expect(f).not.toMatch(/unique_violation/);
      expect([...f.matchAll(/\bexception\s+when\b/g)]).toHaveLength(1);
      const handler = f.indexOf("exception when others then");
      expect(f.lastIndexOf("begin", handler)).toBeGreaterThan(f.indexOf("insert into credit_ledger"));
      expect(f.slice(f.lastIndexOf("begin", handler), handler)).toContain("from claim_low_credit_notice(v_pair.t) c;");
      expect(flat(f.slice(handler))).toMatch(/^exception when others then v_low := null; v_threshold := null; end;/);
    });
    it("refuses a bad price, cap, source, pair list and a market that is not a public shadow market (22023)", () => {
      expect(f).toContain("if p_price is null or p_price < 1 or p_event_cap is null or p_event_cap < p_price then");
      expect(f).toContain("if p_source is null or p_source not in ('webhook', 'read') then");
      expect(f).toContain("coalesce(cardinality(p_tenants), 0) > 1000");
      expect(flat(f)).toContain("(mk.id is not null and mk.tenant_id is null and not mk.is_test) as public_market");
      expect(flat(f)).toContain("if not v_pair.public_market then raise exception using errcode = '22023'");
    });
  });

  describe("refund_late_reveals: the refund rule", () => {
    const f = fnBody("refund_late_reveals");
    it("writes only its loop_runs row (success, no_op or failure); the money moves through refund_credits(), once per request id", () => {
      expect(writes(f)).toEqual([["insert into", "loop_runs"], ["insert into", "loop_runs"]]);
      expect(f).toContain("v_amount := refund_credits(v_charge.request_id);");
      expect(f).toContain("'reveal_refund'");
    });
    it("webhook charges only (a read's charge is never refunded), not refunded yet, past their deadline", () => {
      const q = flat(f);
      expect(q).toContain("where c.reason = 'charge' and c.note = 'reveal webhook' and c.created_at > now() - interval '3 days'");
      expect(q).toContain("and not exists (select 1 from credit_ledger x where x.reason = 'refund' and x.request_id = c.request_id)");
      expect(q).toContain("and now() >= coalesce((select min(d.reveal_due_at) from webhook_deliveries d where d.reveal_charge_id = c.request_id), c.created_at + make_interval(mins => p_late_minutes))");
      expect(f).not.toContain("reveal read");
    });
    it("owed only when no delivery was attempted or delivered by the deadline and the tenant did not read it (an attempt in time stands, whatever the endpoint answered)", () => {
      const q = flat(f);
      expect(q).toContain("and not exists (select 1 from webhook_deliveries d where d.reveal_charge_id = c.request_id and (d.first_attempt_at <= d.reveal_due_at or (d.status = 'delivered' and d.delivered_at <= d.reveal_due_at)))");
      expect(q).toContain("and not exists (select 1 from reveal_reads rr where rr.request_id = c.request_id)");
      // a delivery in flight under a live lease may have POSTed (first_attempt_at is written with its outcome): decided next run
      expect(q).toContain("and not exists (select 1 from webhook_deliveries d where d.reveal_charge_id = c.request_id and d.status = 'delivering' and d.lease_until > now())");
      // the receiver's answer (dlq, last_status_code) is never what decides it
      expect(f).not.toMatch(/status = 'dlq'|last_status_code/);
    });
    it("locks every tenant of its charges first, in id order (as charge_reveals), and decides after the lock: it cannot deadlock with a publish", () => {
      const q = flat(f);
      const lock = q.indexOf("perform 1 from tenants t where t.id in (select c.tenant_id from credit_ledger c where c.reason = 'charge' and c.request_id = any(v_ids)) order by t.id for update;");
      expect(lock).toBeGreaterThan(0);
      expect(lock).toBeLessThan(q.indexOf("for v_charge in"));
      expect(lock).toBeLessThan(q.indexOf("refund_credits("));
      expect(q).toContain("order by c.tenant_id, c.created_at loop");
      // the owed conditions are read after the lock
      expect(q.indexOf("from reveal_reads rr")).toBeGreaterThan(lock);
      expect(q.indexOf("d.first_attempt_at <= d.reveal_due_at")).toBeGreaterThan(lock);
    });
    it("a refund that fails is reported and the others stand; an error outside them rolls the run back and is recorded", () => {
      expect(flat(f)).toMatch(/begin v_amount := refund_credits\(v_charge\.request_id\);[^]*?exception when others then v_failed := v_failed \+ 1;/);
      expect(flat(f)).toContain("case when v_failed > 0 then 'failure' when v_n > 0 then 'success' else 'no_op' end");
    });
    it("runs every 5 minutes from pg_cron with the Worker's 10-minute window", () => {
      expect(REVEAL_LATE_MINUTES).toBe(10);
      expect(flat(body)).toContain("perform cron.unschedule(jobid) from cron.job where jobname = 'refund_late_reveals'; perform cron.schedule('refund_late_reveals', '*/5 * * * *', 'select public.refund_late_reveals(10)');");
    });
  });

  it("claim_webhook_deliveries: the same signature and lease, highest priority first, then first attempts before retries, then the oldest due", () => {
    const f = flat(fnBody("claim_webhook_deliveries"));
    expect(raw).toMatch(/create or replace function public\.claim_webhook_deliveries\(p_max integer default 10\)\s+returns setof webhook_deliveries language sql security definer set search_path = public as/);
    expect(f).toContain("where status = 'pending' and next_attempt_at <= now() and (lease_until is null or lease_until < now()) order by priority desc, attempt, next_attempt_at, id limit p_max for update skip locked");
    expect(body).toContain("create index if not exists idx_webhook_deliveries_claim on webhook_deliveries (priority desc, attempt, next_attempt_at) where status = 'pending';");
    expect(f).toContain("set status = 'delivering', lease_until = now() + interval '60 seconds'");
  });

  describe("follow_event", () => {
    const f = fnBody("follow_event");
    it("locks the tenant row first, reads the legs once, refuses past the cap before anything is written, inserts only legs not followed", () => {
      expect(writes(f)).toEqual([["insert into", "market_follows"]]);
      const lock = f.indexOf("perform 1 from tenants t where t.id = p_tenant and t.deleted_at is null for update;");
      expect(lock).toBeGreaterThan(0);
      expect(lock).toBeLessThan(f.indexOf("from markets m"));
      expect(flat(f)).toContain("where m.event_key = v_market.event_key and m.tenant_id is null and not m.is_test and m.deleted_at is null and m.status = 'open';");
      expect(f.indexOf("'cap_reached'")).toBeLessThan(f.indexOf("insert into market_follows"));
      expect(flat(f)).toContain("if p_cap is not null and v_new > 0 and v_active + v_new > p_cap then");
      expect(flat(f)).toContain("select p_tenant, l.id from unnest(v_legs) as l(id) where not exists (select 1 from market_follows f where f.tenant_id = p_tenant and f.market_id = l.id and f.deleted_at is null);");
    });
  });

  it("storage_status keeps its three keys and adds the refund rule's newest run and cron job; it reads only", () => {
    const f = fnBody("storage_status");
    expect(writes(f)).toEqual([]);
    for (const k of ["'database_bytes'", "'purge_scheduled'", "'last_purge'", "'refund_scheduled'", "'last_refund'"]) expect(f, k).toContain(k);
    expect(flat(f)).toContain("from public.loop_runs r where r.loop_name = 'reveal_refund' order by r.started_at desc limit 1;");
    expect(f).toContain("j.jobname = ''refund_late_reveals'' and j.active");
  });
});

describe("scripts/selftest/reveal.ts (the rollback-only block for migration 023)", () => {
  it("rolls back: one DO block that always ends by raising its results", () => {
    expect(REVEAL_BLOCK.trim().startsWith("do $$")).toBe(true);
    expect(REVEAL_BLOCK.trim().endsWith("end $$;")).toBe(true);
    expect(REVEAL_BLOCK).toContain("raise exception 'SELFTEST_REVEAL %', out::text;");
    expect(REVEAL_BLOCK).not.toMatch(/(^|;)\s*(commit|rollback)\s*;/im);
  });
  it("produces every expected key, and expects none left undefined", () => {
    const missing = Object.keys(REVEAL_EXPECT).filter((k) => !REVEAL_BLOCK.includes(`'${k}'`) && !REVEAL_BLOCK.includes(`"${k}"`));
    expect(missing).toEqual([]);
    expect(Object.entries(REVEAL_EXPECT).filter(([, v]) => v === undefined)).toEqual([]);
  });
  it("reads what a charge wrote in a statement of its own (the charge's statement sees its snapshot, from before)", () => {
    expect(REVEAL_BLOCK).toMatch(/out := out \|\| jsonb_build_object\('first', \(select [^;]+ from charge_reveals\([^;]+\) c\)\);\s+out := out \|\| jsonb_build_object\('ledger_row', \(select [^;]+ from credit_ledger l [^;]+\)\);/);
    expect(REVEAL_BLOCK).toMatch(/jsonb_build_object\('replay_read', \(select [^;]+\) c\)\);\s+out := out \|\| jsonb_build_object\('replay_rows'/);
    // no statement both charges and reads the ledger or a balance
    for (const stmt of REVEAL_BLOCK.split(";")) if (/from charge_reveals\(/.test(stmt)) expect(stmt, stmt.slice(0, 120)).not.toMatch(/from credit_ledger|credits_balance from tenants/);
  });
  it("covers the charge once, the replay free from either source, the locked short balance, a settled market public, the cap net of refunds and the refund rule", () => {
    expect(REVEAL_EXPECT).toMatchObject({
      first: [true, false, 25, 35, "charged"], replay_read: [true, true, 0, 35, "replay"], replay_rows: 1, short: [false, 0, 25, 10, "insufficient_credits"], short_rows: 0,
      settled_public: [true, false, 0, 10, "public"], settled_rows: 0,
      event_cap: [[25, "charged"], [0, "event_cap_reached"]], cap_after_refund: [25, "charged"], claim_first_attempt_first: true, read_receipt: 1,
      // dlq without an attempt, delivered in time, attempted and delivered late, not due, a read's charge, attempted in time then dlq, read back
      refunded: [1, 0, 1, 0, 0, 0, 0], reveal_reads_rls: true, reveal_reads_anon: false,
    });
    // the attempted-in-time row carries first_attempt_at before its deadline; the read-back charge is read in a statement of its own
    expect(flat(REVEAL_BLOCK)).toContain("(ep, tr, 'shadow.committed', '{}', 'dlq', now() - interval '3 minutes', 'reveal:' || tr || ':' || rp6, now() - interval '1 minute')");
    expect(REVEAL_BLOCK).toMatch(/c;\s+-- the tenant reads rp7 back: a replay\s+out := out \|\| jsonb_build_object\('read_receipt'/);
  });
  it("the persisting staging probe races charge_reveals: 10 parallel calls for one pair at the last 25 credits, one charge and nine replays", () => {
    const probe = readFileSync(resolve(import.meta.dirname, "../scripts/selftest-db.ts"), "utf8");
    expect(probe).toMatch(/bad \+= await concurrencyProbe\(\) \+ await chargeReadProbe\(\) \+ await chargeRevealsProbe\(\);/);
    const fn = probe.slice(probe.indexOf("async function chargeRevealsProbe()"));
    expect(fn).toContain("values ('__selftest_concurrency_reveal__', 'payg', 25)");
    expect(fn).toMatch(/Array\.from\(\{ length: 10 \}, \(\) => sql<[^>]+>\(`select \* from charge_reveals\(array\['\$\{tid\}'\]::uuid\[\], array\['\$\{mid\}'\]::uuid\[\], 25, 2000, now\(\)/);
    expect(fn).toContain("const ok = cnt!.charges === 1 && cnt!.balance === 0 && charged === 1 && replayed === 9;");
  });
});

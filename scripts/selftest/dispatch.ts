/**
 * Migration 019 against a real database, in one DO block that always raises at the end, so everything it wrote rolls
 * back and nothing persists; the raised message carries the results, printed as PASS/FAIL lines.
 *   claim_watch_dispatch(): the first claim of a leased watch's (watch_id, minute) is claimed, the second
 *     signature_used; a released (null) lease, an expired lease and an unknown watch are refused, and the signature
 *     they presented stays used; the lease must be the one the signed minute took (ends before minute + 180 s: 170 s
 *     is claimed, 180 s and 181 s are lease_superseded, as is a tenant fetch's lease seen by a late dispatch); a claim
 *     extends the lease to now + 120 s; gc_dispatch_signatures() deletes rows older than 2 days only.
 *   lease_watch_now(): takes a free or expired lease (now + 120 s), refuses a live one and an unknown watch (null).
 *   register_market(): a market and its watches land together; the same key answers existing, writing nothing, even at
 *     the tenant's limit; watch_limit counts the tenant's active watches plus the new ones; max_base_watches counts
 *     active base_log watches service-wide; an unsupported_source market with watches is refused; a smoke market is a
 *     test market; a soft-deleted twin keeps its key taken (23505).
 *   Locks: register_market() locks the tenant row FOR UPDATE (its xmax becomes this transaction's id, observed on a
 *     call that inserts nothing, so no foreign-key check can have locked the row instead) and takes the Base advisory
 *     lock only when it adds base_log watches (pg_locks, this backend, before and after). Both are what serializes
 *     concurrent registrations; a second session is not needed to see that they are taken.
 *   Privileges: service_role may claim, lease, register and read the ledger but not write it directly; anon may do
 *     none of it.
 *
 *   npx tsx scripts/selftest/dispatch.ts                  through the Management API (SUPABASE_PROJECT_REF + token)
 *   npx tsx scripts/selftest/dispatch.ts --psql <conninfo> through psql, e.g. a throwaway local cluster
 * Refused unless SUPABASE_PROJECT_REF equals STAGING_SUPABASE_PROJECT_REF, or RESOLVE_SELFTEST_NON_PRODUCTION=1 names
 * the target as staging or local. The block rolls back, but it is never run against production.
 */
import { spawnSync } from "node:child_process";
import { loadEnv } from "../lib/env";
import { sql } from "../lib/mgmt";

const TAG = "SELFTEST_DISPATCH";

export const DISPATCH_BLOCK = `
do $$
declare out jsonb := '{}'::jsonb; m uuid; w_ok uuid; w_null uuid; w_old uuid; w_170 uuid; w_180 uuid; w_181 uuid; w_short uuid;
  w_free uuid; w_live uuid; w_gone uuid; t uuid; t_lock uuid; r jsonb; r2 jsonb; n integer; base_before integer; l timestamptz;
  signed constant timestamptz := '2099-01-01T00:00:00+00';
  this_minute constant text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI');
  base_key constant bigint := hashtextextended('resolve.register_market.max_base_watches', 0);
  base_lock constant text := 'select exists (select 1 from pg_locks where locktype = ''advisory'' and pid = pg_backend_pid() and granted and objsubid = 1 and classid = (($1 >> 32) & 4294967295)::bigint::oid and objid = ($1 & 4294967295)::bigint::oid)';
  held boolean;
  mk constant text := 'insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc, tenant_id) values (''custom'', $1, ''selftest condition'', ''selftest statement'', ''Yes'', ''No'', ''OPTION_A'', now() - interval ''1 day'', now() + interval ''1 day'', $2) returning id';
  body constant jsonb := '{"platform":"custom","condition":"selftest condition","event_statement":"selftest statement","option_a":"Yes","option_b":"No","positive_option":"OPTION_A","anchors":["selftest"],"sources":[{"kind":"github_api","ref":"repos/o/r/pulls/1"}],"resolver":null,"negative_rule":"absence_after_deadline","allow_prerelease":false,"open_at":"2026-01-01T00:00:00Z","deadline_utc":"2099-01-01T00:00:00Z","grace_seconds":3600,"status":"open","meta":{"registration_reasons":[]},"condition_id":null,"is_test":false}';
  gh constant jsonb := '{"source_kind":"github_api","source_ref":{"ref":"repos/o/r/pulls/1"},"cursor":{},"poll_interval_s":300}';
  bl constant jsonb := '{"source_kind":"base_log","source_ref":{"chain":"base","address":"0x0000000000000000000000000000000000000001","topic0":null},"cursor":{},"poll_interval_s":300}';
begin
  -- claim_watch_dispatch -------------------------------------------------------------------------------------------
  execute mk into m using '__selftest_dispatch__', null::uuid;
  insert into watches (market_id, source_kind, source_ref, lease_until) values (m, 'github_api', '{"ref":"repos/o/r/pulls/1"}', now() + interval '120 seconds') returning id into w_ok;
  insert into watches (market_id, source_kind, source_ref, lease_until) values (m, 'github_api', '{"ref":"repos/o/r/pulls/2"}', null) returning id into w_null;
  insert into watches (market_id, source_kind, source_ref, lease_until) values (m, 'github_api', '{"ref":"repos/o/r/pulls/3"}', now() - interval '1 second') returning id into w_old;
  out := out || jsonb_build_object(
    'claim_first', claim_watch_dispatch(w_ok, '2099-01-01T00:00'),
    'claim_replay', claim_watch_dispatch(w_ok, '2099-01-01T00:00'),
    'claim_next_minute', claim_watch_dispatch(w_ok, '2099-01-01T00:01'),
    'claim_lease_null', claim_watch_dispatch(w_null, '2099-01-01T00:00'),
    'claim_lease_null_replay', claim_watch_dispatch(w_null, '2099-01-01T00:00'),
    'claim_lease_expired', claim_watch_dispatch(w_old, '2099-01-01T00:00'),
    'claim_unknown_watch', claim_watch_dispatch(gen_random_uuid(), '2099-01-01T00:00'));
  begin perform claim_watch_dispatch(w_ok, '2099-01-01 00:02'); out := out || '{"claim_bad_minute":"allowed"}';
  exception when check_violation then out := out || '{"claim_bad_minute":"refused"}'; end;
  -- the lease must be the one minute 2099-01-01T00:00 took: select_due_watches() sets now() + 120 s inside the minute
  insert into watches (market_id, source_kind, source_ref, lease_until) values (m, 'github_api', '{"ref":"repos/o/r/pulls/4"}', signed + interval '170 seconds') returning id into w_170;
  insert into watches (market_id, source_kind, source_ref, lease_until) values (m, 'github_api', '{"ref":"repos/o/r/pulls/5"}', signed + interval '180 seconds') returning id into w_180;
  insert into watches (market_id, source_kind, source_ref, lease_until) values (m, 'github_api', '{"ref":"repos/o/r/pulls/6"}', signed + interval '181 seconds') returning id into w_181;
  insert into watches (market_id, source_kind, source_ref, lease_until) values (m, 'github_api', '{"ref":"repos/o/r/pulls/7"}', now() + interval '5 seconds') returning id into w_short;
  out := out || jsonb_build_object(
    'claim_lease_170s', claim_watch_dispatch(w_170, '2099-01-01T00:00'),
    'claim_lease_180s', claim_watch_dispatch(w_180, '2099-01-01T00:00'),
    'claim_lease_181s', claim_watch_dispatch(w_181, '2099-01-01T00:00'),
    'claim_short_lease', claim_watch_dispatch(w_short, this_minute));
  -- statements of their own: the claims' updates are invisible to the snapshot of the statement that called them
  out := out || jsonb_build_object('claim_extends_lease', (select lease_until = now() + interval '120 seconds' from watches where id = w_short),
    'claim_lease_170s_kept', (select lease_until = signed + interval '170 seconds' from watches where id = w_170));
  insert into used_dispatch_signatures (watch_id, minute, used_at) values (w_ok, '2099-01-02T00:00', now() - interval '3 days');
  n := gc_dispatch_signatures();
  out := out || jsonb_build_object('gc_deleted_old', n >= 1,
    'gc_old_gone', not exists (select 1 from used_dispatch_signatures where watch_id = w_ok and minute = '2099-01-02T00:00'),
    'gc_fresh_kept', (select count(*) from used_dispatch_signatures where watch_id = w_ok and minute in ('2099-01-01T00:00', '2099-01-01T00:01')));

  -- lease_watch_now (a tenant fetch) ---------------------------------------------------------------------------------
  insert into watches (market_id, source_kind, source_ref, lease_until) values (m, 'github_api', '{"ref":"repos/o/r/pulls/8"}', null) returning id into w_free;
  insert into watches (market_id, source_kind, source_ref, lease_until) values (m, 'github_api', '{"ref":"repos/o/r/pulls/9"}', now() + interval '60 seconds') returning id into w_live;
  insert into watches (market_id, source_kind, source_ref, lease_until) values (m, 'github_api', '{"ref":"repos/o/r/pulls/10"}', now() - interval '1 second') returning id into w_gone;
  l := lease_watch_now(w_free);
  out := out || jsonb_build_object('lease_now_free', l = now() + interval '120 seconds',
    'lease_now_free_row', (select lease_until = now() + interval '120 seconds' from watches where id = w_free),
    'lease_now_twice', lease_watch_now(w_free) is null,
    'lease_now_live', lease_watch_now(w_live) is null,
    'lease_now_live_kept', (select lease_until = now() + interval '60 seconds' from watches where id = w_live),
    'lease_now_expired', lease_watch_now(w_gone) = now() + interval '120 seconds',
    'lease_now_unknown', lease_watch_now(gen_random_uuid()) is null);
  -- a dispatch signed 3 minutes ago arriving now finds the tenant fetch's lease: not its own
  out := out || jsonb_build_object('claim_after_tenant_lease', claim_watch_dispatch(w_free, to_char((now() - interval '3 minutes') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI')));

  -- register_market -------------------------------------------------------------------------------------------------
  -- The tenant row lock, observed on a call that inserts nothing (watch_limit 0): an insert into markets would take a
  -- FOR KEY SHARE lock on the row through its foreign key and set xmax whatever register_market does.
  insert into tenants (display_name, watch_limit) values ('__selftest_dispatch_lock__', 0) returning id into t_lock;
  out := out || jsonb_build_object('lock_tenant_before', (select xmax::text from tenants where id = t_lock));
  r := register_market(t_lock, body || '{"external_id":"__selftest_reg_lock__"}', jsonb_build_array(gh));
  out := out || jsonb_build_object('lock_tenant_outcome', r->>'outcome',
    'lock_tenant_for_update', (select xmax = pg_current_xact_id()::xid from tenants where id = t_lock));
  insert into tenants (display_name, watch_limit) values ('__selftest_dispatch_tenant__', 2) returning id into t;
  r := register_market(t, body || '{"external_id":"__selftest_reg_a__"}', jsonb_build_array(gh, gh));
  out := out || jsonb_build_object('reg_created', r->>'outcome', 'reg_created_watches', jsonb_array_length(r->'watches'),
    'reg_rows_watches', (select count(*) from watches where market_id = (r->>'market_id')::uuid and active and next_poll_at <= now()),
    'reg_row_meta_reasons', (select meta->'registration_reasons' from markets where id = (r->>'market_id')::uuid));
  r2 := register_market(t, body || '{"external_id":"__selftest_reg_a__","meta":{"slug":"changed"}}', jsonb_build_array(gh));
  out := out || jsonb_build_object('reg_repeat', r2->>'outcome', 'reg_repeat_same_id', r2->>'market_id' = r->>'market_id',
    'reg_repeat_watches', jsonb_array_length(r2->'watches'),
    'reg_repeat_meta_untouched', (select meta ? 'slug' from markets where id = (r->>'market_id')::uuid) = false);
  r := register_market(t, body || '{"external_id":"__selftest_reg_b__"}', jsonb_build_array(gh));
  out := out || jsonb_build_object('reg_over_limit', r->>'outcome', 'reg_over_limit_counts', jsonb_build_array(r->'watch_limit', r->'active_watches', r->'requested'),
    'reg_over_limit_wrote', (select count(*) from markets where external_id = '__selftest_reg_b__'));
  r := register_market(t, body || '{"external_id":"__selftest_reg_c__"}', '[]'::jsonb);
  out := out || jsonb_build_object('reg_no_watches_at_limit', r->>'outcome');

  select count(*) into base_before from watches where source_kind = 'base_log' and active and deleted_at is null;
  insert into app_config (key, value) values ('max_base_watches', (base_before + 1)::text)
  on conflict (key) do update set value = excluded.value;
  -- every registration above added GitHub watches only: none of them took the Base lock
  execute base_lock into held using base_key;
  out := out || jsonb_build_object('lock_base_before', held);
  r := register_market(null, body || '{"external_id":"__selftest_reg_base2__"}', jsonb_build_array(bl, bl));
  execute base_lock into held using base_key;
  out := out || jsonb_build_object('lock_base_held', held);
  out := out || jsonb_build_object('reg_base_over_cap', r->>'outcome', 'reg_base_over_cap_requested', r->'requested',
    'reg_base_over_cap_wrote', (select count(*) from markets where external_id = '__selftest_reg_base2__'));
  r := register_market(null, body || '{"external_id":"__selftest_reg_base1__"}', jsonb_build_array(bl));
  out := out || jsonb_build_object('reg_base_within_cap', r->>'outcome');

  begin perform register_market(null, body || '{"external_id":"__selftest_reg_unsup__","status":"unsupported_source"}', jsonb_build_array(gh));
    out := out || '{"reg_unsupported_with_watches":"allowed"}';
  exception when others then out := out || '{"reg_unsupported_with_watches":"refused"}'; end;
  r := register_market(null, body || '{"external_id":"smoke-__selftest_reg__"}', '[]'::jsonb);
  out := out || jsonb_build_object('reg_smoke_is_test', r->'is_test');
  update markets set deleted_at = now() where id = (r->>'market_id')::uuid;
  begin perform register_market(null, body || '{"external_id":"smoke-__selftest_reg__"}', '[]'::jsonb);
    out := out || '{"reg_deleted_twin":"allowed"}';
  exception when unique_violation then out := out || '{"reg_deleted_twin":"23505"}'; end;

  -- privileges -------------------------------------------------------------------------------------------------------
  begin
    set local role service_role;
    out := out || jsonb_build_object('service_role_claim', claim_watch_dispatch(w_ok, '2099-01-01T00:03'),
      'service_role_lease_now', lease_watch_now(w_gone) is null);
    -- a statement of its own: the claim's insert is invisible to the snapshot of the statement that called it
    out := out || jsonb_build_object('service_role_reads_ledger', (select count(*) from used_dispatch_signatures where watch_id = w_ok));
    begin insert into used_dispatch_signatures (watch_id, minute) values (w_ok, '2099-01-01T00:04'); out := out || '{"service_role_insert":"allowed"}';
    exception when insufficient_privilege then out := out || '{"service_role_insert":"denied"}'; end;
    begin delete from used_dispatch_signatures where watch_id = w_ok; out := out || '{"service_role_delete":"allowed"}';
    exception when insufficient_privilege then out := out || '{"service_role_delete":"denied"}'; end;
    reset role;
    set local role anon;
    begin perform claim_watch_dispatch(w_ok, '2099-01-01T00:05'); out := out || '{"anon_claim":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_claim":"denied"}'; end;
    begin perform lease_watch_now(w_ok); out := out || '{"anon_lease_now":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_lease_now":"denied"}'; end;
    begin perform register_market(null, body || '{"external_id":"__selftest_reg_anon__"}', '[]'::jsonb); out := out || '{"anon_register":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_register":"denied"}'; end;
    begin perform gc_dispatch_signatures(); out := out || '{"anon_gc":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_gc":"denied"}'; end;
    begin perform 1 from used_dispatch_signatures limit 1; out := out || '{"anon_read":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_read":"denied"}'; end;
    reset role;
  exception when others then out := out || jsonb_build_object('privileges_block', 'error: ' || sqlerrm);
  end;
  raise exception '${TAG} %', out::text;
end $$;`;

export const DISPATCH_EXPECT: Record<string, unknown> = {
  claim_first: "claimed", claim_replay: "signature_used", claim_next_minute: "claimed",
  claim_lease_null: "lease_missing", claim_lease_null_replay: "signature_used", claim_lease_expired: "lease_expired", claim_unknown_watch: "watch_not_found",
  claim_bad_minute: "refused",
  claim_lease_170s: "claimed", claim_lease_180s: "lease_superseded", claim_lease_181s: "lease_superseded", claim_lease_170s_kept: true,
  claim_short_lease: "claimed", claim_extends_lease: true,
  gc_deleted_old: true, gc_old_gone: true, gc_fresh_kept: 2,
  lease_now_free: true, lease_now_free_row: true, lease_now_twice: true, lease_now_live: true, lease_now_live_kept: true,
  lease_now_expired: true, lease_now_unknown: true, claim_after_tenant_lease: "lease_superseded",
  lock_tenant_before: "0", lock_tenant_outcome: "watch_limit", lock_tenant_for_update: true, lock_base_before: false, lock_base_held: true,
  reg_created: "created", reg_created_watches: 2, reg_rows_watches: 2, reg_row_meta_reasons: [],
  reg_repeat: "existing", reg_repeat_same_id: true, reg_repeat_watches: 2, reg_repeat_meta_untouched: true,
  reg_over_limit: "watch_limit", reg_over_limit_counts: [2, 2, 1], reg_over_limit_wrote: 0, reg_no_watches_at_limit: "created",
  reg_base_over_cap: "base_watch_cap", reg_base_over_cap_requested: 2, reg_base_over_cap_wrote: 0, reg_base_within_cap: "created",
  reg_unsupported_with_watches: "refused", reg_smoke_is_test: true, reg_deleted_twin: "23505",
  service_role_claim: "claimed", service_role_lease_now: true, service_role_reads_ledger: 3, service_role_insert: "denied", service_role_delete: "denied",
  anon_claim: "denied", anon_lease_now: "denied", anon_register: "denied", anon_gc: "denied", anon_read: "denied",
};

/** The json the block raised, from a Management API error or psql's stderr; null when absent. */
export function parseRaised(msg: string): Record<string, unknown> | null {
  let inner = msg;
  const j = msg.indexOf("{");
  if (j >= 0 && msg.slice(j).startsWith('{"message"')) { try { inner = String(JSON.parse(msg.slice(j)).message ?? msg); } catch { /* keep raw */ } }
  const m = inner.match(new RegExp(`${TAG} (\\{.*\\})`, "s"));
  if (!m) return null;
  try { return JSON.parse(m[1]!.split("\n")[0]!) as Record<string, unknown>; } catch { return null; }
}

/** PASS/FAIL per expected key; returns the number of failures. */
export function report(r: Record<string, unknown>, expect: Record<string, unknown>, say: (l: string) => void = console.log): number {
  let bad = 0;
  for (const [k, v] of Object.entries(expect)) {
    const ok = JSON.stringify(r[k]) === JSON.stringify(v);
    if (!ok) bad++;
    say(`${ok ? "PASS" : "FAIL"} dispatch.${k} = ${JSON.stringify(r[k])}${ok ? "" : ` (expected ${JSON.stringify(v)})`}`);
  }
  for (const k of Object.keys(r)) if (!(k in expect)) { bad++; say(`FAIL dispatch.${k} = ${JSON.stringify(r[k])} (not expected)`); }
  return bad;
}

async function runBlock(psql: string | null): Promise<string> {
  if (psql) {
    const p = spawnSync("psql", [psql, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", DISPATCH_BLOCK], { encoding: "utf8" });
    if (p.error) throw p.error;
    return `${p.stderr}\n${p.stdout}`;
  }
  try { await sql(DISPATCH_BLOCK); return ""; } catch (e) { return String(e); }
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--psql");
  const psql = i >= 0 ? argv[i + 1] ?? "" : null;
  if (psql === "" || argv.some((a, k) => a.startsWith("-") && a !== "--psql" && k !== i + 1)) { console.error("usage: npx tsx scripts/selftest/dispatch.ts [--psql <conninfo>]"); process.exit(2); }
  const ref = process.env.SUPABASE_PROJECT_REF, staging = process.env.STAGING_SUPABASE_PROJECT_REF;
  const allowed = process.env.RESOLVE_SELFTEST_NON_PRODUCTION === "1" || (!psql && !!ref && !!staging && ref === staging);
  if (!allowed) {
    console.error("selftest dispatch: refused. It runs only when SUPABASE_PROJECT_REF equals STAGING_SUPABASE_PROJECT_REF, or with RESOLVE_SELFTEST_NON_PRODUCTION=1 for a staging or local database (the block rolls back, but it is never run against production).");
    process.exit(2);
  }
  const raised = parseRaised(await runBlock(psql));
  if (!raised) { console.error(`selftest dispatch: the block did not return its results (${psql ? "psql" : "Management API"}); nothing was asserted`); process.exit(1); }
  const bad = report(raised, DISPATCH_EXPECT);
  console.log(`rolled back: nothing persisted from the dispatch DO block (${bad ? `${bad} FAIL` : "all PASS"})`);
  if (bad) process.exit(1);
}

if (process.argv[1]?.endsWith("dispatch.ts")) main().catch((e) => { console.error(String(e)); process.exit(1); });

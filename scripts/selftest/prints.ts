/**
 * Migration 022 (charge_read, purge_retention, database_size_bytes), rollback-only: everything runs inside one DO block
 * that always raises at the end, so nothing persists. It asserts:
 *   - charge_read(): the first call charges once (one credit_ledger 'charge' row, note read, the new balance back); the
 *     same request id again is a replay (charged 0, no second row), also at a zero balance; a short balance is refused
 *     with nothing written; another tenant cannot replay the id (RS003); a deleted tenant is refused; an amount below 1,
 *     a bare-hex id, and begin_resolution's own charge id are refused (22023), so a read never replays a verdict's charge;
 *     refund_credits() gives a read's charge back;
 *   - purge_retention(): with rows older than 30 days written in every protected table (official_observations,
 *     bot_posts, credit_ledger, reconciliations, resolutions), a fingerprint of each whole table is the same after the
 *     purge and the old rows are all there; a loop_runs row older than 30 days is deleted and a recent one kept; the
 *     excerpt of 30-day-old evidence is cleared for a settled and for a deleted market, and kept for an open market and
 *     for recent evidence of a settled one, with the hashes, R2 key and URL kept; the run writes its loop_runs row with
 *     the database size;
 *   - database_size_bytes() is pg_database_size() of this database;
 *   - least privilege: anon and authenticated cannot execute any of the three, PUBLIC holds no EXECUTE, service_role
 *     can; each is SECURITY DEFINER with a pinned search_path and commented, as is evidence.excerpt; the daily cron job.
 * Refused unless SUPABASE_PROJECT_REF equals STAGING_SUPABASE_PROJECT_REF or RESOLVE_SELFTEST_NON_PRODUCTION=1 (with
 * --psql, only the latter); the target is printed first.
 *   RESOLVE_SELFTEST_NON_PRODUCTION=1 npx tsx scripts/selftest/prints.ts --psql postgresql://postgres@localhost:5541/resolve
 *   npx tsx scripts/selftest/prints.ts             (the Management API: the project .env names, staging only)
 */
import { loadEnv } from "../lib/env";
import { blockRunner, check, describeTarget, nonProductionRefusal, raisedResults, UsageError } from "../lib/selftest";

const TAG = "SELFTEST_PRINTS";
const A = "print:us_unemployment_rate:2026-09:__selftest_prints_a__";
const B = "print:us_unemployment_rate:2026-09:__selftest_prints_b__";
const C = "print:us_unemployment_rate:2026-09:__selftest_prints_c__";
const FNS = "'public.charge_read(uuid,integer,text)'::regprocedure, 'public.purge_retention()'::regprocedure, 'public.database_size_bytes()'::regprocedure";
/** The record: purge_retention never deletes or changes a row of these. */
export const PROTECTED_TABLES = ["official_observations", "bot_posts", "credit_ledger", "reconciliations", "resolutions"] as const;
const ORDER: Record<(typeof PROTECTED_TABLES)[number], string> = { official_observations: "x.series, x.period", bot_posts: "x.id", credit_ledger: "x.id", reconciliations: "x.id", resolutions: "x.id" };
const fingerprint = PROTECTED_TABLES.map((t) => `select '${t}' as t, md5(coalesce(string_agg(x::text, '|' order by ${ORDER[t]}), '')) as fp from ${t} x`).join("\n      union all ");

export const PRINTS_BLOCK = `
do $$
declare
  out jsonb := '{}'::jsonb;
  v_old constant timestamptz := now() - interval '45 days';
  t1 uuid; t2 uuid; tdel uuid; r record; r2 record;
  mo uuid; mc uuid; md uuid; e1 uuid; e2 uuid; e3 uuid; e4 uuid;
  purge jsonb; fp_before jsonb; fp_after jsonb; v_bool boolean;
begin
  -- 1. charge_read ------------------------------------------------------------------------------------------------------
  insert into tenants (display_name, credits_balance) values ('__selftest_prints_t1__', 2) returning id into t1;
  insert into tenants (display_name, credits_balance) values ('__selftest_prints_t2__', 5) returning id into t2;
  insert into tenants (display_name, credits_balance, deleted_at) values ('__selftest_prints_del__', 10, now()) returning id into tdel;

  select * into r from charge_read(t1, 1, '${A}');
  out := out || jsonb_build_object('first', jsonb_build_array(r.ok, r.replayed, r.charged, r.balance));
  select * into r from charge_read(t1, 1, '${A}');
  out := out || jsonb_build_object('replay', jsonb_build_array(r.ok, r.replayed, r.charged, r.balance),
    'charge_rows_after_replay', (select count(*) from credit_ledger where tenant_id = t1 and reason = 'charge'),
    'charge_row', (select jsonb_build_array(delta, balance_after, note) from credit_ledger where reason = 'charge' and request_id = '${A}'));
  select * into r from charge_read(t1, 1, '${B}');
  out := out || jsonb_build_object('second_read', jsonb_build_array(r.ok, r.replayed, r.charged, r.balance));
  select * into r from charge_read(t1, 1, '${C}');
  out := out || jsonb_build_object('short', jsonb_build_array(r.ok, r.replayed, r.charged, r.balance),
    'short_rows', (select count(*) from credit_ledger where request_id = '${C}'),
    'short_balance', (select credits_balance from tenants where id = t1));
  select * into r from charge_read(t1, 1, '${A}');
  out := out || jsonb_build_object('replay_at_zero', jsonb_build_array(r.ok, r.replayed, r.charged, r.balance));
  begin perform charge_read(t2, 1, '${A}'); out := out || '{"other_tenant":"allowed"}';
  exception when others then out := out || jsonb_build_object('other_tenant', sqlstate); end;
  select * into r from charge_read(tdel, 1, 'print:us_unemployment_rate:2026-09:__selftest_prints_del__');
  out := out || jsonb_build_object('deleted_tenant', jsonb_build_array(r.ok, r.charged, r.balance),
    'deleted_rows', (select count(*) from credit_ledger where tenant_id = tdel));
  begin perform charge_read(t2, 0, 'print:us_unemployment_rate:2026-09:__selftest_prints_zero__'); out := out || '{"zero_amount":"allowed"}';
  exception when others then out := out || jsonb_build_object('zero_amount', sqlstate); end;
  begin perform charge_read(t2, 1, repeat('a', 64)); out := out || '{"bare_hex_id":"allowed"}';
  exception when others then out := out || jsonb_build_object('bare_hex_id', sqlstate); end;
  select * into r2 from begin_resolution(t2, null, '__selftest_prints_idem__', 1, null, 'eval');
  begin perform charge_read(t2, 1, r2.request_id); out := out || '{"verdict_charge_id":"allowed"}';
  exception when others then out := out || jsonb_build_object('verdict_charge_id', sqlstate); end;
  out := out || jsonb_build_object('refund', refund_credits('${B}'), 'refund_balance', (select credits_balance from tenants where id = t1));

  -- 2. purge_retention: rows older than 30 days in every protected table and in the two it purges ------------------------
  insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc)
    values ('custom', '__selftest_prints_open__', 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', v_old - interval '10 days', v_old) returning id into mo;
  insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc, status)
    values ('custom', '__selftest_prints_closed__', 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', v_old - interval '10 days', v_old, 'resolved') returning id into mc;
  insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc, deleted_at)
    values ('custom', '__selftest_prints_deleted__', 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', v_old - interval '10 days', v_old, now()) returning id into md;
  insert into evidence (market_id, source_kind, source_url, observed_at, fetched_at, raw_sha256, canonical_sha256, raw_r2_key, excerpt, created_at)
    values (mc, 'web_fetch', 'https://example.org/selftest-1', v_old, v_old, repeat('1', 64), repeat('2', 64), 'raw/' || repeat('1', 64), 'old excerpt of a settled market', v_old) returning id into e1;
  insert into evidence (market_id, source_kind, source_url, observed_at, fetched_at, raw_sha256, canonical_sha256, excerpt)
    values (mc, 'web_fetch', 'https://example.org/selftest-2', now(), now(), repeat('3', 64), repeat('4', 64), 'recent excerpt of a settled market') returning id into e2;
  insert into evidence (market_id, source_kind, source_url, observed_at, fetched_at, raw_sha256, canonical_sha256, excerpt, created_at)
    values (mo, 'web_fetch', 'https://example.org/selftest-3', v_old, v_old, repeat('5', 64), repeat('6', 64), 'old excerpt of an open market', v_old) returning id into e3;
  insert into evidence (market_id, source_kind, source_url, observed_at, fetched_at, raw_sha256, canonical_sha256, excerpt, created_at)
    values (md, 'web_fetch', 'https://example.org/selftest-4', v_old, v_old, repeat('7', 64), repeat('8', 64), 'old excerpt of a deleted market', v_old) returning id into e4;
  insert into loop_runs (loop_name, started_at, outcome) values ('__selftest_prints_old__', v_old, 'success'), ('__selftest_prints_new__', now(), 'success');
  insert into resolutions (id, market_id, mode, status_row, resolution_status, winning_outcome, confidence_score, determination_basis, caveats, thresholds_version, created_at)
    values ('__selftest_prints_r1__', mo, 'shadow', 'complete', 'RESOLVED', 'OPTION_A', 0.95, 'structured', '[]', 'v1', v_old);
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at, created_at)
    values ('__selftest_prints_r1__', mo, 'none', 'commit', repeat('9', 64), 'n', '{}', '__selftest_prints_c1__', v_old, v_old);
  insert into reconciliations (resolution_id, market_id, platform, official_outcome, agreement, final, reconciled_at)
    values ('__selftest_prints_r1__', mo, 'custom', 'OPTION_A', 'agree', false, v_old);
  insert into credit_ledger (tenant_id, delta, reason, balance_after, note, created_at) values (t2, 1, 'grant', 5, '__selftest_prints_old_grant__', v_old);
  insert into official_observations (series, period, value, value_text, deciding_text, source_url, raw_sha256, observed_at)
    values ('selftest_prints', '2099-01', 1, '1', 'SELFTEST - JANUARY 2099', 'https://www.bls.gov/selftest', repeat('a', 64), v_old);

  select jsonb_object_agg(f.t, f.fp) into fp_before from (
      ${fingerprint}) f;
  purge := purge_retention();
  select jsonb_object_agg(f.t, f.fp) into fp_after from (
      ${fingerprint}) f;
  out := out || jsonb_build_object(
    'purge_error', purge ? 'error',
    'protected_unchanged', fp_before = fp_after,
    'protected_tables', (select count(*) from jsonb_object_keys(fp_before)),
    'protected_old_rows_kept', jsonb_build_array(
      (select count(*) from official_observations where series = 'selftest_prints'),
      (select count(*) from bot_posts where dedup_key = '__selftest_prints_c1__'),
      (select count(*) from credit_ledger where note = '__selftest_prints_old_grant__'),
      (select count(*) from reconciliations where resolution_id = '__selftest_prints_r1__'),
      (select count(*) from resolutions where id = '__selftest_prints_r1__')),
    'old_loop_run_deleted', not exists (select 1 from loop_runs where loop_name = '__selftest_prints_old__'),
    'recent_loop_run_kept', exists (select 1 from loop_runs where loop_name = '__selftest_prints_new__'),
    'old_settled_excerpt', (select excerpt from evidence where id = e1),
    'old_settled_row_kept', (select raw_sha256 = repeat('1', 64) and canonical_sha256 = repeat('2', 64) and raw_r2_key = 'raw/' || repeat('1', 64)
                               and source_url = 'https://example.org/selftest-1' and observed_at = v_old from evidence where id = e1),
    'recent_settled_excerpt', (select excerpt from evidence where id = e2),
    'old_open_excerpt', (select excerpt from evidence where id = e3),
    'old_deleted_excerpt', (select excerpt from evidence where id = e4),
    'purge_counted', (purge->>'loop_runs_deleted')::int >= 1 and (purge->>'evidence_excerpts_cleared')::int >= 2,
    'purge_run_row', (select jsonb_build_array(l.outcome, l.meta ? 'database_bytes', (l.meta->>'retention_days')::int) from loop_runs l
                       where l.loop_name = 'retention_purge' order by l.id desc limit 1),
    'size_is_pg_database_size', database_size_bytes() = pg_database_size(current_database()) and database_size_bytes() > 0);

  -- 3. least privilege, pinned search_path, comments, the cron job -----------------------------------------------------
  begin
    set local role anon;
    begin perform charge_read(t2, 1, 'print:us_unemployment_rate:2026-09:__selftest_prints_anon__'); out := out || '{"anon_charge":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_charge":"denied"}'; end;
    begin perform purge_retention(); out := out || '{"anon_purge":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_purge":"denied"}'; end;
    begin perform database_size_bytes(); out := out || '{"anon_size":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_size":"denied"}'; end;
    reset role;
  exception when others then out := out || jsonb_build_object('anon_charge', 'set role failed: ' || sqlerrm);
  end;
  begin
    set local role service_role;
    select * into r from charge_read(t2, 1, 'print:us_unemployment_rate:2026-09:__selftest_prints_service__');
    out := out || jsonb_build_object('service_charge', r.charged, 'service_size', database_size_bytes() > 0);
    reset role;
  exception when others then out := out || jsonb_build_object('service_charge', 'error: ' || sqlerrm);
  end;
  out := out || jsonb_build_object(
    'authenticated_denied', not has_function_privilege('authenticated', 'public.charge_read(uuid,integer,text)', 'execute')
      and not has_function_privilege('authenticated', 'public.purge_retention()', 'execute')
      and not has_function_privilege('authenticated', 'public.database_size_bytes()', 'execute'),
    'public_execute', (select count(*) from pg_proc f where f.oid in (${FNS})
      and (f.proacl is null or exists (select 1 from aclexplode(f.proacl) a where a.grantee = 0))),
    'definer_search_path', (select bool_and(f.prosecdef and exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%')) from pg_proc f where f.oid in (${FNS})),
    'uncommented', (select count(*) from pg_proc f where f.oid in (${FNS}) and obj_description(f.oid, 'pg_proc') is null)
      + (select count(*) from pg_attribute a where a.attrelid = 'public.evidence'::regclass and a.attname = 'excerpt' and col_description(a.attrelid, a.attnum) is null));
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $c$select exists (select 1 from cron.job where jobname = 'purge_retention' and schedule = '23 3 * * *' and active
      and command = 'select public.purge_retention()')$c$ into v_bool;
    out := out || jsonb_build_object('cron_job', v_bool);
  else
    out := out || '{"cron_job":"no_pg_cron"}';
  end if;
  raise exception '${TAG} %', out::text;
end $$;`;

export const PRINTS_EXPECT: Record<string, unknown> = {
  first: [true, false, 1, 1], replay: [true, true, 0, 1], charge_rows_after_replay: 1, charge_row: [-1, 1, "read"],
  second_read: [true, false, 1, 0], short: [false, false, 0, 0], short_rows: 0, short_balance: 0, replay_at_zero: [true, true, 0, 0],
  other_tenant: "RS003", deleted_tenant: [false, 0, 0], deleted_rows: 0,
  zero_amount: "22023", bare_hex_id: "22023", verdict_charge_id: "22023", refund: 1, refund_balance: 1,
  purge_error: false, protected_unchanged: true, protected_tables: PROTECTED_TABLES.length, protected_old_rows_kept: [1, 1, 1, 1, 1],
  old_loop_run_deleted: true, recent_loop_run_kept: true,
  old_settled_excerpt: null, old_settled_row_kept: true, recent_settled_excerpt: "recent excerpt of a settled market",
  old_open_excerpt: "old excerpt of an open market", old_deleted_excerpt: null,
  purge_counted: true, purge_run_row: ["success", true, 30], size_is_pg_database_size: true,
  anon_charge: "denied", anon_purge: "denied", anon_size: "denied", service_charge: 1, service_size: true,
  authenticated_denied: true, public_execute: 0, definer_search_path: true, uncommented: 0, cron_job: true,
};

async function main(): Promise<number> {
  loadEnv();
  let runner: ReturnType<typeof blockRunner>;
  try { runner = blockRunner(process.argv.slice(2)); } catch (e) {
    if (e instanceof UsageError) { console.error(e.message); return 2; }
    throw e;
  }
  console.log(`selftest prints target: ${describeTarget(runner)}`);
  const refusal = nonProductionRefusal(process.env, runner.via);
  if (refusal) { console.error(`selftest prints (migration 022): ${refusal}`); return 2; }
  const raw = await runner.run(PRINTS_BLOCK);
  const r = raisedResults(TAG, raw);
  if (!r) { console.error("FAIL prints: the block did not return results:", raw.slice(0, 1200)); return 1; }
  // a local cluster without pg_cron keeps the function and schedules nothing
  const expect = { ...PRINTS_EXPECT, ...(runner.via === "psql" && r.cron_job === "no_pg_cron" ? { cron_job: "no_pg_cron" } : {}) };
  let bad = check(r, expect, "prints.");
  for (const k of Object.keys(r)) if (!(k in expect)) { bad++; console.log(`FAIL prints.${k} = ${JSON.stringify(r[k])} (unexpected key)`); }
  console.log(`rolled back: nothing persisted from the prints block (${runner.via})`);
  return bad ? 1 : 0;
}

if (process.argv[1]?.endsWith("prints.ts")) main().then((code) => process.exit(code), (e) => { console.error(String(e)); process.exit(1); });

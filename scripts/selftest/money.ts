/**
 * Migration 020 (money): rollback-only assertions against real Postgres. Everything runs inside ONE DO block that always
 * ends with RAISE, so nothing it writes persists (tenants, deposits, ledger rows, challenges, app_config changes all roll
 * back); the raised message carries the results, printed as PASS/FAIL lines. It asserts: the PAYG tier math through
 * credit_from_deposit (49.99, 50, 249.99, 250, 999.99, 1000 USDC and the plan §11 packs), the passed rate as fallback
 * when payg_tiers is absent, dust, malformed tiers refused before anything is credited; match_deposit (only an unmatched
 * deposit, the tier rate, one ledger row, the audit, the same answer with replayed=true on a retry, every refusal with
 * its SQLSTATE and nothing written); the low-credit notice (once per crossing, a refund does not reset it, a purchase or
 * grant does, release gives it back, the threshold is data); register_wallet (registered, used, expired, taken,
 * another tenant's challenge); and least privilege (anon denied, service_role allowed, search_path pinned, comments).
 *   RESOLVE_SELFTEST_NON_PRODUCTION=1 npx tsx scripts/selftest/money.ts                     Management API, SUPABASE_PROJECT_REF
 *   RESOLVE_SELFTEST_NON_PRODUCTION=1 npx tsx scripts/selftest/money.ts --psql "<conninfo>"  a local database through psql
 * Refused unless SUPABASE_PROJECT_REF equals STAGING_SUPABASE_PROJECT_REF or RESOLVE_SELFTEST_NON_PRODUCTION=1: the block
 * rolls back, but it is never pointed at production.
 */
import { spawnSync } from "node:child_process";
import { loadEnv } from "../lib/env";
import { sql } from "../lib/mgmt";

const TAG = "SELFTEST_MONEY";

export const MONEY_SELFTEST_SQL = `
do $$
declare
  t1 uuid; t2 uuid; tl uuid; tdel uuid; out jsonb := '{}'::jsonb; r record; m1 record; m2 record;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; c5 uuid; w record; b1 record;
  ok_tiers constant text := '[{"min_usdc":1000,"credits_per_usdc":120},{"min_usdc":250,"credits_per_usdc":110},{"min_usdc":0,"credits_per_usdc":100}]';
  wa1 constant text := '0x00000000000000000000000000000000000020a1';
  wa2 constant text := '0x00000000000000000000000000000000000020a2';
  wdel constant text := '0x00000000000000000000000000000000000020a3';
  wl constant text := '0x00000000000000000000000000000000000020a4';
  wnew constant text := '0x00000000000000000000000000000000000020c1';
  wnobody constant text := '0x00000000000000000000000000000000000020ff';
begin
  -- The tiers under test are migration 020's, whatever the target holds today (rolled back with everything else).
  update app_config set value = ok_tiers where key = 'payg_tiers';
  if not found then insert into app_config (key, value) values ('payg_tiers', ok_tiers); end if;
  delete from app_config where key = 'low_credit_threshold';
  insert into tenants (display_name, wallet_address, credits_balance) values ('__selftest_money_t1__', wa1, 0) returning id into t1;
  insert into tenants (display_name, wallet_address, credits_balance) values ('__selftest_money_t2__', wa2, 0) returning id into t2;
  insert into tenants (display_name, wallet_address, credits_balance, deleted_at) values ('__selftest_money_del__', wdel, 0, now()) returning id into tdel;
  insert into tenants (display_name, wallet_address, credits_balance) values ('__selftest_money_low__', wl, 600) returning id into tl;

  -- 1. tier math through credit_from_deposit (the rate passed, 100, is overridden by the tiers)
  for r in select * from (values ('49.99', 1), ('50', 2), ('249.99', 3), ('250', 4), ('999.99', 5), ('1000', 6)) as x(amount, n) loop
    select * into m1 from credit_from_deposit('0x__selftest_money_tier_' || r.n, 0, wa1, '0xdead', r.amount::numeric, 100, 200, 100);
    out := out || jsonb_build_object('tier_' || replace(r.amount, '.', '_'), m1.credits, 'tier_' || replace(r.amount, '.', '_') || '_status', m1.status);
  end loop;
  out := out || jsonb_build_object(
    'rate_recorded_250', (select credits_per_usdc from usdc_deposits where tx_hash = '0x__selftest_money_tier_4' and log_index = 0),
    'rate_recorded_1000', (select credits_per_usdc from usdc_deposits where tx_hash = '0x__selftest_money_tier_6' and log_index = 0),
    'packs', jsonb_build_array(floor(50 * payg_credits_per_usdc(50)), floor(250 * payg_credits_per_usdc(250)), floor(1000 * payg_credits_per_usdc(1000))),
    'tier_ledger_rows', (select count(*) from credit_ledger where tenant_id = t1 and reason = 'purchase'),
    'tier_balance', (select credits_balance from tenants where id = t1));
  select * into m1 from credit_from_deposit('0x__selftest_money_dust', 0, wa1, '0xdead', 0.000001, 100, 200, 100);
  select * into m2 from credit_from_deposit('0x__selftest_money_cent', 0, wa1, '0xdead', 0.01, 100, 200, 100);
  out := out || jsonb_build_object('dust_status', m1.status, 'dust_credits', m1.credits, 'cent_status', m2.status, 'cent_credits', m2.credits,
    'dust_row_status', (select status from usdc_deposits where tx_hash = '0x__selftest_money_dust'));
  select * into m1 from credit_from_deposit('0x__selftest_money_tier_1', 0, wa1, '0xdead', 49.99, 100, 200, 100);
  out := out || jsonb_build_object('replay_status', m1.status);

  -- 2. payg_tiers absent: the rate passed (the pre-020 Worker's CREDITS_PER_USDC); malformed: refused, nothing written
  delete from app_config where key = 'payg_tiers';
  select * into m1 from credit_from_deposit('0x__selftest_money_fb1', 0, wa1, '0xdead', 1000, 100, 200, 100);
  select * into m2 from credit_from_deposit('0x__selftest_money_fb2', 0, wa1, '0xdead', 10, 100, 200, 77);
  out := out || jsonb_build_object('fallback_1000_at_100', m1.credits, 'fallback_10_at_77', m2.credits);
  begin perform payg_credits_per_usdc(10, null); out := out || '{"no_tiers_no_fallback":"allowed"}';
  exception when others then out := out || jsonb_build_object('no_tiers_no_fallback', sqlstate); end;
  for r in select * from (values
      ('falling', '[{"min_usdc":0,"credits_per_usdc":100},{"min_usdc":250,"credits_per_usdc":90}]'),
      ('no_zero', '[{"min_usdc":250,"credits_per_usdc":110}]'),
      ('typo_rate', '[{"min_usdc":0,"credits_per_usdc":12000}]'),
      ('fraction_rate', '[{"min_usdc":0,"credits_per_usdc":100.5}]'),
      ('duplicate_min', '[{"min_usdc":0,"credits_per_usdc":100},{"min_usdc":0,"credits_per_usdc":110}]'),
      ('not_json', 'tiers please'),
      ('not_array', '{"min_usdc":0,"credits_per_usdc":100}'),
      ('empty', '[]'),
      ('string_rate', '[{"min_usdc":0,"credits_per_usdc":"100"}]')) as x(name, value) loop
    insert into app_config (key, value) values ('payg_tiers', r.value) on conflict (key) do update set value = excluded.value;
    begin
      perform credit_from_deposit('0x__selftest_money_bad_' || r.name, 0, wa1, '0xdead', 300, 100, 200, 100);
      out := out || jsonb_build_object('malformed_' || r.name, 'credited');
    exception when others then out := out || jsonb_build_object('malformed_' || r.name, sqlstate); end;
  end loop;
  out := out || jsonb_build_object('malformed_rows_written', (select count(*) from usdc_deposits where tx_hash like '0x__selftest_money_bad_%'));
  update app_config set value = ok_tiers where key = 'payg_tiers';

  -- 3. match_deposit
  select * into m1 from credit_from_deposit('0x__selftest_money_unm', 0, wnobody, '0xdead', 250, 100, 200, 100);
  out := out || jsonb_build_object('unmatched_status', m1.status);
  select * into m1 from match_deposit('0x__SELFTEST_MONEY_UNM', 0, t2, 'selftest', 'selftest: tenant named the tx');
  select * into m2 from match_deposit('0x__selftest_money_unm', 0, t2, 'selftest', 'selftest: tenant named the tx');
  out := out || jsonb_build_object(
    'match', jsonb_build_object('status', m1.status, 'tenant', m1.tenant_id = t2, 'credits', m1.credits, 'balance_after', m1.balance_after, 'amount', m1.amount_usdc, 'rate', m1.credits_per_usdc, 'replayed', m1.replayed),
    'match_again', jsonb_build_object('status', m2.status, 'tenant', m2.tenant_id = t2, 'credits', m2.credits, 'balance_after', m2.balance_after, 'amount', m2.amount_usdc, 'rate', m2.credits_per_usdc, 'replayed', m2.replayed),
    'match_ledger_rows', (select count(*) from credit_ledger where tx_hash = '0x__selftest_money_unm'),
    'match_balance', (select credits_balance from tenants where id = t2),
    'match_audit', (select matched_by = 'selftest' and match_reason = 'selftest: tenant named the tx' and matched_at is not null and status = 'credited' and tenant_id = t2
                      from usdc_deposits where tx_hash = '0x__selftest_money_unm'),
    'match_note', (select note like '%matched by selftest%' from credit_ledger where tx_hash = '0x__selftest_money_unm'));
  select * into m1 from match_deposit('0x__selftest_money_tier_2', 0, t1, 'selftest', 'selftest: already credited by the scan');
  out := out || jsonb_build_object('match_scan_credited_same_tenant', jsonb_build_object('replayed', m1.replayed, 'credits', m1.credits));
  begin perform match_deposit('0x__selftest_money_unm', 0, t1, 'selftest', 'selftest: another tenant'); out := out || '{"match_other_tenant":"allowed"}';
  exception when others then out := out || jsonb_build_object('match_other_tenant', sqlstate); end;
  begin perform match_deposit('0x__selftest_money_dust', 0, t1, 'selftest', 'selftest: dust'); out := out || '{"match_dust":"allowed"}';
  exception when others then out := out || jsonb_build_object('match_dust', sqlstate); end;
  begin perform match_deposit('0x__selftest_money_none', 0, t1, 'selftest', 'selftest: missing'); out := out || '{"match_missing":"allowed"}';
  exception when others then out := out || jsonb_build_object('match_missing', sqlstate); end;
  perform credit_from_deposit('0x__selftest_money_unm2', 0, wnobody, '0xdead', 50, 100, 200, 100);
  begin perform match_deposit('0x__selftest_money_unm2', 0, tdel, 'selftest', 'selftest: deleted tenant'); out := out || '{"match_deleted_tenant":"allowed"}';
  exception when others then out := out || jsonb_build_object('match_deleted_tenant', sqlstate); end;
  begin perform match_deposit('0x__selftest_money_unm2', 0, t1, 'selftest', '   '); out := out || '{"match_blank_reason":"allowed"}';
  exception when others then out := out || jsonb_build_object('match_blank_reason', sqlstate); end;
  delete from app_config where key = 'payg_tiers';
  begin perform match_deposit('0x__selftest_money_unm2', 0, t1, 'selftest', 'selftest: no tiers'); out := out || '{"match_without_tiers":"allowed"}';
  exception when others then out := out || jsonb_build_object('match_without_tiers', sqlstate); end;
  insert into app_config (key, value) values ('payg_tiers', ok_tiers);
  out := out || jsonb_build_object('refused_left_unmatched', (select status from usdc_deposits where tx_hash = '0x__selftest_money_unm2'),
    'refused_ledger_rows', (select count(*) from credit_ledger where tx_hash = '0x__selftest_money_unm2'));
  begin update usdc_deposits set matched_by = 'x' where tx_hash = '0x__selftest_money_unm2'; out := out || '{"half_audit":"allowed"}';
  exception when check_violation then out := out || '{"half_audit":"refused"}'; end;

  -- 4. the low-credit notice (tl starts at 600; low_credit_threshold absent = 500)
  select * into r from claim_low_credit_notice(tl);
  out := out || jsonb_build_object('low_above', r.crossed, 'low_default_threshold', r.threshold);
  select * into b1 from begin_resolution(tl, null, '__selftest_money_c1__', 150, null, 'eval');      -- 450
  select * into r from claim_low_credit_notice(tl);
  out := out || jsonb_build_object('low_crossed', jsonb_build_array(r.crossed, r.balance));
  select * into r from claim_low_credit_notice(tl);
  out := out || jsonb_build_object('low_again', r.crossed);
  perform begin_resolution(tl, null, '__selftest_money_c2__', 10, null, 'eval');                      -- 440
  select * into r from claim_low_credit_notice(tl);
  out := out || jsonb_build_object('low_next_charge', r.crossed);
  perform refund_credits(b1.request_id);                                                             -- 590
  out := out || jsonb_build_object('low_refund_keeps_notice', (select low_credit_notified_at is not null from tenants where id = tl));
  perform begin_resolution(tl, null, '__selftest_money_c3__', 100, null, 'eval');                     -- 490
  select * into r from claim_low_credit_notice(tl);
  out := out || jsonb_build_object('low_after_refund_and_charge', r.crossed);
  perform grant_credits(tl, 10, 'selftest grant');                                                   -- 500
  out := out || jsonb_build_object('low_cleared_by_grant', (select low_credit_notified_at is null from tenants where id = tl));
  select * into r from claim_low_credit_notice(tl);
  out := out || jsonb_build_object('low_at_threshold', r.crossed);
  perform begin_resolution(tl, null, '__selftest_money_c4__', 1, null, 'eval');                       -- 499
  select * into r from claim_low_credit_notice(tl);
  out := out || jsonb_build_object('low_recrossed_after_grant', r.crossed);
  perform credit_from_deposit('0x__selftest_money_low', 0, wl, '0xdead', 1, 100, 200, 100);           -- 599
  out := out || jsonb_build_object('low_cleared_by_purchase', (select low_credit_notified_at is null from tenants where id = tl));
  perform begin_resolution(tl, null, '__selftest_money_c5__', 100, null, 'eval');                     -- 499
  select * into r from claim_low_credit_notice(tl);
  out := out || jsonb_build_object('low_recrossed_after_purchase', r.crossed);
  perform release_low_credit_notice(tl);
  select * into r from claim_low_credit_notice(tl);
  out := out || jsonb_build_object('low_after_release', r.crossed);
  insert into app_config (key, value) values ('low_credit_threshold', '100');
  perform release_low_credit_notice(tl);
  select * into r from claim_low_credit_notice(tl);
  out := out || jsonb_build_object('low_threshold_data', jsonb_build_array(r.crossed, r.threshold));
  update app_config set value = 'lots' where key = 'low_credit_threshold';
  begin perform claim_low_credit_notice(tl); out := out || '{"low_bad_threshold":"allowed"}';
  exception when others then out := out || jsonb_build_object('low_bad_threshold', sqlstate); end;
  delete from app_config where key = 'low_credit_threshold';

  -- 5. register_wallet
  insert into wallet_challenges (tenant_id, address, nonce, message) values (t1, wnew, repeat('1', 32), 'selftest') returning id into c1;
  select * into w from register_wallet(c1, t1);
  out := out || jsonb_build_object('reg', jsonb_build_array(w.result, w.address = wnew, w.previous_address = wa1),
    'reg_wallet', (select wallet_address = wnew from tenants where id = t1),
    'reg_challenge', (select used_at is not null and replaced_address = wa1 from wallet_challenges where id = c1));
  select * into w from register_wallet(c1, t1);
  out := out || jsonb_build_object('reg_used', w.result);
  insert into wallet_challenges (tenant_id, address, nonce, message, expires_at) values (t1, wa1, repeat('2', 32), 'selftest', now() - interval '1 second') returning id into c2;
  select * into w from register_wallet(c2, t1);
  out := out || jsonb_build_object('reg_expired', w.result, 'reg_expired_wallet_kept', (select wallet_address = wnew from tenants where id = t1));
  insert into wallet_challenges (tenant_id, address, nonce, message) values (t1, wa2, repeat('3', 32), 'selftest') returning id into c3;
  select * into w from register_wallet(c3, t1);
  out := out || jsonb_build_object('reg_taken', w.result, 'reg_taken_unused', (select used_at is null from wallet_challenges where id = c3));
  insert into wallet_challenges (tenant_id, address, nonce, message) values (t1, wdel, repeat('4', 32), 'selftest') returning id into c4;
  select * into w from register_wallet(c4, t1);
  out := out || jsonb_build_object('reg_taken_by_deleted', w.result);
  select * into w from register_wallet(c4, t2);
  out := out || jsonb_build_object('reg_other_tenant', w.result);
  insert into wallet_challenges (tenant_id, address, nonce, message) values (t1, wnew, repeat('5', 32), 'selftest') returning id into c5;
  select * into w from register_wallet(c5, t1);
  out := out || jsonb_build_object('reg_same_again', jsonb_build_array(w.result, w.previous_address));
  begin insert into wallet_challenges (tenant_id, address, nonce, message) values (t1, wnew, repeat('5', 32), 'selftest'); out := out || '{"reg_nonce_reuse":"allowed"}';
  exception when unique_violation then out := out || '{"reg_nonce_reuse":"refused"}'; end;
  begin insert into wallet_challenges (tenant_id, address, nonce, message) values (t1, '0xABC', repeat('6', 32), 'selftest'); out := out || '{"reg_bad_address":"allowed"}';
  exception when check_violation then out := out || '{"reg_bad_address":"refused"}'; end;
  out := out || jsonb_build_object('reg_default_ttl_s', (select round(extract(epoch from expires_at - created_at)) from wallet_challenges where id = c1));

  -- 6. least privilege, pinned search_path, comments
  begin
    set local role anon;
    begin perform match_deposit('0x__selftest_money_unm2', 0, t1, 'anon', 'anon attempt'); out := out || '{"anon_match":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_match":"denied"}'; end;
    begin perform claim_low_credit_notice(t1); out := out || '{"anon_claim":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_claim":"denied"}'; end;
    begin perform register_wallet(c1, t1); out := out || '{"anon_register":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_register":"denied"}'; end;
    begin perform payg_credits_per_usdc(1, 100); out := out || '{"anon_tiers":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_tiers":"denied"}'; end;
    begin perform release_low_credit_notice(t1); out := out || '{"anon_release":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_release":"denied"}'; end;
    begin perform 1 from wallet_challenges limit 1; out := out || '{"anon_challenges":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_challenges":"denied"}'; end;
    reset role;
  exception when others then out := out || jsonb_build_object('anon_match', 'set role failed: ' || sqlerrm);
  end;
  begin
    set local role service_role;
    out := out || jsonb_build_object('service_tiers', payg_credits_per_usdc(250, null),
      'service_challenges', (select count(*) from wallet_challenges where tenant_id = t1) > 0);
    select * into m1 from match_deposit('0x__selftest_money_unm', 0, t2, 'selftest', 'selftest: service_role replay');
    out := out || jsonb_build_object('service_match_replay', m1.replayed);
    reset role;
  exception when others then out := out || jsonb_build_object('service_tiers', 'error: ' || sqlerrm);
  end;
  out := out || jsonb_build_object(
    'definer_without_search_path', (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
       and p.proname in ('payg_credits_per_usdc', 'credit_from_deposit', 'match_deposit', 'claim_low_credit_notice', 'release_low_credit_notice', 'register_wallet')
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
    'uncommented_functions', (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('payg_credits_per_usdc', 'credit_from_deposit', 'match_deposit', 'claim_low_credit_notice', 'release_low_credit_notice', 'register_wallet', 'credit_ledger_low_credit_reset')
       and obj_description(p.oid, 'pg_proc') is null),
    'uncommented_columns', (select count(*) from information_schema.columns c
       where c.table_schema = 'public' and ((c.table_name = 'wallet_challenges') or (c.table_name = 'usdc_deposits' and c.column_name in ('credits_per_usdc', 'matched_by', 'match_reason', 'matched_at'))
         or (c.table_name = 'tenants' and c.column_name = 'low_credit_notified_at'))
       and col_description(format('public.%I', c.table_name)::regclass, c.ordinal_position) is null));
  raise exception '${TAG} %', out::text;
end $$;`;

export const MONEY_SELFTEST_EXPECT: Record<string, unknown> = {
  tier_49_99: 4999, tier_50: 5000, tier_249_99: 24999, tier_250: 27500, tier_999_99: 109998, tier_1000: 120000,
  tier_49_99_status: "credited", tier_50_status: "credited", tier_249_99_status: "credited", tier_250_status: "credited", tier_999_99_status: "credited", tier_1000_status: "credited",
  rate_recorded_250: 110, rate_recorded_1000: 120, packs: [5000, 27500, 120000], tier_ledger_rows: 6, tier_balance: 4999 + 5000 + 24999 + 27500 + 109998 + 120000,
  dust_status: "dust", dust_credits: 0, cent_status: "credited", cent_credits: 1, dust_row_status: "dust", replay_status: "duplicate",
  fallback_1000_at_100: 100000, fallback_10_at_77: 770, no_tiers_no_fallback: "RS004",
  malformed_falling: "RS004", malformed_no_zero: "RS004", malformed_typo_rate: "RS004", malformed_fraction_rate: "RS004", malformed_duplicate_min: "RS004",
  malformed_not_json: "RS004", malformed_not_array: "RS004", malformed_empty: "RS004", malformed_string_rate: "RS004", malformed_rows_written: 0,
  unmatched_status: "unmatched",
  match: { status: "credited", tenant: true, credits: 27500, balance_after: 27500, amount: "250.000000", rate: 110, replayed: false },
  match_again: { status: "credited", tenant: true, credits: 27500, balance_after: 27500, amount: "250.000000", rate: 110, replayed: true },
  match_ledger_rows: 1, match_balance: 27500, match_audit: true, match_note: true,
  match_scan_credited_same_tenant: { replayed: true, credits: 5000 },
  match_other_tenant: "RS003", match_dust: "RS003", match_missing: "P0002", match_deleted_tenant: "P0002", match_blank_reason: "22023", match_without_tiers: "RS004",
  refused_left_unmatched: "unmatched", refused_ledger_rows: 0, half_audit: "refused",
  low_above: false, low_default_threshold: 500, low_crossed: [true, 450], low_again: false, low_next_charge: false,
  low_refund_keeps_notice: true, low_after_refund_and_charge: false, low_cleared_by_grant: true, low_at_threshold: false,
  low_recrossed_after_grant: true, low_cleared_by_purchase: true, low_recrossed_after_purchase: true, low_after_release: true,
  low_threshold_data: [false, 100], low_bad_threshold: "RS004",
  reg: ["registered", true, true], reg_wallet: true, reg_challenge: true, reg_used: "used", reg_expired: "expired", reg_expired_wallet_kept: true,
  reg_taken: "taken", reg_taken_unused: true, reg_taken_by_deleted: "taken", reg_other_tenant: "not_found", reg_same_again: ["registered", null],
  reg_nonce_reuse: "refused", reg_bad_address: "refused", reg_default_ttl_s: 600,
  anon_match: "denied", anon_claim: "denied", anon_register: "denied", anon_tiers: "denied", anon_release: "denied", anon_challenges: "denied",
  service_tiers: 110, service_challenges: true, service_match_replay: true,
  definer_without_search_path: 0, uncommented_functions: 0, uncommented_columns: 0,
};

/** The results JSON from the raised message ("<TAG> {...}"), or null. */
export function parseResults(raised: string): Record<string, unknown> | null {
  let inner = raised;
  const j = raised.indexOf("{");
  if (j >= 0) { try { inner = String(JSON.parse(raised.slice(j)).message ?? raised); } catch { /* psql prints the message raw */ } }
  const m = inner.match(new RegExp(`${TAG} (\\{.*\\})`, "s"));
  if (!m) return null;
  try { return JSON.parse(m[1]!) as Record<string, unknown>; } catch { return null; }
}

/** JSON with object keys sorted: jsonb stores keys in its own order, so equality must not depend on it. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x);

/** PASS/FAIL per expected key; returns the number of failures. */
export function check(r: Record<string, unknown>, expect: Record<string, unknown>): number {
  let bad = 0;
  for (const [k, v] of Object.entries(expect)) {
    const ok = canonical(r[k]) === canonical(v);
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} money.${k} = ${JSON.stringify(r[k])}${ok ? "" : ` (expected ${JSON.stringify(v)})`}`);
  }
  return bad;
}

/** Whether this run may touch the target: a declared non-production target, or the staging project itself. */
export function allowedTarget(e: NodeJS.ProcessEnv): boolean {
  if (e.RESOLVE_SELFTEST_NON_PRODUCTION === "1") return true;
  return !!e.SUPABASE_PROJECT_REF && !!e.STAGING_SUPABASE_PROJECT_REF && e.SUPABASE_PROJECT_REF === e.STAGING_SUPABASE_PROJECT_REF;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--psql");
  const conninfo = i >= 0 ? args[i + 1] : undefined;
  if (i >= 0 && !conninfo) { console.error("usage: npx tsx scripts/selftest/money.ts [--psql <conninfo>]"); process.exit(2); }
  if (!conninfo) loadEnv();
  if (!allowedTarget(process.env)) {
    console.error("selftest/money: refused. Set RESOLVE_SELFTEST_NON_PRODUCTION=1 only for a staging or local database, or run with SUPABASE_PROJECT_REF equal to STAGING_SUPABASE_PROJECT_REF. The block rolls back, but it is never run against production.");
    process.exit(2);
  }
  let raised = "";
  if (conninfo) {
    const p = spawnSync(process.env.PSQL_BIN ?? "psql", [conninfo, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", MONEY_SELFTEST_SQL], { encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" } });
    if (p.error) { console.error(`psql could not run: ${p.error.message}`); process.exit(1); }
    raised = `${p.stderr}\n${p.stdout}`;
  } else {
    try { await sql(MONEY_SELFTEST_SQL); } catch (e) { raised = String(e); }
  }
  const r = parseResults(raised);
  if (!r) { console.error("selftest/money did not return results:", raised.slice(0, 1500)); process.exit(1); }
  const bad = check(r, MONEY_SELFTEST_EXPECT);
  console.log(`rolled back: nothing persisted from the money DO block (${Object.keys(MONEY_SELFTEST_EXPECT).length - bad}/${Object.keys(MONEY_SELFTEST_EXPECT).length} PASS)`);
  if (bad) process.exit(1);
}

if (process.argv[1] && /selftest[\\/]money\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(String(e)); process.exit(1); });

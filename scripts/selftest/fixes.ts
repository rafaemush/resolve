/**
 * Migration 017 (record integrity), rollback-only: everything runs inside one DO block that always raises at the end, so
 * nothing persists. It asserts:
 *   - market_event_key() gives what src/markets/event-key.ts eventKey() gives, case by case; the insert trigger fills an
 *     omitted event_key by that rule and keeps an explicit one; event_key is NOT NULL and fixed once a commit exists;
 *   - commit_context(): the latest commit by created_at (A -> B -> A: the last A), the other open non-test shadow legs of
 *     the event, distinct events with a public commit (legs count once, test markets never); a concurrent duplicate of
 *     commit:<market>:after:<latest> collides; settle_market refuses a plan that missed the newest commit and settles the
 *     final on it otherwise;
 *   - several pending commits may take one message_id (the 012 trigger, once each); note_post_failure counts attempts;
 *   - claim_post_lease: idle takes no lease, the pacing ceiling counts messages (legs sharing one count once), one holder
 *     at a time, renew, release by the holder only;
 *   - v_track_record: legs of an event count once (n_events_*), an event with a disagreeing leg is false, event_precision
 *     and its Wilson interval, and `reportable` is exactly 100 reconciled events (a 100-leg ladder does not open it);
 *   - least privilege: no relation, column, sequence or function in public is usable by anon or authenticated; the
 *     service_role keeps every table privilege and RPC the Worker uses.
 * Refused unless SUPABASE_PROJECT_REF equals STAGING_SUPABASE_PROJECT_REF or RESOLVE_SELFTEST_NON_PRODUCTION=1.
 *   RESOLVE_SELFTEST_NON_PRODUCTION=1 npx tsx scripts/selftest/fixes.ts --psql postgresql://postgres@localhost:5541/resolve
 *   npx tsx scripts/selftest/fixes.ts             (the Management API: the project .env names, staging only)
 */
import { loadEnv } from "../lib/env";
import { blockRunner, check, nonProductionRefusal, raisedResults, UsageError } from "../lib/selftest";
import { eventKey, type EventKeyInput } from "../../src/markets/event-key";

/** Inputs of the event-key rule; the expected value of each is eventKey() in TypeScript. */
const EVENT_KEY_CASES: EventKeyInput[] = [
  { platform: "limitless", external_id: "30percent-1789462576829", resolver: { kind: "official_release", series: "us_cpi_u_nsa_yoy", period: "2026-09" }, meta: {} },
  { platform: "polymarket", external_id: "12345", resolver: { kind: "official_release", series: "fomc_upper_bound", period: "2026-10-28" }, meta: { event_id: "60182" } },
  { platform: "polymarket", external_id: "637022", resolver: null, meta: { event_id: "60182" } },
  { platform: "polymarket", external_id: "637022", resolver: null, meta: { event_id: 60182 } },
  { platform: "limitless", external_id: "leg-slug", resolver: null, meta: { group_id: "10014423" } },
  { platform: "limitless", external_id: "leg-slug", resolver: null, meta: { event_id: "60182" } },
  { platform: "polymarket", external_id: "637022", resolver: null, meta: { group_id: "1" } },
  { platform: "polymarket", external_id: "637022", resolver: { kind: "github_release_published" }, meta: { event_id: "  " } },
  { platform: "custom", external_id: "smoke-1", resolver: null, meta: null },
];

/** Tables and privileges the Worker uses through PostgREST (grep of src/: from("...").select/insert/update/upsert). */
const SERVICE_TABLES: Array<[string, string]> = [
  ["alerts", "SELECT"], ["alerts", "INSERT"], ["api_keys", "SELECT"], ["api_keys", "INSERT"], ["api_keys", "UPDATE"], ["api_request_log", "INSERT"],
  ["app_config", "SELECT"], ["app_config", "INSERT"], ["app_config", "UPDATE"], ["bench_runs", "INSERT"], ["bot_posts", "SELECT"], ["bot_posts", "INSERT"],
  ["bot_posts", "UPDATE"], ["credit_ledger", "SELECT"], ["evidence", "SELECT"], ["evidence", "INSERT"], ["evidence", "UPDATE"], ["jev_calls", "INSERT"],
  ["loop_runs", "SELECT"], ["loop_runs", "INSERT"], ["market_follows", "SELECT"], ["market_follows", "UPDATE"], ["markets", "SELECT"], ["markets", "INSERT"],
  ["markets", "UPDATE"], ["official_observations", "SELECT"], ["post_leases", "SELECT"], ["post_leases", "INSERT"], ["post_leases", "UPDATE"],
  ["resolutions", "SELECT"], ["resolutions", "INSERT"], ["resolutions", "UPDATE"], ["tenants", "SELECT"], ["tenants", "INSERT"], ["v_track_record", "SELECT"],
  ["watches", "SELECT"], ["watches", "INSERT"], ["watches", "UPDATE"], ["webhook_deliveries", "SELECT"], ["webhook_deliveries", "UPDATE"],
  ["webhook_endpoints", "SELECT"], ["webhook_endpoints", "INSERT"], ["webhook_endpoints", "UPDATE"],
];
/** RPCs the Worker calls (grep of src/: rpc("...")). */
const SERVICE_RPCS = [
  "begin_resolution", "bump_api_key_usage_atomic", "check_gates", "claim_official_fetch", "claim_post_lease", "claim_webhook_deliveries", "commit_context",
  "credit_from_deposit", "defer_reconcile", "dispatch_failures", "extend_official_fetch", "follow_entitlements", "follow_market", "grant_credits",
  "note_post_failure", "recheck_official_corroboration", "record_jev_spend", "record_official_observation", "refund_credits", "release_post_lease",
  "report_eval_run", "settle_market", "upstream_record_failure", "upstream_record_success",
];

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const FIXES_BLOCK = `
do $$
declare
  out jsonb := '{}'::jsonb;
  pend0 integer; r jsonb; ctx jsonb; ev0 integer; msgs0 integer; n integer; k integer;
  m uuid; s uuid; lone uuid; tst uuid; tnt uuid; x uuid; p1 uuid; p2 uuid; q1 uuid; q2 uuid; c1 uuid; c2 uuid; c3 uuid; rows0 integer;
  filled text; kept text; b record; a record; g record;
begin
  -- 0. claim_post_lease with nothing pending takes no lease (checked first, before this block writes pending rows)
  select count(*) into pend0 from bot_posts where channel = 'pending' and kind in ('commit', 'reveal');
  r := claim_post_lease('__selftest_fx_channel__', 'h0', 30, 1000000, 60);
  out := out || jsonb_build_object('claim_idle_takes_no_lease',
    case when pend0 = 0 then r->>'reason' = 'idle' and not exists (select 1 from post_leases where channel = '__selftest_fx_channel__') else true end);
  delete from post_leases where channel = '__selftest_fx_channel__';

  -- 1. the event key rule, case by case (compared with eventKey() by the caller)
  out := out || jsonb_build_object('event_keys', (
    select coalesce(jsonb_agg(market_event_key(e->>'platform', e->>'external_id', e->'resolver', e->'meta') order by i), '[]'::jsonb)
      from jsonb_array_elements($cases$${JSON.stringify(EVENT_KEY_CASES)}$cases$::jsonb) with ordinality as t(e, i)));

  create or replace function pg_temp.fx_market(p_ext text, p_event text, p_platform text default 'custom') returns uuid language sql as $f$
    insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc, event_key)
    values (p_platform, p_ext, 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', now() - interval '3 days', now() - interval '2 days', p_event)
    returning id $f$;
  -- a leg with a resolution, a (never posted) commit and, when p_agreement is given, its final reconciliation
  create or replace function pg_temp.fx_leg(p_ext text, p_event text, p_agreement text) returns uuid language plpgsql as $f$
  declare mid uuid; rid text := '__selftest_fx_r_' || p_ext;
  begin
    mid := pg_temp.fx_market(p_ext, p_event);
    insert into resolutions (id, market_id, mode, status_row, resolution_status, winning_outcome, confidence_score, determination_basis, caveats, thresholds_version)
      values (rid, mid, 'shadow', 'complete', 'RESOLVED', 'OPTION_A', 0.95, 'structured', '[]', 'v1');
    insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at)
      values (rid, mid, 'none', 'commit', repeat('f', 64), 'n', '{}', '__selftest_fx_c_' || p_ext, null);
    if p_agreement is not null then
      insert into reconciliations (resolution_id, market_id, platform, official_outcome, agreement, final) values (rid, mid, 'custom', 'OPTION_A', p_agreement, true);
    end if;
    return mid;
  end $f$;

  -- 2. the insert trigger fills an omitted event_key by the rule and keeps an explicit one; NOT NULL; fixed after a commit
  insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc, meta)
    values ('polymarket', '__selftest_fx_fill__', 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', now() - interval '3 days', now() - interval '2 days', '{"event_id":"__selftest_ev__"}')
    returning event_key into filled;
  insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc, meta, event_key)
    values ('polymarket', '__selftest_fx_kept__', 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', now() - interval '3 days', now() - interval '2 days', '{"event_id":"__selftest_ev__"}', 'fx:explicit')
    returning event_key into kept;
  out := out || jsonb_build_object('fill_by_rule', filled, 'explicit_kept', kept);
  m := pg_temp.fx_market('__selftest_fx_m__', 'fx:E');
  begin update markets set event_key = 'fx:E-moved' where id = m; out := out || '{"event_key_change_before_commit": true}';
  exception when others then out := out || jsonb_build_object('event_key_change_before_commit', sqlerrm); end;
  update markets set event_key = 'fx:E' where id = m;
  begin update markets set event_key = null where id = m; out := out || '{"event_key_null_refused": false}';
  exception when not_null_violation then out := out || '{"event_key_null_refused": true}'; end;

  -- 3. commit_context: siblings, the latest commit (A -> B -> A), distinct public events
  s := pg_temp.fx_market('__selftest_fx_s__', 'fx:E');
  perform pg_temp.fx_market('__selftest_fx_closed__', 'fx:E');
  update markets set status = 'resolved' where external_id = '__selftest_fx_closed__';
  tst := pg_temp.fx_market('__selftest_fx_test__', 'fx:E');
  update markets set is_test = true where id = tst;
  insert into tenants (display_name) values ('__selftest_fx_tenant__') returning id into tnt;
  x := pg_temp.fx_market('__selftest_fx_tenant_leg__', 'fx:E');
  update markets set tenant_id = tnt where id = x;
  x := pg_temp.fx_market('__selftest_fx_deleted__', 'fx:E');
  update markets set deleted_at = now() where id = x;
  ctx := commit_context(m);
  ev0 := (ctx->>'public_commit_events')::integer;
  out := out || jsonb_build_object('ctx_event_key', ctx->>'event_key', 'ctx_no_commit_yet', ctx->'latest' = 'null'::jsonb, 'ctx_open_siblings', (ctx->>'event_open_markets')::integer);
  insert into resolutions (id, market_id, mode, status_row, resolution_status, winning_outcome, confidence_score, determination_basis, caveats, thresholds_version) values
    ('__selftest_fx_a1__', m, 'shadow', 'complete', 'RESOLVED', 'OPTION_A', 0.95, 'structured', '[]', 'v1'),
    ('__selftest_fx_b__', m, 'shadow', 'complete', 'UNRESOLVED', 'NONE', 0.50, 'structured', '["x"]', 'v1'),
    ('__selftest_fx_a2__', m, 'shadow', 'complete', 'RESOLVED', 'OPTION_A', 0.95, 'structured', '[]', 'v1');
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at, created_at)
    values ('__selftest_fx_a1__', m, 'pending', 'commit', repeat('1', 64), 'n', '{"verdict_signature":"RESOLVED|OPTION_A|"}', 'commit:' || m || ':after:none', null, now() - interval '3 minutes') returning id into c1;
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at, created_at)
    values ('__selftest_fx_b__', m, 'pending', 'commit', repeat('2', 64), 'n', '{"verdict_signature":"UNRESOLVED|NONE|"}', 'commit:' || m || ':after:' || c1, null, now() - interval '2 minutes') returning id into c2;
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at, created_at)
    values ('__selftest_fx_a2__', m, 'pending', 'commit', repeat('3', 64), 'n', '{"verdict_signature":"RESOLVED|OPTION_A|"}', 'commit:' || m || ':after:' || c2, null, now() - interval '1 minute') returning id into c3;
  begin
    insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at)
      values ('__selftest_fx_a2__', m, 'pending', 'commit', repeat('4', 64), 'n', '{}', 'commit:' || m || ':after:' || c2, null);
    out := out || '{"concurrent_duplicate_refused": false}';
  exception when unique_violation then out := out || '{"concurrent_duplicate_refused": true}'; end;
  ctx := commit_context(m);
  out := out || jsonb_build_object('ctx_latest_is_last_a', (ctx->'latest'->>'id')::uuid = c3, 'ctx_latest_signature', ctx->'latest'->>'verdict_signature');
  begin update markets set event_key = 'fx:E-moved' where id = m; out := out || '{"event_key_locked_after_commit": false}';
  exception when others then out := out || '{"event_key_locked_after_commit": true}'; end;
  insert into bot_posts (market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at) values (s, 'pending', 'commit', repeat('5', 64), 'n', '{}', '__selftest_fx_cs__', null);
  lone := pg_temp.fx_market('__selftest_fx_lone__', 'fx:lone');
  insert into bot_posts (market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at) values (lone, 'pending', 'commit', repeat('6', 64), 'n', '{}', '__selftest_fx_cl__', null);
  insert into bot_posts (market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at) values (tst, 'none', 'commit', repeat('7', 64), 'n', '{}', '__selftest_fx_ct__', null);
  out := out || jsonb_build_object('public_events_delta', (commit_context(m)->>'public_commit_events')::integer - ev0);
  -- settle_market: a plan that missed the newest commit is refused; with it, the final is the last A
  out := out || jsonb_build_object('settle_missing_commit', settle_market(m, array[c1, c2], '[]', '[]', 'resolved', 'OPTION_A', now(), null)->>'result');
  r := settle_market(m, array[c1, c2, c3], jsonb_build_array(
      jsonb_build_object('resolution_id', '__selftest_fx_a1__', 'platform', 'custom', 'official_outcome', 'OPTION_A', 'agreement', 'agree', 'final', false),
      jsonb_build_object('resolution_id', '__selftest_fx_b__', 'platform', 'custom', 'official_outcome', 'OPTION_A', 'agreement', 'abstained', 'final', false),
      jsonb_build_object('resolution_id', '__selftest_fx_a2__', 'platform', 'custom', 'official_outcome', 'OPTION_A', 'agreement', 'agree', 'final', true)),
    '[]', 'resolved', 'OPTION_A', now(), null);
  out := out || jsonb_build_object('settle_result', r->>'result', 'settle_final', (select resolution_id from reconciliations where market_id = m and final));

  -- 4. several pending commits share one message_id; failures are counted per row
  p1 := pg_temp.fx_market('__selftest_fx_p1__', 'fx:P'); p2 := pg_temp.fx_market('__selftest_fx_p2__', 'fx:P');
  insert into bot_posts (market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at) values (p1, 'pending', 'commit', repeat('8', 64), 'n', '{"post_attempts":0}', '__selftest_fx_cp1__', null) returning id into p1;
  insert into bot_posts (market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at) values (p2, 'pending', 'commit', repeat('9', 64), 'n', '{"post_attempts":0}', '__selftest_fx_cp2__', null) returning id into p2;
  q1 := pg_temp.fx_market('__selftest_fx_q1__', 'fx:Q');
  insert into bot_posts (market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at) values (q1, 'pending', 'commit', repeat('a', 64), 'n', '{"post_attempts":0}', '__selftest_fx_cq1__', null) returning id into q1;
  insert into bot_posts (market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at) values (lone, 'pending', 'reveal', repeat('b', 64), 'n', '{}', '__selftest_fx_rq2__', null) returning id into q2;
  update bot_posts set channel = 'telegram', message_id = 4242424242, telegram_date = now(), posted_at = now() where id in (p1, p2) and channel = 'pending';
  get diagnostics n = row_count;
  out := out || jsonb_build_object('note_failure_rows', note_post_failure(array[q1, q2, p1], 'selftest refused'));
  out := out || jsonb_build_object('shared_message_rows', n,
    'note_failure_attempts', (select payload->'post_attempts' from bot_posts where id = q1), 'note_failure_error', (select payload->>'post_error' from bot_posts where id = q1),
    'note_failure_reveal', (select payload->'post_attempts' from bot_posts where id = q2), 'posted_leg_untouched', (select payload->'post_attempts' from bot_posts where id = p1));
  begin update bot_posts set message_id = 1 where id = p2; out := out || '{"second_receipt_refused": false}';
  exception when others then out := out || '{"second_receipt_refused": true}'; end;

  -- 5. pacing counts messages (legs sharing one count once); one holder at a time
  select count(distinct message_id), count(*) into msgs0, rows0 from bot_posts
   where channel = 'telegram' and kind in ('commit', 'reveal') and message_id is not null and posted_at >= now() - interval '60 seconds';
  r := claim_post_lease('__selftest_fx_channel__', 'h1', 30, msgs0, 60);
  out := out || jsonb_build_object('paced_at_ceiling', r->>'reason');
  r := claim_post_lease('__selftest_fx_channel__', 'h1', 30, msgs0 + 1, 60);
  out := out || jsonb_build_object('claimed_under_ceiling', r->'claimed', 'window_counts_messages_not_rows', (r->>'messages_in_window')::integer = msgs0 and msgs0 < rows0);
  out := out || jsonb_build_object('second_holder', claim_post_lease('__selftest_fx_channel__', 'h2', 30, 1000000, 60)->>'reason',
    'same_holder_renews', claim_post_lease('__selftest_fx_channel__', 'h1', 30, 1000000, 60)->'claimed',
    'release_by_other', release_post_lease('__selftest_fx_channel__', 'h2'), 'release_by_holder', release_post_lease('__selftest_fx_channel__', 'h1'),
    'claim_after_release', claim_post_lease('__selftest_fx_channel__', 'h2', 30, 1000000, 60)->'claimed');
  begin perform claim_post_lease('__selftest_fx_channel__', 'h3', 0, 10, 60); out := out || '{"bad_seconds_refused": false}';
  exception when others then out := out || '{"bad_seconds_refused": true}'; end;

  -- 6. v_track_record by distinct event (platform custom: the Worker never reconciles it)
  select coalesce(sum(n_reconciled), 0)::int as n, coalesce(sum(n_events_reconciled), 0)::int as ev, coalesce(sum(events_false_resolved), 0)::int as f,
         coalesce(sum(n_events_committed), 0)::int as ec, coalesce(max(n_events_reconciled_cumulative), 0)::int as cum,
         coalesce(max(n_events_decided_cumulative), 0)::int as dec, coalesce(max(events_false_resolved_cumulative), 0)::int as fcum
    into b from v_track_record where platform = 'custom';
  perform pg_temp.fx_leg('__selftest_fx_e1a__', 'fx:E1', 'agree'); perform pg_temp.fx_leg('__selftest_fx_e1b__', 'fx:E1', 'agree');
  perform pg_temp.fx_leg('__selftest_fx_e1c__', 'fx:E1', 'disagree');
  perform pg_temp.fx_leg('__selftest_fx_e2a__', 'fx:E2', 'agree'); perform pg_temp.fx_leg('__selftest_fx_e2b__', 'fx:E2', 'abstained');
  perform pg_temp.fx_leg('__selftest_fx_e3__', 'fx:E3', 'void');
  select coalesce(sum(n_reconciled), 0)::int as n, coalesce(sum(n_events_reconciled), 0)::int as ev, coalesce(sum(events_false_resolved), 0)::int as f,
         coalesce(sum(n_events_committed), 0)::int as ec, coalesce(max(n_events_reconciled_cumulative), 0)::int as cum,
         coalesce(max(n_events_decided_cumulative), 0)::int as dec, coalesce(max(events_false_resolved_cumulative), 0)::int as fcum
    into a from v_track_record where platform = 'custom';
  out := out || jsonb_build_object('view_legs_delta', a.n - b.n, 'view_events_delta', a.ev - b.ev, 'view_false_events_delta', a.f - b.f,
    'view_committed_events_delta', a.ec - b.ec, 'view_cumulative_events_delta', a.cum - b.cum, 'view_decided_events_delta', a.dec - b.dec, 'view_false_cumulative_delta', a.fcum - b.fcum);
  for k in 1 .. 100 loop perform pg_temp.fx_leg('__selftest_fx_ladder_' || k, 'fx:ladder', 'agree'); end loop;
  select coalesce(max(n_events_reconciled_cumulative), 0)::int as cum, coalesce(sum(n_reconciled), 0)::int as n into b from v_track_record where platform = 'custom';
  out := out || jsonb_build_object('ladder_legs_delta', b.n - a.n, 'ladder_events_delta', b.cum - a.cum,
    'reportable_is_event_gate', (select bool_and(reportable = (n_events_reconciled_cumulative >= 100)) from v_track_record));
  k := greatest(0, 100 - b.cum);
  for n in 1 .. k loop perform pg_temp.fx_leg('__selftest_fx_single_' || n, 'fx:single:' || n, 'agree'); end loop;
  select * into g from v_track_record where platform = 'custom' order by week desc limit 1;
  out := out || jsonb_build_object('reportable_at_100_events', g.reportable, 'event_precision_formula',
    g.event_precision = round((g.n_events_decided_cumulative - g.events_false_resolved_cumulative)::numeric / g.n_events_decided_cumulative, 4),
    'event_wilson_brackets', g.event_wilson_low <= g.event_precision and g.event_precision <= g.event_wilson_high);

  -- 7. least privilege: nothing in public is usable by anon or authenticated; service_role keeps what the Worker uses
  out := out || jsonb_build_object(
    'anon_auth_relation_acl', (select count(*) from pg_class c, aclexplode(c.relacl) x
                                where c.relnamespace = 'public'::regnamespace and x.grantee in ('anon'::regrole, 'authenticated'::regrole)),
    'anon_auth_column_acl', (select count(*) from pg_attribute att join pg_class c on c.oid = att.attrelid, aclexplode(att.attacl) x
                              where c.relnamespace = 'public'::regnamespace and x.grantee in ('anon'::regrole, 'authenticated'::regrole)),
    'anon_auth_table_privileges', (select count(*) from pg_class c cross join (values ('anon'), ('authenticated')) w(role)
                                    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
                                      and has_table_privilege(w.role, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')),
    'anon_auth_sequence_privileges', (select count(*) from pg_class c cross join (values ('anon'), ('authenticated')) w(role)
                                       where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and has_sequence_privilege(w.role, c.oid, 'USAGE, SELECT, UPDATE')),
    'anon_auth_function_execute', (select count(*) from pg_proc p cross join (values ('anon'), ('authenticated')) w(role)
                                    where p.pronamespace = 'public'::regnamespace and has_function_privilege(w.role, p.oid, 'EXECUTE')),
    'service_role_tables_missing', (select coalesce(jsonb_agg(v.t || ' ' || v.p order by v.t, v.p), '[]'::jsonb)
                                     from jsonb_to_recordset($tables$${JSON.stringify(SERVICE_TABLES.map(([t, p]) => ({ t, p })))}$tables$::jsonb) as v(t text, p text)
                                    where to_regclass('public.' || v.t) is null or not has_table_privilege('service_role', to_regclass('public.' || v.t), v.p)),
    'service_role_rpcs_missing', (select coalesce(jsonb_agg(f order by f), '[]'::jsonb) from unnest(array[${SERVICE_RPCS.map(lit).join(", ")}]) as f
                                   where not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f
                                                        and has_function_privilege('service_role', p.oid, 'EXECUTE'))));
  begin
    set local role service_role;
    out := out || jsonb_build_object('service_role_commit_context', (commit_context(lone)->>'event_key'));
    reset role;
  exception when others then out := out || jsonb_build_object('service_role_commit_context', 'error: ' || sqlerrm);
  end;
  begin
    set local role anon;
    begin perform 1 from markets limit 1; out := out || '{"anon_markets_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_markets_denied": true}'; end;
    begin perform commit_context(lone); out := out || '{"anon_commit_context_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_commit_context_denied": true}'; end;
    begin perform claim_post_lease('__selftest_fx_channel__', 'anon', 30, 10, 60); out := out || '{"anon_claim_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_claim_denied": true}'; end;
    reset role;
  exception when others then out := out || jsonb_build_object('anon_markets_denied', 'set role failed: ' || sqlerrm);
  end;
  raise exception 'SELFTEST_FIXES %', out::text;
end $$;`;

export const FIXES_EXPECT: Record<string, unknown> = {
  claim_idle_takes_no_lease: true,
  event_keys: EVENT_KEY_CASES.map((c) => eventKey(c)),
  fill_by_rule: "polymarket:event:__selftest_ev__", explicit_kept: "fx:explicit", event_key_change_before_commit: true, event_key_null_refused: true,
  ctx_event_key: "fx:E", ctx_no_commit_yet: true, ctx_open_siblings: 1,
  concurrent_duplicate_refused: true, ctx_latest_is_last_a: true, ctx_latest_signature: "RESOLVED|OPTION_A|", event_key_locked_after_commit: true,
  public_events_delta: 2, settle_missing_commit: "commits_changed", settle_result: "settled", settle_final: "__selftest_fx_a2__",
  note_failure_rows: 2, shared_message_rows: 2, note_failure_attempts: 1, note_failure_error: "selftest refused", note_failure_reveal: 1, posted_leg_untouched: 0,
  second_receipt_refused: true,
  paced_at_ceiling: "paced", claimed_under_ceiling: true, window_counts_messages_not_rows: true,
  second_holder: "busy", same_holder_renews: true, release_by_other: false, release_by_holder: true, claim_after_release: true, bad_seconds_refused: true,
  view_legs_delta: 6, view_events_delta: 3, view_false_events_delta: 1, view_committed_events_delta: 3, view_cumulative_events_delta: 3,
  view_decided_events_delta: 2, view_false_cumulative_delta: 1,
  ladder_legs_delta: 100, ladder_events_delta: 1, reportable_is_event_gate: true,
  reportable_at_100_events: true, event_precision_formula: true, event_wilson_brackets: true,
  anon_auth_relation_acl: 0, anon_auth_column_acl: 0, anon_auth_table_privileges: 0, anon_auth_sequence_privileges: 0, anon_auth_function_execute: 0,
  service_role_tables_missing: [], service_role_rpcs_missing: [], service_role_commit_context: "fx:lone",
  anon_markets_denied: true, anon_commit_context_denied: true, anon_claim_denied: true,
};

async function main(): Promise<number> {
  loadEnv();
  const argv = process.argv.slice(2);
  let runner: ReturnType<typeof blockRunner>;
  try { runner = blockRunner(argv); } catch (e) {
    if (e instanceof UsageError) { console.error(e.message); return 2; }
    throw e;
  }
  const refusal = nonProductionRefusal();
  if (refusal) { console.error(`selftest fixes (migration 017): ${refusal}`); return 2; }
  const raw = await runner.run(FIXES_BLOCK);
  const r = raisedResults("SELFTEST_FIXES", raw);
  if (!r) { console.error("FAIL fixes: the block did not return results:", raw.slice(0, 1200)); return 1; }
  const bad = check(r, FIXES_EXPECT, "fixes.");
  console.log(`rolled back: nothing persisted from the fixes block (${runner.via})`);
  return bad ? 1 : 0;
}

if (process.argv[1]?.endsWith("fixes.ts")) main().then((code) => process.exit(code), (e) => { console.error(String(e)); process.exit(1); });

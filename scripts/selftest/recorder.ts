/**
 * Migration 018 (Limitless recorder): rollback-only assertions on real Postgres, kept apart from scripts/selftest-db.ts.
 *   RESOLVE_SELFTEST_NON_PRODUCTION=1 npx tsx scripts/selftest/recorder.ts               the SUPABASE_PROJECT_REF project (Management API)
 *   RESOLVE_SELFTEST_NON_PRODUCTION=1 npx tsx scripts/selftest/recorder.ts --psql <uri>  a local cluster through psql (PSQL=path overrides the binary)
 * Refused unless SUPABASE_PROJECT_REF equals STAGING_SUPABASE_PROJECT_REF or RESOLVE_SELFTEST_NON_PRODUCTION=1: the block
 * rolls back, but it deletes every limitless_markets row inside its transaction so the due order is deterministic, and
 * it is never pointed at production.
 * Everything runs in one DO block that always ends with RAISE, so nothing persists (not even the pg_net request
 * dispatch_internal queues: pg_net sends only committed rows). It asserts: the atomic merge (first sightings kept once,
 * a later observation never moves them, last_pending_at frozen at the first sighting, a failed check only moves the
 * queue, the last duplicate wins), the due order (never checked first, then least recently checked; containers,
 * outcomes and give-ups excluded), the observed_at guard, the set-once trigger and CHECK, least privilege, comments,
 * the cadence view (its week boundary to the second), dispatch_internal's signature, skip and failure rows, the cron
 * job where pg_cron exists, and the websocket listener's meta-only row (src/jobs/limitless-ws.ts: only meta moves).
 */
import { spawnSync } from "node:child_process";
import { loadEnv } from "../lib/env";
import { sql } from "../lib/mgmt";

const TAG = "SELFTEST_RECORDER";

const BLOCK = `
do $$
declare
  p constant text := 'selftest-rec-';
  obs text := (now() - interval '1 minute')::text;
  cur text := now()::text;
  r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; w0 jsonb; w1 jsonb; q record; v_req bigint; v_secret text; v_minute text; v_bool boolean;
  out jsonb := '{}'::jsonb;
begin
  delete from limitless_markets; -- rolled back with the block: real rows come back untouched

  -- rows with a known history, written as the owner
  insert into limitless_markets (slug, category, market_type, expiration_at, last_checked_at) values
    (p || 'c1', 'selftest-rec', 'single', now() - interval '5 hours', now() - interval '30 minutes'),
    (p || 'c2', 'selftest-rec', 'single', now() - interval '6 hours', now() - interval '60 minutes');
  insert into limitless_markets (slug, category, market_type, expiration_at, resolved_seen_at, winning_outcome_index, last_pending_at) values
    (p || 'old', 'selftest-rec', 'single', now() - interval '1 day', now() - interval '2 hours', 1, now() - interval '3 hours');
  insert into limitless_markets (slug, category, market_type, expiration_at, resolved_seen_at, meta) values
    (p || 'void', 'selftest-rec', 'single', now() - interval '1 day', now() - interval '2 hours', '{"void": true}');
  -- the cadence week boundary (no expiry, so never due): created at this week's Monday 00:00 UTC counts as created in
  -- the week of first sight; one second earlier, or three days earlier, is the previous week's backfill
  insert into limitless_markets (slug, category, market_type, platform_created_at) values
    (p || 'wk-start', 'selftest-rec', 'single', date_trunc('week', now() at time zone 'utc') at time zone 'utc'),
    (p || 'wk-prev-1s', 'selftest-rec', 'single', date_trunc('week', now() at time zone 'utc') at time zone 'utc' - interval '1 second'),
    (p || 'wk-prev-3d', 'selftest-rec', 'single', date_trunc('week', now() at time zone 'utc') at time zone 'utc' - interval '3 days');

  -- 1. a feed page: singles, a group with legs (one resolved), a group without legs, an old sighting seen again
  r1 := record_limitless_observations(jsonb_build_array(
    jsonb_build_object('slug', p || 's-exp', 'category', 'selftest-rec', 'market_type', 'single', 'expiration_at', (now() - interval '2 hours')::text, 'platform_created_at', cur, 'observed', true, 'observed_at', obs, 'expired', true),
    jsonb_build_object('slug', p || 's-fut', 'category', 'selftest-rec', 'market_type', 'single', 'expiration_at', (now() + interval '10 days')::text, 'platform_created_at', (now() - interval '60 days')::text, 'observed', true, 'observed_at', obs),
    jsonb_build_object('slug', p || 's-old', 'category', 'selftest-rec', 'market_type', 'single', 'expiration_at', (now() - interval '30 days')::text, 'observed', true, 'observed_at', obs, 'expired', true),
    jsonb_build_object('slug', p || 'g1', 'container', true, 'category', 'selftest-rec', 'market_type', 'group', 'expiration_at', (now() + interval '20 days')::text, 'observed', true, 'observed_at', obs, 'winning_outcome_index', 0),
    jsonb_build_object('slug', p || 'g1-a', 'group_slug', p || 'g1', 'category', 'selftest-rec', 'market_type', 'group', 'expiration_at', (now() - interval '3 hours')::text, 'observed', true, 'observed_at', obs, 'expired', true),
    jsonb_build_object('slug', p || 'g1-b', 'group_slug', p || 'g1', 'category', 'selftest-rec', 'market_type', 'group', 'expiration_at', (now() + interval '20 days')::text, 'observed', true, 'observed_at', obs),
    jsonb_build_object('slug', p || 'g1-c', 'group_slug', p || 'g1', 'category', 'selftest-rec', 'market_type', 'group', 'expiration_at', (now() - interval '4 hours')::text, 'observed', true, 'observed_at', obs, 'expired', true, 'winning_outcome_index', 1),
    jsonb_build_object('slug', p || 'g2', 'container', true, 'category', 'selftest-rec', 'market_type', 'group', 'expiration_at', (now() - interval '1 hour')::text, 'observed', true, 'observed_at', obs, 'expired', true),
    jsonb_build_object('slug', p || 'old', 'category', 'selftest-rec', 'observed', true, 'observed_at', obs, 'expired', true, 'winning_outcome_index', 0)
  ), 100, 21);
  out := out || jsonb_build_object('feed_counts', r1 - 'due' - 'groups_missing_legs', 'feed_missing_legs', r1->'groups_missing_legs', 'feed_due', r1->'due');
  select * into q from limitless_markets where slug = p || 'g1-c';
  out := out || jsonb_build_object('leg_first_sighting', q.resolved_seen_at = now() and q.winning_outcome_index = 1 and q.last_pending_at is null);
  select * into q from limitless_markets where slug = p || 'old';
  out := out || jsonb_build_object('old_sighting_kept', q.resolved_seen_at = now() - interval '2 hours' and q.winning_outcome_index = 1 and q.last_pending_at = now() - interval '3 hours');
  select * into q from limitless_markets where slug = p || 'g1';
  out := out || jsonb_build_object('container_no_outcome', q.winning_outcome_index is null and q.resolved_seen_at is null and q.last_pending_at is null);
  select * into q from limitless_markets where slug = p || 's-exp';
  out := out || jsonb_build_object('pending_row', q.last_pending_at = obs::timestamptz and q.expired_seen_at = now() and q.last_checked_at is null
    and q.check_attempts = 0 and q.platform_created_at = cur::timestamptz and q.resolved_seen_at is null);

  -- 2. the check phase: one resolved, one failed GET, one sighting seen again with another index
  r2 := record_limitless_observations(jsonb_build_array(
    jsonb_build_object('slug', p || 's-exp', 'checked', true, 'observed', true, 'observed_at', cur, 'expired', true, 'winning_outcome_index', 0, 'meta', '{"last_error": null, "last_http_status": 200}'::jsonb),
    jsonb_build_object('slug', p || 'g1-a', 'checked', true, 'observed', false, 'meta', '{"last_error": "HTTP 502", "last_http_status": 502}'::jsonb),
    jsonb_build_object('slug', p || 'g1-c', 'checked', true, 'observed', true, 'observed_at', cur, 'expired', true, 'winning_outcome_index', 0),
    jsonb_build_object('slug', p || 'old', 'observed', true, 'observed_at', cur, 'expired', true)
  ), 100, 21);
  out := out || jsonb_build_object('check_counts', r2 - 'due' - 'groups_missing_legs', 'check_due', r2->'due');
  select * into q from limitless_markets where slug = p || 's-exp';
  out := out || jsonb_build_object('check_resolved', q.resolved_seen_at = now() and q.winning_outcome_index = 0 and q.check_attempts = 1
    and q.last_checked_at = now() and q.last_pending_at = obs::timestamptz);
  select * into q from limitless_markets where slug = p || 'g1-a';
  out := out || jsonb_build_object('check_failed', q.check_attempts = 1 and q.last_checked_at = now() and q.meta->>'last_error' = 'HTTP 502'
    and q.resolved_seen_at is null and q.last_pending_at = obs::timestamptz and q.expired_seen_at = now() and q.group_slug = p || 'g1');
  select * into q from limitless_markets where slug = p || 'g1-c';
  out := out || jsonb_build_object('index_kept', q.winning_outcome_index = 1 and q.check_attempts = 1);
  select * into q from limitless_markets where slug = p || 'old';
  out := out || jsonb_build_object('pending_bound_frozen', q.last_pending_at = now() - interval '3 hours' and q.resolved_seen_at = now() - interval '2 hours');

  -- 3. the same slug twice in one call: the last observation wins
  r3 := record_limitless_observations(jsonb_build_array(
    jsonb_build_object('slug', p || 'dup', 'category', 'selftest-rec', 'market_type', 'single', 'expiration_at', (now() + interval '5 days')::text, 'observed', true, 'observed_at', obs),
    jsonb_build_object('slug', p || 'dup', 'category', 'selftest-rec', 'market_type', 'single', 'expiration_at', (now() + interval '5 days')::text, 'observed', true, 'observed_at', cur, 'expired', true, 'winning_outcome_index', 1)
  ), 0, 21);
  select * into q from limitless_markets where slug = p || 'dup';
  out := out || jsonb_build_object('dup_counts', r3 - 'due' - 'groups_missing_legs', 'dup_last_wins', q.winning_outcome_index = 1 and q.resolved_seen_at = now());

  -- 3b. the websocket listener's write (src/jobs/limitless-ws.ts): observed = false, checked = false, meta only. On a
  --     row the poll saw resolved and on a pending one, every column but meta keeps its value and meta gains the ws key
  --     with the other keys kept, even when the websocket's index disagrees with the poll's (old: poll 1, ws 0).
  select jsonb_object_agg(l.slug, to_jsonb(l)) into w0 from limitless_markets l where l.slug in (p || 'old', p || 's-fut');
  w1 := record_limitless_observations(jsonb_build_array(
    jsonb_build_object('slug', p || 'old', 'observed', false, 'checked', false, 'meta', jsonb_build_object('ws', jsonb_build_object('resolution_date', '2026-09-27T22:53:02.774Z', 'winning_index', 0, 'source', 'limitless_ws'))),
    jsonb_build_object('slug', p || 's-fut', 'observed', false, 'checked', false, 'meta', jsonb_build_object('ws', jsonb_build_object('resolution_date', '2026-09-27T22:53:04.042Z', 'winning_index', 1, 'source', 'limitless_ws')))
  ), 0, 21);
  out := out || jsonb_build_object('ws_counts', w1 - 'due' - 'groups_missing_legs', 'ws_meta_only', (
    select bool_and((to_jsonb(l) - 'meta') = ((w0->l.slug) - 'meta')
                    and l.meta = (w0->l.slug->'meta') || jsonb_build_object('ws', l.meta->'ws')
                    and l.meta->'ws'->>'source' = 'limitless_ws') and count(*) = 2
      from limitless_markets l where l.slug in (p || 'old', p || 's-fut')));

  -- 4. what the write path refuses
  begin perform record_limitless_observations(jsonb_build_array(jsonb_build_object('slug', p || 'stale', 'observed', true, 'observed_at', (now() - interval '20 minutes')::text)), 0, 21);
    out := out || '{"stale_observed_at":"allowed"}';
  exception when others then out := out || jsonb_build_object('stale_observed_at', case when sqlerrm like '%within the last 10 minutes%' then 'refused' else 'error: ' || sqlerrm end); end;
  begin perform record_limitless_observations(jsonb_build_array(jsonb_build_object('slug', p || 'no-time', 'observed', true)), 0, 21);
    out := out || '{"missing_observed_at":"allowed"}';
  exception when others then out := out || jsonb_build_object('missing_observed_at', case when sqlerrm like '%within the last 10 minutes%' then 'refused' else 'error: ' || sqlerrm end); end;
  begin perform record_limitless_observations('{}'::jsonb, 0, 21);
    out := out || '{"non_array":"allowed"}';
  exception when others then out := out || jsonb_build_object('non_array', case when sqlerrm like '%must be a json array%' then 'refused' else 'error: ' || sqlerrm end); end;

  -- 5. the set-once guard, for every writer (the owner included)
  begin update limitless_markets set resolved_seen_at = now() where slug = p || 'old';
    out := out || '{"move_sighting":"allowed"}';
  exception when others then out := out || jsonb_build_object('move_sighting', case when sqlerrm like '%set once%' then 'refused' else 'error: ' || sqlerrm end); end;
  begin update limitless_markets set winning_outcome_index = 0 where slug = p || 'old';
    out := out || '{"change_index":"allowed"}';
  exception when others then out := out || jsonb_build_object('change_index', case when sqlerrm like '%set once%' then 'refused' else 'error: ' || sqlerrm end); end;
  begin update limitless_markets set winning_outcome_index = 0 where slug = p || 'void';
    out := out || '{"index_after_void":"allowed"}';
  exception when others then out := out || jsonb_build_object('index_after_void', case when sqlerrm like '%cannot be added later%' then 'refused' else 'error: ' || sqlerrm end); end;
  begin insert into limitless_markets (slug, winning_outcome_index) values (p || 'no-sighting', 0);
    out := out || '{"index_without_sighting":"allowed"}';
  exception when check_violation then out := out || '{"index_without_sighting":"refused"}'; end;
  begin update limitless_markets set resolved_seen_at = now(), winning_outcome_index = 1 where slug = p || 'c1';
    out := out || '{"set_from_null":"allowed"}';
  exception when others then out := out || jsonb_build_object('set_from_null', 'error: ' || sqlerrm); end;
  begin update limitless_markets set meta = meta || '{"note": "selftest"}' where slug = p || 'old';
    out := out || '{"meta_on_resolved":"allowed"}';
  exception when others then out := out || jsonb_build_object('meta_on_resolved', 'error: ' || sqlerrm); end;

  -- 6. the due order after all of it: c1 now resolved, g1-a checked now
  r4 := record_limitless_observations('[]'::jsonb, 100, 21);
  out := out || jsonb_build_object('final_due', r4->'due', 'due_limit', jsonb_array_length(record_limitless_observations('[]'::jsonb, 1, 21)->'due'));

  -- 7. the cadence view (this week, the selftest category)
  select coalesce(sum(markets_first_seen), 0)::int as f, coalesce(sum(markets_created_in_week), 0)::int as c, coalesce(sum(markets_expiring_45d), 0)::int as e,
         coalesce(sum(legs_first_seen), 0)::int as l into q
    from v_limitless_cadence where category = 'selftest-rec' and week_start = (date_trunc('week', now() at time zone 'utc'))::date;
  out := out || jsonb_build_object('cadence', jsonb_build_object('first_seen', q.f, 'created_in_week', q.c, 'expiring_45d', q.e, 'legs', q.l));

  -- 8. least privilege
  begin
    set local role service_role;
    out := out || jsonb_build_object('service_role_select', (select count(*) from limitless_markets where slug like 'selftest-rec-%') > 0,
                                     'service_role_view', (select count(*) from v_limitless_cadence where category = 'selftest-rec') > 0);
    begin insert into limitless_markets (slug) values (p || 'direct');
      out := out || '{"service_role_insert":"allowed"}';
    exception when insufficient_privilege then out := out || '{"service_role_insert":"denied"}'; end;
    begin update limitless_markets set meta = '{}'::jsonb where slug = p || 'c2';
      out := out || '{"service_role_update":"allowed"}';
    exception when insufficient_privilege then out := out || '{"service_role_update":"denied"}'; end;
    begin perform record_limitless_observations('[]'::jsonb, 0, 21);
      out := out || '{"service_role_rpc":"allowed"}';
    exception when insufficient_privilege then out := out || '{"service_role_rpc":"denied"}'; end;
    reset role;
  exception when others then out := out || jsonb_build_object('service_role_block', 'error: ' || sqlerrm);
  end;
  begin
    set local role anon;
    begin perform 1 from limitless_markets limit 1;
      out := out || '{"anon_table":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_table":"denied"}'; end;
    begin perform 1 from v_limitless_cadence limit 1;
      out := out || '{"anon_view":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_view":"denied"}'; end;
    begin perform record_limitless_observations('[]'::jsonb, 0, 21);
      out := out || '{"anon_rpc":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_rpc":"denied"}'; end;
    begin perform dispatch_internal('limitless_record');
      out := out || '{"anon_dispatch":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_dispatch":"denied"}'; end;
    reset role;
  exception when others then out := out || jsonb_build_object('anon_block', 'error: ' || sqlerrm);
  end;
  out := out || jsonb_build_object(
    'authenticated_denied', not has_table_privilege('authenticated', 'public.limitless_markets', 'select')
      and not has_table_privilege('authenticated', 'public.v_limitless_cadence', 'select')
      and not has_function_privilege('authenticated', 'public.record_limitless_observations(jsonb,integer,integer)', 'execute')
      and not has_function_privilege('authenticated', 'public.dispatch_internal(text)', 'execute'),
    'service_role_dispatch', has_function_privilege('service_role', 'public.dispatch_internal(text)', 'execute'),
    'public_execute', (select count(*) from pg_proc f where f.oid in ('public.record_limitless_observations(jsonb,integer,integer)'::regprocedure,
        'public.dispatch_internal(text)'::regprocedure, 'public.limitless_markets_set_once()'::regprocedure)
        and (f.proacl is null or exists (select 1 from aclexplode(f.proacl) a where a.grantee = 0))),
    'definer_search_path', (select bool_and(f.prosecdef and exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%')) from pg_proc f
        where f.oid in ('public.record_limitless_observations(jsonb,integer,integer)'::regprocedure, 'public.dispatch_internal(text)'::regprocedure)),
    'forced_rls', (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.limitless_markets'::regclass),
    'view_security_invoker', (select coalesce('security_invoker=true' = any(reloptions), false) from pg_class where oid = 'public.v_limitless_cadence'::regclass),
    'uncommented', (select count(*) from pg_attribute a where a.attrelid in ('public.limitless_markets'::regclass, 'public.v_limitless_cadence'::regclass)
        and a.attnum > 0 and not a.attisdropped and col_description(a.attrelid, a.attnum) is null)
      + (select count(*) from (values (obj_description('public.limitless_markets'::regclass, 'pg_class')), (obj_description('public.v_limitless_cadence'::regclass, 'pg_class')),
        (obj_description('public.record_limitless_observations(jsonb,integer,integer)'::regprocedure, 'pg_proc')), (obj_description('public.dispatch_internal(text)'::regprocedure, 'pg_proc')),
        (obj_description('public.limitless_markets_set_once()'::regprocedure, 'pg_proc'))) d(c) where d.c is null));

  -- 9. dispatch_internal: failure, skip, signed request
  v_req := dispatch_internal('selftest_unknown');
  select * into q from loop_runs where loop_name = 'dispatch_internal' and meta->>'id' = 'selftest_unknown' order by id desc limit 1;
  out := out || jsonb_build_object('dispatch_unknown', v_req is null and q.outcome = 'failure' and q.error like '%unknown job id%');
  delete from app_config where key = 'worker_base_url';
  v_req := dispatch_internal('limitless_record');
  out := out || jsonb_build_object('dispatch_unconfigured', v_req is null and exists (select 1 from loop_runs where loop_name = 'dispatch_internal'
    and meta->>'id' = 'limitless_record' and outcome = 'skipped' and started_at >= now()));
  insert into app_config (key, value) values ('worker_base_url', 'https://selftest.invalid') on conflict (key) do update set value = excluded.value;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'internal_hmac_secret' limit 1;
  if v_secret is null then
    out := out || '{"dispatch_signed":"no internal_hmac_secret in vault (run scripts/configure-db.ts first)"}';
  else
    v_minute := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI');
    v_req := dispatch_internal('limitless_record');
    select * into q from net.http_request_queue where id = v_req;
    out := out || jsonb_build_object('dispatch_signed', v_req is not null and q.url = 'https://selftest.invalid/internal/limitless/record'
      and q.timeout_milliseconds = 30000 and q.headers->>'X-Internal-Minute' = v_minute
      and q.headers->>'X-Internal-Signature' = encode(extensions.hmac(convert_to('limitless_record|' || v_minute, 'utf8'), convert_to(v_secret, 'utf8'), 'sha256'), 'hex'));
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $c$select exists (select 1 from cron.job where jobname = 'limitless_recorder' and schedule = '*/10 * * * *' and active
      and command = 'select public.dispatch_internal(''limitless_record'')')$c$ into v_bool;
    out := out || jsonb_build_object('cron_job', v_bool);
  else
    out := out || '{"cron_job":"no_pg_cron"}';
  end if;

  raise exception '${TAG} %', out::text;
end $$;`;

const P = "selftest-rec-";
const EXPECT: Record<string, unknown> = {
  feed_counts: { inserted: 8, updated: 1, newly_expired: 6, newly_resolved: 1 },
  feed_missing_legs: [`${P}g2`],
  feed_due: [`${P}g1-a`, `${P}s-exp`, `${P}c2`, `${P}c1`],
  leg_first_sighting: true, old_sighting_kept: true, container_no_outcome: true, pending_row: true,
  check_counts: { inserted: 0, updated: 4, newly_expired: 0, newly_resolved: 1 },
  check_due: [`${P}c2`, `${P}c1`, `${P}g1-a`],
  check_resolved: true, check_failed: true, index_kept: true, pending_bound_frozen: true,
  dup_counts: { inserted: 1, updated: 0, newly_expired: 1, newly_resolved: 1 }, dup_last_wins: true,
  ws_counts: { inserted: 0, updated: 2, newly_expired: 0, newly_resolved: 0 }, ws_meta_only: true,
  stale_observed_at: "refused", missing_observed_at: "refused", non_array: "refused",
  move_sighting: "refused", change_index: "refused", index_after_void: "refused", index_without_sighting: "refused",
  set_from_null: "allowed", meta_on_resolved: "allowed",
  final_due: [`${P}c2`, `${P}g1-a`], due_limit: 1,
  cadence: { first_seen: 13, created_in_week: 2, expiring_45d: 3, legs: 3 }, // created_in_week: s-exp and wk-start, never wk-prev-*
  service_role_select: true, service_role_view: true, service_role_insert: "denied", service_role_update: "denied", service_role_rpc: "allowed",
  anon_table: "denied", anon_view: "denied", anon_rpc: "denied", anon_dispatch: "denied",
  authenticated_denied: true, service_role_dispatch: true, public_execute: 0, definer_search_path: true, forced_rls: true, view_security_invoker: true, uncommented: 0,
  dispatch_unknown: true, dispatch_unconfigured: true, dispatch_signed: true,
  cron_job: true,
};

/** JSON with object keys sorted: jsonb orders keys its own way, so equal objects must compare equal. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

function refuseUnlessNonProduction(): void {
  const ref = process.env.SUPABASE_PROJECT_REF, staging = process.env.STAGING_SUPABASE_PROJECT_REF;
  if (process.env.RESOLVE_SELFTEST_NON_PRODUCTION === "1" || (!!ref && !!staging && ref === staging)) return;
  console.error("selftest/recorder: refused. Point SUPABASE_PROJECT_REF at STAGING_SUPABASE_PROJECT_REF, or set RESOLVE_SELFTEST_NON_PRODUCTION=1 only for a staging or local database (the block rolls back, but it is never run against production).");
  process.exit(2);
}

/** The block's error text: through psql (stderr) for a local cluster, else the Management API. */
async function runBlock(psqlUri: string | null): Promise<string> {
  if (psqlUri) {
    const r = spawnSync(process.env.PSQL ?? "psql", [psqlUri, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", BLOCK], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    if (r.error) throw r.error;
    return `${r.stderr}`;
  }
  try { await sql(BLOCK); return ""; } catch (e) { return String(e); }
}

async function main(): Promise<void> {
  loadEnv();
  refuseUnlessNonProduction();
  const i = process.argv.indexOf("--psql");
  const psqlUri = i >= 0 ? process.argv[i + 1] ?? null : null;
  if (i >= 0 && !psqlUri) { console.error("usage: npx tsx scripts/selftest/recorder.ts [--psql <connection uri>]"); process.exit(2); }
  const msg = await runBlock(psqlUri);
  let inner = msg;
  const j = msg.indexOf("{");
  if (!psqlUri && j >= 0) { try { inner = String(JSON.parse(msg.slice(j)).message ?? msg); } catch { /* keep raw */ } }
  const m = inner.match(new RegExp(`${TAG} (\\{[^\\n]*\\})`));
  if (!m) { console.error("selftest/recorder did not return results:", msg.slice(0, 800)); process.exit(1); }
  const r = JSON.parse(m[1]!) as Record<string, unknown>;
  const expect = { ...EXPECT, ...(psqlUri && r.cron_job === "no_pg_cron" ? { cron_job: "no_pg_cron" } : {}) }; // a local cluster has no pg_cron
  let bad = 0;
  for (const [k, v] of Object.entries(expect)) {
    const ok = canonical(r[k]) === canonical(v);
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} recorder.${k} = ${JSON.stringify(r[k])}${ok ? "" : ` (expected ${JSON.stringify(v)})`}`);
  }
  for (const k of Object.keys(r)) if (!(k in expect)) { bad++; console.log(`FAIL recorder.${k} = ${JSON.stringify(r[k])} (unexpected key)`); }
  console.log("rolled back: nothing persisted from the recorder DO block");
  if (bad) process.exit(1);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });

/**
 * Migration 024 (redispatch_official_legs, the second-stamped single-use signature), rollback-only: everything runs inside
 * one DO block that always raises at the end, so nothing persists (pg_net's queued requests included: they are sent only
 * on commit, and app_config worker_base_url is pointed at https://selftest.invalid inside the block anyway). It asserts:
 *   - redispatch_official_legs(): every open leg of the series and period whose lease is free or expired is leased for
 *     30 s and gets one queued POST to /internal/watch/<id> whose X-Internal-Minute is a stamp to the second; the holder
 *     is skipped (its live lease untouched); a leg whose run is in flight (a live lease), another period, another series,
 *     a market that is not open and an inactive watch are untouched; legs, dispatched and busy are counted; one loop_runs
 *     row (redispatch_official, success). With p_holder_too the holder's own live lease is handed over and it is
 *     dispatched with the sibling series given. No worker_base_url: skipped with a loop_runs row, nothing leased. No
 *     series: failure with the error text and a loop_runs row, nothing leased.
 *   - claim_watch_dispatch(): a second-stamped dispatch is claimed once (the replay is signature_used), and is a row of
 *     its own beside the same minute's stamp; its lease is checked against the stamp's own second with a threshold of its
 *     own (59 s claimed; 60 s and the 151 s of a later 120 s lease taken at S + 31 s lease_superseded, where a minute stamp
 *     would still claim it: 179 s claimed, 180 s lease_superseded for the minute form); a malformed stamp is refused by the widened check (check_violation).
 *   - least privilege: anon and authenticated cannot execute redispatch_official_legs, PUBLIC holds no EXECUTE,
 *     service_role can; SECURITY DEFINER with a pinned search_path; commented, as is the minute column.
 * Supabase only (vault and pg_net). Refused unless SUPABASE_PROJECT_REF equals STAGING_SUPABASE_PROJECT_REF or
 * RESOLVE_SELFTEST_NON_PRODUCTION=1 (with --psql, only the latter); the target is printed first.
 *   npx tsx scripts/selftest/inline.ts             (the Management API: the project .env names, staging only)
 */
import { loadEnv } from "../lib/env";
import { blockRunner, check, describeTarget, nonProductionRefusal, raisedResults, UsageError } from "../lib/selftest";

const TAG = "SELFTEST_INLINE";
const FN = "'public.redispatch_official_legs(text[],text,uuid,boolean)'::regprocedure";

export const INLINE_BLOCK = `
do $$
declare out jsonb := '{}'::jsonb; r jsonb; v_stamp text; v_bool boolean;
  m_a uuid; m_b uuid; m_sib uuid; m_other uuid; m_shut uuid;
  w_holder uuid; w_free uuid; w_late uuid; w_busy uuid; w_sib uuid; w_other uuid; w_shut uuid; w_off uuid; w_59 uuid; w_60 uuid; w_151 uuid; w_m179 uuid; w_m180 uuid;
  mk constant text := 'insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc, resolver, status) values (''custom'', $1, ''selftest condition'', ''selftest statement'', ''Yes'', ''No'', ''OPTION_A'', now() - interval ''1 day'', now() + interval ''1 day'', $2, $3) returning id';
  wk constant text := 'insert into watches (market_id, source_kind, source_ref, lease_until, active) values ($1, ''official_release'', ''{"ref":"official:selftest"}'', $2, $3) returning id';
  cpi constant jsonb := '{"kind":"official_release","series":"us_cpi_u_nsa_yoy","period":"2099-01"}';
  mom constant jsonb := '{"kind":"official_release","series":"us_cpi_u_sa_mom","period":"2099-01"}';
  later constant jsonb := '{"kind":"official_release","series":"us_cpi_u_nsa_yoy","period":"2099-02"}';
  queued constant text := 'select count(*) from net.http_request_queue where url = ''https://selftest.invalid/internal/watch/'' || $1::text and length(headers->>''X-Internal-Minute'') = 19';
  n integer;
begin
  insert into app_config (key, value) values ('worker_base_url', 'https://selftest.invalid') on conflict (key) do update set value = excluded.value;
  insert into app_config (key, value) values ('watch_daily_cap', '100000000') on conflict (key) do update set value = excluded.value;
  if not exists (select 1 from vault.decrypted_secrets where name = 'internal_hmac_secret') then
    perform vault.create_secret('selftest-secret', 'internal_hmac_secret');
  end if;
  execute mk into m_a using '__selftest_inline_a__', cpi, 'open';
  execute mk into m_b using '__selftest_inline_b__', cpi, 'open';
  execute mk into m_sib using '__selftest_inline_sib__', mom, 'open';
  execute mk into m_other using '__selftest_inline_other__', later, 'open';
  execute mk into m_shut using '__selftest_inline_shut__', cpi, 'unsupported_source';
  execute wk into w_holder using m_a, now() + interval '50 seconds', true;  -- the holder: its poll kept the lease
  execute wk into w_free using m_b, null::timestamptz, true;
  execute wk into w_late using m_b, now() - interval '1 second', true;     -- an expired lease is free
  execute wk into w_busy using m_b, now() + interval '90 seconds', true;   -- a run in flight
  execute wk into w_sib using m_sib, null::timestamptz, true;
  execute wk into w_other using m_other, null::timestamptz, true;
  execute wk into w_shut using m_shut, null::timestamptz, true;
  execute wk into w_off using m_b, null::timestamptz, false;

  -- the holder's series, holder skipped ----------------------------------------------------------------------------
  r := redispatch_official_legs(array['us_cpi_u_nsa_yoy'], '2099-01', w_holder, false);
  out := out || jsonb_build_object('event_outcome', r->>'outcome', 'event_counts', jsonb_build_array(r->'legs', r->'dispatched', r->'busy'),
    'event_stamp_seconds', length(r->>'stamp') = 19);
  -- statements of their own: the call's updates are invisible to the snapshot of the statement that made it
  out := out || jsonb_build_object(
    'event_leased_30s', (select bool_and(lease_until = now() + interval '30 seconds') from watches where id in (w_free, w_late)),
    'event_holder_untouched', (select lease_until = now() + interval '50 seconds' from watches where id = w_holder),
    'event_busy_untouched', (select lease_until = now() + interval '90 seconds' from watches where id = w_busy),
    'event_others_untouched', (select bool_and(lease_until is null) from watches where id in (w_sib, w_other, w_shut, w_off)),
    'event_next_poll_untouched', (select bool_and(next_poll_at <= now()) from watches where id in (w_free, w_late)),
    'event_loop_run', (select jsonb_build_array(outcome, rows_written, meta->'busy') from loop_runs where loop_name = 'redispatch_official' order by started_at desc, id desc limit 1));
  execute queued into n using w_free;
  out := out || jsonb_build_object('event_post_free', n);
  execute queued into n using w_holder;
  out := out || jsonb_build_object('event_post_holder', n);

  -- the holder hands its lease over, with the sibling series ----------------------------------------------------------
  r := redispatch_official_legs(array['us_cpi_u_nsa_yoy', 'us_cpi_u_sa_mom'], '2099-01', w_holder, true);
  out := out || jsonb_build_object('handover_counts', jsonb_build_array(r->'legs', r->'dispatched', r->'busy'));
  out := out || jsonb_build_object('handover_leased', (select bool_and(lease_until = now() + interval '30 seconds') from watches where id in (w_holder, w_sib)),
    'handover_other_period_untouched', (select lease_until is null from watches where id = w_other));

  -- refusals that never look like "nothing to dispatch" ---------------------------------------------------------------
  r := redispatch_official_legs(array[]::text[], '2099-01', null, false);
  out := out || jsonb_build_object('no_series', jsonb_build_array(r->>'outcome', r ? 'error'));
  delete from app_config where key = 'worker_base_url';
  update watches set lease_until = null where id = w_free;
  r := redispatch_official_legs(array['us_cpi_u_nsa_yoy'], '2099-01', w_holder, false);
  out := out || jsonb_build_object('no_url', jsonb_build_array(r->>'outcome', r->'dispatched'));
  out := out || jsonb_build_object('no_url_nothing_leased', (select lease_until is null from watches where id = w_free),
    'no_url_loop_run', (select outcome from loop_runs where loop_name = 'redispatch_official' order by started_at desc, id desc limit 1));

  -- claim_watch_dispatch with a stamp to the second -------------------------------------------------------------------
  v_stamp := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS');
  out := out || jsonb_build_object('claim_second', claim_watch_dispatch(w_late, v_stamp),
    'claim_second_replay', claim_watch_dispatch(w_late, v_stamp),
    'claim_minute_beside', claim_watch_dispatch(w_late, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI')));
  execute wk into w_59 using m_b, '2099-01-01T00:00:09+00'::timestamptz + interval '59 seconds', true;
  execute wk into w_60 using m_b, '2099-01-01T00:00:09+00'::timestamptz + interval '60 seconds', true;
  -- the redispatch's 30 s lease expired and the minute tick (or a tenant fetch) leased the leg at S + 31 s for 120 s
  execute wk into w_151 using m_b, '2099-01-01T00:00:09+00'::timestamptz + interval '151 seconds', true;
  execute wk into w_m179 using m_b, '2099-01-01T00:00:00+00'::timestamptz + interval '179 seconds', true;
  execute wk into w_m180 using m_b, '2099-01-01T00:00:00+00'::timestamptz + interval '180 seconds', true;
  out := out || jsonb_build_object('claim_second_59s', claim_watch_dispatch(w_59, '2099-01-01T00:00:09'),
    'claim_second_60s', claim_watch_dispatch(w_60, '2099-01-01T00:00:09'),
    'claim_second_later_lease', claim_watch_dispatch(w_151, '2099-01-01T00:00:09'),
    'claim_minute_179s', claim_watch_dispatch(w_m179, '2099-01-01T00:00'),
    'claim_minute_180s', claim_watch_dispatch(w_m180, '2099-01-01T00:00'));
  begin perform claim_watch_dispatch(w_late, '2099-01-01T00:00:9'); out := out || '{"claim_bad_stamp":"allowed"}';
  exception when check_violation then out := out || '{"claim_bad_stamp":"refused"}'; end;
  begin perform claim_watch_dispatch(w_late, '2099-01-01T00:00:09Z'); out := out || '{"claim_bad_stamp_z":"allowed"}';
  exception when check_violation then out := out || '{"claim_bad_stamp_z":"refused"}'; end;

  -- privileges and conventions ---------------------------------------------------------------------------------------
  begin
    set local role service_role;
    r := redispatch_official_legs(array['us_cpi_u_nsa_yoy'], '2099-01', w_holder, false);
    out := out || jsonb_build_object('service_role_call', r->>'outcome');
    reset role;
    set local role anon;
    begin perform redispatch_official_legs(array['us_cpi_u_nsa_yoy'], '2099-01', w_holder, false); out := out || '{"anon_call":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_call":"denied"}'; end;
    reset role;
  exception when others then out := out || jsonb_build_object('privileges_block', 'error: ' || sqlerrm);
  end;
  out := out || jsonb_build_object(
    'authenticated_denied', not has_function_privilege('authenticated', ${FN}, 'execute'),
    'public_execute', (select count(*) from pg_proc f where f.oid = ${FN} and (f.proacl is null or exists (select 1 from aclexplode(f.proacl) a where a.grantee = 0))),
    'definer_search_path', (select f.prosecdef and exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%') from pg_proc f where f.oid = ${FN}),
    'uncommented', (select count(*) from pg_proc f where f.oid = ${FN} and obj_description(f.oid, 'pg_proc') is null)
      + (select count(*) from pg_attribute a where a.attrelid = 'public.used_dispatch_signatures'::regclass and a.attname = 'minute' and col_description(a.attrelid, a.attnum) is null));
  raise exception '${TAG} %', out::text;
end $$;`;

export const INLINE_EXPECT: Record<string, unknown> = {
  event_outcome: "dispatched", event_counts: [3, 2, 1], event_stamp_seconds: true,
  event_leased_30s: true, event_holder_untouched: true, event_busy_untouched: true, event_others_untouched: true, event_next_poll_untouched: true,
  event_loop_run: ["success", 2, 1], event_post_free: 1, event_post_holder: 0,
  // the holder's series (holder, free and late now leased by the first call, busy) and the sibling series: the holder
  // (handed over) and the sibling are dispatched; free, late and busy hold live leases
  handover_counts: [5, 2, 3], handover_leased: true, handover_other_period_untouched: true,
  no_series: ["failure", true], no_url: ["skipped", 0], no_url_nothing_leased: true, no_url_loop_run: "skipped",
  claim_second: "claimed", claim_second_replay: "signature_used", claim_minute_beside: "claimed",
  claim_second_59s: "claimed", claim_second_60s: "lease_superseded", claim_second_later_lease: "lease_superseded",
  claim_minute_179s: "claimed", claim_minute_180s: "lease_superseded", claim_bad_stamp: "refused", claim_bad_stamp_z: "refused",
  service_role_call: "skipped", anon_call: "denied",
  authenticated_denied: true, public_execute: 0, definer_search_path: true, uncommented: 0,
};

async function main(): Promise<number> {
  loadEnv();
  let runner: ReturnType<typeof blockRunner>;
  try { runner = blockRunner(process.argv.slice(2)); } catch (e) {
    if (e instanceof UsageError) { console.error(e.message); return 2; }
    throw e;
  }
  console.log(`selftest inline target: ${describeTarget(runner)}`);
  const refusal = nonProductionRefusal(process.env, runner.via);
  if (refusal) { console.error(`selftest inline (migration 024): ${refusal}`); return 2; }
  const raw = await runner.run(INLINE_BLOCK);
  const r = raisedResults(TAG, raw);
  if (!r) { console.error("FAIL inline: the block did not return results:", raw.slice(0, 1200)); return 1; }
  let bad = check(r, INLINE_EXPECT, "inline.");
  for (const k of Object.keys(r)) if (!(k in INLINE_EXPECT)) { bad++; console.log(`FAIL inline.${k} = ${JSON.stringify(r[k])} (unexpected key)`); }
  console.log(`rolled back: nothing persisted from the inline block (${runner.via})`);
  return bad ? 1 : 0;
}

if (process.argv[1]?.endsWith("inline.ts")) main().then((code) => process.exit(code), (e) => { console.error(String(e)); process.exit(1); });

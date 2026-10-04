/**
 * Migration 023 (charge_reveals, refund_late_reveals, follow_event, the delivery priority, storage_status's refund keys),
 * rollback-only: everything runs inside one DO block that always raises at the end, so nothing persists. It asserts:
 *   - charge_reveals(): a paying tenant is charged once per (tenant, market) (one credit_ledger 'charge' row, request id
 *     reveal:<tenant>:<market>, note 'reveal webhook' or 'reveal read'); the same pair again, from either source, is a
 *     replay (charged 0, no second row); a short balance is locked with nothing written; an included plan and a free
 *     tenant created before the cut-over are free; a free tenant after it pays and its first charge below the threshold
 *     claims the low-credit notice (once); in one call two legs of one event under a 50-credit cap: one charged, the
 *     other free past the cap; after a refund the cap reopens (net of refunds); a settled market is public (free at any
 *     balance, nothing written); a deleted tenant is unknown_tenant; another
 *     tenant's id raises RS003; a bad price, cap, source, pair list, a tenant market and a test market raise 22023. A
 *     concurrent duplicate needs a second session: scripts/selftest-db.ts --concurrency-probe races it on staging;
 *   - claim_webhook_deliveries(): a due priority-3 row is claimed before an older due priority-0 row, and a first
 *     attempt before an older retry of the same priority (every other due row is moved out of the way inside the block,
 *     and that is rolled back with the rest);
 *   - refund_late_reveals(): a webhook charge whose every delivery dead-lettered without an attempt, and one first
 *     attempted and delivered after its deadline, are refunded once (a second run refunds nothing more); one delivered in
 *     time, one attempted in time that then dead-lettered (the endpoint had the body), one whose deadline has not passed,
 *     one the tenant read back (a read's replay leaves a reveal_reads row), and a read's charge are not; the run writes
 *     its loop_runs row and storage_status() reports it;
 *   - follow_event(): every open public leg once (settled, test, tenant and deleted legs left out), again idempotent,
 *     all or nothing at the cap, not_followable for a test market, a negative cap and an unknown tenant refused;
 *   - least privilege: anon cannot execute the new functions, PUBLIC holds no EXECUTE, service_role can; each is
 *     SECURITY DEFINER with a pinned search_path and commented, as are the three new columns; the cron job.
 * Refused unless SUPABASE_PROJECT_REF equals STAGING_SUPABASE_PROJECT_REF or RESOLVE_SELFTEST_NON_PRODUCTION=1 (with
 * --psql, only the latter); the target is printed first.
 *   RESOLVE_SELFTEST_NON_PRODUCTION=1 npx tsx scripts/selftest/reveal.ts --psql postgresql://postgres@localhost:5541/resolve
 *   npx tsx scripts/selftest/reveal.ts             (the Management API: the project .env names, staging only)
 */
import { loadEnv } from "../lib/env";
import { blockRunner, check, describeTarget, nonProductionRefusal, raisedResults, UsageError } from "../lib/selftest";

const TAG = "SELFTEST_REVEAL";
const FNS = "'public.charge_reveals(uuid[],uuid[],integer,integer,timestamptz,text[],text)'::regprocedure, 'public.refund_late_reveals(integer)'::regprocedure, 'public.follow_event(uuid,uuid,integer)'::regprocedure, 'public.claim_webhook_deliveries(integer)'::regprocedure, 'public.storage_status()'::regprocedure";
/** charge_reveals with the Worker's price (25), cap (2,000), cut-over (the block's now()) and included plans. */
const CR = (tenants: string, markets: string, source = "webhook", cap = "2000") => `charge_reveals(array[${tenants}]::uuid[], array[${markets}]::uuid[], 25, ${cap}, now(), array['builder','growth','platform'], '${source}')`;
/** One answer as [entitled_full, replayed, charged, balance, reason]. */
const ROW = "jsonb_build_array(c.entitled_full, c.replayed, c.charged, c.balance, c.reason)";

export const REVEAL_BLOCK = `
do $$
declare
  out jsonb := '{}'::jsonb;
  tp uuid; ts uuid; tb uuid; tg uuid; tn uuid; td uuid; tf uuid; tc uuid; tr uuid;
  m1 uuid; m2 uuid; m3 uuid; mx uuid; mten uuid; mtest uuid; e1 uuid; e2 uuid; e3 uuid; ex uuid; esettled uuid; etest uuid;
  ep uuid; d0 uuid; d3 uuid; dr uuid; claimed uuid; rp1 uuid; rp2 uuid; rp3 uuid; rp4 uuid; rp5 uuid; rp6 uuid; rp7 uuid; msettled uuid;
  v_res jsonb; v_res2 jsonb; st jsonb; v_bool boolean;
  r record; v_paid uuid; v_free uuid;
  mk constant text := 'insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc, tenant_id, status, event_key) values (''custom'', $1, ''selftest condition'', ''selftest statement'', ''Yes'', ''No'', ''OPTION_A'', now() - interval ''3 days'', now() + interval ''2 days'', $2, $3, $4) returning id';
begin
  -- tenants: created_at set explicitly (now() is one value in this transaction; the cut-over passed below is now())
  insert into tenants (display_name, plan, credits_balance, created_at) values ('__selftest_reveal_pay__', 'payg', 60, now()) returning id into tp;
  insert into tenants (display_name, plan, credits_balance, created_at) values ('__selftest_reveal_short__', 'payg', 10, now()) returning id into ts;
  insert into tenants (display_name, plan, credits_balance, created_at) values ('__selftest_reveal_builder__', 'builder', 0, now()) returning id into tb;
  insert into tenants (display_name, plan, credits_balance, created_at) values ('__selftest_reveal_grand__', 'free', 300, now() - interval '30 days') returning id into tg;
  insert into tenants (display_name, plan, credits_balance, created_at) values ('__selftest_reveal_new__', 'free', 300, now()) returning id into tn;
  insert into tenants (display_name, plan, credits_balance, created_at, deleted_at) values ('__selftest_reveal_del__', 'payg', 100, now(), now()) returning id into td;
  execute mk into m1 using '__selftest_reveal_m1__', null::uuid, 'open', '__selftest_reveal_event__';
  execute mk into m2 using '__selftest_reveal_m2__', null::uuid, 'open', '__selftest_reveal_event__';
  execute mk into m3 using '__selftest_reveal_m3__', null::uuid, 'open', '__selftest_reveal_event__';
  execute mk into mx using '__selftest_reveal_mx__', null::uuid, 'open', '__selftest_reveal_other__';
  execute mk into mten using '__selftest_reveal_mten__', tp, 'open', '__selftest_reveal_ten__';
  execute mk into mtest using '__selftest_reveal_mtest__', null::uuid, 'open', '__selftest_reveal_test__';
  update markets set is_test = true where id = mtest;

  -- 1. charge_reveals --------------------------------------------------------------------------------------------------
  -- Every read of what a charge wrote is a statement of its own: read in the charge's statement it would see that
  -- statement's snapshot, from before the charge (the 022 refund_balance lesson).
  out := out || jsonb_build_object('first', (select ${ROW} from ${CR("tp", "m1")} c));
  out := out || jsonb_build_object('ledger_row', (select jsonb_build_array(l.delta, l.note, l.balance_after) from credit_ledger l where l.reason = 'charge' and l.request_id = 'reveal:' || tp || ':' || m1));
  out := out || jsonb_build_object('replay_read', (select ${ROW} from ${CR("tp", "m1", "read")} c));
  out := out || jsonb_build_object('replay_rows', (select count(*) from credit_ledger l where l.tenant_id = tp and l.reason = 'charge'));
  out := out || jsonb_build_object('short', (select jsonb_build_array(c.entitled_full, c.charged, c.price, c.balance, c.reason) from ${CR("ts", "m1")} c));
  out := out || jsonb_build_object('short_rows', (select count(*) from credit_ledger l where l.tenant_id = ts));
  out := out || jsonb_build_object('included', (select ${ROW} from ${CR("tb", "m1")} c),
    'grandfathered', (select ${ROW} from ${CR("tg", "m1")} c),
    'deleted_tenant', (select jsonb_build_array(c.entitled_full, c.charged, c.reason) from ${CR("td", "m1")} c));
  out := out || jsonb_build_object('after_cutover', (select jsonb_build_array(c.charged, c.reason, c.low_credit) from ${CR("tn", "m1")} c));
  out := out || jsonb_build_object('second_charge_low_credit', (select c.low_credit from ${CR("tn", "mx")} c));
  -- two legs of one event under a 50-credit cap, in one call: tp paid 25 for m1, so the first leg processed (market id
  -- order) costs 25 and the other is free past the cap
  v_res := '[]'::jsonb;
  for r in select * from ${CR("tp, tp", "m3, m2", "webhook", "50")} c loop
    v_res := v_res || jsonb_build_array(jsonb_build_array(r.charged, r.reason));
    if r.charged > 0 then v_paid := r.market_id; else v_free := r.market_id; end if;
  end loop;
  out := out || jsonb_build_object('event_cap', (select jsonb_agg(x order by (x->>0)::int desc) from jsonb_array_elements(v_res) x),
    'event_cap_balance', (select credits_balance from tenants where id = tp),
    'event_cap_rows', (select count(*) from credit_ledger l where l.tenant_id = tp and l.reason = 'charge'));
  -- a refund reopens the cap: net of refunds, tp has paid 25 for the event, so the leg that was free now costs 25
  perform refund_credits('reveal:' || tp || ':' || v_paid);
  out := out || jsonb_build_object('cap_after_refund', (select jsonb_build_array(c.charged, c.reason) from ${CR("tp", "v_free", "webhook", "50")} c));
  -- another tenant's id under this tenant's pair raises RS003; nothing else is written
  insert into credit_ledger (tenant_id, delta, reason, request_id, balance_after, note) values (tb, -1, 'charge', 'reveal:' || ts || ':' || mx, 0, 'selftest');
  begin perform 1 from ${CR("ts", "mx")} c; out := out || '{"other_tenant":"allowed"}';
  exception when others then out := out || jsonb_build_object('other_tenant', sqlstate); end;
  begin perform 1 from ${CR("tp", "mten")} c; out := out || '{"tenant_market":"allowed"}';
  exception when others then out := out || jsonb_build_object('tenant_market', sqlstate); end;
  begin perform 1 from ${CR("tp", "mtest")} c; out := out || '{"test_market":"allowed"}';
  exception when others then out := out || jsonb_build_object('test_market', sqlstate); end;
  begin perform 1 from charge_reveals(array[tp], array[m1], 0, 2000, now(), array['builder'], 'read') c; out := out || '{"zero_price":"allowed"}';
  exception when others then out := out || jsonb_build_object('zero_price', sqlstate); end;
  begin perform 1 from charge_reveals(array[tp], array[m1], 25, 10, now(), array['builder'], 'read') c; out := out || '{"cap_below_price":"allowed"}';
  exception when others then out := out || jsonb_build_object('cap_below_price', sqlstate); end;
  begin perform 1 from charge_reveals(array[tp], array[m1], 25, 2000, now(), array['builder'], 'gift') c; out := out || '{"bad_source":"allowed"}';
  exception when others then out := out || jsonb_build_object('bad_source', sqlstate); end;
  begin perform 1 from charge_reveals(array[tp, ts], array[m1], 25, 2000, now(), array['builder'], 'read') c; out := out || '{"unpaired":"allowed"}';
  exception when others then out := out || jsonb_build_object('unpaired', sqlstate); end;
  out := out || jsonb_build_object('empty', (select count(*) from charge_reveals('{}'::uuid[], '{}'::uuid[], 25, 2000, now(), array['builder'], 'read')));
  -- a settled market's commits are public: free at a short balance, nothing written
  execute mk into msettled using '__selftest_reveal_ms__', null::uuid, 'resolved', '__selftest_reveal_settled__';
  out := out || jsonb_build_object('settled_public', (select ${ROW} from ${CR("ts", "msettled")} c));
  out := out || jsonb_build_object('settled_rows', (select count(*) from credit_ledger l where l.tenant_id = ts));

  -- 2. claim_webhook_deliveries: priority first -------------------------------------------------------------------------
  insert into webhook_endpoints (tenant_id, url, secret, events) values (tp, 'https://example.org/__selftest_reveal__', 's', '{shadow.committed}') returning id into ep;
  -- every other due row out of the way (rolled back with the block)
  update webhook_deliveries set next_attempt_at = now() + interval '1 day' where status = 'pending' and next_attempt_at <= now();
  insert into webhook_deliveries (endpoint_id, tenant_id, event_type, payload, next_attempt_at, priority) values (ep, tp, 'shadow.committed', '{}', now() - interval '10 minutes', 0) returning id into d0;
  insert into webhook_deliveries (endpoint_id, tenant_id, event_type, payload, next_attempt_at, priority) values (ep, tp, 'shadow.committed', '{}', now() - interval '1 minute', 3) returning id into d3;
  select d.id into claimed from claim_webhook_deliveries(1) d;
  out := out || jsonb_build_object('claim_priority_first', claimed = d3, 'claim_old_still_pending', (select status from webhook_deliveries where id = d0));
  -- within one priority a first attempt goes before an older retry (the retry of an endpoint that failed waits)
  insert into webhook_deliveries (endpoint_id, tenant_id, event_type, payload, next_attempt_at, priority, attempt) values (ep, tp, 'shadow.committed', '{}', now() - interval '9 minutes', 3, 2) returning id into dr;
  insert into webhook_deliveries (endpoint_id, tenant_id, event_type, payload, next_attempt_at, priority) values (ep, tp, 'shadow.committed', '{}', now() - interval '1 minute', 3) returning id into d3;
  select d.id into claimed from claim_webhook_deliveries(1) d;
  out := out || jsonb_build_object('claim_first_attempt_first', claimed = d3);
  begin insert into webhook_deliveries (endpoint_id, tenant_id, event_type, payload, priority) values (ep, tp, 'shadow.committed', '{}', 7); out := out || '{"priority_7":"allowed"}';
  exception when check_violation then out := out || '{"priority_7":"refused"}'; end;
  begin insert into webhook_deliveries (endpoint_id, tenant_id, event_type, payload, reveal_charge_id) values (ep, tp, 'shadow.committed', '{}', 'reveal:' || tp || ':' || m1); out := out || '{"charge_without_due":"allowed"}';
  exception when check_violation then out := out || '{"charge_without_due":"refused"}'; end;

  -- 3. refund_late_reveals -----------------------------------------------------------------------------------------------
  insert into tenants (display_name, plan, credits_balance, created_at) values ('__selftest_reveal_refund__', 'payg', 1000, now()) returning id into tr;
  execute mk into rp1 using '__selftest_reveal_r1__', null::uuid, 'open', '__selftest_reveal_r1__';
  execute mk into rp2 using '__selftest_reveal_r2__', null::uuid, 'open', '__selftest_reveal_r2__';
  execute mk into rp3 using '__selftest_reveal_r3__', null::uuid, 'open', '__selftest_reveal_r3__';
  execute mk into rp4 using '__selftest_reveal_r4__', null::uuid, 'open', '__selftest_reveal_r4__';
  execute mk into rp5 using '__selftest_reveal_r5__', null::uuid, 'open', '__selftest_reveal_r5__';
  execute mk into rp6 using '__selftest_reveal_r6__', null::uuid, 'open', '__selftest_reveal_r6__';
  execute mk into rp7 using '__selftest_reveal_r7__', null::uuid, 'open', '__selftest_reveal_r7__';
  perform 1 from ${CR("tr, tr, tr, tr, tr, tr", "rp1, rp2, rp3, rp4, rp6, rp7")} c;   -- six webhook charges
  perform 1 from ${CR("tr", "rp5", "read")} c;                                         -- a read's charge
  perform 1 from ${CR("tr", "rp7", "read")} c;                                         -- the tenant reads rp7 back: a replay
  out := out || jsonb_build_object('read_receipt', (select count(*) from reveal_reads rr where rr.request_id = 'reveal:' || tr || ':' || rp7));
  insert into webhook_deliveries (endpoint_id, tenant_id, event_type, payload, status, reveal_charge_id, reveal_due_at) values
    -- rp1: every delivery dead-lettered without an attempt (the endpoint inactive), past its deadline
    (ep, tr, 'shadow.committed', '{}', 'dlq', 'reveal:' || tr || ':' || rp1, now() - interval '1 minute'),
    (ep, tr, 'shadow.committed', '{}', 'dlq', 'reveal:' || tr || ':' || rp1, now() - interval '1 minute'),
    -- rp4: not past its deadline yet (still retrying)
    (ep, tr, 'shadow.committed', '{}', 'pending', 'reveal:' || tr || ':' || rp4, now() + interval '5 minutes'),
    -- rp5 (a read's charge): dead-lettered past a deadline, still never refunded
    (ep, tr, 'shadow.committed', '{}', 'dlq', 'reveal:' || tr || ':' || rp5, now() - interval '1 minute'),
    -- rp7: never attempted, but the tenant read it back
    (ep, tr, 'shadow.committed', '{}', 'dlq', 'reveal:' || tr || ':' || rp7, now() - interval '1 minute');
  insert into webhook_deliveries (endpoint_id, tenant_id, event_type, payload, status, first_attempt_at, reveal_charge_id, reveal_due_at) values
    -- rp6: attempted two minutes before its deadline (the endpoint answered 500 and dead-lettered later): it had the body
    (ep, tr, 'shadow.committed', '{}', 'dlq', now() - interval '3 minutes', 'reveal:' || tr || ':' || rp6, now() - interval '1 minute');
  insert into webhook_deliveries (endpoint_id, tenant_id, event_type, payload, status, delivered_at, reveal_charge_id, reveal_due_at) values
    -- rp2: delivered one minute before its deadline (one endpoint is enough)
    (ep, tr, 'shadow.committed', '{}', 'delivered', now() - interval '2 minutes', 'reveal:' || tr || ':' || rp2, now() - interval '1 minute'),
    (ep, tr, 'shadow.committed', '{}', 'dlq', null, 'reveal:' || tr || ':' || rp2, now() - interval '1 minute'),
    -- rp3: first attempted and delivered one minute after its deadline (the queue was behind)
    (ep, tr, 'shadow.committed', '{}', 'delivered', now(), 'reveal:' || tr || ':' || rp3, now() - interval '1 minute');
  update webhook_deliveries set first_attempt_at = delivered_at where reveal_charge_id = 'reveal:' || tr || ':' || rp3;
  v_res := refund_late_reveals(10);
  v_res2 := refund_late_reveals(10);
  out := out || jsonb_build_object('refund_error', v_res ? 'error',
    'refunded', jsonb_build_array(
      (select count(*) from credit_ledger l where l.reason = 'refund' and l.request_id = 'reveal:' || tr || ':' || rp1),
      (select count(*) from credit_ledger l where l.reason = 'refund' and l.request_id = 'reveal:' || tr || ':' || rp2),
      (select count(*) from credit_ledger l where l.reason = 'refund' and l.request_id = 'reveal:' || tr || ':' || rp3),
      (select count(*) from credit_ledger l where l.reason = 'refund' and l.request_id = 'reveal:' || tr || ':' || rp4),
      (select count(*) from credit_ledger l where l.reason = 'refund' and l.request_id = 'reveal:' || tr || ':' || rp5),
      (select count(*) from credit_ledger l where l.reason = 'refund' and l.request_id = 'reveal:' || tr || ':' || rp6),
      (select count(*) from credit_ledger l where l.reason = 'refund' and l.request_id = 'reveal:' || tr || ':' || rp7)),
    'refund_balance', (select credits_balance from tenants where id = tr),
    'refund_run_row', (select jsonb_build_array(l.outcome = any(array['success', 'no_op']), l.meta ? 'refunded', (l.meta->>'late_minutes')::int) from loop_runs l
                         where l.loop_name = 'reveal_refund' order by l.id desc limit 1));
  st := storage_status();
  out := out || jsonb_build_object('storage_refund', st->'last_refund' ? 'outcome' and st ? 'refund_scheduled',
    'storage_keys', (select jsonb_agg(k order by k) from jsonb_object_keys(st) k));

  -- 4. follow_event -------------------------------------------------------------------------------------------------------
  insert into tenants (display_name, plan, created_at) values ('__selftest_reveal_follower__', 'payg', now()) returning id into tf;
  insert into tenants (display_name, plan, created_at) values ('__selftest_reveal_capped__', 'free', now()) returning id into tc;
  execute mk into e1 using '__selftest_reveal_e1__', null::uuid, 'open', '__selftest_reveal_followed_event__';
  execute mk into e2 using '__selftest_reveal_e2__', null::uuid, 'open', '__selftest_reveal_followed_event__';
  execute mk into e3 using '__selftest_reveal_e3__', null::uuid, 'open', '__selftest_reveal_followed_event__';
  execute mk into esettled using '__selftest_reveal_es__', null::uuid, 'resolved', '__selftest_reveal_followed_event__';
  execute mk into etest using '__selftest_reveal_et__', null::uuid, 'open', '__selftest_reveal_followed_event__';
  update markets set is_test = true where id = etest;
  execute mk into ex using '__selftest_reveal_ex__', tp, 'open', '__selftest_reveal_followed_event__';
  v_res := follow_event(tf, e2, 500);
  out := out || jsonb_build_object('event_follow', jsonb_build_array(v_res->>'result', (v_res->>'legs')::int, (v_res->>'followed')::int, (v_res->>'already_following')::int),
    'event_follow_rows', (select jsonb_agg(f.market_id = any(array[e1, e2, e3]) order by f.market_id) from market_follows f where f.tenant_id = tf and f.deleted_at is null));
  v_res := follow_event(tf, e1, 500);
  out := out || jsonb_build_object('event_follow_again', jsonb_build_array(v_res->>'result', (v_res->>'followed')::int, (v_res->>'already_following')::int));
  v_res := follow_event(tc, e1, 2);
  out := out || jsonb_build_object('follow_event_cap', jsonb_build_array(v_res->>'result', (v_res->>'legs')::int, (v_res->>'cap')::int),
    'follow_event_cap_rows', (select count(*) from market_follows f where f.tenant_id = tc));
  out := out || jsonb_build_object('event_test_market', follow_event(tf, etest, null)->>'result', 'event_settled_market', follow_event(tf, esettled, null)->>'reason');
  begin perform follow_event(tf, e1, -1); out := out || '{"event_negative_cap":"allowed"}';
  exception when others then out := out || '{"event_negative_cap":"refused"}'; end;
  begin perform follow_event(gen_random_uuid(), e1, null); out := out || '{"event_unknown_tenant":"allowed"}';
  exception when others then out := out || '{"event_unknown_tenant":"refused"}'; end;

  -- 5. least privilege, pinned search_path, comments, the cron job --------------------------------------------------------
  begin
    set local role anon;
    begin perform 1 from ${CR("tp", "m1", "read")} c; out := out || '{"anon_charge":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_charge":"denied"}'; end;
    begin perform refund_late_reveals(10); out := out || '{"anon_refund":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_refund":"denied"}'; end;
    begin perform follow_event(tf, e1, null); out := out || '{"anon_follow_event":"allowed"}';
    exception when insufficient_privilege then out := out || '{"anon_follow_event":"denied"}'; end;
    reset role;
  exception when others then out := out || jsonb_build_object('anon_charge', 'set role failed: ' || sqlerrm);
  end;
  begin
    set local role service_role;
    out := out || jsonb_build_object('service_charge', (select c.reason from ${CR("tp", "m1", "read")} c));
    reset role;
  exception when others then out := out || jsonb_build_object('service_charge', 'error: ' || sqlerrm);
  end;
  out := out || jsonb_build_object(
    'public_execute', (select count(*) from pg_proc f where f.oid in (${FNS})
      and (f.proacl is null or exists (select 1 from aclexplode(f.proacl) a where a.grantee = 0))),
    'definer_search_path', (select bool_and(f.prosecdef and exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%')) from pg_proc f where f.oid in (${FNS})),
    'uncommented', (select count(*) from pg_proc f where f.oid in (${FNS}) and obj_description(f.oid, 'pg_proc') is null)
      + (select count(*) from pg_attribute a where a.attrelid = 'public.webhook_deliveries'::regclass and a.attname in ('priority', 'reveal_charge_id', 'reveal_due_at', 'first_attempt_at') and col_description(a.attrelid, a.attnum) is null)
      + (select count(*) from pg_attribute a where a.attrelid = 'public.reveal_reads'::regclass and a.attnum > 0 and not a.attisdropped and col_description(a.attrelid, a.attnum) is null)
      + (case when obj_description('public.reveal_reads'::regclass, 'pg_class') is null then 1 else 0 end),
    'reveal_reads_rls', (select c.relrowsecurity and c.relforcerowsecurity from pg_class c where c.oid = 'public.reveal_reads'::regclass),
    'reveal_reads_anon', has_table_privilege('anon', 'public.reveal_reads', 'select'));
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $c$select exists (select 1 from cron.job where jobname = 'refund_late_reveals' and schedule = '*/5 * * * *' and active
      and command = 'select public.refund_late_reveals(10)')$c$ into v_bool;
    out := out || jsonb_build_object('cron_job', v_bool);
  else
    out := out || '{"cron_job":"no_pg_cron"}';
  end if;
  raise exception '${TAG} %', out::text;
end $$;`;

export const REVEAL_EXPECT: Record<string, unknown> = {
  first: [true, false, 25, 35, "charged"], ledger_row: [-25, "reveal webhook", 35],
  replay_read: [true, true, 0, 35, "replay"], replay_rows: 1,
  short: [false, 0, 25, 10, "insufficient_credits"], short_rows: 0,
  included: [true, false, 0, 0, "included_plan"], grandfathered: [true, false, 0, 300, "grandfathered"], deleted_tenant: [false, 0, "unknown_tenant"],
  after_cutover: [25, "charged", true], second_charge_low_credit: false,
  event_cap: [[25, "charged"], [0, "event_cap_reached"]], event_cap_balance: 10, event_cap_rows: 2,
  cap_after_refund: [25, "charged"],
  other_tenant: "RS003", tenant_market: "22023", test_market: "22023", zero_price: "22023", cap_below_price: "22023", bad_source: "22023", unpaired: "22023", empty: 0,
  settled_public: [true, false, 0, 10, "public"], settled_rows: 0,
  claim_priority_first: true, claim_old_still_pending: "pending", claim_first_attempt_first: true, priority_7: "refused", charge_without_due: "refused",
  read_receipt: 1,
  // rp1 .. rp7: dlq without an attempt, delivered in time, attempted and delivered late, not due yet, a read's charge, attempted in time then dlq, read back
  refund_error: false, refunded: [1, 0, 1, 0, 0, 0, 0], refund_balance: 1000 - 7 * 25 + 2 * 25, refund_run_row: [true, true, 10],
  storage_refund: true, storage_keys: ["database_bytes", "last_purge", "last_refund", "purge_scheduled", "refund_scheduled"],
  event_follow: ["followed", 3, 3, 0], event_follow_rows: [true, true, true], event_follow_again: ["followed", 0, 3],
  follow_event_cap: ["cap_reached", 3, 2], follow_event_cap_rows: 0,
  event_test_market: "not_followable", event_settled_market: "market is resolved", event_negative_cap: "refused", event_unknown_tenant: "refused",
  anon_charge: "denied", anon_refund: "denied", anon_follow_event: "denied", service_charge: "replay",
  public_execute: 0, definer_search_path: true, uncommented: 0, reveal_reads_rls: true, reveal_reads_anon: false, cron_job: true,
};

async function main(): Promise<number> {
  loadEnv();
  let runner: ReturnType<typeof blockRunner>;
  try { runner = blockRunner(process.argv.slice(2)); } catch (e) {
    if (e instanceof UsageError) { console.error(e.message); return 2; }
    throw e;
  }
  console.log(`selftest reveal target: ${describeTarget(runner)}`);
  const refusal = nonProductionRefusal(process.env, runner.via);
  if (refusal) { console.error(`selftest reveal (migration 023): ${refusal}`); return 2; }
  const raw = await runner.run(REVEAL_BLOCK);
  const r = raisedResults(TAG, raw);
  if (!r) { console.error("FAIL reveal: the block did not return results:", raw.slice(0, 1200)); return 1; }
  // a local cluster without pg_cron keeps the function and schedules nothing
  const expect = { ...REVEAL_EXPECT, ...(runner.via === "psql" && r.cron_job === "no_pg_cron" ? { cron_job: "no_pg_cron" } : {}) };
  let bad = check(r, expect, "reveal.");
  for (const k of Object.keys(r)) if (!(k in expect)) { bad++; console.log(`FAIL reveal.${k} = ${JSON.stringify(r[k])} (unexpected key)`); }
  console.log(`rolled back: nothing persisted from the reveal block (${runner.via})`);
  return bad ? 1 : 0;
}

if (process.argv[1]?.endsWith("reveal.ts")) main().then((code) => process.exit(code), (e) => { console.error(String(e)); process.exit(1); });

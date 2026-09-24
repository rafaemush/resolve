-- 013_ops_alerts: watch dispatch made observable to the Worker's alerting (plan §16.4 P0 step 7, §19.2 item 6).
-- MEASURED 2026-09-23 (plan §16.2): select_due_watches() fires one pg_net POST per due watch and nobody reads the
-- answers, and a run that throws rolls back its own loop_runs row, so a broken dispatcher leaves no trace the Worker
-- can see (09-22: 109 skipped runs noticed only by hand). The database cannot DM the operator; the Worker can:
--   * select_due_watches() now writes a 'failure' row (error text + SQLSTATE) when it throws; the every-minute tick
--     reads the newest row and alerts on skipped / failure / no row at all (src/jobs/tick.ts).
--   * dispatch_failures(p_minutes) counts pg_net answers that were not a delivered dispatch; the 10-minute job alerts
--     when it is above zero (src/jobs/dispatch.ts).
--
-- Compatibility with the Worker deployed before this migration (it keeps running until the new one is deployed):
--   * select_due_watches() keeps its signature, its schedule, its leasing and its success / no_op / skipped rows; only
--     a run that throws changes, from "no row, pg_cron logs the error" to "a 'failure' row, the leases and queued
--     requests of that run rolled back as before". The old Worker never reads these rows.
--   * dispatch_failures() is new; the old Worker never calls it.
--   * The old Worker answers 500 for a watch poll whose outcome is 'failure' (a source error); the new one answers 200
--     for any run that recorded its outcome. Until the new Worker is deployed, dispatch_failures() also counts those
--     polls; deploy it right after this migration.
begin;

-- 1. select_due_watches(): identical dispatch, plus a 'failure' row when the run throws ---------------------------
create or replace function public.select_due_watches()
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare
  v_start   timestamptz := clock_timestamp();
  v_url     text;
  v_secret  text;
  v_cap     integer;
  v_batch   integer;
  v_today   integer;
  v_minute  text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI');
  v_sig     text;
  v_state   text;
  v_msg     text;
  r         record;
  n         integer := 0;
begin
  select value into v_url from app_config where key = 'worker_base_url';
  select value::integer into v_cap from app_config where key = 'watch_daily_cap';
  select value::integer into v_batch from app_config where key = 'watch_batch_max';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'internal_hmac_secret' limit 1;

  if v_url is null or v_secret is null then
    insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, error)
    values ('select_due_watches', v_start, 0, 'skipped', 0, 'worker_base_url or internal_hmac_secret not configured');
    return 0;
  end if;

  select count(*) into v_today from loop_runs
   where loop_name = 'watch' and started_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  if v_today >= coalesce(v_cap, 50000) then
    insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, error)
    values ('select_due_watches', v_start, 0, 'skipped', 0, 'watch_daily_cap reached: ' || v_today);
    return 0;
  end if;

  for r in
    with due as (
      select id from watches
       where active and deleted_at is null
         and next_poll_at <= now()
         and (lease_until is null or lease_until < now())
       order by next_poll_at
       limit coalesce(v_batch, 100)
       for update skip locked)
    update watches w
       set lease_until = now() + interval '120 seconds',
           next_poll_at = now() + make_interval(secs => w.poll_interval_s)
      from due where w.id = due.id
    returning w.id
  loop
    v_sig := encode(hmac(convert_to(r.id::text || '|' || v_minute, 'utf8'), convert_to(v_secret, 'utf8'), 'sha256'), 'hex');
    perform net.http_post(
      url := v_url || '/internal/watch/' || r.id::text,
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'X-Internal-Signature', v_sig,
                                    'X-Internal-Minute', v_minute),
      body := jsonb_build_object('watch_id', r.id),
      timeout_milliseconds := 30000);
    n := n + 1;
  end loop;

  insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written)
  values ('select_due_watches', v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::integer,
          case when n > 0 then 'success' else 'no_op' end, n);
  return n;
exception when others then
  -- Everything this run did (leases, queued pg_net requests) is rolled back; the row below is what the tick alerts on.
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, error, meta)
  values ('select_due_watches', v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::integer,
          'failure', 0, left(v_msg, 500), jsonb_build_object('sqlstate', v_state));
  return 0;
end $$;
comment on function public.select_due_watches() is
  'Leases due watches and dispatches one signed pg_net POST per watch to the Worker. Refuses past watch_daily_cap (skipped). One loop_runs row per run: success / no_op / skipped, or failure with the error text and SQLSTATE when the run throws (its leases and queued requests roll back). Run by pg_cron every minute; the Worker''s every-minute tick alerts on skipped, failure and on no row for 3 minutes.';
revoke all on function public.select_due_watches() from public, anon, authenticated;
grant execute on function public.select_due_watches() to service_role;

-- 2. dispatch_failures(): pg_net answers that were not a delivered dispatch ------------------------------------------
create or replace function public.dispatch_failures(p_minutes integer)
returns integer language plpgsql stable security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_minutes is null or p_minutes < 1 or p_minutes > 1440 then
    raise exception 'dispatch_failures: p_minutes must be between 1 and 1440, got %', p_minutes;
  end if;
  -- "Could not look" is an error, never a zero: without pg_net there is nothing to count.
  if to_regclass('net._http_response') is null then
    raise exception 'dispatch_failures: net._http_response does not exist (pg_net missing)';
  end if;
  select count(*)::integer into v_count
    from net._http_response r
   where r.created >= now() - make_interval(mins => p_minutes)
     and (r.status_code >= 400 or r.error_msg is not null);
  return v_count;
end $$;
comment on function public.dispatch_failures(integer) is
  'Count of pg_net answers created in the last p_minutes (1..1440) with status_code >= 400 or an error_msg (transport error, timeout): watch dispatches that did not produce a recorded run (the Worker answers 200 for any run that recorded its outcome). pg_net keeps answers for a few hours (pg_net.ttl). Raises when pg_net is missing. Called by the Worker''s 10-minute job, which alerts above zero.';
revoke all on function public.dispatch_failures(integer) from public, anon, authenticated;
grant execute on function public.dispatch_failures(integer) to service_role;

commit;

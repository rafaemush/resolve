-- Migration 007 — extensions, app_config, scheduler (Resolve, 2026-09-22).
--
-- WHY: Workers Free allows 50 subrequests and 10 ms CPU per invocation, so a
-- cron tick cannot process 50 watches. The database is the scheduler: pg_cron
-- runs select_due_watches() every minute, which leases each due watch and has
-- pg_net POST /internal/watch/<id> to the Worker, one invocation per watch,
-- signed with HMAC(vault secret, watch_id|minute). The Worker URL, the daily
-- invocation cap and the secret are configuration rows, set by
-- scripts/configure-db.ts, never literals in a migration.

begin;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table if not exists app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
comment on table app_config is 'Non-secret runtime configuration read by database functions: worker_base_url, watch_daily_cap, watch_batch_max.';
insert into app_config (key, value) values ('watch_daily_cap', '50000'), ('watch_batch_max', '100')
on conflict (key) do nothing;
select apply_rls('app_config');

create or replace function public.select_due_watches()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_start   timestamptz := clock_timestamp();
  v_url     text;
  v_secret  text;
  v_cap     integer;
  v_batch   integer;
  v_today   integer;
  v_minute  text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI');
  v_sig     text;
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
  values ('select_due_watches', v_start, extract(milliseconds from clock_timestamp() - v_start)::integer,
          case when n > 0 then 'success' else 'no_op' end, n);
  return n;
end $$;
comment on function public.select_due_watches() is 'Leases due watches and dispatches one signed pg_net POST per watch to the Worker. Refuses past watch_daily_cap. Run by pg_cron every minute.';

create or replace function public.db_heartbeat()
returns void language sql security definer set search_path = public as $$
  insert into loop_runs (loop_name, outcome, rows_written, meta)
  values ('db_heartbeat', 'success', 1, jsonb_build_object('pg_version', version()));
$$;

-- idempotent schedule registration
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('select_due_watches', 'db_heartbeat', 'rate_limit_gc');
  perform cron.schedule('select_due_watches', '* * * * *', 'select public.select_due_watches()');
  perform cron.schedule('db_heartbeat', '0 */6 * * *', 'select public.db_heartbeat()');
  perform cron.schedule('rate_limit_gc', '17 4 * * *', 'select public.rate_limit_gc()');
end $$;

commit;

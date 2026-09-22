-- Migration 005 — rate-limit buckets, upstream state, request log, batched gate RPC (Resolve, 2026-09-22).
--
-- WHY: the paid path may make exactly one DB round trip before Jev, so the
-- rate-limit buckets, the Jev circuit breaker, the render-minute budget and the
-- daily Jev spend are all read in ONE function (check_gates). rate_limit_hit is
-- OilFlow migration 073 verbatim in spirit; the caller may fail OPEN on a DB
-- error here ONLY because begin_resolution (004) fails CLOSED behind it.
-- api_request_log is hash-not-body (OilFlow 118): shape + sha256 of the
-- response, never the bodies.

begin;

create table if not exists rate_limit_buckets (
  key        text primary key,
  count      integer not null default 0,
  reset_at   timestamptz not null,
  updated_at timestamptz not null default now()
);
comment on table rate_limit_buckets is 'Fixed-window counters keyed "<scope>:<subject>". Drained by rate_limit_gc().';
select apply_rls('rate_limit_buckets');

create or replace function public.rate_limit_hit(p_key text, p_window_ms integer, p_limit integer)
returns table (allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_now timestamptz := now(); v_new_reset timestamptz := now() + make_interval(secs => p_window_ms / 1000.0);
        v_count integer; v_reset timestamptz;
begin
  insert into rate_limit_buckets as b (key, count, reset_at, updated_at)
  values (p_key, 1, v_new_reset, v_now)
  on conflict (key) do update set
    count = case when b.reset_at <= v_now then 1 else b.count + 1 end,
    reset_at = case when b.reset_at <= v_now then v_new_reset else b.reset_at end,
    updated_at = v_now
  returning b.count, b.reset_at into v_count, v_reset;
  allowed := v_count <= p_limit; remaining := greatest(0, p_limit - v_count); reset_at := v_reset;
  return next;
end $$;

create or replace function public.rate_limit_gc()
returns integer language plpgsql security definer set search_path = public as $$
declare v_deleted integer;
begin
  delete from rate_limit_buckets where reset_at < now() - interval '24 hours';
  get diagnostics v_deleted = row_count; return v_deleted;
end $$;

create table if not exists upstream_state (
  name                 text primary key,
  consecutive_failures integer not null default 0,
  open_until           timestamptz,
  budget_used_today    numeric(14,4) not null default 0,
  day_bucket           date,
  updated_at           timestamptz not null default now()
);
comment on table upstream_state is 'Circuit breaker + daily budgets per upstream (jev, render_minutes). Atomic in Postgres because KV counters are neither atomic nor prompt.';
insert into upstream_state (name) values ('jev'), ('render_minutes') on conflict do nothing;
select apply_rls('upstream_state');

create or replace function public.upstream_record_failure(p_name text, p_threshold integer, p_open_seconds integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_failures integer; v_opened boolean := false;
begin
  insert into upstream_state (name) values (p_name) on conflict do nothing;
  update upstream_state set consecutive_failures = consecutive_failures + 1, updated_at = now()
   where name = p_name returning consecutive_failures into v_failures;
  if v_failures >= p_threshold then
    update upstream_state set open_until = now() + make_interval(secs => p_open_seconds), consecutive_failures = 0 where name = p_name;
    v_opened := true;
  end if;
  return v_opened;
end $$;

create or replace function public.upstream_record_success(p_name text)
returns void language sql security definer set search_path = public as $$
  update upstream_state set consecutive_failures = 0, updated_at = now() where name = p_name;
$$;

create or replace function public.upstream_consume_budget(p_name text, p_amount numeric, p_daily_cap numeric)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_used numeric;
begin
  insert into upstream_state (name) values (p_name) on conflict do nothing;
  update upstream_state
     set budget_used_today = case when day_bucket is distinct from (now() at time zone 'utc')::date then p_amount else budget_used_today + p_amount end,
         day_bucket = (now() at time zone 'utc')::date, updated_at = now()
   where name = p_name returning budget_used_today into v_used;
  return v_used <= p_daily_cap;
end $$;

-- One round trip for the hot path: all buckets + breaker + spend.
create or replace function public.check_gates(p_keys text[], p_window_ms integer[], p_limits integer[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_buckets jsonb := '[]'::jsonb; i integer; r record; v_jev record;
begin
  if array_length(p_keys, 1) is not null then
    for i in 1 .. array_length(p_keys, 1) loop
      select * into r from rate_limit_hit(p_keys[i], p_window_ms[i], p_limits[i]);
      v_buckets := v_buckets || jsonb_build_object('key', p_keys[i], 'allowed', r.allowed, 'remaining', r.remaining, 'reset_at', r.reset_at);
    end loop;
  end if;
  select * into v_jev from upstream_state where name = 'jev';
  return jsonb_build_object(
    'buckets', v_buckets,
    'jev_open_until', v_jev.open_until,
    'jev_breaker_open', (v_jev.open_until is not null and v_jev.open_until > now()),
    'jev_spend_today_usd', jev_spend_today(),
    'now', now());
end $$;
comment on function public.check_gates(text[], integer[], integer[]) is 'Batched gate read for the paid path: every rate-limit bucket hit, the Jev breaker state and today''s Jev spend in one call.';

create table if not exists api_request_log (
  id              uuid primary key default gen_random_uuid(),
  request_id      text not null,
  logged_at       timestamptz not null default now(),
  api_key_id      uuid references api_keys(id),
  tenant_id       uuid references tenants(id),
  auth_source     text not null check (auth_source in ('database','admin','internal','public')),
  route           text not null,
  method          text not null,
  status          integer not null,
  duration_ms     integer,
  redacted_params jsonb not null default '{}'::jsonb check (jsonb_typeof(redacted_params) = 'object'),
  response_sha256 text,
  client_colo     text,
  client_ip       inet,
  user_agent      text
);
comment on table api_request_log is 'Append-only evidence trail: route, status, timing, redacted shape and sha256 of the response body. No bodies, no raw params.';
create index if not exists idx_api_request_log_key_time on api_request_log (api_key_id, logged_at desc);
create index if not exists idx_api_request_log_route_time on api_request_log (route, logged_at desc);
drop trigger if exists api_request_log_append_only on api_request_log;
create trigger api_request_log_append_only before update or delete on api_request_log for each row execute function deny_mutation();
select apply_rls('api_request_log');

revoke all on function public.rate_limit_hit(text, integer, integer) from public;
revoke all on function public.rate_limit_gc() from public;
revoke all on function public.upstream_record_failure(text, integer, integer) from public;
revoke all on function public.upstream_record_success(text) from public;
revoke all on function public.upstream_consume_budget(text, numeric, numeric) from public;
revoke all on function public.check_gates(text[], integer[], integer[]) from public;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
grant execute on function public.rate_limit_gc() to service_role;
grant execute on function public.upstream_record_failure(text, integer, integer) to service_role;
grant execute on function public.upstream_record_success(text) to service_role;
grant execute on function public.upstream_consume_budget(text, numeric, numeric) to service_role;
grant execute on function public.check_gates(text[], integer[], integer[]) to service_role;

commit;

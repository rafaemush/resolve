-- 018_limitless_recorder: the Limitless resolution-latency recorder (plan §17.3 P0 row, §19.3).
-- WHY: nobody has measured how long Limitless takes to resolve a manual market (the "24-72 h" is a docs quote), and the
-- REST object carries no resolution timestamp: updatedAt precedes expirationTimestamp by 16-22 h on sampled markets
-- (plan §17.1), so it is not one. The only honest official time on Workers Free is the first poll that sees
-- winningOutcomeIndex set (source 'limitless_api_poll', ±10 min at the 10-minute cadence); the exact resolutionDate
-- exists only on the marketResolved websocket event, which needs a Durable Object on Workers Paid
-- (docs/runbooks/limitless-recorder.md). The same rows give the weekly creation cadence of manual markets, the rank-1
-- inventory number (v_limitless_cadence).
--   * limitless_markets: one row per slug (single market, group container, or group leg with group_slug set). The first
--     sighting of an outcome (resolved_seen_at, winning_outcome_index) is set once from null and never changes (guard
--     trigger + CHECK); last_pending_at is the last observation that still showed no outcome, so the platform resolved
--     the market inside (last_pending_at, resolved_seen_at], a bound measured per market instead of assumed.
--   * record_limitless_observations(): the Worker's only write path, one request per phase: an atomic merge that keeps
--     every first sighting (a later observation never moves it), returning the next markets to check.
--   * dispatch_internal(p_path): pg_net POST of a signed internal job, the select_due_watches scheme (migration 007)
--     with the job id in the MAC; pg_cron runs dispatch_internal('limitless_record') every 10 minutes.
--
-- Compatibility with the Worker deployed before this migration (8d67d16; it keeps running until the new one ships):
--   * everything here is new (a table, a view, three functions, a trigger, a cron job, two app_config keys the Worker
--     writes later); no existing table, function signature or view column changes. dispatch_failures() (013) only gets
--     a comment naming both dispatchers it counts.
--   * the cron job POSTs /internal/limitless/record every 10 minutes; the old Worker has no such route and answers 404,
--     which pg_net keeps in net._http_response (nothing reads it on the old Worker). The new Worker's 10-minute dispatch
--     check counts the last 10 minutes, so at most one pre-deploy 404 can raise one dispatch_http_failures alert; deploy
--     right after the migrations.
-- Idempotent. Nothing here is reachable by anon or authenticated (migration 010).
begin;

-- 1. limitless_markets ----------------------------------------------------------------------------------------------
create table if not exists limitless_markets (
  slug                  text primary key check (slug ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$'),
  group_slug            text check (group_slug is null or group_slug ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$'),
  condition_id          text,
  category              text,
  trade_type            text,
  automation_type       text,
  market_type           text,
  expiration_at         timestamptz,
  platform_created_at   timestamptz,
  first_seen_at         timestamptz not null default now(),
  last_checked_at       timestamptz,
  check_attempts        integer not null default 0 check (check_attempts >= 0),
  expired_seen_at       timestamptz,
  last_pending_at       timestamptz,
  resolved_seen_at      timestamptz,
  winning_outcome_index integer check (winning_outcome_index is null or winning_outcome_index >= 0),
  meta                  jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  constraint limitless_markets_index_needs_sighting check (winning_outcome_index is null or resolved_seen_at is not null)
);
comment on table limitless_markets is
  'Limitless manual markets seen by the recorder (src/jobs/limitless-recorder.ts): one row per slug, a single market, a group container (market_type group, group_slug null; no outcome of its own) or a group leg (group_slug set). Written only by record_limitless_observations; the first sighting of an outcome (resolved_seen_at, winning_outcome_index) is set once from null and never changed (trigger limitless_markets_set_once). Private: service_role reads, nobody else.';
comment on column limitless_markets.slug is 'The market''s Limitless slug (GET /markets/<slug>); a leg''s own slug for a group leg.';
comment on column limitless_markets.group_slug is 'The container''s slug for a group leg; null for single markets and for containers.';
comment on column limitless_markets.condition_id is 'Limitless conditionId (CTF condition) when the API gives one; containers have none.';
comment on column limitless_markets.category is 'First entry of the market''s Limitless categories (all of them in meta.categories).';
comment on column limitless_markets.trade_type is 'Limitless tradeType (clob | amm).';
comment on column limitless_markets.automation_type is 'Limitless automationType at the latest observation. Only rows the feed returned as manual are inserted (the feed''s automationType filter lets other rows through); a later value shows a market Limitless moved to automation.';
comment on column limitless_markets.market_type is 'Limitless marketType (single | group; a group leg also says group, with group_slug set).';
comment on column limitless_markets.expiration_at is 'Limitless expirationTimestamp: when trading stops (status LOCKED). Resolution latency is measured from here.';
comment on column limitless_markets.platform_created_at is 'Limitless createdAt, kept from the first observation: v_limitless_cadence separates markets created in their week of first sight from the first run''s backfill.';
comment on column limitless_markets.first_seen_at is 'When the recorder first saw the slug (database clock).';
comment on column limitless_markets.last_checked_at is 'Last GET /markets/<slug> by the check phase (success or error); null until the market is first checked after expiry. The check phase takes the oldest (nulls first).';
comment on column limitless_markets.check_attempts is 'GET /markets/<slug> checks so far, errors included (feed sightings are not counted).';
comment on column limitless_markets.expired_seen_at is 'First observation with expired = true; set once.';
comment on column limitless_markets.last_pending_at is 'Latest observation (feed or check) that still showed no outcome, taken as the Worker''s clock before the request, so it is never later than the platform''s read. Frozen once resolved_seen_at is set: Limitless resolved the market inside (last_pending_at, resolved_seen_at]. Null when the market was first seen already resolved (latency unknown).';
comment on column limitless_markets.resolved_seen_at is 'First observation of an outcome: winningOutcomeIndex set, or equal positive payoutNumerators with no index (void, meta.void). Database clock at the write, never earlier than the observation (an upper bound on the resolution time; source limitless_api_poll). Set once from null, never changed.';
comment on column limitless_markets.winning_outcome_index is 'winningOutcomeIndex at the first sighting (0 = YES, 1 = NO for a binary market); null for a void. Set only together with resolved_seen_at, never changed.';
comment on column limitless_markets.meta is 'Observation details merged key by key: platform id, group id, status, categories, payout_numerators, void, last_error / last_http_status of the latest check.';

create index if not exists idx_limitless_markets_due on limitless_markets (last_checked_at asc nulls first, expiration_at) where resolved_seen_at is null;
comment on index idx_limitless_markets_due is 'Check phase: unresolved markets, least recently checked first.';
create index if not exists idx_limitless_markets_group on limitless_markets (group_slug) where group_slug is not null;
comment on index idx_limitless_markets_group is 'Legs of a group container (groups_missing_legs in record_limitless_observations).';

create or replace function public.limitless_markets_set_once()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.resolved_seen_at is not null and new.resolved_seen_at is distinct from old.resolved_seen_at then
    raise exception 'limitless_markets: resolved_seen_at of % is set once and never changed', old.slug;
  end if;
  if old.winning_outcome_index is not null and new.winning_outcome_index is distinct from old.winning_outcome_index then
    raise exception 'limitless_markets: winning_outcome_index of % is set once and never changed', old.slug;
  end if;
  -- the outcome belongs to the first sighting: an index added after a void sighting would rewrite what was first seen
  if old.resolved_seen_at is not null and old.winning_outcome_index is null and new.winning_outcome_index is not null then
    raise exception 'limitless_markets: % was first seen resolved without an index; the index cannot be added later', old.slug;
  end if;
  return new;
end $$;
comment on function public.limitless_markets_set_once() is
  'BEFORE UPDATE guard on limitless_markets: resolved_seen_at and winning_outcome_index may each be set once from null (the index only in the update that sets resolved_seen_at) and never changed afterwards.';
drop trigger if exists limitless_markets_set_once on limitless_markets;
create trigger limitless_markets_set_once before update on limitless_markets
  for each row execute function public.limitless_markets_set_once();
revoke all on function public.limitless_markets_set_once() from public, anon, authenticated;
grant execute on function public.limitless_markets_set_once() to service_role;

select apply_rls('limitless_markets');
-- Writes go through record_limitless_observations only; the Worker (reconcile) and scripts read.
revoke all on limitless_markets from public, anon, authenticated, service_role;
grant select on limitless_markets to service_role;

-- 2. the write path -------------------------------------------------------------------------------------------------
create or replace function public.record_limitless_observations(p_rows jsonb, p_due_limit integer, p_give_up_days integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; v_due jsonb; v_missing jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'record_limitless_observations: p_rows must be a json array';
  end if;
  -- An observation time outside the run that made it is a bug, never a sighting to keep (a run lasts < 30 s).
  if exists (select 1 from jsonb_array_elements(p_rows) e(v)
              where coalesce((e.v->>'observed')::boolean, false)
                and ((e.v->>'observed_at') is null or (e.v->>'observed_at')::timestamptz not between now() - interval '10 minutes' and now() + interval '1 minute')) then
    raise exception 'record_limitless_observations: every observed row needs an observed_at within the last 10 minutes';
  end if;

  with src as (
    select distinct on (e.v->>'slug')
           e.v->>'slug' as slug, nullif(e.v->>'group_slug', '') as group_slug, nullif(e.v->>'condition_id', '') as condition_id,
           nullif(e.v->>'category', '') as category, nullif(e.v->>'trade_type', '') as trade_type,
           nullif(e.v->>'automation_type', '') as automation_type, nullif(e.v->>'market_type', '') as market_type,
           (e.v->>'expiration_at')::timestamptz as expiration_at, (e.v->>'platform_created_at')::timestamptz as platform_created_at,
           coalesce((e.v->>'observed')::boolean, false) as observed, coalesce((e.v->>'checked')::boolean, false) as checked,
           least((e.v->>'observed_at')::timestamptz, now()) as observed_at,
           coalesce((e.v->>'expired')::boolean, false) as expired, (e.v->>'winning_outcome_index')::integer as idx,
           coalesce((e.v->>'void')::boolean, false) as void, coalesce((e.v->>'container')::boolean, false) as container,
           coalesce(case when jsonb_typeof(e.v->'meta') = 'object' then e.v->'meta' end, '{}'::jsonb) as meta
      from jsonb_array_elements(p_rows) with ordinality as e(v, ord)
     order by e.v->>'slug', e.ord desc),                 -- a slug twice in one call: the last observation wins
  sighted as (
    select s.*, s.observed and not s.container and (s.idx is not null or s.void) as resolved from src s),
  -- the rows as they were before this call (every CTE reads the same snapshot), so "newly" never depends on the clock
  prior as (
    select l.slug, l.expired_seen_at, l.resolved_seen_at from limitless_markets l join sighted s on s.slug = l.slug),
  up as (
    insert into limitless_markets as t (slug, group_slug, condition_id, category, trade_type, automation_type, market_type,
                                        expiration_at, platform_created_at, last_checked_at, check_attempts, expired_seen_at,
                                        last_pending_at, resolved_seen_at, winning_outcome_index, meta)
    select s.slug, s.group_slug, s.condition_id, s.category, s.trade_type, s.automation_type, s.market_type,
           s.expiration_at, s.platform_created_at,
           case when s.checked then now() end,
           case when s.checked then 1 else 0 end,
           case when s.observed and s.expired then now() end,
           case when s.observed and not s.resolved and not s.container then s.observed_at end,
           case when s.resolved then now() end,
           case when s.resolved then s.idx end,
           s.meta
      from sighted s
    on conflict (slug) do update set
      group_slug          = coalesce(excluded.group_slug, t.group_slug),
      condition_id        = coalesce(excluded.condition_id, t.condition_id),
      category            = coalesce(excluded.category, t.category),
      trade_type          = coalesce(excluded.trade_type, t.trade_type),
      automation_type     = coalesce(excluded.automation_type, t.automation_type),
      market_type         = coalesce(excluded.market_type, t.market_type),
      expiration_at       = coalesce(excluded.expiration_at, t.expiration_at),
      platform_created_at = coalesce(t.platform_created_at, excluded.platform_created_at),
      last_checked_at     = coalesce(excluded.last_checked_at, t.last_checked_at),
      check_attempts      = t.check_attempts + excluded.check_attempts,
      expired_seen_at     = coalesce(t.expired_seen_at, excluded.expired_seen_at),
      -- frozen at the first sighting, so the bound (last_pending_at, resolved_seen_at] stays the one that was observed
      last_pending_at     = case when t.resolved_seen_at is null then coalesce(excluded.last_pending_at, t.last_pending_at) else t.last_pending_at end,
      resolved_seen_at    = coalesce(t.resolved_seen_at, excluded.resolved_seen_at),
      winning_outcome_index = case when t.resolved_seen_at is null then excluded.winning_outcome_index else t.winning_outcome_index end,
      meta                = t.meta || excluded.meta
    returning t.slug, (t.xmax = 0) as inserted, t.expired_seen_at, t.resolved_seen_at)
  select jsonb_build_object(
           'inserted', count(*) filter (where u.inserted), 'updated', count(*) filter (where not u.inserted),
           'newly_expired', count(*) filter (where u.expired_seen_at is not null and p.expired_seen_at is null),
           'newly_resolved', count(*) filter (where u.resolved_seen_at is not null and p.resolved_seen_at is null))
    into v from up u left join prior p on p.slug = u.slug;

  -- Containers in this call whose legs have never been recorded: the caller fetches them (feed rows carry legs inline).
  select coalesce(jsonb_agg(distinct e.v->>'slug'), '[]'::jsonb) into v_missing
    from jsonb_array_elements(p_rows) e(v)
   where coalesce((e.v->>'container')::boolean, false)
     and not exists (select 1 from limitless_markets l where l.group_slug = e.v->>'slug');

  -- Next markets to check: no outcome yet, not a container, expired (by the clock or by the API), not given up.
  select coalesce(jsonb_agg(d.slug order by d.rn), '[]'::jsonb) into v_due from (
    select m.slug, row_number() over (order by m.last_checked_at asc nulls first, m.expiration_at asc nulls last, m.slug) as rn
      from limitless_markets m
     where m.resolved_seen_at is null
       and not (m.market_type = 'group' and m.group_slug is null)
       and (m.expiration_at <= now() or m.expired_seen_at is not null)
       and coalesce(m.expiration_at, m.expired_seen_at) > now() - make_interval(days => least(greatest(coalesce(p_give_up_days, 21), 1), 90))
     order by m.last_checked_at asc nulls first, m.expiration_at asc nulls last, m.slug
     limit least(greatest(coalesce(p_due_limit, 0), 0), 100)) d;

  return v || jsonb_build_object('groups_missing_legs', v_missing, 'due', v_due);
end $$;
comment on function public.record_limitless_observations(jsonb, integer, integer) is
  'The recorder''s write path, one request per phase. p_rows: [{slug, group_slug, container, condition_id, category, trade_type, automation_type, market_type, expiration_at, platform_created_at, observed, observed_at, checked, expired, winning_outcome_index, void, meta}] (observed = false for a check that failed: only last_checked_at, check_attempts and meta move; a container never gets an outcome or last_pending_at). Atomic merge: metadata refreshed, first sightings (platform_created_at, expired_seen_at, resolved_seen_at + winning_outcome_index) kept, last_pending_at frozen at the first sighting of an outcome. Returns {inserted, updated, newly_expired, newly_resolved, groups_missing_legs, due}: due = up to p_due_limit (<= 100) unresolved non-container markets past expiry (or flagged expired) and inside p_give_up_days (1..90) of it, least recently checked first (never checked first). Raises on a non-array or an observed row whose observed_at is not within the last 10 minutes.';
revoke all on function public.record_limitless_observations(jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.record_limitless_observations(jsonb, integer, integer) to service_role;

-- 3. the weekly re-scan number ---------------------------------------------------------------------------------------
drop view if exists public.v_limitless_cadence;
create view public.v_limitless_cadence with (security_invoker = true) as
select to_char(date_trunc('week', m.first_seen_at at time zone 'utc'), 'IYYY-"W"IW') as iso_week,
       (date_trunc('week', m.first_seen_at at time zone 'utc'))::date as week_start,
       coalesce(m.category, 'unknown') as category,
       count(*) filter (where m.group_slug is null) as markets_first_seen,
       count(*) filter (where m.group_slug is null
                          and m.platform_created_at >= date_trunc('week', m.first_seen_at at time zone 'utc') at time zone 'utc') as markets_created_in_week,
       count(*) filter (where m.group_slug is null
                          and m.expiration_at > m.first_seen_at and m.expiration_at <= m.first_seen_at + interval '45 days') as markets_expiring_45d,
       count(*) filter (where m.group_slug is not null) as legs_first_seen
  from limitless_markets m
 group by 1, 2, 3;
comment on view public.v_limitless_cadence is
  'Weekly re-scan of Limitless manual markets (plan §17.3, the rank-1 inventory number), per ISO week (UTC, Monday start) of first sight and category. A market is a single market or a group container; legs are counted apart. markets_first_seen includes the first run''s backfill of markets that already existed; markets_created_in_week counts only those Limitless created in that same week (platform_created_at), the creation cadence; markets_expiring_45d = expiring within 45 days of first sight (a pilot can reconcile them soon). Read by scripts/limitless-cadence.ts. security_invoker: readable by service_role only.';
comment on column public.v_limitless_cadence.iso_week is 'ISO week of first sight, e.g. 2026-W39.';
comment on column public.v_limitless_cadence.week_start is 'Monday (UTC) of that week.';
comment on column public.v_limitless_cadence.category is 'limitless_markets.category (unknown when none).';
comment on column public.v_limitless_cadence.markets_first_seen is 'Single markets and group containers first seen that week.';
comment on column public.v_limitless_cadence.markets_created_in_week is 'Of those, created by Limitless in the same week (excludes backfill).';
comment on column public.v_limitless_cadence.markets_expiring_45d is 'Of those, expiring within 45 days of first sight.';
comment on column public.v_limitless_cadence.legs_first_seen is 'Group legs first seen that week.';
revoke all on public.v_limitless_cadence from public, anon, authenticated;
grant select on public.v_limitless_cadence to service_role;

-- 4. signed dispatch of internal jobs --------------------------------------------------------------------------------
create or replace function public.dispatch_internal(p_path text)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare
  v_start  timestamptz := clock_timestamp();
  v_route  text;
  v_url    text;
  v_secret text;
  v_minute text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI');
  v_sig    text;
  v_req    bigint;
  v_state  text;
  v_msg    text;
begin
  -- An allowlist, so a typo in a cron command is a failure row instead of a POST to a route that does not exist.
  v_route := case p_path when 'limitless_record' then '/internal/limitless/record' end;
  if v_route is null then
    raise exception 'dispatch_internal: unknown job id "%"', p_path;
  end if;
  select value into v_url from app_config where key = 'worker_base_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'internal_hmac_secret' limit 1;
  if v_url is null or v_secret is null then
    insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, error, meta)
    values ('dispatch_internal', v_start, 0, 'skipped', 0, 'worker_base_url or internal_hmac_secret not configured', jsonb_build_object('id', p_path));
    return null;
  end if;
  v_sig := encode(hmac(convert_to(p_path || '|' || v_minute, 'utf8'), convert_to(v_secret, 'utf8'), 'sha256'), 'hex');
  v_req := net.http_post(
    url := v_url || v_route,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Internal-Signature', v_sig, 'X-Internal-Minute', v_minute),
    body := jsonb_build_object('id', p_path),
    timeout_milliseconds := 30000);
  insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, meta)
  values ('dispatch_internal', v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::integer, 'success', 1,
          jsonb_build_object('id', p_path, 'request_id', v_req));
  return v_req;
exception when others then
  -- The queued request (if any) rolls back with the run; this row is what an operator reads.
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, error, meta)
  values ('dispatch_internal', v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::integer, 'failure', 0,
          left(v_msg, 500), jsonb_build_object('id', p_path, 'sqlstate', v_state));
  return null;
end $$;
comment on function public.dispatch_internal(text) is
  'pg_net POST of one internal Worker job, signed like select_due_watches (migration 007): X-Internal-Signature = hex HMAC-SHA256(vault internal_hmac_secret, "<p_path>|<YYYY-MM-DDTHH:MI UTC>"), X-Internal-Minute, 30 s timeout; the Worker accepts it within 3 minutes. p_path is the job id and must be on the allowlist (limitless_record -> POST /internal/limitless/record). One loop_runs row (loop_name dispatch_internal, meta.id): success with the pg_net request id, skipped when worker_base_url or the secret is missing, failure with the error text when it throws. Returns the pg_net request id, or null. Run by pg_cron.';
revoke all on function public.dispatch_internal(text) from public, anon, authenticated;
grant execute on function public.dispatch_internal(text) to service_role;

-- 5. dispatch_failures() (migration 013) counts every pg_net answer, so from here on dispatch_internal's too ----------
comment on function public.dispatch_failures(integer) is
  'Count of pg_net answers created in the last p_minutes (1..1440) with status_code >= 400 or an error_msg (transport error, timeout): dispatches that did not produce a recorded run, watch polls (select_due_watches) and internal jobs (dispatch_internal, migration 018) alike; a dispatch_internal loop_runs row keeps its pg_net request id in meta.request_id, which tells the two apart. The Worker answers 200 for any run that recorded its outcome. pg_net keeps answers for a few hours (pg_net.ttl). Raises when pg_net is missing. Called by the Worker''s 10-minute job, which alerts above zero.';

-- 6. schedule: every 10 minutes, where pg_cron exists (a local cluster without it still applies this file) ---------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'limitless_recorder';
    perform cron.schedule('limitless_recorder', '*/10 * * * *', 'select public.dispatch_internal(''limitless_record'')');
  else
    raise notice '018: pg_cron is not installed here; limitless_recorder is not scheduled';
  end if;
end $$;

commit;

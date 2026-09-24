-- 019_registration_dispatch: single-use watch dispatches and transactional market registration (plan §16.4 P1 steps 4
-- and 7, §19.3).
-- WHY:
--   * A pg_net dispatch (select_due_watches, migrations 007/013) is authorized only by HMAC(watch_id|minute) with a
--     +-3 minute window, so the same signed request could run a watch twice in that window: two evidence rows, two
--     resolutions, two commits, two tenant charges (audit schema:D17). claim_watch_dispatch() records each
--     (watch_id, minute) once, INSERT first, before the Worker does any work, and checks the watch still holds the
--     lease select_due_watches() took for that minute (not a later one), then holds it for the run.
--   * POST /v1/resolve with fetch:true ran a watch with no lease at all, so a tenant fetch could overlap a dispatched
--     run of the same watch. lease_watch_now() takes the same lease atomically, or reports that a run holds it.
--   * registerMarket inserted the market and then each watch in separate requests, and POST /v1/markets counted the
--     tenant's watches before inserting: a failure half-way left an open market polling fewer sources (or none), and
--     two concurrent registrations could both pass watch_limit. register_market() does both inserts in one transaction
--     under a lock on the tenant row, and holds the service-wide Base watch cap (app_config max_base_watches) under an
--     advisory lock: Base log reads go to public RPCs whose rate limits the plan's capacity arithmetic is built on.
--
-- Compatibility with the Worker deployed before this migration (8d67d16; it keeps running until the new one is
-- deployed): everything here is new (a table, four functions, one app_config row, one pg_cron job). No existing
-- table, column, constraint, view or function changes. The old Worker never calls claim_watch_dispatch(),
-- lease_watch_now() or register_market() and keeps inserting markets and watches directly, which service_role may
-- still do. Idempotent.
-- Nothing here is reachable by anon or authenticated (migration 010: default privileges alone are not enough, so every
-- function is revoked from public, anon and authenticated explicitly and granted to service_role only).
begin;

-- 1. single-use dispatch signatures ----------------------------------------------------------------------------------
create table if not exists used_dispatch_signatures (
  watch_id uuid not null,
  minute   text not null check (minute ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  used_at  timestamptz not null default now(),
  primary key (watch_id, minute)
);
comment on table used_dispatch_signatures is
  'One row per pg_net watch dispatch the Worker accepted: the (watch_id, minute) the HMAC signs. Written only by claim_watch_dispatch, INSERT first, so a replay or a duplicate of the same signed request finds its row and is refused (409 signature already used). A replay ledger, not a relation: watch_id has no foreign key, and rows older than 2 days are deleted daily by gc_dispatch_signatures (a signature is stale after 3 minutes anyway).';
comment on column used_dispatch_signatures.watch_id is 'The dispatched watch (watches.id), as signed.';
comment on column used_dispatch_signatures.minute is 'The dispatch minute as signed by select_due_watches(): YYYY-MM-DDTHH:MI in UTC (header X-Internal-Minute).';
comment on column used_dispatch_signatures.used_at is 'When the Worker claimed the signature; gc_dispatch_signatures deletes rows older than 2 days.';
create index if not exists idx_used_dispatch_signatures_used_at on used_dispatch_signatures (used_at);
comment on index idx_used_dispatch_signatures_used_at is 'Retention: gc_dispatch_signatures deletes by used_at.';
select apply_rls('used_dispatch_signatures');
-- Writes go through claim_watch_dispatch only; the Worker may read.
revoke all on used_dispatch_signatures from public, anon, authenticated, service_role;
grant select on used_dispatch_signatures to service_role;

create or replace function public.claim_watch_dispatch(p_watch uuid, p_minute text)
returns text language plpgsql security definer set search_path = public as $$
declare v_claimed uuid; v_lease timestamptz;
begin
  -- INSERT first: of two identical requests racing, the second waits on the first's row and then finds it.
  insert into used_dispatch_signatures (watch_id, minute) values (p_watch, p_minute)
  on conflict (watch_id, minute) do nothing
  returning watch_id into v_claimed;
  if v_claimed is null then return 'signature_used'; end if;
  -- The row lock orders this check against select_due_watches() (which skips locked rows) and lease_watch_now().
  select lease_until into v_lease from watches where id = p_watch for update;
  if not found then return 'watch_not_found'; end if;
  if v_lease is null then return 'lease_missing'; end if;
  if v_lease <= now() then return 'lease_expired'; end if;
  -- select_due_watches() signs minute M and sets lease_until = now() + 120 s inside M, so the lease M took ends before
  -- M + 180 s. A lease past that was taken later (a later dispatch or a tenant fetch, possible only once M's lease
  -- ended): this request is late, and that run is the current one.
  if v_lease >= (p_minute || ':00+00')::timestamptz + interval '180 seconds' then return 'lease_superseded'; end if;
  -- Hold the lease for the whole run: claimed near its end, the run would otherwise outlive it and overlap the next
  -- dispatch. runWatch releases it (lease_until null) when the run is recorded.
  update watches set lease_until = greatest(lease_until, now() + interval '120 seconds') where id = p_watch;
  return 'claimed';
end $$;
comment on function public.claim_watch_dispatch(uuid, text) is
  'Called by POST /internal/watch/:id after the HMAC check, before any work. Inserts (p_watch, p_minute) into used_dispatch_signatures first; returns signature_used when it was already there (a replay or duplicate: the Worker answers 409), watch_not_found, lease_missing (lease_until null: the watch was already polled and released, or never leased), lease_expired (lease_until at or before now: the request came after the 120 s lease select_due_watches() took), lease_superseded (lease_until at or after p_minute + 180 s: the lease was taken after the one minute p_minute leased, by a later dispatch or a tenant fetch, so this late request must not run beside it), or claimed (run the poll; the lease is extended to at least now + 120 s so it covers the run). The signature stays used whatever the answer. service_role only.';
revoke all on function public.claim_watch_dispatch(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_watch_dispatch(uuid, text) to service_role;

create or replace function public.lease_watch_now(p_watch uuid)
returns timestamptz language sql security definer set search_path = public as $$
  -- The lease condition of select_due_watches(): a live lease means a run of this watch is in progress.
  update watches set lease_until = now() + interval '120 seconds'
   where id = p_watch and (lease_until is null or lease_until < now())
  returning lease_until;
$$;
comment on function public.lease_watch_now(uuid) is
  'Called by POST /v1/resolve with fetch:true before it runs a watch outside the pg_net schedule. Takes the watch''s lease for 120 s, exactly as select_due_watches() does, and returns the new lease_until; returns null when the watch is leased (a dispatched run or another fetch holds it: the Worker answers 409) or does not exist. One UPDATE, so two callers can never both take it; runWatch releases it when the run is recorded. next_poll_at is untouched. service_role only.';
revoke all on function public.lease_watch_now(uuid) from public, anon, authenticated;
grant execute on function public.lease_watch_now(uuid) to service_role;

create or replace function public.gc_dispatch_signatures()
returns integer language sql security definer set search_path = public as $$
  with gone as (delete from used_dispatch_signatures where used_at < now() - interval '2 days' returning 1)
  select count(*)::integer from gone;
$$;
comment on function public.gc_dispatch_signatures() is
  'Deletes used_dispatch_signatures rows older than 2 days and returns how many. Safe: the Worker refuses a signature older than 3 minutes before it ever claims one. Run daily by pg_cron (job gc_dispatch_signatures).';
revoke all on function public.gc_dispatch_signatures() from public, anon, authenticated;
grant execute on function public.gc_dispatch_signatures() to service_role;

-- A database without pg_cron (a local check) keeps the function and schedules nothing.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'gc_dispatch_signatures';
    perform cron.schedule('gc_dispatch_signatures', '41 4 * * *', 'select public.gc_dispatch_signatures()');
  else
    raise notice '019: pg_cron is not installed; gc_dispatch_signatures is not scheduled';
  end if;
end $$;

-- 2. transactional registration ------------------------------------------------------------------------------------
insert into app_config (key, value) values ('max_base_watches', '20') on conflict (key) do nothing;

create or replace function public.register_market(p_tenant uuid, p_market jsonb, p_watches jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_limit     integer;
  v_active    integer;
  v_cap       integer;
  v_n         integer;
  v_n_base    integer;
  v_status    text := p_market ->> 'status';
  v_market    markets%rowtype;
  v_watch     record;
  v_watch_id  uuid;
  v_watches   jsonb := '[]'::jsonb;
begin
  if p_market is null or jsonb_typeof(p_market) <> 'object' then
    raise exception 'register_market: p_market must be a JSON object';
  end if;
  if p_watches is null or jsonb_typeof(p_watches) <> 'array' then
    raise exception 'register_market: p_watches must be a JSON array';
  end if;
  v_n := jsonb_array_length(p_watches);
  v_n_base := (select count(*) from jsonb_array_elements(p_watches) w where w ->> 'source_kind' = 'base_log');
  if v_status is null or v_status not in ('open', 'unsupported_source') then
    raise exception 'register_market: status must be open or unsupported_source, got %', coalesce(v_status, 'null');
  end if;
  if v_status = 'unsupported_source' and v_n > 0 then
    raise exception 'register_market: an unsupported_source market gets no watches';
  end if;

  -- Serialize this tenant's registrations (the watch count below cannot move until commit), then every registration
  -- that adds Base watches (the service-wide count).
  if p_tenant is not null then
    select watch_limit into v_limit from tenants where id = p_tenant and deleted_at is null for update;
    if not found then raise exception 'register_market: tenant % not found', p_tenant; end if;
  end if;
  if v_n_base > 0 then perform pg_advisory_xact_lock(hashtextextended('resolve.register_market.max_base_watches', 0)); end if;

  -- Idempotent: the same (tenant, platform, external_id) answers the market that exists, writing nothing.
  select * into v_market from markets
   where tenant_id is not distinct from p_tenant and platform = p_market ->> 'platform'
     and external_id = p_market ->> 'external_id' and deleted_at is null;
  if not found then
    if p_tenant is not null and v_n > 0 and v_limit is not null then
      select count(*) into v_active from watches w join markets m on m.id = w.market_id
       where m.tenant_id = p_tenant and w.active and w.deleted_at is null;
      if v_active + v_n > v_limit then
        return jsonb_build_object('outcome', 'watch_limit', 'watch_limit', v_limit, 'active_watches', v_active, 'requested', v_n);
      end if;
    end if;
    if v_n_base > 0 then
      v_cap := coalesce((select value::integer from app_config where key = 'max_base_watches'), 20);
      select count(*) into v_active from watches where source_kind = 'base_log' and active and deleted_at is null;
      if v_active + v_n_base > v_cap then
        return jsonb_build_object('outcome', 'base_watch_cap', 'base_watch_cap', v_cap, 'active_base_watches', v_active, 'requested', v_n_base);
      end if;
    end if;

    insert into markets (tenant_id, platform, external_id, condition, event_statement, option_a, option_b, positive_option, anchors, sources,
                         resolver, negative_rule, allow_prerelease, open_at, deadline_utc, grace_seconds, status, meta, condition_id, is_test)
    values (p_tenant, p_market ->> 'platform', p_market ->> 'external_id', p_market ->> 'condition', p_market ->> 'event_statement',
            p_market ->> 'option_a', p_market ->> 'option_b', p_market ->> 'positive_option',
            coalesce(p_market -> 'anchors', '[]'::jsonb), coalesce(p_market -> 'sources', '[]'::jsonb),
            case when jsonb_typeof(p_market -> 'resolver') = 'object' then p_market -> 'resolver' end,
            coalesce(p_market ->> 'negative_rule', 'absence_after_deadline'), coalesce((p_market ->> 'allow_prerelease')::boolean, false),
            (p_market ->> 'open_at')::timestamptz, (p_market ->> 'deadline_utc')::timestamptz, coalesce((p_market ->> 'grace_seconds')::integer, 3600),
            v_status, coalesce(p_market -> 'meta', '{}'::jsonb), p_market ->> 'condition_id', coalesce((p_market ->> 'is_test')::boolean, false))
    on conflict on constraint markets_unique_per_tenant do nothing
    returning * into v_market;

    if v_market.id is not null then
      for v_watch in select w.value from jsonb_array_elements(p_watches) with ordinality as w(value, ordinality) order by w.ordinality loop
        insert into watches (market_id, source_kind, source_ref, cursor, poll_interval_s, next_poll_at)
        values (v_market.id, v_watch.value ->> 'source_kind', v_watch.value -> 'source_ref', coalesce(v_watch.value -> 'cursor', '{}'::jsonb),
                (v_watch.value ->> 'poll_interval_s')::integer, now())
        returning id into v_watch_id;
        v_watches := v_watches || jsonb_build_array(jsonb_build_object('id', v_watch_id, 'source_kind', v_watch.value ->> 'source_kind'));
      end loop;
      return jsonb_build_object('outcome', 'created', 'market_id', v_market.id, 'status', v_market.status, 'is_test', v_market.is_test, 'watches', v_watches);
    end if;

    -- The key is taken: a shadow registration (no tenant lock) raced this one, and its row is answered below; or only
    -- a soft-deleted twin holds it, and the key stays taken, as the unique constraint always had it.
    select * into v_market from markets
     where tenant_id is not distinct from p_tenant and platform = p_market ->> 'platform'
       and external_id = p_market ->> 'external_id' and deleted_at is null;
    if not found then
      raise exception using errcode = '23505', message = format('register_market: %s:%s is taken by a deleted market (markets_unique_per_tenant)', p_market ->> 'platform', p_market ->> 'external_id');
    end if;
  end if;

  return jsonb_build_object('outcome', 'existing', 'market_id', v_market.id, 'status', v_market.status, 'is_test', v_market.is_test,
    'reasons', coalesce(v_market.meta -> 'registration_reasons', '[]'::jsonb),
    'watches', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'source_kind', w.source_kind) order by w.created_at, w.id)
                           from watches w where w.market_id = v_market.id and w.deleted_at is null), '[]'::jsonb));
end $$;
comment on function public.register_market(uuid, jsonb, jsonb) is
  'One transaction for a market registration (src/markets/register.ts). p_market carries the markets columns (status open or unsupported_source), p_watches the watches [{source_kind, source_ref, cursor, poll_interval_s}] (none for unsupported_source). Locks the tenant row (FOR UPDATE), then, when Base watches are added, an advisory lock. Answers jsonb outcome: existing (the same tenant, platform, external_id, not deleted: its id, status, is_test, reasons, watches; nothing written), watch_limit (the tenant''s active watches plus this market''s would exceed tenants.watch_limit; nothing written), base_watch_cap (active base_log watches service-wide plus this market''s would exceed app_config max_base_watches, default 20; nothing written), or created (market and every watch inserted, next_poll_at now; markets_smoke_is_test may set is_test). A soft-deleted twin keeps its key taken (23505). service_role only.';
revoke all on function public.register_market(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.register_market(uuid, jsonb, jsonb) to service_role;

commit;

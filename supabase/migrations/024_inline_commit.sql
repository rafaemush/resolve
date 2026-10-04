-- 024_inline_commit: the other legs of an official release are dispatched the moment its first print is recorded,
-- instead of at the next minute tick (plan "3. Be fast", approved by the founder 2026-10-05).
-- WHY:
--   * MEASURED 2026-10-02 (the BLS Employment Situation, 12:30:00 UTC): the first print was observed at +8 s, but the
--     commit rows were written at +61-62 s and posted at +104 s; all $541.88 of trader edge on those 16 legs was gone by
--     +17 s, and across 12 BLS ladders 70% of the post-release edge was still open at +10 s and 1.3% at +60 s. The 53 s
--     were a wait: the fetch-slot holder records the first print in waitUntil and every leg, its own included, resolves
--     from the stored row on its next poll, and select_due_watches() (pg_cron, migrations 007/013) dispatches once a
--     minute. The Worker now commits the holder's own leg in the invocation that recorded the first print (within 15 s
--     of release_at: src/ingest/official-watch.ts INLINE_COMMIT_WINDOW_S) and calls redispatch_official_legs() once, so
--     every other open leg of the event runs within seconds, each in its own Worker invocation with its own 50
--     subrequests, through the same signed pg_net POST and the same POST /internal/watch/:id as a scheduled poll.
--   * Why a dispatch and not next_poll_at = now(): select_due_watches() runs once a minute, so a due watch still waits for
--     the next tick, which is the wait being removed. redispatch_official_legs() dispatches at once: it leases each open
--     leg exactly as select_due_watches() does (FOR UPDATE SKIP LOCKED, only a watch whose lease is free or expired, so a
--     leg whose scheduled run is still in flight is never run beside it) and fires one pg_net POST per leg.
--   * The single-use dispatch rule (019) is kept, not bypassed. A dispatch is signed HMAC("<watch_id>|<stamp>") and
--     claim_watch_dispatch() records (watch_id, stamp) once, INSERT first. Every leg of the event was already dispatched
--     in the release minute, so a second dispatch signed with that minute would be refused as signature_used. A
--     redispatch therefore signs its stamp to the second ("YYYY-MM-DDTHH:MI:SS"): a stamp the scheduled dispatch never
--     uses, so it is its own single-use row. The Worker accepts it within the same +-3 minutes
--     (src/api/dispatch-auth.ts), and claim_watch_dispatch() checks the lease against the stamp's own time: the lease a
--     redispatch takes ends 30 s after its stamp, long before the stamp + 180 s that marks a lease as taken by a later
--     run. used_dispatch_signatures.minute accepts both forms; nothing else in 019 changes.
--   * The lease a redispatch takes is 30 s, not 120: claim_watch_dispatch() extends it to now + 120 s when the POST
--     arrives (pg_net gives up after 30 s), and a POST that never arrives frees the leg in 30 s, before the next minute
--     tick (the redispatch runs at most about 30 s after release_at), so a lost redispatch costs nothing against today.
--   * The caller's own watch (p_holder): the holder's poll keeps its lease until its next minute start while its
--     capture runs in waitUntil, so no other run of that leg can start beside the inline commit. With p_holder_too
--     false the holder is skipped (it commits inline); with true (the inline commit did not fit the invocation's
--     subrequest budget) the caller hands its lease over and the holder is dispatched like every other leg.
--   * One loop_runs row per call (loop_name redispatch_official): success with the legs dispatched and the legs still
--     busy (a run of theirs in flight: they resolve on their next poll), skipped (worker_base_url or the HMAC secret
--     missing, or watch_daily_cap reached), or failure with the error text. The answer is jsonb with the same facts, so
--     the Worker alerts on skipped and failure: a redispatch that could not run never looks like one that found nothing.
--
-- Compatibility with the Worker deployed before this migration (5be76d1; it keeps running until the new one ships):
--   * The old Worker never calls redispatch_official_legs(), so nothing dispatches a second-stamped POST to it.
--   * claim_watch_dispatch() answers exactly as before for every minute stamp (the only stamp the old Worker sends); the
--     check on used_dispatch_signatures.minute only widens (every existing row matches the new pattern).
--   * A Worker that calls redispatch_official_legs() before this migration is applied gets "function not found": it
--     alerts (apply 024) and the legs resolve on their next minute poll, as before.
-- Idempotent: create or replace, drop constraint if exists before add. Every object is commented; every function is
-- revoked from public, anon and authenticated and granted to service_role only (migration 010).
begin;

-- 1. single-use signatures: a stamp to the minute (select_due_watches) or to the second (redispatch_official_legs) ----
alter table used_dispatch_signatures drop constraint if exists used_dispatch_signatures_minute_check;
alter table used_dispatch_signatures add constraint used_dispatch_signatures_minute_check
  check (minute ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$');
comment on column used_dispatch_signatures.minute is
  'The dispatch stamp as signed (header X-Internal-Minute, UTC): YYYY-MM-DDTHH:MI from select_due_watches(), or YYYY-MM-DDTHH:MI:SS from redispatch_official_legs() (migration 024), so a redispatch in the minute the scheduled dispatch already used is its own single-use row.';
comment on constraint used_dispatch_signatures_minute_check on used_dispatch_signatures is
  'A stamp to the minute (select_due_watches) or to the second (redispatch_official_legs, migration 024); anything else is refused before it is recorded.';

create or replace function public.claim_watch_dispatch(p_watch uuid, p_minute text)
returns text language plpgsql security definer set search_path = public as $$
declare v_claimed uuid; v_lease timestamptz; v_signed timestamptz;
begin
  -- INSERT first: of two identical requests racing, the second waits on the first's row and then finds it. The check
  -- constraint refuses a malformed stamp here, before anything else.
  insert into used_dispatch_signatures (watch_id, minute) values (p_watch, p_minute)
  on conflict (watch_id, minute) do nothing
  returning watch_id into v_claimed;
  if v_claimed is null then return 'signature_used'; end if;
  -- The row lock orders this check against select_due_watches() and redispatch_official_legs() (which skip locked rows)
  -- and lease_watch_now().
  select lease_until into v_lease from watches where id = p_watch for update;
  if not found then return 'watch_not_found'; end if;
  if v_lease is null then return 'lease_missing'; end if;
  if v_lease <= now() then return 'lease_expired'; end if;
  -- The signed time: the minute's start, or the second a redispatch signed.
  v_signed := case when length(p_minute) = 19 then (p_minute || '+00')::timestamptz else (p_minute || ':00+00')::timestamptz end;
  -- select_due_watches() signs minute M and sets lease_until = now() + 120 s inside M, and redispatch_official_legs()
  -- signs second S and sets now() + 30 s, so the lease the signed dispatch took ends before the signed time + 180 s. A
  -- lease past that was taken later (a later dispatch or a tenant fetch, possible only once that lease ended): this
  -- request is late, and that run is the current one.
  if v_lease >= v_signed + interval '180 seconds' then return 'lease_superseded'; end if;
  -- Hold the lease for the whole run: claimed near its end, the run would otherwise outlive it and overlap the next
  -- dispatch. runWatch releases it (lease_until null) when the run is recorded.
  update watches set lease_until = greatest(lease_until, now() + interval '120 seconds') where id = p_watch;
  return 'claimed';
end $$;
comment on function public.claim_watch_dispatch(uuid, text) is
  'Called by POST /internal/watch/:id after the HMAC check, before any work. Inserts (p_watch, p_minute) into used_dispatch_signatures first; p_minute is the signed stamp, to the minute (select_due_watches) or to the second (redispatch_official_legs, migration 024). Returns signature_used when it was already there (a replay or duplicate: the Worker answers 409), watch_not_found, lease_missing (lease_until null: the watch was already polled and released, or never leased), lease_expired (lease_until at or before now: the request came after the lease its dispatch took), lease_superseded (lease_until at or after the signed time + 180 s: the lease was taken after the one the signed dispatch took, by a later dispatch or a tenant fetch, so this late request must not run beside it), or claimed (run the poll; the lease is extended to at least now + 120 s so it covers the run). The signature stays used whatever the answer. service_role only.';
revoke all on function public.claim_watch_dispatch(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_watch_dispatch(uuid, text) to service_role;

-- 2. redispatch_official_legs(): every other open leg of a release, dispatched now -----------------------------------
create or replace function public.redispatch_official_legs(p_series text[], p_period text, p_holder uuid, p_holder_too boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_start   timestamptz := clock_timestamp();
  v_url     text;
  v_secret  text;
  v_cap     integer;
  v_batch   integer;
  v_today   integer;
  v_stamp   text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS');
  v_sig     text;
  v_legs    integer;
  v_state   text;
  v_msg     text;
  v_meta    jsonb;
  r         record;
  n         integer := 0;
begin
  if p_series is null or cardinality(p_series) = 0 or cardinality(p_series) > 8 or p_period is null or p_period = '' or p_holder_too is null then
    raise exception 'redispatch_official_legs: p_series (1 to 8 series), p_period and p_holder_too are required, got % % %', p_series, p_period, p_holder_too;
  end if;
  v_meta := jsonb_build_object('series', to_jsonb(p_series), 'period', p_period, 'holder', p_holder, 'holder_too', p_holder_too, 'stamp', v_stamp);
  select value into v_url from app_config where key = 'worker_base_url';
  select value::integer into v_cap from app_config where key = 'watch_daily_cap';
  select value::integer into v_batch from app_config where key = 'watch_batch_max';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'internal_hmac_secret' limit 1;

  if v_url is null or v_secret is null then
    insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, error, meta)
    values ('redispatch_official', v_start, 0, 'skipped', 0, 'worker_base_url or internal_hmac_secret not configured', v_meta);
    return v_meta || jsonb_build_object('outcome', 'skipped', 'reason', 'worker_base_url or internal_hmac_secret not configured', 'dispatched', 0);
  end if;
  -- The same daily cap as select_due_watches(): a redispatched poll is a watch run like any other.
  select count(*) into v_today from loop_runs
   where loop_name = 'watch' and started_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  if v_today >= coalesce(v_cap, 50000) then
    insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, error, meta)
    values ('redispatch_official', v_start, 0, 'skipped', 0, 'watch_daily_cap reached: ' || v_today, v_meta);
    return v_meta || jsonb_build_object('outcome', 'skipped', 'reason', 'watch_daily_cap reached: ' || v_today, 'dispatched', 0);
  end if;

  -- Every open leg of these series and period (an official_release watch of an open market whose resolver names them).
  select count(*) into v_legs
    from watches w join markets m on m.id = w.market_id
   where w.active and w.deleted_at is null and w.source_kind = 'official_release'
     and m.status = 'open' and m.deleted_at is null and m.resolver->>'kind' = 'official_release'
     and m.resolver->>'series' = any(p_series) and m.resolver->>'period' = p_period
     and (p_holder is null or w.id <> p_holder or p_holder_too);

  for r in
    with legs as (
      select w.id from watches w join markets m on m.id = w.market_id
       where w.active and w.deleted_at is null and w.source_kind = 'official_release'
         and m.status = 'open' and m.deleted_at is null and m.resolver->>'kind' = 'official_release'
         and m.resolver->>'series' = any(p_series) and m.resolver->>'period' = p_period
         -- the holder is skipped (it commits inline) unless it hands its own lease over (p_holder_too)
         and (p_holder is null or w.id <> p_holder or p_holder_too)
         -- the lease condition of select_due_watches(): a live lease is a run in flight, never run beside it; the
         -- holder's own lease is the caller's to hand over
         and (w.lease_until is null or w.lease_until < now() or (p_holder_too and w.id = p_holder))
       order by w.next_poll_at, w.id
       limit coalesce(v_batch, 100)
       for update of w skip locked)
    update watches w
       set lease_until = now() + interval '30 seconds'
      from legs where w.id = legs.id
    returning w.id
  loop
    v_sig := encode(hmac(convert_to(r.id::text || '|' || v_stamp, 'utf8'), convert_to(v_secret, 'utf8'), 'sha256'), 'hex');
    perform net.http_post(
      url := v_url || '/internal/watch/' || r.id::text,
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'X-Internal-Signature', v_sig,
                                    'X-Internal-Minute', v_stamp),
      body := jsonb_build_object('watch_id', r.id, 'redispatch', true),
      timeout_milliseconds := 30000);
    n := n + 1;
  end loop;

  v_meta := v_meta || jsonb_build_object('legs', v_legs, 'dispatched', n, 'busy', greatest(v_legs - n, 0));
  insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, meta)
  values ('redispatch_official', v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::integer,
          case when n > 0 then 'success' else 'no_op' end, n, v_meta);
  return v_meta || jsonb_build_object('outcome', 'dispatched');
exception when others then
  -- Everything this call did (leases, queued pg_net requests) is rolled back; the row and the answer say why.
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, error, meta)
  values ('redispatch_official', v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::integer,
          'failure', 0, left(v_msg, 500), coalesce(v_meta, '{}'::jsonb) || jsonb_build_object('sqlstate', v_state));
  return coalesce(v_meta, '{}'::jsonb) || jsonb_build_object('outcome', 'failure', 'error', left(v_msg, 500), 'sqlstate', v_state, 'dispatched', 0);
end $$;
comment on function public.redispatch_official_legs(text[], text, uuid, boolean) is
  'Called by the Worker once the fetch-slot holder of an official release recorded its first print within 15 s of release_at (src/ingest/official-watch.ts): dispatches every open leg of p_series (1 to 8 series) and p_period now instead of at the next minute tick. Each leg (an active official_release watch of an open, undeleted market whose resolver names the series and period) whose lease is free or expired is leased for 30 s (FOR UPDATE SKIP LOCKED, as select_due_watches does; claim_watch_dispatch extends it to 120 s when the POST arrives) and gets one signed pg_net POST to /internal/watch/<id>, signed HMAC("<id>|YYYY-MM-DDTHH:MI:SS") with that stamp in X-Internal-Minute: a stamp to the second, so it is a single-use signature of its own beside the release minute''s scheduled dispatch. next_poll_at is untouched (the run sets it). p_holder is the caller''s own watch: skipped, or with p_holder_too dispatched as well, its live lease (the caller''s) notwithstanding. Refuses past watch_daily_cap like select_due_watches. One loop_runs row (loop_name redispatch_official): success / no_op with legs, dispatched and busy (legs whose run is in flight), skipped, or failure with the error text (its leases and queued requests roll back). Returns the same as jsonb: outcome dispatched, skipped or failure. service_role only.';
revoke all on function public.redispatch_official_legs(text[], text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.redispatch_official_legs(text[], text, uuid, boolean) to service_role;

commit;

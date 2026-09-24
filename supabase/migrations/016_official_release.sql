-- 016_official_release: the official_release rail (plan §17.3 official_release row, §18.1 scheduled burst, §19.3).
-- WHY: the Limitless/Polymarket macro and central-bank ladders (US CPI/PPI, BoK, Korea GDP, FOMC, ECB, BCB, BoE;
-- Oct 14 - Nov 5 2026) settle on one official number each, first print only ("data from the initial release ...
-- will be used"). Every binary leg of a ladder must decide from the SAME observation, and a later revision must
-- never change a decided leg. So the number is stored once per (series, period), first print wins, the row is
-- immutable (corroboration may be set once from null, or superseded only through the audited
-- recheck_official_corroboration, which appends a history row), and one fetch slot per (series, period) keeps dozens
-- of legs from each fetching the same upstream in the same minute (a Retry-After extends it for the whole ladder).
-- Safe against the live database while the previous Worker stays deployed: additive only (two tables, two RPCs,
-- one guard trigger) plus the watches/evidence source_kind CHECKs widened to admit 'official_release', which the
-- previous Worker never writes. Idempotent. Nothing here is reachable by anon or authenticated (migration 010).
begin;

-- 1. first prints ---------------------------------------------------------------------------------------------
create table if not exists official_observations (
  series        text not null check (series ~ '^[a-z0-9_]{2,64}$'),
  period        text not null check (period ~ '^\d{4}-(\d{2}(-\d{2})?|Q[1-4])$'),
  value         numeric not null,
  value_text    text not null check (length(value_text) between 1 and 100),
  deciding_text text not null check (length(deciding_text) between 1 and 4000),
  source_url    text not null check (source_url ~ '^https://'),
  raw_sha256    text not null check (raw_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at   timestamptz not null default now(),
  corroboration jsonb check (corroboration is null or jsonb_typeof(corroboration) = 'object'),
  meta          jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  primary key (series, period)
);
comment on table official_observations is
  'First print of each official number the official_release rail decides from, one row per (series, period), written only by record_official_observation (first print wins). Immutable: a guard trigger refuses any change to the observation and any DELETE; corroboration may be set once from null. Every leg of a ladder resolves from this row (src/resolve/official.ts); a later revision is alerted, never applied.';
comment on column official_observations.series is 'Series id from src/resolve/official.ts (e.g. us_cpi_u_nsa_yoy, fomc_upper_bound).';
comment on column official_observations.period is 'Target period: YYYY-MM (monthly print), YYYY-Qn (quarterly) or YYYY-MM-DD (decision day). The adapter records a document only when it is about this period.';
comment on column official_observations.value is 'The published number: a 12-month percent change (1 dp as printed) or the new policy rate level (the market decides its change against prior_level).';
comment on column official_observations.value_text is 'The number exactly as published ("3.4", "2.50", "3-3/4 to 4").';
comment on column official_observations.deciding_text is 'The exact sentence or title the value was read from, prefixed with the document''s own period line; gate 1 requires it to name the target period.';
comment on column official_observations.source_url is 'The allowlisted primary document the value was read from.';
comment on column official_observations.raw_sha256 is 'sha256 of the upstream response body (stored in R2 under raw/<sha256>).';
comment on column official_observations.observed_at is 'When the first print was recorded (database clock); gate 1 requires it to be at or after the market''s release_at.';
comment on column official_observations.corroboration is 'Second official source at record time: {status agree|disagree|unavailable|inconclusive|single_source, source_url, value, value_text, detail, checked_at}. Unavailable is not a disagreement. Set once from null, or superseded by recheck_official_corroboration (the previous value goes to official_corroboration_history first).';
comment on column official_observations.meta is 'Adapter details: direction the text states, the document''s own period, fetch time, upstream request count, effective dates.';

create or replace function public.official_observations_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'official_observations: first prints are never deleted (% %)', old.series, old.period;
  end if;
  if new.series is distinct from old.series or new.period is distinct from old.period
     or new.value is distinct from old.value or new.value_text is distinct from old.value_text
     or new.deciding_text is distinct from old.deciding_text or new.source_url is distinct from old.source_url
     or new.raw_sha256 is distinct from old.raw_sha256 or new.observed_at is distinct from old.observed_at
     or new.meta is distinct from old.meta then
    raise exception 'official_observations: the first print of % % is immutable', old.series, old.period;
  end if;
  -- a set corroboration changes only inside recheck_official_corroboration, which records the previous value first
  if old.corroboration is not null and new.corroboration is distinct from old.corroboration
     and coalesce(current_setting('resolve.official_recheck', true), '') <> 'on' then
    raise exception 'official_observations: corroboration of % % was already set; use recheck_official_corroboration', old.series, old.period;
  end if;
  return new;
end $$;
comment on function public.official_observations_guard() is
  'BEFORE UPDATE OR DELETE guard on official_observations: refuses every DELETE and every UPDATE that changes the observation (series, period, value, value_text, deciding_text, source_url, raw_sha256, observed_at, meta); corroboration may change from null, or inside recheck_official_corroboration (transaction-local setting resolve.official_recheck).';
drop trigger if exists official_observations_guard on official_observations;
create trigger official_observations_guard before update or delete on official_observations
  for each row execute function public.official_observations_guard();
drop trigger if exists official_observations_no_truncate on official_observations;
create trigger official_observations_no_truncate before truncate on official_observations
  for each statement execute function public.deny_mutation();
select apply_rls('official_observations');
-- Writes go through record_official_observation only; the Worker reads.
revoke all on official_observations from public, anon, authenticated, service_role;
grant select on official_observations to service_role;

create or replace function public.record_official_observation(
  p_series text, p_period text, p_value numeric, p_value_text text, p_deciding_text text,
  p_source_url text, p_raw_sha256 text, p_corroboration jsonb default null, p_meta jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_inserted boolean; v_row official_observations%rowtype;
begin
  insert into official_observations (series, period, value, value_text, deciding_text, source_url, raw_sha256, corroboration, meta)
  values (p_series, p_period, p_value, p_value_text, p_deciding_text, p_source_url, p_raw_sha256, p_corroboration, coalesce(p_meta, '{}'::jsonb))
  on conflict (series, period) do nothing;
  v_inserted := found;
  select * into v_row from official_observations where series = p_series and period = p_period;
  return to_jsonb(v_row) || jsonb_build_object(
    'inserted', v_inserted,
    'revision_differs', (not v_inserted) and v_row.value is distinct from p_value);
end $$;
comment on function public.record_official_observation(text, text, numeric, text, text, text, text, jsonb, jsonb) is
  'INSERT ... ON CONFLICT DO NOTHING, then returns the stored row as jsonb plus inserted and revision_differs. First print wins: a later call with a different value gets the stored first print back with revision_differs = true (the caller alerts official_revision_<series>_<period>); it never overwrites.';
revoke all on function public.record_official_observation(text, text, numeric, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_official_observation(text, text, numeric, text, text, text, text, jsonb, jsonb) to service_role;

-- 2. fetch slots ------------------------------------------------------------------------------------------------
create table if not exists official_fetch_slots (
  series      text not null check (series ~ '^[a-z0-9_]{2,64}$'),
  period      text not null check (period ~ '^\d{4}-(\d{2}(-\d{2})?|Q[1-4])$'),
  lease_until timestamptz not null,
  claims      integer not null default 1 check (claims >= 1),
  updated_at  timestamptz not null default now(),
  primary key (series, period)
);
comment on table official_fetch_slots is
  'One upstream fetcher per (series, period) at a time: every leg of a ladder first reads official_observations, and only the leg that wins claim_official_fetch requests the source. Written only by claim_official_fetch.';
comment on column official_fetch_slots.series is 'Series id (src/resolve/official.ts).';
comment on column official_fetch_slots.period is 'Target period, as in official_observations.';
comment on column official_fetch_slots.lease_until is 'The current holder may fetch until this time; a claim after it succeeds.';
comment on column official_fetch_slots.claims is 'Successful claims so far (diagnostics: fetch attempts for this release).';
comment on column official_fetch_slots.updated_at is 'Time of the last successful claim.';
select apply_rls('official_fetch_slots');
revoke all on official_fetch_slots from public, anon, authenticated, service_role;
grant select on official_fetch_slots to service_role;

create or replace function public.claim_official_fetch(p_series text, p_period text, p_seconds integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  insert into official_fetch_slots as s (series, period, lease_until)
  values (p_series, p_period, now() + make_interval(secs => least(greatest(coalesce(p_seconds, 45), 1), 300)))
  on conflict (series, period) do update
     set lease_until = excluded.lease_until, claims = s.claims + 1, updated_at = now()
   where s.lease_until < now()
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;
comment on function public.claim_official_fetch(text, text, integer) is
  'Atomically takes the fetch lease for (series, period) for p_seconds (clamped to 1..300) when no lease is live. true = this caller may fetch the upstream now; false = another leg holds it (read official_observations again on the next poll).';
revoke all on function public.claim_official_fetch(text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_official_fetch(text, text, integer) to service_role;
revoke all on function public.official_observations_guard() from public, anon, authenticated;
grant execute on function public.official_observations_guard() to service_role;

create or replace function public.extend_official_fetch(p_series text, p_period text, p_seconds integer)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_until timestamptz;
begin
  update official_fetch_slots
     set lease_until = greatest(lease_until, now() + make_interval(secs => least(greatest(coalesce(p_seconds, 45), 1), 3600))),
         updated_at = now()
   where series = p_series and period = p_period
  returning lease_until into v_until;
  return v_until;
end $$;
comment on function public.extend_official_fetch(text, text, integer) is
  'Pushes the fetch lease of (series, period) to at least now + p_seconds (clamped to 1..3600) when the source answered with Retry-After, so every leg of the ladder backs off, not only the one that fetched. Returns the new lease_until (null when no slot exists). Never shortens a lease.';
revoke all on function public.extend_official_fetch(text, text, integer) from public, anon, authenticated;
grant execute on function public.extend_official_fetch(text, text, integer) to service_role;

-- 3. audited corroboration re-check ---------------------------------------------------------------------------------
-- A disagreeing second source holds every leg at sources_disagree. The way out is an operator re-check (the second
-- source revised, or its row was misread): the previous corroboration is appended to this history, then superseded.
-- The first print itself (value, text, source, hashes) is never touched.
create table if not exists official_corroboration_history (
  id         bigint generated always as identity primary key,
  series     text not null,
  period     text not null,
  previous   jsonb check (previous is null or jsonb_typeof(previous) = 'object'),
  next       jsonb not null check (jsonb_typeof(next) = 'object' and next ? 'status'),
  actor      text not null check (length(actor) between 1 and 200),
  reason     text not null check (length(reason) between 8 and 2000),
  created_at timestamptz not null default now(),
  foreign key (series, period) references official_observations (series, period)
);
comment on table official_corroboration_history is
  'Append-only audit of every corroboration re-check on official_observations: who, why, the value before and the value after. Written only by recheck_official_corroboration; UPDATE, DELETE and TRUNCATE are refused.';
comment on column official_corroboration_history.id is 'Re-check id, also stamped into the superseding corroboration as recheck_id.';
comment on column official_corroboration_history.series is 'Series of the first print re-checked.';
comment on column official_corroboration_history.period is 'Period of the first print re-checked.';
comment on column official_corroboration_history.previous is 'The corroboration before the re-check (null when none was recorded).';
comment on column official_corroboration_history.next is 'The corroboration after the re-check (must carry a status).';
comment on column official_corroboration_history.actor is 'Who re-checked (for example admin_api or an operator name).';
comment on column official_corroboration_history.reason is 'Why: what was checked and against which source (at least 8 characters).';
comment on column official_corroboration_history.created_at is 'When the re-check was recorded.';
drop trigger if exists official_corroboration_history_append_only on official_corroboration_history;
create trigger official_corroboration_history_append_only before update or delete on official_corroboration_history
  for each row execute function public.deny_mutation();
drop trigger if exists official_corroboration_history_no_truncate on official_corroboration_history;
create trigger official_corroboration_history_no_truncate before truncate on official_corroboration_history
  for each statement execute function public.deny_mutation();
select apply_rls('official_corroboration_history');
revoke all on official_corroboration_history from public, anon, authenticated, service_role;
grant select on official_corroboration_history to service_role;

create or replace function public.recheck_official_corroboration(
  p_series text, p_period text, p_corroboration jsonb, p_actor text, p_reason text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_prev jsonb; v_id bigint; v_row official_observations%rowtype;
begin
  if p_corroboration is null or jsonb_typeof(p_corroboration) <> 'object'
     or coalesce(p_corroboration ->> 'status', '') <> all (array['agree', 'disagree', 'unavailable', 'inconclusive', 'single_source']) then
    raise exception 'recheck_official_corroboration: corroboration must be an object with a known status';
  end if;
  select corroboration into v_prev from official_observations where series = p_series and period = p_period for update;
  if not found then
    raise exception 'recheck_official_corroboration: no first print for % %', p_series, p_period;
  end if;
  insert into official_corroboration_history (series, period, previous, next, actor, reason)
  values (p_series, p_period, v_prev, p_corroboration, p_actor, p_reason)
  returning id into v_id;
  perform set_config('resolve.official_recheck', 'on', true);
  update official_observations
     set corroboration = p_corroboration || jsonb_build_object('recheck_id', v_id, 'rechecked_at', now())
   where series = p_series and period = p_period
  returning * into v_row;
  perform set_config('resolve.official_recheck', 'off', true);
  return to_jsonb(v_row) || jsonb_build_object('recheck_id', v_id, 'previous', v_prev);
end $$;
comment on function public.recheck_official_corroboration(text, text, jsonb, text, text) is
  'Audited way out of sources_disagree: appends {previous, next, actor, reason} to official_corroboration_history, then supersedes official_observations.corroboration (stamped with recheck_id and rechecked_at). The first print (value, text, source, hashes, observed_at) is never touched; the legs re-resolve because the change projection includes the corroboration status. Called by POST /internal/official/recheck (admin key).';
revoke all on function public.recheck_official_corroboration(text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.recheck_official_corroboration(text, text, jsonb, text, text) to service_role;

-- 4. watches and evidence admit the new source kind ---------------------------------------------------------------
-- Widened in place from the live definition (a parallel migration may have added kinds of its own), never
-- replaced by a hard-coded list; an unexpected definition stops the migration instead of guessing.
do $$
declare v_def text; t record;
begin
  for t in select * from (values ('watches', 'watches_source_kind_check'), ('evidence', 'evidence_source_kind_check')) as x(tbl, con) loop
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c where c.conrelid = format('public.%I', t.tbl)::regclass and c.conname = t.con;
    if v_def is null then
      raise exception '016: constraint %.% not found; refusing to guess the allowed source kinds', t.tbl, t.con;
    end if;
    if position('''official_release''' in v_def) = 0 then
      if position('ARRAY[' in v_def) = 0 then
        raise exception '016: unexpected definition of %.%: %', t.tbl, t.con, v_def;
      end if;
      execute format('alter table public.%I drop constraint %I', t.tbl, t.con);
      execute format('alter table public.%I add constraint %I %s', t.tbl, t.con, replace(v_def, 'ARRAY[', 'ARRAY[''official_release''::text, '));
    end if;
  end loop;
end $$;

commit;

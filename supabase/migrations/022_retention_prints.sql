-- 022_retention_prints: the charge for a first-print read, the retention purge, and the storage status (database size,
-- the purge's last run) the Worker alerts on (plan §22.3 item 6, §22.5, §21.4 B).
-- WHY:
--   * GET /v1/prints/{series}/{period} (src/api/prints.ts) serves the rail's stored first print for 1 credit (founder
--     decision 2026-10-01). begin_resolution() (migration 004) cannot charge it: it inserts a resolutions stub, and a read
--     is not a resolution. charge_read() writes exactly one credit_ledger 'charge' row per request id: it takes the
--     tenant row lock before it looks the id up, so a replay of the same id is free even while the first call is still
--     running (UNIQUE(reason, request_id), idx_ledger_reason_request, stays the second guard), a short balance is
--     refused with nothing written (the Worker answers 402), and the new balance comes back. The Worker derives the id
--     from the tenant, the print and the Idempotency-Key ("print:<series>:<period>:<sha256>"), or from the request id
--     without one; the "<kind>:" prefix it must carry keeps it apart from begin_resolution's bare-hex ids, so a read can
--     never replay the charge of a verdict.
--   * Supabase Free holds 500 MB and has no backups; loop_runs gains a row per watch poll, dispatch and job run, and
--     evidence keeps up to 16 KB of excerpt per fetch. purge_retention(),
--     daily by pg_cron, deletes loop_runs rows older than 30 days and clears (sets null) evidence.excerpt older than 30
--     days for markets that are no longer open (settled, closed or deleted). Hashes, R2 keys, URLs, times and every
--     other column stay. It never touches official_observations, bot_posts, credit_ledger, reconciliations or
--     resolutions (the record; most of them refuse deletion by trigger as well), and writes one loop_runs row per run
--     with the counts and the database size.
--   * The database cannot DM the operator (migration 013); the Worker can. storage_status() answers pg_database_size(),
--     the newest retention_purge run and whether its cron job is there; the Worker's 10-minute dispatch check
--     (src/jobs/dispatch.ts) reads it and alerts through alertMany() (src/ops/alerts.ts: an alerts row and a Telegram
--     DM) once the database passes 300 MB and again past 400 MB (DB_SIZE_ALERT_MB), and when the purge failed, has not
--     run for a day, or its cron job is missing: a purge that silently stopped is otherwise heard of only at 300 MB.
--
-- Compatibility with the Worker deployed before this migration (e7c2e99; it keeps running until the new one ships):
--   * Additive: three new functions and one pg_cron job; no table, column, constraint, view or existing function
--     changes. Comments on loop_runs, evidence.excerpt and credit_ledger are restated with the retention and the new
--     charge rows. The old Worker never calls charge_read() or storage_status().
--   * The purge deletes loop_runs rows the old Worker never reads (the tick reads the newest rows only; the daily watch
--     cap counts today's) and clears excerpts of markets that are no longer open, 30 days after they were fetched: a
--     tenant's POST /v1/resolve {market_id} on such a market then reads an empty excerpt (R2 keeps raw bodies 7 days),
--     as it already would for any raw body past its R2 retention.
-- Idempotent (create or replace, a cron job rescheduled by name). Nothing here is reachable by anon or authenticated
-- (migration 010 explains why revoking from public alone is not enough on Supabase).
begin;

-- 1. charge_read: one credit_ledger charge per request id -------------------------------------------------------------
create or replace function public.charge_read(p_tenant uuid, p_amount integer, p_request_id text)
returns table (ok boolean, replayed boolean, charged integer, balance integer)
language plpgsql security definer set search_path = public as $$
declare v_led credit_ledger%rowtype; v_balance integer; v_live boolean;
begin
  if p_tenant is null or p_amount is null or p_amount < 1 then
    raise exception using errcode = '22023', message = format('charge_read: tenant and a positive amount are required, got amount %s', p_amount);
  end if;
  if p_request_id is null or p_request_id !~ '^[a-z_]+:.+' or length(p_request_id) > 300 then
    raise exception using errcode = '22023', message = 'charge_read: request_id must be "<kind>:<id>" (at most 300 characters)';
  end if;
  -- The tenant row lock first. A concurrent call with the same id (a client retrying while the first request runs)
  -- waits here until that call commits, and the lookup below, a statement of its own and so a new snapshot, then sees
  -- its charge: a replay at any balance. Looked up before the lock, both calls would miss it and the second would
  -- re-check the balance the first one left (at the last credit: refused as short, a 402 for a print already paid).
  select t.credits_balance, t.deleted_at is null into v_balance, v_live from tenants t where t.id = p_tenant for update;
  -- A replay: this request id's charge already stands. Nothing is written and nothing is charged again.
  select * into v_led from credit_ledger l where l.reason = 'charge' and l.request_id = p_request_id;
  if found then
    if v_led.tenant_id is distinct from p_tenant then
      raise exception using errcode = 'RS003', message = 'charge_read: this request id was charged to another tenant';
    end if;
    return query select true, true, 0, v_balance;
    return;
  end if;
  -- A short balance, a deleted or an unknown tenant: nothing is written.
  if v_live is not true or v_balance < p_amount then
    return query select false, false, 0, case when v_live then v_balance else 0 end;
    return;
  end if;
  update tenants t set credits_balance = t.credits_balance - p_amount where t.id = p_tenant
  returning t.credits_balance into v_balance;
  -- No handler: the id cannot be taken by another call of this tenant (the lock), so a unique_violation here is
  -- another tenant's id and fails the whole call with nothing written (the Worker answers 503, nothing served).
  insert into credit_ledger (tenant_id, delta, reason, request_id, balance_after, note)
  values (p_tenant, -p_amount, 'charge', p_request_id, v_balance, 'read');
  return query select true, false, p_amount, v_balance;
end $$;
comment on function public.charge_read(uuid, integer, text) is
  'Charges p_amount credits for one read (GET /v1/prints/{series}/{period}: 1 credit per served first print) exactly once per p_request_id: under the tenant row lock, a debit of tenants.credits_balance and one credit_ledger row (reason charge, note read) in one transaction. A request id whose charge already stands is a replay: ok and replayed true, charged 0, nothing written, also for a concurrent call with the same id (it waits on the lock, then finds the charge) and at a zero balance (the same id charged to another tenant raises RS003). A short balance or a deleted tenant: ok false, charged 0, nothing written (the Worker answers 402). p_request_id must be "<kind>:<id>" (the Worker sends print:<series>:<period>:<sha256 of tenant|series|period|Idempotency-Key, or the request id>), never a bare-hex begin_resolution id; p_amount >= 1. Returns (ok, replayed, charged, balance) with the balance after the call. refund_credits(p_request_id) can give the charge back. service_role only.';
revoke all on function public.charge_read(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.charge_read(uuid, integer, text) to service_role;

comment on table credit_ledger is
  'Append-only. 1 credit = $0.01. UNIQUE(reason, request_id) makes charge/refund idempotent per request; UNIQUE(tx_hash, log_index) makes purchases idempotent per on-chain transfer. Charge rows come from begin_resolution (request_id = the resolution id) and charge_read (request_id "<kind>:<id>", note read: a served first print).';

-- 2. retention ----------------------------------------------------------------------------------------------------------
create or replace function public.purge_retention()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_start    timestamptz := clock_timestamp();
  v_cutoff   timestamptz := now() - interval '30 days';
  v_runs     integer := 0;
  v_excerpts integer := 0;
  v_bytes    bigint;
  v_state    text;
  v_msg      text;
begin
  delete from loop_runs r where r.started_at < v_cutoff;
  get diagnostics v_runs = row_count;
  -- Only the excerpt: raw_sha256, canonical_sha256, raw_r2_key, source_url, the times and the markers stay.
  update evidence e set excerpt = null
    from markets m
   where m.id = e.market_id and e.excerpt is not null and e.created_at < v_cutoff
     and (m.status <> 'open' or m.deleted_at is not null);
  get diagnostics v_excerpts = row_count;
  v_bytes := pg_database_size(current_database());
  insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, meta)
  values ('retention_purge', v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::integer,
          case when v_runs + v_excerpts > 0 then 'success' else 'no_op' end, v_runs + v_excerpts,
          jsonb_build_object('loop_runs_deleted', v_runs, 'evidence_excerpts_cleared', v_excerpts, 'retention_days', 30, 'database_bytes', v_bytes));
  return jsonb_build_object('loop_runs_deleted', v_runs, 'evidence_excerpts_cleared', v_excerpts, 'database_bytes', v_bytes);
exception when others then
  -- Everything this run did is rolled back; the row below is what storage_status() reports and the Worker alerts on.
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, error, meta)
  values ('retention_purge', v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::integer, 'failure', 0,
          left(v_msg, 500), jsonb_build_object('sqlstate', v_state));
  return jsonb_build_object('error', left(v_msg, 500), 'sqlstate', v_state);
end $$;
comment on function public.purge_retention() is
  'Retention, run daily by pg_cron (job purge_retention): deletes loop_runs rows whose started_at is more than 30 days old, and sets evidence.excerpt to null on rows created more than 30 days ago whose market is no longer open (status other than open, or soft-deleted); every other evidence column (hashes, R2 key, URL, times, markers) stays. Touches no other table: official_observations, bot_posts, credit_ledger, reconciliations and resolutions are the record and are never purged. One loop_runs row per run (loop_name retention_purge): success or no_op with loop_runs_deleted, evidence_excerpts_cleared and database_bytes in meta, or failure with the error text and SQLSTATE (the run rolls back). Returns the same counts as jsonb.';
revoke all on function public.purge_retention() from public, anon, authenticated;
grant execute on function public.purge_retention() to service_role;

comment on table loop_runs is
  'One row per watch invocation, cron tick, reconcile pass and heartbeat. rows_written=0 with exit 0 is recorded as no_op so silent no-ops are visible. Kept 30 days: purge_retention (migration 022) deletes older rows daily.';
comment on column evidence.excerpt is
  'Up to 16 KB of the fetched text (the raw bytes live in R2 under raw_r2_key for 7 days). Set to null by purge_retention (migration 022) 30 days after the row was created once its market is no longer open; the hashes and every other column stay.';

-- 3. storage status, for the Worker's alerts ------------------------------------------------------------------------------
create or replace function public.storage_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_at timestamptz; v_outcome text; v_error text; v_scheduled boolean;
begin
  select r.started_at, r.outcome, r.error into v_at, v_outcome, v_error
    from public.loop_runs r where r.loop_name = 'retention_purge' order by r.started_at desc limit 1;
  -- where pg_cron exists (Supabase): is the daily job there and active; null on a cluster without it
  if exists (select 1 from pg_catalog.pg_extension x where x.extname = 'pg_cron') then
    execute 'select exists (select 1 from cron.job j where j.jobname = ''purge_retention'' and j.active)' into v_scheduled;
  end if;
  return pg_catalog.jsonb_build_object(
    'database_bytes', pg_catalog.pg_database_size(pg_catalog.current_database()),
    'purge_scheduled', v_scheduled,
    'last_purge', case when v_at is null then null
                       else pg_catalog.jsonb_build_object('started_at', v_at, 'outcome', v_outcome, 'error', v_error) end);
end $$;
comment on function public.storage_status() is
  'What the Worker''s 10-minute dispatch check (src/jobs/dispatch.ts) alerts on, since the database cannot DM the operator: database_bytes (pg_database_size() of this database; alerts past 300 MB and again past 400 MB of the Supabase Free plan''s 500 MB, DB_SIZE_ALERT_MB, 1 MB = 1,048,576 bytes as pg_size_pretty prints), last_purge (started_at, outcome, error of the newest retention_purge loop_runs row, null before the first run; alerts when it failed or is more than a day old) and purge_scheduled (the purge_retention cron job exists and is active; null where pg_cron is not installed). Reads only. service_role only.';
revoke all on function public.storage_status() from public, anon, authenticated;
grant execute on function public.storage_status() to service_role;

-- 4. schedule: daily at 03:23 UTC, where pg_cron exists (a local cluster without it keeps the function) -------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'purge_retention';
    perform cron.schedule('purge_retention', '23 3 * * *', 'select public.purge_retention()');
  else
    raise notice '022: pg_cron is not installed; purge_retention is not scheduled';
  end if;
end $$;

commit;

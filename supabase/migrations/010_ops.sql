-- 010_ops: least privilege on every public routine and view, dust deposits that can
-- never freeze the deposit scan, and the operator alerts table.
-- MEASURED 2026-09-24 before this migration: anon/authenticated could EXECUTE every
-- public function (Supabase default privileges grant them directly, so the earlier
-- `revoke ... from public` did not remove them), including SECURITY DEFINER
-- grant_credits, credit_from_deposit, refund_credits and select_due_watches, and could
-- SELECT v_track_record. Nothing in Resolve uses anon or authenticated: the Worker
-- uses service_role and pg_cron runs as the owner.
begin;

-- 1. Least privilege ---------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
  for r in select c.oid::regclass as rel from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') loop
    execute format('revoke all on %s from anon, authenticated', r.rel);
  end loop;
end $$;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- 2. Dust deposits -----------------------------------------------------------
alter table usdc_deposits drop constraint if exists usdc_deposits_status_check;
alter table usdc_deposits add constraint usdc_deposits_status_check
  check (status in ('seen', 'credited', 'unmatched', 'dust'));

create or replace function public.credit_from_deposit(
  p_tx_hash text, p_log_index integer, p_from text, p_to text,
  p_amount_usdc numeric, p_block bigint, p_safe_block bigint, p_credits_per_usdc integer
) returns table (status text, tenant_id uuid, credits integer)
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_credits integer; v_balance integer; v_ledger bigint;
begin
  if p_block > p_safe_block then raise exception 'deposit block % is above safe block %', p_block, p_safe_block; end if;
  insert into usdc_deposits (tx_hash, log_index, from_address, to_address, amount_usdc, block_number, safe_block_seen)
  values (lower(p_tx_hash), p_log_index, lower(p_from), lower(p_to), p_amount_usdc, p_block, p_safe_block)
  on conflict (tx_hash, log_index) do nothing;
  if not found then return query select 'duplicate'::text, null::uuid, 0; return; end if;

  v_credits := floor(p_amount_usdc * p_credits_per_usdc)::integer;
  if v_credits < 1 then
    update usdc_deposits set status = 'dust' where tx_hash = lower(p_tx_hash) and log_index = p_log_index;
    return query select 'dust'::text, null::uuid, 0; return;
  end if;

  select id into v_tenant from tenants where wallet_address = lower(p_from) and deleted_at is null;
  if v_tenant is null then
    update usdc_deposits set status = 'unmatched' where tx_hash = lower(p_tx_hash) and log_index = p_log_index;
    return query select 'unmatched'::text, null::uuid, 0; return;
  end if;

  update tenants set credits_balance = credits_balance + v_credits where id = v_tenant returning credits_balance into v_balance;
  insert into credit_ledger (tenant_id, delta, reason, tx_hash, log_index, balance_after, note)
  values (v_tenant, v_credits, 'purchase', lower(p_tx_hash), p_log_index, v_balance, p_amount_usdc::text || ' USDC')
  returning id into v_ledger;
  update usdc_deposits set status = 'credited', tenant_id = v_tenant, ledger_id = v_ledger, credited_at = now()
   where tx_hash = lower(p_tx_hash) and log_index = p_log_index;
  return query select 'credited'::text, v_tenant, v_credits;
end $$;
comment on function public.credit_from_deposit(text, integer, text, text, numeric, bigint, bigint, integer) is
  'INSERT-first on (tx_hash, log_index). Refuses blocks above the safe tag. Returns credited | unmatched | duplicate | dust (worth < 1 credit: recorded, never credited, never blocks the scan).';
revoke all on function public.credit_from_deposit(text, integer, text, text, numeric, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.credit_from_deposit(text, integer, text, text, numeric, bigint, bigint, integer) to service_role;

-- 3. Operator alerts ---------------------------------------------------------
create table if not exists alerts (
  id         bigint generated always as identity primary key,
  key        text not null check (length(key) between 1 and 200),
  text       text not null,
  meta       jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  created_at timestamptz not null default now()
);
comment on table alerts is 'Every operator alert (also sent as a Telegram DM). key groups repeats; dedup is per key over a window chosen by the caller. Text is redacted before insert.';
create index if not exists idx_alerts_key_time on alerts (key, created_at desc);
select apply_rls('alerts');

commit;

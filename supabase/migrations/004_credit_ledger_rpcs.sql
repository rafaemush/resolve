-- Migration 004 — credit ledger, USDC deposits, billing RPCs (Resolve, 2026-09-22).
--
-- WHY: every money touch is a ledger row and the balance is only ever moved by
-- these SECURITY DEFINER functions. begin_resolution() is the single entry for
-- a billable request: INSERT-first stub (idempotent by tenant+key), THEN the
-- conditional UPDATE...RETURNING charge (OilFlow migration 174 shape). Ten
-- concurrent identical requests therefore produce exactly one charge row. The
-- Worker treats ANY error from this function as fail-closed (503, no Jev call).
-- Deposits are credited only for logs at or below Base's `safe` block tag; the
-- (tx_hash, log_index) primary key makes crediting idempotent.

begin;

create table if not exists credit_ledger (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references tenants(id),
  delta         integer not null check (delta <> 0),
  reason        text not null check (reason in ('purchase','charge','refund','grant','adjustment')),
  request_id    text,
  tx_hash       text,
  log_index     integer,
  balance_after integer not null check (balance_after >= 0),
  note          text,
  created_at    timestamptz not null default now()
);
comment on table credit_ledger is 'Append-only. 1 credit = $0.01. UNIQUE(reason, request_id) makes charge/refund idempotent per request; UNIQUE(tx_hash, log_index) makes purchases idempotent per on-chain transfer.';
create unique index if not exists idx_ledger_reason_request on credit_ledger (reason, request_id) where request_id is not null;
create unique index if not exists idx_ledger_tx on credit_ledger (tx_hash, log_index) where tx_hash is not null;
create index if not exists idx_ledger_tenant_time on credit_ledger (tenant_id, created_at desc);
drop trigger if exists credit_ledger_append_only on credit_ledger;
create trigger credit_ledger_append_only before update or delete on credit_ledger for each row execute function deny_mutation();
select apply_rls('credit_ledger');

create table if not exists usdc_deposits (
  tx_hash         text not null,
  log_index       integer not null,
  from_address    text not null,
  to_address      text not null,
  amount_usdc     numeric(18,6) not null check (amount_usdc > 0),
  block_number    bigint not null,
  safe_block_seen bigint not null,
  tenant_id       uuid references tenants(id),
  status          text not null default 'seen' check (status in ('seen','credited','unmatched')),
  ledger_id       bigint references credit_ledger(id),
  created_at      timestamptz not null default now(),
  credited_at     timestamptz,
  primary key (tx_hash, log_index)
);
comment on table usdc_deposits is 'USDC Transfer logs to the receiving address, seen at or below the safe tag. unmatched = sender wallet not registered on any tenant; the founder maps it with grant_credits().';
create index if not exists idx_usdc_deposits_unmatched on usdc_deposits (created_at desc) where status = 'unmatched';
select apply_rls('usdc_deposits');

-- begin_resolution ------------------------------------------------------------
create or replace function public.begin_resolution(
  p_tenant uuid,
  p_api_key uuid,
  p_idempotency_key text,
  p_amount integer,
  p_market uuid,
  p_mode text default 'tenant'
) returns table (request_id text, replayed boolean, ok boolean, balance integer, charged integer)
language plpgsql security definer set search_path = public as $$
declare
  v_id      text;
  v_balance integer;
  v_row     resolutions%rowtype;
begin
  if p_amount < 0 then raise exception 'p_amount must be >= 0'; end if;

  if p_idempotency_key is not null and p_tenant is not null then
    v_id := encode(digest(p_tenant::text || '|' || p_idempotency_key, 'sha256'), 'hex');
  else
    v_id := replace(gen_random_uuid()::text, '-', '');
  end if;

  begin
    insert into resolutions (id, tenant_id, api_key_id, market_id, idempotency_key, mode, status_row)
    values (v_id, p_tenant, p_api_key, p_market, p_idempotency_key, p_mode, 'pending');
  exception when unique_violation then
    select * into v_row from resolutions
     where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
    if not found then
      select * into v_row from resolutions where id = v_id;
    end if;
    return query select v_row.id, true, true,
      (select credits_balance from tenants where id = p_tenant), v_row.credits_charged;
    return;
  end;

  if p_tenant is null or p_amount = 0 then
    return query select v_id, false, true,
      coalesce((select credits_balance from tenants where id = p_tenant), 0), 0;
    return;
  end if;

  update tenants
     set credits_balance = credits_balance - p_amount
   where id = p_tenant and deleted_at is null and credits_balance >= p_amount
  returning credits_balance into v_balance;

  if v_balance is null then
    -- The stub never carried a verdict or a charge; removing it is not a record deletion.
    delete from resolutions where id = v_id and status_row = 'pending';
    return query select v_id, false, false,
      coalesce((select credits_balance from tenants where id = p_tenant), 0), 0;
    return;
  end if;

  insert into credit_ledger (tenant_id, delta, reason, request_id, balance_after)
  values (p_tenant, -p_amount, 'charge', v_id, v_balance);
  update resolutions set credits_charged = p_amount where id = v_id;

  return query select v_id, false, true, v_balance, p_amount;
end $$;
comment on function public.begin_resolution(uuid, uuid, text, integer, uuid, text) is 'INSERT-first idempotent claim then conditional charge. replayed=true returns the existing row with no new charge. ok=false means insufficient credits (HTTP 402). Any raised error => the Worker fails closed (503, no Jev call).';

-- refund_credits ------------------------------------------------------------
create or replace function public.refund_credits(p_request_id text)
returns integer language plpgsql security definer set search_path = public as $$
declare v_charge credit_ledger%rowtype; v_balance integer;
begin
  select * into v_charge from credit_ledger where reason = 'charge' and request_id = p_request_id;
  if not found then return 0; end if;
  if exists (select 1 from credit_ledger where reason = 'refund' and request_id = p_request_id) then return 0; end if;
  begin
    update tenants set credits_balance = credits_balance + (-v_charge.delta)
     where id = v_charge.tenant_id returning credits_balance into v_balance;
    insert into credit_ledger (tenant_id, delta, reason, request_id, balance_after)
    values (v_charge.tenant_id, -v_charge.delta, 'refund', p_request_id, v_balance);
    update resolutions set credits_refunded = -v_charge.delta where id = p_request_id;
  exception when unique_violation then
    return 0;
  end;
  return -v_charge.delta;
end $$;
comment on function public.refund_credits(text) is 'Refunds the charge for a request exactly once (UNIQUE(reason, request_id) is the second guard). Returns credits refunded, 0 if nothing to refund.';

-- grant_credits -------------------------------------------------------------
create or replace function public.grant_credits(p_tenant uuid, p_amount integer, p_note text, p_request_id text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare v_balance integer;
begin
  if p_amount = 0 then return (select credits_balance from tenants where id = p_tenant); end if;
  update tenants set credits_balance = credits_balance + p_amount
   where id = p_tenant and deleted_at is null returning credits_balance into v_balance;
  if v_balance is null then raise exception 'tenant % not found or insufficient balance for negative grant', p_tenant; end if;
  insert into credit_ledger (tenant_id, delta, reason, request_id, balance_after, note)
  values (p_tenant, p_amount, case when p_amount > 0 then 'grant' else 'adjustment' end, p_request_id, v_balance, p_note);
  return v_balance;
end $$;

-- credit_from_deposit -------------------------------------------------------
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

  select id into v_tenant from tenants where wallet_address = lower(p_from) and deleted_at is null;
  if v_tenant is null then
    update usdc_deposits set status = 'unmatched' where tx_hash = lower(p_tx_hash) and log_index = p_log_index;
    return query select 'unmatched'::text, null::uuid, 0; return;
  end if;

  v_credits := floor(p_amount_usdc * p_credits_per_usdc)::integer;
  update tenants set credits_balance = credits_balance + v_credits where id = v_tenant returning credits_balance into v_balance;
  insert into credit_ledger (tenant_id, delta, reason, tx_hash, log_index, balance_after, note)
  values (v_tenant, v_credits, 'purchase', lower(p_tx_hash), p_log_index, v_balance, p_amount_usdc::text || ' USDC')
  returning id into v_ledger;
  update usdc_deposits set status = 'credited', tenant_id = v_tenant, ledger_id = v_ledger, credited_at = now()
   where tx_hash = lower(p_tx_hash) and log_index = p_log_index;
  return query select 'credited'::text, v_tenant, v_credits;
end $$;
comment on function public.credit_from_deposit(text, integer, text, text, numeric, bigint, bigint, integer) is 'INSERT-first on (tx_hash, log_index). Refuses blocks above the safe tag. Returns credited | unmatched | duplicate.';

revoke all on function public.begin_resolution(uuid, uuid, text, integer, uuid, text) from public;
revoke all on function public.refund_credits(text) from public;
revoke all on function public.grant_credits(uuid, integer, text, text) from public;
revoke all on function public.credit_from_deposit(text, integer, text, text, numeric, bigint, bigint, integer) from public;
grant execute on function public.begin_resolution(uuid, uuid, text, integer, uuid, text) to service_role;
grant execute on function public.refund_credits(text) to service_role;
grant execute on function public.grant_credits(uuid, integer, text, text) to service_role;
grant execute on function public.credit_from_deposit(text, integer, text, text, numeric, bigint, bigint, integer) to service_role;

commit;

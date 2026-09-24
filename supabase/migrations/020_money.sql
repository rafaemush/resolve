-- 020_money: deposits that land on the right tenant, PAYG tiers as data, signed wallet registration, and the
-- low-credit notice (plan §16.4 P3 step 3, §17.3 P3a, §19.3).
-- WHY: a buyer who sends USDC before registering a wallet is 'unmatched' today and the only way to credit them was an
-- untraceable grant_credits(): match_deposit() credits exactly that transfer at the tier rate, once, with who and why on
-- the deposit row, the purchase ledger row keyed by (tx_hash, log_index), and the same answer on every retry. The pack
-- bonuses of plan §11 ($50 -> 5,000, $250 -> 27,500, $1,000 -> 120,000 credits) are data (app_config payg_tiers) read by
-- one function that both credit paths use, so a price change is a row, not a deploy. A tenant proves control of its
-- sender wallet by signing a single-use challenge (wallet_challenges, register_wallet()); the Worker verifies the
-- EIP-191 signature, the database makes the registration atomic and refuses an address another tenant holds.
-- credits.low goes out once per crossing: claim_low_credit_notice() sets tenants.low_credit_notified_at at the crossing
-- and every purchase or grant clears it (a trigger on credit_ledger, so every credit path clears it, old ones included).
--
-- Compatibility with the Worker deployed before this migration (8d67d16; it keeps running until the new one ships):
--   * credit_from_deposit keeps its signature (8 arguments, including the rate the old Worker passes) and its return
--     shape (status, tenant_id, credits); only the rate inside changes: the tier rate when payg_tiers exists, else the
--     rate passed. The dust rule is unchanged (worth < 1 credit -> 'dust', never credited).
--   * Everything else is additive: new columns (nullable, no default rewrite), two app_config rows, one table, six new
--     functions, one trigger on credit_ledger that only clears a column the old Worker never reads. No CHECK is
--     narrowed, no column or view is dropped or renamed, no existing signature changes.
-- Idempotent (if not exists / create or replace / drop ... if exists). Nothing here is reachable by anon or
-- authenticated (migration 010 explains why revoking from public alone is not enough on Supabase).
begin;

-- 1. columns ------------------------------------------------------------------------------------------------------------
alter table tenants add column if not exists low_credit_notified_at timestamptz;
comment on column tenants.low_credit_notified_at is
  'Set by claim_low_credit_notice() when a charge left credits_balance below app_config low_credit_threshold and the credits.low event was queued; cleared by the credit_ledger_low_credit_reset trigger on any purchase or grant. Null = the next charge below the threshold notifies. Refunds do not clear it, so a charge/refund pair around the threshold notifies once.';

alter table usdc_deposits add column if not exists credits_per_usdc integer;
alter table usdc_deposits add column if not exists matched_by text;
alter table usdc_deposits add column if not exists match_reason text;
alter table usdc_deposits add column if not exists matched_at timestamptz;
alter table usdc_deposits drop constraint if exists usdc_deposits_rate_check;
alter table usdc_deposits add constraint usdc_deposits_rate_check check (credits_per_usdc is null or credits_per_usdc >= 1);
-- A manual match is audited as a whole or not at all: who, why and when together, on a credited row only.
alter table usdc_deposits drop constraint if exists usdc_deposits_match_audit_check;
alter table usdc_deposits add constraint usdc_deposits_match_audit_check check (
  (matched_by is null and match_reason is null and matched_at is null)
  or (matched_by is not null and length(btrim(matched_by)) > 0 and match_reason is not null and length(btrim(match_reason)) > 0
      and matched_at is not null and status = 'credited'));
comment on table usdc_deposits is
  'USDC Transfer logs to the receiving address, seen at or below the safe tag. unmatched = the sender wallet is not registered on any tenant; the operator credits it to the right tenant with match_deposit() (POST /internal/deposits/match), which records who and why. dust = worth less than one credit, never credited.';
comment on column usdc_deposits.credits_per_usdc is 'The rate the credit was made at (payg_credits_per_usdc() for the deposit''s amount). Null until credited; null on rows credited before migration 020.';
comment on column usdc_deposits.matched_by is 'Who credited an unmatched deposit by hand (match_deposit p_actor, e.g. admin_api:founder). Null for deposits credited automatically from a registered wallet.';
comment on column usdc_deposits.match_reason is 'Why the operator matched this deposit to this tenant (match_deposit p_reason): the evidence that the sender is that tenant.';
comment on column usdc_deposits.matched_at is 'When match_deposit() credited the deposit. Null for automatic credits.';

-- 2. configuration as data --------------------------------------------------------------------------------------------
insert into app_config (key, value) values
  ('payg_tiers', '[{"min_usdc":1000,"credits_per_usdc":120},{"min_usdc":250,"credits_per_usdc":110},{"min_usdc":0,"credits_per_usdc":100}]'),
  ('low_credit_threshold', '500')
on conflict (key) do nothing;
comment on table app_config is
  'Non-secret runtime configuration read by database functions and the Worker: worker_base_url, watch_daily_cap, watch_batch_max, usdc_cursor_block (deposit scan cursor), payg_tiers (JSON array of {min_usdc, credits_per_usdc} objects with no other key: the rate of a deposit is the one of the highest min_usdc at or below its amount; read by payg_credits_per_usdc()), low_credit_threshold (integer credits; credits.low fires when a charge leaves the balance below it; 500 when absent).';

-- 3. PAYG tiers -------------------------------------------------------------------------------------------------------
create or replace function public.payg_credits_per_usdc(p_amount_usdc numeric, p_fallback integer default null)
returns integer language plpgsql stable security definer set search_path = public as $$
declare
  v_raw   text;
  v_tiers jsonb;
  t       jsonb;
  v_min   numeric;
  v_rate  numeric;
  v_prev_min  numeric := null;
  v_prev_rate numeric := null;
  v_best_min  numeric := null;
  v_best_rate integer := null;
  v_has_zero  boolean := false;
begin
  if p_amount_usdc is null or p_amount_usdc < 0 then
    raise exception using errcode = '22023', message = format('payg_credits_per_usdc: amount must be >= 0, got %s', p_amount_usdc);
  end if;
  select c.value into v_raw from app_config c where c.key = 'payg_tiers';
  if v_raw is null then
    if p_fallback is null or p_fallback < 1 then
      raise exception using errcode = 'RS004', message = 'payg_credits_per_usdc: app_config payg_tiers is absent and no fallback rate was given';
    end if;
    return p_fallback;
  end if;
  begin
    v_tiers := v_raw::jsonb;
  exception when others then
    raise exception using errcode = 'RS004', message = format('app_config payg_tiers is not JSON: %s', left(v_raw, 200));
  end;
  if jsonb_typeof(v_tiers) <> 'array' then
    raise exception using errcode = 'RS004', message = 'app_config payg_tiers must be a non-empty JSON array';
  end if;
  if jsonb_array_length(v_tiers) = 0 then
    raise exception using errcode = 'RS004', message = 'app_config payg_tiers must be a non-empty JSON array';
  end if;
  -- Checked in ascending min_usdc order: a larger payment never buys fewer credits per USDC (else paying more could buy
  -- fewer credits in total), and a rate above 1,000 credits/USDC (10x the 1 credit = $0.01 base) is a typo, not a price.
  for t in select e from jsonb_array_elements(v_tiers) e
           order by case when jsonb_typeof(e->'min_usdc') = 'number' then (e->>'min_usdc')::numeric end nulls first loop
    if jsonb_typeof(t) <> 'object' or jsonb_typeof(t->'min_usdc') is distinct from 'number'
       or jsonb_typeof(t->'credits_per_usdc') is distinct from 'number' then
      raise exception using errcode = 'RS004', message = format('app_config payg_tiers: each tier is {min_usdc, credits_per_usdc} numbers, got %s', left(t::text, 200));
    end if;
    -- Those two keys and no other, as src/billing/tiers.ts (z.strictObject) requires: an extra key ("bonus_per_usdc", a
    -- misspelt "credit_per_usdc" beside the real one) is a rate someone meant and nobody would apply. Its own IF, after
    -- the object check above: jsonb_object_keys raises on a non-object, and SQL does not promise to short-circuit OR.
    if (select count(*) from jsonb_object_keys(t)) <> 2 then
      raise exception using errcode = 'RS004', message = format('app_config payg_tiers: each tier has exactly the keys min_usdc and credits_per_usdc, got %s', left(t::text, 200));
    end if;
    v_min := (t->>'min_usdc')::numeric;
    v_rate := (t->>'credits_per_usdc')::numeric;
    if v_min < 0 or v_min >= 1e12 or v_min <> round(v_min, 6) then
      raise exception using errcode = 'RS004', message = format('app_config payg_tiers: min_usdc must be a numeric(18,6) amount >= 0, got %s', v_min);
    end if;
    if v_rate <> trunc(v_rate) or v_rate < 1 or v_rate > 1000 then
      raise exception using errcode = 'RS004', message = format('app_config payg_tiers: credits_per_usdc must be an integer from 1 to 1000, got %s', v_rate);
    end if;
    if v_prev_min is not null and v_min = v_prev_min then
      raise exception using errcode = 'RS004', message = format('app_config payg_tiers: two tiers start at %s USDC', v_min);
    end if;
    if v_prev_rate is not null and v_rate < v_prev_rate then
      raise exception using errcode = 'RS004', message = format('app_config payg_tiers: the tier at %s USDC pays %s credits/USDC, less than the smaller tier''s %s', v_min, v_rate, v_prev_rate);
    end if;
    if v_min = 0 then v_has_zero := true; end if;
    if v_min <= p_amount_usdc then v_best_min := v_min; v_best_rate := v_rate::integer; end if;
    v_prev_min := v_min;
    v_prev_rate := v_rate;
  end loop;
  if not v_has_zero then
    raise exception using errcode = 'RS004', message = 'app_config payg_tiers must include a tier at min_usdc 0 (every amount needs a rate)';
  end if;
  return v_best_rate;
end $$;
comment on function public.payg_credits_per_usdc(numeric, integer) is
  'Credits per USDC for a deposit of p_amount_usdc: the credits_per_usdc of the payg_tiers tier with the highest min_usdc at or below the amount (defaults: >= 1000 -> 120, >= 250 -> 110, else 100). payg_tiers absent -> p_fallback, or RS004 when p_fallback is null. Malformed tiers raise RS004 (not JSON, a tier that is not exactly {min_usdc, credits_per_usdc} numbers (no other key), no tier at 0, two tiers at one min_usdc, a rate that falls as min_usdc rises, a rate outside 1..1000): a deposit is never credited at a guessed rate; the scan holds and alerts instead. Used by credit_from_deposit() and match_deposit(); src/billing/tiers.ts mirrors it for the rates GET /v1/payments/address quotes.';

-- 4. credit_from_deposit: same signature and return shape, tier rate inside ---------------------------------------------
create or replace function public.credit_from_deposit(
  p_tx_hash text, p_log_index integer, p_from text, p_to text,
  p_amount_usdc numeric, p_block bigint, p_safe_block bigint, p_credits_per_usdc integer
) returns table (status text, tenant_id uuid, credits integer)
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_rate integer; v_credits integer; v_balance integer; v_ledger bigint;
begin
  if p_block > p_safe_block then raise exception 'deposit block % is above safe block %', p_block, p_safe_block; end if;
  insert into usdc_deposits (tx_hash, log_index, from_address, to_address, amount_usdc, block_number, safe_block_seen)
  values (lower(p_tx_hash), p_log_index, lower(p_from), lower(p_to), p_amount_usdc, p_block, p_safe_block)
  on conflict (tx_hash, log_index) do nothing;
  if not found then return query select 'duplicate'::text, null::uuid, 0; return; end if;

  v_rate := payg_credits_per_usdc(p_amount_usdc, p_credits_per_usdc);
  v_credits := floor(p_amount_usdc * v_rate)::integer;
  if v_credits < 1 then
    update usdc_deposits d set status = 'dust' where d.tx_hash = lower(p_tx_hash) and d.log_index = p_log_index;
    return query select 'dust'::text, null::uuid, 0; return;
  end if;

  select t.id into v_tenant from tenants t where t.wallet_address = lower(p_from) and t.deleted_at is null;
  if v_tenant is null then
    update usdc_deposits d set status = 'unmatched' where d.tx_hash = lower(p_tx_hash) and d.log_index = p_log_index;
    return query select 'unmatched'::text, null::uuid, 0; return;
  end if;

  update tenants t set credits_balance = t.credits_balance + v_credits where t.id = v_tenant returning t.credits_balance into v_balance;
  insert into credit_ledger (tenant_id, delta, reason, tx_hash, log_index, balance_after, note)
  values (v_tenant, v_credits, 'purchase', lower(p_tx_hash), p_log_index, v_balance, format('%s USDC at %s credits/USDC', p_amount_usdc, v_rate))
  returning id into v_ledger;
  update usdc_deposits d set status = 'credited', tenant_id = v_tenant, ledger_id = v_ledger, credited_at = now(), credits_per_usdc = v_rate
   where d.tx_hash = lower(p_tx_hash) and d.log_index = p_log_index;
  return query select 'credited'::text, v_tenant, v_credits;
end $$;
comment on function public.credit_from_deposit(text, integer, text, text, numeric, bigint, bigint, integer) is
  'INSERT-first on (tx_hash, log_index). Refuses blocks above the safe tag. Credits at payg_credits_per_usdc(amount, p_credits_per_usdc): the tier rate when app_config payg_tiers exists, else the rate passed (the pre-020 Worker passes CREDITS_PER_USDC). Returns credited | unmatched | duplicate | dust (worth < 1 credit: recorded, never credited, never blocks the scan). The Worker reads the purchase ledger row by (tx_hash, log_index) for payment.credited''s balance_after.';

-- 5. match_deposit ----------------------------------------------------------------------------------------------------
create or replace function public.match_deposit(p_tx_hash text, p_log_index integer, p_tenant uuid, p_actor text, p_reason text)
returns table (status text, tenant_id uuid, credits integer, balance_after integer, amount_usdc text, credits_per_usdc integer, replayed boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_tx      text := lower(btrim(p_tx_hash));
  v_actor   text := nullif(btrim(p_actor), '');
  v_reason  text := nullif(btrim(p_reason), '');
  v_dep     usdc_deposits%rowtype;
  v_led     credit_ledger%rowtype;
  v_rate    integer;
  v_credits integer;
  v_balance integer;
  v_ledger  bigint;
begin
  if v_actor is null or v_reason is null or p_tenant is null or p_log_index is null or v_tx is null then
    raise exception using errcode = '22023', message = 'match_deposit: tx_hash, log_index, tenant, actor and reason are all required (a manual credit is audited)';
  end if;
  -- The row lock serializes concurrent matches of one deposit: the second waits, then sees 'credited'.
  select * into v_dep from usdc_deposits d where d.tx_hash = v_tx and d.log_index = p_log_index for update;
  if not found then
    raise exception using errcode = 'P0002', message = format('match_deposit: no deposit %s#%s has been seen', v_tx, p_log_index);
  end if;
  if v_dep.status = 'credited' then
    if v_dep.tenant_id is distinct from p_tenant then
      raise exception using errcode = 'RS003', message = format('match_deposit: deposit %s#%s is already credited to another tenant (%s)', v_tx, p_log_index, v_dep.tenant_id);
    end if;
    -- A retry (or a deposit the scan already credited to this tenant): the same answer, nothing written.
    select * into v_led from credit_ledger l where l.id = v_dep.ledger_id;
    return query select 'credited'::text, v_dep.tenant_id, v_led.delta, v_led.balance_after, v_dep.amount_usdc::text, v_dep.credits_per_usdc, true;
    return;
  end if;
  if v_dep.status <> 'unmatched' then
    raise exception using errcode = 'RS003', message = format('match_deposit: deposit %s#%s is %s; only an unmatched deposit can be matched', v_tx, p_log_index, v_dep.status);
  end if;

  v_rate := payg_credits_per_usdc(v_dep.amount_usdc, null);
  v_credits := floor(v_dep.amount_usdc * v_rate)::integer;
  if v_credits < 1 then
    raise exception using errcode = 'RS003', message = format('match_deposit: deposit %s#%s (%s USDC) is worth less than one credit', v_tx, p_log_index, v_dep.amount_usdc);
  end if;
  update tenants t set credits_balance = t.credits_balance + v_credits
   where t.id = p_tenant and t.deleted_at is null returning t.credits_balance into v_balance;
  if v_balance is null then
    raise exception using errcode = 'P0002', message = format('match_deposit: tenant %s not found or deleted', p_tenant);
  end if;
  -- UNIQUE(tx_hash, log_index) on the ledger is the second guard: one purchase row per transfer, ever.
  insert into credit_ledger (tenant_id, delta, reason, tx_hash, log_index, balance_after, note)
  values (p_tenant, v_credits, 'purchase', v_tx, p_log_index, v_balance,
          format('%s USDC at %s credits/USDC; matched by %s: %s', v_dep.amount_usdc, v_rate, v_actor, left(v_reason, 500)))
  returning id into v_ledger;
  update usdc_deposits d
     set status = 'credited', tenant_id = p_tenant, ledger_id = v_ledger, credited_at = now(), credits_per_usdc = v_rate,
         matched_by = v_actor, match_reason = v_reason, matched_at = now()
   where d.tx_hash = v_tx and d.log_index = p_log_index;
  return query select 'credited'::text, p_tenant, v_credits, v_balance, v_dep.amount_usdc::text, v_rate, false;
end $$;
comment on function public.match_deposit(text, integer, uuid, text, text) is
  'Credit an unmatched USDC deposit to a tenant by hand, at the tier rate for its amount (payg_credits_per_usdc, no fallback). Only status unmatched can be matched: a missing deposit or tenant raises P0002; a dust, seen or another tenant''s credited deposit raises RS003; blank arguments raise 22023; unusable payg_tiers raises RS004 (nothing is credited at a guessed rate). Writes the purchase ledger row (UNIQUE(tx_hash, log_index)) and sets the deposit credited with matched_by / match_reason / matched_at. A second call for the same tenant writes nothing and returns the same (status, tenant_id, credits, balance_after, amount_usdc, credits_per_usdc) with replayed = true, so the Worker emits payment.credited and the operator alert once. Called by POST /internal/deposits/match (admin key).';

-- 6. the low-credit notice --------------------------------------------------------------------------------------------
create or replace function public.credit_ledger_low_credit_reset() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.reason in ('purchase', 'grant') then
    update tenants t set low_credit_notified_at = null where t.id = new.tenant_id and t.low_credit_notified_at is not null;
  end if;
  return null;
end $$;
comment on function public.credit_ledger_low_credit_reset() is
  'AFTER INSERT on credit_ledger: a purchase or a grant clears tenants.low_credit_notified_at, so the next charge below the threshold notifies again. On the ledger rather than in each RPC so every path that adds credits (credit_from_deposit, match_deposit, grant_credits, and any later one) clears it.';
drop trigger if exists credit_ledger_low_credit_reset on credit_ledger;
create trigger credit_ledger_low_credit_reset after insert on credit_ledger for each row execute function credit_ledger_low_credit_reset();
comment on trigger credit_ledger_low_credit_reset on credit_ledger is 'Clears the tenant''s low-credit notice on a purchase or grant (credit_ledger_low_credit_reset).';

create or replace function public.claim_low_credit_notice(p_tenant uuid)
returns table (crossed boolean, balance integer, threshold integer)
language plpgsql security definer set search_path = public as $$
declare v_raw text; v_threshold integer; v_balance integer;
begin
  select c.value into v_raw from app_config c where c.key = 'low_credit_threshold';
  if v_raw is null then
    v_threshold := 500;
  elsif btrim(v_raw) !~ '^\d{1,9}$' then
    raise exception using errcode = 'RS004', message = format('app_config low_credit_threshold must be a whole number of credits, got %s', left(v_raw, 50));
  else
    v_threshold := btrim(v_raw)::integer;
  end if;
  -- One UPDATE decides it: of two concurrent charges, only the first finds low_credit_notified_at still null.
  update tenants t set low_credit_notified_at = now()
   where t.id = p_tenant and t.deleted_at is null and t.low_credit_notified_at is null and t.credits_balance < v_threshold
  returning t.credits_balance into v_balance;
  if found then
    return query select true, v_balance, v_threshold;
    return;
  end if;
  return query select false, (select t.credits_balance from tenants t where t.id = p_tenant), v_threshold;
end $$;
comment on function public.claim_low_credit_notice(uuid) is
  'Called by the Worker after a charge that stands. crossed = true exactly once per low period: the balance is below app_config low_credit_threshold (500 when absent; a value that is not a whole number raises RS004) and no notice was claimed since the last purchase or grant; it sets tenants.low_credit_notified_at. The Worker then queues credits.low. Returns the balance and threshold either way.';

create or replace function public.release_low_credit_notice(p_tenant uuid) returns void
language sql security definer set search_path = public as $$
  update tenants t set low_credit_notified_at = null where t.id = p_tenant;
$$;
comment on function public.release_low_credit_notice(uuid) is
  'Undo a claim_low_credit_notice() whose credits.low event could not be queued, so the next charge tries again instead of the notice being lost.';

-- 7. signed wallet registration ---------------------------------------------------------------------------------------
create table if not exists wallet_challenges (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  address          text not null check (address ~ '^0x[0-9a-f]{40}$'),
  nonce            text not null check (nonce ~ '^[0-9a-f]{32}$'),
  message          text not null check (length(message) between 1 and 1000),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '10 minutes',
  used_at          timestamptz,
  replaced_address text check (replaced_address is null or replaced_address ~ '^0x[0-9a-f]{40}$')
);
comment on table wallet_challenges is
  'Single-use wallet registration challenges (GET /v1/account/wallet/challenge). The tenant signs message with EIP-191 personal_sign from the wallet it will send USDC from; POST /v1/account/wallet verifies the signature against address in the Worker, then register_wallet() marks the row used and sets tenants.wallet_address in one transaction. Used rows are the audit trail of every registration; unused expired rows carry nothing and may be purged. Service role only (RLS).';
comment on column wallet_challenges.id is 'Challenge id the tenant sends back with its signature.';
comment on column wallet_challenges.tenant_id is 'The tenant that asked for the challenge; only that tenant can use it.';
comment on column wallet_challenges.address is 'The lowercase 0x address to register; the signature must recover to it.';
comment on column wallet_challenges.nonce is '16 random bytes, hex: makes every message unique, so a signature is never reusable for another challenge.';
comment on column wallet_challenges.message is
  'Exactly the text the wallet signs: "Resolve wallet registration\ntenant: <tenant_id>\naddress: <address>\nnonce: <nonce>\nissued: <ISO time>" (src/billing/wallet.ts challengeMessage).';
comment on column wallet_challenges.created_at is 'Row insert time (database clock).';
comment on column wallet_challenges.expires_at is 'Ten minutes after issue: a later POST answers 410.';
comment on column wallet_challenges.used_at is 'When register_wallet() registered the address with this challenge; a used challenge answers 409.';
comment on column wallet_challenges.replaced_address is 'The tenant''s wallet_address before this registration replaced it (null when it had none or it was the same): deposits from it are no longer matched to the tenant.';
create unique index if not exists uq_wallet_challenges_nonce on wallet_challenges (nonce);
comment on index uq_wallet_challenges_nonce is 'A nonce is never issued twice.';
create index if not exists idx_wallet_challenges_tenant on wallet_challenges (tenant_id, created_at desc);
comment on index idx_wallet_challenges_tenant is 'A tenant''s challenges, newest first.';
select apply_rls('wallet_challenges');

create or replace function public.register_wallet(p_challenge uuid, p_tenant uuid)
returns table (result text, address text, previous_address text)
language plpgsql security definer set search_path = public as $$
declare v_ch wallet_challenges%rowtype; v_prev text;
begin
  -- The challenge row lock makes it single use: a concurrent second POST waits, then finds used_at set.
  select * into v_ch from wallet_challenges w where w.id = p_challenge and w.tenant_id = p_tenant for update;
  if not found then return query select 'not_found'::text, null::text, null::text; return; end if;
  if v_ch.used_at is not null then return query select 'used'::text, v_ch.address, null::text; return; end if;
  if v_ch.expires_at <= now() then return query select 'expired'::text, v_ch.address, null::text; return; end if;
  -- tenants.wallet_address is UNIQUE over every row, deleted tenants included: their deposits stay theirs.
  if exists (select 1 from tenants t where t.wallet_address = v_ch.address and t.id <> p_tenant) then
    return query select 'taken'::text, v_ch.address, null::text; return;
  end if;
  select t.wallet_address into v_prev from tenants t where t.id = p_tenant and t.deleted_at is null for update;
  if not found then return query select 'not_found'::text, null::text, null::text; return; end if;
  begin
    update tenants t set wallet_address = v_ch.address where t.id = p_tenant;
  exception when unique_violation then
    -- another tenant registered the address between the check above and this update
    return query select 'taken'::text, v_ch.address, null::text; return;
  end;
  update wallet_challenges w set used_at = now(), replaced_address = nullif(v_prev, v_ch.address) where w.id = p_challenge;
  return query select 'registered'::text, v_ch.address, nullif(v_prev, v_ch.address);
end $$;
comment on function public.register_wallet(uuid, uuid) is
  'Second half of signed wallet registration; the Worker has already verified the EIP-191 signature of the challenge message against its address. In one transaction: the challenge (p_tenant''s own) must be unused and unexpired; an address held by another tenant (deleted ones included) is refused; else tenants.wallet_address = address and the challenge is marked used with the replaced address. result: registered | not_found | used | expired | taken (nothing is written unless registered).';

-- 8. least privilege (Supabase default privileges grant anon/authenticated directly; migration 010) ---------------------
revoke all on table wallet_challenges from public, anon, authenticated;
grant select, insert, update, delete on table wallet_challenges to service_role;
revoke all on function public.payg_credits_per_usdc(numeric, integer) from public, anon, authenticated;
grant execute on function public.payg_credits_per_usdc(numeric, integer) to service_role;
revoke all on function public.credit_from_deposit(text, integer, text, text, numeric, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.credit_from_deposit(text, integer, text, text, numeric, bigint, bigint, integer) to service_role;
revoke all on function public.match_deposit(text, integer, uuid, text, text) from public, anon, authenticated;
grant execute on function public.match_deposit(text, integer, uuid, text, text) to service_role;
revoke all on function public.credit_ledger_low_credit_reset() from public, anon, authenticated;
grant execute on function public.credit_ledger_low_credit_reset() to service_role;
revoke all on function public.claim_low_credit_notice(uuid) from public, anon, authenticated;
grant execute on function public.claim_low_credit_notice(uuid) to service_role;
revoke all on function public.release_low_credit_notice(uuid) from public, anon, authenticated;
grant execute on function public.release_low_credit_notice(uuid) to service_role;
revoke all on function public.register_wallet(uuid, uuid) from public, anon, authenticated;
grant execute on function public.register_wallet(uuid, uuid) to service_role;

commit;

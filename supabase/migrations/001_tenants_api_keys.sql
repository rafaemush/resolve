-- Migration 001 — tenants, API keys, shared helpers (Resolve, 2026-09-22).
--
-- WHY: every table in this database is reached only by the Worker holding the
-- service_role key, or by pg_cron inside the database. The anon key is never
-- shipped to a browser, but PostgREST is still reachable by anyone who learns
-- the project URL, so RLS is the barrier: service_role ALL + explicit deny for
-- anon/authenticated on every table (OilFlow migration 218 pair). Soft deletes
-- only. COMMENT ON everything.
--
-- api_keys mirrors OilFlow platform/src/lib/api-auth.ts: raw key shown once,
-- sha256 stored, display prefix kept, atomic UTC-day counter via RPC.

begin;

create extension if not exists pgcrypto;

-- helpers -------------------------------------------------------------------
create or replace function public.apply_rls(p_table text)
returns void language plpgsql as $$
begin
  execute format('alter table %I enable row level security', p_table);
  execute format('alter table %I force row level security', p_table);
  execute format('drop policy if exists %I on %I', p_table || '_service', p_table);
  execute format('create policy %I on %I for all to service_role using (true) with check (true)', p_table || '_service', p_table);
  execute format('drop policy if exists %I on %I', p_table || '_deny', p_table);
  execute format('create policy %I on %I for all to anon, authenticated using (false) with check (false)', p_table || '_deny', p_table);
end $$;
comment on function public.apply_rls(text) is 'Canonical RLS pair: service_role ALL, anon/authenticated denied. Call once per table.';

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create or replace function public.deny_mutation()
returns trigger language plpgsql as $$
begin raise exception 'table % is append-only (no % allowed)', tg_table_name, tg_op; end $$;
comment on function public.deny_mutation() is 'Attach BEFORE UPDATE OR DELETE to make a ledger table append-only for every role, including service_role.';

-- tenants -------------------------------------------------------------------
create table if not exists tenants (
  id              uuid primary key default gen_random_uuid(),
  display_name    text not null,
  contact         text,
  wallet_address  text unique,
  plan            text not null default 'free' check (plan in ('free','payg','builder','growth','platform')),
  credits_balance integer not null default 0 check (credits_balance >= 0),
  watch_limit     integer not null default 5 check (watch_limit >= 0),
  strict_v0       boolean not null default false,
  billing_entity  text,
  meta            jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint tenants_wallet_lower check (wallet_address is null or wallet_address = lower(wallet_address))
);
comment on table tenants is 'One row per paying or free customer. wallet_address (lowercase EVM) is the crypto-buyer identity used to match USDC deposits. credits_balance is the materialized sum of credit_ledger and is only moved by the ledger RPCs.';
comment on column tenants.strict_v0 is 'When true the verdict body carries only INSUFFICIENT_DATA|SOURCE_MISMATCH and no error_reason; UNSAFE_INPUT->422 and UPSTREAM_UNAVAILABLE->503 at the HTTP level.';
drop trigger if exists tenants_updated_at on tenants;
create trigger tenants_updated_at before update on tenants for each row execute function set_updated_at();
select apply_rls('tenants');

-- api_keys ------------------------------------------------------------------
create table if not exists api_keys (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  key_hash       text not null,
  key_prefix     text not null,
  name           text not null default 'default',
  environment    text not null default 'live' check (environment in ('live','test')),
  scopes         text[] not null default '{}',
  daily_cap      integer not null default 1000 check (daily_cap >= 0),
  requests_today integer not null default 0,
  day_bucket     date,
  requests_total bigint not null default 0,
  last_used_at   timestamptz,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
comment on table api_keys is 'sha256(raw key) lookup table. Raw keys look like rsl_live_<32 chars> / rsl_test_<32 chars> and are shown exactly once. key_prefix is the first 12 chars + "..." for display only.';
comment on column api_keys.daily_cap is 'UTC-day request cap enforced on the value bump_api_key_usage_atomic() returns.';
create unique index if not exists idx_api_keys_hash_active on api_keys (key_hash) where revoked_at is null and deleted_at is null;
create index if not exists idx_api_keys_tenant on api_keys (tenant_id) where deleted_at is null;
select apply_rls('api_keys');

create or replace function public.bump_api_key_usage_atomic(p_key_id uuid)
returns integer language sql security definer set search_path = public as $$
  update api_keys
     set requests_today = case when day_bucket is distinct from (now() at time zone 'utc')::date
                               then 1 else requests_today + 1 end,
         day_bucket     = (now() at time zone 'utc')::date,
         requests_total = requests_total + 1,
         last_used_at   = now()
   where id = p_key_id
  returning requests_today;
$$;
comment on function public.bump_api_key_usage_atomic(uuid) is 'Atomic, UTC-day-aware increment. Returns the post-increment count; the caller enforces daily_cap on that value (bill-then-check).';
revoke all on function public.bump_api_key_usage_atomic(uuid) from public;
grant execute on function public.bump_api_key_usage_atomic(uuid) to service_role;

commit;

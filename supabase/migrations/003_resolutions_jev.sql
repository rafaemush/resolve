-- Migration 003 — resolutions, jev_calls, jev_spend_daily (Resolve, 2026-09-22).
--
-- WHY: resolutions.id IS the request_id. When a tenant sends an Idempotency-Key
-- the id is sha256(tenant_id|key), so the same logical request always maps to
-- the same row and UNIQUE(tenant_id, idempotency_key) makes the INSERT-first
-- claim atomic (OilFlow migration 173 shape). The CHECK constraints encode the
-- public contract invariants at the database, so no code path can persist a
-- verdict that violates them: ERROR <=> error_code present <=> error_reason
-- present; winning_outcome is NONE unless RESOLVED.

begin;

create table if not exists resolutions (
  id                  text primary key,
  tenant_id           uuid references tenants(id),
  api_key_id          uuid references api_keys(id),
  market_id           uuid references markets(id),
  evidence_id         uuid references evidence(id),
  idempotency_key     text,
  mode                text not null default 'tenant' check (mode in ('tenant','shadow','eval')),
  status_row          text not null default 'pending' check (status_row in ('pending','complete','failed')),
  resolution_status   text check (resolution_status in ('RESOLVED','UNRESOLVED','ERROR')),
  winning_outcome     text check (winning_outcome in ('OPTION_A','OPTION_B','NONE')),
  confidence_score    numeric(3,2) check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 0.99)),
  error_code          text check (error_code is null or error_code in ('INSUFFICIENT_DATA','SOURCE_MISMATCH','UNSAFE_INPUT','UPSTREAM_UNAVAILABLE')),
  error_reason        text check (error_reason is null or error_reason in ('INJECTION_SUSPECTED','SUBJECT_MISMATCH','SOURCE_REF_MISMATCH','NO_ANCHOR','OUT_OF_WINDOW','CORRUPT_INPUT','TOO_SHORT','NO_STATEMENT','AMBIGUOUS_VALUE','COVERAGE_GAP','MODEL_UNAVAILABLE','BUDGET_EXCEEDED','SOURCE_UNREACHABLE','RENDER_BUDGET_EXHAUSTED','BILLING_UNAVAILABLE','PAID_JEV_DISABLED')),
  caveats             jsonb not null default '[]'::jsonb check (jsonb_typeof(caveats) = 'array'),
  determination_basis text check (determination_basis is null or determination_basis in ('structured','jev')),
  checks              jsonb not null default '[]'::jsonb check (jsonb_typeof(checks) = 'array'),
  jev_answers         jsonb check (jev_answers is null or jsonb_typeof(jev_answers) = 'object'),
  jev_model           text,
  thresholds_version  text,
  credits_charged     integer not null default 0 check (credits_charged >= 0),
  credits_refunded    integer not null default 0 check (credits_refunded >= 0),
  duration_ms         integer,
  jev_ms              integer,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz,
  constraint resolutions_idem unique (tenant_id, idempotency_key),
  constraint resolutions_error_iff_code check (
    resolution_status is null
    or (resolution_status = 'ERROR' and error_code is not null and error_reason is not null)
    or (resolution_status <> 'ERROR' and error_code is null and error_reason is null)),
  constraint resolutions_outcome_iff_resolved check (
    resolution_status is null or winning_outcome is null
    or ((resolution_status = 'RESOLVED') = (winning_outcome <> 'NONE'))),
  constraint resolutions_unresolved_has_caveat check (
    resolution_status is distinct from 'UNRESOLVED' or jsonb_array_length(caveats) >= 1)
);
comment on table resolutions is 'One row per resolution attempt; id is the public request_id. status_row=pending is the INSERT-first idempotency stub written before any charge or Jev call. The CHECKs are the contract invariants: a verdict that violates them cannot exist.';
create index if not exists idx_resolutions_market_time on resolutions (market_id, created_at desc);
create index if not exists idx_resolutions_tenant_time on resolutions (tenant_id, created_at desc) where tenant_id is not null;
create index if not exists idx_resolutions_shadow on resolutions (created_at desc) where mode = 'shadow';
select apply_rls('resolutions');

create table if not exists jev_calls (
  id            uuid primary key default gen_random_uuid(),
  resolution_id text references resolutions(id),
  surface       text not null default 'resolve',
  model         text not null,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd      numeric(12,8) not null default 0,
  http_status   integer,
  latency_ms    integer,
  error         text,
  created_at    timestamptz not null default now()
);
comment on table jev_calls is 'Every call to the model, priced at insert time. An unknown model id is priced at 100x list so it can never read as free.';
create index if not exists idx_jev_calls_time on jev_calls (created_at desc);
select apply_rls('jev_calls');

create table if not exists jev_spend_daily (
  day          date primary key,
  calls        integer not null default 0,
  input_tokens bigint not null default 0,
  usd_estimate numeric(12,6) not null default 0,
  updated_at   timestamptz not null default now()
);
comment on table jev_spend_daily is 'Atomic daily accumulator behind the JEV_DAILY_USD_CEILING gate (UTC day).';
select apply_rls('jev_spend_daily');

create or replace function public.record_jev_spend(p_input_tokens integer, p_usd numeric)
returns numeric language sql security definer set search_path = public as $$
  insert into jev_spend_daily as s (day, calls, input_tokens, usd_estimate)
  values ((now() at time zone 'utc')::date, 1, p_input_tokens, p_usd)
  on conflict (day) do update
    set calls = s.calls + 1,
        input_tokens = s.input_tokens + excluded.input_tokens,
        usd_estimate = s.usd_estimate + excluded.usd_estimate,
        updated_at = now()
  returning usd_estimate;
$$;
create or replace function public.jev_spend_today()
returns numeric language sql security definer set search_path = public as $$
  select coalesce((select usd_estimate from jev_spend_daily where day = (now() at time zone 'utc')::date), 0);
$$;
revoke all on function public.record_jev_spend(integer, numeric) from public;
revoke all on function public.jev_spend_today() from public;
grant execute on function public.record_jev_spend(integer, numeric) to service_role;
grant execute on function public.jev_spend_today() to service_role;

commit;

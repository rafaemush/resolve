-- Migration 009 — settle-bot posts, reconciliations, webhooks, track-record view (Resolve, 2026-09-22).
--
-- WHY: the public track record is commit-reveal. A commit row is written the
-- moment a shadow verdict exists (hash of the verdict + nonce; the verdict
-- itself stays private) and is never edited; the reveal is a separate row that
-- replies to the commit once the platform of record has resolved. Every
-- statistic anyone can quote is a column of v_track_record; nothing is typed by
-- hand, and no percentage is exposed until n_reconciled >= 100.
-- Webhooks: at-least-once delivery with HMAC signature, capped backoff, DLQ,
-- replay (OilFlow shared/webhooks.py shape).

begin;

create table if not exists bot_posts (
  id                  uuid primary key default gen_random_uuid(),
  resolution_id       text references resolutions(id),
  market_id           uuid not null references markets(id),
  channel             text not null default 'telegram' check (channel in ('telegram','none')),
  kind                text not null check (kind in ('commit','reveal','digest')),
  message_id          bigint,
  reply_to_message_id bigint,
  telegram_date       timestamptz,
  commitment_sha256   text,
  nonce               text,
  payload             jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  dedup_key           text unique,
  posted_at           timestamptz not null default now(),
  created_at          timestamptz not null default now()
);
comment on table bot_posts is 'Commit and reveal posts. A commit row is immutable (trigger). nonce is private until the reveal; commitment_sha256 = sha256(market_id|status|outcome|confidence|caveats|evidence_canonical_sha256|thresholds_version|nonce).';
create index if not exists idx_bot_posts_market on bot_posts (market_id, created_at desc);
create or replace function public.deny_commit_mutation() returns trigger language plpgsql as $$
begin
  if old.kind = 'commit' then raise exception 'commit posts are immutable'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists bot_posts_commit_immutable on bot_posts;
create trigger bot_posts_commit_immutable before update or delete on bot_posts for each row execute function deny_commit_mutation();
select apply_rls('bot_posts');

create table if not exists reconciliations (
  id               bigint generated always as identity primary key,
  resolution_id    text not null unique references resolutions(id),
  market_id        uuid not null references markets(id),
  platform         text not null,
  official_outcome text check (official_outcome is null or official_outcome in ('OPTION_A','OPTION_B','VOID')),
  official_at      timestamptz,
  agreement        text not null check (agreement in ('agree','disagree','void','pending','abstained')),
  lead_seconds     integer,
  source_url       text,
  reconciled_at    timestamptz not null default now()
);
comment on table reconciliations is 'One row per committed shadow verdict once the platform of record resolves. abstained = we committed UNRESOLVED/ERROR; disagree = a false RESOLVED, revealed exactly like an agreement.';
create index if not exists idx_reconciliations_market on reconciliations (market_id);
select apply_rls('reconciliations');

create table if not exists webhook_endpoints (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  url        text not null,
  secret     text not null,
  events     text[] not null default '{market.resolved,market.unresolved_update,market.error,credits.low,payment.credited}',
  active     boolean not null default true,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table webhook_endpoints is 'Tenant webhook targets. secret signs X-Resolve-Signature: t=<unix>,v1=hmac_sha256(secret, "<t>.<body>"). Service-role only; never returned after creation.';
create index if not exists idx_webhook_endpoints_tenant on webhook_endpoints (tenant_id) where deleted_at is null;
select apply_rls('webhook_endpoints');

create table if not exists webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  endpoint_id      uuid not null references webhook_endpoints(id),
  tenant_id        uuid not null references tenants(id),
  event_id         uuid not null unique default gen_random_uuid(),
  event_type       text not null,
  payload          jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256   text,
  status           text not null default 'pending' check (status in ('pending','delivering','delivered','dlq')),
  attempt          integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  lease_until      timestamptz,
  last_status_code integer,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz not null default now()
);
comment on table webhook_deliveries is 'At-least-once outbound queue. Retry schedule: 0s, 60s, 5m, 30m, 2h, 12h, 24h then dlq. event_id is the idempotency key handed to the receiver.';
create index if not exists idx_webhook_deliveries_due on webhook_deliveries (next_attempt_at) where status = 'pending';
create index if not exists idx_webhook_deliveries_tenant on webhook_deliveries (tenant_id, created_at desc);
select apply_rls('webhook_deliveries');

-- Lease a batch of due deliveries atomically (one Worker tick).
create or replace function public.claim_webhook_deliveries(p_max integer default 10)
returns setof webhook_deliveries language sql security definer set search_path = public as $$
  with due as (
    select id from webhook_deliveries
     where status = 'pending' and next_attempt_at <= now() and (lease_until is null or lease_until < now())
     order by next_attempt_at limit p_max for update skip locked)
  update webhook_deliveries d set status = 'delivering', lease_until = now() + interval '60 seconds'
    from due where d.id = due.id
  returning d.*;
$$;
revoke all on function public.claim_webhook_deliveries(integer) from public;
grant execute on function public.claim_webhook_deliveries(integer) to service_role;

-- Track record: rendered, never typed. Percentages are NULL until n_reconciled >= 100 (the API renders "not yet reportable").
create or replace view public.v_track_record as
with shadow as (
  select r.id, r.market_id, m.platform, r.resolution_status, r.winning_outcome, r.determination_basis, r.duration_ms, r.created_at,
         date_trunc('week', r.created_at) as week
    from resolutions r join markets m on m.id = r.market_id
   where r.mode = 'shadow' and r.status_row = 'complete'),
commits as (select market_id, min(posted_at) as first_commit from bot_posts where kind = 'commit' group by market_id),
agg as (
  select s.platform, s.week,
         count(distinct s.market_id) as n_markets_shadowed,
         count(distinct c.market_id) as n_committed,
         count(distinct rc.market_id) filter (where rc.agreement <> 'pending') as n_reconciled,
         count(distinct rc.market_id) filter (where rc.agreement = 'agree') as resolved_correct,
         count(distinct rc.market_id) filter (where rc.agreement = 'disagree') as resolved_wrong,
         count(distinct rc.market_id) filter (where rc.agreement = 'abstained') as abstained,
         percentile_cont(0.5) within group (order by rc.lead_seconds) filter (where rc.agreement in ('agree','disagree')) as median_lead_seconds,
         percentile_cont(0.95) within group (order by s.duration_ms) as p95_query_ms,
         count(*) filter (where s.determination_basis = 'jev')::numeric / nullif(count(*), 0) as jev_share
    from shadow s
    left join commits c on c.market_id = s.market_id
    left join reconciliations rc on rc.resolution_id = s.id
   group by s.platform, s.week)
select platform, week, n_markets_shadowed, n_committed, n_reconciled, resolved_correct, resolved_wrong, abstained,
       case when n_reconciled >= 100 then round(resolved_correct::numeric / nullif(n_markets_shadowed, 0), 4) end as coverage_accuracy,
       case when n_reconciled >= 100 then round(resolved_correct::numeric / nullif(resolved_correct + resolved_wrong, 0), 4) end as precision,
       case when n_reconciled >= 100 then round(abstained::numeric / nullif(n_reconciled, 0), 4) end as abstention_rate,
       resolved_wrong as false_resolved,
       median_lead_seconds, p95_query_ms, round(jev_share, 4) as jev_share,
       (n_reconciled >= 100) as reportable
  from agg;
comment on view public.v_track_record is 'Per platform and ISO week. coverage_accuracy = resolved_correct / n_markets_shadowed (a timid oracle cannot look precise). NULL percentages below 100 reconciled markets.';

commit;

-- 023_priced_reveal: the price of the private early reveal, its refund when the webhook is late, paid reveals delivered
-- first, and following every leg of an event in one call (plan "1. Make it buyable", approved by the founder 2026-10-05).
-- WHY:
--   * Nothing can earn until it has a price. The private early reveal (the shadow.committed webhook, GET
--     /v1/shadow/:market_id, GET /v1/shadow/export) cost 0 credits. Free and pay-as-you-go tenants now pay 25 credits
--     per RESOLVED leg revealed to them, at most 2,000 credits per event (markets.event_key, 017) per tenant; Builder,
--     Growth and Platform include reveals, as docs/pricing.md publishes them; a free tenant created before the cut-over
--     (REVEAL_PRICING_FROM, src/shadow/reveal.ts) keeps free reveals until its evaluation key expires. The Worker sends
--     the price, the cap, the cut-over and the included plans; the rules that need the ledger run here.
--     charge_reveals() decides and charges a set of (tenant, market) pairs in one call: one RPC per publish whatever the
--     number of followers (the publish path's budget, COMMITTED_QUEUE_SUBREQUESTS in src/shadow/events.ts), one per
--     GET /v1/shadow/:market_id and one per export. Modelled on charge_read() (022): every tenant row is locked first,
--     in id order (two publishes that share followers cannot deadlock), each replay and each event total is read in a
--     statement of its own after the lock (a concurrent publish for the same tenant waits, then sees the charge it
--     made), a short balance writes nothing (the reveal is locked: the hash and the card pointer, never the verdict),
--     and there is no unique_violation handler. One credit_ledger 'charge' row per (tenant, market), request id
--     reveal:<tenant uuid>:<market uuid>: a later commit of the same market, a re-read and a retry find it and are free.
--     The low-credit notice is claimed in the same call (claim_low_credit_notice(), 020), so the Worker queues
--     credits.low with the event itself instead of spending one RPC per charged follower.
--     A verdict that is already public (the market settled: resolved, void or closed_unresolved; settle_market(), 012,
--     records its reveals in the same transaction) is not a private early reveal: charge_reveals() answers it 'public',
--     free, whoever asks.
--   * The refund rule: a reveal charged for a queued shadow.committed (ledger note 'reveal webhook') is refunded once
--     when Resolve did not put it in front of the tenant in time: no delivery of it was attempted (its POST sent,
--     webhook_deliveries.first_attempt_at) by its reveal_due_at (committed_at + REVEAL_LATE_MINUTES = 10), none was
--     delivered by then, and the tenant did not read the verdict at GET /v1/shadow/:market_id or the export in the
--     meantime (reveal_reads). That covers no delivery queued at all (the insert failed after the charge), a queue
--     that was behind, and an endpoint deactivated before its attempt (dead-lettered without a POST). Once an attempt
--     was made in time the charge stands, whatever the endpoint answered: the body of that POST carried the verdict
--     (a receiver that answers 500, or hangs past the timeout, has read it), so a rule keyed on the receiver's answer
--     would let any tenant take every reveal for nothing; the verdict also stays readable, free, at GET
--     /v1/shadow/:market_id. refund_late_reveals() runs every 5 minutes from pg_cron and refunds through
--     refund_credits() (004: once per request id). A charge taken by a read (note 'reveal read') is never refunded: the
--     verdict was in the answer. storage_status() (022) also reports the newest refund run and its cron job, so the
--     Worker's 10-minute check alerts when it fails or stops, in the same one RPC.
--   * Paid reveals first: webhook_deliveries.priority (3 a paid reveal, 2 an included plan, 1 grandfathered or a
--     verdict that is not RESOLVED, 0 everything else); claim_webhook_deliveries() (009) claims the highest priority
--     first, first attempts before retries within a priority (a retry to an endpoint that failed cannot hold back a
--     paid reveal's first attempt, the one the refund rule reads), and the Worker's inline first attempt takes the same
--     order (src/webhooks/deliver.ts inlineCandidates). The ceiling stays INLINE_MAX (2) inline attempts per publish
--     and DRAIN_MAX (5) per 5-minute drain: past about 7 paying followers with an endpoint on one commit, the rest are
--     attempted after the 10 minutes and refunded (docs/runbooks/venue-pilot.md).
--   * follow_event(): POST /v1/markets/:id/follow {"scope":"event"} follows every open public leg of the market's event
--     (an official release's legs on every venue, a Polymarket event's legs) in one transaction, all or nothing against
--     the plan's follow limit (a Québec event has 135 legs; pay as you go now follows up to 500).
--
-- Compatibility with the Worker deployed before this migration (889e9a4; it keeps running until the new one ships):
--   * Additive: four columns on webhook_deliveries (priority defaults to 0, the three reveal columns are nullable), one
--     new table (reveal_reads, written only by charge_reveals), four indexes, four new functions, one pg_cron job.
--     claim_webhook_deliveries keeps its signature and return type; only its order changes (priority first, then first
--     attempts before retries, then next_attempt_at as before), and every row the old Worker queues has priority 0, so
--     among them only a fresh row now goes before an older retry, which a drain of 5 a run reaches either way.
--     storage_status keeps its three keys and adds two, which the old Worker's parse drops. The old Worker never calls
--     charge_reveals, follow_event or refund_late_reveals: its reveals stay free, and refund_late_reveals finds no
--     'reveal webhook' charge to refund, until the new Worker ships.
-- Idempotent (if not exists / create or replace / a cron job rescheduled by name). Nothing here is reachable by anon or
-- authenticated (migration 010 explains why revoking from public alone is not enough on Supabase).
begin;

-- 1. webhook_deliveries: delivery priority and the reveal charge a delivery carries ------------------------------------
alter table webhook_deliveries add column if not exists priority smallint not null default 0;
alter table webhook_deliveries add column if not exists reveal_charge_id text;
alter table webhook_deliveries add column if not exists reveal_due_at timestamptz;
alter table webhook_deliveries add column if not exists first_attempt_at timestamptz;
alter table webhook_deliveries drop constraint if exists webhook_deliveries_priority_check;
alter table webhook_deliveries add constraint webhook_deliveries_priority_check check (priority between 0 and 3);
-- A delivery carries a reveal charge with its deadline, or neither: the refund rule reads both together.
alter table webhook_deliveries drop constraint if exists webhook_deliveries_reveal_charge_check;
alter table webhook_deliveries add constraint webhook_deliveries_reveal_charge_check check (
  (reveal_charge_id is null and reveal_due_at is null)
  or (reveal_charge_id ~ '^reveal:[0-9a-f-]{36}:[0-9a-f-]{36}$' and reveal_due_at is not null and event_type = 'shadow.committed'));
comment on column webhook_deliveries.priority is
  'Delivery order (migration 023): 3 = a shadow.committed whose reveal the tenant paid for (charged now, a replay of a charge, or free past the event cap), 2 = an included plan (Builder, Growth, Platform), 1 = a grandfathered evaluation key or a verdict that is not RESOLVED, 0 = everything else (locked reveals and every other event; the default, so the Worker deployed before 023 queues at 0). claim_webhook_deliveries() and the inline first attempt take the highest first.';
comment on column webhook_deliveries.reveal_charge_id is
  'The credit_ledger request id (reveal:<tenant>:<market>) of the reveal charge taken when this shadow.committed was queued; null for every other delivery (a replayed or included reveal, a locked one, another event). Every endpoint''s delivery of that event carries it. refund_late_reveals() refunds the charge when none of them was delivered by reveal_due_at.';
comment on column webhook_deliveries.reveal_due_at is
  'committed_at + REVEAL_LATE_MINUTES (10) of the commit this charged shadow.committed carries: no delivery of it attempted (first_attempt_at) or delivered by then, and no read of it (reveal_reads), and refund_late_reveals() refunds reveal_charge_id. Set exactly when reveal_charge_id is.';
comment on column webhook_deliveries.first_attempt_at is
  'When the first POST of a delivery that carries a reveal charge (reveal_charge_id) was sent, written with the outcome of that attempt whatever the endpoint answered (src/webhooks/deliver.ts); null until then and on every other delivery. A delivery dead-lettered without a POST because the tenant removed its endpoint (only DELETE /v1/webhooks/:id deactivates one) records it at that moment: the tenant's own removal is not Resolve's lateness. refund_late_reveals() reads it: a reveal attempted by reveal_due_at was put in front of the tenant and is not refunded.';
create index if not exists idx_webhook_deliveries_claim on webhook_deliveries (priority desc, attempt, next_attempt_at) where status = 'pending';
comment on index idx_webhook_deliveries_claim is 'claim_webhook_deliveries(): due pending rows, highest priority first, then first attempts before retries, then oldest due first.';
create index if not exists idx_webhook_deliveries_reveal_charge on webhook_deliveries (reveal_charge_id) where reveal_charge_id is not null;
comment on index idx_webhook_deliveries_reveal_charge is 'refund_late_reveals(): the deliveries of one reveal charge.';
create index if not exists idx_ledger_reveal_webhook on credit_ledger (created_at) where reason = 'charge' and note = 'reveal webhook';
comment on index idx_ledger_reveal_webhook is 'refund_late_reveals(): the reveal charges taken for a queued shadow.committed, by time.';
create index if not exists idx_markets_event_key on markets (event_key);
comment on index idx_markets_event_key is 'Every leg of an event, settled ones included: charge_reveals() sums what a tenant paid for the event''s reveals (idx_markets_event_key_open, 017, covers open legs only).';

comment on table webhook_deliveries is
  'At-least-once outbound queue. Retry schedule: 0s, 60s, 5m, 30m, 2h, 12h, 24h then dlq. event_id is the idempotency key handed to the receiver. priority orders the claim (paid reveals first, migration 023); reveal_charge_id, reveal_due_at and first_attempt_at tie a charged shadow.committed to its refund rule.';

-- reveal_reads: a webhook charge whose verdict the tenant also read, which is then never refunded
create table if not exists reveal_reads (
  request_id    text primary key check (request_id ~ '^reveal:[0-9a-f-]{36}:[0-9a-f-]{36}$'),
  tenant_id     uuid not null references tenants(id),
  first_read_at timestamptz not null default now()
);
comment on table reveal_reads is
  'Migration 023: one row per reveal charge (credit_ledger request id reveal:<tenant>:<market>) whose RESOLVED verdict the tenant then read at GET /v1/shadow/:market_id or GET /v1/shadow/export as a replay of that charge. Written only by charge_reveals() (a replay from source read, insert on conflict do nothing); read only by refund_late_reveals(), which never refunds a charge listed here: the tenant received the verdict in the answer, so a late or missing webhook cost it nothing. Append-only. Service role only (RLS).';
comment on column reveal_reads.request_id is 'The reveal charge''s credit_ledger request id: reveal:<tenant uuid>:<market uuid>.';
comment on column reveal_reads.tenant_id is 'The tenant that read it (the charge''s tenant).';
comment on column reveal_reads.first_read_at is 'The first read that replayed the charge (database clock); later reads leave it as it is.';
select apply_rls('reveal_reads');
revoke all on table reveal_reads from public, anon, authenticated;

-- 2. the claim: highest priority first ---------------------------------------------------------------------------------
create or replace function public.claim_webhook_deliveries(p_max integer default 10)
returns setof webhook_deliveries language sql security definer set search_path = public as $$
  with due as (
    select id from webhook_deliveries
     where status = 'pending' and next_attempt_at <= now() and (lease_until is null or lease_until < now())
     order by priority desc, attempt, next_attempt_at, id limit p_max for update skip locked)
  update webhook_deliveries d set status = 'delivering', lease_until = now() + interval '60 seconds'
    from due where d.id = due.id
  returning d.*;
$$;
comment on function public.claim_webhook_deliveries(integer) is
  'Lease up to p_max due deliveries for one drain run (status delivering, a 60 s lease), skipping rows another run holds: highest priority first (migration 023: paid reveals, then included plans, then the rest), then first attempts before retries (attempt ascending: a paid reveal''s first attempt, which its refund rule reads, is never held back by retries to an endpoint that failed), then the oldest next_attempt_at, then id (a stable order for rows of one insert). A row whose lease is still running is not due.';
revoke all on function public.claim_webhook_deliveries(integer) from public, anon, authenticated;
grant execute on function public.claim_webhook_deliveries(integer) to service_role;

-- 3. charge_reveals: the reveal decision and its one charge per (tenant, market) ------------------------------------------
create or replace function public.charge_reveals(
  p_tenants uuid[], p_markets uuid[], p_price integer, p_event_cap integer, p_pricing_from timestamptz,
  p_included_plans text[], p_source text)
returns table (tenant_id uuid, market_id uuid, plan text, entitled_full boolean, replayed boolean, charged integer,
               price integer, balance integer, reason text, low_credit boolean, low_credit_threshold integer)
language plpgsql security definer set search_path = public as $$
declare
  v_pair      record;
  v_ten       record;
  v_id        text;
  v_owner     uuid;
  v_spent     integer;
  v_due       integer;
  v_balance   integer;
  v_low       boolean;
  v_threshold integer;
begin
  if p_price is null or p_price < 1 or p_event_cap is null or p_event_cap < p_price then
    raise exception using errcode = '22023', message = format('charge_reveals: a positive price and an event cap of at least the price are required, got %s and %s', p_price, p_event_cap);
  end if;
  if p_source is null or p_source not in ('webhook', 'read') then
    raise exception using errcode = '22023', message = format('charge_reveals: p_source must be webhook or read, got %s', p_source);
  end if;
  if p_pricing_from is null or p_included_plans is null then
    raise exception using errcode = '22023', message = 'charge_reveals: the pricing cut-over and the included plans are required';
  end if;
  if coalesce(cardinality(p_tenants), 0) <> coalesce(cardinality(p_markets), 0) or coalesce(cardinality(p_tenants), 0) > 1000 then
    raise exception using errcode = '22023', message = format('charge_reveals: p_tenants and p_markets are pairs, at most 1000 (got %s and %s)', cardinality(p_tenants), cardinality(p_markets));
  end if;
  if coalesce(cardinality(p_tenants), 0) = 0 then return; end if;
  if exists (select 1 from unnest(p_tenants, p_markets) as x(t, m) where x.t is null or x.m is null) then
    raise exception using errcode = '22023', message = 'charge_reveals: a pair names no tenant or no market';
  end if;
  -- Every tenant row first, in id order: a concurrent call for an overlapping set of tenants (another market's publish,
  -- a read) waits here until this one commits, and two calls can never hold each other's rows. The replay and the event
  -- total below are statements of their own, so after a wait they see the charges the other call made.
  perform 1 from tenants t where t.id = any(p_tenants) order by t.id for update;
  for v_pair in
    select distinct x.t, x.m, mk.event_key as ek, (mk.id is not null and mk.tenant_id is null and not mk.is_test) as public_market,
           mk.status in ('resolved', 'void', 'closed_unresolved') as settled
      from unnest(p_tenants, p_markets) as x(t, m) left join markets mk on mk.id = x.m
     order by x.t, ek, x.m
  loop
    if not v_pair.public_market then
      raise exception using errcode = '22023', message = format('charge_reveals: market %s is not a public shadow market', v_pair.m);
    end if;
    -- read per pair: an earlier pair of the same tenant in this call may have debited it
    select t.plan as pl, t.credits_balance as bal, t.created_at as created, t.deleted_at is null as live into v_ten from tenants t where t.id = v_pair.t;
    if not found then
      return query select v_pair.t, v_pair.m, null::text, false, false, 0, p_price, 0, 'unknown_tenant'::text, null::boolean, null::integer;
      continue;
    end if;
    if not v_ten.live then
      return query select v_pair.t, v_pair.m, v_ten.pl, false, false, 0, p_price, 0, 'unknown_tenant'::text, null::boolean, null::integer;
      continue;
    end if;
    -- A settled market's commits are public (settle_market() recorded their reveals with the status): nothing private
    -- is left to sell, whatever the plan.
    if v_pair.settled then
      return query select v_pair.t, v_pair.m, v_ten.pl, true, false, 0, 0, v_ten.bal, 'public'::text, null::boolean, null::integer;
      continue;
    end if;
    if v_ten.pl = any(p_included_plans) then
      return query select v_pair.t, v_pair.m, v_ten.pl, true, false, 0, 0, v_ten.bal, 'included_plan'::text, null::boolean, null::integer;
      continue;
    end if;
    -- An evaluation key issued before the cut-over keeps free reveals; followBlock (src/shadow/follows.ts) ends them
    -- with the key. Pay as you go is never grandfathered.
    if v_ten.pl = 'free' and v_ten.created < p_pricing_from then
      return query select v_pair.t, v_pair.m, v_ten.pl, true, false, 0, 0, v_ten.bal, 'grandfathered'::text, null::boolean, null::integer;
      continue;
    end if;
    v_id := 'reveal:' || v_pair.t::text || ':' || v_pair.m::text;
    -- A replay: this tenant's charge for this market already stands (any commit of it, any source). No money moves; a
    -- read records that the verdict reached the tenant in the answer (reveal_reads), so a webhook charge it replays is
    -- never refunded.
    select l.tenant_id into v_owner from credit_ledger l where l.reason = 'charge' and l.request_id = v_id;
    if found then
      if v_owner is distinct from v_pair.t then
        raise exception using errcode = 'RS003', message = 'charge_reveals: this request id was charged to another tenant';
      end if;
      if p_source = 'read' then
        insert into reveal_reads (request_id, tenant_id) values (v_id, v_pair.t) on conflict (request_id) do nothing;
      end if;
      return query select v_pair.t, v_pair.m, v_ten.pl, true, true, 0, 0, v_ten.bal, 'replay'::text, null::boolean, null::integer;
      continue;
    end if;
    -- What this tenant has paid for reveals of this event, net of refunds (an earlier pair of this call included).
    select coalesce(sum(-c.delta - coalesce(r.delta, 0)), 0)::integer into v_spent
      from markets mk
      join credit_ledger c on c.reason = 'charge' and c.request_id = 'reveal:' || v_pair.t::text || ':' || mk.id::text
      left join credit_ledger r on r.reason = 'refund' and r.request_id = c.request_id
     where mk.event_key = v_pair.ek;
    v_due := least(p_price, greatest(p_event_cap - v_spent, 0));
    if v_due = 0 then
      return query select v_pair.t, v_pair.m, v_ten.pl, true, false, 0, 0, v_ten.bal, 'event_cap_reached'::text, null::boolean, null::integer;
      continue;
    end if;
    -- A short balance: locked, nothing written. The next read or commit tries again.
    if v_ten.bal < v_due then
      return query select v_pair.t, v_pair.m, v_ten.pl, false, false, 0, v_due, v_ten.bal, 'insufficient_credits'::text, null::boolean, null::integer;
      continue;
    end if;
    update tenants t set credits_balance = t.credits_balance - v_due where t.id = v_pair.t
    returning t.credits_balance into v_balance;
    -- No handler: the id carries the tenant, whose row this call holds, so a unique_violation cannot be a concurrent
    -- duplicate; it fails the whole call with nothing written (the Worker locks the reveals as billing_unavailable).
    insert into credit_ledger (tenant_id, delta, reason, request_id, balance_after, note)
    values (v_pair.t, -v_due, 'charge', v_id, v_balance, 'reveal ' || p_source);
    -- credits.low once per crossing, claimed here so the Worker queues it with the event; a claim that fails (a
    -- malformed low_credit_threshold) never fails the charge: low_credit null, and the Worker alerts it.
    begin
      select c.crossed, c.threshold into v_low, v_threshold from claim_low_credit_notice(v_pair.t) c;
    exception when others then
      v_low := null; v_threshold := null;
    end;
    return query select v_pair.t, v_pair.m, v_ten.pl, true, false, v_due, v_due, v_balance, 'charged'::text, v_low, v_threshold;
  end loop;
end $$;
comment on function public.charge_reveals(uuid[], uuid[], integer, integer, timestamptz, text[], text) is
  'The private early reveal of a RESOLVED verdict, decided and charged for (tenant, market) pairs (p_tenants[i], p_markets[i], at most 1000) in one transaction: every tenant row locked first in id order; then per pair, in (tenant, event_key, market) order: a deleted or unknown tenant -> unknown_tenant (not entitled); a settled market (resolved, void, closed_unresolved: its commits are public) -> public (free); a plan in p_included_plans -> included_plan; plan free and tenants.created_at before p_pricing_from -> grandfathered; a credit_ledger charge with request id reveal:<tenant>:<market> -> replay (free, no money moves; from source read, one reveal_reads row, on conflict nothing, so refund_late_reveals() never refunds that charge; the same id charged to another tenant raises RS003); else the charge is least(p_price, p_event_cap minus what the tenant paid, net of refunds, for reveals of markets with the same event_key): 0 -> event_cap_reached (free), more than the balance -> insufficient_credits (not entitled, nothing written), else a debit of tenants.credits_balance and one credit_ledger row (reason charge, request id reveal:<tenant>:<market>, note ''reveal webhook'' or ''reveal read'' from p_source) -> charged, with the low-credit notice claimed (low_credit true at the crossing, null when the claim failed). Returns one row per pair: tenant_id, market_id, plan, entitled_full, replayed, charged, price (what the leg costs now; 0 when free), balance (after the call), reason, low_credit, low_credit_threshold. Raises 22023 on a bad price, cap, source or pair and on a market that is not a public shadow market. The Worker calls it only for a RESOLVED verdict (src/shadow/reveal.ts). service_role only.';
revoke all on function public.charge_reveals(uuid[], uuid[], integer, integer, timestamptz, text[], text) from public, anon, authenticated;
grant execute on function public.charge_reveals(uuid[], uuid[], integer, integer, timestamptz, text[], text) to service_role;

comment on table credit_ledger is
  'Append-only. 1 credit = $0.01. UNIQUE(reason, request_id) makes charge/refund idempotent per request; UNIQUE(tx_hash, log_index) makes purchases idempotent per on-chain transfer. Charge rows come from begin_resolution (request_id = the resolution id), charge_read (request_id "<kind>:<id>", note read: a served first print) and charge_reveals (request_id reveal:<tenant>:<market>, note ''reveal webhook'' when taken for a queued shadow.committed, which refund_late_reveals refunds when no delivery of it was attempted in time and the tenant did not read it, or ''reveal read'' when taken by a read, never refunded).';

-- 4. refund_late_reveals: the refund rule, every 5 minutes -----------------------------------------------------------------
create or replace function public.refund_late_reveals(p_late_minutes integer default 10)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_start   timestamptz := clock_timestamp();
  v_ids     text[];
  v_charge  record;
  v_amount  integer;
  v_n       integer := 0;
  v_credits integer := 0;
  v_failed  integer := 0;
  v_error   text;
  v_state   text;
  v_msg     text;
begin
  if p_late_minutes is null or p_late_minutes < 1 then
    raise exception using errcode = '22023', message = format('refund_late_reveals: p_late_minutes must be >= 1, got %s', p_late_minutes);
  end if;
  -- A charge is decided once its deadline has passed. Charges older than 3 days were decided by earlier runs; a cron
  -- that stopped for longer is alerted within 30 minutes (the Worker's dispatch check reads storage_status()).
  select coalesce(array_agg(c.request_id), '{}') into v_ids
    from credit_ledger c
   where c.reason = 'charge' and c.note = 'reveal webhook' and c.created_at > now() - interval '3 days'
     and not exists (select 1 from credit_ledger x where x.reason = 'refund' and x.request_id = c.request_id)
     and now() >= coalesce((select min(d.reveal_due_at) from webhook_deliveries d where d.reveal_charge_id = c.request_id),
                           c.created_at + make_interval(mins => p_late_minutes));
  -- Every tenant row of those charges first, in id order, as charge_reveals() locks them: refund_credits() updates each
  -- tenant row and this run is one transaction, so locking them one refund at a time (in charge order) could hold one
  -- tenant while a publish's charge_reveals() holds another, and deadlock.
  perform 1 from tenants t
   where t.id in (select c.tenant_id from credit_ledger c where c.reason = 'charge' and c.request_id = any(v_ids))
   order by t.id for update;
  -- Decided after the lock, in a statement of its own (a read or a delivery that committed while this run waited
  -- counts): owed only when Resolve did not put the verdict in front of the tenant in time. No delivery of it was
  -- attempted (first_attempt_at) or delivered by its reveal_due_at, and the tenant did not read it (reveal_reads). An
  -- attempt made in time stands whatever the endpoint answered: its body carried the verdict.
  for v_charge in
    select c.request_id
      from credit_ledger c
     where c.reason = 'charge' and c.request_id = any(v_ids)
       and not exists (select 1 from credit_ledger x where x.reason = 'refund' and x.request_id = c.request_id)
       and not exists (select 1 from webhook_deliveries d
                        where d.reveal_charge_id = c.request_id
                          and (d.first_attempt_at <= d.reveal_due_at or (d.status = 'delivered' and d.delivered_at <= d.reveal_due_at)))
       -- A delivery still in flight under a live lease may have POSTed already: deliver.ts writes first_attempt_at with
       -- the attempt's outcome, up to its 10 s timeout later. Such a charge is decided by the next run, never refunded now.
       and not exists (select 1 from webhook_deliveries d
                        where d.reveal_charge_id = c.request_id and d.status = 'delivering' and d.lease_until > now())
       and not exists (select 1 from reveal_reads rr where rr.request_id = c.request_id)
     order by c.tenant_id, c.created_at
  loop
    -- one refund at a time: a refund that fails is reported and the others still go through
    begin
      v_amount := refund_credits(v_charge.request_id);
      if v_amount > 0 then v_n := v_n + 1; v_credits := v_credits + v_amount; end if;
    exception when others then
      v_failed := v_failed + 1;
      v_error := left(format('%s: %s', v_charge.request_id, sqlerrm), 500);
    end;
  end loop;
  insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, error, meta)
  values ('reveal_refund', v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::integer,
          case when v_failed > 0 then 'failure' when v_n > 0 then 'success' else 'no_op' end, v_n, v_error,
          jsonb_build_object('refunded', v_n, 'credits', v_credits, 'failed', v_failed, 'late_minutes', p_late_minutes));
  return jsonb_build_object('refunded', v_n, 'credits', v_credits, 'failed', v_failed);
exception when others then
  -- Everything this run did is rolled back; the row below is what storage_status() reports and the Worker alerts on.
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  insert into loop_runs (loop_name, started_at, duration_ms, outcome, rows_written, error, meta)
  values ('reveal_refund', v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::integer, 'failure', 0,
          left(v_msg, 500), jsonb_build_object('sqlstate', v_state));
  return jsonb_build_object('error', left(v_msg, 500), 'sqlstate', v_state);
end $$;
comment on function public.refund_late_reveals(integer) is
  'The refund rule of the priced reveal (docs/pricing.md), run every 5 minutes by pg_cron (job refund_late_reveals): the credit_ledger charges with note ''reveal webhook'' from the last 3 days that are not refunded yet and whose deadline has passed (the reveal_due_at of their deliveries, committed_at + p_late_minutes; with no delivery at all, the charge time + p_late_minutes) have their tenant rows locked in id order (as charge_reveals() locks them: no deadlock with a publish); then each one is refunded through refund_credits() (once per request id) when, read after the lock, none of its deliveries (webhook_deliveries.reveal_charge_id) was attempted (first_attempt_at) or delivered at or before reveal_due_at and the tenant did not read the verdict (reveal_reads). An attempt made in time is never refunded, whatever the endpoint answered: the POST carried the verdict. A charge with note ''reveal read'' is never refunded. One loop_runs row per run (loop_name reveal_refund): success (rows_written = charges refunded), no_op, or failure with the error text (a refund that fails is reported and the others stand; an error outside them rolls the run back). Returns refunded, credits and failed as jsonb.';
revoke all on function public.refund_late_reveals(integer) from public, anon, authenticated;
grant execute on function public.refund_late_reveals(integer) to service_role;

-- 5. follow_event: every open public leg of an event, all or nothing ---------------------------------------------------------
create or replace function public.follow_event(p_tenant uuid, p_market uuid, p_cap integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_market  record;
  v_legs    uuid[];
  v_already integer;
  v_new     integer;
  v_active  integer;
begin
  if p_cap is not null and p_cap < 0 then
    raise exception 'follow_event: p_cap must be >= 0 or null (unlimited), got %', p_cap;
  end if;
  -- One follow at a time per tenant (follow_market() takes the same lock), so the cap holds for the whole event.
  perform 1 from tenants t where t.id = p_tenant and t.deleted_at is null for update;
  if not found then raise exception 'follow_event: no tenant %', p_tenant; end if;
  select m.tenant_id, m.is_test, m.status, m.deleted_at, m.event_key into v_market from markets m where m.id = p_market;
  if not found then
    return jsonb_build_object('result', 'not_followable', 'reason', 'not a public shadow market');
  end if;
  if v_market.deleted_at is not null or v_market.tenant_id is not null or v_market.is_test then
    return jsonb_build_object('result', 'not_followable', 'reason', 'not a public shadow market');
  end if;
  if v_market.status <> 'open' then
    return jsonb_build_object('result', 'not_followable', 'reason', 'market is ' || v_market.status);
  end if;
  -- The legs, read once: the count, the cap check and the insert all use this set.
  select coalesce(array_agg(m.id order by m.id), '{}') into v_legs
    from markets m
   where m.event_key = v_market.event_key and m.tenant_id is null and not m.is_test and m.deleted_at is null and m.status = 'open';
  select count(*)::integer into v_already
    from market_follows f where f.tenant_id = p_tenant and f.deleted_at is null and f.market_id = any(v_legs);
  -- what the cap counts: active follows of open markets (follow_market())
  select count(*)::integer into v_active
    from market_follows f join markets m on m.id = f.market_id
   where f.tenant_id = p_tenant and f.deleted_at is null and m.status = 'open' and m.deleted_at is null;
  v_new := cardinality(v_legs) - v_already;
  if p_cap is not null and v_new > 0 and v_active + v_new > p_cap then
    return jsonb_build_object('result', 'cap_reached', 'event_key', v_market.event_key, 'legs', cardinality(v_legs),
                              'already_following', v_already, 'active', v_active, 'cap', p_cap);
  end if;
  insert into market_follows (tenant_id, market_id)
  select p_tenant, l.id from unnest(v_legs) as l(id)
   where not exists (select 1 from market_follows f where f.tenant_id = p_tenant and f.market_id = l.id and f.deleted_at is null);
  get diagnostics v_new = row_count;
  return jsonb_build_object('result', 'followed', 'event_key', v_market.event_key, 'legs', cardinality(v_legs),
                            'followed', v_new, 'already_following', v_already, 'active', v_active + v_new);
end $$;
comment on function public.follow_event(uuid, uuid, integer) is
  'Follow every leg of p_market''s event in one transaction: lock the tenant row (as follow_market()), refuse a market that is not an open, non-test shadow market ({result: not_followable, reason}), then take every open, non-test, undeleted public market with the same event_key (the market itself among them): when the legs not yet followed do not fit under p_cap with the tenant''s active follows of open markets, nothing is written ({result: cap_reached, event_key, legs, already_following, active, cap}); else each is followed once ({result: followed, event_key, legs, followed, already_following, active}); legs already followed are left as they are. p_cap null = unlimited. The Worker derives p_cap from tenants.plan (src/shadow/follows.ts followCap). service_role only.';
revoke all on function public.follow_event(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.follow_event(uuid, uuid, integer) to service_role;

-- 6. storage_status: also the newest refund run and its cron job ---------------------------------------------------------
create or replace function public.storage_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_at timestamptz; v_outcome text; v_error text; v_scheduled boolean;
        v_refund_at timestamptz; v_refund_outcome text; v_refund_error text; v_refund_scheduled boolean;
begin
  select r.started_at, r.outcome, r.error into v_at, v_outcome, v_error
    from public.loop_runs r where r.loop_name = 'retention_purge' order by r.started_at desc limit 1;
  select r.started_at, r.outcome, r.error into v_refund_at, v_refund_outcome, v_refund_error
    from public.loop_runs r where r.loop_name = 'reveal_refund' order by r.started_at desc limit 1;
  -- where pg_cron exists (Supabase): are the jobs there and active; null on a cluster without it
  if exists (select 1 from pg_catalog.pg_extension x where x.extname = 'pg_cron') then
    execute 'select exists (select 1 from cron.job j where j.jobname = ''purge_retention'' and j.active)' into v_scheduled;
    execute 'select exists (select 1 from cron.job j where j.jobname = ''refund_late_reveals'' and j.active)' into v_refund_scheduled;
  end if;
  return pg_catalog.jsonb_build_object(
    'database_bytes', pg_catalog.pg_database_size(pg_catalog.current_database()),
    'purge_scheduled', v_scheduled,
    'last_purge', case when v_at is null then null
                       else pg_catalog.jsonb_build_object('started_at', v_at, 'outcome', v_outcome, 'error', v_error) end,
    'refund_scheduled', v_refund_scheduled,
    'last_refund', case when v_refund_at is null then null
                        else pg_catalog.jsonb_build_object('started_at', v_refund_at, 'outcome', v_refund_outcome, 'error', v_refund_error) end);
end $$;
comment on function public.storage_status() is
  'What the Worker''s 10-minute dispatch check (src/jobs/dispatch.ts) alerts on, since the database cannot DM the operator: database_bytes (pg_database_size() of this database; alerts past 300 MB and again past 400 MB of the Supabase Free plan''s 500 MB, DB_SIZE_ALERT_MB, 1 MB = 1,048,576 bytes as pg_size_pretty prints), last_purge (started_at, outcome, error of the newest retention_purge loop_runs row, null before the first run; alerts when it failed or is more than a day old), purge_scheduled (the purge_retention cron job exists and is active; null where pg_cron is not installed), and since migration 023 last_refund and refund_scheduled, the same for refund_late_reveals (loop_name reveal_refund, every 5 minutes; alerts when it failed or is more than 30 minutes old). Reads only. service_role only.';
revoke all on function public.storage_status() from public, anon, authenticated;
grant execute on function public.storage_status() to service_role;

-- 7. schedule: the refund rule every 5 minutes, where pg_cron exists (a local cluster without it keeps the function) -------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'refund_late_reveals';
    perform cron.schedule('refund_late_reveals', '*/5 * * * *', 'select public.refund_late_reveals(10)');
  else
    raise notice '023: pg_cron is not installed; refund_late_reveals is not scheduled';
  end if;
end $$;

commit;

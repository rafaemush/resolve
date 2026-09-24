-- 014_gtm_follows: the GTM log with the no-cold-pitch gate, and follows of shadow markets (plan §19.2 item 5, §17.3
-- P7-lite, §16.4 P7).
-- WHY: the first thing a buyer pays for is a private early reveal: a tenant follows a public shadow market and receives
-- the committed verdict (shadow.committed webhook, GET /v1/shadow/:market_id) the moment the commitment exists, long
-- before the public reveal. market_follows records who follows what. leads and gtm_touches are the sales log every
-- dated gate is read from (plan §17.7: "never from a chat message"); the founder rule "no cold pitch" is enforced by the
-- database, not by memory: an outbound pitch to a lead is refused until a reconciled row exists on the lead's platform,
-- unless the touch carries an override reason (which is then on the record).
-- No touch is backfilled: the send status of the 2026-09-22 TypeSafe request is unverified (plan §17.8).
--
-- Compatibility with the Worker deployed before this migration (it keeps running until the new one is deployed):
--   * Additive only: three new tables and three new functions. The old Worker never reads or writes them, and no
--     existing table, view, constraint or function is changed.
begin;

-- 1. leads ------------------------------------------------------------------------------------------------------------
create table if not exists leads (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(btrim(name)) > 0),
  org               text,
  platform          text check (platform is null or platform = lower(btrim(platform))),
  channel           text,
  contact           text,
  fit_rank          integer check (fit_rank is null or fit_rank >= 1),
  shadow_started_at timestamptz,
  status            text not null default 'prospect'
                    check (status in ('prospect', 'contacted', 'replied', 'trial', 'pilot', 'customer', 'lost', 'paused')),
  notes             text,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
comment on table leads is
  'Prospective buyers (plan §17.2 ranking). One row per person or team the founder may contact; every contact with them is a gtm_touches row. Soft delete only. Service role only (RLS).';
comment on column leads.id is 'Lead id; gtm_touches.lead_id references it.';
comment on column leads.name is 'Person or team name as the founder addresses them. Not empty.';
comment on column leads.org is 'Organization (venue, analytics shop, bot operator), free text.';
comment on column leads.platform is
  'The markets.platform whose reconciled rows are this lead''s evidence (polymarket | limitless | custom). The no-cold-pitch gate (gtm_touch_gate) compares it with markets.platform exactly (stored lower-case, so ''Polymarket'' cannot silently miss); a lead with no platform, or a platform Resolve does not shadow, has no evidence, so every outbound pitch to it needs an override reason.';
comment on column leads.channel is 'Where the lead is reached (telegram, email, x, discord, form...), free text.';
comment on column leads.contact is 'Handle, address or form URL for the channel. Personal data: never exported to the public record.';
comment on column leads.fit_rank is 'Priority rank, 1 = best fit (plan §17.2 order); null when unranked.';
comment on column leads.shadow_started_at is 'When shadowing of this lead''s platform or markets started: the first evidence-led pitch waits for enough reconciled rows after it (plan §17.4).';
comment on column leads.status is 'prospect -> contacted -> replied -> trial (test key issued) -> pilot -> customer; lost and paused end or suspend the sequence. Set by hand; the touch log is the history.';
comment on column leads.notes is 'Free-text notes. Never the source of a gate: gates read gtm_touches, reconciliations and v_track_record.';
comment on column leads.created_at is 'Row insert time.';
comment on column leads.deleted_at is 'Soft delete. A deleted lead accepts no new touch (gtm_touch_gate).';
create index if not exists idx_leads_platform on leads (platform) where deleted_at is null;
comment on index idx_leads_platform is 'Leads per platform (the gate''s evidence scope).';
select apply_rls('leads');

-- 2. gtm_touches ------------------------------------------------------------------------------------------------------
create table if not exists gtm_touches (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid not null references leads(id),
  kind            text not null check (kind in ('dm', 'email', 'call', 'reply', 'ops')),
  direction       text not null check (direction in ('out', 'in')),
  summary         text not null check (length(btrim(summary)) > 0),
  evidence_url    text,
  override_reason text check (override_reason is null or length(btrim(override_reason)) > 0),
  touched_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
comment on table gtm_touches is
  'Append-only log of every sales and vendor contact (plan §17.4: "every touch in gtm_touches"). Written through log_touch(); an outbound pitch (direction out, kind dm | email | call) is refused by the gtm_touch_gate trigger until a reconciled row exists on the lead''s platform, unless override_reason says why. UPDATE and DELETE are refused for every role: a wrong row is corrected by a later ops touch. Service role only (RLS).';
comment on column gtm_touches.id is 'Touch id; log_touch() returns it.';
comment on column gtm_touches.lead_id is 'The lead contacted (or who contacted us).';
comment on column gtm_touches.kind is 'dm | email | call = a pitch when outbound; reply = our answer to a message the lead sent first (never gated); ops = not a sale (vendor requests such as the TypeSafe follow-ups, paperwork, a permission request).';
comment on column gtm_touches.direction is 'out = we contacted them; in = they contacted us or replied.';
comment on column gtm_touches.summary is 'What was said or asked, including the dated ask. Not empty.';
comment on column gtm_touches.evidence_url is 'Link to the message, thread, calendar entry or the reconciliation report the touch attached, when one exists.';
comment on column gtm_touches.override_reason is 'Why an outbound pitch was sent without a reconciled row on the lead''s platform. Null otherwise; blank is refused (a reason nobody wrote is not a reason).';
comment on column gtm_touches.touched_at is 'When the touch happened (defaults to the insert time).';
comment on column gtm_touches.created_at is 'Row insert time.';
create index if not exists idx_gtm_touches_lead on gtm_touches (lead_id, touched_at desc);
comment on index idx_gtm_touches_lead is 'A lead''s touch history, newest first.';

create or replace function public.gtm_touch_gate() returns trigger language plpgsql set search_path = public as $$
declare
  v_platform text;
  v_deleted  timestamptz;
begin
  select platform, deleted_at into v_platform, v_deleted from leads where id = new.lead_id;
  if not found then
    raise exception using errcode = '23503', message = format('gtm_touches: no lead %s', new.lead_id);
  end if;
  if v_deleted is not null then
    raise exception using errcode = 'RS002', message = format('lead %s is deleted: no new touch', new.lead_id);
  end if;
  -- An outbound pitch needs evidence: a settled reconciliation (the view's n_reconciled states; pending and
  -- unresolved_by_platform are not evidence of anything) on a public, non-test shadow market of the lead's platform.
  if new.direction = 'out' and new.kind in ('dm', 'email', 'call') and new.override_reason is null
     and not exists (
       select 1 from reconciliations rc join markets m on m.id = rc.market_id
        where m.platform = v_platform and m.tenant_id is null and not m.is_test
          and rc.agreement in ('agree', 'disagree', 'abstained', 'void')) then
    raise exception using errcode = 'RS002',
      message = format('no-cold-pitch gate: no reconciled row on platform %s for lead %s; an outbound %s needs one, or an override_reason',
                       coalesce(v_platform, '(none)'), new.lead_id, new.kind);
  end if;
  return new;
end $$;
comment on function public.gtm_touch_gate() is
  'BEFORE INSERT on gtm_touches: refuses (SQLSTATE RS002) a touch on a deleted lead, and an outbound pitch (direction out, kind dm | email | call) without override_reason when no reconciliations row with agreement agree | disagree | abstained | void exists for a non-test shadow market (tenant_id null) whose platform equals the lead''s platform. A trigger, not only the RPC, so a direct insert cannot skip the gate.';
drop trigger if exists gtm_touches_gate on gtm_touches;
create trigger gtm_touches_gate before insert on gtm_touches for each row execute function gtm_touch_gate();
comment on trigger gtm_touches_gate on gtm_touches is 'The no-cold-pitch gate (gtm_touch_gate).';
drop trigger if exists gtm_touches_append_only on gtm_touches;
create trigger gtm_touches_append_only before update or delete on gtm_touches for each row execute function deny_mutation();
comment on trigger gtm_touches_append_only on gtm_touches is 'The touch log is append-only for every role (deny_mutation).';
select apply_rls('gtm_touches');

create or replace function public.log_touch(
  p_lead uuid, p_kind text, p_direction text, p_summary text, p_evidence_url text default null, p_override_reason text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  -- Blank strings are absent values: a blank override must not read as a reason, and the gate trigger sees NULL.
  insert into gtm_touches (lead_id, kind, direction, summary, evidence_url, override_reason)
  values (p_lead, p_kind, p_direction, p_summary, nullif(btrim(p_evidence_url), ''), nullif(btrim(p_override_reason), ''))
  returning id into v_id;
  return v_id;
end $$;
comment on function public.log_touch(uuid, text, text, text, text, text) is
  'Record one touch and return its id. Refuses (SQLSTATE RS002, from the gtm_touches_gate trigger) an outbound pitch (direction out, kind dm | email | call) while no reconciled row (agree | disagree | abstained | void) exists for a non-test shadow market on the lead''s platform, unless p_override_reason is non-blank; refuses a touch on a deleted lead. Blank evidence_url / override_reason are stored as NULL. service_role only.';

-- 3. market_follows ---------------------------------------------------------------------------------------------------
create table if not exists market_follows (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  market_id  uuid not null references markets(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table market_follows is
  'A tenant following a public shadow market (tenant_id null, not a test market): it receives the private early reveal (shadow.committed webhook and GET /v1/shadow/:market_id) and the shadow.revealed event. Created through follow_market() (per-tenant cap, one active row per tenant and market); unfollow is a soft delete. Service role only (RLS).';
comment on column market_follows.id is 'Follow id.';
comment on column market_follows.tenant_id is 'The following tenant.';
comment on column market_follows.market_id is 'The followed shadow market.';
comment on column market_follows.created_at is 'When the follow started. Commits recorded before it are still readable through GET /v1/shadow/:market_id.';
comment on column market_follows.deleted_at is 'Soft delete (DELETE /v1/markets/:id/follow). A tenant can follow the market again, which creates a new row.';
create unique index if not exists uq_market_follows_active on market_follows (tenant_id, market_id) where deleted_at is null;
comment on index uq_market_follows_active is 'At most one active follow per tenant and market (follow is idempotent).';
create index if not exists idx_market_follows_market on market_follows (market_id) where deleted_at is null;
comment on index idx_market_follows_market is 'Followers of a market: the shadow.committed / shadow.revealed fan-out.';
select apply_rls('market_follows');

create or replace function public.follow_market(p_tenant uuid, p_market uuid, p_cap integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_market record;
  v_id     uuid;
  v_active integer;
begin
  if p_cap is not null and p_cap < 0 then
    raise exception 'follow_market: p_cap must be >= 0 or null (unlimited), got %', p_cap;
  end if;
  -- One follow at a time per tenant: without the row lock two concurrent follows could both pass the cap count.
  perform 1 from tenants where id = p_tenant and deleted_at is null for update;
  if not found then raise exception 'follow_market: no tenant %', p_tenant; end if;
  select tenant_id, is_test, status, deleted_at into v_market from markets where id = p_market;
  if not found then
    return jsonb_build_object('result', 'not_followable', 'reason', 'not a public shadow market');
  end if;
  if v_market.deleted_at is not null or v_market.tenant_id is not null or v_market.is_test then
    return jsonb_build_object('result', 'not_followable', 'reason', 'not a public shadow market');
  end if;
  if v_market.status <> 'open' then
    return jsonb_build_object('result', 'not_followable', 'reason', 'market is ' || v_market.status);
  end if;
  select count(*)::integer into v_active from market_follows where tenant_id = p_tenant and deleted_at is null;
  select id into v_id from market_follows where tenant_id = p_tenant and market_id = p_market and deleted_at is null;
  if v_id is not null then
    return jsonb_build_object('result', 'already_following', 'follow_id', v_id, 'active', v_active);
  end if;
  if p_cap is not null and v_active >= p_cap then
    return jsonb_build_object('result', 'cap_reached', 'active', v_active, 'cap', p_cap);
  end if;
  insert into market_follows (tenant_id, market_id) values (p_tenant, p_market) returning id into v_id;
  return jsonb_build_object('result', 'followed', 'follow_id', v_id, 'active', v_active + 1);
end $$;
comment on function public.follow_market(uuid, uuid, integer) is
  'Follow a public shadow market in one transaction: lock the tenant row (concurrent follows serialize, so the cap holds), refuse a market that is not an open, non-test shadow market ({result: not_followable, reason}), answer an existing active follow ({result: already_following, follow_id, active}), refuse past p_cap active follows ({result: cap_reached, active, cap}; p_cap null = unlimited), else insert ({result: followed, follow_id, active}). The Worker derives p_cap from tenants.plan (src/shadow/follows.ts followCap). service_role only.';

-- 4. least privilege (Supabase default privileges grant anon/authenticated directly; migration 010) ------------------
revoke all on table leads, gtm_touches, market_follows from public, anon, authenticated;
grant select, insert, update, delete on table leads, gtm_touches, market_follows to service_role;
revoke all on function public.gtm_touch_gate() from public, anon, authenticated;
grant execute on function public.gtm_touch_gate() to service_role;
revoke all on function public.log_touch(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.log_touch(uuid, text, text, text, text, text) to service_role;
revoke all on function public.follow_market(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.follow_market(uuid, uuid, integer) to service_role;

commit;

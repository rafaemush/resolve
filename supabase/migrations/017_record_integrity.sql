-- 017_record_integrity: the public record counted by distinct event, commit dedup against the latest commit, a paced
-- channel poster, and least privilege on every relation (plan §16.4 P2, §17.3 "n >= 100 counted by distinct event, not
-- ladder leg", §19.1 "fixes that keep the public record clean never wait").
-- WHY:
--   * A multi-outcome ladder (24 CPI buckets, a Polymarket event's legs, a Limitless group) is one event whose legs are
--     separate markets that resolve from the same fact: counting legs lets one release make "n_reconciled >= 100" and
--     correlates their errors. markets.event_key names the event; v_track_record counts distinct events and the
--     reportable gate is 100 reconciled events per platform.
--   * The Worker deduped commits on (market, verdict signature), so a verdict that returned to an earlier signature
--     (A -> B -> A) was never committed again and the market's final commit stood for a retracted verdict. It now
--     dedupes against the market's latest commit only (commit_context, dedup_key commit:<market>:after:<latest id>).
--   * Each leg of a ladder commits in its own watch invocation, so a CPI release produced ~24 posts in one minute
--     against Telegram's ~20 messages per minute per channel. Legs of an event are now posted as one message by a poster
--     that holds the channel lease (post_leases) and never exceeds 15 commit/reveal messages per rolling 60 s.
--   * MEASURED 2026-09-24: production still grants table-level privileges on the tables and sequences of 001-009 to
--     anon (010 fixed routines, views and default privileges only); only the RLS deny policies stood in the way.
-- Compatibility with the Worker deployed at 8d67d16 (it keeps running until every migration is applied):
--   * markets.event_key is filled by a BEFORE INSERT trigger when the insert omits it (the old Worker never names it),
--     so NOT NULL never refuses an old insert; the old Worker never updates it.
--   * v_track_record keeps every existing column, name, type and position (create or replace view); the new columns
--     are appended. `reportable` now means 100 reconciled distinct events, which is never looser than 100 markets.
--   * commit_context, claim_post_lease, release_post_lease, note_post_failure, market_event_key and post_leases are new;
--     the old Worker never calls or reads them. Revoking from anon/authenticated removes nothing the Worker uses
--     (it authenticates as service_role).
-- Idempotent: every statement is create-or-replace, if-not-exists or drop-if-exists, and the backfill only fills NULLs.
begin;

-- 1. markets.event_key ------------------------------------------------------------------------------------------------
alter table markets add column if not exists event_key text;
comment on column markets.event_key is
  'The event this market is one leg of (plan §17.3: the public n counts distinct events, not ladder legs). official_release legs: official:<series>:<period>; Polymarket: polymarket:event:<meta.event_id>; Limitless: limitless:group:<meta.group_id>; otherwise <platform>:<external_id>. Set at registration (src/markets/event-key.ts, the same rule as market_event_key()), filled by trigger markets_event_key_fill when an insert omits it, fixed once the market has a commit (markets_event_key_locked).';

create or replace function public.market_event_key(p_platform text, p_external_id text, p_resolver jsonb, p_meta jsonb)
returns text language sql immutable set search_path = public as $$
  select case
    when p_resolver ->> 'kind' = 'official_release'
         and nullif(btrim(p_resolver ->> 'series', E' \t\r\n'), '') is not null
         and nullif(btrim(p_resolver ->> 'period', E' \t\r\n'), '') is not null
      then 'official:' || btrim(p_resolver ->> 'series', E' \t\r\n') || ':' || btrim(p_resolver ->> 'period', E' \t\r\n')
    when p_platform = 'polymarket' and nullif(btrim(p_meta ->> 'event_id', E' \t\r\n'), '') is not null
      then 'polymarket:event:' || btrim(p_meta ->> 'event_id', E' \t\r\n')
    when p_platform = 'limitless' and nullif(btrim(p_meta ->> 'group_id', E' \t\r\n'), '') is not null
      then 'limitless:group:' || btrim(p_meta ->> 'group_id', E' \t\r\n')
    else p_platform || ':' || p_external_id
  end
$$;
comment on function public.market_event_key(text, text, jsonb, jsonb) is
  'The event key rule of markets.event_key, in the order the Worker applies it (src/markets/event-key.ts eventKey(), same cases in tests/event-key.test.ts and scripts/selftest/fixes.ts): an official_release resolver -> official:<series>:<period>; polymarket with meta.event_id -> polymarket:event:<id>; limitless with meta.group_id -> limitless:group:<id>; else <platform>:<external_id>.';

-- Existing rows: the same rule. Rows registered before importer meta and official_release existed (every production
-- row at 8d67d16) get <platform>:<external_id>, one event per market.
update markets set event_key = market_event_key(platform, external_id, resolver, meta) where event_key is null;

create or replace function public.fill_market_event_key() returns trigger language plpgsql set search_path = public as $$
begin
  if new.event_key is null or btrim(new.event_key) = '' then
    new.event_key := market_event_key(new.platform, new.external_id, new.resolver, new.meta);
  end if;
  return new;
end $$;
comment on function public.fill_market_event_key() is
  'BEFORE INSERT on markets: an insert that names no event_key (the Worker deployed before 017, scripts) gets market_event_key() of the row, so the NOT NULL column never refuses it.';
drop trigger if exists markets_event_key_fill on markets;
create trigger markets_event_key_fill before insert on markets for each row execute function fill_market_event_key();
comment on trigger markets_event_key_fill on markets is 'Fills markets.event_key when an insert omits it (fill_market_event_key).';

alter table markets alter column event_key set not null;
alter table markets drop constraint if exists markets_event_key_check;
alter table markets add constraint markets_event_key_check check (length(btrim(event_key)) > 0);

create or replace function public.deny_event_key_change() returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from bot_posts where market_id = old.id and kind = 'commit') then
    raise exception 'markets.event_key is fixed once the market has a commit (market %)', old.id;
  end if;
  return new;
end $$;
comment on function public.deny_event_key_change() is
  'BEFORE UPDATE OF event_key on markets: refuses a change once any commit row exists for the market, so the distinct-event counts of v_track_record and the public floor can never be regrouped after a public call.';
drop trigger if exists markets_event_key_locked on markets;
create trigger markets_event_key_locked before update of event_key on markets for each row
  when (old.event_key is distinct from new.event_key) execute function deny_event_key_change();
comment on trigger markets_event_key_locked on markets is 'event_key is fixed once a commit exists (deny_event_key_change).';

create index if not exists idx_markets_event_key_open on markets (event_key) where status = 'open' and deleted_at is null;
comment on index idx_markets_event_key_open is 'Open legs of an event: commit_context() decides whether a commit is posted inline or batched with its event.';

-- 2. commit_context(): what one commit needs, in one request -----------------------------------------------------------
create or replace function public.commit_context(p_market uuid)
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'market_id', m.id,
    'event_key', m.event_key,
    'latest', (select jsonb_build_object('id', b.id, 'verdict_signature', b.payload ->> 'verdict_signature', 'created_at', b.created_at)
                 from bot_posts b
                where b.market_id = m.id and b.kind = 'commit'
                order by b.created_at desc, b.id desc
                limit 1),
    'event_open_markets', (select count(*)::integer from markets o
                            where o.event_key = m.event_key and o.id <> m.id and o.status = 'open' and o.deleted_at is null
                              and not o.is_test and o.tenant_id is null),
    'public_commit_events', (select count(distinct x.event_key)::integer
                               from bot_posts b join markets x on x.id = b.market_id
                              where b.kind = 'commit' and not x.is_test and x.tenant_id is null))
    from markets m
   where m.id = p_market;
$$;
comment on function public.commit_context(uuid) is
  'One read for src/bot/commit.ts commitVerdict(): the market''s event_key; its latest commit {id, verdict_signature, created_at} (created_at desc, id desc: the order settle_market makes the final commit), which a new commit is deduped against (dedup_key commit:<market>:after:<latest id | none>); event_open_markets = other open, non-deleted, non-test shadow markets of the same event (> 0: the commit waits for the channel poster, which posts the event''s legs as one message); public_commit_events = distinct events with a commit on a non-test shadow market (the 0.90 public floor holds for the first 100). NULL when the market does not exist. service_role only.';

-- 3. the channel poster: one lease, pacing, failure bookkeeping ---------------------------------------------------------
create table if not exists post_leases (
  channel     text primary key check (length(channel) between 1 and 100),
  holder      text not null check (length(holder) between 1 and 100),
  lease_until timestamptz not null,
  updated_at  timestamptz not null default now()
);
comment on table post_leases is
  'One row per public channel: which Worker invocation may post to it until lease_until. Everything that posts commits or reveals (the inline commit post, the every-minute poster, the reconcile retry) holds it, so two crons never post the same pending rows twice and the pacing count cannot be raced. Written only by claim_post_lease / release_post_lease.';
comment on column post_leases.channel is 'Channel name (src/bot/post.ts CHANNEL: the public commit-reveal channel).';
comment on column post_leases.holder is 'Random id of the invocation holding the lease.';
comment on column post_leases.lease_until is 'The holder may start posts until this time; a claim after it succeeds. Released early by release_post_lease.';
comment on column post_leases.updated_at is 'Time of the last claim or release.';
select apply_rls('post_leases');
revoke all on post_leases from public, anon, authenticated;
grant select, insert, update on post_leases to service_role;

create or replace function public.claim_post_lease(p_channel text, p_holder text, p_seconds integer, p_max_messages integer, p_window_seconds integer)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_commits  integer;
  v_reveals  integer;
  v_messages integer;
  v_until    timestamptz;
begin
  if p_seconds is null or p_seconds < 1 or p_seconds > 600 then
    raise exception 'claim_post_lease: p_seconds must be between 1 and 600, got %', p_seconds;
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 3600 or p_max_messages is null or p_max_messages < 1 then
    raise exception 'claim_post_lease: p_window_seconds must be between 1 and 3600 and p_max_messages >= 1';
  end if;
  select count(*) filter (where kind = 'commit')::integer, count(*) filter (where kind = 'reveal')::integer
    into v_commits, v_reveals
    from bot_posts where channel = 'pending' and kind in ('commit', 'reveal');
  if v_commits + v_reveals = 0 then
    return jsonb_build_object('claimed', false, 'reason', 'idle', 'pending_commits', 0, 'pending_reveals', 0);
  end if;
  -- Several legs posted as one message share its message_id: pacing counts messages, not rows.
  select count(distinct message_id)::integer into v_messages
    from bot_posts
   where channel = 'telegram' and kind in ('commit', 'reveal') and message_id is not null
     and posted_at >= now() - make_interval(secs => p_window_seconds);
  if v_messages >= p_max_messages then
    return jsonb_build_object('claimed', false, 'reason', 'paced', 'messages_in_window', v_messages, 'pending_commits', v_commits, 'pending_reveals', v_reveals);
  end if;
  insert into post_leases as l (channel, holder, lease_until) values (p_channel, p_holder, now() + make_interval(secs => p_seconds))
  on conflict (channel) do update set holder = excluded.holder, lease_until = excluded.lease_until, updated_at = now()
   where l.lease_until <= now() or l.holder = excluded.holder
  returning l.lease_until into v_until;
  if v_until is null then
    return jsonb_build_object('claimed', false, 'reason', 'busy', 'messages_in_window', v_messages, 'pending_commits', v_commits, 'pending_reveals', v_reveals);
  end if;
  return jsonb_build_object('claimed', true, 'lease_until', v_until, 'now', now(), 'messages_in_window', v_messages,
                            'pending_commits', v_commits, 'pending_reveals', v_reveals);
end $$;
comment on function public.claim_post_lease(text, text, integer, integer, integer) is
  'Take the channel lease for p_seconds (1..600) when there is something to post and the channel has room: {claimed false, reason idle} when no commit or reveal is pending (no lease taken); {claimed false, reason paced} when p_max_messages distinct messages (commit or reveal rows posted to telegram, grouped by message_id) were posted in the last p_window_seconds; {claimed false, reason busy} while another holder''s lease is live; else {claimed true, lease_until, now, messages_in_window, pending_commits, pending_reveals}. The same holder may renew. service_role only.';

create or replace function public.release_post_lease(p_channel text, p_holder text)
returns boolean language sql security invoker set search_path = public as $$
  with r as (
    update post_leases set lease_until = now(), updated_at = now()
     where channel = p_channel and holder = p_holder and lease_until > now()
    returning 1)
  select exists (select 1 from r);
$$;
comment on function public.release_post_lease(text, text) is
  'End the lease early when p_holder still holds it (true), so the next poster need not wait for lease_until; false when it had expired or another holder took it. service_role only.';

create or replace function public.note_post_failure(p_ids uuid[], p_error text)
returns integer language sql security invoker set search_path = public as $$
  with u as (
    update bot_posts
       set payload = payload || jsonb_build_object(
             'post_error', left(coalesce(p_error, 'unknown'), 300),
             'post_attempts', case when jsonb_typeof(payload -> 'post_attempts') = 'number' then (payload ->> 'post_attempts')::numeric::integer else 0 end + 1)
     where id = any (p_ids) and channel = 'pending'
    returning 1)
  select count(*)::integer from u;
$$;
comment on function public.note_post_failure(uuid[], text) is
  'A failed post of one message that carried several pending rows (the legs of an event, or several reveals): payload.post_error = p_error (at most 300 characters, redacted by the caller) and payload.post_attempts + 1 on each row still pending, in one request. Only these two payload keys change, which bot_posts_commit_immutable allows on a pending commit. Returns the rows updated. service_role only.';

create index if not exists idx_bot_posts_posted_recent on bot_posts (posted_at) where channel = 'telegram';
comment on index idx_bot_posts_posted_recent is 'Pacing: messages posted to the channel in the last 60 s (claim_post_lease).';

-- 4. v_track_record: distinct events appended; the reportable gate is 100 reconciled events ----------------------------
-- create or replace keeps every existing column in place (name, type, position); new columns are appended.
create or replace view public.v_track_record with (security_invoker = true) as
with live as (
  select id, platform, event_key from markets where not is_test and tenant_id is null),
shadow as (
  select r.market_id, l.platform, date_trunc('week', r.created_at) as week, r.determination_basis, r.duration_ms
    from resolutions r join live l on l.id = r.market_id
   where r.mode = 'shadow' and r.status_row = 'complete'),
first_shadow as (
  select market_id, platform, min(week) as week from shadow group by market_id, platform),
commits as (
  select b.market_id, l.platform, l.event_key, date_trunc('week', b.created_at) as week
    from bot_posts b join live l on l.id = b.market_id
   where b.kind = 'commit'),
finals as (
  select rc.market_id, l.platform, l.event_key, date_trunc('week', rc.reconciled_at) as week, rc.agreement, rc.lead_seconds, rc.official_at_source
    from reconciliations rc join live l on l.id = rc.market_id
   where rc.final),
weeks as (
  select platform, week from shadow union select platform, week from commits union select platform, week from finals),
s as (
  select platform, week, count(distinct market_id) as n_markets_shadowed,
         percentile_cont(0.95) within group (order by duration_ms) as p95_query_ms,
         count(*) filter (where determination_basis = 'jev')::numeric / nullif(count(*), 0) as jev_share
    from shadow group by platform, week),
fs as (
  select platform, week, count(*) as n_markets_first_shadowed from first_shadow group by platform, week),
c as (
  select platform, week, count(distinct market_id) as n_committed, count(distinct event_key) as n_events_committed
    from commits group by platform, week),
f as (
  select platform, week,
         count(*) filter (where agreement in ('agree', 'disagree', 'abstained', 'void')) as n_reconciled,
         count(*) filter (where agreement = 'agree') as resolved_correct,
         count(*) filter (where agreement = 'disagree') as resolved_wrong,
         count(*) filter (where agreement = 'abstained') as abstained,
         count(*) filter (where agreement = 'void') as voided,
         count(*) filter (where agreement = 'unresolved_by_platform') as unresolved_by_platform,
         -- a platform timestamp only; a poll-observed official time is late by up to the poll delay, so it only bounds
         -- the lead from above and is reported apart (median_lead_seconds_poll)
         percentile_cont(0.5) within group (order by lead_seconds)
           filter (where agreement in ('agree', 'disagree') and official_at_source = 'gamma_closed_time') as median_lead_seconds,
         percentile_cont(0.5) within group (order by lead_seconds)
           filter (where agreement in ('agree', 'disagree') and official_at_source in ('limitless_api_poll', 'first_observed_poll')) as median_lead_seconds_poll
    from finals group by platform, week),
-- One row per event and platform: the week its first leg was reconciled, the week its first leg was decided (a final
-- RESOLVED leg: agree or disagree) and the week its first leg disagreed. An event is false from that week on; it is
-- correct while it has a decided leg and no disagreeing one.
ev as (
  select platform, event_key,
         min(week) filter (where agreement in ('agree', 'disagree', 'abstained', 'void')) as reconciled_week,
         min(week) filter (where agreement in ('agree', 'disagree')) as decided_week,
         min(week) filter (where agreement = 'disagree') as false_week
    from finals group by platform, event_key),
evw as (
  select w.platform, w.week,
         count(*) filter (where e.reconciled_week = w.week) as n_events_reconciled,
         count(*) filter (where e.false_week = w.week) as events_false_resolved,
         count(*) filter (where e.reconciled_week <= w.week) as n_events_reconciled_cumulative,
         count(*) filter (where e.decided_week <= w.week) as n_events_decided_cumulative,
         count(*) filter (where e.false_week <= w.week) as events_false_resolved_cumulative
    from weeks w join ev e on e.platform = w.platform
   group by w.platform, w.week),
wk as (
  select w.platform, w.week,
         coalesce(s.n_markets_shadowed, 0) as n_markets_shadowed, coalesce(fs.n_markets_first_shadowed, 0) as n_markets_first_shadowed,
         coalesce(c.n_committed, 0) as n_committed,
         coalesce(f.n_reconciled, 0) as n_reconciled, coalesce(f.resolved_correct, 0) as resolved_correct,
         coalesce(f.resolved_wrong, 0) as resolved_wrong, coalesce(f.abstained, 0) as abstained,
         coalesce(f.voided, 0) as voided, coalesce(f.unresolved_by_platform, 0) as unresolved_by_platform,
         f.median_lead_seconds, f.median_lead_seconds_poll, s.p95_query_ms, s.jev_share,
         coalesce(c.n_events_committed, 0) as n_events_committed,
         coalesce(evw.n_events_reconciled, 0) as n_events_reconciled,
         coalesce(evw.events_false_resolved, 0) as events_false_resolved,
         coalesce(evw.n_events_reconciled_cumulative, 0) as n_events_reconciled_cumulative,
         coalesce(evw.n_events_decided_cumulative, 0) as n_events_decided_cumulative,
         coalesce(evw.events_false_resolved_cumulative, 0) as events_false_resolved_cumulative
    from weeks w
    left join s on s.platform = w.platform and s.week = w.week
    left join fs on fs.platform = w.platform and fs.week = w.week
    left join c on c.platform = w.platform and c.week = w.week
    left join f on f.platform = w.platform and f.week = w.week
    left join evw on evw.platform = w.platform and evw.week = w.week),
cum as (
  select wk.*,
         sum(n_markets_first_shadowed) over p as n_markets_shadowed_cumulative,
         sum(n_reconciled) over p as n_reconciled_cumulative,
         sum(resolved_correct) over p as resolved_correct_cumulative,
         sum(resolved_wrong) over p as resolved_wrong_cumulative,
         sum(abstained) over p as abstained_cumulative
    from wk
  window p as (partition by platform order by week rows between unbounded preceding and current row)),
g as (
  select cum.*,
         -- plan §17.3: n >= 100 counts distinct events, so the legs of one ladder cannot open the gate together
         n_events_reconciled_cumulative >= 100 as is_reportable,
         resolved_correct_cumulative + resolved_wrong_cumulative as n_decided,
         resolved_correct_cumulative / nullif(resolved_correct_cumulative + resolved_wrong_cumulative, 0) as p_hat,
         (n_events_decided_cumulative - events_false_resolved_cumulative)::numeric / nullif(n_events_decided_cumulative, 0) as e_hat
    from cum)
select platform, week, n_markets_shadowed, n_committed, n_reconciled, resolved_correct, resolved_wrong, abstained,
       -- plan §6 definition (migration 009), now cumulative: every shadowed market counts, so a timid oracle cannot look precise
       case when is_reportable then round(resolved_correct_cumulative / nullif(n_markets_shadowed_cumulative, 0), 4) end as coverage_accuracy,
       case when is_reportable then round(p_hat, 4) end as precision,
       case when is_reportable then round(abstained_cumulative / nullif(n_reconciled_cumulative, 0), 4) end as abstention_rate,
       resolved_wrong as false_resolved,
       median_lead_seconds, p95_query_ms, round(jev_share, 4) as jev_share,
       is_reportable as reportable,
       -- appended in v2 (012)
       n_reconciled_cumulative, resolved_correct_cumulative, resolved_wrong_cumulative, abstained_cumulative,
       voided, unresolved_by_platform,
       case when is_reportable and n_decided > 0 then round((p_hat + 1.9208 / n_decided
            - 1.96 * sqrt(p_hat * (1 - p_hat) / n_decided + 0.9604 / (n_decided * n_decided))) / (1 + 3.8416 / n_decided), 4) end as wilson_low,
       case when is_reportable and n_decided > 0 then round((p_hat + 1.9208 / n_decided
            + 1.96 * sqrt(p_hat * (1 - p_hat) / n_decided + 0.9604 / (n_decided * n_decided))) / (1 + 3.8416 / n_decided), 4) end as wilson_high,
       n_markets_shadowed_cumulative,
       case when is_reportable then round(resolved_correct_cumulative / nullif(resolved_correct_cumulative + resolved_wrong_cumulative + abstained_cumulative, 0), 4) end as reconciled_accuracy,
       median_lead_seconds_poll,
       -- appended in 017: distinct events
       n_events_committed, n_events_reconciled, n_events_reconciled_cumulative, events_false_resolved,
       case when is_reportable then round(e_hat, 4) end as event_precision,
       case when is_reportable and n_events_decided_cumulative > 0 then round((e_hat + 1.9208 / n_events_decided_cumulative
            - 1.96 * sqrt(e_hat * (1 - e_hat) / n_events_decided_cumulative + 0.9604 / (n_events_decided_cumulative::numeric * n_events_decided_cumulative)))
            / (1 + 3.8416 / n_events_decided_cumulative), 4) end as event_wilson_low,
       case when is_reportable and n_events_decided_cumulative > 0 then round((e_hat + 1.9208 / n_events_decided_cumulative
            + 1.96 * sqrt(e_hat * (1 - e_hat) / n_events_decided_cumulative + 0.9604 / (n_events_decided_cumulative::numeric * n_events_decided_cumulative)))
            / (1 + 3.8416 / n_events_decided_cumulative), 4) end as event_wilson_high,
       n_events_decided_cumulative, events_false_resolved_cumulative
  from g;
comment on view public.v_track_record is
  'Public track record, per platform and ISO week, excluding markets.is_test. One agreement per market: the final reconciliation (latest commit). Weekly counts: markets with a complete shadow resolution (n_markets_shadowed), with a commit (n_committed), whose final reconciliation landed that week (n_reconciled = agree + disagree + abstained + void; unresolved_by_platform and pending are not reconciled). Distinct events (markets.event_key; the legs of one ladder are one event, 017): n_events_committed (events with a commit that week), n_events_reconciled (events whose first leg was reconciled that week), n_events_reconciled_cumulative, events_false_resolved (events whose first disagreeing final RESOLVED leg landed that week) and its cumulative, n_events_decided_cumulative (events with at least one final RESOLVED leg). Percentages are cumulative per platform up to the row''s week and NULL until n_events_reconciled_cumulative >= 100 (reportable; plan §17.3 counts events, not legs): coverage_accuracy = agree / distinct markets shadowed (the plan §6 definition), reconciled_accuracy = agree / (agree + disagree + abstained), precision = agree / (agree + disagree) per market with a 95 % Wilson interval (wilson_low, wilson_high), event_precision = events whose final RESOLVED legs all agreed / events with at least one, with its 95 % Wilson interval (event_wilson_low, event_wilson_high), abstention_rate = abstained / n_reconciled. median_lead_seconds uses only a platform timestamp (official_at_source gamma_closed_time); median_lead_seconds_poll uses poll-observed official times (limitless_api_poll, first_observed_poll), which are late by up to the poll delay, so it is an upper bound on the lead. security_invoker: RLS of the caller applies; readable by service_role only.';
comment on column public.v_track_record.n_events_committed is 'Distinct events (markets.event_key) with a commit this week on this platform.';
comment on column public.v_track_record.n_events_reconciled is 'Events whose first final leg was reconciled (agree, disagree, abstained or void) this week: summed over weeks, each event counts once.';
comment on column public.v_track_record.n_events_reconciled_cumulative is 'Distinct events reconciled on this platform up to this week; reportable = this >= 100.';
comment on column public.v_track_record.events_false_resolved is 'Events whose first disagreeing final RESOLVED leg landed this week (an event with any disagreeing leg is false).';
comment on column public.v_track_record.event_precision is 'Cumulative: events whose final RESOLVED legs all agreed / events with at least one final RESOLVED leg. NULL until reportable.';
comment on column public.v_track_record.event_wilson_low is 'Lower bound of the 95 % Wilson interval of event_precision (n = n_events_decided_cumulative). NULL until reportable.';
comment on column public.v_track_record.event_wilson_high is 'Upper bound of the 95 % Wilson interval of event_precision. NULL until reportable.';
comment on column public.v_track_record.n_events_decided_cumulative is 'Distinct events with at least one final RESOLVED leg (agree or disagree) up to this week: the n of event_precision.';
comment on column public.v_track_record.events_false_resolved_cumulative is 'Distinct events with a disagreeing final RESOLVED leg up to this week.';
revoke all on public.v_track_record from public, anon, authenticated;
grant select on public.v_track_record to service_role;

-- 5. least privilege on every relation ----------------------------------------------------------------------------------
-- 010 revoked routines and views and the default privileges for tables and functions; the tables and sequences created
-- before it kept their table-level grants to anon and authenticated (RLS deny policies were the only barrier). Nothing
-- in Resolve uses either role. service_role keeps every grant it has (the Worker and scripts authenticate as it).
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- 6. functions this migration creates: service_role only (default privileges would grant PUBLIC execute) ------------
revoke all on function public.market_event_key(text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.market_event_key(text, text, jsonb, jsonb) to service_role;
revoke all on function public.fill_market_event_key() from public, anon, authenticated;
grant execute on function public.fill_market_event_key() to service_role;
revoke all on function public.deny_event_key_change() from public, anon, authenticated;
grant execute on function public.deny_event_key_change() to service_role;
revoke all on function public.commit_context(uuid) from public, anon, authenticated;
grant execute on function public.commit_context(uuid) to service_role;
revoke all on function public.claim_post_lease(text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_post_lease(text, text, integer, integer, integer) to service_role;
revoke all on function public.release_post_lease(text, text) from public, anon, authenticated;
grant execute on function public.release_post_lease(text, text) to service_role;
revoke all on function public.note_post_failure(uuid[], text) from public, anon, authenticated;
grant execute on function public.note_post_failure(uuid[], text) to service_role;

commit;

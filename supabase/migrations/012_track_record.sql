-- 012_track_record: commit-reveal integrity, reconcile states and the public record v2 (plan §16.4 P2 steps 1-3,
-- §17.3 P2a, §19.2 item 3).
-- MEASURED 2026-09-23 (plan §16.2): the only commits on the public record are the two smoke markets (platform custom,
-- external_id smoke-*), v_track_record counted distinct market_id per agreement (one market could count as both agree
-- and abstained), and the commit path posted to Telegram before inserting its row (a failed insert orphaned a public
-- post; a failed post lost the commitment). The Worker now inserts a 'pending' commit first, posts, then fills only
-- the delivery columns; this migration lets exactly that transition through the immutability trigger.
--
-- Compatibility with the Worker deployed before this migration (it keeps running until the new one is deployed):
--   * bot_posts.channel CHECK is widened, never narrowed; old inserts ('telegram' / 'none') still pass.
--   * bot_posts.posted_at keeps its default now(): the old commit/reveal inserts omit posted_at and would violate
--     NOT NULL without it. Only NOT NULL is dropped, so the new code writes an explicit NULL while a row is pending
--     and telegram_date once posted. Existing rows keep their values (they are immutable commits anyway).
--   * reconciliations.final defaults to false, so the old upsert still inserts; rows it writes before the new Worker
--     lands are not counted by the v2 view until marked final (the backfill below marks existing ones). The new Worker
--     never revisits a market the old one settled, so deploy it right after this migration (today the old reconcile
--     has nothing to settle: it reads Polymarket/Limitless shadow markets only, and none exists in production).
--   * v_track_record is dropped and recreated in this transaction; every column the old src/api/public.ts reads keeps
--     its name and position, new columns are appended.
--   * markets.reconcile_next_at / reconcile_attempts / official_first_seen_at are new columns with defaults; the old
--     Worker never reads them. settle_market() and defer_reconcile() are new; the old Worker never calls them.
--   * bot_posts_commit_market_open refuses a commit on a market that is no longer open. The old Worker posts before it
--     inserts, so a refused insert there would orphan a post, but only in the race it closes (the old reconcile settles
--     Polymarket/Limitless shadow markets only, and none exists in production: plan §16.2).
begin;

-- 1. markets: test flag, condition id, closed_unresolved ------------------------------------------------------------
alter table markets add column if not exists is_test boolean not null default false;
alter table markets add column if not exists condition_id text;
comment on column markets.is_test is
  'Smoke/test market: never posted (commits recorded with channel none), never reconciled, excluded from v_track_record. Fixed once the market has a commit (trigger markets_is_test_locked), so a public call can never be hidden after the fact.';
comment on column markets.condition_id is
  'Platform condition id (Polymarket CTF conditionId / Limitless conditionId) for on-chain corroboration of the official outcome; null until an importer or the reconcile loop fills it.';
alter table markets add column if not exists reconcile_next_at timestamptz not null default now();
alter table markets add column if not exists reconcile_attempts integer not null default 0;
alter table markets add column if not exists official_first_seen_at timestamptz;
alter table markets drop constraint if exists markets_reconcile_attempts_check;
alter table markets add constraint markets_reconcile_attempts_check check (reconcile_attempts >= 0);
comment on column markets.reconcile_next_at is
  'When the reconcile job may next ask the platform about this market (once past its deadline). Discovery takes due markets oldest reconcile_next_at first, so a market that stays open (platform pending, label unmappable, platform unreachable) moves behind the others instead of holding a slot forever (plan §16.4 P2 step 2, no starvation).';
comment on column markets.reconcile_attempts is
  'Consecutive reconcile checks that could not map, reach or write the official outcome; the recheck delay doubles with it (10 min up to 6 h). Reset to 0 by a pending answer.';
comment on column markets.official_first_seen_at is
  'First time the reconcile job saw the official outcome when the platform gives no timestamp (Limitless; Polymarket without closedTime), kept when the settle had to wait, so official_at (and lead_seconds) is that first observation, never a later one.';
create index if not exists idx_markets_reconcile_due on markets (reconcile_next_at) where status = 'open' and deleted_at is null;
comment on index idx_markets_reconcile_due is 'Reconcile discovery: open markets by reconcile_next_at.';

alter table markets drop constraint if exists markets_status_check;
alter table markets add constraint markets_status_check
  check (status in ('open', 'resolved', 'void', 'unsupported_source', 'closed_unresolved'));
comment on column markets.status is
  'open -> resolved | void (official outcome reconciled) | closed_unresolved (no official outcome 21 days after the deadline) | unsupported_source (registration refused every source). Watches are deactivated on every terminal status.';

-- The migration is the one actor allowed to classify existing markets, so the lock trigger is recreated after the update.
drop trigger if exists markets_is_test_locked on markets;
update markets set is_test = true where platform = 'custom' and external_id like 'smoke-%' and not is_test;
update watches set active = false where active and market_id in (select id from markets where is_test);

create or replace function public.mark_smoke_market_test() returns trigger language plpgsql as $$
begin
  if new.platform = 'custom' and new.external_id like 'smoke-%' then new.is_test := true; end if;
  return new;
end $$;
comment on function public.mark_smoke_market_test() is
  'BEFORE INSERT on markets: a custom market whose external_id starts with smoke- is a test market, the same rule migration 012 applied to the existing rows, so a new smoke market can never reach the public record.';
drop trigger if exists markets_smoke_is_test on markets;
create trigger markets_smoke_is_test before insert on markets for each row execute function mark_smoke_market_test();
comment on trigger markets_smoke_is_test on markets is 'Smoke markets are test markets from their first row (mark_smoke_market_test).';

create or replace function public.deny_is_test_change() returns trigger language plpgsql as $$
begin
  if exists (select 1 from bot_posts where market_id = old.id and kind = 'commit') then
    raise exception 'markets.is_test is fixed once the market has a commit (market %)', old.id;
  end if;
  return new;
end $$;
comment on function public.deny_is_test_change() is
  'BEFORE UPDATE OF is_test on markets: refuses a change once any commit row exists for the market, so flagging a market as test can never remove a public call from v_track_record.';
create trigger markets_is_test_locked before update of is_test on markets for each row
  when (old.is_test is distinct from new.is_test) execute function deny_is_test_change();
comment on trigger markets_is_test_locked on markets is 'is_test is fixed once a commit exists (deny_is_test_change).';

-- 2. bot_posts: pending channel, nullable posted_at, column-wise commit immutability ---------------------------------
alter table bot_posts drop constraint if exists bot_posts_channel_check;
alter table bot_posts add constraint bot_posts_channel_check check (channel in ('telegram', 'none', 'pending'));
alter table bot_posts alter column posted_at drop not null;
comment on column bot_posts.channel is
  'pending = row recorded, not yet posted (retried by the reconcile job, alerted after 15 min); telegram = posted (message_id, telegram_date set); none = recorded and never posted by design (test markets, reveals of commits that were never public).';
comment on column bot_posts.posted_at is
  'When the post reached the channel (= telegram_date). NULL while pending or never posted. Rows written before migration 012 carry their insert time; the default now() is kept only because the Worker deployed before 012 omits the column.';
comment on column bot_posts.payload is
  'Post text and metadata. For commits since migration 012, payload.committed is the exact committed verdict and preimage (preimage_version v2) that reveal and reconcile use; post_error / post_attempts record failed deliveries.';
comment on table bot_posts is
  'Commit and reveal posts, inserted before posting (channel pending) and updated only with delivery columns (trigger bot_posts_commit_immutable). commitment_sha256 = sha256(preimage). Preimage v2 = platform:external_id|status|outcome|confidence(2dp)|caveats joined by ,|evidence_canonical_sha256|thresholds_version|nonce; v1 commits (before 012) used the internal market id as the first field. nonce is private until the reveal.';

create or replace function public.deny_commit_mutation() returns trigger language plpgsql as $$
declare
  delivery constant text[] := array['message_id', 'telegram_date', 'posted_at', 'channel', 'payload'];
begin
  if old.kind <> 'commit' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then raise exception 'commit posts are immutable (DELETE refused)'; end if;
  if old.channel <> 'pending' then
    raise exception 'commit posts are immutable once delivered (channel %)', old.channel;
  end if;
  if (to_jsonb(old) - delivery) is distinct from (to_jsonb(new) - delivery) then
    raise exception 'a pending commit may change only message_id, telegram_date, posted_at, channel and payload delivery fields';
  end if;
  if (old.payload - 'post_error' - 'post_attempts') is distinct from (new.payload - 'post_error' - 'post_attempts') then
    raise exception 'a pending commit payload may change only post_error and post_attempts';
  end if;
  -- The only exits from pending: still pending (a failed attempt), or posted with the Telegram receipt. Never
  -- 'none': abandoning a recorded commitment would be a silent loss.
  if new.channel not in ('pending', 'telegram') then
    raise exception 'a pending commit can only become telegram (got %)', new.channel;
  end if;
  if new.channel = 'pending' and (new.message_id is not null or new.telegram_date is not null or new.posted_at is not null) then
    raise exception 'a pending commit carries no delivery receipt';
  end if;
  if new.channel = 'telegram' and (new.message_id is null or new.telegram_date is null) then
    raise exception 'a posted commit needs message_id and telegram_date';
  end if;
  return new;
end $$;
comment on function public.deny_commit_mutation() is
  'bot_posts trigger. Commit rows: DELETE always refused; UPDATE refused unless the row is pending and only the delivery columns change (message_id, telegram_date, posted_at, channel -> telegram with a receipt, payload.post_error / payload.post_attempts). A delivered commit is immutable. Reveal and digest rows are unrestricted.';
drop trigger if exists bot_posts_commit_immutable on bot_posts;
create trigger bot_posts_commit_immutable before update or delete on bot_posts for each row execute function deny_commit_mutation();
comment on trigger bot_posts_commit_immutable on bot_posts is 'Commit immutability, column-wise since migration 012 (deny_commit_mutation).';
create index if not exists idx_bot_posts_pending on bot_posts (created_at) where channel = 'pending';
comment on index idx_bot_posts_pending is 'Unposted commits and reveals: the reconcile job retries and alerts on these.';
create index if not exists idx_bot_posts_commitment on bot_posts (commitment_sha256) where kind = 'commit';
comment on index idx_bot_posts_commitment is 'GET /v1/track-record/verify?hash= lookup.';

-- A commit is recorded only while its market is open. The watch reads markets.status once, before a Jev call that can
-- take tens of seconds; a commit that lands after the reconcile settled the market would never be reconciled or revealed
-- (the reconcile reads open markets only) yet would count in n_committed. FOR SHARE conflicts with the FOR UPDATE that
-- settle_market() holds, so a commit either commits before the settle reads the market's commits or waits and is refused.
create or replace function public.deny_commit_on_closed_market() returns trigger language plpgsql as $$
declare st text;
begin
  select status into st from markets where id = new.market_id for share;
  if st is distinct from 'open' then
    raise exception using errcode = 'RS001',
      message = format('market %s is %s: a commit is recorded only while its market is open', new.market_id, coalesce(st, 'missing'));
  end if;
  return new;
end $$;
comment on function public.deny_commit_on_closed_market() is
  'BEFORE INSERT on bot_posts for commit rows: refuses (SQLSTATE RS001) a commit whose market is not open, under a FOR SHARE lock that serializes with settle_market(). src/bot/commit.ts reads RS001 as "settled while this verdict was computed".';
drop trigger if exists bot_posts_commit_market_open on bot_posts;
create trigger bot_posts_commit_market_open before insert on bot_posts for each row
  when (new.kind = 'commit') execute function deny_commit_on_closed_market();
comment on trigger bot_posts_commit_market_open on bot_posts is 'Commits only on open markets (deny_commit_on_closed_market).';

-- 3. reconciliations: final flag, unresolved_by_platform, label and time provenance -----------------------------------
alter table reconciliations add column if not exists final boolean not null default false;
alter table reconciliations add column if not exists official_label text;
alter table reconciliations add column if not exists official_at_source text;
alter table reconciliations drop constraint if exists reconciliations_agreement_check;
alter table reconciliations add constraint reconciliations_agreement_check
  check (agreement in ('agree', 'disagree', 'void', 'pending', 'abstained', 'unresolved_by_platform'));
alter table reconciliations drop constraint if exists reconciliations_official_at_source_check;
alter table reconciliations add constraint reconciliations_official_at_source_check
  check (official_at_source is null or official_at_source in ('gamma_closed_time', 'limitless_api_poll', 'first_observed_poll'));
comment on column reconciliations.final is
  'true on exactly one row per market: the reconciliation of the market''s latest commit, which is the market''s agreement on the public record (partial unique index uq_reconciliations_final). Earlier commits are reconciled and revealed but not counted.';
comment on column reconciliations.official_label is
  'The platform''s winning outcome label exactly as returned (gamma outcomes[i] / Limitless outcome at winningOutcomeIndex), mapped to OPTION_A/OPTION_B only by normalized equality with the registered option text.';
comment on column reconciliations.official_at_source is
  'Where official_at comes from: gamma_closed_time (gamma closedTime), limitless_api_poll (first time the reconcile poll saw winningOutcomeIndex set; the REST object has no resolution timestamp and updatedAt is not one, plan §17.1), first_observed_poll (no platform timestamp). NULL when official_at is NULL.';
comment on column reconciliations.agreement is
  'agree / disagree (committed RESOLVED vs official) / abstained (committed UNRESOLVED or ERROR) / void (official VOID) / unresolved_by_platform (no official outcome 21 days after the deadline; not counted as reconciled) / pending.';

-- Rows written before 012 (the old Worker upserts without final): mark the latest commit's row per market.
update reconciliations rc set final = true
  from (select distinct on (b.market_id) b.market_id, b.resolution_id
          from bot_posts b
         where b.kind = 'commit' and b.resolution_id is not null
         order by b.market_id, b.created_at desc, b.id desc) latest
 where rc.resolution_id = latest.resolution_id
   and not rc.final
   and not exists (select 1 from reconciliations f where f.market_id = rc.market_id and f.final);
create unique index if not exists uq_reconciliations_final on reconciliations (market_id) where final;
comment on index uq_reconciliations_final is 'At most one final reconciliation (one public agreement) per market.';

-- One transaction per settled market. Before this function the Worker wrote reconciliations, reveals, watches and the
-- market status in four requests: a run that failed after the first left the market open with a final on the then
-- latest commit, and once a newer commit landed, the next plan's final collided with it on uq_reconciliations_final
-- (ON CONFLICT (resolution_id) does not cover that index), so every later run failed and the market never settled.
create or replace function public.settle_market(
  p_market uuid, p_commit_ids uuid[], p_reconciliations jsonb, p_reveals jsonb,
  p_status text, p_official_outcome text, p_official_at timestamptz, p_official_source_url text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m record;
  settle_after timestamptz;
  n_final integer;
  final_rid text;
  n_rec integer := 0;
  n_rev integer := 0;
begin
  if p_status is null or p_status not in ('resolved', 'void', 'closed_unresolved') then
    raise exception 'settle_market: % is not a terminal status', p_status;
  end if;
  if jsonb_typeof(p_reconciliations) is distinct from 'array' or jsonb_typeof(p_reveals) is distinct from 'array' then
    raise exception 'settle_market: reconciliations and reveals must be json arrays';
  end if;
  -- FOR UPDATE conflicts with the FOR SHARE of bot_posts_commit_market_open: a concurrent commit either committed
  -- before this point (and the commit-set check below sees it) or waits and is refused once the status is terminal.
  select id, status, deadline_utc, grace_seconds into m from markets where id = p_market for update;
  if not found then raise exception 'settle_market: no market %', p_market; end if;
  if m.status <> 'open' then
    update watches set active = false where market_id = p_market and active;
    return jsonb_build_object('result', 'not_open', 'status', m.status);
  end if;
  -- The absence rule commits only after deadline + grace. Settling before every active watch has finished a clean poll
  -- after that point would make a pre-deadline UNRESOLVED the final commit and switch off the watch that was about to
  -- commit the post-deadline verdict. Five minutes of margin because last_polled_at is stamped after the fetch, so a
  -- poll that started just before deadline + grace can carry a later stamp. A watch without one clean poll 24 hours
  -- later is broken (the watch runner alerts its failure streak) and no longer holds the market.
  settle_after := m.deadline_utc + make_interval(secs => m.grace_seconds) + interval '5 minutes';
  if now() < settle_after + interval '24 hours' and exists (
       select 1 from watches w
        where w.market_id = p_market and w.active and w.deleted_at is null
          and (w.last_polled_at is null or w.last_polled_at < settle_after or w.consecutive_errors > 0)) then
    return jsonb_build_object('result', 'awaiting_watch');
  end if;
  -- Watches off before anything else: no new commit starts from here, so a stale plan converges on the next run.
  update watches set active = false where market_id = p_market and active;
  if exists (select 1 from bot_posts b where b.market_id = p_market and b.kind = 'commit' and not (b.id = any (p_commit_ids))) then
    return jsonb_build_object('result', 'commits_changed');
  end if;

  select count(*) filter (where x.final), max(x.resolution_id) filter (where x.final) into n_final, final_rid
    from jsonb_to_recordset(p_reconciliations) as x(resolution_id text, final boolean);
  if jsonb_array_length(p_reconciliations) > 0 and n_final <> 1 then
    raise exception 'settle_market: % final rows planned for market % (exactly one expected)', n_final, p_market;
  end if;
  if exists (select 1 from jsonb_to_recordset(p_reconciliations) as x(resolution_id text)
              where not exists (select 1 from bot_posts b where b.market_id = p_market and b.kind = 'commit' and b.resolution_id = x.resolution_id)) then
    raise exception 'settle_market: a planned reconciliation is not for a commit of market %', p_market;
  end if;
  if exists (select 1 from jsonb_to_recordset(p_reveals) as x(channel text)
              where x.channel is null or x.channel not in ('pending', 'none')) then
    raise exception 'settle_market: a reveal is recorded pending (or none), never as already posted';
  end if;

  -- One final per market: an older final (written by an earlier Worker) is cleared before the new rows land. Rows that
  -- already exist keep their first observation and take only the final flag.
  update reconciliations set final = false where market_id = p_market and final and resolution_id is distinct from final_rid;
  insert into reconciliations (resolution_id, market_id, platform, official_outcome, official_label, official_at, official_at_source, agreement, lead_seconds, source_url, final)
  select x.resolution_id, p_market, x.platform, x.official_outcome, x.official_label, x.official_at, x.official_at_source, x.agreement, x.lead_seconds, x.source_url, x.final
    from jsonb_to_recordset(p_reconciliations) as x(resolution_id text, platform text, official_outcome text, official_label text, official_at timestamptz,
                                                  official_at_source text, agreement text, lead_seconds integer, source_url text, final boolean)
  on conflict (resolution_id) do update set final = excluded.final;
  get diagnostics n_rec = row_count;
  insert into bot_posts (resolution_id, market_id, channel, kind, reply_to_message_id, commitment_sha256, nonce, payload, dedup_key, posted_at)
  select x.resolution_id, p_market, x.channel, 'reveal', x.reply_to_message_id, x.commitment_sha256, x.nonce, x.payload, x.dedup_key, null
    from jsonb_to_recordset(p_reveals) as x(resolution_id text, channel text, reply_to_message_id bigint, commitment_sha256 text, nonce text, payload jsonb, dedup_key text)
  on conflict (dedup_key) do nothing;
  get diagnostics n_rev = row_count;
  update markets set status = p_status, official_outcome = p_official_outcome, official_resolved_at = p_official_at, official_source_url = p_official_source_url
   where id = p_market;
  return jsonb_build_object('result', 'settled', 'reconciliations', n_rec, 'reveals', n_rev);
end $$;
comment on function public.settle_market(uuid, uuid[], jsonb, jsonb, text, text, timestamptz, text) is
  'Settle one market in one transaction (src/jobs/reconcile.ts plans the rows): lock the market; not open -> watches off, {result: not_open}; an active watch without a clean poll after deadline + grace (+5 min; waived 24 h later) -> {result: awaiting_watch}, nothing written; watches off; a commit the plan did not see -> {result: commits_changed}, nothing else written; else move the final flag, insert reconciliations (existing rows take only final) and pending reveals (insert-or-ignore on dedup_key), set the terminal status -> {result: settled, reconciliations, reveals}. service_role only.';

-- One request for every market a reconcile run checked without settling.
create or replace function public.defer_reconcile(p_rows jsonb) returns integer
language sql security definer set search_path = public as $$
  with d as (
    update markets m
       set reconcile_next_at = x.next_at, reconcile_attempts = x.attempts,
           official_first_seen_at = coalesce(m.official_first_seen_at, x.first_seen_at)
      from jsonb_to_recordset(p_rows) as x(id uuid, next_at timestamptz, attempts integer, first_seen_at timestamptz)
     where m.id = x.id and m.status = 'open'
    returning 1)
  select count(*)::integer from d;
$$;
comment on function public.defer_reconcile(jsonb) is
  'Reconcile scheduling in one request: rows [{id, next_at, attempts, first_seen_at}] set reconcile_next_at and reconcile_attempts on open markets; official_first_seen_at keeps its first value. Returns the number of markets updated. service_role only.';

-- 4. v_track_record v2 ------------------------------------------------------------------------------------------------
drop view if exists public.v_track_record;
create view public.v_track_record with (security_invoker = true) as
with live as (
  select id, platform from markets where not is_test and tenant_id is null),
shadow as (
  select r.market_id, l.platform, date_trunc('week', r.created_at) as week, r.determination_basis, r.duration_ms
    from resolutions r join live l on l.id = r.market_id
   where r.mode = 'shadow' and r.status_row = 'complete'),
first_shadow as (
  select market_id, platform, min(week) as week from shadow group by market_id, platform),
commits as (
  select b.market_id, l.platform, date_trunc('week', b.created_at) as week
    from bot_posts b join live l on l.id = b.market_id
   where b.kind = 'commit'),
finals as (
  select rc.market_id, l.platform, date_trunc('week', rc.reconciled_at) as week, rc.agreement, rc.lead_seconds, rc.official_at_source
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
  select platform, week, count(distinct market_id) as n_committed from commits group by platform, week),
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
wk as (
  select w.platform, w.week,
         coalesce(s.n_markets_shadowed, 0) as n_markets_shadowed, coalesce(fs.n_markets_first_shadowed, 0) as n_markets_first_shadowed,
         coalesce(c.n_committed, 0) as n_committed,
         coalesce(f.n_reconciled, 0) as n_reconciled, coalesce(f.resolved_correct, 0) as resolved_correct,
         coalesce(f.resolved_wrong, 0) as resolved_wrong, coalesce(f.abstained, 0) as abstained,
         coalesce(f.voided, 0) as voided, coalesce(f.unresolved_by_platform, 0) as unresolved_by_platform,
         f.median_lead_seconds, f.median_lead_seconds_poll, s.p95_query_ms, s.jev_share
    from weeks w
    left join s on s.platform = w.platform and s.week = w.week
    left join fs on fs.platform = w.platform and fs.week = w.week
    left join c on c.platform = w.platform and c.week = w.week
    left join f on f.platform = w.platform and f.week = w.week),
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
         n_reconciled_cumulative >= 100 as is_reportable,
         resolved_correct_cumulative + resolved_wrong_cumulative as n_decided,
         resolved_correct_cumulative / nullif(resolved_correct_cumulative + resolved_wrong_cumulative, 0) as p_hat
    from cum)
select platform, week, n_markets_shadowed, n_committed, n_reconciled, resolved_correct, resolved_wrong, abstained,
       -- plan §6 definition (migration 009), now cumulative: every shadowed market counts, so a timid oracle cannot look precise
       case when is_reportable then round(resolved_correct_cumulative / nullif(n_markets_shadowed_cumulative, 0), 4) end as coverage_accuracy,
       case when is_reportable then round(p_hat, 4) end as precision,
       case when is_reportable then round(abstained_cumulative / nullif(n_reconciled_cumulative, 0), 4) end as abstention_rate,
       resolved_wrong as false_resolved,
       median_lead_seconds, p95_query_ms, round(jev_share, 4) as jev_share,
       is_reportable as reportable,
       -- appended in v2
       n_reconciled_cumulative, resolved_correct_cumulative, resolved_wrong_cumulative, abstained_cumulative,
       voided, unresolved_by_platform,
       case when is_reportable and n_decided > 0 then round((p_hat + 1.9208 / n_decided
            - 1.96 * sqrt(p_hat * (1 - p_hat) / n_decided + 0.9604 / (n_decided * n_decided))) / (1 + 3.8416 / n_decided), 4) end as wilson_low,
       case when is_reportable and n_decided > 0 then round((p_hat + 1.9208 / n_decided
            + 1.96 * sqrt(p_hat * (1 - p_hat) / n_decided + 0.9604 / (n_decided * n_decided))) / (1 + 3.8416 / n_decided), 4) end as wilson_high,
       n_markets_shadowed_cumulative,
       case when is_reportable then round(resolved_correct_cumulative / nullif(resolved_correct_cumulative + resolved_wrong_cumulative + abstained_cumulative, 0), 4) end as reconciled_accuracy,
       median_lead_seconds_poll
  from g;
comment on view public.v_track_record is
  'Public track record v2, per platform and ISO week, excluding markets.is_test. One agreement per market: the final reconciliation (latest commit). Weekly counts: markets with a complete shadow resolution (n_markets_shadowed), with a commit (n_committed), whose final reconciliation landed that week (n_reconciled = agree + disagree + abstained + void; unresolved_by_platform and pending are not reconciled). Percentages are cumulative per platform up to the row''s week and NULL until n_reconciled_cumulative >= 100: coverage_accuracy = agree / distinct markets shadowed (n_markets_shadowed_cumulative; the plan §6 definition), reconciled_accuracy = agree / (agree + disagree + abstained), precision = agree / (agree + disagree) with a 95 % Wilson interval (wilson_low, wilson_high), abstention_rate = abstained / n_reconciled. median_lead_seconds uses only a platform timestamp (official_at_source gamma_closed_time); median_lead_seconds_poll uses poll-observed official times (limitless_api_poll, first_observed_poll), which are late by up to the poll delay, so it is an upper bound on the lead. security_invoker: RLS of the caller applies; readable by service_role only.';
revoke all on public.v_track_record from public, anon, authenticated;
grant select on public.v_track_record to service_role;

-- 5. least privilege on the functions this migration creates or replaces (default privileges grant PUBLIC execute) --
revoke all on function public.deny_commit_mutation() from public, anon, authenticated;
grant execute on function public.deny_commit_mutation() to service_role;
revoke all on function public.deny_is_test_change() from public, anon, authenticated;
grant execute on function public.deny_is_test_change() to service_role;
revoke all on function public.mark_smoke_market_test() from public, anon, authenticated;
grant execute on function public.mark_smoke_market_test() to service_role;
revoke all on function public.deny_commit_on_closed_market() from public, anon, authenticated;
grant execute on function public.deny_commit_on_closed_market() to service_role;
revoke all on function public.settle_market(uuid, uuid[], jsonb, jsonb, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.settle_market(uuid, uuid[], jsonb, jsonb, text, text, timestamptz, text) to service_role;
revoke all on function public.defer_reconcile(jsonb) from public, anon, authenticated;
grant execute on function public.defer_reconcile(jsonb) to service_role;

commit;

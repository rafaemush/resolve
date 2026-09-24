-- 021_venue_report: one row per public shadow market with every time a venue reconciliation report quotes (plan §17.3
-- P7-lite "venue reconciliation report renderer", §18.1 (e) "record determinable_at, committed_at, delivered_at,
-- official_at per market so lead time is measured, not asserted", §19.3).
-- WHY: the artifact every evidence-led touch attaches is a per-venue report of commit time, official time, lead time,
-- agreement and the share of web-evidence verdicts, and the founder rule is "no fabricated numbers": every number in it
-- comes from a view. v_track_record is per platform and week; a venue report needs the per-market rows behind it, from
-- the tables that already hold them:
--   * determinable_at    resolutions.created_at of the market's first complete shadow verdict that is RESOLVED (003)
--   * committed_at       bot_posts.created_at of the market's first commit (009; inserted first since 012)
--   * posted_at          that commit's telegram_date (012): when it became public in the channel
--   * first_delivered_at the first shadow.committed webhook delivered to any follower (webhook_deliveries, 009)
--   * official_*, agreement, lead_seconds  the final reconciliation (009, 012: final = the latest commit's)
-- plus the latest commit's verdict and hashes (payload.committed since 012, else the resolutions row, like
-- src/bot/commit.ts committedOf) for GET /v1/shadow/export, which reads this view for a tenant's followed markets
-- (never the nonce or the preimage: the view has neither).
-- Read by scripts/venue-report.ts (with v_track_record, nothing else) and by the Worker's GET /v1/shadow/export.
--
-- Compatibility with the Worker deployed before this migration (8d67d16; it keeps running until every migration is
-- applied and the new Worker ships):
--   * Additive only: one new view and one new partial index on webhook_deliveries. No table, column, constraint,
--     function or existing view changes; the old Worker never reads the view. The index covers only delivered
--     shadow.committed rows, which the old Worker never writes (it has no such event), so its inserts and updates of
--     webhook_deliveries pay nothing until the new Worker delivers one.
-- Idempotent (create or replace view, create index if not exists). Nothing here is reachable by anon or authenticated
-- (migration 010 explains why revoking from public alone is not enough on Supabase).
begin;

-- 1. first delivery of shadow.committed per market ----------------------------------------------------------------------
create index if not exists idx_webhook_deliveries_shadow_committed
  on webhook_deliveries ((payload ->> 'market_id'), delivered_at)
  where event_type = 'shadow.committed' and delivered_at is not null;
comment on index idx_webhook_deliveries_shadow_committed is
  'v_venue_report.first_delivered_at: the earliest delivered shadow.committed webhook of a market (payload.market_id), without scanning every delivery.';

-- 2. v_venue_report ---------------------------------------------------------------------------------------------------
create or replace view public.v_venue_report with (security_invoker = true) as
select m.id as market_id,
       m.platform,
       m.event_key,
       m.external_id,
       m.status,
       case when lc.payload ? 'committed' then lc.payload #>> '{committed,determination_basis}' else lr.determination_basis end as determination_basis,
       dr.created_at as determinable_at,
       fc.created_at as committed_at,
       fc.telegram_date as posted_at,
       wd.first_delivered_at,
       rc.official_at,
       rc.official_at_source,
       rc.agreement,
       rc.lead_seconds,
       -- identifiers a venue matches on (never a title or criteria text)
       case when m.platform = 'limitless'
            then coalesce(nullif(btrim(m.meta ->> 'limitless_slug'), ''), nullif(btrim(m.meta ->> 'slug'), ''), m.external_id)
            else nullif(btrim(m.meta ->> 'slug'), '') end as venue_slug,
       lower(coalesce(m.condition_id, nullif(btrim(m.meta ->> 'condition_id'), ''))) as condition_id,
       m.created_at as registered_at,
       m.deadline_utc,
       coalesce(nc.n_commits, 0) as n_commits,
       lc.created_at as latest_committed_at,
       lc.commitment_sha256 as latest_commitment_sha256,
       case when lc.payload ? 'committed' then lc.payload #>> '{committed,resolution_status}' else lr.resolution_status end as committed_status,
       case when lc.payload ? 'committed' then lc.payload #>> '{committed,winning_outcome}' else lr.winning_outcome end as committed_outcome,
       case when h.raw ~ '^[0-9a-f]{64}$' then h.raw end as evidence_raw_sha256,
       case when h.canonical ~ '^[0-9a-f]{64}$' then h.canonical end as evidence_canonical_sha256,
       rc.official_outcome,
       rc.reconciled_at
  from markets m
  left join lateral (
    select b.created_at, b.telegram_date
      from bot_posts b
     where b.market_id = m.id and b.kind = 'commit'
     order by b.created_at, b.id
     limit 1) fc on true
  left join lateral (
    select b.created_at, b.commitment_sha256, b.payload, b.resolution_id
      from bot_posts b
     where b.market_id = m.id and b.kind = 'commit'
     order by b.created_at desc, b.id desc
     limit 1) lc on true
  left join lateral (
    select count(*)::integer as n_commits from bot_posts b where b.market_id = m.id and b.kind = 'commit') nc on true
  left join resolutions lr on lr.id = lc.resolution_id
  left join lateral (
    select case when lc.payload ? 'committed' then lc.payload #>> '{committed,raw_sha256}' else lc.payload ->> 'evidence_raw_sha256' end as raw,
           case when lc.payload ? 'committed' then lc.payload #>> '{committed,canonical_sha256}' else lc.payload ->> 'canonical_sha256' end as canonical) h on true
  left join lateral (
    select r.created_at
      from resolutions r
     where r.market_id = m.id and r.mode = 'shadow' and r.status_row = 'complete' and r.resolution_status = 'RESOLVED'
     order by r.created_at, r.id
     limit 1) dr on true
  left join lateral (
    select min(d.delivered_at) as first_delivered_at
      from webhook_deliveries d
     where d.event_type = 'shadow.committed' and d.delivered_at is not null and d.payload ->> 'market_id' = m.id::text) wd on true
  left join reconciliations rc on rc.market_id = m.id and rc.final
 where m.tenant_id is null and not m.is_test
   -- a deleted registration drops out, unless it carries a commit: a public call never leaves the record
   and (m.deleted_at is null or fc.created_at is not null);
comment on view public.v_venue_report is
  'Venue reconciliation report rows (plan §17.3 P7-lite, §18.1 (e)): one row per public shadow market (tenant_id null, not is_test; a deleted market only if it has a commit), with the times a report quotes, all read from the tables of record: determinable_at (first complete shadow verdict that is RESOLVED), committed_at / posted_at (first commit, and when it reached the channel), first_delivered_at (first shadow.committed webhook delivered to any follower), and the final reconciliation (official_at, official_at_source, agreement, lead_seconds = official_at - the final commit''s posted time). determination_basis, committed_status / committed_outcome and the evidence hashes are the latest commit''s (payload.committed since migration 012, else its resolutions row). No title, criteria text, nonce or preimage. Read by scripts/venue-report.ts and GET /v1/shadow/export. security_invoker: readable by service_role only.';
comment on column public.v_venue_report.market_id is 'markets.id.';
comment on column public.v_venue_report.platform is 'markets.platform: polymarket | limitless | custom.';
comment on column public.v_venue_report.event_key is 'markets.event_key (migration 017): the legs of one multi-outcome event share it; reports count events by it.';
comment on column public.v_venue_report.external_id is 'markets.external_id: the platform''s id (gamma market id, Limitless slug).';
comment on column public.v_venue_report.status is 'markets.status: open | resolved | void | closed_unresolved | unsupported_source.';
comment on column public.v_venue_report.determination_basis is 'The latest commit''s determination_basis: structured | jev; NULL when the pre-checks settled the verdict, or no commit exists.';
comment on column public.v_venue_report.determinable_at is 'created_at of the market''s first complete shadow resolutions row whose verdict is RESOLVED (before the public floor); NULL when none.';
comment on column public.v_venue_report.committed_at is 'created_at of the market''s first commit (bot_posts kind commit); NULL when never committed.';
comment on column public.v_venue_report.posted_at is 'telegram_date of that first commit: when it reached the public channel; NULL while pending or never posted.';
comment on column public.v_venue_report.first_delivered_at is 'Earliest delivered_at of a shadow.committed webhook for this market (any follower); NULL when none was delivered.';
comment on column public.v_venue_report.official_at is 'Final reconciliation: the platform''s official time (see official_at_source).';
comment on column public.v_venue_report.official_at_source is 'gamma_closed_time (a platform timestamp) | limitless_api_poll | first_observed_poll (the first poll that saw the outcome: an upper bound, so lead_seconds is too).';
comment on column public.v_venue_report.agreement is 'Final reconciliation: agree | disagree | abstained | void | unresolved_by_platform; NULL before the platform resolves.';
comment on column public.v_venue_report.lead_seconds is 'Final reconciliation: official_at minus the final commit''s telegram_date, in seconds; NULL when unposted or no official time.';
comment on column public.v_venue_report.venue_slug is 'The slug the platform knows the market by: Limitless meta.limitless_slug, else meta.slug, else external_id (reconcile''s limitlessSlug); Polymarket meta.slug; NULL otherwise.';
comment on column public.v_venue_report.condition_id is 'markets.condition_id, else meta.condition_id, lower case (Polymarket CTF / Limitless conditionId).';
comment on column public.v_venue_report.registered_at is 'markets.created_at: when the market was registered for shadowing.';
comment on column public.v_venue_report.deadline_utc is 'markets.deadline_utc.';
comment on column public.v_venue_report.n_commits is 'Commit rows of the market (a changed verdict is a new commit; the latest is the final one).';
comment on column public.v_venue_report.latest_committed_at is 'created_at of the market''s latest commit (created_at desc, id desc: the commit settle_market makes final).';
comment on column public.v_venue_report.latest_commitment_sha256 is 'commitment_sha256 of the latest commit; checkable at GET /v1/track-record/verify?hash=.';
comment on column public.v_venue_report.committed_status is 'The latest commit''s resolution_status as committed (after the public floor): RESOLVED | UNRESOLVED | ERROR.';
comment on column public.v_venue_report.committed_outcome is 'The latest commit''s winning_outcome: OPTION_A | OPTION_B | NONE.';
comment on column public.v_venue_report.evidence_raw_sha256 is 'The latest commit''s raw evidence sha256 (64 hex), NULL when none.';
comment on column public.v_venue_report.evidence_canonical_sha256 is 'The latest commit''s canonical evidence sha256 (64 hex), NULL when none.';
comment on column public.v_venue_report.official_outcome is 'Final reconciliation: OPTION_A | OPTION_B | VOID; NULL for unresolved_by_platform or before the platform resolves.';
comment on column public.v_venue_report.reconciled_at is 'When the final reconciliation row was written.';
revoke all on public.v_venue_report from public, anon, authenticated;
grant select on public.v_venue_report to service_role;

commit;

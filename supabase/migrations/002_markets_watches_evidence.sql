-- Migration 002 — markets, watches, evidence (Resolve, 2026-09-22).
--
-- WHY: resolutions (003) reference markets and evidence, so the registry lives
-- here even though the ingestion code lands in roadmap step 2. A market is a
-- registered condition with tenant-supplied options; positive_option names the
-- option that asserts event_statement occurred, so every gate in code is
-- expressed as positive/negative, never OPTION_A/OPTION_B. A watch is one source
-- polled by one Worker invocation at a time (lease). Evidence rows are
-- content-addressed (raw_sha256) and carry provenance and coverage so a verdict
-- can always be re-derived from what was actually fetched.

begin;

create table if not exists markets (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid references tenants(id),
  platform             text not null check (platform in ('polymarket','limitless','custom')),
  external_id          text not null,
  condition            text not null,
  event_statement      text not null,
  option_a             text not null,
  option_b             text not null,
  positive_option      text not null check (positive_option in ('OPTION_A','OPTION_B')),
  anchors              jsonb not null default '[]'::jsonb check (jsonb_typeof(anchors) = 'array'),
  sources              jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  resolver             jsonb check (resolver is null or jsonb_typeof(resolver) = 'object'),
  negative_rule        text not null default 'absence_after_deadline' check (negative_rule in ('absence_after_deadline','explicit_negative')),
  allow_prerelease     boolean not null default false,
  open_at              timestamptz not null,
  deadline_utc         timestamptz not null,
  grace_seconds        integer not null default 3600 check (grace_seconds >= 0),
  status               text not null default 'open' check (status in ('open','resolved','void','unsupported_source')),
  official_outcome     text check (official_outcome is null or official_outcome in ('OPTION_A','OPTION_B','VOID')),
  official_resolved_at timestamptz,
  official_source_url  text,
  meta                 jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  constraint markets_deadline_after_open check (deadline_utc > open_at),
  constraint markets_unique_per_tenant unique nulls not distinct (tenant_id, platform, external_id)
);
comment on table markets is 'Registered market conditions. tenant_id NULL = a shadow market the settle-bot resolves for the public track record. official_* is filled by the reconcile loop from the platform of record, never by us.';
comment on column markets.event_statement is 'Deadline-free statement of the event Jev is asked about; the deadline is enforced in code because Jev reads dates as text.';
create index if not exists idx_markets_open on markets (deadline_utc) where status = 'open' and deleted_at is null;
drop trigger if exists markets_updated_at on markets;
create trigger markets_updated_at before update on markets for each row execute function set_updated_at();
select apply_rls('markets');

create table if not exists watches (
  id                 uuid primary key default gen_random_uuid(),
  market_id          uuid not null references markets(id),
  source_kind        text not null check (source_kind in ('github_api','github_events','base_log','solana_log','web_fetch','web_render')),
  source_ref         jsonb not null check (jsonb_typeof(source_ref) = 'object'),
  poll_interval_s    integer not null default 300 check (poll_interval_s >= 30),
  next_poll_at       timestamptz not null default now(),
  lease_until        timestamptz,
  etag               text,
  cursor             jsonb not null default '{}'::jsonb check (jsonb_typeof(cursor) = 'object'),
  coverage           jsonb not null default '[]'::jsonb check (jsonb_typeof(coverage) = 'array'),
  last_evidence_hash text,
  last_polled_at     timestamptz,
  last_error         text,
  consecutive_errors integer not null default 0,
  backlog            boolean not null default false,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
comment on table watches is 'One source per market, polled by exactly one Worker invocation at a time: select_due_watches() leases the row (lease_until) and pg_net POSTs /internal/watch/:id. coverage records every polled window {from,to,status} so absence claims can prove contiguous observation.';
create index if not exists idx_watches_due on watches (next_poll_at) where active and deleted_at is null;
create index if not exists idx_watches_market on watches (market_id) where deleted_at is null;
drop trigger if exists watches_updated_at on watches;
create trigger watches_updated_at before update on watches for each row execute function set_updated_at();
select apply_rls('watches');

create table if not exists evidence (
  id                uuid primary key default gen_random_uuid(),
  market_id         uuid not null references markets(id),
  watch_id          uuid references watches(id),
  source_kind       text not null check (source_kind in ('github_api','github_events','base_log','solana_log','web_fetch','web_render','tenant_supplied')),
  source_url        text,
  observed_at       timestamptz not null,
  claimed_at        timestamptz,
  fetched_at        timestamptz not null default now(),
  http_status       integer,
  etag              text,
  raw_sha256        text not null,
  canonical_sha256  text not null,
  raw_bytes         integer,
  raw_r2_key        text,
  excerpt           text check (excerpt is null or length(excerpt) <= 16384),
  windows           jsonb not null default '[]'::jsonb check (jsonb_typeof(windows) = 'array'),
  injection_markers jsonb not null default '[]'::jsonb check (jsonb_typeof(injection_markers) = 'array'),
  provenance        jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  coverage          jsonb not null default '{}'::jsonb check (jsonb_typeof(coverage) = 'object'),
  created_at        timestamptz not null default now(),
  constraint evidence_unique_bytes unique (market_id, raw_sha256)
);
comment on table evidence is 'Content-addressed fetch results. observed_at is the source''s server timestamp for structured sources and fetched_at (our clock) for web sources; claimed_at is a page''s own timestamp, display only, never compared. Raw bytes live in R2 under raw_r2_key for 7 days; only the <=16 KB excerpt is stored here.';
create index if not exists idx_evidence_market_time on evidence (market_id, fetched_at desc);
select apply_rls('evidence');

commit;

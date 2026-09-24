-- 011_watches_ingest: columns for ingestion correctness (P1a).
-- MEASURED 2026-09-23 (plan §16.2): change detection compared the raw-bytes hash, so a PR whose embedded repo
-- counters moved re-stored and re-resolved on every poll (42/42 distinct hashes), and HTTP 403 rate-limit
-- bodies became evidence. The Worker now compares the hash of a projection of deciding fields
-- (src/ingest/projection.ts) and records the last HTTP status to alert on a 200 -> non-200 transition.
-- Additive only: the currently deployed Worker never reads or writes these columns. No backfill: a null
-- last_canonical_hash makes the next poll store one observation, which then seeds the column.
begin;

alter table watches add column if not exists last_canonical_hash text;
alter table watches add column if not exists last_http_status integer;
alter table watches drop constraint if exists watches_last_http_status_check;
alter table watches add constraint watches_last_http_status_check
  check (last_http_status is null or last_http_status between 100 and 599);

comment on column watches.last_canonical_hash is
  'sha256 of the change projection (src/ingest/projection.ts: deciding fields of GitHub JSON, canonical text for web, the ordered matching logs/signatures for chains) of the last STORED observation. A poll whose projection hash equals this is a no_op (coverage/cursor advance, no evidence row, no resolution) unless it is the post-deadline observation. Not evidence.canonical_sha256, which stays the hash of the canonical evidence text.';
comment on column watches.last_http_status is
  'HTTP status of the last answer from a github/web source (the final status after same-site redirects); null for chain sources and until the first poll after migration 011. A transition from 200/304 to a failing answer raises an operator alert.';
comment on column watches.last_evidence_hash is
  'raw_sha256 of the last stored observation (the R2 key suffix). Change detection uses last_canonical_hash since migration 011.';

commit;

/**
 * Migration 021 (v_venue_report), rollback-only: everything runs inside one DO block that always raises at the end, so
 * nothing persists. It asserts, on rows written inside the block with fixed times:
 *   - one row per public shadow market: a test market, a tenant's market and a deleted market without a commit are not
 *     rows; a deleted market with a commit is (a public call never leaves the record);
 *   - determinable_at = the first complete shadow resolution that is RESOLVED (not an earlier UNRESOLVED one, not a
 *     tenant-mode or pending row); committed_at / posted_at = the first commit's created_at / telegram_date;
 *     first_delivered_at = the earliest delivered shadow.committed webhook of the market (not a pending one, not
 *     shadow.revealed, not another market's); official_at, official_at_source, agreement and lead_seconds = the final
 *     reconciliation, never an earlier commit's;
 *   - the latest commit's verdict and hashes from payload.committed, or from its resolutions row for a commit recorded
 *     before migration 012 (a legacy "n/a" hash is NULL); determination_basis is the latest commit's;
 *   - the identifiers: Limitless venue_slug (limitless_slug, then slug, then external_id), condition_id lower-cased
 *     from the column or meta;
 *   - least privilege: security_invoker, service_role reads it, anon and authenticated cannot; the view, every column
 *     and the new index are commented.
 * Refused unless SUPABASE_PROJECT_REF equals STAGING_SUPABASE_PROJECT_REF or RESOLVE_SELFTEST_NON_PRODUCTION=1 (with
 * --psql, only the latter); the target is printed first.
 *   RESOLVE_SELFTEST_NON_PRODUCTION=1 npx tsx scripts/selftest/venue.ts --psql postgresql://postgres@localhost:5561/resolve
 *   npx tsx scripts/selftest/venue.ts             (the Management API: the project .env names, staging only)
 */
import { loadEnv } from "../lib/env";
import { blockRunner, check, describeTarget, nonProductionRefusal, raisedResults, UsageError } from "../lib/selftest";

const TAG = "SELFTEST_VENUE";
const H = (c: string) => c.repeat(64);

export const VENUE_BLOCK = `
do $$
declare
  out jsonb := '{}'::jsonb;
  t0 constant timestamptz := '2026-01-01T00:00:00Z';
  tnt uuid; ep uuid; m1 uuid; m2 uuid; m3 uuid; mt uuid; mten uuid; mdel uuid; mdelc uuid; mother uuid;
  v record;
  mk text := $mk$insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc, meta, condition_id, tenant_id)
              values ($1, $2, 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', '2025-12-01T00:00:00Z', '2026-01-02T00:00:00Z', $3, $4, $5) returning id$mk$;
begin
  insert into tenants (display_name) values ('__selftest_venue_tenant__') returning id into tnt;
  insert into webhook_endpoints (tenant_id, url, secret, events) values (tnt, 'https://selftest.invalid/hook', 'whsec_selftest', '{shadow.committed,shadow.revealed}') returning id into ep;

  execute mk into m1 using 'polymarket', '__selftest_venue_m1__', '{"slug":"venue-m1","event_id":"__selftest_venue_ev__"}'::jsonb, '0x' || repeat('AB', 32), null::uuid;
  execute mk into m2 using 'limitless', '__selftest_venue_m2__', '{"limitless_slug":"venue-leg-a","slug":"venue-other","group_slug":"venue-group","condition_id":"0xCD"}'::jsonb, null::text, null::uuid;
  execute mk into m3 using 'limitless', '__selftest_venue_m3__', '{}'::jsonb, null::text, null::uuid;
  execute mk into mt using 'custom', '__selftest_venue_test__', '{}'::jsonb, null::text, null::uuid;
  update markets set is_test = true where id = mt;
  execute mk into mten using 'custom', '__selftest_venue_tenant__', '{}'::jsonb, null::text, tnt;
  execute mk into mdel using 'custom', '__selftest_venue_del__', '{}'::jsonb, null::text, null::uuid;
  update markets set deleted_at = now() where id = mdel;
  execute mk into mdelc using 'custom', '__selftest_venue_delc__', '{}'::jsonb, null::text, null::uuid;
  execute mk into mother using 'custom', '__selftest_venue_other__', '{}'::jsonb, null::text, null::uuid;

  -- m1: UNRESOLVED, then RESOLVED twice (determinable at the first RESOLVED); a tenant-mode and a pending RESOLVED earlier
  insert into resolutions (id, market_id, mode, status_row, resolution_status, winning_outcome, confidence_score, determination_basis, caveats, thresholds_version, created_at) values
    ('__selftest_venue_tn__', m1, 'tenant', 'complete', 'RESOLVED', 'OPTION_A', 0.95, 'structured', '[]', 'v1', t0 + interval '1 minute'),
    ('__selftest_venue_pd__', m1, 'shadow', 'pending', null, null, null, null, '[]', 'v1', t0 + interval '2 minutes'),
    ('__selftest_venue_r1__', m1, 'shadow', 'complete', 'UNRESOLVED', 'NONE', 0.50, 'structured', '["no_anchor"]', 'v1', t0 + interval '5 minutes'),
    ('__selftest_venue_r2__', m1, 'shadow', 'complete', 'RESOLVED', 'OPTION_A', 0.95, 'jev', '[]', 'v1', t0 + interval '60 minutes'),
    ('__selftest_venue_r3__', m1, 'shadow', 'complete', 'RESOLVED', 'OPTION_A', 0.96, 'jev', '[]', 'v1', t0 + interval '120 minutes');
  -- first commit posted at +11, the latest one (payload.committed, RESOLVED by jev) still pending
  insert into bot_posts (resolution_id, market_id, channel, kind, message_id, telegram_date, commitment_sha256, nonce, payload, dedup_key, posted_at, created_at)
    values ('__selftest_venue_r1__', m1, 'telegram', 'commit', 1, t0 + interval '11 minutes', '${H("1")}', 'n1',
            '{"committed":{"resolution_status":"UNRESOLVED","winning_outcome":"NONE","determination_basis":"structured","raw_sha256":"${H("a")}","canonical_sha256":"${H("b")}"}}',
            '__selftest_venue_c1__', t0 + interval '11 minutes', t0 + interval '10 minutes');
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at, created_at)
    values ('__selftest_venue_r2__', m1, 'pending', 'commit', '${H("2")}', 'n2',
            '{"committed":{"resolution_status":"RESOLVED","winning_outcome":"OPTION_A","determination_basis":"jev","raw_sha256":"${H("c")}","canonical_sha256":"${H("d")}"}}',
            '__selftest_venue_c2__', null, t0 + interval '70 minutes');
  -- reconciliations: the first commit's (not final) and the final one
  insert into reconciliations (resolution_id, market_id, platform, official_outcome, official_at, official_at_source, agreement, lead_seconds, final, reconciled_at) values
    ('__selftest_venue_r1__', m1, 'polymarket', 'OPTION_A', t0 + interval '300 minutes', 'gamma_closed_time', 'abstained', 17340, false, t0 + interval '301 minutes'),
    ('__selftest_venue_r2__', m1, 'polymarket', 'OPTION_A', t0 + interval '300 minutes', 'gamma_closed_time', 'agree', 13800, true, t0 + interval '301 minutes');
  -- deliveries: the earliest delivered shadow.committed of m1 is +12
  insert into webhook_deliveries (endpoint_id, tenant_id, event_type, payload, status, delivered_at) values
    (ep, tnt, 'shadow.committed', jsonb_build_object('market_id', m1), 'delivered', t0 + interval '80 minutes'),
    (ep, tnt, 'shadow.committed', jsonb_build_object('market_id', m1), 'delivered', t0 + interval '12 minutes'),
    (ep, tnt, 'shadow.committed', jsonb_build_object('market_id', m1), 'pending', null),
    (ep, tnt, 'shadow.revealed', jsonb_build_object('market_id', m1), 'delivered', t0 + interval '1 minute'),
    (ep, tnt, 'shadow.committed', jsonb_build_object('market_id', mother), 'delivered', t0 + interval '2 minutes');

  -- m3: a commit recorded before migration 012 (no payload.committed): its resolutions row stands in
  insert into resolutions (id, market_id, mode, status_row, resolution_status, winning_outcome, confidence_score, determination_basis, caveats, thresholds_version, created_at)
    values ('__selftest_venue_r4__', m3, 'shadow', 'complete', 'RESOLVED', 'OPTION_B', 0.95, 'structured', '[]', 'v1', t0 + interval '30 minutes');
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at, created_at)
    values ('__selftest_venue_r4__', m3, 'none', 'commit', '${H("3")}', 'n3', '{"evidence_raw_sha256":"n/a","canonical_sha256":"${H("e")}"}', '__selftest_venue_c3__', null, t0 + interval '31 minutes');

  -- excluded and included edge rows: a test market's and a tenant market's commits, a deleted market with a commit
  insert into resolutions (id, market_id, mode, status_row, resolution_status, winning_outcome, confidence_score, determination_basis, caveats, thresholds_version) values
    ('__selftest_venue_rt__', mt, 'shadow', 'complete', 'RESOLVED', 'OPTION_A', 0.95, 'structured', '[]', 'v1'),
    ('__selftest_venue_rd__', mdelc, 'shadow', 'complete', 'RESOLVED', 'OPTION_A', 0.95, 'structured', '[]', 'v1');
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at) values
    ('__selftest_venue_rt__', mt, 'none', 'commit', '${H("4")}', 'n4', '{}', '__selftest_venue_ct__', null),
    ('__selftest_venue_rd__', mdelc, 'none', 'commit', '${H("5")}', 'n5', '{}', '__selftest_venue_cd__', null);
  update markets set deleted_at = now() where id = mdelc;

  out := out || jsonb_build_object('rows', (select coalesce(jsonb_agg(external_id order by external_id), '[]'::jsonb) from v_venue_report where external_id like '__selftest_venue_%'));

  select * into v from v_venue_report where market_id = m1;
  out := out || jsonb_build_object('m1', jsonb_build_object(
    'platform', v.platform, 'event_key', v.event_key, 'status', v.status, 'determination_basis', v.determination_basis,
    'determinable_min', extract(epoch from v.determinable_at - t0)::integer / 60,
    'committed_min', extract(epoch from v.committed_at - t0)::integer / 60,
    'posted_min', extract(epoch from v.posted_at - t0)::integer / 60,
    'first_delivered_min', extract(epoch from v.first_delivered_at - t0)::integer / 60,
    'official_min', extract(epoch from v.official_at - t0)::integer / 60,
    'official_at_source', v.official_at_source, 'agreement', v.agreement, 'lead_seconds', v.lead_seconds, 'official_outcome', v.official_outcome,
    'reconciled_min', extract(epoch from v.reconciled_at - t0)::integer / 60,
    'venue_slug', v.venue_slug, 'condition_id', v.condition_id, 'n_commits', v.n_commits,
    'latest_min', extract(epoch from v.latest_committed_at - t0)::integer / 60, 'latest_commitment', v.latest_commitment_sha256,
    'committed_status', v.committed_status, 'committed_outcome', v.committed_outcome,
    'raw', v.evidence_raw_sha256, 'canonical', v.evidence_canonical_sha256));

  select * into v from v_venue_report where market_id = m2;
  out := out || jsonb_build_object('m2', jsonb_build_object(
    'venue_slug', v.venue_slug, 'condition_id', v.condition_id, 'n_commits', v.n_commits, 'committed_at', v.committed_at, 'posted_at', v.posted_at,
    'determinable_at', v.determinable_at, 'first_delivered_at', v.first_delivered_at, 'agreement', v.agreement, 'determination_basis', v.determination_basis,
    'latest_commitment', v.latest_commitment_sha256, 'event_key', v.event_key));

  select * into v from v_venue_report where market_id = m3;
  out := out || jsonb_build_object('m3', jsonb_build_object(
    'venue_slug', v.venue_slug, 'committed_status', v.committed_status, 'committed_outcome', v.committed_outcome, 'determination_basis', v.determination_basis,
    'raw', v.evidence_raw_sha256, 'canonical', v.evidence_canonical_sha256, 'posted_at', v.posted_at,
    'committed_min', extract(epoch from v.committed_at - t0)::integer / 60, 'determinable_min', extract(epoch from v.determinable_at - t0)::integer / 60));

  -- least privilege and comments
  begin
    set local role service_role;
    out := out || jsonb_build_object('service_role_select', (select count(*) from v_venue_report where market_id = m1) = 1);
    reset role;
  exception when others then out := out || jsonb_build_object('service_role_select', 'error: ' || sqlerrm);
  end;
  begin
    set local role anon;
    begin perform 1 from v_venue_report limit 1; out := out || '{"anon_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_denied": true}'; end;
    reset role;
  exception when others then out := out || jsonb_build_object('anon_denied', 'set role failed: ' || sqlerrm);
  end;
  out := out || jsonb_build_object(
    'authenticated_denied', not has_table_privilege('authenticated', 'public.v_venue_report', 'select'),
    'public_denied', not exists (select 1 from pg_class c, aclexplode(c.relacl) a where c.oid = 'public.v_venue_report'::regclass and a.grantee = 0),
    'security_invoker', (select coalesce('security_invoker=true' = any(reloptions), false) from pg_class where oid = 'public.v_venue_report'::regclass),
    'uncommented', (select count(*) from pg_attribute a where a.attrelid = 'public.v_venue_report'::regclass and a.attnum > 0 and not a.attisdropped
                      and col_description(a.attrelid, a.attnum) is null)
      + (case when obj_description('public.v_venue_report'::regclass, 'pg_class') is null then 1 else 0 end)
      + (case when obj_description('public.idx_webhook_deliveries_shadow_committed'::regclass, 'pg_class') is null then 1 else 0 end));
  raise exception '${TAG} %', out::text;
end $$;`;

export const VENUE_EXPECT: Record<string, unknown> = {
  rows: ["__selftest_venue_delc__", "__selftest_venue_m1__", "__selftest_venue_m2__", "__selftest_venue_m3__", "__selftest_venue_other__"],
  m1: {
    platform: "polymarket", event_key: "polymarket:event:__selftest_venue_ev__", status: "open", determination_basis: "jev",
    determinable_min: 60, committed_min: 10, posted_min: 11, first_delivered_min: 12, official_min: 300,
    official_at_source: "gamma_closed_time", agreement: "agree", lead_seconds: 13800, official_outcome: "OPTION_A", reconciled_min: 301,
    venue_slug: "venue-m1", condition_id: `0x${"ab".repeat(32)}`, n_commits: 2, latest_min: 70, latest_commitment: H("2"),
    committed_status: "RESOLVED", committed_outcome: "OPTION_A", raw: H("c"), canonical: H("d"),
  },
  m2: {
    venue_slug: "venue-leg-a", condition_id: "0xcd", n_commits: 0, committed_at: null, posted_at: null, determinable_at: null, first_delivered_at: null,
    agreement: null, determination_basis: null, latest_commitment: null, event_key: "limitless:__selftest_venue_m2__",
  },
  m3: {
    venue_slug: "__selftest_venue_m3__", committed_status: "RESOLVED", committed_outcome: "OPTION_B", determination_basis: "structured",
    raw: null, canonical: H("e"), posted_at: null, committed_min: 31, determinable_min: 30,
  },
  service_role_select: true, anon_denied: true, authenticated_denied: true, public_denied: true, security_invoker: true, uncommented: 0,
};

/** JSON with object keys sorted: jsonb orders keys its own way, so equal objects must compare equal. */
const canonical = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x)));

async function main(): Promise<number> {
  loadEnv();
  let runner: ReturnType<typeof blockRunner>;
  try { runner = blockRunner(process.argv.slice(2)); } catch (e) {
    if (e instanceof UsageError) { console.error(e.message); return 2; }
    throw e;
  }
  console.log(`selftest venue target: ${describeTarget(runner)}`);
  const refusal = nonProductionRefusal(process.env, runner.via);
  if (refusal) { console.error(`selftest venue (migration 021): ${refusal}`); return 2; }
  const raw = await runner.run(VENUE_BLOCK);
  const r = raisedResults(TAG, raw);
  if (!r) { console.error("FAIL venue: the block did not return results:", raw.slice(0, 1200)); return 1; }
  const bad = check(canonical(r) as Record<string, unknown>, canonical(VENUE_EXPECT) as Record<string, unknown>, "venue.");
  console.log(`rolled back: nothing persisted from the venue block (${runner.via})`);
  return bad ? 1 : 0;
}

if (process.argv[1]?.endsWith("venue.ts")) main().then((code) => process.exit(code), (e) => { console.error(String(e)); process.exit(1); });

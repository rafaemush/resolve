/**
 * Exercises the billing RPCs, the commit-reveal trigger and the public view (migration 012), the dispatch
 * observability of migration 013, and the no-cold-pitch gate and follows of migration 014, each inside a DO block that
 * always raises at the end, so the whole thing rolls back and nothing persists. The raised message carries the assertion results. Then a real concurrency probe: 10 parallel begin_resolution calls with one
 * Idempotency-Key against a __selftest__ tenant (soft-deleted afterwards; ledger rows are append-only by design).
 * Point it at staging: the concurrency probe persists rows.
 */
import { loadEnv } from "./lib/env";
import { sql } from "./lib/mgmt";

loadEnv();

/** Run a DO block that ends with raise exception '<tag> <json>' and return the parsed json (null when absent). */
async function rollbackBlock(tag: string, block: string): Promise<Record<string, unknown> | null> {
  let msg = "";
  try { await sql(block); } catch (e) { msg = String(e); }
  let inner = msg;
  const j = msg.indexOf("{");
  if (j >= 0) { try { inner = String(JSON.parse(msg.slice(j)).message ?? msg); } catch { /* keep raw */ } }
  const m = inner.match(new RegExp(`${tag} (\\{.*\\})`, "s"));
  if (!m) { console.error(`${tag} did not return results:`, msg.slice(0, 800)); return null; }
  return JSON.parse(m[1]!) as Record<string, unknown>;
}

/** Print PASS/FAIL per expected key ("a.b" reads a nested key); returns the number of failures. */
function check(r: Record<string, unknown>, expect: Record<string, unknown>): number {
  let bad = 0;
  for (const [k, v] of Object.entries(expect)) {
    const got = k.includes(".") ? (r[k.split(".")[0]!] as Record<string, unknown> | undefined)?.[k.split(".")[1]!] : r[k];
    const ok = JSON.stringify(got) === JSON.stringify(v);
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} ${k} = ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(v)})`}`);
  }
  return bad;
}

/**
 * Migration 012: a pending commit may take its delivery receipt once and nothing else; delete is refused; the view
 * counts one agreement per market (the final reconciliation) and never a test market; anon cannot read the view.
 * settle_market(): a final left on an older commit moves to the newest one in the same transaction (the
 * uq_reconciliations_final collision a four-request settle ran into), a second call is a no-op, a commit after the settle
 * is refused (RS001), a commit the plan did not see stops it, an unfinished post-deadline watch poll holds it (waived
 * 24 h later); defer_reconcile() keeps the first official sighting; anon can execute neither.
 */
const P2A_BLOCK = `
do $$
declare m uuid; mt uuid; c1 uuid; c2 uuid; rv uuid; smoke boolean; b record; a record; out jsonb := '{}'::jsonb;
  ms uuid; mc uuid; ma uuid; mw uuid; ws uuid; wa uuid; cs1 uuid; cs2 uuid; cs3 uuid; cc uuid; res jsonb; plan jsonb; revs jsonb;
begin
  insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc)
    values ('polymarket', '__selftest_p2a__', 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', now() - interval '3 days', now() - interval '2 days') returning id into m;
  insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc)
    values ('polymarket', '__selftest_p2a_test__', 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', now() - interval '3 days', now() - interval '2 days') returning id into mt;
  update markets set is_test = true where id = mt;                       -- allowed: no commit yet
  insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc)
    values ('custom', 'smoke-__selftest_p2a__', 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', now() - interval '3 days', now() - interval '2 days') returning is_test into smoke;
  out := out || jsonb_build_object('smoke_insert_is_test', smoke);
  select coalesce(sum(n_reconciled), 0)::int as n, coalesce(sum(abstained), 0)::int as ab, coalesce(sum(resolved_correct), 0)::int as ok,
         coalesce(sum(n_committed), 0)::int as nc, coalesce(sum(n_markets_shadowed), 0)::int as ns into b from v_track_record where platform = 'polymarket';
  insert into resolutions (id, market_id, mode, status_row, resolution_status, winning_outcome, confidence_score, determination_basis, caveats, thresholds_version) values
    ('__selftest_p2a_r1__', m, 'shadow', 'complete', 'UNRESOLVED', 'NONE', 0.50, 'structured', '["selftest"]', 'v1'),
    ('__selftest_p2a_r2__', m, 'shadow', 'complete', 'RESOLVED', 'OPTION_A', 0.95, 'structured', '[]', 'v1'),
    ('__selftest_p2a_rt__', mt, 'shadow', 'complete', 'RESOLVED', 'OPTION_A', 0.95, 'structured', '[]', 'v1');
  -- every row carries the transaction's now(), so the view sees one week whatever the wall clock
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at)
    values ('__selftest_p2a_r1__', m, 'pending', 'commit', repeat('a', 64), 'n1', '{"committed":{"k":1},"post_attempts":0}', '__selftest_p2a_c1__', null) returning id into c1;
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at)
    values ('__selftest_p2a_r2__', m, 'pending', 'commit', repeat('b', 64), 'n2', '{"committed":{"k":2},"post_attempts":0}', '__selftest_p2a_c2__', null) returning id into c2;
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at)
    values ('__selftest_p2a_rt__', mt, 'none', 'commit', repeat('c', 64), 'n3', '{}', '__selftest_p2a_ct__', null);

  begin update bot_posts set payload = payload || '{"post_error":"selftest","post_attempts":1}' where id = c2;
    out := out || '{"pending_failed_attempt_allowed": true}'; exception when others then out := out || jsonb_build_object('pending_failed_attempt_allowed', sqlerrm); end;
  begin update bot_posts set commitment_sha256 = repeat('d', 64) where id = c2;
    out := out || '{"pending_sha_change_refused": false}'; exception when others then out := out || '{"pending_sha_change_refused": true}'; end;
  begin update bot_posts set payload = jsonb_set(payload, '{committed,k}', '9') where id = c2;
    out := out || '{"pending_committed_change_refused": false}'; exception when others then out := out || '{"pending_committed_change_refused": true}'; end;
  begin update bot_posts set channel = 'none' where id = c2;
    out := out || '{"pending_to_none_refused": false}'; exception when others then out := out || '{"pending_to_none_refused": true}'; end;
  begin update bot_posts set channel = 'telegram' where id = c2;
    out := out || '{"posted_without_receipt_refused": false}'; exception when others then out := out || '{"posted_without_receipt_refused": true}'; end;
  begin update bot_posts set channel = 'telegram', message_id = 1, telegram_date = now(), posted_at = now(), payload = payload || '{"post_attempts":1}' where id = c1;
    out := out || '{"pending_to_posted_allowed": true}'; exception when others then out := out || jsonb_build_object('pending_to_posted_allowed', sqlerrm); end;
  begin update bot_posts set message_id = 2 where id = c1;
    out := out || '{"second_update_after_posted_refused": false}'; exception when others then out := out || '{"second_update_after_posted_refused": true}'; end;
  begin delete from bot_posts where id = c1;
    out := out || '{"posted_delete_refused": false}'; exception when others then out := out || '{"posted_delete_refused": true}'; end;
  begin delete from bot_posts where id = c2;
    out := out || '{"pending_delete_refused": false}'; exception when others then out := out || '{"pending_delete_refused": true}'; end;
  begin update markets set is_test = true where id = m;
    out := out || '{"is_test_locked_after_commit": false}'; exception when others then out := out || '{"is_test_locked_after_commit": true}'; end;
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at)
    values ('__selftest_p2a_r1__', m, 'pending', 'reveal', repeat('a', 64), 'n1', '{}', '__selftest_p2a_v1__', null) returning id into rv;
  begin update bot_posts set channel = 'telegram', message_id = 3, telegram_date = now(), posted_at = now(), reply_to_message_id = 1 where id = rv;
    out := out || '{"reveal_update_allowed": true}'; exception when others then out := out || jsonb_build_object('reveal_update_allowed', sqlerrm); end;

  insert into reconciliations (resolution_id, market_id, platform, official_outcome, agreement, final) values
    ('__selftest_p2a_r1__', m, 'polymarket', 'OPTION_A', 'abstained', false),
    ('__selftest_p2a_r2__', m, 'polymarket', 'OPTION_A', 'agree', true),
    ('__selftest_p2a_rt__', mt, 'polymarket', 'OPTION_A', 'agree', true);
  select coalesce(sum(n_reconciled), 0)::int as n, coalesce(sum(abstained), 0)::int as ab, coalesce(sum(resolved_correct), 0)::int as ok,
         coalesce(sum(n_committed), 0)::int as nc, coalesce(sum(n_markets_shadowed), 0)::int as ns into a from v_track_record where platform = 'polymarket';
  out := out || jsonb_build_object('view_reconciled_delta', a.n - b.n, 'view_abstained_delta', a.ab - b.ab, 'view_correct_delta', a.ok - b.ok,
                                   'view_committed_delta', a.nc - b.nc, 'view_shadowed_delta', a.ns - b.ns);
  begin update reconciliations set final = true where resolution_id = '__selftest_p2a_r1__';
    out := out || '{"second_final_refused": false}'; exception when unique_violation then out := out || '{"second_final_refused": true}'; end;

  -- settle_market: the partial settle an older Worker left (final on s2), then a newer commit s3
  insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc)
    values ('polymarket', '__selftest_p2a_settle__', 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', now() - interval '3 days', now() - interval '2 days') returning id into ms;
  insert into watches (market_id, source_kind, source_ref, last_polled_at) values (ms, 'web_fetch', '{}', now()) returning id into ws;
  insert into resolutions (id, market_id, mode, status_row, resolution_status, winning_outcome, confidence_score, determination_basis, caveats, thresholds_version) values
    ('__selftest_p2a_s1__', ms, 'shadow', 'complete', 'UNRESOLVED', 'NONE', 0.50, 'structured', '["selftest"]', 'v1'),
    ('__selftest_p2a_s2__', ms, 'shadow', 'complete', 'UNRESOLVED', 'NONE', 0.50, 'structured', '["selftest2"]', 'v1'),
    ('__selftest_p2a_s3__', ms, 'shadow', 'complete', 'RESOLVED', 'OPTION_A', 0.95, 'structured', '[]', 'v1');
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at)
    values ('__selftest_p2a_s1__', ms, 'pending', 'commit', repeat('1', 64), 'n', '{}', '__selftest_p2a_cs1__', null) returning id into cs1;
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at)
    values ('__selftest_p2a_s2__', ms, 'pending', 'commit', repeat('2', 64), 'n', '{}', '__selftest_p2a_cs2__', null) returning id into cs2;
  insert into reconciliations (resolution_id, market_id, platform, official_outcome, agreement, final) values
    ('__selftest_p2a_s1__', ms, 'polymarket', 'OPTION_A', 'abstained', false),
    ('__selftest_p2a_s2__', ms, 'polymarket', 'OPTION_A', 'abstained', true);
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at)
    values ('__selftest_p2a_s3__', ms, 'pending', 'commit', repeat('3', 64), 'n', '{}', '__selftest_p2a_cs3__', null) returning id into cs3;
  plan := jsonb_build_array(
    jsonb_build_object('resolution_id', '__selftest_p2a_s1__', 'platform', 'polymarket', 'official_outcome', 'OPTION_A', 'agreement', 'abstained', 'final', false),
    jsonb_build_object('resolution_id', '__selftest_p2a_s2__', 'platform', 'polymarket', 'official_outcome', 'OPTION_A', 'agreement', 'abstained', 'final', false),
    jsonb_build_object('resolution_id', '__selftest_p2a_s3__', 'platform', 'polymarket', 'official_outcome', 'OPTION_A', 'agreement', 'agree', 'final', true));
  revs := jsonb_build_array(jsonb_build_object('resolution_id', '__selftest_p2a_s3__', 'channel', 'pending', 'commitment_sha256', repeat('3', 64), 'nonce', 'n', 'payload', '{}'::jsonb, 'dedup_key', '__selftest_p2a_rv3__'));
  begin perform settle_market(ms, array[cs1, cs2, cs3], plan || jsonb_build_array(plan->2), revs, 'resolved', 'OPTION_A', now(), null);
    out := out || '{"settle_two_finals_refused": false}'; exception when others then out := out || '{"settle_two_finals_refused": true}'; end;
  res := settle_market(ms, array[cs1, cs2, cs3], plan, revs, 'resolved', 'OPTION_A', now(), null);
  out := out || jsonb_build_object('settle_result', res->>'result', 'settle_rows', res->'reconciliations', 'settle_reveals', res->'reveals',
    'settle_final', (select resolution_id from reconciliations where market_id = ms and final),
    'settle_status', (select status from markets where id = ms), 'settle_watch_active', (select active from watches where id = ws));
  out := out || jsonb_build_object('settle_again', settle_market(ms, array[cs1, cs2, cs3], plan, revs, 'resolved', 'OPTION_A', now(), null)->>'result');
  begin insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at)
      values ('__selftest_p2a_s3__', ms, 'pending', 'commit', repeat('4', 64), 'n', '{}', '__selftest_p2a_cs4__', null);
    out := out || '{"late_commit_refused": false}'; exception when sqlstate 'RS001' then out := out || '{"late_commit_refused": true}'; end;
  out := out || jsonb_build_object('defer_closed_market', defer_reconcile(jsonb_build_array(jsonb_build_object('id', ms, 'next_at', now(), 'attempts', 1))));

  -- a commit the plan did not see: watches off, nothing else written, the market stays open for the next run
  insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc)
    values ('polymarket', '__selftest_p2a_changed__', 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', now() - interval '3 days', now() - interval '2 days') returning id into mc;
  insert into watches (market_id, source_kind, source_ref, last_polled_at) values (mc, 'web_fetch', '{}', now()) returning id into wa;
  insert into bot_posts (resolution_id, market_id, channel, kind, commitment_sha256, nonce, payload, dedup_key, posted_at)
    values ('__selftest_p2a_r2__', mc, 'pending', 'commit', repeat('5', 64), 'n', '{}', '__selftest_p2a_cc__', null) returning id into cc;
  res := settle_market(mc, '{}'::uuid[], '[]', '[]', 'resolved', 'OPTION_A', now(), null);
  out := out || jsonb_build_object('changed_result', res->>'result', 'changed_status', (select status from markets where id = mc),
    'changed_watch_active', (select active from watches where id = wa), 'changed_rows', (select count(*) from reconciliations where market_id = mc));

  -- the post-deadline watch poll has not run yet (deadline 30 min ago, grace 1 h): nothing written, watch still on
  insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc)
    values ('polymarket', '__selftest_p2a_await__', 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', now() - interval '3 days', now() - interval '30 minutes') returning id into ma;
  insert into watches (market_id, source_kind, source_ref, last_polled_at) values (ma, 'web_fetch', '{}', now() - interval '1 minute') returning id into wa;
  res := settle_market(ma, '{}'::uuid[], '[]', '[]', 'resolved', 'OPTION_A', now(), null);
  out := out || jsonb_build_object('await_result', res->>'result', 'await_status', (select status from markets where id = ma), 'await_watch_active', (select active from watches where id = wa));
  perform defer_reconcile(jsonb_build_array(jsonb_build_object('id', ma, 'next_at', now() + interval '10 minutes', 'attempts', 0, 'first_seen_at', now() - interval '7 minutes')));
  perform defer_reconcile(jsonb_build_array(jsonb_build_object('id', ma, 'next_at', now() + interval '20 minutes', 'attempts', 3, 'first_seen_at', now())));
  out := out || jsonb_build_object('defer_keeps_first_seen', (select official_first_seen_at = now() - interval '7 minutes' from markets where id = ma),
    'defer_attempts', (select reconcile_attempts from markets where id = ma), 'defer_next_at', (select reconcile_next_at = now() + interval '20 minutes' from markets where id = ma));
  -- a watch still failing 24 h after deadline + grace no longer holds the market
  insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc)
    values ('polymarket', '__selftest_p2a_waived__', 'selftest condition', 'selftest statement', 'Yes', 'No', 'OPTION_A', now() - interval '5 days', now() - interval '3 days') returning id into mw;
  insert into watches (market_id, source_kind, source_ref, last_polled_at, consecutive_errors) values (mw, 'web_fetch', '{}', now(), 9);
  out := out || jsonb_build_object('waived_result', settle_market(mw, '{}'::uuid[], '[]', '[]', 'closed_unresolved', null, null, null)->>'result');
  begin
    set local role anon;
    begin perform 1 from v_track_record limit 1; out := out || '{"anon_view_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_view_denied": true}'; end;
    begin perform settle_market(ma, '{}'::uuid[], '[]', '[]', 'resolved', 'OPTION_A', now(), null); out := out || '{"anon_settle_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_settle_denied": true}'; end;
    begin perform defer_reconcile('[]'); out := out || '{"anon_defer_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_defer_denied": true}'; end;
    reset role;
  exception when others then out := out || jsonb_build_object('anon_view_denied', 'set role failed: ' || sqlerrm);
  end;
  raise exception 'SELFTEST_P2A %', out::text;
end $$;`;

/**
 * Migration 013: a select_due_watches() run that throws leaves a 'failure' row with its SQLSTATE (forced here with an
 * unparsable watch_batch_max, rolled back with everything else), dispatch_failures() answers a count and refuses a bad
 * window, and anon can execute neither.
 */
const OPS_BLOCK = `
do $$
declare out jsonb := '{}'::jsonb; n integer; lr record;
begin
  update app_config set value = 'not-a-number' where key = 'watch_batch_max';
  if not found then insert into app_config (key, value) values ('watch_batch_max', 'not-a-number'); end if;
  n := select_due_watches();
  select outcome, error, meta into lr from loop_runs where loop_name = 'select_due_watches' order by id desc limit 1;
  out := out || jsonb_build_object('throw_returns', n, 'throw_outcome', lr.outcome, 'throw_sqlstate', lr.meta->>'sqlstate', 'throw_has_error', lr.error is not null);
  n := dispatch_failures(10);
  out := out || jsonb_build_object('dispatch_failures_is_count', n >= 0);
  begin perform dispatch_failures(0); out := out || '{"bad_window_refused": false}';
  exception when others then out := out || '{"bad_window_refused": true}'; end;
  begin
    set local role anon;
    begin perform dispatch_failures(10); out := out || '{"anon_dispatch_failures_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_dispatch_failures_denied": true}'; end;
    begin perform select_due_watches(); out := out || '{"anon_select_due_watches_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_select_due_watches_denied": true}'; end;
    reset role;
  exception when others then out := out || jsonb_build_object('anon_dispatch_failures_denied', 'set role failed: ' || sqlerrm);
  end;
  raise exception 'SELFTEST_OPS %', out::text;
end $$;`;

/**
 * Migration 014: log_touch() refuses an outbound pitch (dm, email, call) with no settled reconciliation on the lead's
 * platform unless an override reason is given (blank is not a reason), a direct insert cannot skip the gate, pending /
 * unresolved_by_platform / test-market / tenant-market rows are not evidence, a real one is; the touch log is
 * append-only; a retry with the same request_id returns the recorded touch (even after the lead is deleted), the same
 * request_id with other content is refused, and a blank one does not deduplicate; follow_market() is idempotent, holds
 * the cap (null = unlimited) on follows of open markets only (a settled market frees its slot), refuses anything but an
 * open non-test shadow market, and allows a new follow after an unfollow; follow_entitlements() reports live_key false
 * for a tenant whose keys are all expired or revoked, and ranks follows oldest first among open markets plus the market
 * asked about; anon can execute none of the functions nor read the tables.
 * The evidence half runs on platform custom, which the Worker never reconciles (custom_prior_evidence must be false).
 */
const GTM_BLOCK = `
do $$
declare out jsonb := '{}'::jsonb; prior boolean; lx uuid; lc uuid; tid uuid; t uuid; tt uuid; res jsonb; n integer;
  m_pend uuid; m_unres uuid; m_test uuid; m_ten uuid; m_ok uuid; f1 uuid; f2 uuid; f3 uuid; f_test uuid; f_closed uuid;
  tr uuid; ti uuid; te uuid; e1 uuid; e2 uuid; e3 uuid;
  mk constant text := 'insert into markets (platform, external_id, condition, event_statement, option_a, option_b, positive_option, open_at, deadline_utc, tenant_id, status) values (''custom'', $1, ''selftest condition'', ''selftest statement'', ''Yes'', ''No'', ''OPTION_A'', now() - interval ''3 days'', now() - interval ''2 days'', $2, $3) returning id';
  rs constant text := 'insert into resolutions (id, market_id, mode, status_row, resolution_status, winning_outcome, confidence_score, determination_basis, caveats, thresholds_version) values ($1, $2, ''shadow'', ''complete'', ''RESOLVED'', ''OPTION_A'', 0.95, ''structured'', ''[]'', ''v1'')';
  rc constant text := 'insert into reconciliations (resolution_id, market_id, platform, official_outcome, agreement, final) values ($1, $2, ''custom'', $3, $4, true)';
begin
  prior := exists (select 1 from reconciliations r join markets m on m.id = r.market_id
                    where m.platform = 'custom' and m.tenant_id is null and not m.is_test and r.agreement in ('agree', 'disagree', 'abstained', 'void'));
  out := out || jsonb_build_object('custom_prior_evidence', prior);
  insert into leads (name, platform) values ('__selftest_lead_x__', '__selftest_platform__') returning id into lx;
  insert into leads (name, platform) values ('__selftest_lead_c__', 'custom') returning id into lc;

  begin perform log_touch(lx, 'dm', 'out', 'selftest pitch', null, null); out := out || '{"cold_dm_refused": false}';
  exception when sqlstate 'RS002' then out := out || '{"cold_dm_refused": true}'; end;
  begin perform log_touch(lx, 'email', 'out', 'selftest pitch', null, null); out := out || '{"cold_email_refused": false}';
  exception when sqlstate 'RS002' then out := out || '{"cold_email_refused": true}'; end;
  begin perform log_touch(lx, 'call', 'out', 'selftest pitch', null, null); out := out || '{"cold_call_refused": false}';
  exception when sqlstate 'RS002' then out := out || '{"cold_call_refused": true}'; end;
  begin perform log_touch(lx, 'dm', 'out', 'selftest pitch', null, '   '); out := out || '{"blank_override_refused": false}';
  exception when sqlstate 'RS002' then out := out || '{"blank_override_refused": true}'; end;
  begin insert into gtm_touches (lead_id, kind, direction, summary) values (lx, 'email', 'out', 'selftest direct insert'); out := out || '{"direct_insert_refused": false}';
  exception when sqlstate 'RS002' then out := out || '{"direct_insert_refused": true}'; end;
  tid := log_touch(lx, 'dm', 'out', 'selftest pitch', ' ', 'selftest: vendor asked for the pitch');
  out := out || jsonb_build_object('override_accepted', tid is not null,
    'override_stored', (select override_reason from gtm_touches where id = tid), 'blank_url_stored_null', (select evidence_url is null from gtm_touches where id = tid));
  out := out || jsonb_build_object('reply_out_accepted', log_touch(lx, 'reply', 'out', 'selftest reply', null, null) is not null,
    'ops_out_accepted', log_touch(lx, 'ops', 'out', 'selftest vendor request', null, null) is not null,
    'dm_in_accepted', log_touch(lx, 'dm', 'in', 'selftest inbound', null, null) is not null);
  begin update gtm_touches set summary = 'edited' where id = tid; out := out || '{"touch_update_refused": false}';
  exception when others then out := out || '{"touch_update_refused": true}'; end;
  begin delete from gtm_touches where id = tid; out := out || '{"touch_delete_refused": false}';
  exception when others then out := out || '{"touch_delete_refused": true}'; end;
  -- idempotency: a retry after a lost response returns the recorded touch; other content under the same id is refused
  ti := log_touch(lx, 'ops', 'out', 'selftest idempotent touch', null, null, '__selftest_req_1__');
  out := out || jsonb_build_object('touch_retry_same_id', log_touch(lx, 'ops', 'out', 'selftest idempotent touch', ' ', ' ', '__selftest_req_1__') = ti,
    'touch_retry_rows', (select count(*) from gtm_touches where request_id = '__selftest_req_1__'));
  begin perform log_touch(lx, 'ops', 'out', 'selftest other content', null, null, '__selftest_req_1__'); out := out || '{"touch_reuse_refused": false}';
  exception when unique_violation then out := out || '{"touch_reuse_refused": true}'; end;
  out := out || jsonb_build_object('blank_request_id_not_deduped',
    log_touch(lx, 'ops', 'out', 'selftest no key', null, null, '  ') <> log_touch(lx, 'ops', 'out', 'selftest no key', null, null, '  '));
  tr := log_touch(lx, 'dm', 'out', 'selftest pitch', null, 'selftest: vendor asked for the pitch', '__selftest_req_2__');

  -- not evidence: pending, unresolved_by_platform, a test market, a tenant market
  insert into tenants (display_name) values ('__selftest_gtm_tenant__') returning id into t;
  execute mk into m_pend using '__selftest_gtm_pend__', null::uuid, 'open';
  execute mk into m_unres using '__selftest_gtm_unres__', null::uuid, 'open';
  execute mk into m_test using '__selftest_gtm_test__', null::uuid, 'open';
  update markets set is_test = true where id = m_test;
  execute mk into m_ten using '__selftest_gtm_ten__', t, 'open';
  execute rs using '__selftest_gtm_r_pend__', m_pend; execute rc using '__selftest_gtm_r_pend__', m_pend, null::text, 'pending';
  execute rs using '__selftest_gtm_r_unres__', m_unres; execute rc using '__selftest_gtm_r_unres__', m_unres, null::text, 'unresolved_by_platform';
  execute rs using '__selftest_gtm_r_test__', m_test; execute rc using '__selftest_gtm_r_test__', m_test, 'OPTION_A', 'agree';
  execute rs using '__selftest_gtm_r_ten__', m_ten; execute rc using '__selftest_gtm_r_ten__', m_ten, 'OPTION_A', 'agree';
  begin perform log_touch(lc, 'dm', 'out', 'selftest pitch', null, null); out := out || '{"non_evidence_refused": false}';
  exception when sqlstate 'RS002' then out := out || '{"non_evidence_refused": true}'; end;
  -- evidence: a settled reconciliation on a public non-test shadow market of the lead's platform
  execute mk into m_ok using '__selftest_gtm_ok__', null::uuid, 'open';
  execute rs using '__selftest_gtm_r_ok__', m_ok; execute rc using '__selftest_gtm_r_ok__', m_ok, 'OPTION_A', 'abstained';
  out := out || jsonb_build_object('evidence_accepted', log_touch(lc, 'dm', 'out', 'selftest evidence-led pitch', null, null) is not null);
  update leads set deleted_at = now() where id = lx;
  begin perform log_touch(lx, 'reply', 'out', 'selftest reply', null, null); out := out || '{"deleted_lead_refused": false}';
  exception when sqlstate 'RS002' then out := out || '{"deleted_lead_refused": true}'; end;
  out := out || jsonb_build_object('touch_retry_after_lead_deleted',
    log_touch(lx, 'dm', 'out', 'selftest pitch', null, 'selftest: vendor asked for the pitch', '__selftest_req_2__') = tr);

  -- follow_market
  insert into tenants (display_name) values ('__selftest_gtm_follower__') returning id into tt;
  execute mk into f1 using '__selftest_gtm_f1__', null::uuid, 'open';
  execute mk into f2 using '__selftest_gtm_f2__', null::uuid, 'open';
  execute mk into f_closed using '__selftest_gtm_closed__', null::uuid, 'resolved';
  out := out || jsonb_build_object('follow_first', follow_market(tt, f1, 1)->>'result', 'follow_again', follow_market(tt, f1, 1)->>'result',
    'follow_over_cap', follow_market(tt, f2, 1)->>'result', 'follow_unlimited', follow_market(tt, f2, null)->>'result',
    'follow_active', (follow_market(tt, f2, null)->>'active')::int,
    'follow_test', follow_market(tt, m_test, null)->>'result', 'follow_tenant_market', follow_market(tt, m_ten, null)->>'result',
    'follow_closed', follow_market(tt, f_closed, null)->>'reason', 'follow_missing', follow_market(tt, gen_random_uuid(), null)->>'result');
  begin perform follow_market(tt, f1, -1); out := out || '{"negative_cap_refused": false}';
  exception when others then out := out || '{"negative_cap_refused": true}'; end;
  begin perform follow_market(gen_random_uuid(), f1, null); out := out || '{"unknown_tenant_refused": false}';
  exception when others then out := out || '{"unknown_tenant_refused": true}'; end;
  begin insert into market_follows (tenant_id, market_id) values (tt, f1); out := out || '{"second_active_refused": false}';
  exception when unique_violation then out := out || '{"second_active_refused": true}'; end;
  update market_follows set deleted_at = now() where tenant_id = tt and market_id = f1 and deleted_at is null;
  res := follow_market(tt, f1, 2);
  select count(*) into n from market_follows where tenant_id = tt and market_id = f1;
  out := out || jsonb_build_object('refollow_after_unfollow', res->>'result', 'follow_rows_kept', n);
  -- the cap counts follows of open markets: tt follows f1 and f2 (both open), so a third is over a cap of 2 until f2 settles
  execute mk into f3 using '__selftest_gtm_f3__', null::uuid, 'open';
  out := out || jsonb_build_object('follow_cap_open_only_before', follow_market(tt, f3, 2)->>'result');
  update markets set status = 'resolved' where id = f2;
  res := follow_market(tt, f3, 2);
  out := out || jsonb_build_object('follow_settled_frees_slot', res->>'result', 'follow_counted_after_settle', (res->>'active')::int);

  -- follow_entitlements: key facts and ranks (created_at set explicitly: now() is one value inside this transaction)
  insert into tenants (display_name) values ('__selftest_gtm_entitled__') returning id into te;
  execute mk into e1 using '__selftest_gtm_e1__', null::uuid, 'open';
  execute mk into e2 using '__selftest_gtm_e2__', null::uuid, 'open';
  execute mk into e3 using '__selftest_gtm_e3__', null::uuid, 'open';
  insert into market_follows (tenant_id, market_id, created_at)
    values (te, e1, now() - interval '3 hours'), (te, e2, now() - interval '2 hours'), (te, e3, now() - interval '1 hour');
  out := out || jsonb_build_object('ent_plan', (select plan from follow_entitlements(e1) where tenant_id = te),
    'ent_no_key', (select live_key from follow_entitlements(e1) where tenant_id = te));
  insert into api_keys (tenant_id, key_hash, key_prefix, expires_at) values (te, '__selftest_gtm_h1__', 'rsl_test_sel...', now() - interval '1 minute');
  insert into api_keys (tenant_id, key_hash, key_prefix, revoked_at) values (te, '__selftest_gtm_h2__', 'rsl_test_sel...', now());
  out := out || jsonb_build_object('ent_expired_or_revoked', (select live_key from follow_entitlements(e1) where tenant_id = te));
  insert into api_keys (tenant_id, key_hash, key_prefix, expires_at) values (te, '__selftest_gtm_h3__', 'rsl_test_sel...', now() + interval '1 day');
  out := out || jsonb_build_object('ent_live_key', (select live_key from follow_entitlements(e1) where tenant_id = te),
    'ent_ranks', jsonb_build_array((select open_rank from follow_entitlements(e1) where tenant_id = te),
      (select open_rank from follow_entitlements(e2) where tenant_id = te), (select open_rank from follow_entitlements(e3) where tenant_id = te)));
  update markets set status = 'resolved' where id = e1;   -- e1 keeps its rank for its own reveal; e2 and e3 move up
  out := out || jsonb_build_object('ent_ranks_after_settle', jsonb_build_array((select open_rank from follow_entitlements(e1) where tenant_id = te),
      (select open_rank from follow_entitlements(e2) where tenant_id = te), (select open_rank from follow_entitlements(e3) where tenant_id = te)),
    'ent_one_tenant', (select count(*) from follow_entitlements(e2, te)), 'ent_other_tenant', (select count(*) from follow_entitlements(e2, tt)));
  update tenants set deleted_at = now() where id = te;
  out := out || jsonb_build_object('ent_deleted_tenant', (select count(*) from follow_entitlements(e2)));
  begin
    set local role anon;
    begin perform log_touch(lc, 'reply', 'out', 'anon', null, null); out := out || '{"anon_log_touch_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_log_touch_denied": true}'; end;
    begin perform follow_market(tt, f1, null); out := out || '{"anon_follow_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_follow_denied": true}'; end;
    begin perform 1 from follow_entitlements(f1); out := out || '{"anon_entitlements_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_entitlements_denied": true}'; end;
    begin perform 1 from leads limit 1; out := out || '{"anon_leads_denied": false}';
    exception when insufficient_privilege then out := out || '{"anon_leads_denied": true}'; end;
    reset role;
  exception when others then out := out || jsonb_build_object('anon_log_touch_denied', 'set role failed: ' || sqlerrm);
  end;
  raise exception 'SELFTEST_GTM %', out::text;
end $$;`;

async function main() {
  const block = `
do $$
declare t uuid; k uuid; r1 record; r2 record; r3 record; r4 record; ref1 int; ref2 int; d1 record; d2 record; d3 record; out jsonb;
begin
  insert into tenants (display_name, wallet_address, credits_balance) values ('__selftest_tx__', '0x00000000000000000000000000000000000000aa', 7) returning id into t;
  insert into api_keys (tenant_id, key_hash, key_prefix) values (t, 'h', 'rsl_test_x...') returning id into k;
  select * into r1 from begin_resolution(t, k, 'idem-1', 5, null, 'eval');
  select * into r2 from begin_resolution(t, k, 'idem-1', 5, null, 'eval');   -- replay, no second charge
  select * into r3 from begin_resolution(t, k, 'idem-2', 5, null, 'eval');   -- only 2 credits left -> ok=false
  select * into r4 from begin_resolution(t, k, null, 0, null, 'eval');       -- free precheck path, no ledger row
  ref1 := refund_credits(r1.request_id);
  ref2 := refund_credits(r1.request_id);                                      -- second refund is a no-op
  select * into d1 from credit_from_deposit('0xABC', 3, '0x00000000000000000000000000000000000000aa', '0xdead', 2.5, 100, 200, 100);
  select * into d2 from credit_from_deposit('0xABC', 3, '0x00000000000000000000000000000000000000aa', '0xdead', 2.5, 100, 200, 100); -- duplicate
  select * into d3 from credit_from_deposit('0xDEF', 0, '0x00000000000000000000000000000000000000bb', '0xdead', 1, 100, 200, 100);   -- unmatched wallet
  out := jsonb_build_object(
    'r1', jsonb_build_object('replayed', r1.replayed, 'ok', r1.ok, 'balance', r1.balance, 'charged', r1.charged),
    'r2', jsonb_build_object('replayed', r2.replayed, 'ok', r2.ok, 'same_id', r2.request_id = r1.request_id, 'charged', r2.charged),
    'r3', jsonb_build_object('replayed', r3.replayed, 'ok', r3.ok, 'balance', r3.balance),
    'r4', jsonb_build_object('ok', r4.ok, 'charged', r4.charged),
    'charge_rows', (select count(*) from credit_ledger where tenant_id = t and reason = 'charge'),
    'refund1', ref1, 'refund2', ref2,
    'refund_rows', (select count(*) from credit_ledger where tenant_id = t and reason = 'refund'),
    'pending_stubs_left', (select count(*) from resolutions where tenant_id = t and status_row = 'pending' and idempotency_key = 'idem-2'),
    'deposit1', d1.status, 'deposit1_credits', d1.credits, 'deposit2', d2.status, 'deposit3', d3.status,
    'final_balance', (select credits_balance from tenants where id = t));
  raise exception 'SELFTEST %', out::text;
end $$;`;
  const r = await rollbackBlock("SELFTEST", block);
  if (!r) process.exit(1);
  const expect: Record<string, unknown> = {
    "r1.replayed": false, "r1.ok": true, "r1.balance": 2, "r1.charged": 5,
    "r2.replayed": true, "r2.ok": true, "r2.same_id": true, "r2.charged": 5,
    "r3.replayed": false, "r3.ok": false, "r3.balance": 2,
    "r4.ok": true, "r4.charged": 0,
    "charge_rows": 1, "refund1": 5, "refund2": 0, "refund_rows": 1, "pending_stubs_left": 0,
    "deposit1": "credited", "deposit1_credits": 250, "deposit2": "duplicate", "deposit3": "unmatched",
    "final_balance": 257,
  };
  let bad = check(r, expect);
  console.log("rolled back: nothing persisted from the DO block");

  const p2a = await rollbackBlock("SELFTEST_P2A", P2A_BLOCK);
  if (!p2a) process.exit(1);
  bad += check(p2a, {
    smoke_insert_is_test: true,
    pending_failed_attempt_allowed: true, pending_sha_change_refused: true, pending_committed_change_refused: true,
    pending_to_none_refused: true, posted_without_receipt_refused: true, pending_to_posted_allowed: true,
    second_update_after_posted_refused: true, posted_delete_refused: true, pending_delete_refused: true,
    is_test_locked_after_commit: true, reveal_update_allowed: true,
    // snapshot before any row: one market with two commits counts once (its final agree, not the earlier abstention);
    // the test market's resolution, commit and final agree never count
    view_reconciled_delta: 1, view_abstained_delta: 0, view_correct_delta: 1, view_committed_delta: 1, view_shadowed_delta: 1,
    second_final_refused: true, anon_view_denied: true,
    settle_two_finals_refused: true, settle_result: "settled", settle_rows: 3, settle_reveals: 1, settle_final: "__selftest_p2a_s3__",
    settle_status: "resolved", settle_watch_active: false, settle_again: "not_open", late_commit_refused: true, defer_closed_market: 0,
    changed_result: "commits_changed", changed_status: "open", changed_watch_active: false, changed_rows: 0,
    await_result: "awaiting_watch", await_status: "open", await_watch_active: true,
    defer_keeps_first_seen: true, defer_attempts: 3, defer_next_at: true, waived_result: "settled",
    anon_settle_denied: true, anon_defer_denied: true,
  });
  console.log("rolled back: nothing persisted from the P2a block");

  const ops = await rollbackBlock("SELFTEST_OPS", OPS_BLOCK);
  if (!ops) process.exit(1);
  bad += check(ops, {
    throw_returns: 0, throw_outcome: "failure", throw_sqlstate: "22P02", throw_has_error: true,
    dispatch_failures_is_count: true, bad_window_refused: true, anon_dispatch_failures_denied: true, anon_select_due_watches_denied: true,
  });
  console.log("rolled back: nothing persisted from the ops block");

  const gtm = await rollbackBlock("SELFTEST_GTM", GTM_BLOCK);
  if (!gtm) process.exit(1);
  bad += check(gtm, {
    custom_prior_evidence: false,
    cold_dm_refused: true, cold_email_refused: true, cold_call_refused: true, blank_override_refused: true, direct_insert_refused: true,
    override_accepted: true, override_stored: "selftest: vendor asked for the pitch", blank_url_stored_null: true,
    reply_out_accepted: true, ops_out_accepted: true, dm_in_accepted: true, touch_update_refused: true, touch_delete_refused: true,
    touch_retry_same_id: true, touch_retry_rows: 1, touch_reuse_refused: true, blank_request_id_not_deduped: true,
    non_evidence_refused: true, evidence_accepted: true, deleted_lead_refused: true, touch_retry_after_lead_deleted: true,
    follow_first: "followed", follow_again: "already_following", follow_over_cap: "cap_reached", follow_unlimited: "followed", follow_active: 2,
    follow_test: "not_followable", follow_tenant_market: "not_followable", follow_closed: "market is resolved", follow_missing: "not_followable",
    negative_cap_refused: true, unknown_tenant_refused: true, second_active_refused: true, refollow_after_unfollow: "followed", follow_rows_kept: 2,
    follow_cap_open_only_before: "cap_reached", follow_settled_frees_slot: "followed", follow_counted_after_settle: 2,
    ent_plan: "free", ent_no_key: false, ent_expired_or_revoked: false, ent_live_key: true, ent_ranks: [1, 2, 3], ent_ranks_after_settle: [1, 1, 2],
    ent_one_tenant: 1, ent_other_tenant: 0, ent_deleted_tenant: 0,
    anon_log_touch_denied: true, anon_follow_denied: true, anon_entitlements_denied: true, anon_leads_denied: true,
  });
  console.log("rolled back: nothing persisted from the GTM block");

  // concurrency probe (persists rows on a __selftest__ tenant; tenant soft-deleted after)
  const [t] = await sql<{ id: string }>("insert into tenants (display_name, credits_balance) values ('__selftest_concurrency__', 100) returning id");
  const tid = t!.id;
  const calls = Array.from({ length: 10 }, () => sql<{ request_id: string; replayed: boolean; charged: number }>(`select * from begin_resolution('${tid}'::uuid, null, 'concurrent-key', 5, null, 'eval')`));
  const results = (await Promise.allSettled(calls)).map((x) => (x.status === "fulfilled" ? x.value[0] : { error: String(x.reason).slice(0, 80) }));
  const [cnt] = await sql<{ charges: number; balance: number }>(`select (select count(*)::int from credit_ledger where tenant_id='${tid}' and reason='charge') as charges, (select credits_balance from tenants where id='${tid}') as balance`);
  const replayed = results.filter((x: any) => x.replayed === true).length;
  const errors = results.filter((x: any) => x.error).length;
  const ok = cnt!.charges === 1 && cnt!.balance === 95 && errors === 0;
  console.log(`${ok ? "PASS" : "FAIL"} concurrency: 10 parallel calls -> charge_rows=${cnt!.charges} balance=${cnt!.balance} replayed=${replayed} errors=${errors}`);
  await sql(`update tenants set deleted_at = now() where id='${tid}'`);
  if (bad || !ok) process.exit(1);
}
// --official runs only the migration 016 block below; the default run above is unchanged.
if (!process.argv.includes("--official")) main().catch((e) => { console.error(String(e)); process.exit(1); });

// =====================================================================================================================
// official_release (migration 016): rollback-only assertions.
//   RESOLVE_SELFTEST_NON_PRODUCTION=1 pnpm tsx scripts/selftest-db.ts --official
// Kept in its own block (main's part of this file changes independently). Everything runs inside one DO block that
// always ends with RAISE, so nothing persists; still, it is refused unless the operator declares a non-production
// target, and it has never been run against production. It asserts: first print wins, revision_differs, the guard
// trigger's refusals (UPDATE of the observation, DELETE, corroboration overwrite) and its one allowance (from null),
// service_role write denial with read + RPC access, the fetch lease and its extension, and the audited re-check
// (history appended before the supersede, value untouched, history append-only, guard re-armed afterwards).
// =====================================================================================================================
const OFFICIAL_SELFTEST_SQL = `
do $$
declare r1 jsonb; r2 jsonb; r3 jsonb; c2 boolean; ext timestamptz; out jsonb := '{}'::jsonb;
  corr jsonb := '{"status":"disagree","value":3.5,"value_text":"3.5","source_url":null,"detail":"selftest","checked_at":"2099-02-01T00:00:00Z"}';
begin
  r1 := record_official_observation('selftest_series', '2099-01', 3.4, '3.4', 'SELFTEST - JANUARY 2099: 3.4', 'https://www.bls.gov/selftest', repeat('a', 64), corr, '{}'::jsonb);
  r2 := record_official_observation('selftest_series', '2099-01', 3.6, '3.6', 'SELFTEST revised', 'https://www.bls.gov/selftest2', repeat('b', 64), null, '{}'::jsonb);
  r3 := record_official_observation('selftest_series', '2099-01', 3.4, '3.4', 'SELFTEST again', 'https://www.bls.gov/selftest', repeat('a', 64), null, '{}'::jsonb);
  out := out || jsonb_build_object('first_inserted', r1->'inserted', 'second_inserted', r2->'inserted', 'second_revision_differs', r2->'revision_differs',
    'second_returns_first_value', r2->'value', 'second_keeps_first_text', r2->>'deciding_text', 'third_revision_differs', r3->'revision_differs');

  begin update official_observations set value = 9 where series = 'selftest_series';
    out := out || '{"update_value":"allowed"}';
  exception when others then out := out || jsonb_build_object('update_value', case when sqlerrm like '%immutable%' then 'refused' else 'error: ' || sqlerrm end); end;
  begin delete from official_observations where series = 'selftest_series';
    out := out || '{"delete":"allowed"}';
  exception when others then out := out || jsonb_build_object('delete', case when sqlerrm like '%never deleted%' then 'refused' else 'error: ' || sqlerrm end); end;
  begin update official_observations set corroboration = '{"status":"agree"}' where series = 'selftest_series' and period = '2099-01';
    out := out || '{"overwrite_corroboration":"allowed"}';
  exception when others then out := out || jsonb_build_object('overwrite_corroboration', case when sqlerrm like '%already set%' then 'refused' else 'error: ' || sqlerrm end); end;
  perform record_official_observation('selftest_series', '2099-02', 1.0, '1.0', 'SELFTEST - FEBRUARY 2099', 'https://www.bls.gov/selftest', repeat('c', 64), null, '{}'::jsonb);
  begin update official_observations set corroboration = '{"status":"unavailable"}' where series = 'selftest_series' and period = '2099-02';
    out := out || '{"set_from_null":"allowed"}';
  exception when others then out := out || jsonb_build_object('set_from_null', 'error: ' || sqlerrm); end;

  begin
    set local role service_role;
    begin insert into official_observations (series, period, value, value_text, deciding_text, source_url, raw_sha256)
            values ('selftest_series', '2099-03', 1, '1', 'x', 'https://www.bls.gov/x', repeat('d', 64));
      out := out || '{"service_role_insert":"allowed"}';
    exception when insufficient_privilege then out := out || '{"service_role_insert":"denied"}'; end;
    begin update official_observations set corroboration = null where series = 'selftest_series';
      out := out || '{"service_role_update":"allowed"}';
    exception when insufficient_privilege then out := out || '{"service_role_update":"denied"}'; end;
    begin insert into official_corroboration_history (series, period, next, actor, reason) values ('selftest_series', '2099-01', '{"status":"agree"}', 'x', 'selftest direct write');
      out := out || '{"service_role_history_insert":"allowed"}';
    exception when insufficient_privilege then out := out || '{"service_role_history_insert":"denied"}'; end;
    out := out || jsonb_build_object('service_role_select', (select count(*) from official_observations where series = 'selftest_series'),
      'service_role_rpc_claim', claim_official_fetch('selftest_series', '2099-01', 45));
    reset role;
  exception when others then out := out || jsonb_build_object('service_role_block', 'error: ' || sqlerrm);
  end;

  c2 := claim_official_fetch('selftest_series', '2099-01', 45);
  ext := extend_official_fetch('selftest_series', '2099-01', 600);
  out := out || jsonb_build_object('claim_while_leased', c2, 'extended_seconds', round(extract(epoch from ext - now())),
    'claim_after_extend', claim_official_fetch('selftest_series', '2099-01', 45));

  perform recheck_official_corroboration('selftest_series', '2099-01',
    '{"status":"agree","value":3.4,"value_text":"3.4","source_url":null,"detail":"selftest re-read","checked_at":"2099-02-02T00:00:00Z"}'::jsonb,
    'selftest', 'selftest re-check of a disagreement');
  out := out || jsonb_build_object(
    'recheck_status', (select corroboration->>'status' from official_observations where series = 'selftest_series' and period = '2099-01'),
    'recheck_value_untouched', (select value from official_observations where series = 'selftest_series' and period = '2099-01'),
    'history_rows', (select count(*) from official_corroboration_history where series = 'selftest_series'),
    'history_previous_status', (select previous->>'status' from official_corroboration_history where series = 'selftest_series' order by id limit 1));
  begin update official_corroboration_history set reason = 'tampered with' where series = 'selftest_series';
    out := out || '{"history_update":"allowed"}';
  exception when others then out := out || jsonb_build_object('history_update', case when sqlerrm like '%append-only%' then 'refused' else 'error: ' || sqlerrm end); end;
  begin perform recheck_official_corroboration('selftest_series', '2099-01', '{"status":"probably"}'::jsonb, 'selftest', 'selftest unknown status');
    out := out || '{"recheck_bad_status":"allowed"}';
  exception when others then out := out || jsonb_build_object('recheck_bad_status', case when sqlerrm like '%known status%' then 'refused' else 'error: ' || sqlerrm end); end;
  begin update official_observations set corroboration = '{"status":"disagree"}' where series = 'selftest_series' and period = '2099-01';
    out := out || '{"overwrite_after_recheck":"allowed"}';
  exception when others then out := out || jsonb_build_object('overwrite_after_recheck', case when sqlerrm like '%already set%' then 'refused' else 'error: ' || sqlerrm end); end;
  raise exception 'SELFTEST_OFFICIAL %', out::text;
end $$;`;

const OFFICIAL_SELFTEST_EXPECT: Record<string, unknown> = {
  first_inserted: true, second_inserted: false, second_revision_differs: true, second_returns_first_value: 3.4, second_keeps_first_text: "SELFTEST - JANUARY 2099: 3.4", third_revision_differs: false,
  update_value: "refused", delete: "refused", overwrite_corroboration: "refused", set_from_null: "allowed",
  service_role_insert: "denied", service_role_update: "denied", service_role_history_insert: "denied", service_role_select: 2, service_role_rpc_claim: true,
  claim_while_leased: false, extended_seconds: 600, claim_after_extend: false,
  recheck_status: "agree", recheck_value_untouched: 3.4, history_rows: 1, history_previous_status: "disagree",
  history_update: "refused", recheck_bad_status: "refused", overwrite_after_recheck: "refused",
};

async function officialSelftest(): Promise<void> {
  if (process.env.RESOLVE_SELFTEST_NON_PRODUCTION !== "1") {
    console.error("selftest --official: refused. Set RESOLVE_SELFTEST_NON_PRODUCTION=1 only when SUPABASE_PROJECT_REF names a staging or local database (the block rolls back, but it is never run against production).");
    process.exit(2);
  }
  let msg = "";
  try { await sql(OFFICIAL_SELFTEST_SQL); } catch (e) { msg = String(e); }
  let inner = msg;
  const j = msg.indexOf("{");
  if (j >= 0) { try { inner = String(JSON.parse(msg.slice(j)).message ?? msg); } catch { /* keep raw */ } }
  const m = inner.match(/SELFTEST_OFFICIAL (\{.*\})/s);
  if (!m) { console.error("official selftest did not return results:", msg.slice(0, 800)); process.exit(1); }
  let r: Record<string, unknown>;
  try { r = JSON.parse(m[1]!); } catch { console.error("official selftest: unreadable results", m[1]!.slice(0, 400)); process.exit(1); }
  let bad = 0;
  for (const [k, v] of Object.entries(OFFICIAL_SELFTEST_EXPECT)) {
    const ok = JSON.stringify(r[k]) === JSON.stringify(v);
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} official.${k} = ${JSON.stringify(r[k])}${ok ? "" : ` (expected ${JSON.stringify(v)})`}`);
  }
  console.log("rolled back: nothing persisted from the official DO block");
  if (bad) process.exit(1);
}
if (process.argv.includes("--official")) officialSelftest().catch((e) => { console.error(String(e)); process.exit(1); });

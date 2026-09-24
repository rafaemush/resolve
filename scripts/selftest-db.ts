/**
 * Exercises the billing RPCs, the commit-reveal trigger and the public view (migration 012), and the dispatch
 * observability of migration 013, each inside a DO block that always raises at the end, so the whole thing rolls back
 * and nothing persists. The raised message carries the assertion results. Then a real concurrency probe: 10 parallel begin_resolution calls with one
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
main().catch((e) => { console.error(String(e)); process.exit(1); });

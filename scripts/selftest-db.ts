/**
 * Exercises the billing RPCs inside a DO block that always raises at the end,
 * so the whole thing rolls back and nothing persists. The raised message
 * carries the assertion results. Then a real concurrency probe: 10 parallel
 * begin_resolution calls with one Idempotency-Key against a __selftest__
 * tenant (soft-deleted afterwards; ledger rows are append-only by design).
 */
import { loadEnv } from "./lib/env";
import { sql } from "./lib/mgmt";

loadEnv();
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
  let msg = "";
  try { await sql(block); } catch (e) { msg = String(e); }
  let inner = msg;
  const j = msg.indexOf("{");
  if (j >= 0) { try { inner = String(JSON.parse(msg.slice(j)).message ?? msg); } catch { /* keep raw */ } }
  const m = inner.match(/SELFTEST (\{.*\})/s);
  if (!m) { console.error("selftest did not return results:", msg.slice(0, 800)); process.exit(1); }
  const r = JSON.parse(m[1]!);
  const expect: Record<string, unknown> = {
    "r1.replayed": false, "r1.ok": true, "r1.balance": 2, "r1.charged": 5,
    "r2.replayed": true, "r2.ok": true, "r2.same_id": true, "r2.charged": 5,
    "r3.replayed": false, "r3.ok": false, "r3.balance": 2,
    "r4.ok": true, "r4.charged": 0,
    "charge_rows": 1, "refund1": 5, "refund2": 0, "refund_rows": 1, "pending_stubs_left": 0,
    "deposit1": "credited", "deposit1_credits": 250, "deposit2": "duplicate", "deposit3": "unmatched",
    "final_balance": 257,
  };
  let bad = 0;
  for (const [k, v] of Object.entries(expect)) {
    const got = k.includes(".") ? r[k.split(".")[0]!]?.[k.split(".")[1]!] : r[k];
    const ok = JSON.stringify(got) === JSON.stringify(v);
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} ${k} = ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(v)})`}`);
  }
  console.log("rolled back: nothing persisted from the DO block");

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

/**
 * Stand-ins for migration 020's money functions, step for step in the SQL's order, over the in-memory database
 * (tests/lib/fake-db.ts): credit_from_deposit (tier rate), match_deposit, claim_low_credit_notice,
 * release_low_credit_notice, register_wallet, and the credit_ledger_low_credit_reset trigger (ledgerInsert); migration
 * 004's grant_credits with the ledger's UNIQUE(reason, request_id) (idx_ledger_reason_request); and migration 022's
 * charge_read (proven on Postgres by scripts/selftest/prints.ts). They exist
 * so the routes and jobs can be tested end to end without Postgres; the SQL itself is proven by scripts/selftest/money.ts.
 * Run inside fakeDb's rpc(): one subrequest, rolled back on error.
 */
import type { FakeDb, FakeDbOptions, Row } from "./fake-db";
import { effectiveTiers, paygCredits, parseUsdc } from "../../src/billing/tiers";

const fail = (code: string, message: string) => ({ data: null, error: { code, message } });
const table = (db: FakeDb, t: string) => (db.tables[t] ??= []);
/** numeric(18,6)::text, as match_deposit returns amount_usdc. */
const numeric6 = (v: string) => { const m = parseUsdc(v); return `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}`; };

/** payg_credits_per_usdc(): the stored tiers, else the fallback, else RS004. */
function rate(db: FakeDb, amount: string, fallback: number | null): { credits: number; rate: number } | { error: string } {
  const stored = table(db, "app_config").find((r) => r.key === "payg_tiers")?.value ?? null;
  if (stored === null && fallback === null) return { error: "payg_tiers is absent and no fallback rate was given" };
  const eff = effectiveTiers(stored, fallback ?? 1);
  if ("error" in eff) return { error: eff.error };
  const c = paygCredits(amount, eff.tiers);
  return { credits: c.credits, rate: c.credits_per_usdc };
}

/**
 * A credit_ledger insert: UNIQUE(tx_hash, log_index) and UNIQUE(reason, request_id), then the AFTER INSERT trigger (a
 * purchase or grant clears the notice).
 */
export function ledgerInsert(db: FakeDb, row: Row): Row | { error: { code: string; message: string } } {
  const ledger = table(db, "credit_ledger");
  if (row.tx_hash != null && ledger.some((l) => l.tx_hash === row.tx_hash && l.log_index === row.log_index)) return { error: { code: "23505", message: "duplicate key value violates unique constraint \"idx_ledger_tx\"" } };
  if (row.request_id != null && ledger.some((l) => l.reason === row.reason && l.request_id === row.request_id)) return { error: { code: "23505", message: "duplicate key value violates unique constraint \"idx_ledger_reason_request\"" } };
  const r = { id: ledger.length + 1, created_at: new Date().toISOString(), ...row };
  ledger.push(r);
  if (row.reason === "purchase" || row.reason === "grant") {
    const t = table(db, "tenants").find((x) => x.id === row.tenant_id);
    if (t) t.low_credit_notified_at = null;
  }
  return r;
}

export async function creditFromDeposit(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  if (a.p_block > a.p_safe_block) return fail("P0001", `deposit block ${a.p_block} is above safe block ${a.p_safe_block}`);
  const deposits = table(db, "usdc_deposits");
  const tx = String(a.p_tx_hash).toLowerCase();
  if (deposits.some((d) => d.tx_hash === tx && d.log_index === a.p_log_index)) return { data: [{ status: "duplicate", tenant_id: null, credits: 0 }], error: null };
  const dep: Row = { tx_hash: tx, log_index: a.p_log_index, from_address: String(a.p_from).toLowerCase(), amount_usdc: String(a.p_amount_usdc), status: "seen", tenant_id: null, ledger_id: null, credits_per_usdc: null };
  deposits.push(dep);
  const r = rate(db, dep.amount_usdc, a.p_credits_per_usdc);
  if ("error" in r) return fail("RS004", r.error);
  if (r.credits < 1) { dep.status = "dust"; return { data: [{ status: "dust", tenant_id: null, credits: 0 }], error: null }; }
  const tenant = table(db, "tenants").find((t) => t.wallet_address === dep.from_address && !t.deleted_at);
  if (!tenant) { dep.status = "unmatched"; return { data: [{ status: "unmatched", tenant_id: null, credits: 0 }], error: null }; }
  tenant.credits_balance += r.credits;
  const l = ledgerInsert(db, { tenant_id: tenant.id, delta: r.credits, reason: "purchase", tx_hash: tx, log_index: a.p_log_index, balance_after: tenant.credits_balance, request_id: null });
  if ("error" in l) return { data: null, error: l.error };
  Object.assign(dep, { status: "credited", tenant_id: tenant.id, ledger_id: l.id, credits_per_usdc: r.rate });
  return { data: [{ status: "credited", tenant_id: tenant.id, credits: r.credits }], error: null };
}

export async function matchDeposit(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const tx = String(a.p_tx_hash ?? "").trim().toLowerCase();
  const actor = String(a.p_actor ?? "").trim(), reason = String(a.p_reason ?? "").trim();
  if (!actor || !reason || !a.p_tenant || a.p_log_index == null || !tx) return fail("22023", "match_deposit: tx_hash, log_index, tenant, actor and reason are all required");
  const dep = table(db, "usdc_deposits").find((d) => d.tx_hash === tx && d.log_index === a.p_log_index);
  if (!dep) return fail("P0002", `match_deposit: no deposit ${tx}#${a.p_log_index} has been seen`);
  if (dep.status === "credited") {
    if (dep.tenant_id !== a.p_tenant) return fail("RS003", `match_deposit: deposit ${tx}#${a.p_log_index} is already credited to another tenant (${dep.tenant_id})`);
    const l = table(db, "credit_ledger").find((x) => x.id === dep.ledger_id)!;
    return { data: [{ status: "credited", tenant_id: dep.tenant_id, credits: l.delta, balance_after: l.balance_after, amount_usdc: numeric6(dep.amount_usdc), credits_per_usdc: dep.credits_per_usdc, replayed: true }], error: null };
  }
  if (dep.status !== "unmatched") return fail("RS003", `match_deposit: deposit ${tx}#${a.p_log_index} is ${dep.status}; only an unmatched deposit can be matched`);
  const r = rate(db, dep.amount_usdc, null);
  if ("error" in r) return fail("RS004", r.error);
  if (r.credits < 1) return fail("RS003", `match_deposit: deposit ${tx}#${a.p_log_index} is worth less than one credit`);
  const tenant = table(db, "tenants").find((t) => t.id === a.p_tenant && !t.deleted_at);
  if (!tenant) return fail("P0002", `match_deposit: tenant ${a.p_tenant} not found or deleted`);
  tenant.credits_balance += r.credits;
  const l = ledgerInsert(db, { tenant_id: tenant.id, delta: r.credits, reason: "purchase", tx_hash: tx, log_index: a.p_log_index, balance_after: tenant.credits_balance, request_id: null, note: `matched by ${actor}: ${reason}` });
  if ("error" in l) return { data: null, error: l.error };
  const now = new Date().toISOString();
  Object.assign(dep, { status: "credited", tenant_id: tenant.id, ledger_id: l.id, credits_per_usdc: r.rate, matched_by: actor, match_reason: reason, matched_at: now });
  return { data: [{ status: "credited", tenant_id: tenant.id, credits: r.credits, balance_after: tenant.credits_balance, amount_usdc: numeric6(dep.amount_usdc), credits_per_usdc: r.rate, replayed: false }], error: null };
}

/** grant_credits (migration 004): the balance moves and one ledger row records it, or neither (the rpc rolls back). */
export async function grantCredits(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const tenants = table(db, "tenants");
  if (a.p_amount === 0) return { data: tenants.find((t) => t.id === a.p_tenant)?.credits_balance ?? null, error: null };
  const t = tenants.find((x) => x.id === a.p_tenant && !x.deleted_at);
  if (!t) return fail("P0001", `tenant ${a.p_tenant} not found or insufficient balance for negative grant`);
  if ((t.credits_balance ?? 0) + a.p_amount < 0) return fail("23514", "new row for relation \"tenants\" violates check constraint \"tenants_credits_balance_check\"");
  t.credits_balance = (t.credits_balance ?? 0) + a.p_amount;
  const l = ledgerInsert(db, { tenant_id: t.id, delta: a.p_amount, reason: a.p_amount > 0 ? "grant" : "adjustment", request_id: a.p_request_id ?? null, balance_after: t.credits_balance, note: a.p_note });
  if ("error" in l) return { data: null, error: l.error };
  return { data: t.credits_balance, error: null };
}

/**
 * charge_read (migration 022), step for step: the argument checks (22023), a replay when this request id's charge
 * already stands (another tenant's: RS003), else the conditional debit (a short balance or a deleted tenant: ok false,
 * nothing written) and one 'charge' ledger row under UNIQUE(reason, request_id).
 */
export async function chargeRead(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  if (!a.p_tenant || a.p_amount == null || a.p_amount < 1) return fail("22023", `charge_read: tenant and a positive amount are required, got amount ${a.p_amount}`);
  if (typeof a.p_request_id !== "string" || !/^[a-z_]+:.+/.test(a.p_request_id) || a.p_request_id.length > 300) return fail("22023", 'charge_read: request_id must be "<kind>:<id>" (at most 300 characters)');
  const tenants = table(db, "tenants");
  const balanceOf = (live: boolean) => tenants.find((t) => t.id === a.p_tenant && (!live || !t.deleted_at))?.credits_balance ?? null;
  const led = table(db, "credit_ledger").find((l) => l.reason === "charge" && l.request_id === a.p_request_id);
  if (led) {
    if (led.tenant_id !== a.p_tenant) return fail("RS003", "charge_read: this request id was charged to another tenant");
    return { data: [{ ok: true, replayed: true, charged: 0, balance: balanceOf(false) }], error: null };
  }
  const t = tenants.find((x) => x.id === a.p_tenant && !x.deleted_at && x.credits_balance >= a.p_amount);
  if (!t) return { data: [{ ok: false, replayed: false, charged: 0, balance: balanceOf(true) ?? 0 }], error: null };
  t.credits_balance -= a.p_amount;
  const l = ledgerInsert(db, { tenant_id: t.id, delta: -a.p_amount, reason: "charge", request_id: a.p_request_id, balance_after: t.credits_balance, note: "read" });
  if ("error" in l) return { data: null, error: l.error };
  return { data: [{ ok: true, replayed: false, charged: a.p_amount, balance: t.credits_balance }], error: null };
}

export async function claimLowCreditNotice(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const raw = table(db, "app_config").find((r) => r.key === "low_credit_threshold")?.value;
  if (raw !== undefined && !/^\d{1,9}$/.test(String(raw).trim())) return fail("RS004", `app_config low_credit_threshold must be a whole number of credits, got ${raw}`);
  const threshold = raw === undefined ? 500 : Number(raw);
  const t = table(db, "tenants").find((x) => x.id === a.p_tenant);
  if (t && !t.deleted_at && !t.low_credit_notified_at && t.credits_balance < threshold) {
    t.low_credit_notified_at = new Date().toISOString();
    return { data: [{ crossed: true, balance: t.credits_balance, threshold }], error: null };
  }
  return { data: [{ crossed: false, balance: t?.credits_balance ?? null, threshold }], error: null };
}

export async function releaseLowCreditNotice(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const t = table(db, "tenants").find((x) => x.id === a.p_tenant);
  if (t) t.low_credit_notified_at = null;
  return { data: null, error: null };
}

export async function registerWallet(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const answer = (result: string, address: string | null = null, previous: string | null = null) => ({ data: [{ result, address, previous_address: previous }], error: null });
  const ch = table(db, "wallet_challenges").find((w) => w.id === a.p_challenge && w.tenant_id === a.p_tenant);
  if (!ch) return answer("not_found");
  if (ch.used_at) return answer("used", ch.address);
  if (Date.parse(ch.expires_at) <= Date.now()) return answer("expired", ch.address);
  const tenants = table(db, "tenants");
  if (tenants.some((t) => t.wallet_address === ch.address && t.id !== a.p_tenant)) return answer("taken", ch.address);
  const t = tenants.find((x) => x.id === a.p_tenant && !x.deleted_at);
  if (!t) return answer("not_found");
  const previous = t.wallet_address && t.wallet_address !== ch.address ? t.wallet_address : null;
  t.wallet_address = ch.address;
  Object.assign(ch, { used_at: new Date().toISOString(), replaced_address: previous });
  return answer("registered", ch.address, previous);
}

export const MONEY_RPCS: NonNullable<FakeDbOptions["rpc"]> = {
  credit_from_deposit: creditFromDeposit, match_deposit: matchDeposit, claim_low_credit_notice: claimLowCreditNotice,
  release_low_credit_notice: releaseLowCreditNotice, register_wallet: registerWallet, grant_credits: grantCredits, charge_read: chargeRead,
};

/** The app_config rows migration 020 inserts. */
export const MIGRATION_020_CONFIG: Row[] = [
  { key: "payg_tiers", value: '[{"min_usdc":1000,"credits_per_usdc":120},{"min_usdc":250,"credits_per_usdc":110},{"min_usdc":0,"credits_per_usdc":100}]' },
  { key: "low_credit_threshold", value: "500" },
];

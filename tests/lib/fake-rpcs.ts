/**
 * Stand-ins for migration 012's settle_market() and defer_reconcile() and migration 014's follow_market() and
 * follow_entitlements(), step for step in the SQL's order, over the in-memory database (tests/lib/fake-db.ts). They
 * exist so reconcile runs and the follow routes can be tested end to end without Postgres; the SQL itself is proven by
 * scripts/selftest-db.ts. Run inside fakeDb's rpc(): one subrequest, rolled back on error.
 */
import type { FakeDb, FakeDbOptions, Row } from "./fake-db";

/** uq_reconciliations_final: one final reconciliation per market. */
export const RECONCILIATION_FINAL: NonNullable<FakeDbOptions["partialUnique"]> = {
  reconciliations: [{ name: "uq_reconciliations_final", col: "market_id", where: (r) => r.final === true }],
};

const fail = (message: string) => ({ data: null, error: { code: "P0001", message } });

export async function settleMarket(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  if (!["resolved", "void", "closed_unresolved"].includes(a.p_status)) return fail(`settle_market: ${a.p_status} is not a terminal status`);
  const m = (db.tables.markets ?? []).find((x) => x.id === a.p_market);
  if (!m) return fail(`settle_market: no market ${a.p_market}`);
  const watches = (db.tables.watches ?? []).filter((w) => w.market_id === m.id);
  if (m.status !== "open") { for (const w of watches) w.active = false; return { data: { result: "not_open", status: m.status }, error: null }; }
  const settleAfter = Date.parse(m.deadline_utc) + (m.grace_seconds ?? 3600) * 1000 + 5 * 60_000;
  const owed = watches.some((w) => w.active && !w.deleted_at && (!w.last_polled_at || Date.parse(w.last_polled_at) < settleAfter || (w.consecutive_errors ?? 0) > 0));
  if (Date.now() < settleAfter + 24 * 3600_000 && owed) return { data: { result: "awaiting_watch" }, error: null };
  for (const w of watches) w.active = false;
  const commits = (db.tables.bot_posts ?? []).filter((b) => b.market_id === m.id && b.kind === "commit");
  if (commits.some((c) => !a.p_commit_ids.includes(c.id))) return { data: { result: "commits_changed" }, error: null };

  const plan = a.p_reconciliations as Row[];
  const finals = plan.filter((r) => r.final === true);
  if (plan.length && finals.length !== 1) return fail(`settle_market: ${finals.length} final rows planned for market ${m.id} (exactly one expected)`);
  if (plan.some((r) => !commits.some((c) => c.resolution_id === r.resolution_id))) return fail(`settle_market: a planned reconciliation is not for a commit of market ${m.id}`);
  if ((a.p_reveals as Row[]).some((r) => r.channel !== "pending" && r.channel !== "none")) return fail("settle_market: a reveal is recorded pending (or none), never as already posted");

  const clear = await db.client.from("reconciliations").update({ final: false }).eq("market_id", m.id).eq("final", true)
    .in("resolution_id", (db.tables.reconciliations ?? []).filter((r) => r.market_id === m.id && r.resolution_id !== finals[0]?.resolution_id).map((r) => r.resolution_id));
  if (clear.error) return clear;
  let nRec = 0;
  for (const r of plan) {
    const exists = (db.tables.reconciliations ?? []).some((x) => x.resolution_id === r.resolution_id);
    const w = exists
      ? await db.client.from("reconciliations").update({ final: r.final }).eq("resolution_id", r.resolution_id)
      : await db.client.from("reconciliations").insert({ ...r, market_id: m.id });
    if (w.error) return w;
    nRec++;
  }
  let nRev = 0;
  for (const v of a.p_reveals as Row[]) {
    if ((db.tables.bot_posts ?? []).some((b) => b.dedup_key === v.dedup_key)) continue;
    const w = await db.client.from("bot_posts").insert({ ...v, market_id: m.id, kind: "reveal", message_id: null, telegram_date: null, posted_at: null });
    if (w.error) return w;
    nRev++;
  }
  Object.assign(m, { status: a.p_status, official_outcome: a.p_official_outcome, official_resolved_at: a.p_official_at, official_source_url: a.p_official_source_url });
  return { data: { result: "settled", reconciliations: nRec, reveals: nRev }, error: null };
}

export async function deferReconcile(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  let n = 0;
  for (const x of a.p_rows as Row[]) {
    const m = (db.tables.markets ?? []).find((r) => r.id === x.id && r.status === "open");
    if (!m) continue;
    Object.assign(m, { reconcile_next_at: x.next_at, reconcile_attempts: x.attempts, official_first_seen_at: m.official_first_seen_at ?? x.first_seen_at });
    n++;
  }
  return { data: n, error: null };
}

/** What a reconcile run calls: the settle, the deferral, and the follower read of shadow.revealed. */
export const RECONCILE_RPCS: NonNullable<FakeDbOptions["rpc"]> = { settle_market: settleMarket, defer_reconcile: deferReconcile, follow_entitlements: followEntitlements };

/** A market that counts toward a follow cap: open and not deleted (migration 014). */
const openMarket = (db: FakeDb, id: string) => (db.tables.markets ?? []).some((m) => m.id === id && m.status === "open" && !m.deleted_at);

/**
 * Stand-in for migration 014's follow_market(), step for step in the SQL's order. The inserted row carries the market
 * embedded as PostgREST's markets(...) select would return it, so reads that embed the market see it. The cap counts
 * active follows of open markets only, reading markets live.
 */
export async function followMarket(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  if (a.p_cap !== null && a.p_cap < 0) return fail(`follow_market: p_cap must be >= 0 or null (unlimited), got ${a.p_cap}`);
  if (!(db.tables.tenants ?? []).some((t) => t.id === a.p_tenant && !t.deleted_at)) return fail(`follow_market: no tenant ${a.p_tenant}`);
  const m = (db.tables.markets ?? []).find((x) => x.id === a.p_market);
  if (!m || m.deleted_at || m.tenant_id !== null || m.is_test) return { data: { result: "not_followable", reason: "not a public shadow market" }, error: null };
  if (m.status !== "open") return { data: { result: "not_followable", reason: `market is ${m.status}` }, error: null };
  const follows = (db.tables.market_follows ??= []);
  const active = follows.filter((f) => f.tenant_id === a.p_tenant && !f.deleted_at);
  const counted = active.filter((f) => openMarket(db, f.market_id)).length;
  const existing = active.find((f) => f.market_id === a.p_market);
  if (existing) return { data: { result: "already_following", follow_id: existing.id, active: counted }, error: null };
  if (a.p_cap !== null && counted >= a.p_cap) return { data: { result: "cap_reached", active: counted, cap: a.p_cap }, error: null };
  const row = { id: `follow-${follows.length + 1}`, tenant_id: a.p_tenant, market_id: m.id, created_at: new Date(Date.now() + follows.length).toISOString(), deleted_at: null,
    markets: { id: m.id, platform: m.platform, external_id: m.external_id, status: m.status, deadline_utc: m.deadline_utc, deleted_at: null } };
  follows.push(row);
  return { data: { result: "followed", follow_id: row.id, active: counted + 1 }, error: null };
}

/**
 * Stand-in for migration 014's follow_entitlements(): per active follow of p_market by a live tenant (p_tenant's only
 * when given), the plan, whether a key is live (not revoked, not deleted, not expired) and the follow's rank, oldest
 * first (created_at, id), among the tenant's active follows of open markets plus p_market.
 */
export async function followEntitlements(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const now = Date.now();
  const byAge = (x: Row, y: Row) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  const rows = (db.tables.market_follows ?? [])
    .filter((f) => f.market_id === a.p_market && !f.deleted_at && (a.p_tenant == null || f.tenant_id === a.p_tenant))
    .flatMap((f) => {
      const t = (db.tables.tenants ?? []).find((x) => x.id === f.tenant_id && !x.deleted_at);
      if (!t) return [];
      const live_key = (db.tables.api_keys ?? []).some((k) => k.tenant_id === f.tenant_id && !k.revoked_at && !k.deleted_at && (!k.expires_at || Date.parse(k.expires_at) > now));
      const open_rank = (db.tables.market_follows ?? [])
        .filter((g) => g.tenant_id === f.tenant_id && !g.deleted_at && (g.market_id === a.p_market || openMarket(db, g.market_id)) && byAge(g, f) <= 0).length;
      return [{ tenant_id: f.tenant_id, follow_id: f.id, plan: t.plan, live_key, open_rank }];
    });
  return { data: rows, error: null };
}

export const FOLLOW_RPCS: NonNullable<FakeDbOptions["rpc"]> = { follow_market: followMarket, follow_entitlements: followEntitlements };

/**
 * Stand-in for migration 023's charge_reveals(), step for step in the SQL's order, over tenants (plan, credits_balance,
 * created_at, deleted_at, low_credit_notified_at), markets (event_key, tenant_id, is_test, status), credit_ledger and
 * reveal_reads. Per pair, in (tenant, event_key, market) order: unknown_tenant, public (a settled market), included_plan,
 * grandfathered, replay (from source read, one reveal_reads row, on conflict nothing), event_cap_reached,
 * insufficient_credits, else one debit and one 'charge' row (note "reveal <source>") with the low-credit notice claimed
 * (threshold 500, as app_config's default). Errors exactly where the SQL raises.
 */
export async function chargeReveals(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const tenants: string[] = a.p_tenants ?? [], markets: string[] = a.p_markets ?? [];
  if (!(a.p_price >= 1) || !(a.p_event_cap >= a.p_price)) return { data: null, error: { code: "22023", message: "charge_reveals: a positive price and an event cap of at least the price are required" } };
  if (!["webhook", "read"].includes(a.p_source)) return { data: null, error: { code: "22023", message: `charge_reveals: p_source must be webhook or read, got ${a.p_source}` } };
  if (!a.p_pricing_from || !Array.isArray(a.p_included_plans)) return { data: null, error: { code: "22023", message: "charge_reveals: the pricing cut-over and the included plans are required" } };
  if (tenants.length !== markets.length || tenants.length > 1000) return { data: null, error: { code: "22023", message: "charge_reveals: p_tenants and p_markets are pairs, at most 1000" } };
  const ledger = (db.tables.credit_ledger ??= []);
  const mk = (id: string) => (db.tables.markets ?? []).find((m) => m.id === id);
  const pairs = [...new Map(tenants.map((t, i) => [`${t}|${markets[i]}`, { t, m: markets[i]!, ek: String(mk(markets[i]!)?.event_key ?? "") }])).values()]
    .sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : x.ek < y.ek ? -1 : x.ek > y.ek ? 1 : x.m < y.m ? -1 : x.m > y.m ? 1 : 0));
  const out: Row[] = [];
  const row = (p: { t: string; m: string }, o: Partial<Row>) => ({ tenant_id: p.t, market_id: p.m, plan: null, entitled_full: false, replayed: false, charged: 0, price: 0, balance: 0, reason: "", low_credit: null, low_credit_threshold: null, ...o });
  for (const p of pairs) {
    const m = mk(p.m);
    if (!m || m.tenant_id !== null || m.is_test) return { data: null, error: { code: "22023", message: `charge_reveals: market ${p.m} is not a public shadow market` } };
    const t = (db.tables.tenants ?? []).find((x) => x.id === p.t);
    if (!t || t.deleted_at) { out.push(row(p, { price: a.p_price, reason: "unknown_tenant" })); continue; }
    const bal = Number(t.credits_balance ?? 0);
    if (["resolved", "void", "closed_unresolved"].includes(m.status)) { out.push(row(p, { plan: t.plan, entitled_full: true, balance: bal, reason: "public" })); continue; }
    if (a.p_included_plans.includes(t.plan)) { out.push(row(p, { plan: t.plan, entitled_full: true, balance: bal, reason: "included_plan" })); continue; }
    if (t.plan === "free" && t.created_at && Date.parse(t.created_at) < Date.parse(a.p_pricing_from)) { out.push(row(p, { plan: t.plan, entitled_full: true, balance: bal, reason: "grandfathered" })); continue; }
    const id = `reveal:${p.t}:${p.m}`;
    const prior = ledger.find((l) => l.reason === "charge" && l.request_id === id);
    if (prior) {
      if (prior.tenant_id !== p.t) return { data: null, error: { code: "RS003", message: "charge_reveals: this request id was charged to another tenant" } };
      const reads = (db.tables.reveal_reads ??= []);
      if (a.p_source === "read" && !reads.some((r) => r.request_id === id)) reads.push({ request_id: id, tenant_id: p.t, first_read_at: new Date().toISOString() });
      out.push(row(p, { plan: t.plan, entitled_full: true, replayed: true, balance: bal, reason: "replay" })); continue;
    }
    const legs = (db.tables.markets ?? []).filter((x) => x.event_key === m.event_key).map((x) => `reveal:${p.t}:${x.id}`);
    const spent = ledger.filter((l) => l.reason === "charge" && legs.includes(l.request_id))
      .reduce((n, l) => n - Number(l.delta) - Number(ledger.find((r) => r.reason === "refund" && r.request_id === l.request_id)?.delta ?? 0), 0);
    const due = Math.min(a.p_price, Math.max(a.p_event_cap - spent, 0));
    if (due === 0) { out.push(row(p, { plan: t.plan, entitled_full: true, balance: bal, reason: "event_cap_reached" })); continue; }
    if (bal < due) { out.push(row(p, { plan: t.plan, price: due, balance: bal, reason: "insufficient_credits" })); continue; }
    t.credits_balance = bal - due;
    ledger.push({ id: ledger.length + 1, tenant_id: p.t, delta: -due, reason: "charge", request_id: id, balance_after: t.credits_balance, note: `reveal ${a.p_source}`, created_at: new Date().toISOString() });
    const crossed = !t.low_credit_notified_at && t.credits_balance < 500;
    if (crossed) t.low_credit_notified_at = new Date().toISOString();
    out.push(row(p, { plan: t.plan, entitled_full: true, charged: due, price: due, balance: t.credits_balance, reason: "charged", low_credit: crossed, low_credit_threshold: 500 }));
  }
  return { data: out, error: null };
}

/** Stand-in for refund_credits() (migration 004): the charge of a request id refunded once. */
export async function refundCredits(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const ledger = (db.tables.credit_ledger ??= []);
  const c = ledger.find((l) => l.reason === "charge" && l.request_id === a.p_request_id);
  if (!c || ledger.some((l) => l.reason === "refund" && l.request_id === a.p_request_id)) return { data: 0, error: null };
  const t = (db.tables.tenants ?? []).find((x) => x.id === c.tenant_id)!;
  t.credits_balance = Number(t.credits_balance) - Number(c.delta);
  ledger.push({ id: ledger.length + 1, tenant_id: c.tenant_id, delta: -c.delta, reason: "refund", request_id: a.p_request_id, balance_after: t.credits_balance, created_at: new Date().toISOString() });
  return { data: -c.delta, error: null };
}

/**
 * Stand-in for migration 023's refund_late_reveals(), in the SQL's order: every 'reveal webhook' charge not refunded yet,
 * past its deadline (its deliveries' reveal_due_at, else the charge time + p_late_minutes), none of whose deliveries was
 * attempted (first_attempt_at) or delivered at or before reveal_due_at, none still 'delivering' under a live lease (its
 * POST may be out already), and not read by the tenant (reveal_reads), refunded through refundCredits, in (tenant,
 * charge time) order. Returns {refunded, credits, failed}.
 */
export async function refundLateReveals(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const late = a.p_late_minutes ?? 10;
  const now = Date.now();
  const ledger = (db.tables.credit_ledger ??= []);
  const deliveries = db.tables.webhook_deliveries ?? [];
  let refunded = 0, credits = 0;
  const reads = db.tables.reveal_reads ?? [];
  const charges = ledger.filter((l) => l.reason === "charge" && l.note === "reveal webhook" && Date.parse(l.created_at) > now - 3 * 86_400_000)
    .sort((x, y) => (x.tenant_id < y.tenant_id ? -1 : x.tenant_id > y.tenant_id ? 1 : Date.parse(x.created_at) - Date.parse(y.created_at)));
  for (const c of charges) {
    if (ledger.some((l) => l.reason === "refund" && l.request_id === c.request_id)) continue;
    const mine = deliveries.filter((d) => d.reveal_charge_id === c.request_id);
    const due = mine.length ? Math.min(...mine.map((d) => Date.parse(d.reveal_due_at))) : Date.parse(c.created_at) + late * 60_000;
    if (now < due) continue;
    const stamped = (at: unknown) => typeof at === "string" && at !== "";
    if (mine.some((d) => (stamped(d.first_attempt_at) && Date.parse(d.first_attempt_at) <= Date.parse(d.reveal_due_at))
      || (d.status === "delivered" && Date.parse(d.delivered_at) <= Date.parse(d.reveal_due_at)))) continue;
    if (mine.some((d) => d.status === "delivering" && stamped(d.lease_until) && Date.parse(d.lease_until) > now)) continue;
    if (reads.some((r) => r.request_id === c.request_id)) continue;
    const r = await refundCredits(db, { p_request_id: c.request_id });
    if (r.data > 0) { refunded++; credits += r.data; }
  }
  return { data: { refunded, credits, failed: 0 }, error: null };
}

/**
 * Stand-in for migration 023's follow_event(), step for step: the tenant, the market (an open, non-test public shadow
 * market), its event's open public legs read once, all or nothing against p_cap (active follows of open markets), each
 * leg not yet followed inserted. Rows carry the market embedded like followMarket's.
 */
export async function followEvent(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  if (a.p_cap !== null && a.p_cap < 0) return fail(`follow_event: p_cap must be >= 0 or null (unlimited), got ${a.p_cap}`);
  if (!(db.tables.tenants ?? []).some((t) => t.id === a.p_tenant && !t.deleted_at)) return fail(`follow_event: no tenant ${a.p_tenant}`);
  const m = (db.tables.markets ?? []).find((x) => x.id === a.p_market);
  if (!m || m.deleted_at || m.tenant_id !== null || m.is_test) return { data: { result: "not_followable", reason: "not a public shadow market" }, error: null };
  if (m.status !== "open") return { data: { result: "not_followable", reason: `market is ${m.status}` }, error: null };
  const legs = (db.tables.markets ?? []).filter((x) => x.event_key === m.event_key && x.tenant_id === null && !x.is_test && !x.deleted_at && x.status === "open").map((x) => x.id).sort();
  const follows = (db.tables.market_follows ??= []);
  const active = follows.filter((f) => f.tenant_id === a.p_tenant && !f.deleted_at);
  const already = active.filter((f) => legs.includes(f.market_id)).length;
  const counted = active.filter((f) => openMarket(db, f.market_id)).length;
  const fresh = legs.length - already;
  if (a.p_cap !== null && fresh > 0 && counted + fresh > a.p_cap) return { data: { result: "cap_reached", event_key: m.event_key, legs: legs.length, already_following: already, active: counted, cap: a.p_cap }, error: null };
  let n = 0;
  for (const id of legs) {
    if (active.some((f) => f.market_id === id)) continue;
    const x = (db.tables.markets ?? []).find((y) => y.id === id)!;
    follows.push({ id: `follow-${follows.length + 1}`, tenant_id: a.p_tenant, market_id: id, created_at: new Date(Date.now() + follows.length).toISOString(), deleted_at: null,
      markets: { id, platform: x.platform, external_id: x.external_id, status: x.status, deadline_utc: x.deadline_utc, deleted_at: null } });
    n++;
  }
  return { data: { result: "followed", event_key: m.event_key, legs: legs.length, followed: n, already_following: already, active: counted + n }, error: null };
}

export const REVEAL_RPCS: NonNullable<FakeDbOptions["rpc"]> = { charge_reveals: chargeReveals, refund_credits: refundCredits, refund_late_reveals: refundLateReveals, follow_event: followEvent };

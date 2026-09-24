/**
 * Stand-ins for migration 012's settle_market() and defer_reconcile(), step for step in the SQL's order, over the
 * in-memory database (tests/lib/fake-db.ts). They exist so reconcile runs can be tested end to end without Postgres;
 * the SQL itself is proven by scripts/selftest-db.ts. Run inside fakeDb's rpc(): one subrequest, rolled back on error.
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

export const RECONCILE_RPCS: NonNullable<FakeDbOptions["rpc"]> = { settle_market: settleMarket, defer_reconcile: deferReconcile };

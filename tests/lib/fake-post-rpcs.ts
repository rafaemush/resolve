/**
 * Stand-ins for migration 017's commit_context(), claim_post_lease(), release_post_lease() and note_post_failure(),
 * step for step in the SQL's order, over the in-memory database (tests/lib/fake-db.ts). The SQL itself is proven by
 * scripts/selftest/fixes.ts. Run inside fakeDb's rpc(): one subrequest, rolled back on error.
 */
import type { FakeDb, FakeDbOptions, Row } from "./fake-db";

const fail = (message: string) => ({ data: null, error: { code: "P0001", message } });
const ts = (r: Row) => Date.parse(r.created_at);

export async function commitContext(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const markets = db.tables.markets ?? [];
  const m = markets.find((x) => x.id === a.p_market);
  if (!m) return { data: null, error: null };
  const posts = db.tables.bot_posts ?? [];
  const latest = posts.filter((b) => b.market_id === m.id && b.kind === "commit")
    .sort((x, y) => ts(y) - ts(x) || String(y.id).localeCompare(String(x.id)))[0];
  const live = (x: Row) => !x.is_test && (x.tenant_id ?? null) === null;
  // each event's first public commit; the market's event is placed after every event whose first came strictly before
  const firsts = new Map<string, number>();
  for (const b of posts.filter((p) => p.kind === "commit")) {
    const x = markets.find((y) => y.id === b.market_id);
    if (!x || !live(x)) continue;
    firsts.set(x.event_key, Math.min(firsts.get(x.event_key) ?? Infinity, ts(b)));
  }
  const own = firsts.get(m.event_key) ?? Infinity;
  return {
    data: {
      market_id: m.id,
      event_key: m.event_key,
      latest: latest ? { id: latest.id, verdict_signature: latest.payload?.verdict_signature ?? null, created_at: latest.created_at } : null,
      event_open_markets: markets.filter((o) => o.event_key === m.event_key && o.id !== m.id && o.status === "open" && !o.deleted_at && live(o)).length,
      public_events_before: [...firsts].filter(([k, first]) => k !== m.event_key && first < own).length,
    },
    error: null,
  };
}

export async function claimPostLease(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  if (!(a.p_seconds >= 1 && a.p_seconds <= 600)) return fail(`claim_post_lease: p_seconds must be between 1 and 600, got ${a.p_seconds}`);
  const posts = db.tables.bot_posts ?? [];
  const pending = posts.filter((b) => b.channel === "pending" && (b.kind === "commit" || b.kind === "reveal"));
  const counts = { pending_commits: pending.filter((b) => b.kind === "commit").length, pending_reveals: pending.filter((b) => b.kind === "reveal").length };
  if (!pending.length) return { data: { claimed: false, reason: "idle", ...counts }, error: null };
  const now = Date.now();
  const since = now - a.p_window_seconds * 1000;
  const messages = new Set(posts.filter((b) => b.channel === "telegram" && (b.kind === "commit" || b.kind === "reveal") && b.message_id != null && b.posted_at && Date.parse(b.posted_at) >= since).map((b) => b.message_id)).size;
  if (messages >= a.p_max_messages) return { data: { claimed: false, reason: "paced", messages_in_window: messages, ...counts }, error: null };
  const leases = (db.tables.post_leases ??= []);
  const l = leases.find((x) => x.channel === a.p_channel);
  if (l && Date.parse(l.lease_until) > now && l.holder !== a.p_holder) return { data: { claimed: false, reason: "busy", messages_in_window: messages, ...counts }, error: null };
  const until = new Date(now + a.p_seconds * 1000).toISOString();
  if (l) Object.assign(l, { holder: a.p_holder, lease_until: until });
  else leases.push({ channel: a.p_channel, holder: a.p_holder, lease_until: until });
  return { data: { claimed: true, lease_until: until, now: new Date(now).toISOString(), messages_in_window: messages, ...counts }, error: null };
}

export async function releasePostLease(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  const l = (db.tables.post_leases ?? []).find((x) => x.channel === a.p_channel && x.holder === a.p_holder && Date.parse(x.lease_until) > Date.now());
  if (!l) return { data: false, error: null };
  l.lease_until = new Date().toISOString();
  return { data: true, error: null };
}

export async function notePostFailure(db: FakeDb, a: Record<string, any>): Promise<{ data: any; error: any }> {
  let n = 0;
  for (const b of db.tables.bot_posts ?? []) {
    if (!a.p_ids.includes(b.id) || b.channel !== "pending") continue;
    const attempts = typeof b.payload?.post_attempts === "number" ? b.payload.post_attempts : 0;
    b.payload = { ...b.payload, post_error: String(a.p_error ?? "unknown").slice(0, 300), post_attempts: attempts + 1 };
    n++;
  }
  return { data: n, error: null };
}

/** What the commit path and the channel poster call. */
export const POST_RPCS: NonNullable<FakeDbOptions["rpc"]> = {
  commit_context: commitContext, claim_post_lease: claimPostLease, release_post_lease: releasePostLease, note_post_failure: notePostFailure,
};

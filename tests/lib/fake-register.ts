/**
 * In-memory stand-in for register_market (migration 019) over tests/lib/fake-db.ts tables, following the SQL step for
 * step: the idempotent answer first, then the tenant's watch_limit, then the service-wide max_base_watches, then one
 * insert of the market and its watches. The locks are not emulated (fake-db runs one call at a time); the SQL itself,
 * locks included, is exercised by scripts/selftest/dispatch.ts against Postgres.
 */
import type { Row, RpcStandIn } from "./fake-db";

let seq = 0;

export const registerMarketStandIn: RpcStandIn = async (db, args) => {
  const { p_tenant, p_market, p_watches } = args as { p_tenant: string | null; p_market: Row; p_watches: Row[] };
  const t = db.tables;
  const markets = (t.markets ??= []);
  const watches = (t.watches ??= []);
  if (p_market.status === "unsupported_source" && p_watches.length) return { data: null, error: { code: "P0001", message: "register_market: an unsupported_source market gets no watches" } };
  let limit: number | null = null;
  if (p_tenant) {
    const tenant = (t.tenants ?? []).find((r) => r.id === p_tenant && !r.deleted_at);
    if (!tenant) return { data: null, error: { code: "P0001", message: `register_market: tenant ${p_tenant} not found` } };
    limit = tenant.watch_limit ?? null;
  }
  const sameKey = (m: Row) => (m.tenant_id ?? null) === (p_tenant ?? null) && m.platform === p_market.platform && m.external_id === p_market.external_id;
  const existing = markets.find((m) => sameKey(m) && !m.deleted_at);
  if (existing) {
    return { data: {
      outcome: "existing", market_id: existing.id, status: existing.status, is_test: existing.is_test === true,
      reasons: existing.meta?.registration_reasons ?? [], watches: watches.filter((w) => w.market_id === existing.id && !w.deleted_at).map((w) => ({ id: w.id, source_kind: w.source_kind })),
    }, error: null };
  }
  const n = p_watches.length;
  if (p_tenant && n > 0 && limit !== null) {
    const mine = new Set(markets.filter((m) => m.tenant_id === p_tenant).map((m) => m.id));
    const active = watches.filter((w) => mine.has(w.market_id) && w.active !== false && !w.deleted_at).length;
    if (active + n > limit) return { data: { outcome: "watch_limit", watch_limit: limit, active_watches: active, requested: n }, error: null };
  }
  const nBase = p_watches.filter((w) => w.source_kind === "base_log").length;
  if (nBase > 0) {
    const cap = Number((t.app_config ?? []).find((r) => r.key === "max_base_watches")?.value ?? 20);
    const active = watches.filter((w) => w.source_kind === "base_log" && w.active !== false && !w.deleted_at).length;
    if (active + nBase > cap) return { data: { outcome: "base_watch_cap", base_watch_cap: cap, active_base_watches: active, requested: nBase }, error: null };
  }
  if (markets.some(sameKey)) return { data: null, error: { code: "23505", message: `register_market: ${p_market.platform}:${p_market.external_id} is taken by a deleted market (markets_unique_per_tenant)` } };
  const smoke = p_market.platform === "custom" && String(p_market.external_id).startsWith("smoke-");
  const market: Row = { ...structuredClone(p_market), id: `markets-${++seq}`, tenant_id: p_tenant, is_test: smoke || p_market.is_test === true, created_at: new Date().toISOString() };
  markets.push(market);
  const made = p_watches.map((w) => {
    const row = { id: `watches-${++seq}`, market_id: market.id, source_kind: w.source_kind, source_ref: w.source_ref, cursor: w.cursor ?? {}, poll_interval_s: w.poll_interval_s, next_poll_at: new Date().toISOString(), lease_until: null, active: true, deleted_at: null };
    watches.push(row);
    return { id: row.id, source_kind: row.source_kind };
  });
  return { data: { outcome: "created", market_id: market.id, status: market.status, is_test: market.is_test, watches: made }, error: null };
};

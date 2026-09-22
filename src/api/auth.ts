/**
 * API-key auth: `Authorization: Bearer rsl_live_...` or `X-Api-Key`. sha256 lookup through the Cache API
 * (60 s, per colo; revocations propagate within the TTL) then Postgres. Daily cap via the atomic RPC.
 */
import type { Context } from "hono";
import type { Env } from "../env";
import { db, rpc } from "../db/supabase";
import { sha256Hex } from "../resolve/text";
import { err } from "./envelope";

export interface AuthContext {
  keyId: string;
  tenantId: string;
  plan: "free" | "payg" | "builder" | "growth" | "platform";
  strictV0: boolean;
  environment: "live" | "test";
  scopes: string[];
  requestsToday: number;
  dailyCap: number;
}

interface KeyRecord { id: string; tenant_id: string; environment: "live" | "test"; scopes: string[]; daily_cap: number; expires_at: string | null; revoked_at: string | null; tenants: { plan: AuthContext["plan"]; strict_v0: boolean; deleted_at: string | null } | null }

export const KEY_PREFIX = /^rsl_(live|test)_[a-z0-9]{32}$/;

export function extractApiKey(c: Context): string | null {
  const x = c.req.header("x-api-key");
  if (x && x.trim()) return x.trim();
  const a = c.req.header("authorization") ?? "";
  if (!a.toLowerCase().startsWith("bearer ")) return null;
  return a.slice(7).trim() || null;
}

async function lookup(env: Env, hash: string): Promise<KeyRecord | null> {
  const cacheKey = new Request(`https://auth.resolve.internal/key/${hash}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return (await hit.json()) as KeyRecord | null;
  const { data } = await db(env).from("api_keys").select("id, tenant_id, environment, scopes, daily_cap, expires_at, revoked_at, tenants(plan, strict_v0, deleted_at)").eq("key_hash", hash).is("deleted_at", null).maybeSingle();
  const rec = (data as unknown as KeyRecord | null) ?? null;
  await cache.put(cacheKey, new Response(JSON.stringify(rec), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" } }));
  return rec;
}

export async function invalidateKeyCache(hash: string): Promise<void> {
  await caches.default.delete(new Request(`https://auth.resolve.internal/key/${hash}`));
}

export type AuthResult = { ok: true; auth: AuthContext } | { ok: false; response: Response };

export async function authenticate<E extends { Bindings: Env }>(c: Context<E>): Promise<AuthResult> {
  const raw = extractApiKey(c);
  if (!raw) return { ok: false, response: err(c, "auth_required", "Provide an API key via `Authorization: Bearer rsl_live_...` or `X-Api-Key`.", 401) };
  if (!KEY_PREFIX.test(raw)) return { ok: false, response: err(c, "invalid_key", "Invalid API key format.", 401) };
  const hash = await sha256Hex(raw);
  const rec = await lookup(c.env, hash);
  if (!rec || rec.revoked_at || !rec.tenants || rec.tenants.deleted_at) return { ok: false, response: err(c, "invalid_key", "Unknown or revoked API key.", 401) };
  if (rec.expires_at && Date.parse(rec.expires_at) <= Date.now()) return { ok: false, response: err(c, "key_expired", "API key expired. Rotate it with POST /v1/keys/rotate using a valid key, or contact support.", 401) };
  let requestsToday = 0;
  try { requestsToday = await rpc<number>(db(c.env), "bump_api_key_usage_atomic", { p_key_id: rec.id }); }
  catch { requestsToday = 0; /* counter outage never blocks; the charge gate is fail-closed */ }
  if (requestsToday > rec.daily_cap) {
    return { ok: false, response: err(c, "daily_cap_reached", `This key's daily cap (${rec.daily_cap} requests, UTC day) is reached.`, 429, { retryAfterSeconds: secondsToUtcMidnight(), extra: { remaining: 0, resets_at: utcMidnightIso(), retry_after_seconds: secondsToUtcMidnight(), how_to_proceed: "Wait for the UTC day to roll over, or ask for a higher cap." } }) };
  }
  return { ok: true, auth: { keyId: rec.id, tenantId: rec.tenant_id, plan: rec.tenants.plan, strictV0: rec.tenants.strict_v0, environment: rec.environment, scopes: rec.scopes ?? [], requestsToday, dailyCap: rec.daily_cap } };
}

export function utcMidnightIso(): string { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.toISOString(); }
export function secondsToUtcMidnight(): number { return Math.max(1, Math.ceil((Date.parse(utcMidnightIso()) - Date.now()) / 1000)); }

/** Per-key minute bucket + (optionally) the shared Jev buckets. Fails OPEN on DB error because begin_resolution fails closed. */
export async function rateLimit<E extends { Bindings: Env }>(c: Context<E>, auth: AuthContext, opts: { jev: boolean; jevRpmLimit: number }): Promise<{ allowed: true } | { allowed: false; response: Response }> {
  const perKey = auth.plan === "platform" ? 600 : auth.plan === "growth" ? 300 : 60;
  const keys = [`key:${auth.keyId}:min`]; const windows = [60_000]; const limits = [perKey];
  if (opts.jev) { keys.push("upstream:jev:min", `upstream:jev:${auth.tenantId}:min`); windows.push(60_000, 60_000); limits.push(Math.max(1, Math.floor(opts.jevRpmLimit / 2)), Math.max(1, Math.floor(opts.jevRpmLimit / 8))); }
  try {
    const g = await rpc<{ buckets: Array<{ key: string; allowed: boolean; remaining: number; reset_at: string }> }>(db(c.env), "check_gates", { p_keys: keys, p_window_ms: windows, p_limits: limits });
    const bad = g.buckets.find((b) => !b.allowed);
    if (bad) {
      const retry = Math.min(60, Math.max(1, Math.ceil((Date.parse(bad.reset_at) - Date.now()) / 1000)));
      const scope = bad.key.startsWith("key:") ? "this API key" : bad.key.includes(auth.tenantId) ? "this tenant's share of the model upstream" : "the shared model upstream";
      return { allowed: false, response: err(c, "rate_limited", `Rate limit for ${scope} reached for the current 60 s window. It resets at ${bad.reset_at}.`, 429, { retryAfterSeconds: retry, extra: { remaining: bad.remaining, resets_at: bad.reset_at, retry_after_seconds: retry, how_to_proceed: "Wait until resets_at and retry the same call. This limit is per API key, so another address does not reset it." } }) };
    }
    return { allowed: true };
  } catch { return { allowed: true }; }
}

import type { Context } from "hono";

/**
 * Every v1 response uses one envelope (port of OilFlow _shared.ts, plus request_id):
 *   { ok: true,  data, request_id, schema_version }
 *   { ok: false, error: { code, message }, request_id, schema_version, ...extra }
 * 429s carry Retry-After and the quota fields at the top level so an agent that
 * already parses one 429 shape parses this one.
 */
export type ErrorCode =
  | "auth_required" | "invalid_key" | "key_expired" | "scope_denied" | "daily_cap_reached"
  | "rate_limited" | "insufficient_credits" | "validation_error" | "not_found"
  | "UNSAFE_INPUT" | "UPSTREAM_UNAVAILABLE" | "internal_error" | "config_error" | "forbidden";

export function newRequestId(): string {
  return "req_" + crypto.randomUUID().replace(/-/g, "");
}

export function requestId(c: Context): string {
  const existing = c.get("requestId") as string | undefined;
  if (existing) return existing;
  const id = newRequestId();
  c.set("requestId", id);
  return id;
}

export function ok<T>(c: Context, data: T, status = 200) {
  const rid = requestId(c);
  c.header("X-Request-Id", rid);
  return c.json({ ok: true as const, data, request_id: rid, schema_version: c.get("schemaVersion") ?? "1" }, status as 200);
}

export function err(
  c: Context,
  code: ErrorCode,
  message: string,
  status = 400,
  options: { retryAfterSeconds?: number; extra?: Record<string, unknown> } = {},
) {
  const rid = requestId(c);
  c.header("X-Request-Id", rid);
  if (status === 429 || status === 503) {
    c.header("Retry-After", String(options.retryAfterSeconds ?? (status === 429 ? 60 : 30)));
  }
  return c.json(
    { ok: false as const, error: { code, message }, request_id: rid, schema_version: c.get("schemaVersion") ?? "1", ...(options.extra ?? {}) },
    status as 400,
  );
}

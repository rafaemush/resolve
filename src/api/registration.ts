import type { Context } from "hono";
import { err } from "./envelope";
import { RegistrationError } from "../markets/policy";

/**
 * The HTTP answer for a registration that stored nothing (POST /v1/markets, POST /internal/markets):
 * invalid 400, watch limit 403 (the shape POST /v1/markets always had), Base watch cap 409, a check that could not be
 * made 503 with Retry-After (the same request may simply be sent again). Anything else that throws (a schema or
 * official_release refusal, a database error) is the caller's 400, as before.
 */
export function registrationRefused(c: Context, e: unknown): Response {
  if (!(e instanceof RegistrationError)) return err(c, "validation_error", String(e).slice(0, 400), 400);
  const r = e.refusal;
  switch (r.kind) {
    case "invalid": return err(c, "validation_error", e.message.slice(0, 1000), 400);
    case "unverified": return err(c, "UPSTREAM_UNAVAILABLE", e.message.slice(0, 400), 503, { retryAfterSeconds: 60 });
    case "watch_limit": return err(c, "validation_error", e.message, 403, { extra: { watch_limit: r.limit, active_watches: r.active, requested_watches: r.requested } });
    case "base_watch_cap": return err(c, "conflict", e.message, 409, { extra: { max_base_watches: r.cap, active_base_watches: r.active, requested_base_watches: r.requested } });
    default: { const never: never = r; throw new Error(`unhandled refusal ${String(never)}`); }
  }
}

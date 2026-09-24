/**
 * The signature pg_net puts on every dispatch from the database to the Worker: select_due_watches (migrations 007/013,
 * id = the watch id) and dispatch_internal (migration 018, id = the job id, e.g. limitless_record). Both compute
 * X-Internal-Signature = hex HMAC-SHA256(INTERNAL_HMAC_SECRET, "<id>|<YYYY-MM-DDTHH:MM>") over the dispatch minute (UTC)
 * and send that minute as X-Internal-Minute. The id is inside the MAC, so a signature for one watch or job never
 * authorizes another route or id; the minute bounds a replay to the tolerance window.
 */
import { hmacHex } from "../resolve/text";
import { safeEqual } from "./admin";

/** pg_cron fires on the minute and pg_net may queue briefly; both clocks are NTP-synced. */
export const SIGNATURE_TOLERANCE_MS = 3 * 60_000;

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "stale" | "invalid" };

export async function verifyDispatchSignature(secret: string | undefined, id: string, sig: string | undefined, minute: string | undefined, nowMs = Date.now()): Promise<SignatureCheck> {
  if (!sig || !minute) return { ok: false, reason: "missing" };
  const t = Date.parse(minute + ":00Z");
  if (!Number.isFinite(t) || Math.abs(nowMs - t) > SIGNATURE_TOLERANCE_MS) return { ok: false, reason: "stale" };
  // An unset secret must refuse, not sign with an empty key (parseConfig guards the rest of the Worker, not this check).
  if (!secret) return { ok: false, reason: "invalid" };
  return safeEqual(sig, await hmacHex(secret, `${id}|${minute}`)) ? { ok: true } : { ok: false, reason: "invalid" };
}

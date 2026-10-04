/**
 * The signature pg_net puts on every dispatch from the database to the Worker: select_due_watches (migrations 007/013,
 * id = the watch id) and dispatch_internal (migration 018, id = the job id, e.g. limitless_record). Both compute
 * X-Internal-Signature = hex HMAC-SHA256(INTERNAL_HMAC_SECRET, "<id>|<YYYY-MM-DDTHH:MM>") over the dispatch minute (UTC)
 * and send that minute as X-Internal-Minute. The id is inside the MAC, so a signature for one watch or job never
 * authorizes another route or id; the stamp bounds a replay to the tolerance window.
 * redispatch_official_legs (migration 024: the other legs of an official release, dispatched the moment its first print
 * is recorded) signs a stamp to the second, "<id>|<YYYY-MM-DDTHH:MM:SS>": every leg was already dispatched in the
 * release minute, and claim_watch_dispatch() records each (watch_id, stamp) once, so a stamp the scheduled dispatch
 * never uses is the redispatch's own single-use row. Only the watch route accepts it (opts.seconds); the same tolerance.
 */
import { hmacHex } from "../resolve/text";
import { safeEqual } from "./admin";

/** pg_cron fires on the minute and pg_net may queue briefly; both clocks are NTP-synced. */
export const SIGNATURE_TOLERANCE_MS = 3 * 60_000;

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "stale" | "invalid" };

/** A stamp to the minute, or with opts.seconds to the second (a redispatch); anything else is not a stamp. */
const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** The time a stamp names, in ms (NaN for anything that is not a stamp this route accepts). Pure. */
export function stampMs(stamp: string, seconds = false): number {
  if (MINUTE.test(stamp)) return Date.parse(stamp + ":00Z");
  if (seconds && SECOND.test(stamp)) return Date.parse(stamp + "Z");
  return NaN;
}

export async function verifyDispatchSignature(secret: string | undefined, id: string, sig: string | undefined, minute: string | undefined, nowMs = Date.now(), opts: { seconds?: boolean } = {}): Promise<SignatureCheck> {
  if (!sig || !minute) return { ok: false, reason: "missing" };
  const t = stampMs(minute, opts.seconds === true);
  if (!Number.isFinite(t) || Math.abs(nowMs - t) > SIGNATURE_TOLERANCE_MS) return { ok: false, reason: "stale" };
  // An unset secret must refuse, not sign with an empty key (parseConfig guards the rest of the Worker, not this check).
  if (!secret) return { ok: false, reason: "invalid" };
  return safeEqual(sig, await hmacHex(secret, `${id}|${minute}`)) ? { ok: true } : { ok: false, reason: "invalid" };
}

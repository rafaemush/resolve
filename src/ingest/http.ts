/** HTTP helpers shared by the github and web adapters. Pure except discardBody. */

/** Longest a source may push a watch back: a rate-limit reset or Retry-After beyond this is treated as this. */
export const MAX_DEFER_S = 3600;

/** Positive finite seconds -> whole seconds capped at MAX_DEFER_S; anything else -> undefined (no deferral). */
export function clampDefer(s: number | undefined): number | undefined {
  if (s === undefined || !Number.isFinite(s) || s <= 0) return undefined;
  return Math.min(MAX_DEFER_S, Math.ceil(s));
}

/** Retry-After as delta-seconds ("120") or an HTTP-date (RFC 9110 §10.2.3). */
export function retryAfterSeconds(headers: Headers, nowMs: number): number | undefined {
  const v = headers.get("retry-after")?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return clampDefer(Number(v));
  const t = Date.parse(v);
  return Number.isFinite(t) ? clampDefer((t - nowMs) / 1000) : undefined;
}

/** The largest of the given deferrals (the most conservative reading of what the source asked for). */
export function maxDefer(...xs: Array<number | undefined>): number | undefined {
  const present = xs.filter((x): x is number => x !== undefined);
  return present.length ? Math.max(...present) : undefined;
}

/** Release the connection of a response whose body we will not read. */
export async function discardBody(res: Response): Promise<void> {
  try { await res.body?.cancel(); } catch { /* already consumed or not cancellable */ }
}

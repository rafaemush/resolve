/**
 * API key material, shared by the Worker (POST /internal/tenants, POST /v1/keys/rotate, POST /v1/request-key, webhook
 * secrets) and the founder's scripts (scripts/issue-test-key.ts), so every key is minted and hashed one way:
 * rsl_<env>_<32 chars of [a-z0-9]> (src/api/auth.ts KEY_PREFIX), stored as sha256(raw) with a 12-character display
 * prefix. The evaluation key's terms live here too, so the form and the script issue the same key.
 */
import { sha256Hex } from "../resolve/text";

/** Credits an evaluation key comes with (docs/pricing.md, plan §17.5 "Free: 300 credits"). */
export const FREE_EVALUATION_CREDITS = 300;
/** Days an evaluation key is valid: api_keys.expires_at = issue + 30 days (docs/pricing.md). */
export const EVALUATION_KEY_DAYS = 30;
/** tenants.watch_limit of an evaluation tenant, as POST /internal/tenants and scripts/issue-test-key.ts create it. */
export const EVALUATION_WATCH_LIMIT = 5;

/**
 * The ledger request_id that makes the evaluation grant once per tenant (credit_ledger UNIQUE(reason, request_id)).
 * One scheme for both paths that grant it (scripts/issue-test-key.ts and POST /v1/request-key), so whichever runs
 * first grants and the other sees the grant.
 */
export const grantRequestId = (tenantId: string): string => `issue-test-key:${tenantId}`;

export function randomKeyBody(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  let s = ""; for (const b of bytes) s += chars[b % chars.length]; return s;
}

export interface MintedKey { raw: string; hash: string; prefix: string }

/** A new raw key (shown once, never stored) with the hash and display prefix api_keys stores. */
export async function mintKey(environment: "live" | "test"): Promise<MintedKey> {
  const raw = `rsl_${environment}_${randomKeyBody()}`;
  return { raw, hash: await sha256Hex(raw), prefix: raw.slice(0, 12) + "..." };
}

/** How long a rotated-out key keeps working, so the caller can switch without an outage. */
export const ROTATION_OVERLAP_MS = 24 * 3600_000;

/**
 * Pure. Expiries for POST /v1/keys/rotate. Rotation never extends a key's life: the new key keeps the old key's expiry
 * (an evaluation key stays inside its 30 days, docs/pricing.md), and the old key's overlap ends at the earlier of now +
 * 24 h and its own expiry.
 */
export function rotationExpiry(expiresAt: string | null | undefined, now: number): { newKey: string | null; oldKey: string } {
  const overlap = now + ROTATION_OVERLAP_MS;
  const own = expiresAt ? Date.parse(expiresAt) : NaN;
  return { newKey: expiresAt ?? null, oldKey: new Date(Number.isFinite(own) ? Math.min(own, overlap) : overlap).toISOString() };
}

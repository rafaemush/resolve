/**
 * API key material, shared by the Worker (POST /internal/tenants, POST /v1/keys/rotate, webhook secrets) and the
 * founder's scripts (scripts/issue-test-key.ts), so every key is minted and hashed one way: rsl_<env>_<32 chars of
 * [a-z0-9]> (src/api/auth.ts KEY_PREFIX), stored as sha256(raw) with a 12-character display prefix.
 */
import { sha256Hex } from "../resolve/text";

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

/**
 * Signed wallet registration (plan §16.4 P3 step 3, §11 "tenant registers a sender wallet"). A USDC deposit is credited
 * to the tenant whose wallet_address sent it, so a tenant registers that address by proving it controls it: GET
 * /v1/account/wallet/challenge issues a single-use message, the wallet signs it with EIP-191 personal_sign, and POST
 * /v1/account/wallet verifies the signature here, then register_wallet() (migration 020) marks the challenge used and
 * sets the address in one transaction. Only externally owned accounts can sign; a contract wallet is matched by the
 * operator (POST /internal/deposits/match).
 * CPU (Workers Free: 10 ms per invocation): one secp256k1 public-key recovery, measured with Node 24 on the build
 * machine at ~1.8 ms warm and ~19 ms on the first call of an isolate (viem builds noble's base-point table then).
 */
import { verifyMessage } from "viem";

export const WALLET_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A 65-byte r || s || v signature, as personal_sign returns it. */
export const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
export const CHALLENGE_TTL_MINUTES = 10; // wallet_challenges.expires_at default (migration 020)

export interface ChallengeFields { tenantId: string; address: string; nonce: string; issuedAt: string }

/** Pure. Exactly the text the wallet signs; wallet_challenges.message stores it and the signature is checked against it. */
export function challengeMessage(c: ChallengeFields): string {
  return ["Resolve wallet registration", `tenant: ${c.tenantId}`, `address: ${c.address.toLowerCase()}`, `nonce: ${c.nonce}`, `issued: ${c.issuedAt}`].join("\n");
}

/** 16 random bytes, hex (wallet_challenges.nonce). */
export function newNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether `signature` is an EIP-191 personal_sign of `message` by `address`. A signature that cannot be parsed or
 * recovered is not a signature by anyone: false, never a throw.
 */
export async function signedBy(address: string, message: string, signature: string): Promise<boolean> {
  if (!WALLET_ADDRESS.test(address) || !SIGNATURE.test(signature)) return false;
  try {
    return await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch {
    return false;
  }
}

export const REGISTER_RESULTS = ["registered", "not_found", "used", "expired", "taken"] as const;
export type RegisterResult = (typeof REGISTER_RESULTS)[number];

export interface RegisterAnswer { status: 200 | 404 | 409 | 410; reason: string; message: string }

/** Pure. HTTP answer for a register_wallet() result (and for the same states read before the signature is checked). */
export function registerAnswer(r: RegisterResult, address: string | null): RegisterAnswer {
  switch (r) {
    case "registered": return { status: 200, reason: "registered", message: `wallet ${address} registered: USDC it sends to the receiving address is credited to this account` };
    case "not_found": return { status: 404, reason: "challenge_not_found", message: "no such challenge for this account (GET /v1/account/wallet/challenge issues one)" };
    case "used": return { status: 409, reason: "challenge_used", message: "this challenge was already used; request a new one (GET /v1/account/wallet/challenge)" };
    case "expired": return { status: 410, reason: "challenge_expired", message: `this challenge expired (challenges live ${CHALLENGE_TTL_MINUTES} minutes); request a new one` };
    case "taken": return { status: 409, reason: "wallet_taken", message: `wallet ${address} is registered to another account; contact support if it is yours` };
    default: { const never: never = r; throw new Error(`unhandled register_wallet result ${String(never)}`); }
  }
}

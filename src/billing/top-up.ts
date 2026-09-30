/**
 * Where a tenant is told to top up (plan §22.3 #1): the 402 of POST /v1/resolve, the credits.low event, the operator's
 * credits.low alert and the refusal of GET /v1/payments/address. While card checkout is offered (switched on and
 * configured, src/billing/whop.ts cardCheckoutOffered) the pointer is the card rail: POST /v1/billing/checkout and the
 * /pricing form; otherwise it says to contact support. It never names the USDC receiving address: no third-party USDC
 * is solicited, and GET /v1/payments/address answers only while USDC_DEPOSITS_OFFERED is exactly "1". Pure.
 */
import type { Env } from "../env";
import { CARD_CURRENCY, CARD_PACKS, PACK_IDS, cardCheckoutOffered, whopConfig, type PackId } from "./whop";

/** The card form on the pricing page (src/api/site.ts payByCardHtml). */
export const PAY_BY_CARD_PATH = "/pricing#pay-by-card";
/** The terms page's contact section: the request form, answered by email. */
export const CONTACT_PATH = "/terms#contact";
export const CHECKOUT_ROUTE = "POST /v1/billing/checkout";
export const USDC_NOT_OFFERED = "USDC deposits are not offered";

/** The machine-readable pointer (the `top_up` field of the 402 and of credits.low). */
export type TopUp =
  | { method: "card"; checkout: typeof CHECKOUT_ROUTE; page: string; packs: Array<{ pack: PackId; price: string; currency: string; credits: number }> }
  | { method: "contact_support"; page: string };

/** Only the exact "1" offers USDC deposits to tenants; unset, "0", "true" or anything else does not. */
export const usdcDepositsOffered = (env: Pick<Env, "USDC_DEPOSITS_OFFERED">): boolean => env.USDC_DEPOSITS_OFFERED === "1";

/** The site's public origin: RESOLVE_PUBLIC_URL, else the request's own origin; null without either (paths stay relative). */
export function publicBase(env: Pick<Env, "RESOLVE_PUBLIC_URL">, reqUrl?: string): string | null {
  const set = env.RESOLVE_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (set) return set;
  if (!reqUrl) return null;
  try { return new URL(reqUrl).origin; } catch { return null; }
}

/** The pointer for this Worker's configuration: the card rail while it is offered, else support. */
export function topUp(env: Env, base: string | null): TopUp {
  const at = (path: string) => `${base ?? ""}${path}`;
  if (!cardCheckoutOffered(whopConfig(env))) return { method: "contact_support", page: at(CONTACT_PATH) };
  return {
    method: "card", checkout: CHECKOUT_ROUTE, page: at(PAY_BY_CARD_PATH),
    packs: PACK_IDS.map((pack) => ({ pack, price: (CARD_PACKS[pack].priceCents / 100).toFixed(2), currency: CARD_CURRENCY, credits: CARD_PACKS[pack].credits })),
  };
}

/** The same pointer as one sentence, for a message a person reads. */
export function topUpText(t: TopUp): string {
  if (t.method === "contact_support") return `Card checkout is not available right now: contact support (${t.page}) to add credits.`;
  const packs = t.packs.map((p) => `"${p.pack}"`).join(" | ");
  return `Top up by card: ${t.checkout} with {"pack": ${packs}} answers a checkout_url, or use the form at ${t.page}.`;
}

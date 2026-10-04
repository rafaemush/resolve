/**
 * Card checkout through Whop (plan §21.4 C, checkout half): a developer who holds a Resolve key buys a credit pack by
 * card, and Whop is the merchant of record. The pure half lives here: the configuration, the webhook signature, the
 * payload shapes, what a payment grants and what a refund or dispute takes back, and the one call that opens a
 * checkout. src/billing/whop-events.ts moves the credits; src/api/billing.ts and src/api/site.ts are the routes.
 *
 * What this module guarantees:
 *   - a webhook is believed only when its webhook-signature is the HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.
 *     <raw body>" keyed by the literal bytes of WHOP_WEBHOOK_SECRET, compared in constant time, with a timestamp within
 *     5 minutes either way (rail whop_signature; evals/whop.ts proves the rail and evals/mutate.ts switches it off);
 *   - a pack is found by the payment's PLAN ID in a server-side map (WHOP_PLAN_ID_20, WHOP_PLAN_ID_50,
 *     WHOP_PLAN_ID_250, WHOP_PLAN_ID_1000), never by the amount or the metadata; the amount paid (the total less any tax
 *     added on top) and the currency must then equal the pack's price exactly, or nothing is granted;
 *   - a pack is offered (listed, checkout-able) only while its plan id is set, well-formed and its own (rail
 *     card_pack_plan_set): the $1,000 pack is built dark, its empty plan id means "not offered", never "missing", so it
 *     neither closes the other packs nor alerts, and a payment on a plan no pack holds grants nothing;
 *   - the tenant comes from the checkout's metadata, which Resolve set when it opened the checkout (resolve_tenant_id:
 *     the tenant id, never the key); nothing else in a payment names a tenant;
 *   - a refund or dispute takes back its share of the credits one payment granted: proportional to the amount when the
 *     payload gives it in US dollars, against the pack's price (what the credits were sold for, the amount the grant
 *     was checked against; the same base whichever shape the event comes in, so a refund of the whole price takes them
 *     all even when tax was added on top), rounded up so a refunded cent never keeps its credits; else all of them.
 *
 * Whop sources (read 2026-09-30):
 *  [W1] https://docs.whop.com/developer/guides/webhooks
 *       "Whop webhooks use the [Standard Webhooks] specification."
 *       "Whop signs the string `{webhook-id}.{webhook-timestamp}.{raw body}` with HMAC-SHA256. The key is your `ws_...`
 *       secret. The `webhook-signature` header contains the result in base64: `v1,<signature>`."
 *       "compare it to the header value with a constant-time comparison. Reject a request if its `webhook-timestamp` is
 *       more than 5 minutes from the current time."
 *       "pass it to the helper exactly as Whop gave it to you — a `ws_` string. Don't strip the prefix, and don't
 *       base64-encode it."
 *       "Respond with a 2xx status in less than 5 seconds. All other results are failed attempts"
 *       "Whop delivers each event at least one time. The same event can arrive more than one time." "Each retry of a
 *       delivery has the same `webhook-id`." "Whop retries 12 times with increased delays ... approximately 71 hours."
 *       "The sequence of deliveries isn't guaranteed." "If the failures continue for 72 hours and 10 or more deliveries
 *       failed, Whop disables the webhook". `api_version`: "Use `v1`."
 *  [W2] https://github.com/whopio/whopsdk-typescript/blob/main/src/helpers/verifyWebhook.ts (Whop's own verifier)
 *       "Whop's backend HMACs with the *literal bytes* of the secret it issued" ... "The whole secret is encoded, prefix
 *       included, because the backend never strips a prefix either."
 *  [W3] https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/javascript/src/index.ts (the verifier
 *       [W2] wraps): the header may carry several space-separated "v1,<base64>" signatures and one match is enough; a
 *       timestamp more than 300 s old ("Message timestamp too old") or ahead ("too new") is refused.
 *  [W4] https://docs.whop.com/api-reference/webhooks/create-webhook
 *       api_version_date: "the webhook's payloads are pinned to: events serialize exactly like a REST read at this
 *       version ... Omit to leave the webhook unpinned on the legacy payload shape." (so the webhook is created with
 *       the API, pinned to WHOP_API_VERSION_DATE)
 *  [W5] https://docs.whop.com/api-reference/beta/checkout-configurations/create-a-checkout-configuration
 *       POST https://api.whop.com/api/v1/checkout_configurations, bearerAuth checkout_configuration:create;
 *       plan_id "Existing variant ID, prefixed `plan_`"; metadata "Custom key-value metadata copied to payments and
 *       memberships."; purchase_url "Checkout URL you can send to customers."; redirect_url "URL customers are sent to
 *       after checkout."; header Api-Version-Date "Pins the request to a dated API version." (x-api-version-date
 *       2026-09-29)
 *  [W6] https://docs.whop.com/developer/guides/accept-payments
 *       "Fulfill from the `payment.succeeded` webhook, never from the browser." "your handler receives a
 *       `payment.succeeded` event with the `metadata` you attached, which is how you map the payment back to your own
 *       order."
 *  [W7] https://docs.whop.com/api-reference/beta/payments/retrieve-payment (the Payment a pinned payment.succeeded
 *       carries): plan_id "The variant that was charged, prefixed `plan_`."; status "`paid` once the money moved";
 *       total "The account-facing total: the price after discounts, plus any tax added on top."; Money.amount "The
 *       amount in major units, as an exact decimal string — `"10.00"` is ten dollars."; tax_behavior "Whether
 *       `tax_amount` was added on top of the price (`exclusive`) or was already inside it (`inclusive`)."; customer_email
 *       "The buyer's email address."
 *  [W8] https://github.com/whopio/whopsdk-python (payments/types/post_payment_succeeded_payload.py `data: Payment`;
 *       refunds/types/post_refund_created_payload.py `data: RefundLegacy`; disputes/types/post_dispute_created_payload.py
 *       `data: Dispute`; types/refund_legacy.py: amount "The refunded amount as a decimal in the specified currency",
 *       status pending | requires_action | succeeded | failed | canceled; types/refund_legacy_payment.py: id, total,
 *       currency, plan {id}; types/dispute.py: amount "The disputed amount, in whole units of `currency`", inquiry
 *       "Inquiries follow the same lifecycle but move no funds unless one escalates", status "`prevented` means the
 *       customer was refunded before any ruling, so it settles like `lost`"; types/dispute_payment.py: id, amount,
 *       currency)
 *  [W8b] https://docs.whop.com/api-reference/beta/refunds/retrieve-refund (the native Refund, which a pinned webhook
 *       may serialize instead of RefundLegacy: [W4] "the native serializer where the resource has one"): id "prefixed
 *       `rf_`", payment_id "The payment this refund reverses, prefixed `pay_`", amount (Money) "The refunded amount as
 *       it settled, in the payment's settlement currency", status "`pending`, `requires_action`, `succeeded`, `failed`,
 *       or `canceled`". Both refund shapes are read; which one a pinned refund.created carries is not verified.
 *  [W9] https://docs.whop.com/developer/guides/refunds-and-disputes
 *       "When a dispute is **lost**, Whop doesn't automatically create a Refund record, and you can't create one
 *       yourself." won "Funds stay with you."; lost "Funds go back to the buyer."; closed "Dispute closed without a
 *       formal won/lost outcome (e.g. withdrawn)."; "Subscribe to webhooks for `refund.created`, `refund.updated`,
 *       `dispute.created`, `dispute.updated`"
 *  [W10] https://docs.whop.com/developer/api/idempotency "Every authenticated `POST` on the Current API accepts an
 *       `Idempotency-Key` header."; https://docs.whop.com/developer/guides/sandbox: API
 *       `https://sandbox-api.whop.com/api/v1`, frontend `https://sandbox.whop.com`.
 * Not verified in the documentation (the report's open questions): the host of a sandbox purchase_url (taken to be the
 * sandbox frontend); what an unpinned webhook sends for payment.succeeded (refused here as not understood); whether a
 * dashboard-made webhook can be pinned (the founder makes it with the API).
 */
import { z } from "zod";
import type { Env } from "../env";
import { safeEqual } from "../api/admin";
import { railEnabled } from "../resolve/rails";
import { redact } from "../ops/redact";

/**
 * The packs sold by card (docs/pricing.md, plan §11, §22.3 #5): price in US cents and the credits it buys. The $20 pack is
 * card only (the invoiced and USDC packs, PACKS_USDC in src/billing/tiers.ts, start at $50), at the base rate of
 * payg_tiers (100 credits a dollar); the others are the plan §11 packs at their tier's rate.
 *
 * `optional`: the pack is built dark (plan item 6, 2026-10-05). Its plan id may stay empty: the pack is then not offered,
 * and the card checkout of the other packs stays open. The three packs without it must all be set before checkout opens.
 */
export const CARD_PACKS = {
  "20": { priceCents: 2_000, credits: 2_000, planVar: "WHOP_PLAN_ID_20" },
  "50": { priceCents: 5_000, credits: 5_000, planVar: "WHOP_PLAN_ID_50" },
  "250": { priceCents: 25_000, credits: 27_500, planVar: "WHOP_PLAN_ID_250" },
  "1000": { priceCents: 100_000, credits: 120_000, planVar: "WHOP_PLAN_ID_1000", optional: true },
} as const satisfies Record<string, { priceCents: number; credits: number; planVar: keyof Env; optional?: true }>;
export type PackId = keyof typeof CARD_PACKS;
export const PACK_IDS = Object.keys(CARD_PACKS) as PackId[];
export const isPackId = (v: unknown): v is PackId => typeof v === "string" && Object.hasOwn(CARD_PACKS, v);
/** Pure. Whether the pack is built dark: an empty plan id means it is not offered, never that checkout is misconfigured. */
export const isOptionalPack = (p: PackId): boolean => "optional" in CARD_PACKS[p];
/** The packs every open card checkout sells (each one's plan id set): what a page lists when it is not told which are offered. */
export const CORE_PACK_IDS: readonly PackId[] = PACK_IDS.filter((p) => !isOptionalPack(p));
export const CARD_CURRENCY = "usd";
/** The dated API version checkouts are created at and the webhook is pinned to ([W4], [W5]). */
export const WHOP_API_VERSION_DATE = "2026-09-29";
/** [W1], [W3]: a timestamp further than this from now, either way, is refused. */
export const WHOP_SIGNATURE_TOLERANCE_S = 300;
/** The checkout metadata key that names the tenant ([W5]: copied to the payment). The tenant id, never the key. */
export const TENANT_METADATA_KEY = "resolve_tenant_id";
/** The ledger request_id of a payment's grant (credit_ledger UNIQUE(reason, request_id)): once per Whop payment. */
export const grantRequestIdFor = (paymentId: string): string => `whop:${paymentId}`;
/**
 * The ledger request_id of a refund's or dispute's reversal: once per refund or dispute. The payment id is inside, so
 * every reversal of one payment can be found and their sum held to what the payment granted.
 */
export const reversalRequestIdFor = (kind: "refund" | "dispute", paymentId: string, objectId: string): string => `whop-${kind}:${paymentId}:${objectId}`;

const PLAN_ID = /^plan_[A-Za-z0-9]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,64}$/;
const OBJECT_ID = /^[A-Za-z0-9_]{1,128}$/;

export interface WhopConfig {
  /** WHOP_CHECKOUT_ENABLED is exactly "1". */
  checkoutEnabled: boolean;
  sandbox: boolean;
  apiBase: string;
  /** Where a purchase_url may point, and what /pricing's form-action allows. */
  checkoutOrigin: string;
  /** plan id -> pack, for plan ids that are set and well-formed. */
  plans: Map<string, PackId>;
  planOf: Partial<Record<PackId, string>>;
  /** The packs whose plan id is set, well-formed and their own, in CARD_PACKS order: the only ones that may be offered. */
  withPlan: PackId[];
  /** Names (never values) of what opening a checkout needs and lacks: the API key and the core packs' plan ids. */
  checkoutMissing: string[];
  /**
   * Names of the plan variables unset or invalid: a payment on an unknown plan may be one of those packs. An optional
   * pack's plan left EMPTY is not here (it is dark, see `dark`); one set to something malformed or shared is.
   */
  planMissing: string[];
  /** Names of the optional packs' plan variables left empty: those packs are deliberately not offered. */
  dark: string[];
  webhookSecret: string | null;
  apiKey: string | null;
}

/** Pure. The Whop configuration from the Worker's vars and secrets; a malformed value counts as missing, never guessed. */
export function whopConfig(env: Env): WhopConfig {
  const sandbox = env.WHOP_SANDBOX === "1";
  const plans = new Map<string, PackId>();
  const planOf: Partial<Record<PackId, string>> = {};
  const planMissing: string[] = [];
  const coreMissing: string[] = [];
  const dark: string[] = [];
  const seen = new Map<string, PackId>();
  const miss = (core: boolean, ...names: string[]) => { planMissing.push(...names); if (core) coreMissing.push(...names); };
  for (const pack of PACK_IDS) {
    const name = CARD_PACKS[pack].planVar;
    const v = (env[name] as string | undefined)?.trim() ?? "";
    if (!v) { if (isOptionalPack(pack)) dark.push(name); else miss(true, name); continue; }
    if (!PLAN_ID.test(v)) { miss(!isOptionalPack(pack), `${name} (not a plan_ id)`); continue; }
    const other = seen.get(v);
    // Both packs that share a plan are dropped, never guessed; a core pack among them closes the checkout.
    if (other) { miss(!isOptionalPack(pack) || !isOptionalPack(other), `${name} (the same plan as ${CARD_PACKS[other].planVar})`, CARD_PACKS[other].planVar); plans.delete(v); delete planOf[other]; continue; }
    seen.set(v, pack);
    plans.set(v, pack);
    planOf[pack] = v;
  }
  const apiKey = env.WHOP_API_KEY?.trim() || null;
  const webhookSecret = env.WHOP_WEBHOOK_SECRET?.trim() || null;
  return {
    checkoutEnabled: env.WHOP_CHECKOUT_ENABLED === "1", sandbox,
    apiBase: sandbox ? "https://sandbox-api.whop.com/api/v1" : "https://api.whop.com/api/v1",
    checkoutOrigin: sandbox ? "https://sandbox.whop.com" : "https://whop.com",
    plans, planOf, withPlan: PACK_IDS.filter((p) => planOf[p] !== undefined), planMissing, dark,
    checkoutMissing: [...(apiKey ? [] : ["WHOP_API_KEY"]), ...coreMissing],
    webhookSecret, apiKey,
  };
}

/** Pure. Card checkout is offered (the /pricing form, the /docs section) only when switched on and fully configured. */
export const cardCheckoutOffered = (cfg: WhopConfig): boolean => cfg.checkoutEnabled && cfg.checkoutMissing.length === 0;

/**
 * Pure. The packs a buyer is offered, in price order: none while card checkout is not offered, else each pack whose plan
 * id is set, well-formed and its own (rail card_pack_plan_set; off: every pack in CARD_PACKS). The /pricing form, the
 * 402 and credits.low top_up, and both checkout routes read this list and nothing else.
 */
export function offeredPacks(cfg: WhopConfig): PackId[] {
  if (!cardCheckoutOffered(cfg)) return [];
  return railEnabled("card_pack_plan_set") ? [...cfg.withPlan] : [...PACK_IDS];
}

/** "$1,000" (whole dollars, thousands grouped): how a pack is named to a buyer. */
export const packLabel = (p: PackId): string => `$${(CARD_PACKS[p].priceCents / 100).toLocaleString("en-US")}`;

export type PackOffer =
  | { ok: true }
  /** The pack is dark (its plan id empty) or not offered: nothing to fix, the buyer picks another pack. */
  | { ok: false; status: 400; message: string }
  /** Its plan id is set but malformed or shared: alerted by name (`missing`); nothing was charged. */
  | { ok: false; status: 503; message: string; missing: string[] };

/**
 * Pure. Whether a checkout may be opened for `pack`, called once checkoutRefusal has let the checkout through: yes only
 * when it is among offeredPacks. A dark pack answers 400 "not offered" naming the packs that are; a plan id set but
 * malformed or shared answers 503 with its name for the alert. Never a checkout for a plan Resolve cannot credit.
 */
export function packOffer(cfg: WhopConfig, pack: PackId): PackOffer {
  const offered = offeredPacks(cfg);
  if (offered.includes(pack)) return { ok: true };
  const name = CARD_PACKS[pack].planVar;
  const missing = cfg.planMissing.filter((m) => m === name || m.startsWith(`${name} `));
  if (missing.length) return { ok: false, status: 503, missing, message: `The ${packLabel(pack)} pack cannot be paid by card right now. Nothing was charged.` };
  const list = offered.map(packLabel);
  return { ok: false, status: 400, message: `The ${packLabel(pack)} pack is not offered by card. Choose one of the packs offered: ${list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`}.` };
}

// ---- the webhook signature ([W1]-[W3]) ------------------------------------------------------------------------------

export type WhopSignatureCheck = { ok: true } | { ok: false; reason: "no_secret" | "missing" | "malformed" | "stale" | "invalid" };

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** base64(HMAC-SHA256(key = the literal UTF-8 bytes of the whole secret, "<id>.<timestamp>.<body>")) ([W1], [W2]). */
export async function whopSignature(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${body}`))));
}

/**
 * Whether a request is Whop's: the three headers present, the timestamp a whole number of seconds within
 * WHOP_SIGNATURE_TOLERANCE_S of now (either way), and one "v1,<base64>" entry of the space-separated signature header
 * equal, in constant time, to the HMAC of the raw body. An unset secret refuses, never signs with an empty key.
 */
export async function verifyWhopSignature(
  secret: string | null | undefined,
  h: { id?: string | null; timestamp?: string | null; signature?: string | null },
  body: string,
  nowMs = Date.now(),
): Promise<WhopSignatureCheck> {
  if (!railEnabled("whop_signature")) return { ok: true };
  if (!secret) return { ok: false, reason: "no_secret" };
  const id = h.id?.trim() ?? "", ts = h.timestamp?.trim() ?? "", sig = h.signature?.trim() ?? "";
  if (!id || !ts || !sig) return { ok: false, reason: "missing" };
  // The timestamp is signed as sent; only its canonical digits are accepted, so the text signed is the number checked.
  if (!/^[1-9]\d{0,11}$/.test(ts) || id.length > 256 || sig.length > 2048) return { ok: false, reason: "malformed" };
  const now = Math.floor(nowMs / 1000);
  const t = Number(ts);
  if (now - t > WHOP_SIGNATURE_TOLERANCE_S || t - now > WHOP_SIGNATURE_TOLERANCE_S) return { ok: false, reason: "stale" };
  const expected = await whopSignature(secret, id, ts, body);
  for (const entry of sig.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    if (safeEqual(entry.slice(comma + 1), expected)) return { ok: true };
  }
  return { ok: false, reason: "invalid" };
}

// ---- payloads ([W1], [W7], [W8]) ------------------------------------------------------------------------------------

/** The v1 envelope of every event ([W1]). */
export const WhopEnvelope = z.object({
  id: z.string().min(1).max(256),
  type: z.string().min(1).max(100),
  api_version: z.literal("v1"),
  api_version_date: z.string().nullish(),
  timestamp: z.string().optional(),
  data: z.unknown(),
});
export type WhopEnvelope = z.infer<typeof WhopEnvelope>;

const Money = z.object({ amount: z.string().max(40), currency: z.string().max(10) });
const Amount = z.number().finite().nullish();
const Currency = z.string().max(10).nullish();

/** payment.succeeded's data on a webhook pinned to WHOP_API_VERSION_DATE ([W7], [W8]): the fields read here. */
export const WhopPayment = z.object({
  id: z.string().regex(PAYMENT_ID),
  status: z.string().max(40),
  plan_id: z.string().max(80).nullable(),
  currency: z.string().max(10),
  total: Money.nullable(),
  tax_amount: Money.nullish(),
  tax_behavior: z.string().max(40).nullish(),
  refunded_amount: Money.nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  customer_email: z.string().max(320).nullish(),
});
export type WhopPayment = z.infer<typeof WhopPayment>;

/** refund.created / refund.updated's data as the SDK types it (RefundLegacy, [W8]): decimal amounts, the payment nested. */
export const WhopRefundLegacy = z.object({
  id: z.string().regex(OBJECT_ID),
  amount: Amount,
  currency: Currency,
  status: z.string().max(40),
  payment: z.object({ id: z.string().regex(PAYMENT_ID) }),
});
/** The same as the native Refund resource ([W8b]): Money amounts, the payment by id. */
export const WhopRefundNative = z.object({
  id: z.string().regex(OBJECT_ID),
  payment_id: z.string().regex(PAYMENT_ID),
  amount: Money.nullable(),
  status: z.string().max(40),
});

/** A refund in cents of US dollars, whichever documented shape it came in (`partCents` null: no amount, or another currency). */
export interface RefundRead { id: string; paymentId: string; status: string; partCents: number | null }

/** Pure. Read refund.created / refund.updated's data in either documented shape; an amount in another currency reads as unknown. */
export function readRefund(data: unknown): RefundRead | { error: string } {
  const n = WhopRefundNative.safeParse(data);
  if (n.success) return { id: n.data.id, paymentId: n.data.payment_id, status: n.data.status, partCents: moneyCents(n.data.amount) };
  const l = WhopRefundLegacy.safeParse(data);
  if (l.success) return { id: l.data.id, paymentId: l.data.payment.id, status: l.data.status, partCents: usdCents(l.data.amount, l.data.currency) };
  return { error: l.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join(".") || "data"}: ${i.message}`).join("; ") };
}

/** dispute.created / dispute.updated's data (Dispute, [W8]). */
export const WhopDispute = z.object({
  id: z.string().regex(OBJECT_ID),
  amount: Amount,
  currency: Currency,
  status: z.string().max(40),
  inquiry: z.boolean().nullish(),
  payment: z.object({ id: z.string().regex(PAYMENT_ID) }),
});
export type WhopDispute = z.infer<typeof WhopDispute>;

/** The event types acted on; every other type is answered 200 and ignored. */
export const HANDLED_EVENTS = ["payment.succeeded", "refund.created", "refund.updated", "dispute.created", "dispute.updated"] as const;

/**
 * [W8], [W9]: a formal dispute in one of these statuses has taken the money back (or will: needs_response and
 * under_review hold the disputed funds), so its credits go; won and closed leave the money with the seller.
 */
export const DISPUTE_REVERSES = new Set(["needs_response", "under_review", "lost", "prevented"]);
export const DISPUTE_RETURNS = new Set(["won", "closed"]);

/** Pure. An exact decimal string in major units ([W7] Money.amount) as whole US cents; anything else is null. */
export function moneyCents(m: { amount: string; currency: string } | null | undefined): number | null {
  if (!m || m.currency.toLowerCase() !== CARD_CURRENCY) return null;
  const x = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(m.amount.trim());
  if (!x) return null;
  const frac = (x[2] ?? "").padEnd(6, "0");
  if (!/^\d{2}0{4}$/.test(frac)) return null; // a fraction of a cent is not a price this code sells at
  return Number(x[1]) * 100 + Number(frac.slice(0, 2));
}

/** Pure. A decimal amount in major units ([W8] refund and dispute amounts) as whole cents, when it is one. */
export function floatCents(amount: number | null | undefined): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e9) return null;
  const c = Math.round(amount * 100);
  return Math.abs(c - amount * 100) < 1e-6 ? c : null;
}

/**
 * Pure. What the buyer paid for the pack, in US cents: the total less any tax added on top of the price ([W7]
 * tax_behavior exclusive), or the error that stops the grant. Only US dollars are sold.
 */
export function paidCents(p: WhopPayment): { cents: number } | { error: string } {
  if (p.currency.toLowerCase() !== CARD_CURRENCY) return { error: `currency is ${p.currency}, not ${CARD_CURRENCY}` };
  if (!p.total) return { error: "no total" };
  const total = moneyCents(p.total);
  if (total === null) return { error: `total ${p.total.amount} ${p.total.currency} is not a whole-cent ${CARD_CURRENCY} amount` };
  const tax = p.tax_amount ? moneyCents(p.tax_amount) : 0;
  if (tax === null) return { error: `tax_amount ${p.tax_amount!.amount} ${p.tax_amount!.currency} is not a whole-cent ${CARD_CURRENCY} amount` };
  if (p.tax_behavior === "exclusive") return { cents: total - tax };
  if (p.tax_behavior === "inclusive" || tax === 0) return { cents: total };
  return { error: `tax ${p.tax_amount!.amount} with tax_behavior ${p.tax_behavior ?? "null"}: whether it is inside the total is unknown` };
}

export type GrantDecision =
  | { result: "grant"; pack: PackId; credits: number; tenantId: string }
  /** The plan is not one of the packs; `configIncomplete` when a pack's plan variable is unset, so it may be one. */
  | { result: "unknown_plan"; configIncomplete: boolean }
  | { result: "not_paid"; pack: PackId }
  | { result: "amount_mismatch"; pack: PackId; detail: string }
  | { result: "refunded_already"; pack: PackId; detail: string }
  | { result: "no_tenant"; pack: PackId; detail: string };

/**
 * Pure. What a payment.succeeded grants: its pack from the PLAN ID alone (the server-side map), then the status, the
 * amount and currency against that pack's price, a refund already in the event, and the tenant in the metadata Resolve
 * set. The metadata never chooses the pack, and the amount never chooses it either.
 */
export function decideGrant(p: WhopPayment, cfg: WhopConfig): GrantDecision {
  const pack = p.plan_id ? cfg.plans.get(p.plan_id) : undefined;
  if (!pack) return { result: "unknown_plan", configIncomplete: cfg.planMissing.length > 0 };
  if (p.status !== "paid") return { result: "not_paid", pack };
  const paid = paidCents(p);
  if ("error" in paid) return { result: "amount_mismatch", pack, detail: paid.error };
  if (paid.cents !== CARD_PACKS[pack].priceCents) return { result: "amount_mismatch", pack, detail: `paid ${usd(paid.cents)}, the pack costs ${usd(CARD_PACKS[pack].priceCents)}` };
  const refunded = p.refunded_amount ? moneyCents(p.refunded_amount) : 0;
  if (refunded !== 0) return { result: "refunded_already", pack, detail: `refunded_amount ${p.refunded_amount!.amount} ${p.refunded_amount!.currency}` };
  const t = p.metadata?.[TENANT_METADATA_KEY];
  if (typeof t !== "string" || !UUID.test(t)) return { result: "no_tenant", pack, detail: t === undefined ? `no ${TENANT_METADATA_KEY} in the metadata (not a checkout Resolve opened)` : `${TENANT_METADATA_KEY} is not a tenant id` };
  return { result: "grant", pack, credits: CARD_PACKS[pack].credits, tenantId: t.toLowerCase() };
}

/**
 * Pure. The credits a refund or dispute of `partCents` takes back of the `granted` of a pack priced `wholeCents` (both US
 * cents): proportional, rounded up so a refunded cent never keeps its credits, when both are known and the part is less
 * than the whole; else all of them. The whole is always the pack's price (packPriceFor), never a payload's total: the
 * legacy and native refund shapes then agree, and tax added on top never lowers what a refund of the price takes.
 */
export function reversalCredits(granted: number, partCents: number | null, wholeCents: number | null): { credits: number; proportional: boolean } {
  if (partCents === null || wholeCents === null || wholeCents <= 0 || partCents >= wholeCents) return { credits: granted, proportional: false };
  return { credits: Math.min(granted, Math.ceil((granted * Math.max(0, partCents)) / wholeCents)), proportional: true };
}

/** Pure. The price of the pack that grants `credits`: the base of every reversal (null for a grant of another size: all of it goes). */
export function packPriceFor(credits: number): number | null {
  const p = PACK_IDS.find((k) => CARD_PACKS[k].credits === credits);
  return p ? CARD_PACKS[p].priceCents : null;
}

/** Pure. A decimal amount ([W8] dispute and legacy refund amounts) in US dollars as cents, or null in another currency. */
export const usdCents = (amount: number | null | undefined, currency: string | null | undefined): number | null => (currency?.toLowerCase() === CARD_CURRENCY ? floatCents(amount) : null);

export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

// ---- opening a checkout ([W5], [W10]) -------------------------------------------------------------------------------

/** Pure. A purchase_url Resolve may send a buyer to: https on Whop's checkout host for this configuration, nothing else. */
export function checkoutUrlAllowed(url: unknown, cfg: WhopConfig): url is string {
  if (typeof url !== "string" || url.length > 2048) return false;
  try {
    const u = new URL(url);
    const want = new URL(cfg.checkoutOrigin);
    return u.protocol === "https:" && u.host === want.host && !u.username && !u.password;
  } catch { return false; }
}

export type CheckoutResult = { ok: true; url: string; id: string } | { ok: false; status: number | null; detail: string };

const CheckoutAnswer = z.object({
  id: z.string().regex(/^ch_[A-Za-z0-9]{1,64}$/),
  purchase_url: z.string().nullable(),
  plan: z.object({ id: z.string() }).nullish(),
});

/**
 * Open a Whop checkout for one pack: a checkout configuration for the pack's plan whose metadata names the tenant (its
 * id only: a key is never sent to Whop), created at WHOP_API_VERSION_DATE with an Idempotency-Key. The answer must name
 * a ch_ configuration for the same plan and a purchase_url on Whop's checkout host. One subrequest; 8 s timeout. The
 * detail of a failure never carries the API key.
 */
export async function createWhopCheckout(cfg: WhopConfig, o: { pack: PackId; tenantId: string; redirectUrl: string; idempotencyKey: string }): Promise<CheckoutResult> {
  const planId = cfg.planOf[o.pack];
  if (!cfg.apiKey || !planId) return { ok: false, status: null, detail: `not configured: ${[...(cfg.apiKey ? [] : ["WHOP_API_KEY"]), ...(planId ? [] : [CARD_PACKS[o.pack].planVar])].join(", ")}` };
  const scrub = (s: string) => redact(s.split(cfg.apiKey!).join("[redacted]")).slice(0, 300);
  let res: Response;
  try {
    res = await fetch(`${cfg.apiBase}/checkout_configurations`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json", accept: "application/json", "api-version-date": WHOP_API_VERSION_DATE, "idempotency-key": o.idempotencyKey },
      body: JSON.stringify({ plan_id: planId, mode: "payment", metadata: { [TENANT_METADATA_KEY]: o.tenantId }, redirect_url: o.redirectUrl }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return { ok: false, status: null, detail: scrub(`request failed: ${String(e)}`) };
  }
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = (body as { error?: { message?: unknown } } | null)?.error?.message;
    return { ok: false, status: res.status, detail: scrub(`Whop answered ${res.status}${typeof msg === "string" ? `: ${msg}` : ""}`) };
  }
  const a = CheckoutAnswer.safeParse(body);
  if (!a.success) return { ok: false, status: res.status, detail: "Whop answered without a checkout configuration id" };
  if (a.data.plan && a.data.plan.id !== planId) return { ok: false, status: res.status, detail: `Whop's checkout is for plan ${scrub(a.data.plan.id)}, not ${planId}` };
  if (!checkoutUrlAllowed(a.data.purchase_url, cfg)) return { ok: false, status: res.status, detail: `purchase_url is not an https URL on ${new URL(cfg.checkoutOrigin).host}` };
  return { ok: true, url: a.data.purchase_url, id: a.data.id };
}

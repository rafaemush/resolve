/**
 * Card checkout routes (plan §21.4 C; src/billing/whop.ts has the sources and the rules):
 *   POST /webhooks/whop        public: Whop's signed events. The raw body is read before anything parses it; a request
 *                              that fails the signature or timestamp check answers 401 and nothing is stored. Verified
 *                              events move credits through src/billing/whop-events.ts whether or not checkout is
 *                              switched on, so a test event from the Whop dashboard is answered and recorded.
 *   POST /v1/billing/checkout  authenticated (the v1 key middleware): {pack: "20" | "50" | "250"} opens a Whop checkout
 *                              for the calling tenant and answers its URL. 503 while WHOP_CHECKOUT_ENABLED is not "1".
 *   POST /billing/checkout     the /pricing form (src/api/site.ts): the same with the key in the form body, answered with
 *                              a 303 to Whop.
 * The key is never logged, echoed, alerted, cached, sent to Whop or put in a URL: Whop receives the tenant id only, and
 * every answer of these routes is no-store.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { ok, err, requestId } from "./envelope";
import type { AuthContext } from "./auth";
import { alert } from "../ops/alerts";
import { CARD_PACKS, CARD_CURRENCY, HANDLED_EVENTS, PACK_IDS, WhopEnvelope, createWhopCheckout, usd, verifyWhopSignature, whopConfig, type CheckoutResult, type PackId, type WhopConfig } from "../billing/whop";
import { configMissing, handleWhopEvent } from "../billing/whop-events";

type Vars = { requestId: string; schemaVersion: string };

/** Whop's payloads are a few kilobytes; anything far larger is refused before it is read. */
export const WEBHOOK_MAX_BYTES = 262_144;

/** Every answer no-store, the auth middleware's refusals included (mounted before the v1 router in src/index.ts). */
export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
};

const eventLabel = (t: string) => (/^[a-z0-9_.]{1,64}$/.test(t) ? t : "unrecognized");
const logLine = (o: Record<string, unknown>) => console.log(JSON.stringify({ job: "whop_webhook", ...o }));

export const whopWebhook = new Hono<{ Bindings: Env; Variables: Vars }>();

whopWebhook.post("/webhooks/whop", async (c) => {
  c.header("Cache-Control", "no-store");
  const cfg = whopConfig(c.env);
  if (Number(c.req.header("content-length") ?? 0) > WEBHOOK_MAX_BYTES) return err(c, "validation_error", "body too large", 413);
  // The raw body, exactly as sent: the signature covers these bytes, so nothing parses it first.
  const raw = await c.req.text();
  if (raw.length > WEBHOOK_MAX_BYTES) return err(c, "validation_error", "body too large", 413);
  if (!cfg.webhookSecret) {
    const a = await configMissing(c.env, ["WHOP_WEBHOOK_SECRET"], "A Whop webhook");
    return err(c, "UPSTREAM_UNAVAILABLE", a.message ?? "not configured", 503);
  }
  const v = await verifyWhopSignature(cfg.webhookSecret, { id: c.req.header("webhook-id"), timestamp: c.req.header("webhook-timestamp"), signature: c.req.header("webhook-signature") }, raw);
  if (!v.ok) {
    // Nothing from the request is stored or logged: only that one was refused, and why.
    logLine({ outcome: "unverified", reason: v.reason });
    return err(c, "invalid_signature", "webhook signature not verified", 401);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const ev = WhopEnvelope.safeParse(parsed);
  if (!ev.success) {
    await alert(c.env, "whop_envelope_unreadable", `A verified Whop webhook (webhook-id ${String(c.req.header("webhook-id")).slice(0, 80)}) is not a v1 event envelope: ${ev.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; ")}. Nothing was done; the webhook must use api_version v1.`, { dedupMinutes: 1440 });
    logLine({ outcome: "not_understood" });
    return ok(c, { received: true, result: "not_understood" });
  }
  const type = eventLabel(ev.data.type);
  if (!(HANDLED_EVENTS as readonly string[]).includes(ev.data.type)) {
    logLine({ outcome: "ignored", type });
    return ok(c, { received: true, type, result: "ignored" });
  }
  const a = await handleWhopEvent(c.env, cfg, ev.data);
  logLine({ outcome: a.result, type, status: a.status });
  if (a.status === 200) return ok(c, { received: true, type, result: a.result, ...(a.detail ?? {}) });
  return err(c, a.status === 409 ? "conflict" : "UPSTREAM_UNAVAILABLE", a.message ?? a.result, a.status, { extra: { result: a.result } });
});

// ---- opening a checkout ---------------------------------------------------------------------------------------------

export const NOT_AVAILABLE = "Card checkout is not yet available.";

/** Why a checkout cannot be opened right now (switched off, or missing configuration, alerted once a day), or null. */
export async function checkoutRefusal(env: Env, cfg: WhopConfig, route: string): Promise<{ status: 503; message: string } | null> {
  if (!cfg.checkoutEnabled) return { status: 503, message: NOT_AVAILABLE };
  if (cfg.checkoutMissing.length) {
    await configMissing(env, cfg.checkoutMissing, `A checkout (${route})`);
    return { status: 503, message: "Card checkout is not available right now. Nothing was charged." };
  }
  return null;
}

/** Where Whop sends the buyer after paying: a static page that trusts no query parameter (GET /billing/done). */
export function doneUrl(env: Env, reqUrl: string): string {
  return `${env.RESOLVE_PUBLIC_URL?.replace(/\/+$/, "") || new URL(reqUrl).origin}/billing/done`;
}

/**
 * Open the checkout for the authenticated tenant: the tenant id and nothing of the key goes to Whop. A failure is
 * alerted (hourly at most) with its reason and the tenant, never the key.
 */
export async function startCheckout<E extends { Bindings: Env }>(c: Context<E>, cfg: WhopConfig, auth: Pick<AuthContext, "tenantId">, pack: PackId): Promise<CheckoutResult> {
  const r = await createWhopCheckout(cfg, { pack, tenantId: auth.tenantId, redirectUrl: doneUrl(c.env, c.req.url), idempotencyKey: `resolve-checkout:${requestId(c)}` });
  if (!r.ok) {
    await alert(c.env, "whop_checkout_failed", `A Whop checkout could not be opened for tenant ${auth.tenantId} (${usd(CARD_PACKS[pack].priceCents)} pack): ${r.detail}. The buyer was told nothing was charged.`, { dedupMinutes: 60, meta: { tenant_id: auth.tenantId, pack, status: r.status } });
    console.log(JSON.stringify({ job: "whop_checkout", outcome: "failed", status: r.status, tenant_id: auth.tenantId }));
  } else {
    console.log(JSON.stringify({ job: "whop_checkout", outcome: "opened", checkout_id: r.id, tenant_id: auth.tenantId, pack }));
  }
  return r;
}

const CheckoutBody = z.object({ pack: z.union([z.enum(PACK_IDS as [PackId, ...PackId[]]), z.literal(20).transform(() => "20" as const), z.literal(50).transform(() => "50" as const), z.literal(250).transform(() => "250" as const)]) });

export const billingV1 = new Hono<{ Bindings: Env; Variables: Vars & { auth: AuthContext } }>();

billingV1.post("/checkout", async (c) => {
  c.header("Cache-Control", "no-store");
  const cfg = whopConfig(c.env);
  const refused = await checkoutRefusal(c.env, cfg, "POST /v1/billing/checkout");
  if (refused) return err(c, "UPSTREAM_UNAVAILABLE", refused.message, refused.status);
  const b = CheckoutBody.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return err(c, "validation_error", `pack must be one of ${PACK_IDS.map((p) => `"${p}"`).join(", ")}`, 400);
  const pack = b.data.pack;
  const r = await startCheckout(c, cfg, c.get("auth"), pack);
  if (!r.ok) return err(c, "UPSTREAM_UNAVAILABLE", "The checkout could not be opened right now. Nothing was charged; try again in a few minutes.", 503);
  return ok(c, {
    checkout_url: r.url, checkout_id: r.id, pack, price: (CARD_PACKS[pack].priceCents / 100).toFixed(2), currency: CARD_CURRENCY, credits: CARD_PACKS[pack].credits,
    merchant_of_record: "Whop",
    note: "Open checkout_url to pay by card. The credits are added to this account once the payment is confirmed. Credits are a non-refundable prepayment for API services and do not expire while the account is open; a card refund or chargeback removes them.",
  });
});

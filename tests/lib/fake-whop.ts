/**
 * Test helpers for the Whop card checkout (src/billing/whop.ts): webhook requests signed the way Whop signs them
 * (HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<raw body>" keyed by the literal secret, base64, "v1,<sig>"),
 * computed with node:crypto so a test never trusts the code under test to sign; event builders in the shape a webhook
 * pinned to api_version_date 2026-09-29 sends (payment.succeeded: Payment; refund.*: RefundLegacy; dispute.*: Dispute);
 * and the rpc stand-ins the routes call (migration 004's grant_credits, migration 005's rate_limit_hit), step for step
 * over the in-memory database (tests/lib/fake-db.ts).
 */
import { createHmac } from "node:crypto";
import type { FakeDbOptions } from "./fake-db";
import { grantCredits } from "./fake-money";
import { rateLimitHit } from "./fake-request-key";

export const WHOP_SECRET = `ws_${"0123456789abcdef".repeat(4)}`;
/** The $20 pack's plan as wrangler.toml sets it (a real plan id: the webhook must grant 2,000 credits for exactly this one). */
export const PLAN_20 = "plan_PNgCSGmXG38KW";
export const PLAN_50 = "plan_Pack50xxxxxxxx";
export const PLAN_250 = "plan_Pack250xxxxxxx";
export const WHOP_RPCS: NonNullable<FakeDbOptions["rpc"]> = { grant_credits: grantCredits, rate_limit_hit: rateLimitHit };

export const whopSign = (secret: string, id: string, ts: string, body: string): string => createHmac("sha256", secret).update(`${id}.${ts}.${body}`).digest("base64");

let seq = 0;
/**
 * A POST /webhooks/whop request for `event`, signed now with WHOP_SECRET unless told otherwise: `signedBody` is what the
 * signature covers when it differs from what is sent (a tampered body), `signature` replaces the header (null drops it).
 */
export function whopRequest(event: unknown, o: { secret?: string; id?: string; ts?: number; signature?: string | null; signedBody?: string } = {}): RequestInit {
  const body = JSON.stringify(event);
  const id = o.id ?? `msg_test${++seq}`;
  const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts };
  const sig = o.signature === undefined ? `v1,${whopSign(o.secret ?? WHOP_SECRET, id, ts, o.signedBody ?? body)}` : o.signature;
  if (sig !== null) headers["webhook-signature"] = sig;
  return { method: "POST", headers, body };
}

const money = (amount: string, currency = "usd") => ({ amount, currency, decimals: 2, display_decimals: 2 });

/** A v1 envelope ([W1]). */
export function envelope(type: string, data: unknown, id = `msg_evt${++seq}`) {
  return { id, type, api_version: "v1", api_version_date: "2026-09-29", timestamp: "2026-09-30T12:00:00.000Z", account_id: "biz_test", data };
}

/** payment.succeeded for the $50 pack paid in full by a buyer of `tenantId` (pass data fields to change any of it). */
export function paymentSucceeded(tenantId: string | null, data: Record<string, unknown> = {}, id?: string) {
  return envelope("payment.succeeded", {
    id: "pay_test50", status: "paid", substatus: "succeeded", plan_id: PLAN_50, product_id: "prod_test", currency: "usd",
    total: money("50.00"), subtotal: money("50.00"), usd_total: money("50.00"), tax_amount: null, tax_behavior: null,
    refunded_amount: null, amount_after_fees: money("47.20"), customer_email: "buyer@example.com",
    metadata: tenantId === null ? {} : { resolve_tenant_id: tenantId }, checkout_configuration_id: "ch_test",
    created_at: "2026-09-30T11:59:00.000Z", paid_at: "2026-09-30T11:59:30.000Z", ...data,
  }, id);
}
export { money as whopMoney };

/** refund.created / refund.updated (RefundLegacy): `amount` of the payment's `total`, both in dollars. */
export function refundEvent(type: "refund.created" | "refund.updated", o: { id?: string; paymentId?: string; amount?: number | null; total?: number | null; status?: string; currency?: string } = {}) {
  return envelope(type, {
    id: o.id ?? "ref_test1", amount: o.amount === undefined ? 50 : o.amount, currency: o.currency ?? "usd", status: o.status ?? "succeeded", provider: "stripe", created_at: "2026-10-01T10:00:00.000Z",
    payment: { id: o.paymentId ?? "pay_test50", total: o.total === undefined ? 50 : o.total, subtotal: 50, currency: "usd", plan: { id: PLAN_50 }, metadata: {}, created_at: "2026-09-30T11:59:00.000Z" },
  });
}

/** refund.created / refund.updated as the native Refund resource (Money amount, payment_id). */
export function nativeRefundEvent(type: "refund.created" | "refund.updated", o: { id?: string; paymentId?: string; amount?: string | null; status?: string } = {}) {
  return envelope(type, {
    id: o.id ?? "rf_test1", payment_id: o.paymentId ?? "pay_test50", account_id: "biz_test", status: o.status ?? "succeeded",
    amount: o.amount === null ? null : money(o.amount ?? "50.00"), original_amount: money(o.amount ?? "50.00"), provider: "stripe", reason: "requested_by_customer",
    failure_reason: null, failure_message: null, reference_status: null, reference_type: null, reference_value: null, visa_rdr: false,
    provider_created_at: null, created_at: "2026-10-01T10:00:00.000Z", updated_at: "2026-10-01T10:00:00.000Z",
  });
}

/** dispute.created / dispute.updated (Dispute). */
export function disputeEvent(type: "dispute.created" | "dispute.updated", o: { id?: string; paymentId?: string; amount?: number | null; paymentAmount?: number | null; status?: string; inquiry?: boolean } = {}) {
  return envelope(type, {
    id: o.id ?? "dspt_test1", amount: o.amount === undefined ? 50 : o.amount, currency: "usd", status: o.status ?? "needs_response", inquiry: o.inquiry ?? false, reason: "fraudulent",
    buyer: { email: "buyer@example.com", member_id: null, name: null, user_id: null, username: null }, plan_id: PLAN_50, product_id: "prod_test",
    payment: { id: o.paymentId ?? "pay_test50", amount: o.paymentAmount === undefined ? 50 : o.paymentAmount, currency: "usd", created_at: "2026-09-30T11:59:00.000Z" },
    created_at: "2026-10-02T10:00:00.000Z", updated_at: "2026-10-02T10:00:00.000Z",
  });
}

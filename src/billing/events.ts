/**
 * Money events (plan §16.4 P3 step 3). payment.credited goes out when a deposit is credited: by the deposit scan
 * (credit_from_deposit answered 'credited') and by a manual match (match_deposit). credits.low goes out when a charge
 * that stands leaves the balance below app_config low_credit_threshold, once per crossing: claim_low_credit_notice()
 * (migration 020) sets tenants.low_credit_notified_at, and the next purchase or grant clears it. Its top_up points to
 * the card rail while card checkout is offered, else to the pricing page, never to the USDC address: no third-party
 * USDC is solicited (the charge that crosses may be a free key's first print, GET /v1/prints/{series}/{period}).
 * Payload builders are pure.
 */
import { z } from "zod";
import type { Env } from "../env";
import { db, rpc } from "../db/supabase";
import { alert } from "../ops/alerts";
import { COST } from "../ops/budget";
import { redact } from "../ops/redact";
import { queueEvents, type EventItem } from "../webhooks/deliver";
import { formatUsdc, parseUsdc } from "./tiers";
import { cardCheckoutOffered, whopConfig } from "./whop";

export interface PaymentCredited { tx_hash: string; log_index: number; amount_usdc: string; credits: number; balance_after: number }

/** Pure. The payment.credited payload; amount_usdc is the exact decimal ("250", "2.5"), never a float. */
export function paymentCreditedPayload(p: PaymentCredited): Record<string, unknown> {
  return { tx_hash: p.tx_hash.toLowerCase(), log_index: p.log_index, amount_usdc: formatUsdc(parseUsdc(p.amount_usdc)), credits: p.credits, balance_after: p.balance_after };
}

export interface CreditsLow { balance: number; threshold: number; request_id: string; top_up: string }

/** Pure. Where credits.low points to top up: the card rail while it is offered (src/billing/whop.ts), else /pricing. Never the USDC address. */
export function creditsLowTopUp(env: Env): string {
  return cardCheckoutOffered(whopConfig(env)) ? "POST /v1/billing/checkout" : "/pricing";
}

/** Pure. The credits.low payload: the balance the charge left, the threshold it fell below, the charge that crossed it, where to top up. */
export function creditsLowPayload(p: CreditsLow): Record<string, unknown> {
  return { balance: p.balance, threshold: p.threshold, request_id: p.request_id, top_up: p.top_up };
}

// ---- payment.credited from the deposit scan ---------------------------------------------------------------------------

/** A deposit credit_from_deposit answered 'credited' for. */
export interface CreditedDeposit { tenant: string; tx: string; logIndex: number; amountUsdc: string; credits: number }

/** queuePaymentsCredited's subrequests, whatever the number of deposits: the ledger read, the endpoint read, the insert. */
export const PAYMENT_EVENTS_COST = 3 * COST.db;

/**
 * payment.credited for every deposit one scan credited, in PAYMENT_EVENTS_COST subrequests: balance_after comes from the
 * purchase ledger rows (credit_from_deposit keeps its pre-020 return shape, which has no balance), read in one query,
 * then one queueEvents(). No alert of its own (the scan carries it in its run's alertMany()); a deposit whose ledger row
 * is not in the answer is reported in `error`, never sent with a made-up balance.
 */
export async function queuePaymentsCredited(env: Env, credited: readonly CreditedDeposit[]): Promise<{ queued: number; error: string | null }> {
  if (!credited.length) return { queued: 0, error: null };
  const key = (tx: string, logIndex: number) => `${tx}#${logIndex}`;
  const { data, error } = await db(env).from("credit_ledger").select("tx_hash, log_index, balance_after").eq("reason", "purchase").in("tx_hash", [...new Set(credited.map((c) => c.tx))]);
  if (error) return { queued: 0, error: `the purchase ledger read failed (${redact(error.message)})` };
  const balance = new Map(((data ?? []) as Array<{ tx_hash: string; log_index: number; balance_after: number }>).map((r) => [key(r.tx_hash, Number(r.log_index)), Number(r.balance_after)]));
  const items: EventItem[] = [];
  const missing: string[] = [];
  for (const c of credited) {
    const after = balance.get(key(c.tx, c.logIndex));
    if (after === undefined) { missing.push(key(c.tx, c.logIndex)); continue; }
    items.push({ tenant: c.tenant, eventType: "payment.credited", payload: paymentCreditedPayload({ tx_hash: c.tx, log_index: c.logIndex, amount_usdc: c.amountUsdc, credits: c.credits, balance_after: after }) });
  }
  const q = await queueEvents(env, items);
  const problems = [...(missing.length ? [`no purchase ledger row for ${missing.join(", ")}`] : []), ...(q.error ? [q.error] : [])];
  return { queued: q.rows.length, error: problems.length ? problems.join("; ") : null };
}

// ---- credits.low after a charge -------------------------------------------------------------------------------------

const LowCreditClaim = z.union([
  z.object({ crossed: z.literal(true), balance: z.number().int(), threshold: z.number().int() }),
  z.object({ crossed: z.literal(false), balance: z.number().int().nullable(), threshold: z.number().int() }),
]);

/**
 * After a charge that stands (not refunded): claim the low-credit notice and, when this charge crossed, queue credits.low.
 * Subrequests: 1 (the claim); 3 at the crossing (+ the endpoint read and the insert; the 5-minute drain delivers it, a
 * low balance does not need an inline attempt); on a failure + the release and one alert (5). Never throws: a claim that
 * fails is alerted and the next charge claims again; an event that could not be queued gives its claim back.
 */
export async function noteCharge(env: Env, tenantId: string, requestId: string): Promise<{ crossed: boolean; queued: number }> {
  const meta = { tenant_id: tenantId, request_id: requestId };
  try {
    const client = db(env);
    const out = await rpc<unknown>(client, "claim_low_credit_notice", { p_tenant: tenantId });
    const claim = LowCreditClaim.parse(Array.isArray(out) ? out[0] : out);
    if (!claim.crossed) return { crossed: false, queued: 0 };
    const q = await queueEvents(env, [{ tenant: tenantId, eventType: "credits.low", payload: creditsLowPayload({ balance: claim.balance, threshold: claim.threshold, request_id: requestId, top_up: creditsLowTopUp(env) }) }]);
    if (!q.error) return { crossed: true, queued: q.rows.length };
    let released = "given back: the next charge queues it again";
    try { await rpc(client, "release_low_credit_notice", { p_tenant: tenantId }); }
    catch (e) { released = `not given back either (${redact(String(e)).slice(0, 120)}): no credits.low until the next purchase or grant`; }
    await alert(env, "low_credit_event_failed", `credits.low for tenant ${tenantId} (balance ${claim.balance} < ${claim.threshold}) was not queued: ${q.error}. The notice was ${released}.`, { dedupMinutes: 60, meta });
    return { crossed: true, queued: 0 };
  } catch (e) {
    await alert(env, "low_credit_check_failed", `claim_low_credit_notice failed after charge ${requestId} (tenant ${tenantId}); credits.low waits for the next charge: ${redact(String(e)).slice(0, 200)}`, { dedupMinutes: 60, meta });
    return { crossed: false, queued: 0 };
  }
}

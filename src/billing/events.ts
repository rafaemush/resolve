/**
 * Money events (plan §16.4 P3 step 3). payment.credited goes out when a deposit is credited: by the deposit scan
 * (credit_from_deposit answered 'credited') and by a manual match (match_deposit). credits.low goes out when a charge
 * that stands leaves the balance below app_config low_credit_threshold, once per crossing: claim_low_credit_notice()
 * (migration 020) sets tenants.low_credit_notified_at, and the next purchase or grant clears it. Its top_up points to
 * the card rail while card checkout is offered, else to support, never to the USDC address (src/billing/top-up.ts).
 * The same crossing alerts the operator once (plan §22.3 #2): a free key's first charge crosses (300 < 500), so on the
 * free plan it is the "first paid use" signal. Payload builders are pure.
 */
import { z } from "zod";
import type { Env } from "../env";
import { db, rpc, type Db } from "../db/supabase";
import { alert, alertMany, type AlertItem } from "../ops/alerts";
import { COST } from "../ops/budget";
import { redact } from "../ops/redact";
import { queueEvents, type EventItem } from "../webhooks/deliver";
import { formatUsdc, parseUsdc } from "./tiers";
import { publicBase, topUp, type TopUp } from "./top-up";

export interface PaymentCredited { tx_hash: string; log_index: number; amount_usdc: string; credits: number; balance_after: number }

/** Pure. The payment.credited payload; amount_usdc is the exact decimal ("250", "2.5"), never a float. */
export function paymentCreditedPayload(p: PaymentCredited): Record<string, unknown> {
  return { tx_hash: p.tx_hash.toLowerCase(), log_index: p.log_index, amount_usdc: formatUsdc(parseUsdc(p.amount_usdc)), credits: p.credits, balance_after: p.balance_after };
}

export interface CreditsLow { balance: number; threshold: number; request_id: string; top_up: TopUp }

/**
 * Pure. The credits.low payload: the balance the charge left, the threshold it fell below, the charge that crossed it,
 * and where to top up (the card rail, or support: never the USDC address).
 */
export function creditsLowPayload(p: CreditsLow): Record<string, unknown> {
  return { balance: p.balance, threshold: p.threshold, request_id: p.request_id, top_up: p.top_up };
}

/** The operator's credits.low alert stays in the dedup table this long; its key names the crossing, so it is sent once. */
export const CREDITS_LOW_ALERT_DEDUP_MINUTES = 1440;

/**
 * Pure. The operator's alert for one crossing (plan §22.3 #2): the tenant, its plan, the balance and threshold, and the
 * pay-by-card page the tenant was pointed to. Keyed by tenant and the charge that crossed, so each crossing alerts once.
 * Never a key, never an email address: ids and numbers only.
 */
export function creditsLowAlert(o: { tenantId: string; plan: string | null; balance: number; threshold: number; requestId: string; topUp: TopUp }): AlertItem {
  const first = o.plan === "free";
  return {
    key: `credits_low_${o.tenantId}_${o.requestId}`,
    text: [
      `Credits low${first ? ": first paid use (free plan)" : ""}`,
      `Tenant: ${o.tenantId}`,
      `Plan: ${o.plan ?? "unknown (the plan could not be read)"}`,
      `Balance: ${o.balance}, below the threshold of ${o.threshold}, after charge ${o.requestId}`,
      o.topUp.method === "card"
        ? `Pay by card: ${o.topUp.page} (packs ${o.topUp.packs.map((p) => `$${Number(p.price)} = ${p.credits} credits`).join(", ")})`
        : `Card checkout is not offered: the tenant was told to contact support (${o.topUp.page})`,
    ].join("\n"),
    dedupMinutes: CREDITS_LOW_ALERT_DEDUP_MINUTES,
    meta: { tenant_id: o.tenantId, request_id: o.requestId, plan: o.plan, balance: o.balance, threshold: o.threshold, first_paid_use: first, top_up: o.topUp.method },
  };
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

/** tenants.plan for the operator alert when the caller does not hold it; null when it cannot be read (the alert still goes). */
async function planOf(client: Db, tenantId: string): Promise<string | null> {
  try {
    const { data, error } = await client.from("tenants").select("plan").eq("id", tenantId).maybeSingle();
    return !error && typeof (data as { plan?: unknown } | null)?.plan === "string" ? (data as { plan: string }).plan : null;
  } catch { return null; }
}

/**
 * After a charge that stands (not refunded): claim the low-credit notice and, when this charge crossed, queue credits.low
 * and alert the operator (creditsLowAlert). `plan` is the tenant's plan when the caller holds it (POST /v1/resolve: the
 * key's); without it the crossing reads it. `base` is the public origin the pointers use (publicBase). Subrequests: 1
 * (the claim); at the crossing + the endpoint read and the insert (the 5-minute drain delivers it, a low balance does
 * not need an inline attempt), + the plan read when not given, + one alert (5): 9 at most; an event that could not be
 * queued: + the release and the failure alert instead, the operator's alert in the same DM when the notice could not be
 * given back: 10 at most. Never throws, and no alert can fail the charge: a claim that fails is alerted and the next
 * charge claims again; an event that could not be queued gives its claim back, and the charge that claims it again
 * sends the operator's alert then (once per crossing).
 */
export async function noteCharge(env: Env, tenantId: string, requestId: string, o: { plan?: string; base?: string | null } = {}): Promise<{ crossed: boolean; queued: number }> {
  const meta = { tenant_id: tenantId, request_id: requestId };
  // alertMany never throws; this keeps a failure of the operator's alert from ever reaching the charge's path.
  const tell = (items: AlertItem[]) => alertMany(env, items).catch((e) => { console.error(JSON.stringify({ level: "error", job: "credits_low_alert", ...meta, error: redact(String(e)).slice(0, 200) })); });
  try {
    const client = db(env);
    const out = await rpc<unknown>(client, "claim_low_credit_notice", { p_tenant: tenantId });
    const claim = LowCreditClaim.parse(Array.isArray(out) ? out[0] : out);
    if (!claim.crossed) return { crossed: false, queued: 0 };
    const top = topUp(env, o.base !== undefined ? o.base : publicBase(env));
    const operator = async () => creditsLowAlert({ tenantId, plan: o.plan ?? (await planOf(client, tenantId)), balance: claim.balance, threshold: claim.threshold, requestId, topUp: top });
    const q = await queueEvents(env, [{ tenant: tenantId, eventType: "credits.low", payload: creditsLowPayload({ balance: claim.balance, threshold: claim.threshold, request_id: requestId, top_up: top }) }]);
    if (!q.error) {
      await tell([await operator()]);
      return { crossed: true, queued: q.rows.length };
    }
    let givenBack = true;
    let released = "given back: the next charge queues it again";
    try { await rpc(client, "release_low_credit_notice", { p_tenant: tenantId }); }
    catch (e) { givenBack = false; released = `not given back either (${redact(String(e)).slice(0, 120)}): no credits.low until the next purchase or grant`; }
    const failed: AlertItem = { key: "low_credit_event_failed", text: `credits.low for tenant ${tenantId} (balance ${claim.balance} < ${claim.threshold}) was not queued: ${q.error}. The notice was ${released}.`, dedupMinutes: 60, meta };
    // Given back, the charge that claims it again alerts the operator; otherwise no later charge will, so it goes now.
    await tell(givenBack ? [failed] : [failed, await operator()]);
    return { crossed: true, queued: 0 };
  } catch (e) {
    await alert(env, "low_credit_check_failed", `claim_low_credit_notice failed after charge ${requestId} (tenant ${tenantId}); credits.low waits for the next charge: ${redact(String(e)).slice(0, 200)}`, { dedupMinutes: 60, meta });
    return { crossed: false, queued: 0 };
  }
}

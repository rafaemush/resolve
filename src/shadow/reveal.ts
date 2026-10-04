/**
 * The price of the private early reveal (plan "1. Make it buyable", approved by the founder 2026-10-05; docs/pricing.md).
 * Free and pay-as-you-go tenants pay REVEAL_PRICE_CREDITS per RESOLVED leg revealed to them, at most
 * REVEAL_EVENT_CAP_CREDITS per event (markets.event_key, src/markets/event-key.ts) per tenant. Builder, Growth and
 * Platform include reveals; a free tenant created before REVEAL_PRICING_FROM keeps free reveals until its evaluation key
 * expires (followBlock ends them with the key). A verdict that is not RESOLVED (UNRESOLVED, ERROR) is revealed in full
 * and never charged.
 * The charge is taken once per (tenant, market), when a RESOLVED verdict is first released to the tenant: a
 * shadow.committed queued for it (src/shadow/events.ts), or its first read of GET /v1/shadow/:market_id or GET
 * /v1/shadow/export (src/api/v1.ts), whichever comes first; every later commit of the market, re-read and retry is a
 * replay, free. charge_reveals() (migration 023) decides and charges every (tenant, market) pair of one release in one
 * call. Here: the call and the parse of its answer (revealEntitlements), and the pure rules that turn an answer into what
 * the tenant receives, the verdict or a locked reveal (the market, the commitment and the evidence hashes, never the
 * verdict or a proposal, with the card pointer of src/billing/top-up.ts and never a USDC address).
 * Two rails (src/resolve/rails.ts; evals/reveal.ts proves both, evals/mutate.ts switches each off):
 *   reveal_charge  a RESOLVED verdict is released only through charge_reveals' answer (off: every entitled follower gets
 *                  it free, the behaviour before the price)
 *   reveal_lock    a reveal whose charge was refused (short balance, billing unavailable) is locked (off: the verdict
 *                  goes out anyway)
 * Pure except revealEntitlements.
 */
import { z } from "zod";
import { rpc, type Db } from "../db/supabase";
import { railEnabled } from "../resolve/rails";
import { redact } from "../ops/redact";
import { topUpText, type TopUp } from "../billing/top-up";
import { Plan } from "./follows";

/** Credits per RESOLVED leg revealed to a free or pay-as-you-go tenant (founder decision 2026-10-05). */
export const REVEAL_PRICE_CREDITS = 25;
/** At most this many credits per event (markets.event_key) per tenant: $20, the smallest card pack. */
export const REVEAL_EVENT_CAP_CREDITS = 2000;
/**
 * A charged reveal whose shadow.committed was not delivered to any of the tenant's endpoints within this many minutes of
 * committed_at is refunded once (refund_late_reveals(), migration 023, every 5 minutes): every delivery dead-lettered,
 * delivered late, or none queued. A charge taken by a read is never refunded.
 */
export const REVEAL_LATE_MINUTES = 10;
/**
 * The cut-over: a free-plan tenant created before it keeps free reveals until its evaluation key expires. It must not be
 * earlier than the deploy of the Worker that charges (a tenant created before that deploy signed up under free reveals);
 * a later value only grandfathers more keys. Pay as you go is never grandfathered.
 */
export const REVEAL_PRICING_FROM = "2026-10-10T00:00:00.000Z";
/** Plans whose reveals are included, as docs/pricing.md publishes them (the pilot and Design Partner accounts are platform). */
export const REVEAL_INCLUDED_PLANS = ["builder", "growth", "platform"] as const satisfies readonly Plan[];

export const includedPlan = (p: Plan | null): boolean => p !== null && (REVEAL_INCLUDED_PLANS as readonly string[]).includes(p);

/** What charge_reveals() answers per pair (migration 023). */
export const SQL_REASONS = ["included_plan", "grandfathered", "replay", "event_cap_reached", "charged", "insufficient_credits", "unknown_tenant"] as const;
/** Every reason a tenant can see: the SQL's, plus the two decided here (a verdict that is not RESOLVED, billing that could not be reached). */
export const REVEAL_REASONS = [...SQL_REASONS, "not_resolved", "billing_unavailable"] as const;
export type RevealReason = (typeof REVEAL_REASONS)[number];

/** One row of charge_reveals() (RETURNS TABLE, so PostgREST answers an array of these). */
export const ChargeRevealRow = z.object({
  tenant_id: z.string(),
  market_id: z.string(),
  plan: Plan.nullable(),
  entitled_full: z.boolean(),
  replayed: z.boolean(),
  charged: z.number().int().min(0),
  price: z.number().int().min(0),
  balance: z.number().int(),
  reason: z.enum(SQL_REASONS),
  low_credit: z.boolean().nullable(),
  low_credit_threshold: z.number().int().nullable(),
});

/** One pair's answer: charge_reveals()'s row, or one decided here (not RESOLVED, billing unavailable). balance null = not read. */
export interface RevealAnswer {
  tenant_id: string; market_id: string; plan: Plan | null;
  entitled_full: boolean; replayed: boolean; charged: number; price: number; balance: number | null; reason: RevealReason;
  low_credit: boolean | null; low_credit_threshold: number | null;
}

/** A follower and the market whose verdict would be released to it, with its plan (follow_entitlements, migration 014). */
export interface RevealPair { tenant_id: string; market_id: string; plan: Plan }
export type RevealSource = "webhook" | "read";

/** The credit_ledger request id of a reveal charge: "<kind>:<id>", unique per tenant and market, under 300 characters. */
export const revealRequestId = (tenantId: string, marketId: string): string => `reveal:${tenantId}:${marketId}`;

/**
 * Pure. The charge for one leg given what the tenant already paid for reveals of the same event (net of refunds): the
 * price, or what is left under the event cap, never below 0. charge_reveals() computes the same in SQL.
 */
export function revealCharge(spentOnEvent: number, price = REVEAL_PRICE_CREDITS, cap = REVEAL_EVENT_CAP_CREDITS): number {
  return Math.min(price, Math.max(0, cap - spentOnEvent));
}

/**
 * Pure. Who pays, before the ledger is read: an included plan never, a free tenant created before the cut-over never
 * (grandfathered), everyone else pays (a replay or the event cap may still make the leg free). charge_reveals() applies
 * the same order in SQL; the Worker uses this where it cannot ask (billing unavailable) and to word the docs' table.
 */
export function revealTerms(plan: Plan, createdAt: string | null, pricingFrom = REVEAL_PRICING_FROM): "included_plan" | "grandfathered" | "pays" {
  if (includedPlan(plan)) return "included_plan";
  if (plan === "free" && createdAt !== null && Date.parse(createdAt) < Date.parse(pricingFrom)) return "grandfathered";
  return "pays";
}

const local = (p: RevealPair, reason: Extract<RevealReason, "not_resolved" | "included_plan" | "billing_unavailable">): RevealAnswer => ({
  tenant_id: p.tenant_id, market_id: p.market_id, plan: p.plan,
  entitled_full: reason !== "billing_unavailable", replayed: false, charged: 0,
  price: reason === "billing_unavailable" ? REVEAL_PRICE_CREDITS : 0, balance: null, reason, low_credit: null, low_credit_threshold: null,
});

/**
 * Pure. The answer when charge_reveals() could not be asked or answered: an included plan still gets the verdict (it
 * never pays); every other follower gets a locked reveal with reason billing_unavailable. Nothing is released free that
 * should have been paid for, and nothing is dropped. A grandfathered evaluation key is locked too (its creation time is
 * not known without the call); its next read is free.
 */
export const billingUnavailable = (p: RevealPair): RevealAnswer => local(p, includedPlan(p.plan) ? "included_plan" : "billing_unavailable");

const pairKey = (t: string, m: string) => `${t}|${m}`;

/**
 * The reveal answers for these pairs. A verdict that is not RESOLVED needs no call (every follower gets it, free); a
 * RESOLVED one goes through charge_reveals() in one RPC (`source` webhook or read, which the ledger note records: only a
 * webhook charge can be refunded). An error, an answer that does not parse, or a pair the answer leaves out yields
 * billingUnavailable for those pairs and the error text, for the caller to alert. A charge the call made whose answer
 * could not be read stands in the ledger: a webhook charge with no delivery carrying it is refunded by
 * refund_late_reveals(), and a read charge is found by the next read as a replay. One subrequest, or none.
 */
export async function revealEntitlements(client: Db, pairs: readonly RevealPair[], o: { resolved: boolean; source: RevealSource }): Promise<{ answers: RevealAnswer[]; error: string | null }> {
  if (!pairs.length) return { answers: [], error: null };
  if (!o.resolved) return { answers: pairs.map((p) => local(p, "not_resolved")), error: null };
  // rail reveal_charge off: the behaviour before the price, the verdict released to every entitled follower, free
  if (!railEnabled("reveal_charge")) return { answers: pairs.map((p) => local(p, "included_plan")), error: null };
  let rows: z.infer<typeof ChargeRevealRow>[];
  try {
    const out = await rpc<unknown>(client, "charge_reveals", {
      p_tenants: pairs.map((p) => p.tenant_id), p_markets: pairs.map((p) => p.market_id),
      p_price: REVEAL_PRICE_CREDITS, p_event_cap: REVEAL_EVENT_CAP_CREDITS, p_pricing_from: REVEAL_PRICING_FROM,
      p_included_plans: [...REVEAL_INCLUDED_PLANS], p_source: o.source,
    });
    const parsed = z.array(ChargeRevealRow).safeParse(out ?? []);
    if (!parsed.success) throw new Error(`charge_reveals answered ${JSON.stringify(out).slice(0, 200)}`);
    rows = parsed.data;
  } catch (e) {
    return { answers: pairs.map(billingUnavailable), error: redact(String(e)).slice(0, 300) };
  }
  const by = new Map(rows.map((r) => [pairKey(r.tenant_id, r.market_id), r]));
  const missing = pairs.filter((p) => !by.has(pairKey(p.tenant_id, p.market_id)));
  return {
    answers: pairs.map((p) => by.get(pairKey(p.tenant_id, p.market_id)) ?? billingUnavailable(p)),
    error: missing.length ? `charge_reveals left out ${missing.length} pair(s), e.g. tenant ${missing[0]!.tenant_id} market ${missing[0]!.market_id}` : null,
  };
}

/** Pure. Whether the verdict goes to this tenant (rail reveal_lock: a reveal the charge refused is locked). */
export function revealReleased(a: Pick<RevealAnswer, "entitled_full">): boolean {
  return a.entitled_full || !railEnabled("reveal_lock");
}

/** What every reveal (webhook or read) says about its price: why it was released or locked, and what this release charged. */
export interface RevealAccess { reason: RevealReason; credits_charged: number; replayed: boolean }
export const revealAccess = (a: RevealAnswer): RevealAccess => ({ reason: a.reason, credits_charged: a.charged, replayed: a.replayed });

/** The locked object of a reveal the tenant did not receive: why, the price, the balance, where to top up, where to read it. */
export interface LockedReveal {
  reason: "insufficient_credits" | "billing_unavailable" | "account_unavailable";
  price_credits: number; balance: number | null; top_up: TopUp | null; read: string; message: string;
}

/**
 * Pure. The locked object for an answer that is not released, or null. insufficient_credits carries the leg's price,
 * the balance and the card pointer (the same top_up as POST /v1/resolve's 402); billing_unavailable says that nothing
 * was charged and when to read again.
 */
export function lockedReveal(a: RevealAnswer, top: TopUp, marketId: string): LockedReveal | null {
  if (revealReleased(a)) return null;
  const read = `/v1/shadow/${marketId}`;
  switch (a.reason) {
    case "insufficient_credits":
      return {
        reason: "insufficient_credits", price_credits: a.price, balance: a.balance, top_up: top, read,
        message: `This RESOLVED verdict costs ${a.price} credit(s); the balance is ${a.balance ?? "unknown"}. Nothing was charged. ${topUpText(top)} Then read ${read}: the verdict is released and charged then.`,
      };
    case "billing_unavailable":
      return { reason: "billing_unavailable", price_credits: a.price, balance: null, top_up: null, read, message: `Billing could not be reached, so this RESOLVED verdict was not released and nothing was charged. Read ${read} in a minute.` };
    default:
      return { reason: "account_unavailable", price_credits: a.price, balance: null, top_up: null, read, message: "This account cannot receive early reveals: it is not active." };
  }
}

/**
 * Pure. The delivery priority of a shadow.committed (webhook_deliveries.priority, migration 023): 3 a reveal the tenant
 * pays for (charged now, a replay of its charge, free past the event cap), 2 an included plan, 1 a grandfathered key or a
 * verdict that is not RESOLVED (2 when the follower's plan includes reveals), 0 a locked reveal. The inline first attempt
 * and the drain take the highest first.
 */
export function revealPriority(a: RevealAnswer): 0 | 1 | 2 | 3 {
  if (!revealReleased(a)) return 0;
  switch (a.reason) {
    case "charged": case "replay": case "event_cap_reached": return 3;
    case "included_plan": return 2;
    case "grandfathered": return 1;
    case "not_resolved": return includedPlan(a.plan) ? 2 : 1;
    case "insufficient_credits": case "billing_unavailable": case "unknown_tenant": return 0;
    default: { const never: never = a.reason; throw new Error(`unhandled reveal reason ${String(never)}`); }
  }
}

/** Pure. The refund deadline a charged shadow.committed carries: committed_at + REVEAL_LATE_MINUTES. */
export const revealDueAt = (committedAt: string): string => new Date(Date.parse(committedAt) + REVEAL_LATE_MINUTES * 60_000).toISOString();

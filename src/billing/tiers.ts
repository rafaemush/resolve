/**
 * PAYG tiers (plan §11, §16.4 P3 step 3). The rate of a USDC deposit is data, app_config payg_tiers, and the database
 * decides every credit with payg_credits_per_usdc() (migration 020): the rate of the tier with the highest min_usdc at
 * or below the amount, floor(amount x rate) credits. This is its mirror for what the API quotes (GET
 * /v1/payments/address), with the same validation, in exact integer micro-USDC arithmetic so a quote can never differ
 * from the credit by a float rounding. Pure.
 */
import { z } from "zod";

/** 10x the 1 credit = $0.01 base: a larger rate is a typo in the data, not a price (the SQL refuses it too). */
export const MAX_CREDITS_PER_USDC = 1000;
/** Plan §11 packs, quoted with their credits so a buyer sees exactly what each amount buys. */
export const PACKS_USDC = ["50", "250", "1000"] as const;

const MICRO_PER_USDC = 1_000_000n;
/** USDC has 6 decimals; usdc_deposits.amount_usdc is numeric(18,6). */
const USDC_TEXT = /^(\d{1,12})(?:\.(\d{1,6}))?$/;

/** "2.5", "2.500000" or 2.5 as integer micro-USDC; anything else (negative, >6 decimals, exponent) throws. */
export function parseUsdc(v: string | number): bigint {
  const m = USDC_TEXT.exec(typeof v === "number" ? String(v) : v.trim());
  if (!m) throw new Error(`not a USDC amount: ${JSON.stringify(v)}`);
  return BigInt(m[1]!) * MICRO_PER_USDC + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** Integer micro-USDC as the shortest decimal ("2.5", "250", "0.000001"). */
export function formatUsdc(micro: bigint): string {
  const whole = micro / MICRO_PER_USDC;
  const frac = (micro % MICRO_PER_USDC).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

const isUsdc = (n: number) => { try { parseUsdc(n); return true; } catch { return false; } };

export const PaygTier = z.strictObject({
  min_usdc: z.number().refine(isUsdc, "min_usdc must be >= 0 with at most 6 decimals"),
  credits_per_usdc: z.number().int().min(1).max(MAX_CREDITS_PER_USDC),
});
export type PaygTier = z.infer<typeof PaygTier>;

/** The same rules payg_credits_per_usdc() enforces before it credits anything. */
export const PaygTiers = z.array(PaygTier).min(1).superRefine((tiers, ctx) => {
  const asc = [...tiers].sort((a, b) => a.min_usdc - b.min_usdc);
  if (!asc.length) return; // min(1) reports it
  if (asc[0]!.min_usdc !== 0) ctx.addIssue({ code: "custom", message: "a tier at min_usdc 0 is required (every amount needs a rate)" });
  for (let i = 1; i < asc.length; i++) {
    const [lo, hi] = [asc[i - 1]!, asc[i]!];
    if (hi.min_usdc === lo.min_usdc) ctx.addIssue({ code: "custom", message: `two tiers start at ${hi.min_usdc} USDC` });
    // A larger payment never buys fewer credits per USDC (or paying more could buy fewer credits in total).
    else if (hi.credits_per_usdc < lo.credits_per_usdc) ctx.addIssue({ code: "custom", message: `the tier at ${hi.min_usdc} USDC pays less per USDC than the tier at ${lo.min_usdc}` });
  }
});
export type PaygTiers = z.infer<typeof PaygTiers>;

/** The rate for an amount: the tier with the highest min_usdc at or below it (tiers already validated). */
export function paygRate(amountMicro: bigint, tiers: PaygTiers): number {
  let best: PaygTier | null = null;
  for (const t of tiers) if (parseUsdc(t.min_usdc) <= amountMicro && (!best || t.min_usdc > best.min_usdc)) best = t;
  if (!best) throw new Error("payg tiers have no tier at min_usdc 0");
  return best.credits_per_usdc;
}

export interface PaygCredit { usdc: string; credits: number; credits_per_usdc: number }

/** What a deposit of this amount is credited: floor(amount x rate). credits < 1 is dust (recorded, never credited). */
export function paygCredits(amountUsdc: string | number, tiers: PaygTiers): PaygCredit {
  const micro = parseUsdc(amountUsdc);
  const rate = paygRate(micro, tiers);
  return { usdc: formatUsdc(micro), credits: Number((micro * BigInt(rate)) / MICRO_PER_USDC), credits_per_usdc: rate };
}

/** The plan §11 packs at these tiers. */
export const packQuotes = (tiers: PaygTiers): PaygCredit[] => PACKS_USDC.map((usdc) => paygCredits(usdc, tiers));

/**
 * The tiers the database credits at: app_config payg_tiers when present, else the flat rate credit_from_deposit is
 * passed (CREDITS_PER_USDC). A stored value that fails validation is an error, never a guess: the database refuses to
 * credit at it too.
 */
export function effectiveTiers(stored: string | null, fallbackCreditsPerUsdc: number): { tiers: PaygTiers } | { error: string } {
  if (stored === null) return { tiers: [{ min_usdc: 0, credits_per_usdc: fallbackCreditsPerUsdc }] };
  let json: unknown;
  try { json = JSON.parse(stored); } catch { return { error: "app_config payg_tiers is not JSON" }; }
  const p = PaygTiers.safeParse(json);
  return p.success ? { tiers: p.data } : { error: `app_config payg_tiers is invalid: ${p.error.issues.map((i) => i.message).join("; ")}` };
}

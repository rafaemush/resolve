/**
 * PAYG tiers (plan §11, §16.4 P3 step 3): the rate of a deposit is the tier its amount reaches, floor(amount x rate)
 * credits, in exact micro-USDC arithmetic. The tiers migration 020 inserts must buy exactly the plan §11 packs; the
 * boundaries one cent below each tier stay on the lower rate; dust is worth < 1 credit. The same numbers are asserted
 * against the SQL by scripts/selftest/money.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveTiers, formatUsdc, packQuotes, parseUsdc, paygCredits, paygRate, PaygTiers, type PaygTiers as Tiers } from "../src/billing/tiers";
import { MIGRATION_020_CONFIG } from "./lib/fake-money";

/** An app_config row exactly as supabase/migrations/020_money.sql inserts it. */
function migrationConfig(key: string): string {
  const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/020_money.sql"), "utf8");
  const m = sql.match(new RegExp(`\\('${key}', '([^']*)'\\)`));
  if (!m) throw new Error(`020_money.sql no longer inserts ${key} in the expected form`);
  return m[1]!;
}
const migrationTiers = () => migrationConfig("payg_tiers");
const TIERS: Tiers = PaygTiers.parse(JSON.parse(migrationTiers()));

describe("the tiers migration 020 inserts", () => {
  it("are valid, and the fake database carries the same rows (low_credit_threshold 500)", () => {
    expect(TIERS).toEqual([{ min_usdc: 1000, credits_per_usdc: 120 }, { min_usdc: 250, credits_per_usdc: 110 }, { min_usdc: 0, credits_per_usdc: 100 }]);
    for (const key of ["payg_tiers", "low_credit_threshold"]) expect(MIGRATION_020_CONFIG.find((r) => r.key === key)!.value).toBe(migrationConfig(key));
    expect(migrationConfig("low_credit_threshold")).toBe("500");
  });
  it("buy exactly the plan §11 packs: $50 -> 5,000, $250 -> 27,500, $1,000 -> 120,000", () => {
    expect(packQuotes(TIERS)).toEqual([
      { usdc: "50", credits: 5_000, credits_per_usdc: 100 },
      { usdc: "250", credits: 27_500, credits_per_usdc: 110 },
      { usdc: "1000", credits: 120_000, credits_per_usdc: 120 },
    ]);
  });
});

describe("paygCredits: the tier an amount reaches, floor(amount x rate)", () => {
  it.each([
    ["49.99", 4_999, 100], ["50", 5_000, 100], ["249.99", 24_999, 100], ["250", 27_500, 110],
    ["999.99", 109_998, 110], ["1000", 120_000, 120], ["1000.000001", 120_000, 120], ["2500.5", 300_060, 120],
  ])("%s USDC -> %i credits at %i/USDC", (usdc, credits, rate) => {
    expect(paygCredits(usdc, TIERS)).toMatchObject({ credits, credits_per_usdc: rate });
  });
  it("is exact where floats are not: 0.29 USDC is 29 credits, not 28", () => {
    expect(Math.floor(0.29 * 100)).toBe(28); // the float trap the micro-USDC arithmetic avoids
    expect(paygCredits("0.29", TIERS).credits).toBe(29);
  });
  it("dust: less than one credit (0.009999 USDC at 100/USDC) is 0 credits; one cent is the first credit", () => {
    expect(paygCredits("0.009999", TIERS).credits).toBe(0);
    expect(paygCredits("0.000001", TIERS).credits).toBe(0);
    expect(paygCredits("0.01", TIERS).credits).toBe(1);
  });
  it("takes a number or numeric(18,6) text alike", () => {
    expect(paygCredits(250, TIERS)).toEqual(paygCredits("250.000000", TIERS));
    expect(formatUsdc(parseUsdc("250.500000"))).toBe("250.5");
    expect(formatUsdc(parseUsdc("0.000001"))).toBe("0.000001");
  });
  it("refuses what is not a USDC amount", () => {
    for (const bad of ["-1", "1.0000001", "1e3", "", "abc", "0x10"]) expect(() => parseUsdc(bad)).toThrow();
  });
  it("the base rate is the tier at 0", () => expect(paygRate(0n, TIERS)).toBe(100));
});

describe("PaygTiers: the rules payg_credits_per_usdc() enforces", () => {
  const valid = (tiers: unknown) => PaygTiers.safeParse(tiers).success;
  it("needs a tier at 0, distinct starts, rates that never fall as the amount rises, integer rates 1..1000", () => {
    expect(valid([{ min_usdc: 250, credits_per_usdc: 110 }])).toBe(false);
    expect(valid([{ min_usdc: 0, credits_per_usdc: 100 }, { min_usdc: 0, credits_per_usdc: 110 }])).toBe(false);
    expect(valid([{ min_usdc: 0, credits_per_usdc: 100 }, { min_usdc: 250, credits_per_usdc: 90 }])).toBe(false);
    expect(valid([{ min_usdc: 0, credits_per_usdc: 12_000 }])).toBe(false);
    expect(valid([{ min_usdc: 0, credits_per_usdc: 100.5 }])).toBe(false);
    expect(valid([{ min_usdc: 0.0000001, credits_per_usdc: 100 }, { min_usdc: 0, credits_per_usdc: 100 }])).toBe(false);
    expect(valid([{ min_usdc: 0, credits_per_usdc: 100, bonus: 1 }])).toBe(false);
    expect(valid([])).toBe(false);
    expect(valid([{ min_usdc: 0, credits_per_usdc: 100 }, { min_usdc: 250, credits_per_usdc: 100 }])).toBe(true);
  });
  it("effectiveTiers: the stored row, else the flat rate credit_from_deposit is passed; a bad row is an error, never a guess", () => {
    expect(effectiveTiers(null, 100)).toEqual({ tiers: [{ min_usdc: 0, credits_per_usdc: 100 }] });
    expect(effectiveTiers(migrationTiers(), 100)).toEqual({ tiers: TIERS });
    expect(effectiveTiers("not json", 100)).toEqual({ error: "app_config payg_tiers is not JSON" });
    expect(effectiveTiers('[{"min_usdc":250,"credits_per_usdc":110}]', 100)).toMatchObject({ error: expect.stringContaining("a tier at min_usdc 0 is required") });
  });
});

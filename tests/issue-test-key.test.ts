/** scripts/issue-test-key.ts argument rules: dry run unless --apply, and anything unexpected stops before a write. */
import { describe, expect, it } from "vitest";
import { evaluationCredits, FREE_EVALUATION_CREDITS, grantRequestId, parseTestKeyArgs, UsageError } from "../scripts/lib/test-key";

const M1 = "22222222-2222-4222-8222-222222222222", M2 = "33333333-3333-4333-8333-333333333333";

describe("parseTestKeyArgs", () => {
  it("defaults: dry run, no plan override, credits left to the plan, 30-day expiry", () => {
    expect(parseTestKeyArgs(["--name", "  Acme Bots "])).toEqual({ name: "Acme Bots", plan: null, credits: null, follow: [], expiresDays: 30, apply: false });
    expect(parseTestKeyArgs(["--name", "Acme", "--credits", "0"]).credits).toBe(0); // an explicit 0 stays 0
    expect(parseTestKeyArgs(["--name", "Acme", "--dry-run"]).apply).toBe(false);
  });
  it("every flag, both --flag value and --flag=value; follows deduped and lower-cased", () => {
    expect(parseTestKeyArgs(["--name=Acme", "--plan", "growth", "--credits=300", "--follow", `${M1},${M2.toUpperCase()}`, "--follow", M1, "--expires-days", "0", "--apply"]))
      .toEqual({ name: "Acme", plan: "growth", credits: 300, follow: [M1, M2], expiresDays: 0, apply: true });
  });
  it("refuses what it does not understand", () => {
    const bad: string[][] = [
      [], ["--name", ""], ["--name"], ["--name", "--apply"], ["--nme", "x"], ["--name", "x", "extra"],
      ["--name", "x", "--plan", "enterprise"], ["--name", "x", "--credits", "-5"], ["--name", "x", "--credits", "1.5"], ["--name", "x", "--credits", "2000000"],
      ["--name", "x", "--expires-days", "400"], ["--name", "x", "--follow", "not-a-uuid"], ["--name", "x", "--apply", "--dry-run"], ["--name", "x", "--apply=yes"],
      ["--name", "x".repeat(201)],
    ];
    for (const argv of bad) expect(() => parseTestKeyArgs(argv), argv.join(" ")).toThrow(UsageError);
  });
  it("without --credits a free tenant gets the 300-credit evaluation grant (docs/pricing.md); a paid plan gets none", () => {
    expect(FREE_EVALUATION_CREDITS).toBe(300);
    expect(evaluationCredits("free", null)).toBe(300);
    for (const plan of ["payg", "builder", "growth", "platform"] as const) expect(evaluationCredits(plan, null)).toBe(0);
    expect(evaluationCredits("free", 0)).toBe(0);
    expect(evaluationCredits("builder", 12_000)).toBe(12_000);
  });
  it("the evaluation grant is keyed once per tenant", () => {
    expect(grantRequestId("t-1")).toBe("issue-test-key:t-1");
  });
});

/**
 * Customer-facing text (plan §17.5, MCA §2.3(a)): the pilot pack, the invoice / pilot-letter / W-8BEN templates, the
 * pricing page and the /bot page never name the model, never say "DCM-grade" or quote "24–72 h", never state an
 * accuracy figure, describe credits as a non-refundable prepayment for API services, and carry placeholders instead of
 * personal data.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { botPageHtml } from "../src/api/bot";
import { RESOLVE_BOT_UA } from "../src/ops/ua";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const DOCS = ["docs/pilot-pack.md", "docs/templates/invoice.md", "docs/templates/pilot-letter.md", "docs/templates/w8ben-notes.md", "docs/pricing.md"];

describe("customer-facing documents", () => {
  const texts = Object.fromEntries([...DOCS.map((p) => [p, read(p)]), ["/bot", botPageHtml(RESOLVE_BOT_UA)]]) as Record<string, string>;

  it("never name the model or its vendor, never say DCM-grade or 24-72 h", () => {
    for (const [p, t] of Object.entries(texts)) {
      expect(t, p).not.toMatch(/\bjev\b|typesafe/i);
      expect(t, p).not.toMatch(/DCM/);
      expect(t, p).not.toMatch(/24\s*[–-]\s*72/);
    }
  });
  it("state no accuracy or precision figure (a percentage next to accuracy, precision or correct)", () => {
    for (const [p, t] of Object.entries(texts)) expect(t, p).not.toMatch(/\d+(\.\d+)?\s*%\s*(accura|precis|correct|right)|(accura|precis)\w*\s*(of|is|at)\s*\d/i);
  });
  it("describe credits as a non-refundable prepayment for API services where money is taken", () => {
    for (const p of ["docs/pilot-pack.md", "docs/templates/invoice.md", "docs/templates/pilot-letter.md", "docs/pricing.md"]) expect(texts[p], p).toMatch(/non-refundable prepayment for API services/);
  });
  it("the pilot pack names both offers and the payment rail", () => {
    const t = texts["docs/pilot-pack.md"]!;
    expect(t).toMatch(/\$1,000/);
    expect(t).toMatch(/\$750 a month/);
    expect(t).toMatch(/USDC on Base/);
    expect(t).toMatch(/not an oracle of record/);
  });
  it("templates carry <placeholders>, no personal data: no email address, no filled wallet address", () => {
    for (const p of ["docs/templates/invoice.md", "docs/templates/pilot-letter.md", "docs/templates/w8ben-notes.md"]) {
      const t = texts[p]!;
      expect(t, p).toMatch(/<[^<>\n]+>/);
      expect(t, p).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      // the only 0x address allowed is the public USDC contract on Base
      for (const a of t.match(/0x[0-9a-fA-F]{40}\b/g) ?? []) expect(a).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    }
    expect(texts["docs/templates/w8ben-notes.md"]).toMatch(/Not tax or legal advice/);
    expect(texts["docs/templates/w8ben-notes.md"]).toMatch(/Treaty claim: confirm with counsel/);
  });
  it("the accuracy and lead-time gate is 100 distinct events, never a count of markets", () => {
    for (const [p, t] of Object.entries(texts)) expect(t, p).not.toMatch(/100\s+(reconciled\s+)?markets|100 of your markets/i);
    expect(texts["docs/pilot-pack.md"]).toMatch(/before 100 distinct events on your platform have been reconciled/);
    expect(texts["docs/templates/pilot-letter.md"]).toMatch(/no accuracy figure before 100 distinct events on your platform are reconciled/);
    expect(texts["docs/pricing.md"]).toMatch(/no lead-time guarantee before 100 reconciled distinct events/);
  });
  it("the venue offers state that the account has no follow limit (a PAYG credit alone would cap follows at 50)", () => {
    expect(texts["docs/pilot-pack.md"]).toMatch(/The pilot account has no follow limit/);
    expect(texts["docs/pilot-pack.md"]).toMatch(/The account has no follow limit, so every one of those markets can be followed/);
    expect(texts["docs/templates/pilot-letter.md"]).toMatch(/Account `<tenant id>` has no follow limit for this period/);
    expect(texts["docs/pricing.md"]).toMatch(/the pilot account has no follow limit/);
    expect(read("docs/runbooks/venue-pilot.md")).toMatch(/update tenants set plan = 'platform' where id = '<tenant id>';/);
  });
  it("the report's delivery time is the reader's own: never another follower's", () => {
    expect(texts["docs/pilot-pack.md"]).toMatch(/was delivered to your account \(your deliveries only\)/);
    expect(texts["docs/templates/pilot-letter.md"]).toMatch(/first delivered to your account/);
    expect(texts["docs/pilot-pack.md"]).not.toMatch(/when the first webhook reached you/);
  });
  it("the pilot letter fits one page (under 650 words)", () => {
    expect(texts["docs/templates/pilot-letter.md"]!.split(/\s+/).filter(Boolean).length).toBeLessThan(650);
  });
});

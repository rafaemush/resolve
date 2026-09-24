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
  it("the pilot letter fits one page (under 650 words)", () => {
    expect(texts["docs/templates/pilot-letter.md"]!.split(/\s+/).filter(Boolean).length).toBeLessThan(650);
  });
});

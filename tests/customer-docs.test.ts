/**
 * Customer-facing text (plan §17.5, MCA §2.3(a)): the pilot pack, the invoice / pilot-letter / W-9 templates, the
 * pricing page and the /bot page never name the model, never say "DCM-grade" or quote "24–72 h", never state an
 * accuracy figure, describe credits as a non-refundable prepayment for API services, and carry placeholders instead of
 * personal data. The quickstart (/docs), the key page and the first-print answers (plan §22.3 items 3 and 6) keep the
 * same rules, never call credits "lifetime", and never point a tenant to the USDC address.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { botPageHtml } from "../src/api/bot";
import { docsHtml, keyIssuedHtml, pricingHtml } from "../src/api/site";
import { VERIFY_HINT, listSeries, scheduledAnswer, topUpHint } from "../src/api/prints";
import type { Env } from "../src/env";
import { RESOLVE_BOT_UA } from "../src/ops/ua";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const DOCS = ["docs/pilot-pack.md", "docs/templates/invoice.md", "docs/templates/pilot-letter.md", "docs/templates/w9-notes.md", "docs/pricing.md"];

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
    for (const p of ["docs/templates/invoice.md", "docs/templates/pilot-letter.md", "docs/templates/w9-notes.md"]) {
      const t = texts[p]!;
      expect(t, p).toMatch(/<[^<>\n]+>/);
      expect(t, p).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      // the only 0x address allowed is the public USDC contract on Base
      for (const a of t.match(/0x[0-9a-fA-F]{40}\b/g) ?? []) expect(a).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    }
    expect(texts["docs/templates/w9-notes.md"]).toMatch(/Not tax or legal advice/);
    expect(texts["docs/templates/w9-notes.md"]).toMatch(/Never sign a W-8BEN/);
    for (const [p, t] of Object.entries(texts)) expect(t, p).not.toMatch(/with a W-8BEN|the W-8BEN (and|are)|W-8BEN is provided/);
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

describe("the quickstart, the key page and the first-print answers", () => {
  const base = "https://resolve.example.com";
  const pages: Record<string, string> = {
    "/docs": docsHtml({ base, channel: null, card: true }),
    "/docs (card not open)": docsHtml({ base, channel: null, card: false }),
    "the key page": keyIssuedHtml({ key: `rsl_test_${"a".repeat(32)}`, expiresAt: "2026-10-31T00:00:00Z", base, channel: null }),
    "/pricing": pricingHtml({ packs: null, channel: null, card: { base } }),
    "GET /v1/prints": JSON.stringify(listSeries(Date.parse("2026-10-01T00:00:00Z"), [])),
    "a scheduled print": JSON.stringify(scheduledAnswer("us_unemployment_rate", "2026-09", Date.parse("2026-10-01T00:00:00Z"))),
    "the verify hint": VERIFY_HINT,
    "the 402 top-up (card open)": topUpHint({ WHOP_CHECKOUT_ENABLED: "1", WHOP_API_KEY: "k", WHOP_PLAN_ID_50: "plan_a", WHOP_PLAN_ID_250: "plan_b", USDC_RECEIVING_ADDRESS: `0x${"1".repeat(40)}` } as unknown as Env),
    "the 402 top-up (card not open)": topUpHint({ USDC_RECEIVING_ADDRESS: `0x${"1".repeat(40)}` } as unknown as Env),
  };
  it("never name the model or its vendor, and state no accuracy figure", () => {
    for (const [p, t] of Object.entries(pages)) {
      expect(t, p).not.toMatch(/\bjev\b|typesafe/i);
      expect(t, p).not.toMatch(/\d+(\.\d+)?\s*%\s*(accura|precis|correct|right)|(accura|precis)\w*\s*(of|is|at)\s*\d/i);
    }
  });
  it("credits: a non-refundable prepayment for API services that does not expire while the account is open; never lifetime", () => {
    for (const p of ["/docs", "/pricing"]) {
      expect(pages[p], p).toMatch(/non-refundable prepayment for API services/);
      expect(pages[p], p).toMatch(/do not expire while the account is open/);
    }
    for (const [p, t] of Object.entries(pages)) expect(t, p).not.toMatch(/lifetime/i);
  });
  it("never point a tenant to the USDC address: no /v1/payments/address, no receiving address, no USDC", () => {
    for (const [p, t] of Object.entries(pages)) {
      expect(t, p).not.toMatch(/payments\/address/);
      expect(t, p).not.toMatch(/0x[0-9a-f]{40}/i);
    }
    for (const p of ["/docs", "/docs (card not open)", "the key page", "GET /v1/prints", "a scheduled print", "the verify hint", "the 402 top-up (card open)", "the 402 top-up (card not open)"]) expect(pages[p], p).not.toMatch(/usdc/i);
  });
  it("the quickstart leads with the official-release product: a first print before any market, the GitHub example labelled an illustration", () => {
    const d = pages["/docs"]!;
    expect(d.indexOf("/v1/prints/us_unemployment_rate/2026-09")).toBeLessThan(d.indexOf("/v1/markets"));
    expect(d).toMatch(/Illustration: the repository and pull request below are placeholders/);
    expect(pages["the key page"]).toContain("/v1/prints -H");
  });
});

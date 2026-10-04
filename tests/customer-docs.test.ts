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
import { VERIFY_HINT, listSeries, scheduledAnswer } from "../src/api/prints";
import { topUp, topUpText } from "../src/billing/top-up";
import { REVEAL_EVENT_CAP_CREDITS, REVEAL_LATE_MINUTES, REVEAL_PRICE_CREDITS, REVEAL_PRICING_FROM } from "../src/shadow/reveal";
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
  it("only the invoiced venue offers speak of USDC, and only through the address route opened for that pilot (founder decision 2026-10-01): no self-serve doc names a wallet address", () => {
    for (const [p, t] of Object.entries(texts)) {
      if (!["docs/pilot-pack.md", "docs/templates/invoice.md", "docs/templates/pilot-letter.md", "docs/pricing.md"].includes(p)) expect(t, p).not.toMatch(/(pay|paid|prepaid)( once| monthly)? in USDC(?! against an invoice)|send USDC (on|from|to)|receiving address|register the wallet/i);
      for (const a of t.match(/0x[0-9a-fA-F]{40}\b/g) ?? []) expect(a, p).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    }
    expect(texts["docs/pricing.md"]).toMatch(/Paid in USDC against an invoice, with a W-9 and a one-page pilot letter/);
    expect(texts["docs/pricing.md"]).toMatch(/the address route is opened for that pilot alone/);
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
  it("the venue offers state that the account has no follow limit (a PAYG credit alone would cap follows at 500 and pay per reveal)", () => {
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
  it("docs/pricing.md: card checkout is live, the $20 pack is card only, and no tenant is told to send USDC to an address", () => {
    const t = texts["docs/pricing.md"]!;
    expect(t).toMatch(/Card checkout through Whop is live/);
    expect(t).not.toMatch(/switched off until/);
    expect(t).toMatch(/\$20 = 2,000 credits, card only/);
    expect(t).toMatch(/\{"pack": "20"\}/);
    expect(t).toMatch(/USDC deposits are not offered/);
    expect(t).not.toMatch(/send USDC on Base from that wallet to the address/i);
    expect(t).not.toMatch(/lifetime/i);
  });
  it("docs/pricing.md: the $1,000 pack can be paid by card once offered, never stated as offered now; the card conditions stay", () => {
    const t = texts["docs/pricing.md"]!;
    expect(t).toContain("The $1,000 pack (120,000 credits) can be paid by card once it is offered");
    expect(t).toMatch(/until then that request answers `400` \(the pack is not offered by card\)/);
    // before it is offered by card the page names how the $1,000 pack is paid (an invoice in USD, reviewed before
    // payment), and never says every pack is paid by card or that a USDC address takes it
    expect(t).toContain("the $1,000 pack is sold on request against an invoice in USD: ask us (`/terms#contact`) for payment options, and you review the invoice before anything is paid.");
    expect(t).toContain("Packs offered by card are paid by card; a $1,000 pack bought on request before it is offered by card is invoiced in USD (above)");
    expect(t).not.toMatch(/available on request\./);
    expect(t).not.toMatch(/(^|[.] )Packs are paid by card/m);
    // the packs card checkout sells today are still the three; the $1,000 pack is never listed among them
    expect(t).toMatch(/The \$20, \$50 and \$250 packs can be paid by card through Whop/);
    expect(t).not.toMatch(/\$250 and \$1,000 packs can be paid by card|\$1,000 packs? (is|are) (now )?(offered|sold|available) by card/);
    expect(t).toContain("| $1,000 | 120,000 | 20 % |");
    const card = t.slice(t.indexOf("**Pay by card.**"), t.indexOf("**Self-serve USDC deposits"));
    expect(card).toMatch(/merchant of record/);
    expect(card).toMatch(/A card refund or chargeback removes the credits that payment bought/);
    expect(t).toMatch(/non-refundable prepayment for API services/);
    expect(card).not.toMatch(/lifetime|wallet|\bbet|betting|wager|scrap|\bmarkets?\b/i);
  });
  it("docs/pricing.md prices the early reveal as the code charges it: 25 per RESOLVED leg, 2,000 per event, the plans that include it, the refund window, the locked answer, payg follows 500, the event follow, the cut-over", () => {
    const t = texts["docs/pricing.md"]!;
    expect(t).toContain(`| ${REVEAL_PRICE_CREDITS} |`);
    expect(t).toContain(`at most ${REVEAL_EVENT_CAP_CREDITS.toLocaleString("en-US")} credits per event`);
    expect(t).toMatch(/Included in Builder, Growth, Platform and the venue offers/);
    expect(t).toContain(`within ${REVEAL_LATE_MINUTES} minutes of \`committed_at\``);
    expect(t).toMatch(/A reveal charged by a read \(`GET \/v1\/shadow\/\{market_id\}` or the export\) is not refunded/);
    expect(t).toMatch(/`verdict` is `null`, the `venue` object proposes nothing, and a `locked` object/);
    expect(t).toMatch(/These reads answer 200, never 402/);
    expect(t).toContain("| Pay as you go | packs from $20 (by card) | credits do not expire while the account is open | 5 | up to 500 | 60 |");
    expect(t).toMatch(/an evaluation key may follow up to 50 shadow markets while it is valid, so the early reveal can be judged before buying; each RESOLVED reveal costs 25 of its 300 credits/i);
    expect(t).toContain('`{"scope":"event"}`');
    // the cut-over the docs state is the one the code sends to charge_reveals
    expect(t).toContain(`An evaluation key issued before ${REVEAL_PRICING_FROM.slice(0, 10)} keeps free reveals until it expires`);
    // the dated status states no start date for pay as you go, which pays from the release that charges (only the free
    // keys' grandfathering has a date: REVEAL_PRICING_FROM, compared with tenants.created_at)
    expect(t).toMatch(/## Status \(2026-10-05\)\n\nEarly reveals are priced: 25 credits per RESOLVED leg on the Free and Pay as you go plans/);
    expect(t).toContain("Pay as you go has no such date.");
    expect(t).not.toMatch(/priced from \d{4}-\d{2}-\d{2}/);
    // the refund is owed for Resolve's lateness, never for the endpoint's answer; a settled market is free
    expect(t).toMatch(/if Resolve did not attempt to deliver it to any of your endpoints within 10 minutes of `committed_at`/);
    expect(t).toMatch(/Once a delivery was attempted in time the charge stands, whatever your endpoint answered/);
    expect(t).toMatch(/reading them is free on every plan, and `reveal.reason` \(the export's `reveal` column\) says `public`/);
    expect(t).not.toMatch(/Early reveals are not a Free feature/);
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
    "the 402 top-up (card open)": topUpText(topUp({ WHOP_CHECKOUT_ENABLED: "1", WHOP_API_KEY: "k", WHOP_PLAN_ID_20: "plan_c", WHOP_PLAN_ID_50: "plan_a", WHOP_PLAN_ID_250: "plan_b", USDC_RECEIVING_ADDRESS: `0x${"1".repeat(40)}` } as unknown as Env, base)),
    "the 402 top-up (card not open)": topUpText(topUp({ USDC_RECEIVING_ADDRESS: `0x${"1".repeat(40)}` } as unknown as Env, base)),
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
  it("the quickstart and /pricing price the early reveal from the code's constants, never as a USDC payment", () => {
    for (const p of ["/docs", "/docs (card not open)", "/pricing"]) {
      expect(pages[p], p).toContain(`${REVEAL_PRICE_CREDITS} credits`);
      expect(pages[p], p).toContain(`at most ${REVEAL_EVENT_CAP_CREDITS.toLocaleString("en-US")} credits per event`);
      expect(pages[p], p).toContain(`within ${REVEAL_LATE_MINUTES} minutes is refunded`);
      // the refund is for Resolve's lateness, and Platform includes reveals as docs/pricing.md and the code say
      expect(pages[p], p).toContain("Resolve does not attempt within");
      expect(pages[p], p).toContain("Builder, Growth, Platform and the venue offers");
    }
    expect(pages["/docs"]).toContain("-d '{&quot;scope&quot;:&quot;event&quot;}'".replace(/&quot;/g, '"'));
  });
  it("the quickstart leads with the official-release product: a first print before any market, the GitHub example labelled an illustration", () => {
    const d = pages["/docs"]!;
    expect(d.indexOf("/v1/prints/us_unemployment_rate/2026-09")).toBeLessThan(d.indexOf("/v1/markets"));
    expect(d).toMatch(/Illustration: the repository and pull request below are placeholders/);
    expect(pages["the key page"]).toContain("/v1/prints -H");
  });
});

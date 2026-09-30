/**
 * The pure rules of the Whop card checkout (src/billing/whop.ts): the webhook signature as Whop documents it (checked
 * against node:crypto, not against the code's own signer), the configuration (names, never values; a malformed plan id is
 * missing, never guessed), what a payment grants (the pack from the plan id alone; amount, currency, tax, refunds and the
 * tenant checked after), what a refund or dispute takes back, which checkout URL a buyer may be sent to, and the rail's
 * mutation (evals/whop.ts goes red with the rail off while its controls stay green).
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Env } from "../src/env";
import {
  CARD_PACKS, PACK_IDS, checkoutUrlAllowed, decideGrant, floatCents, grantRequestIdFor, moneyCents, packPriceFor, paidCents, readRefund, reversalCredits,
  reversalRequestIdFor, usdCents, verifyWhopSignature, whopConfig, whopSignature, WhopPayment, cardCheckoutOffered,
} from "../src/billing/whop";
import { effectiveTiers, packQuotes, paygCredits } from "../src/billing/tiers";
import { __setRailsForMutationTesting } from "../src/resolve/rails";
import { runWhopSuite } from "../evals/whop";
import { MIGRATION_020_CONFIG } from "./lib/fake-money";
import { PLAN_20, PLAN_250, PLAN_50, WHOP_SECRET, nativeRefundEvent, paymentSucceeded, refundEvent, whopMoney, whopSign } from "./lib/fake-whop";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const T = String(NOW / 1000);
const BODY = '{"id":"msg_1","type":"payment.succeeded"}';
const env = (o: Record<string, string> = {}) => ({ WHOP_PLAN_ID_20: PLAN_20, WHOP_PLAN_ID_50: PLAN_50, WHOP_PLAN_ID_250: PLAN_250, WHOP_API_KEY: "whop_api_key_test", WHOP_WEBHOOK_SECRET: WHOP_SECRET, WHOP_CHECKOUT_ENABLED: "1", ...o }) as unknown as Env;
const TENANT = "11111111-2222-4333-8444-555555555555";
const pay = (data: Record<string, unknown> = {}, tenant: string | null = TENANT) => WhopPayment.parse(paymentSucceeded(tenant, data).data);

afterEach(() => __setRailsForMutationTesting([]));

describe("the webhook signature (Standard Webhooks, keyed by the literal secret)", () => {
  const h = (o: Partial<{ id: string; timestamp: string; signature: string }> = {}) => ({ id: "msg_1", timestamp: T, signature: `v1,${whopSign(WHOP_SECRET, "msg_1", T, BODY)}`, ...o });

  it("signs base64(HMAC-SHA256(secret bytes, id.timestamp.body)), the same as node:crypto", async () => {
    expect(await whopSignature(WHOP_SECRET, "msg_1", T, BODY)).toBe(whopSign(WHOP_SECRET, "msg_1", T, BODY));
  });
  it("accepts a genuine request, also when one of several v1 entries matches", async () => {
    expect(await verifyWhopSignature(WHOP_SECRET, h(), BODY, NOW)).toEqual({ ok: true });
    expect(await verifyWhopSignature(WHOP_SECRET, h({ signature: `v1,${"x".repeat(44)} v1,${whopSign(WHOP_SECRET, "msg_1", T, BODY)}` }), BODY, NOW)).toEqual({ ok: true });
  });
  it("refuses a wrong signature, a tampered body, another id, another secret, another version tag", async () => {
    expect(await verifyWhopSignature(WHOP_SECRET, h({ signature: `v1,${"A".repeat(43)}=` }), BODY, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyWhopSignature(WHOP_SECRET, h(), BODY.replace("payment", "refund"), NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyWhopSignature(WHOP_SECRET, h({ id: "msg_2" }), BODY, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyWhopSignature(`${WHOP_SECRET}x`, h(), BODY, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyWhopSignature(WHOP_SECRET, h({ signature: `v2,${whopSign(WHOP_SECRET, "msg_1", T, BODY)}` }), BODY, NOW)).toEqual({ ok: false, reason: "invalid" });
  });
  it("keys the HMAC with the whole secret, prefix included, never a base64-decoded key", async () => {
    const decoded = Buffer.from(WHOP_SECRET.slice(3), "base64").toString("latin1");
    const std = await whopSignature(decoded, "msg_1", T, BODY);
    expect(await verifyWhopSignature(WHOP_SECRET, h({ signature: `v1,${std}` }), BODY, NOW)).toEqual({ ok: false, reason: "invalid" });
    const stripped = whopSign(WHOP_SECRET.slice(3), "msg_1", T, BODY);
    expect(await verifyWhopSignature(WHOP_SECRET, h({ signature: `v1,${stripped}` }), BODY, NOW)).toEqual({ ok: false, reason: "invalid" });
  });
  it("refuses a timestamp more than 300 s away either way; 300 s is still inside", async () => {
    const at = (s: number) => { const ts = String(Number(T) + s); return verifyWhopSignature(WHOP_SECRET, h({ timestamp: ts, signature: `v1,${whopSign(WHOP_SECRET, "msg_1", ts, BODY)}` }), BODY, NOW); };
    expect(await at(-300)).toEqual({ ok: true });
    expect(await at(300)).toEqual({ ok: true });
    expect(await at(-301)).toEqual({ ok: false, reason: "stale" });
    expect(await at(301)).toEqual({ ok: false, reason: "stale" });
    expect(await at(-86_400)).toEqual({ ok: false, reason: "stale" });
  });
  it("refuses missing headers, a malformed timestamp, and any request when no secret is set", async () => {
    expect(await verifyWhopSignature(WHOP_SECRET, h({ signature: "" }), BODY, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyWhopSignature(WHOP_SECRET, { id: "msg_1", signature: h().signature }, BODY, NOW)).toEqual({ ok: false, reason: "missing" });
    for (const ts of [`0${T}`, `${T}.5`, "-1", "abc", `${T} `.repeat(2)]) {
      expect((await verifyWhopSignature(WHOP_SECRET, h({ timestamp: ts, signature: `v1,${whopSign(WHOP_SECRET, "msg_1", ts, BODY)}` }), BODY, NOW)).ok, ts).toBe(false);
    }
    for (const s of [null, undefined, ""]) expect(await verifyWhopSignature(s, h(), BODY, NOW)).toEqual({ ok: false, reason: "no_secret" });
  });
  it("the rail is load-bearing: evals/whop.ts is green with it and red without it (controls stay green)", async () => {
    const on = await runWhopSuite({ quiet: true });
    expect(on).toMatchObject({ grader_fail: 0, harness_error: 0 });
    expect(on.cases).toBeGreaterThanOrEqual(10);
    __setRailsForMutationTesting(["whop_signature"]);
    expect(await verifyWhopSignature(WHOP_SECRET, h({ signature: "v1,forged" }), BODY, NOW)).toEqual({ ok: true });
    const off = await runWhopSuite({ quiet: true });
    expect(off.harness_error).toBe(0);
    expect(off.grader_fail).toBeGreaterThanOrEqual(10);
    expect(off.outcomes.filter((o) => o.control).every((o) => o.result === "pass")).toBe(true);
  });
});

describe("configuration: names, never values; a malformed value is missing", () => {
  it("a complete configuration maps each plan id to its pack and offers checkout only when switched on", () => {
    const c = whopConfig(env());
    expect([...c.plans.entries()]).toEqual([[PLAN_20, "20"], [PLAN_50, "50"], [PLAN_250, "250"]]);
    expect(c.checkoutMissing).toEqual([]);
    expect(cardCheckoutOffered(c)).toBe(true);
    expect(cardCheckoutOffered(whopConfig(env({ WHOP_CHECKOUT_ENABLED: "0" })))).toBe(false);
    expect(cardCheckoutOffered(whopConfig(env({ WHOP_CHECKOUT_ENABLED: "true" })))).toBe(false);
    expect(c).toMatchObject({ apiBase: "https://api.whop.com/api/v1", checkoutOrigin: "https://whop.com", sandbox: false });
    expect(whopConfig(env({ WHOP_SANDBOX: "1" }))).toMatchObject({ apiBase: "https://sandbox-api.whop.com/api/v1", checkoutOrigin: "https://sandbox.whop.com" });
  });
  it("unset, malformed or shared plan ids and an unset API key are listed by name and never offered", () => {
    const c = whopConfig(env({ WHOP_PLAN_ID_20: "", WHOP_PLAN_ID_50: "", WHOP_PLAN_ID_250: "prod_abc", WHOP_API_KEY: "" }));
    expect(c.checkoutMissing).toEqual(["WHOP_API_KEY", "WHOP_PLAN_ID_20", "WHOP_PLAN_ID_50", "WHOP_PLAN_ID_250 (not a plan_ id)"]);
    expect(c.plans.size).toBe(0);
    expect(cardCheckoutOffered(c)).toBe(false);
    // the $20 plan alone missing keeps the card checkout closed (every pack's plan is set before it is switched on)
    const no20 = whopConfig(env({ WHOP_PLAN_ID_20: "" }));
    expect([no20.checkoutMissing, cardCheckoutOffered(no20)]).toEqual([["WHOP_PLAN_ID_20"], false]);
    const same = whopConfig(env({ WHOP_PLAN_ID_250: PLAN_50 }));
    expect([...same.plans.entries()]).toEqual([[PLAN_20, "20"]]); // both packs that share a plan are dropped, never guessed
    expect(same.planMissing).toEqual(expect.arrayContaining(["WHOP_PLAN_ID_50", `WHOP_PLAN_ID_250 (the same plan as WHOP_PLAN_ID_50)`]));
    expect(JSON.stringify(whopConfig(env({ WHOP_API_KEY: "" })).checkoutMissing)).not.toContain(WHOP_SECRET);
  });
  it("three card packs, each at the rate migration 020's USDC tiers credit its price: $20 = 2,000 (card only), $50 = 5,000, $250 = 27,500", () => {
    const eff = effectiveTiers(MIGRATION_020_CONFIG[0]!.value, 100);
    if (!("tiers" in eff)) throw new Error(eff.error);
    for (const p of PACK_IDS) expect(paygCredits((CARD_PACKS[p].priceCents / 100).toFixed(2), eff.tiers).credits, p).toBe(CARD_PACKS[p].credits);
    expect(PACK_IDS).toEqual(["20", "50", "250"]);
    expect(CARD_PACKS).toEqual({
      "20": { priceCents: 2000, credits: 2000, planVar: "WHOP_PLAN_ID_20" },
      "50": { priceCents: 5000, credits: 5000, planVar: "WHOP_PLAN_ID_50" },
      "250": { priceCents: 25000, credits: 27500, planVar: "WHOP_PLAN_ID_250" },
    });
    // the invoiced and USDC packs are unchanged: $20 is a card pack only
    expect(packQuotes(eff.tiers).map((q) => q.usdc)).toEqual(["50", "250", "1000"]);
  });
  it("wrangler.toml ships the $20 plan id and keeps USDC deposits off", () => {
    const toml = readFileSync(resolve(import.meta.dirname, "../wrangler.toml"), "utf8");
    const v = (k: string) => new RegExp(`^${k} = "([^"]*)"$`, "m").exec(toml)?.[1];
    expect(v("WHOP_PLAN_ID_20")).toBe(PLAN_20);
    expect(v("WHOP_PLAN_ID_20")).toBe("plan_PNgCSGmXG38KW");
    expect(v("USDC_DEPOSITS_OFFERED")).toBe("0");
    // absolute links in alerts, payloads and the pinned channel post; the channel link the site shows
    expect(v("RESOLVE_PUBLIC_URL")).toBe("https://resolve.rafaemush.workers.dev");
    expect(v("PUBLIC_CHANNEL_URL")).toBe("https://t.me/resolvefeed");
    const shipped = whopConfig({ WHOP_PLAN_ID_20: v("WHOP_PLAN_ID_20"), WHOP_PLAN_ID_50: v("WHOP_PLAN_ID_50"), WHOP_PLAN_ID_250: v("WHOP_PLAN_ID_250") } as unknown as Env);
    expect([...shipped.plans.values()]).toEqual(["20", "50", "250"]);
    expect(shipped.planMissing).toEqual([]);
  });
});

describe("what a payment grants", () => {
  const cfg = whopConfig(env());
  it("the pack comes from the plan id alone, then the tenant from the metadata Resolve set", () => {
    expect(decideGrant(pay(), cfg)).toEqual({ result: "grant", pack: "50", credits: 5000, tenantId: TENANT });
    expect(decideGrant(pay({ plan_id: PLAN_20, total: whopMoney("20.00") }), cfg)).toEqual({ result: "grant", pack: "20", credits: 2000, tenantId: TENANT });
    // $20 paid on another pack's plan, or on a plan that is no pack, grants nothing
    expect(decideGrant(pay({ total: whopMoney("20.00") }), cfg)).toMatchObject({ result: "amount_mismatch", pack: "50" });
    expect(decideGrant(pay({ plan_id: "plan_SomeOther20", total: whopMoney("20.00") }), cfg)).toEqual({ result: "unknown_plan", configIncomplete: false });
    expect(decideGrant(pay({ plan_id: PLAN_20, total: whopMoney("50.00") }), cfg)).toMatchObject({ result: "amount_mismatch", pack: "20" });
    expect(decideGrant(pay({ plan_id: PLAN_250, total: whopMoney("250.00") }), cfg)).toEqual({ result: "grant", pack: "250", credits: 27500, tenantId: TENANT });
    // metadata never picks the pack: a pack claim in the metadata is ignored, and the amount must match the plan's pack
    expect(decideGrant(pay({ metadata: { resolve_tenant_id: TENANT, pack: "250" } }), cfg)).toMatchObject({ result: "grant", pack: "50", credits: 5000 });
    expect(decideGrant(pay({ total: whopMoney("250.00") }), cfg)).toMatchObject({ result: "amount_mismatch", pack: "50" });
  });
  it("an unknown plan grants nothing; it may be a pack only while a plan variable is missing", () => {
    expect(decideGrant(pay({ plan_id: "plan_other" }), cfg)).toEqual({ result: "unknown_plan", configIncomplete: false });
    expect(decideGrant(pay({ plan_id: null }), cfg)).toEqual({ result: "unknown_plan", configIncomplete: false });
    expect(decideGrant(pay({ plan_id: PLAN_250 }), whopConfig(env({ WHOP_PLAN_ID_250: "" })))).toEqual({ result: "unknown_plan", configIncomplete: true });
  });
  it("the amount paid and the currency must equal the pack's price exactly", () => {
    expect(decideGrant(pay({ total: whopMoney("49.99") }), cfg)).toMatchObject({ result: "amount_mismatch", detail: "paid $49.99, the pack costs $50.00" });
    expect(decideGrant(pay({ total: whopMoney("50.01") }), cfg)).toMatchObject({ result: "amount_mismatch" });
    expect(decideGrant(pay({ currency: "eur", total: whopMoney("50.00", "eur") }), cfg)).toMatchObject({ result: "amount_mismatch", detail: "currency is eur, not usd" });
    expect(decideGrant(pay({ total: whopMoney("50.00", "eur") }), cfg)).toMatchObject({ result: "amount_mismatch" });
    expect(decideGrant(pay({ total: null }), cfg)).toMatchObject({ result: "amount_mismatch", detail: "no total" });
    expect(decideGrant(pay({ total: whopMoney("50.005") }), cfg)).toMatchObject({ result: "amount_mismatch" });
  });
  it("tax added on top is taken off the total; tax inside the price is not; tax of unknown placement stops the grant", () => {
    expect(decideGrant(pay({ total: whopMoney("54.13"), tax_amount: whopMoney("4.13"), tax_behavior: "exclusive" }), cfg)).toMatchObject({ result: "grant" });
    expect(decideGrant(pay({ total: whopMoney("50.00"), tax_amount: whopMoney("4.13"), tax_behavior: "inclusive" }), cfg)).toMatchObject({ result: "grant" });
    expect(decideGrant(pay({ total: whopMoney("54.13"), tax_amount: whopMoney("4.13"), tax_behavior: null }), cfg)).toMatchObject({ result: "amount_mismatch" });
    expect(decideGrant(pay({ total: whopMoney("54.13"), tax_amount: whopMoney("4.13"), tax_behavior: "inclusive" }), cfg)).toMatchObject({ result: "amount_mismatch" });
  });
  it("not paid, already refunded, or no tenant id in the metadata grants nothing", () => {
    expect(decideGrant(pay({ status: "pending" }), cfg)).toMatchObject({ result: "not_paid" });
    expect(decideGrant(pay({ refunded_amount: whopMoney("10.00") }), cfg)).toMatchObject({ result: "refunded_already" });
    expect(decideGrant(pay({ refunded_amount: whopMoney("0.00") }), cfg)).toMatchObject({ result: "grant" });
    expect(decideGrant(pay({}, null), cfg)).toMatchObject({ result: "no_tenant" });
    expect(decideGrant(pay({ metadata: null }), cfg)).toMatchObject({ result: "no_tenant" });
    expect(decideGrant(pay({ metadata: { resolve_tenant_id: "rsl_test_abc" } }), cfg)).toMatchObject({ result: "no_tenant", detail: "resolve_tenant_id is not a tenant id" });
  });
  it("amounts: exact decimal strings and whole cents only", () => {
    expect(moneyCents(whopMoney("50.00"))).toBe(5000);
    expect(moneyCents(whopMoney("50"))).toBe(5000);
    expect(moneyCents(whopMoney("50.000000"))).toBe(5000);
    expect(moneyCents(whopMoney("50.001"))).toBeNull();
    expect(moneyCents(whopMoney("-50.00"))).toBeNull();
    expect(moneyCents(whopMoney("5e1"))).toBeNull();
    expect(moneyCents(whopMoney("50.00", "eur"))).toBeNull();
    expect(floatCents(10.43)).toBe(1043);
    expect(floatCents(10.435)).toBeNull();
    expect(floatCents(-1)).toBeNull();
    expect(paidCents(pay())).toEqual({ cents: 5000 });
  });
});

describe("what a refund or dispute takes back", () => {
  it("proportionally (rounded up) when both amounts are known, else all of it", () => {
    expect(reversalCredits(5000, 1000, 5000)).toEqual({ credits: 1000, proportional: true });
    expect(reversalCredits(27500, 1043, 25000)).toEqual({ credits: 1148, proportional: true });
    expect(reversalCredits(5000, 5000, 5000)).toEqual({ credits: 5000, proportional: false });
    expect(reversalCredits(5000, 6000, 5000)).toEqual({ credits: 5000, proportional: false });
    expect(reversalCredits(5000, null, 5000)).toEqual({ credits: 5000, proportional: false });
    expect(reversalCredits(5000, 1000, null)).toEqual({ credits: 5000, proportional: false });
    expect(usdCents(10, "eur")).toBeNull();
    expect(usdCents(10.5, "USD")).toBe(1050);
    expect(packPriceFor(2000)).toBe(2000);
    expect(packPriceFor(5000)).toBe(5000);
    expect(packPriceFor(27500)).toBe(25000);
    expect(packPriceFor(4999)).toBeNull();
  });
  it("a refund reads the same in either documented shape: the SDK's RefundLegacy or the native Refund", () => {
    // the legacy shape's payment total is not read: every reversal is measured against the pack's price (packPriceFor)
    expect(readRefund(refundEvent("refund.created", { amount: 10, total: 54.38 }).data)).toEqual({ id: "ref_test1", paymentId: "pay_test50", status: "succeeded", partCents: 1000 });
    expect(readRefund(nativeRefundEvent("refund.updated", { amount: "10.00" }).data)).toEqual({ id: "rf_test1", paymentId: "pay_test50", status: "succeeded", partCents: 1000 });
    expect(readRefund(nativeRefundEvent("refund.created", { amount: null }).data)).toMatchObject({ partCents: null });
    expect(readRefund(refundEvent("refund.created", { amount: 10, currency: "eur" }).data)).toMatchObject({ partCents: null });
    expect(readRefund({ id: "ref_x", status: "succeeded" })).toHaveProperty("error");
  });
  it("request ids: one per payment for the grant, one per refund or dispute for a reversal, the payment inside", () => {
    expect(grantRequestIdFor("pay_1")).toBe("whop:pay_1");
    expect(reversalRequestIdFor("refund", "pay_1", "ref_9")).toBe("whop-refund:pay_1:ref_9");
    expect(reversalRequestIdFor("dispute", "pay_1", "dspt_9")).toBe("whop-dispute:pay_1:dspt_9");
  });
});

describe("where a buyer may be sent", () => {
  it("only https on Whop's checkout host for the configuration", () => {
    const prod = whopConfig(env()), sandbox = whopConfig(env({ WHOP_SANDBOX: "1" }));
    expect(checkoutUrlAllowed("https://whop.com/checkout/ch_abc/", prod)).toBe(true);
    for (const u of ["http://whop.com/checkout/ch_abc/", "https://evil.example/checkout", "https://whop.com.evil.example/x", "https://user:pw@whop.com/x", "https://sandbox.whop.com/checkout/ch_abc/", "javascript:alert(1)", 42, null]) expect(checkoutUrlAllowed(u, prod), String(u)).toBe(false);
    expect(checkoutUrlAllowed("https://sandbox.whop.com/checkout/ch_abc/", sandbox)).toBe(true);
    expect(checkoutUrlAllowed("https://whop.com/checkout/ch_abc/", sandbox)).toBe(false);
  });
});

/**
 * The card checkout rails, as authored cases graded by equality on accept or refuse. No network, no credentials, no
 * database.
 *   - signature (rail whop_signature, src/billing/whop.ts verifyWhopSignature): over a fixed secret and a fixed clock,
 *     first on the verifier and then on POST /webhooks/whop itself (an event type the route ignores);
 *   - pack_offer (rail card_pack_plan_set, src/billing/whop.ts offeredPacks and packOffer): whether a pack is offered
 *     (the list every surface reads, the checkout decision, the 402 top_up, the /pricing form's options) for a fixed
 *     configuration; "accept" = offered. The dark $1,000 pack with an empty, blank or malformed plan id is refused.
 *   npx tsx evals/whop.ts     run the cases (exit 1 on any failure)
 * evals/mutate.ts switches each rail off and requires its group to go red while the same group with every rail on stays
 * green; the control cases (a genuine signature; a core pack, or the $1,000 pack with its plan set) pass either way.
 */
import type { Env } from "../src/env";
import { offeredPacks, packOffer, verifyWhopSignature, whopConfig, whopSignature, WHOP_SIGNATURE_TOLERANCE_S, type PackId } from "../src/billing/whop";
import { whopWebhook } from "../src/api/billing";
import { topUp } from "../src/billing/top-up";
import { payByCardHtml } from "../src/api/site";

export type WhopGroup = "signature" | "pack_offer";
interface Headers3 { id?: string; timestamp?: string; signature?: string }
/** pack_offer: which surface is asked whether `pack` is offered under `env`. */
interface OfferAsk { surface: "list" | "checkout" | "top_up" | "form"; pack: PackId; env: Record<string, string> }
export interface WhopCase { id: string; group: WhopGroup; control: boolean; title: string; via: "verifier" | "route" | "offer"; secret: string; headers: Headers3; body: string; expect: "accept" | "refuse"; env?: Record<string, string>; offer?: OfferAsk }
interface Outcome { id: string; group: WhopGroup; control: boolean; result: "pass" | "grader_fail" | "harness_error"; failures: string[] }
export interface WhopSummary { cases: number; passed: number; grader_fail: number; harness_error: number; skipped: number; outcomes: Outcome[]; label?: string }

/** The clock every case runs at, and the secret Whop "issued" (the documented ws_ form, [W1]). */
const NOW = Date.parse("2026-09-30T12:00:00Z");
const T = String(Math.floor(NOW / 1000));
const SECRET = "ws_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MSG = "msg_2mYx0000000000000000000000";
const BODY = JSON.stringify({ id: MSG, type: "membership.activated", api_version: "v1", api_version_date: "2026-09-29", timestamp: "2026-09-30T12:00:00.000Z", data: { id: "mem_x" } });
const FORGED_PAYMENT = JSON.stringify({ id: MSG, type: "payment.succeeded", api_version: "v1", data: { id: "pay_forged" } });
/** The $20 pack's plan as wrangler.toml sets it (plan §22.3 #5): 2,000 credits to whichever tenant the metadata names. */
const PLAN_20 = "plan_PNgCSGmXG38KW";
const PAYMENT_20 = JSON.stringify({
  id: MSG, type: "payment.succeeded", api_version: "v1", api_version_date: "2026-09-29", timestamp: "2026-09-30T12:00:00.000Z",
  data: { id: "pay_twenty000001", status: "paid", plan_id: PLAN_20, currency: "usd", total: { amount: "20.00", currency: "usd" }, tax_amount: null, tax_behavior: null, refunded_amount: null, metadata: { resolve_tenant_id: "11111111-2222-4333-8444-555555555555" }, customer_email: null },
});

/** The Standard Webhooks key derivation (base64-decode after a whsec_ prefix), which Whop's backend does not use ([W2]). */
function decodedKeyBytes(secret: string): string {
  const b = secret.replace(/^ws_/, "");
  return Buffer.from(b, "base64").toString("latin1");
}

async function authorCases(): Promise<WhopCase[]> {
  const good = await whopSignature(SECRET, MSG, T, BODY);
  const other = await whopSignature("ws_another_secret_entirely_0000000000000000000000000000000000000", MSG, T, BODY);
  const stdKey = await whopSignature(decodedKeyBytes(SECRET), MSG, T, BODY);
  const old = String(Number(T) - WHOP_SIGNATURE_TOLERANCE_S - 1);
  const ahead = String(Number(T) + WHOP_SIGNATURE_TOLERANCE_S + 1);
  const edge = String(Number(T) - WHOP_SIGNATURE_TOLERANCE_S);
  const h = (over: Partial<Headers3> = {}): Headers3 => ({ id: MSG, timestamp: T, signature: `v1,${good}`, ...over });
  const c = (id: string, control: boolean, title: string, headers: Headers3, expect: WhopCase["expect"], body = BODY, via: WhopCase["via"] = "verifier"): WhopCase => ({ id, group: "signature", control, title, via, secret: SECRET, headers, body, expect });
  return [
    // --- controls: a genuine delivery is accepted with the rail on or off ------------------------------------------------
    c("WH-001", true, "the signature Whop computes over id.timestamp.body with the literal secret", h(), "accept"),
    c("WH-002", true, "one matching v1 entry among several (a secret rotation sends two)", h({ signature: `v1,${other} v1,${good}` }), "accept"),
    c("WH-003", true, "a timestamp exactly 300 s old is still inside the window", h({ timestamp: edge, signature: `v1,${await whopSignature(SECRET, MSG, edge, BODY)}` }), "accept"),
    c("WH-004", true, "the route answers a genuine event of a type it ignores with 200", h(), "accept", BODY, "route"),
    c("WH-005", true, "a genuine payment.succeeded on the $20 pack's plan (plan_PNgCSGmXG38KW)", { id: MSG, timestamp: T, signature: `v1,${await whopSignature(SECRET, MSG, T, PAYMENT_20)}` }, "accept", PAYMENT_20),
    // --- refused only with the rail on (red when it is off) --------------------------------------------------------------
    c("WH-101", false, "a signature that is not the HMAC of this request", h({ signature: `v1,${"A".repeat(43)}=` }), "refuse"),
    c("WH-102", false, "the body changed after signing", h(), "refuse", BODY.replace("mem_x", "mem_y")),
    c("WH-103", false, "the webhook-id changed after signing", h({ id: "msg_someoneelse000000000000000" }), "refuse"),
    c("WH-104", false, "a timestamp 301 s old (a replay)", h({ timestamp: old, signature: `v1,${await whopSignature(SECRET, MSG, old, BODY)}` }), "refuse"),
    c("WH-105", false, "a timestamp 301 s ahead", h({ timestamp: ahead, signature: `v1,${await whopSignature(SECRET, MSG, ahead, BODY)}` }), "refuse"),
    c("WH-106", false, "signed with another secret", h({ signature: `v1,${other}` }), "refuse"),
    c("WH-107", false, "signed with the Standard Webhooks base64-decoded key instead of the literal secret", h({ signature: `v1,${stdKey}` }), "refuse"),
    c("WH-108", false, "the right signature under another version tag", h({ signature: `v2,${good}` }), "refuse"),
    c("WH-109", false, "no signature header", h({ signature: undefined }), "refuse"),
    c("WH-110", false, "a timestamp with a leading zero (the text signed must be the number checked)", h({ timestamp: `0${T}`, signature: `v1,${await whopSignature(SECRET, MSG, `0${T}`, BODY)}` }), "refuse"),
    c("WH-111", false, "the route refuses a forged payment.succeeded with 401 before reading it", h({ signature: `v1,${"B".repeat(43)}=` }), "refuse", FORGED_PAYMENT, "route"),
    { ...c("WH-112", false, "the route refuses a forged $20-pack payment (plan_PNgCSGmXG38KW, 2,000 credits) with 401 while the $20 plan is configured", h({ signature: `v1,${"C".repeat(43)}=` }), "refuse", PAYMENT_20, "route"), env: { WHOP_PLAN_ID_20: PLAN_20 } },
    ...offerCases(),
  ];
}

/** Card checkout switched on with the core packs' plans as wrangler.toml ships them; WHOP_PLAN_ID_1000 as each case sets it. */
const SHIPPED = { WHOP_CHECKOUT_ENABLED: "1", WHOP_API_KEY: "whop_api_key_eval", WHOP_PLAN_ID_20: PLAN_20, WHOP_PLAN_ID_50: "plan_XsiHbMZVNGoca", WHOP_PLAN_ID_250: "plan_NHZHY3hkYrT2J", WHOP_PLAN_ID_1000: "" };
const PLAN_1000 = "plan_Pack1000Eval0001";

function offerCases(): WhopCase[] {
  const o = (id: string, control: boolean, title: string, surface: OfferAsk["surface"], pack: PackId, plan1000: string, expect: WhopCase["expect"]): WhopCase =>
    ({ id, group: "pack_offer", control, title, via: "offer", secret: "", headers: {}, body: "", expect, offer: { surface, pack, env: { ...SHIPPED, WHOP_PLAN_ID_1000: plan1000 } } });
  return [
    // --- controls: a core pack, or the $1,000 pack once its plan is set, is offered with the rail on or off ---------------
    o("WH-201", true, "the $250 pack is listed while the $1,000 plan id is empty (the dark pack never closes the others)", "list", "250", "", "accept"),
    o("WH-202", true, "the $50 pack opens a checkout while the $1,000 plan id is empty", "checkout", "50", "", "accept"),
    o("WH-203", true, "the 402 top_up names the $20 pack while the $1,000 plan id is empty", "top_up", "20", "", "accept"),
    o("WH-204", true, "the $1,000 pack is listed once its plan id is set", "list", "1000", PLAN_1000, "accept"),
    o("WH-205", true, "the $1,000 pack opens a checkout once its plan id is set", "checkout", "1000", PLAN_1000, "accept"),
    o("WH-206", true, "the /pricing form offers the $1,000 pack once its plan id is set", "form", "1000", PLAN_1000, "accept"),
    // --- refused only with the rail on (red when it is off) --------------------------------------------------------------
    o("WH-301", false, "an empty WHOP_PLAN_ID_1000 (as wrangler.toml ships it): the $1,000 pack is not listed", "list", "1000", "", "refuse"),
    o("WH-302", false, "an empty WHOP_PLAN_ID_1000: no checkout is opened for the $1,000 pack", "checkout", "1000", "", "refuse"),
    o("WH-303", false, "an empty WHOP_PLAN_ID_1000: the 402 top_up does not name the $1,000 pack", "top_up", "1000", "", "refuse"),
    o("WH-304", false, "an empty WHOP_PLAN_ID_1000: the /pricing form has no $1,000 option", "form", "1000", "", "refuse"),
    o("WH-305", false, "a blank WHOP_PLAN_ID_1000 (spaces only) is empty: not listed", "list", "1000", "   ", "refuse"),
    o("WH-306", false, "a malformed WHOP_PLAN_ID_1000 (not a plan_ id): not listed", "list", "1000", "prod_NotAPlan", "refuse"),
    o("WH-307", false, "a malformed WHOP_PLAN_ID_1000: no checkout is opened for the $1,000 pack", "checkout", "1000", "prod_NotAPlan", "refuse"),
  ];
}

/** Whether the asked surface offers the pack under the case's configuration (the routes pass offeredPacks to the form). */
function offered(a: OfferAsk): boolean {
  const env = a.env as unknown as Env;
  const cfg = whopConfig(env);
  if (a.surface === "list") return offeredPacks(cfg).includes(a.pack);
  if (a.surface === "checkout") return packOffer(cfg, a.pack).ok;
  if (a.surface === "top_up") { const t = topUp(env, "https://resolve.example.com"); return t.method === "card" && t.packs.some((p) => p.pack === a.pack); }
  return payByCardHtml({ base: "https://resolve.example.com", packs: offeredPacks(cfg) }).includes(`<option value="${a.pack}">`);
}

async function runCase(k: WhopCase): Promise<string[]> {
  let accepted: boolean;
  if (k.via === "offer") {
    if (!k.offer) return ["an offer case without its question"];
    accepted = offered(k.offer);
  } else if (k.via === "verifier") {
    accepted = (await verifyWhopSignature(k.secret, k.headers, k.body, NOW)).ok;
  } else {
    const env = { WHOP_WEBHOOK_SECRET: k.secret, ...k.env } as unknown as Env;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (k.headers.id) headers["webhook-id"] = k.headers.id;
    if (k.headers.timestamp) headers["webhook-timestamp"] = k.headers.timestamp;
    if (k.headers.signature) headers["webhook-signature"] = k.headers.signature;
    const realNow = Date.now;
    Date.now = () => NOW;
    // A forged event the route believes (the rail off) reaches the event code, whose alert has no database here: quiet.
    const log = console.log, error = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      const res = await whopWebhook.request("/webhooks/whop", { method: "POST", headers, body: k.body }, env);
      if (res.status !== 200 && res.status !== 401) return [`route answered ${res.status}`];
      accepted = res.status === 200;
    } finally { Date.now = realNow; console.log = log; console.error = error; }
  }
  const want = k.expect === "accept";
  return accepted === want ? [] : [`expected ${k.expect}, got ${accepted ? "accept" : "refuse"}`];
}

export async function runWhopSuite(opts: { groups?: string[] | null; quiet?: boolean; label?: string } = {}): Promise<WhopSummary> {
  const all = await authorCases();
  const cases = opts.groups ? all.filter((k) => opts.groups!.includes(k.group)) : all;
  const outcomes: Outcome[] = [];
  for (const k of cases) {
    try {
      const failures = await runCase(k);
      outcomes.push({ id: k.id, group: k.group, control: k.control, result: failures.length ? "grader_fail" : "pass", failures });
    } catch (e) {
      outcomes.push({ id: k.id, group: k.group, control: k.control, result: "harness_error", failures: [`exception: ${String(e).slice(0, 200)}`] });
    }
  }
  const s: WhopSummary = {
    cases: outcomes.length, passed: outcomes.filter((o) => o.result === "pass").length,
    grader_fail: outcomes.filter((o) => o.result === "grader_fail").length, harness_error: outcomes.filter((o) => o.result === "harness_error").length,
    skipped: 0, outcomes, label: opts.label,
  };
  if (!opts.quiet) {
    for (const o of outcomes) if (o.result !== "pass") console.log(`${o.result.toUpperCase().padEnd(13)} ${o.id.padEnd(8)} ${o.failures.join("; ")}`);
    console.log(`${opts.label ? `[${opts.label}] ` : ""}whop: cases=${s.cases} passed=${s.passed} grader_fail=${s.grader_fail} harness_error=${s.harness_error}`);
  }
  return s;
}

if (process.argv[1] && process.argv[1].endsWith("whop.ts")) {
  runWhopSuite().then((s) => process.exit(s.grader_fail || s.harness_error ? 1 : 0)).catch((e) => { console.error(String(e)); process.exit(1); });
}

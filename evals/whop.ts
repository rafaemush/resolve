/**
 * The Whop webhook signature rail (rail whop_signature, src/billing/whop.ts verifyWhopSignature): authored cases over a
 * fixed secret and a fixed clock, graded by equality on accept or refuse, first on the verifier and then on POST
 * /webhooks/whop itself (an event type the route ignores, so no case needs a database). No network, no credentials.
 *   npx tsx evals/whop.ts     run the cases (exit 1 on any failure)
 * Group: signature. evals/mutate.ts switches the rail off and requires the group to go red while the same group with
 * every rail on stays green; the control cases (a genuine signature) are accepted either way.
 */
import type { Env } from "../src/env";
import { verifyWhopSignature, whopSignature, WHOP_SIGNATURE_TOLERANCE_S } from "../src/billing/whop";
import { whopWebhook } from "../src/api/billing";

export type WhopGroup = "signature";
interface Headers3 { id?: string; timestamp?: string; signature?: string }
export interface WhopCase { id: string; group: WhopGroup; control: boolean; title: string; via: "verifier" | "route"; secret: string; headers: Headers3; body: string; expect: "accept" | "refuse" }
interface Outcome { id: string; group: WhopGroup; control: boolean; result: "pass" | "grader_fail" | "harness_error"; failures: string[] }
export interface WhopSummary { cases: number; passed: number; grader_fail: number; harness_error: number; skipped: number; outcomes: Outcome[]; label?: string }

/** The clock every case runs at, and the secret Whop "issued" (the documented ws_ form, [W1]). */
const NOW = Date.parse("2026-09-30T12:00:00Z");
const T = String(Math.floor(NOW / 1000));
const SECRET = "ws_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MSG = "msg_2mYx0000000000000000000000";
const BODY = JSON.stringify({ id: MSG, type: "membership.activated", api_version: "v1", api_version_date: "2026-09-29", timestamp: "2026-09-30T12:00:00.000Z", data: { id: "mem_x" } });
const FORGED_PAYMENT = JSON.stringify({ id: MSG, type: "payment.succeeded", api_version: "v1", data: { id: "pay_forged" } });

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
  ];
}

async function runCase(k: WhopCase): Promise<string[]> {
  let accepted: boolean;
  if (k.via === "verifier") {
    accepted = (await verifyWhopSignature(k.secret, k.headers, k.body, NOW)).ok;
  } else {
    const env = { WHOP_WEBHOOK_SECRET: k.secret } as unknown as Env;
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

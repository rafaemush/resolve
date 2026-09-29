/**
 * The evaluation key POST /v1/request-key issues on the spot (plan §21.4 C), the way scripts/issue-test-key.ts issues
 * one by hand: a new tenant on the free plan (watch_limit 5), the 300-credit evaluation grant through grant_credits()
 * once per tenant (ledger request_id grantRequestId), then the rsl_test_ key, minted last, valid 30 days
 * (api_keys.expires_at). A new tenant every time: a form never reuses a tenant by name, so a stranger can never reach
 * another tenant's credits. The raw key is returned to be shown once; it is never stored, logged, alerted, or written to
 * the lead or the touch.
 *
 * Abuse limits, each fail-closed (no key when unsure; the form then answers as it did before keys were issued here:
 * the lead is stored, the operator alerted, a person answers by email):
 *   - one key per email address per 30 days: a tenant created for the address (emailKey, stored as tenants.contact) in
 *     the last 30 days refuses, deleted or not, and a rate_limit_hit bucket per address (its sha256, never the address)
 *     that allows one request a day makes two concurrent requests issue one key at most;
 *   - a daily cap on keys issued here (REQUEST_KEY_DAILY_CAP, default 25; "0" turns issuing off, an invalid value is 0),
 *     counted per UTC day by rate_limit_hit;
 *   - any database error, or an answer other than the one expected, stops before a key is stored or shown.
 * The form's per-IP and global hourly limits stay in front of all of this (src/api/site.ts).
 */
import type { Db } from "../db/supabase";
import { sha256Hex } from "../resolve/text";
import { redact } from "../ops/redact";
import { EVALUATION_KEY_DAYS, EVALUATION_WATCH_LIMIT, FREE_EVALUATION_CREDITS, grantRequestId, mintKey } from "./keys";

export const AUTO_KEY_DAILY_CAP_DEFAULT = 25;
const AUTO_KEY_DAILY_CAP_MAX = 1000;
const DAY_MS = 86_400_000;

/**
 * Pure. REQUEST_KEY_DAILY_CAP: unset or blank = 25; a whole number from 0 to 1000 = that many keys per UTC day (0 =
 * issuing off); anything else is invalid and issues nothing, never a guessed number.
 */
export function autoKeyDailyCap(raw: string | undefined): { cap: number; invalid: boolean } {
  const v = (raw ?? "").trim();
  if (v === "") return { cap: AUTO_KEY_DAILY_CAP_DEFAULT, invalid: false };
  if (!/^\d{1,4}$/.test(v) || Number(v) > AUTO_KEY_DAILY_CAP_MAX) return { cap: 0, invalid: true };
  return { cap: Number(v), invalid: false };
}

/**
 * Pure. The address one key per 30 days is counted by: lower case, a "+tag" dropped, and on gmail.com (googlemail.com
 * is the same mailbox) the dots of the local part dropped, since each of those reaches the same inbox.
 */
export function emailKey(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "") || local;
  return `${local}@${domain}`;
}

export interface AutoKeyInput {
  email: string;
  /** The requester's company or project; the tenant is named "<company> (web form)". */
  company: string;
  leadId: string;
  requestId: string;
  now: number;
  /** REQUEST_KEY_DAILY_CAP as configured. */
  dailyCap: string | undefined;
}

export type AutoKeyOutcome =
  | { result: "issued"; key: string; keyId: string; tenantId: string; expiresAt: string; credits: number }
  /** Issuing is switched off (cap 0) or its configuration is invalid. */
  | { result: "off"; reason: string }
  /** A key went to this address in the last 30 days, or another request for it is being handled. */
  | { result: "known_address" }
  | { result: "cap_reached"; cap: number }
  | { result: "db_error"; step: string; detail: string; tenantId: string | null };

const first = (d: unknown) => (Array.isArray(d) ? d[0] : d) as { allowed?: boolean } | null;
const why = (e: unknown) => redact(String((e as { message?: unknown })?.message ?? e)).slice(0, 200);

/**
 * Decide and, when every check passes, issue. At most 6 subrequests, in this order: the address lookup, the address
 * bucket, the day's bucket, the tenant insert, grant_credits, the key insert. A step that fails leaves the later ones
 * unrun; the outcome names the step, and the tenant when one was created without a key.
 */
export async function issueEvaluationKey(client: Db, o: AutoKeyInput): Promise<AutoKeyOutcome> {
  const cfg = autoKeyDailyCap(o.dailyCap);
  if (cfg.invalid) return { result: "off", reason: "REQUEST_KEY_DAILY_CAP is not a whole number from 0 to 1000" };
  if (cfg.cap === 0) return { result: "off", reason: "REQUEST_KEY_DAILY_CAP is 0" };
  const address = emailKey(o.email);
  let tenantId: string | null = null;
  let step = "address lookup";
  try {
    const since = new Date(o.now - EVALUATION_KEY_DAYS * DAY_MS).toISOString();
    const prior = await client.from("tenants").select("id").eq("contact", address).gte("created_at", since).limit(1);
    if (prior.error) return { result: "db_error", step, detail: why(prior.error), tenantId };
    if (!Array.isArray(prior.data)) return { result: "db_error", step, detail: "no rows array", tenantId };
    if (prior.data.length) return { result: "known_address" };

    step = "address bucket";
    const mine = await client.rpc("rate_limit_hit", { p_key: `request_key:email:${await sha256Hex(address)}`, p_window_ms: DAY_MS, p_limit: 1 });
    if (mine.error) return { result: "db_error", step, detail: why(mine.error), tenantId };
    if (first(mine.data)?.allowed !== true) return { result: "known_address" };

    step = "daily cap bucket";
    const day = new Date(o.now).toISOString().slice(0, 10);
    const today = await client.rpc("rate_limit_hit", { p_key: `request_key:issued:${day}`, p_window_ms: DAY_MS, p_limit: cfg.cap });
    if (today.error) return { result: "db_error", step, detail: why(today.error), tenantId };
    if (first(today.data)?.allowed !== true) return { result: "cap_reached", cap: cfg.cap };

    step = "tenant insert";
    const t = await client.from("tenants").insert({
      display_name: `${o.company.slice(0, 180)} (web form)`, contact: address, plan: "free", watch_limit: EVALUATION_WATCH_LIMIT,
      meta: { source: "request-key", lead_id: o.leadId, request_id: o.requestId },
    }).select("id").single();
    if (t.error || !t.data) return { result: "db_error", step, detail: t.error ? why(t.error) : "no row returned", tenantId };
    tenantId = String((t.data as { id: string }).id);

    step = "grant_credits";
    const g = await client.rpc("grant_credits", { p_tenant: tenantId, p_amount: FREE_EVALUATION_CREDITS, p_note: "evaluation grant (POST /v1/request-key)", p_request_id: grantRequestId(tenantId) });
    if (g.error) return { result: "db_error", step, detail: why(g.error), tenantId };
    // A new tenant's balance after the grant is the grant: any other answer is not understood, so no key.
    if (Number(g.data) !== FREE_EVALUATION_CREDITS) return { result: "db_error", step, detail: `balance after the grant is ${String(g.data).slice(0, 40)}, expected ${FREE_EVALUATION_CREDITS}`, tenantId };

    step = "key insert";
    const key = await mintKey("test");
    const expiresAt = new Date(o.now + EVALUATION_KEY_DAYS * DAY_MS).toISOString();
    const k = await client.from("api_keys").insert({ tenant_id: tenantId, key_hash: key.hash, key_prefix: key.prefix, name: "request-key", environment: "test", daily_cap: 1000, expires_at: expiresAt }).select("id").single();
    if (k.error || !k.data) return { result: "db_error", step, detail: k.error ? why(k.error) : "no row returned", tenantId };
    return { result: "issued", key: key.raw, keyId: String((k.data as { id: string }).id), tenantId, expiresAt, credits: FREE_EVALUATION_CREDITS };
  } catch (e) {
    return { result: "db_error", step, detail: why(e), tenantId };
  }
}

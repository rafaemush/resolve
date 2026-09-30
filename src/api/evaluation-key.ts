/**
 * The evaluation key POST /v1/request-key issues on the spot (plan §21.4 C), the way scripts/issue-test-key.ts issues
 * one by hand: a new tenant on the free plan (watch_limit 5), the 300-credit evaluation grant through grant_credits()
 * once per tenant (ledger request_id grantRequestId), then the rsl_test_ key, minted last, valid 30 days
 * (api_keys.expires_at). A new tenant every time: a form never reuses a tenant by name, so a stranger can never reach
 * another tenant's credits. The raw key is returned to be shown once; it is never stored, logged, alerted, or written to
 * the lead or the touch. The free plan has structured verdicts only, whatever JEV_PAID_ROUTES_ENABLED says
 * (src/resolve/runtime.ts).
 *
 * Abuse limits, each fail-closed (no key when unsure; the form then answers as it did before keys were issued here:
 * the lead is stored, the operator alerted, a person answers by email):
 *   - one key per email address per 30 days: a tenant created for the address (emailKey, stored as tenants.contact) in
 *     the last 30 days refuses, deleted or not;
 *   - one request per address at a time: a rate_limit_hit bucket per address (its sha256, never the address) that
 *     allows one request a day makes two concurrent requests issue one key at most. A request that holds it and ends
 *     before a tenant exists (a limit below, a database error) releases it, so the address can ask again; a hold whose
 *     release fails lapses after the day;
 *   - at most 3 keys a UTC day per network (the IPv4 address, or the IPv6 /64), so one network cannot use the day's cap;
 *   - a daily cap on keys issued here (REQUEST_KEY_DAILY_CAP, default 25; "0" turns issuing off, an invalid value is 0),
 *     counted per UTC day by rate_limit_hit;
 *   - any database error, or an answer other than the one expected, stops before a key is stored or shown.
 * The address is checked before the network and the network before the day, so a request refused by one check spends
 * none of the later counts. The form's per-IP and global hourly limits stay in front of all of this (src/api/site.ts).
 */
import type { Db } from "../db/supabase";
import { sha256Hex } from "../resolve/text";
import { redact } from "../ops/redact";
import { EVALUATION_KEY_DAYS, EVALUATION_WATCH_LIMIT, FREE_EVALUATION_CREDITS, grantRequestId, mintKey } from "./keys";

export const AUTO_KEY_DAILY_CAP_DEFAULT = 25;
/** Keys issued here per UTC day to one network (ipSubject): one network cannot use the day's cap on its own. */
export const AUTO_KEYS_PER_NETWORK_PER_DAY = 3;
const AUTO_KEY_DAILY_CAP_MAX = 1000;
const DAY_MS = 86_400_000;
/** A released bucket's reset_at: its window is over, so the next rate_limit_hit opens a new one (rate_limit_gc drains it). */
const RELEASED = "1970-01-01T00:00:00.000Z";

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

/**
 * Pure. The network a request comes from, for the per-network count: an IPv4 address as it is, an IPv6 address as its
 * /64 (one host is usually given a whole /64, so its single addresses are not a limit).
 */
export function ipSubject(ip: string): string {
  const v = ip.trim().toLowerCase();
  if (!v.includes(":")) return v;
  const [head, tail] = v.includes("::") ? v.split("::", 2) as [string, string] : [v, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  // An embedded IPv4 tail (::ffff:192.0.2.1) is two groups.
  const tailGroups = t.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const groups = tail === null ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - tailGroups)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}::/64`;
}

export interface AutoKeyInput {
  email: string;
  /** The requester's company or project; the tenant is named "<company> (web form)". */
  company: string;
  /** CF-Connecting-IP, for the per-network count. */
  ip: string;
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
  /** A tenant was created for this address in the last 30 days (with a key, or without one after a failed step). */
  | { result: "known_address"; tenantId: string; createdAt: string; secondsAgo: number }
  /** Another request holds the address: one running now, or one that ended without a key and could not release it. */
  | { result: "address_held"; until: string | null }
  /** `hold`, on this and the next two: the address stays held because its release failed (null: released, or never held). */
  | { result: "network_limit"; limit: number; hold: string | null }
  | { result: "cap_reached"; cap: number; hold: string | null }
  | { result: "db_error"; step: string; detail: string; tenantId: string | null; hold: string | null };

/** rate_limit_hit's row. `allowed` must be a boolean: any other answer is not understood (a db_error, never a refusal). */
function hit(d: unknown): { allowed: boolean; resetAt: string | null } | null {
  const r = (Array.isArray(d) ? d[0] : d) as { allowed?: unknown; reset_at?: unknown } | null | undefined;
  if (!r || typeof r !== "object" || typeof r.allowed !== "boolean") return null;
  return { allowed: r.allowed, resetAt: typeof r.reset_at === "string" ? r.reset_at : null };
}
const why = (e: unknown) => redact(String((e as { message?: unknown })?.message ?? e)).slice(0, 200);

/** Where a request got to: the step running, the tenant once created, and until when it holds the address. */
interface Progress { step: string; tenantId: string | null; heldUntil: string | null }

/**
 * Decide and, when every check passes, issue. At most 7 subrequests, in this order: the address lookup, the address
 * bucket, the network's bucket, the day's bucket, the tenant insert, grant_credits, the key insert; a request that held
 * the address and stops before the tenant insert succeeds spends one more to release it. A step that fails leaves the
 * later ones unrun; the outcome names the step, and the tenant when one was created without a key.
 */
export async function issueEvaluationKey(client: Db, o: AutoKeyInput): Promise<AutoKeyOutcome> {
  const cfg = autoKeyDailyCap(o.dailyCap);
  if (cfg.invalid) return { result: "off", reason: "REQUEST_KEY_DAILY_CAP is not a whole number from 0 to 1000" };
  if (cfg.cap === 0) return { result: "off", reason: "REQUEST_KEY_DAILY_CAP is 0" };
  const address = emailKey(o.email);
  const holdKey = `request_key:email:${await sha256Hex(address)}`;
  const p: Progress = { step: "address lookup", tenantId: null, heldUntil: null };
  let out: AutoKeyOutcome;
  try { out = await attempt(client, o, cfg.cap, address, holdKey, p); }
  catch (e) { out = { result: "db_error", step: p.step, detail: why(e), tenantId: p.tenantId, hold: null }; }
  // A request that held the address and ends before a tenant exists lets it go: the address can ask again at once.
  if (p.heldUntil && !p.tenantId && (out.result === "network_limit" || out.result === "cap_reached" || out.result === "db_error")) {
    const failed = await release(client, holdKey);
    if (failed) out = { ...out, hold: `the address stays held until ${p.heldUntil} (its release failed: ${failed})` };
  }
  return out;
}

async function attempt(client: Db, o: AutoKeyInput, cap: number, address: string, holdKey: string, p: Progress): Promise<AutoKeyOutcome> {
  const fail = (detail: string): AutoKeyOutcome => ({ result: "db_error", step: p.step, detail, tenantId: p.tenantId, hold: null });
  const since = new Date(o.now - EVALUATION_KEY_DAYS * DAY_MS).toISOString();
  const prior = await client.from("tenants").select("id, created_at").eq("contact", address).gte("created_at", since).order("created_at", { ascending: false }).limit(1);
  if (prior.error) return fail(why(prior.error));
  if (!Array.isArray(prior.data)) return fail("no rows array");
  if (prior.data.length) {
    const t = prior.data[0] as { id: unknown; created_at: unknown };
    const createdAt = String(t.created_at);
    return { result: "known_address", tenantId: String(t.id), createdAt, secondsAgo: Math.max(0, Math.round((o.now - Date.parse(createdAt)) / 1000)) };
  }

  p.step = "address bucket";
  const mine = await client.rpc("rate_limit_hit", { p_key: holdKey, p_window_ms: DAY_MS, p_limit: 1 });
  if (mine.error) return fail(why(mine.error));
  const m = hit(mine.data);
  if (!m) return fail("unexpected answer");
  if (!m.allowed) return { result: "address_held", until: m.resetAt };
  p.heldUntil = m.resetAt ?? new Date(o.now + DAY_MS).toISOString();

  const day = new Date(o.now).toISOString().slice(0, 10);
  p.step = "network bucket";
  const net = await client.rpc("rate_limit_hit", { p_key: `request_key:net:${ipSubject(o.ip)}:${day}`, p_window_ms: DAY_MS, p_limit: AUTO_KEYS_PER_NETWORK_PER_DAY });
  if (net.error) return fail(why(net.error));
  const n = hit(net.data);
  if (!n) return fail("unexpected answer");
  if (!n.allowed) return { result: "network_limit", limit: AUTO_KEYS_PER_NETWORK_PER_DAY, hold: null };

  p.step = "daily cap bucket";
  const today = await client.rpc("rate_limit_hit", { p_key: `request_key:issued:${day}`, p_window_ms: DAY_MS, p_limit: cap });
  if (today.error) return fail(why(today.error));
  const d = hit(today.data);
  if (!d) return fail("unexpected answer");
  if (!d.allowed) return { result: "cap_reached", cap, hold: null };

  p.step = "tenant insert";
  const t = await client.from("tenants").insert({
    display_name: `${o.company.slice(0, 180)} (web form)`, contact: address, plan: "free", watch_limit: EVALUATION_WATCH_LIMIT,
    meta: { source: "request-key", lead_id: o.leadId, request_id: o.requestId },
  }).select("id").single();
  if (t.error || !t.data) return fail(t.error ? why(t.error) : "no row returned");
  p.tenantId = String((t.data as { id: string }).id);

  p.step = "grant_credits";
  const g = await client.rpc("grant_credits", { p_tenant: p.tenantId, p_amount: FREE_EVALUATION_CREDITS, p_note: "evaluation grant (POST /v1/request-key)", p_request_id: grantRequestId(p.tenantId) });
  if (g.error) return fail(why(g.error));
  // A new tenant's balance after the grant is the grant: any other answer is not understood, so no key.
  if (Number(g.data) !== FREE_EVALUATION_CREDITS) return fail(`balance after the grant is ${String(g.data).slice(0, 40)}, expected ${FREE_EVALUATION_CREDITS}`);

  p.step = "key insert";
  const key = await mintKey("test");
  const expiresAt = new Date(o.now + EVALUATION_KEY_DAYS * DAY_MS).toISOString();
  const k = await client.from("api_keys").insert({ tenant_id: p.tenantId, key_hash: key.hash, key_prefix: key.prefix, name: "request-key", environment: "test", daily_cap: 1000, expires_at: expiresAt }).select("id").single();
  if (k.error || !k.data) return fail(k.error ? why(k.error) : "no row returned");
  return { result: "issued", key: key.raw, keyId: String((k.data as { id: string }).id), tenantId: p.tenantId, expiresAt, credits: FREE_EVALUATION_CREDITS };
}

/** Lets the address go (its bucket's window ends now). Returns why it failed, or null. */
async function release(client: Db, holdKey: string): Promise<string | null> {
  try {
    const { error } = await client.from("rate_limit_buckets").update({ count: 0, reset_at: RELEASED }).eq("key", holdKey);
    return error ? why(error) : null;
  } catch (e) { return why(e); }
}

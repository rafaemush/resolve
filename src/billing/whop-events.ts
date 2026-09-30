/**
 * What a verified Whop event does to the ledger (src/billing/whop.ts decides; this module moves the credits). Every
 * grant and every reversal is one credit_ledger row written by grant_credits() (migration 004), keyed so it happens once:
 *   - payment.succeeded: grant_credits(tenant, pack credits, note, "whop:<payment id>"). A repeat is refused by the
 *     ledger's UNIQUE(reason, request_id) (23505) and answers already_processed: never an error Whop would retry for 3
 *     days; so does a repeat that fails a check it passed before (a refund shown since), never a "NOT credited" alert
 *     about a payment the ledger holds. A free tenant's credited purchase moves it to payg (watch_limit at least
 *     PAYG_WATCH_LIMIT) and clears the expiry of its newest live key (its evaluation key; a key rotated out earlier keeps
 *     its own end); no other plan is ever changed, and a repeat retries a move that failed. The grant runs under the
 *     payment's hold (below), and a payment whose refund or formal dispute was processed first is not credited
 *     automatically: deliveries come in any order ([W1]) and a payment.succeeded answered 503 is retried with the same
 *     payload, so the refund leaves a marker the grant checks, and the operator decides what the buyer kept.
 *   - a payment on a plan that is no pack while a plan variable is unset answers 503 (Whop retries once it is set) only
 *     when it names a Resolve tenant in its metadata, i.e. came from a checkout Resolve opened; a test event from the
 *     Whop dashboard or a sale of another product is answered 200, so the webhook is never failed into being disabled.
 *   - a refund (status succeeded) or a formal dispute that holds or took the money (DISPUTE_REVERSES):
 *     grant_credits(tenant, -n, note, "whop-refund|whop-dispute:<payment id>:<id>"), n its share of what the payment
 *     granted less what earlier reversals of the payment took, and at most the balance: a shortfall is alerted, never
 *     thrown. One payment's events, its grant included, run one at a time (a rate_limit_hit hold, released at the end),
 *     so two of them never both read the same remainder and a refund never passes its grant unseen; the earlier
 *     reversals are read by the payment's request_id prefix, never from a window of the tenant's ledger. A reversal of
 *     a payment Resolve never credited leaves a 20-day marker that stops the payment's automatic grant (Whop retries a
 *     delivery for about 3 days). A reversal that could take nothing leaves a 20-day marker, so a repeat of it stays
 *     a no-op while Whop can still redeliver it, and so does a dispute ruled won or closed before anything was taken
 *     (deliveries come in any order: its late dispute.created then takes nothing). A dispute won after its credits were
 *     taken is alerted with the call that gives them back; the operator decides.
 *   - everything that grants nothing (an unknown plan, a wrong amount or currency, no tenant, a deleted tenant, a refund
 *     or dispute processed first) is alerted with what the operator needs to credit it by hand under the same
 *     request_id the automatic grant uses.
 * Answers: 200 for every outcome a retry cannot change; 503 (a database error, a missing configuration) and 409 (another
 * event of the payment is running) for the ones a Whop retry can fix. An alert never carries the buyer's full email
 * address; nothing here ever sees a Resolve key.
 */
import type { Env } from "../env";
import { db, type Db } from "../db/supabase";
import { alert } from "../ops/alerts";
import { maskEmail, redact } from "../ops/redact";
import { PAYG_WATCH_LIMIT } from "../api/keys";
import {
  CARD_PACKS, DISPUTE_RETURNS, DISPUTE_REVERSES, TENANT_METADATA_KEY, WHOP_API_VERSION_DATE, WhopDispute, WhopPayment,
  decideGrant, grantRequestIdFor, packPriceFor, readRefund, reversalCredits, reversalRequestIdFor, usd, usdCents,
  type GrantDecision, type PackId, type WhopConfig, type WhopEnvelope,
} from "./whop";

export interface EventAnswer {
  status: 200 | 409 | 503;
  /** What happened, in one word; the webhook's answer and its log line carry it. */
  result: string;
  detail?: Record<string, unknown>;
  message?: string;
}

/** An alert about one payment, refund or dispute is sent once (30 days); the configuration and database ones hourly or daily. */
const ONCE = 43_200;
/** One payment's events run one at a time: the hold lapses on its own after this if its release fails. */
const HOLD_MS = 60_000;
/** A reversal that took nothing is remembered this long (rate_limit_hit's window is an int4 of ms: at most ~24.8 days). */
const SETTLED_MS = 20 * 86_400_000;
/** A released bucket's reset_at: its window is over (src/api/evaluation-key.ts does the same). */
const RELEASED = "1970-01-01T00:00:00.000Z";
const holdKey = (paymentId: string) => `whop:payment:${paymentId}`;
const settledKey = (requestId: string) => `whop:settled:${requestId}`;
/** A refund or formal dispute of a payment Resolve had not credited: the payment's automatic grant is stopped. */
const reversedFirstKey = (paymentId: string) => `whop:reversed-first:${paymentId}`;
const why = (e: unknown) => redact(String((e as { message?: unknown })?.message ?? e)).slice(0, 200);
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ job: "whop_webhook", ...o }));

interface TenantRow { id: string; plan: string; watch_limit: number | null; deleted_at: string | null }

/** Act on one verified event. Types other than HANDLED_EVENTS are answered 200 and ignored. */
export async function handleWhopEvent(env: Env, cfg: WhopConfig, ev: WhopEnvelope, now = Date.now()): Promise<EventAnswer> {
  switch (ev.type) {
    case "payment.succeeded": return onPayment(env, cfg, ev, now);
    case "refund.created": case "refund.updated": return onRefund(env, ev, now);
    case "dispute.created": case "dispute.updated": return onDispute(env, ev, now);
    default: return { status: 200, result: "ignored" };
  }
}

/** A configuration value is missing: refused (Whop retries for about 3 days), alerted once a day, names never values. */
export async function configMissing(env: Env, names: string[], what: string): Promise<EventAnswer> {
  await alert(env, "whop_config_missing", `Card checkout is not fully configured: ${names.join(", ")} unset or invalid. ${what} was refused and nothing was granted. Set the plan ids in wrangler.toml [vars] and the secrets with wrangler secret put, then deploy; Whop retries a refused webhook for about 3 days.`, { dedupMinutes: 1440, meta: { missing: names } });
  return { status: 503, result: "config_missing", message: "card checkout is not configured yet; retry later" };
}

async function dbTrouble(env: Env, what: string, e: unknown): Promise<EventAnswer> {
  await alert(env, "whop_db_error", `A Whop event could not be processed: ${what} failed (${why(e)}). Nothing was granted or taken back by this attempt; Whop retries the delivery for about 3 days.`, { dedupMinutes: 60 });
  return { status: 503, result: "db_error", message: "the database is unavailable; retry" };
}

async function notUnderstood(env: Env, ev: WhopEnvelope, what: string, detail: string): Promise<EventAnswer> {
  await alert(env, `whop_not_understood_${ev.id.slice(0, 100)}`, `Whop ${ev.type} event ${ev.id} (api_version_date ${ev.api_version_date ?? "none"}) could not be read as a ${what}: ${detail.slice(0, 300)}. Nothing was granted or taken back. The webhook must be pinned to api_version_date ${WHOP_API_VERSION_DATE}.`, { dedupMinutes: 1440, meta: { event_id: ev.id, type: ev.type } });
  return { status: 200, result: "not_understood" };
}

const issues = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) => e.issues.slice(0, 3).map((i) => `${i.path.map(String).join(".") || "data"}: ${i.message}`).join("; ");

// ---- payment.succeeded ----------------------------------------------------------------------------------------------

async function onPayment(env: Env, cfg: WhopConfig, ev: WhopEnvelope, now: number): Promise<EventAnswer> {
  const parsed = WhopPayment.safeParse(ev.data);
  if (!parsed.success) return notUnderstood(env, ev, "payment", issues(parsed.error));
  const p = parsed.data;
  const d = decideGrant(p, cfg);
  const ids = { payment_id: p.id, plan_id: p.plan_id };
  if (d.result === "unknown_plan") {
    // A plan variable is unset, so the plan may be a pack. Only a checkout Resolve opened names a tenant in the metadata:
    // that payment is refused for Whop to retry once the plan ids are set. Anything else is answered 200 like any other
    // plan, so a webhook made before the plan ids are set is not failed for 3 days and disabled ([W1]).
    const fromResolve = p.metadata?.[TENANT_METADATA_KEY] !== undefined;
    if (d.configIncomplete && fromResolve) return configMissing(env, cfg.planMissing, `Whop payment ${p.id} (plan ${p.plan_id ?? "none"}, from a checkout Resolve opened)`);
    const packs = Object.entries(cfg.planOf).map(([k, v]) => `$${k}: ${v}`).join(", ") || "none set";
    const text = d.configIncomplete
      ? `Whop payment ${p.id} is on plan ${p.plan_id ?? "none"}, which is not a configured Resolve credit pack (${packs}; unset or invalid: ${cfg.planMissing.join(", ")}), and it names no Resolve tenant, so it is not a checkout Resolve opened: no credits were granted. Nothing to do for a test event from the Whop dashboard or another product. A pack bought through a plain Whop link is credited by hand once its tenant is known: grant_credits('<tenant id>', <credits>, 'Whop ${p.id} matched by hand: <why>', '${grantRequestIdFor(p.id)}').`
      : `Whop payment ${p.id} is on plan ${p.plan_id ?? "none"}, which is not a Resolve credit pack (${packs}): no credits were granted. Nothing to do when it is another product.`;
    await alert(env, `whop_unknown_plan_${p.id}`, text, { dedupMinutes: ONCE, meta: { ...ids, config_incomplete: d.configIncomplete } });
    return { status: 200, result: "ignored_plan", detail: ids };
  }
  if (d.result !== "grant") {
    const reason = d.result === "not_paid" ? `its status is ${p.status}, not paid` : d.result === "refunded_already" ? `it was already refunded when the event was read (${d.detail})` : d.result === "amount_mismatch" ? `the amount or currency does not match the pack: ${d.detail}` : d.detail;
    return unmatched(env, p, d.pack, d.result, reason);
  }
  const client = db(env);
  return held(env, client, p.id, ids, () => grantHeld(env, client, p, d, ids, now));
}

/** A payment that passed every check, under its hold: the tenant, then the reversed-first marker, then the grant. */
async function grantHeld(env: Env, client: Db, p: WhopPayment, d: Extract<GrantDecision, { result: "grant" }>, ids: { payment_id: string; plan_id: string | null }, now: number): Promise<EventAnswer> {
  let tenant: TenantRow | null;
  try {
    const t = await client.from("tenants").select("id, plan, watch_limit, deleted_at").eq("id", d.tenantId).maybeSingle();
    if (t.error) return dbTrouble(env, `the tenant read for payment ${p.id}`, t.error);
    tenant = (t.data as TenantRow | null) ?? null;
  } catch (e) { return dbTrouble(env, `the tenant read for payment ${p.id}`, e); }
  if (!tenant) return unmatched(env, p, d.pack, "tenant_missing", `no tenant ${d.tenantId} exists`);
  if (tenant.deleted_at) return unmatched(env, p, d.pack, "tenant_deleted", `tenant ${d.tenantId} is deleted`);

  // A refund or formal dispute of this payment ran before it was credited (this event may be a retry of one answered
  // 503): the money went back or is held, so nothing is granted automatically and the operator decides.
  let reversedFirst: boolean;
  try {
    const m = await client.from("rate_limit_buckets").select("key, reset_at").eq("key", reversedFirstKey(p.id)).maybeSingle();
    if (m.error) return dbTrouble(env, `the refund marker read for payment ${p.id}`, m.error);
    const row = m.data as { reset_at: string } | null;
    reversedFirst = !!row && Date.parse(row.reset_at) > now;
  } catch (e) { return dbTrouble(env, `the refund marker read for payment ${p.id}`, e); }
  if (reversedFirst) return unmatched(env, p, d.pack, "reversed_first", `a refund or dispute of it was processed before this payment.succeeded (Whop delivers events in any order; see the whop_nogrant alert of payment ${p.id}), so its money went back to the buyer or is held. Check the payment in Whop: credit by hand only what the buyer kept (a partial refund, a dispute won)`);

  const price = CARD_PACKS[d.pack].priceCents;
  let g: { data: unknown; error: { code?: string; message?: string } | null };
  try {
    g = await client.rpc("grant_credits", { p_tenant: tenant.id, p_amount: d.credits, p_note: `card purchase through Whop: ${usd(price)} pack, ${d.credits} credits (payment ${p.id}, plan ${p.plan_id})`, p_request_id: grantRequestIdFor(p.id) });
  } catch (e) { return dbTrouble(env, `grant_credits for payment ${p.id}`, e); }
  if (g.error) {
    if (g.error.code === "23505") {
      // Granted before (a repeat, or a hand match under the same request_id): nothing more. A plan move that failed then is retried.
      const plan = await upgradeIfFree(client, tenant);
      if (plan.result !== "unchanged") await alert(env, `whop_plan_${p.id}`, `Whop payment ${p.id} came again (credited earlier to tenant ${tenant.id}); plan: ${plan.line}`, { dedupMinutes: ONCE, meta: { ...ids, tenant_id: tenant.id, plan_change: plan.result } });
      return { status: 200, result: "already_processed", detail: { ...ids, tenant_id: tenant.id } };
    }
    // grant_credits raises "tenant ... not found" when the tenant was deleted between the read and the grant
    if (/not found/i.test(g.error.message ?? "")) return unmatched(env, p, d.pack, "tenant_deleted", `tenant ${d.tenantId} was deleted before the grant`);
    return dbTrouble(env, `grant_credits for payment ${p.id}`, g.error);
  }
  const balance = Number(g.data);
  const plan = await upgradeIfFree(client, tenant);
  await alert(env, `whop_payment_${p.id}`, [
    `Card payment credited (Whop): ${usd(price)} pack, ${d.credits} credits`,
    `Tenant: ${tenant.id}`,
    `Whop payment: ${p.id} (plan ${p.plan_id})`,
    `Buyer: ${p.customer_email ? maskEmail(p.customer_email) : "no email in the event"}`,
    `Balance now: ${Number.isFinite(balance) ? balance : "unknown"}`,
    `Plan: ${plan.line}`,
  ].join("\n"), { dedupMinutes: ONCE, meta: { ...ids, tenant_id: tenant.id, pack: d.pack, credits: d.credits, balance_after: Number.isFinite(balance) ? balance : null, plan_change: plan.result } });
  return { status: 200, result: "credited", detail: { ...ids, tenant_id: tenant.id, credits: d.credits, balance: Number.isFinite(balance) ? balance : null } };
}

/**
 * A pack payment that grants nothing: alerted once with everything needed to credit it by hand. A payment the ledger
 * already credited (a repeat that now fails a check it passed, e.g. it shows a refund since; or a hand match under the
 * same request_id) answers already_processed instead: its refund events take the credits back, and nothing is alerted.
 */
async function unmatched(env: Env, p: WhopPayment, pack: PackId, result: string, reason: string): Promise<EventAnswer> {
  let granted: { tenant_id: string } | null;
  try {
    const g = await db(env).from("credit_ledger").select("tenant_id").eq("reason", "grant").eq("request_id", grantRequestIdFor(p.id)).maybeSingle();
    if (g.error) return dbTrouble(env, `the grant read for payment ${p.id}`, g.error);
    granted = (g.data as { tenant_id: string } | null) ?? null;
  } catch (e) { return dbTrouble(env, `the grant read for payment ${p.id}`, e); }
  if (granted) {
    log({ outcome: "already_processed", payment_id: p.id, now_failing: result });
    return { status: 200, result: "already_processed", detail: { payment_id: p.id, plan_id: p.plan_id, tenant_id: granted.tenant_id } };
  }
  const { credits, priceCents } = CARD_PACKS[pack];
  const hint = p.metadata?.[TENANT_METADATA_KEY];
  const tenantHint = typeof hint === "string" ? hint.slice(0, 64) : null;
  await alert(env, `whop_unmatched_${p.id}`, [
    `Whop payment ${p.id} was NOT credited: ${reason}.`,
    `Pack ${usd(priceCents)} (${credits} credits), plan ${p.plan_id}; paid ${p.total ? `${p.total.amount} ${p.total.currency}` : "unknown"}; status ${p.status}; buyer ${p.customer_email ? maskEmail(p.customer_email) : "no email in the event"}; metadata tenant ${tenantHint ?? "none"}.`,
    `Recorded here for manual matching. To credit it once the tenant is known: grant_credits('<tenant id>', ${credits}, 'Whop ${p.id} matched by hand: <why>', '${grantRequestIdFor(p.id)}'), the automatic grant's request_id, so the payment can never be credited twice; a free tenant also moves to plan payg and its key's expires_at is cleared. Otherwise refund it in Whop unless it is refunded already.`,
  ].join("\n"), { dedupMinutes: ONCE, meta: { payment_id: p.id, plan_id: p.plan_id, pack, credits, amount: p.total?.amount ?? null, currency: p.total?.currency ?? p.currency, metadata_tenant: tenantHint, reason: result } });
  return { status: 200, result, detail: { payment_id: p.id, plan_id: p.plan_id } };
}

/**
 * A free tenant's credited purchase: its newest live key stops expiring, then the plan moves to payg with at least
 * PAYG_WATCH_LIMIT watches (the plan last, so a failure in between leaves the tenant free and a repeat redoes both).
 * Any other plan is left as it is. Never throws.
 */
export async function upgradeIfFree(client: Db, t: TenantRow): Promise<{ result: "unchanged" | "upgraded" | "failed"; line: string }> {
  if (t.plan !== "free") return { result: "unchanged", line: `${t.plan}, unchanged` };
  const failed = (w: string) => ({ result: "failed" as const, line: `free, NOT moved to payg (${w}): set plan payg and clear the evaluation key's expires_at by hand` });
  try {
    const k = await client.from("api_keys").select("id, expires_at").eq("tenant_id", t.id).is("revoked_at", null).is("deleted_at", null).order("created_at", { ascending: false }).limit(1);
    if (k.error || !Array.isArray(k.data)) return failed(`key read: ${k.error ? why(k.error) : "no rows array"}`);
    const key = k.data[0] as { id: string; expires_at: string | null } | undefined;
    let keyLine = key ? `key ${key.id} already had no expiry` : "no live key";
    if (key?.expires_at) {
      const u = await client.from("api_keys").update({ expires_at: null }).eq("id", key.id).eq("tenant_id", t.id).select("id");
      if (u.error) return failed(`key update: ${why(u.error)}`);
      if (!Array.isArray(u.data) || u.data.length !== 1) return failed(`key update: key ${key.id} of this tenant not found`);
      keyLine = `key ${key.id} no longer expires (it expired ${key.expires_at})`;
    }
    const watchLimit = Math.max(Number(t.watch_limit) || 0, PAYG_WATCH_LIMIT);
    const up = await client.from("tenants").update({ plan: "payg", watch_limit: watchLimit }).eq("id", t.id).eq("plan", "free").is("deleted_at", null).select("id");
    if (up.error) return failed(`plan update: ${why(up.error)}; ${keyLine}`);
    if (!Array.isArray(up.data) || up.data.length === 0) return { result: "unchanged", line: `no longer free when updated, unchanged; ${keyLine}` };
    return { result: "upgraded", line: `free -> payg (watch_limit ${watchLimit}); ${keyLine}` };
  } catch (e) { return failed(why(e)); }
}

// ---- refunds and disputes -------------------------------------------------------------------------------------------

async function onRefund(env: Env, ev: WhopEnvelope, now: number): Promise<EventAnswer> {
  const r = readRefund(ev.data);
  if ("error" in r) return notUnderstood(env, ev, "refund", r.error);
  // The money is back with the buyer only once the refund succeeded; refund.updated brings that status.
  if (r.status !== "succeeded") return { status: 200, result: "refund_not_succeeded", detail: { refund_id: r.id, payment_id: r.paymentId, status: r.status } };
  return reverse(env, { kind: "refund", id: r.id, paymentId: r.paymentId, partCents: r.partCents }, now);
}

async function onDispute(env: Env, ev: WhopEnvelope, now: number): Promise<EventAnswer> {
  const parsed = WhopDispute.safeParse(ev.data);
  if (!parsed.success) return notUnderstood(env, ev, "dispute", issues(parsed.error));
  const d = parsed.data;
  const ids = { dispute_id: d.id, payment_id: d.payment.id, status: d.status };
  if (d.inquiry || d.status.startsWith("warning_")) {
    await alert(env, `whop_dispute_inquiry_${d.id}`, `Whop dispute ${d.id} on payment ${d.payment.id} is an inquiry or an early alert (${d.status}): no money moved, so no credits were taken. A formal dispute that follows takes them.`, { dedupMinutes: ONCE, meta: ids });
    return { status: 200, result: "dispute_inquiry", detail: ids };
  }
  if (DISPUTE_REVERSES.has(d.status)) {
    return reverse(env, { kind: "dispute", id: d.id, paymentId: d.payment.id, partCents: usdCents(d.amount, d.currency) }, now);
  }
  if (DISPUTE_RETURNS.has(d.status)) {
    // The money stays with Resolve. Credits taken when the dispute opened stay taken: the operator decides.
    const requestId = reversalRequestIdFor("dispute", d.payment.id, d.id);
    let row: { tenant_id: string; delta: number } | null;
    try {
      const r = await db(env).from("credit_ledger").select("tenant_id, delta").eq("reason", "adjustment").eq("request_id", requestId).maybeSingle();
      if (r.error) return dbTrouble(env, `the reversal read for dispute ${d.id}`, r.error);
      row = (r.data as { tenant_id: string; delta: number } | null) ?? null;
    } catch (e) { return dbTrouble(env, `the reversal read for dispute ${d.id}`, e); }
    if (!row) {
      // Nothing was taken. Deliveries come in any order ([W1]): the settled marker keeps a dispute.created that arrives
      // after this ruling from taking the credits of a dispute the seller already won.
      try {
        const s = await db(env).rpc("rate_limit_hit", { p_key: settledKey(requestId), p_window_ms: SETTLED_MS, p_limit: 1 });
        if (s.error) log({ outcome: "settled_marker_failed", dispute_id: d.id, error: why(s.error) });
      } catch (e) { log({ outcome: "settled_marker_failed", dispute_id: d.id, error: why(e) }); }
      return { status: 200, result: "dispute_closed", detail: ids };
    }
    await alert(env, `whop_dispute_${d.status}_${d.id}`, `Whop dispute ${d.id} on payment ${d.payment.id} ended ${d.status}: the money stays with Resolve. ${-row.delta} credits were taken from tenant ${row.tenant_id} when it opened and stay taken. To give them back: grant_credits('${row.tenant_id}', ${-row.delta}, 'Whop dispute ${d.id} ${d.status}: credits restored', 'whop-dispute-${d.status}:${d.payment.id}:${d.id}').`, { dedupMinutes: ONCE, meta: { ...ids, tenant_id: row.tenant_id, credits: -row.delta } });
    return { status: 200, result: "dispute_closed", detail: { ...ids, tenant_id: row.tenant_id } };
  }
  await alert(env, `whop_dispute_status_${d.id}_${d.status.slice(0, 40)}`, `Whop dispute ${d.id} on payment ${d.payment.id} has status ${d.status}, which this code does not act on: no credits were taken. Check it in Whop.`, { dedupMinutes: ONCE, meta: ids });
  return { status: 200, result: "dispute_status_unknown", detail: ids };
}

interface Reversal {
  kind: "refund" | "dispute";
  id: string;
  paymentId: string;
  /** The amount refunded or disputed, in US cents (null: not given, or in another currency): its share of the pack's price. */
  partCents: number | null;
}

/**
 * Run `run` holding the payment, so its events (the grant, refunds, disputes) run one at a time: 409 for Whop to retry
 * while another holds it. The hold is let go at the end; a release that fails lapses after HOLD_MS.
 */
async function held(env: Env, client: Db, paymentId: string, ids: Record<string, unknown>, run: () => Promise<EventAnswer>): Promise<EventAnswer> {
  let got: boolean;
  try {
    const { data, error } = await client.rpc("rate_limit_hit", { p_key: holdKey(paymentId), p_window_ms: HOLD_MS, p_limit: 1 });
    if (error) return dbTrouble(env, `the hold on payment ${paymentId}`, error);
    const row = (Array.isArray(data) ? data[0] : data) as { allowed?: unknown } | null;
    if (!row || typeof row.allowed !== "boolean") return dbTrouble(env, `the hold on payment ${paymentId}`, "rate_limit_hit answered without allowed");
    got = row.allowed;
  } catch (e) { return dbTrouble(env, `the hold on payment ${paymentId}`, e); }
  if (!got) return { status: 409, result: "busy", message: "another event of this payment is being processed; retry", detail: ids };
  try {
    return await run();
  } finally {
    try {
      const { error } = await client.from("rate_limit_buckets").update({ count: 0, reset_at: RELEASED }).eq("key", holdKey(paymentId));
      if (error) log({ outcome: "hold_release_failed", payment_id: paymentId, error: why(error) });
    } catch (e) { log({ outcome: "hold_release_failed", payment_id: paymentId, error: why(e) }); }
  }
}

/** Take back a refund's or dispute's credits, holding the payment so its events run one at a time. */
async function reverse(env: Env, o: Reversal, now: number): Promise<EventAnswer> {
  const client = db(env);
  const ids = { payment_id: o.paymentId, [`${o.kind}_id`]: o.id };
  return held(env, client, o.paymentId, ids, () => reverseHeld(env, client, o, ids, now));
}

async function reverseHeld(env: Env, client: Db, o: Reversal, ids: Record<string, unknown>, now: number): Promise<EventAnswer> {
  const requestId = reversalRequestIdFor(o.kind, o.paymentId, o.id);
  const done = (): EventAnswer => ({ status: 200, result: "already_processed", detail: ids });
  try {
    // 1. what the payment granted, and to whom
    const g = await client.from("credit_ledger").select("tenant_id, delta").eq("reason", "grant").eq("request_id", grantRequestIdFor(o.paymentId)).maybeSingle();
    if (g.error) return dbTrouble(env, `the grant read for payment ${o.paymentId}`, g.error);
    if (!g.data) {
      // The payment's own payment.succeeded may still come: answered 503 and retried with the same payload, or delivered
      // late ([W1]). This marker stops its automatic grant, so credits are never granted for money that went back; a
      // marker that cannot be written refuses this event for Whop to retry.
      const s = await client.rpc("rate_limit_hit", { p_key: reversedFirstKey(o.paymentId), p_window_ms: SETTLED_MS, p_limit: 1 });
      if (s.error) return dbTrouble(env, `the refund marker of payment ${o.paymentId}`, s.error);
      await alert(env, `whop_nogrant_${requestId}`, `Whop ${o.kind} ${o.id} of payment ${o.paymentId}: Resolve granted nothing for that payment (not a Resolve pack, never matched, or its payment.succeeded is not processed yet), so nothing was taken back. Its payment.succeeded, if it comes within 20 days, grants nothing automatically and is alerted for a decision by hand. A payment credited by hand later must take this ${o.kind} into account: grant_credits('<tenant id>', -<credits>, 'Whop ${o.kind} ${o.id}', '${requestId}').`, { dedupMinutes: ONCE, meta: ids });
      return { status: 200, result: "no_grant", detail: ids };
    }
    const tenantId = String((g.data as { tenant_id: unknown }).tenant_id);
    const granted = Number((g.data as { delta: unknown }).delta);

    // 2. what earlier reversals of the payment took, and whether this one already ran: read by the payment's request_id
    // pattern, never from a window of the tenant's ledger that older rows could fill. "_" in a payment id matches any one
    // character in LIKE, so the pattern only narrows the read; the prefix test below is exact.
    const prior = await client.from("credit_ledger").select("delta, request_id").eq("tenant_id", tenantId).eq("reason", "adjustment").like("request_id", `whop-%:${o.paymentId}:%`).limit(1000);
    if (prior.error || !Array.isArray(prior.data)) return dbTrouble(env, `the reversal read for payment ${o.paymentId}`, prior.error ?? "no rows array");
    const mine = (prior.data as Array<{ delta: number; request_id: string | null }>).filter((r) => typeof r.request_id === "string" && (r.request_id.startsWith(`whop-refund:${o.paymentId}:`) || r.request_id.startsWith(`whop-dispute:${o.paymentId}:`)));
    if (mine.some((r) => r.request_id === requestId)) return done();
    const marker = await client.from("rate_limit_buckets").select("key, reset_at").eq("key", settledKey(requestId)).maybeSingle();
    if (marker.error) return dbTrouble(env, `the settled marker read for ${o.kind} ${o.id}`, marker.error);
    const m = marker.data as { reset_at: string } | null;
    if (m && Date.parse(m.reset_at) > now) return done();
    const takenBefore = mine.reduce((s, r) => s - Number(r.delta), 0);
    const share = reversalCredits(granted, o.partCents, packPriceFor(granted));
    const want = Math.max(0, Math.min(share.credits, granted - takenBefore));

    // 3. at most the balance: the ledger never goes below zero. A charge between the read and the write is read again once.
    let take = 0, balanceBefore: number | null = null, balanceAfter: number | null = null, deleted = false;
    for (let attempt = 0; attempt < 2 && want > 0; attempt++) {
      const t = await client.from("tenants").select("credits_balance, deleted_at").eq("id", tenantId).maybeSingle();
      if (t.error) return dbTrouble(env, `the balance read of tenant ${tenantId}`, t.error);
      const row = t.data as { credits_balance: number; deleted_at: string | null } | null;
      if (!row || row.deleted_at) { deleted = true; take = 0; break; }
      balanceBefore = Math.max(0, Number(row.credits_balance) || 0);
      take = Math.min(want, balanceBefore);
      if (take === 0) break;
      const r = await client.rpc("grant_credits", { p_tenant: tenantId, p_amount: -take, p_note: `Whop ${o.kind} ${o.id} of payment ${o.paymentId}: ${take} of the ${granted} credits it bought taken back${share.proportional ? " (its share of the payment)" : ""}`, p_request_id: requestId });
      if (!r.error) { balanceAfter = Number(r.data); break; }
      if (r.error.code === "23505") return done();
      if (r.error.code === "23514" && attempt === 0) { take = 0; continue; }
      return dbTrouble(env, `grant_credits for ${o.kind} ${o.id}`, r.error);
    }
    if (want > 0 && take > 0 && balanceAfter === null) return dbTrouble(env, `grant_credits for ${o.kind} ${o.id}`, "the balance kept changing");
    const shortfall = want - take;

    // 4. nothing written: a marker keeps a repeat of this event a no-op while Whop can still redeliver it
    let markerLine = "";
    if (take === 0) {
      try {
        const s = await client.rpc("rate_limit_hit", { p_key: settledKey(requestId), p_window_ms: SETTLED_MS, p_limit: 1 });
        if (s.error) markerLine = ` (its no-op marker was not recorded: ${why(s.error)}; a repeat of this event is evaluated again)`;
      } catch (e) { markerLine = ` (its no-op marker was not recorded: ${why(e)}; a repeat of this event is evaluated again)`; }
    }

    const lines = [
      `Card ${o.kind} (Whop): ${take} credits taken back from tenant ${tenantId}`,
      `Whop ${o.kind} ${o.id} of payment ${o.paymentId}: the payment granted ${granted}; earlier refunds and disputes took ${takenBefore}; this one's share is ${share.credits}${share.proportional ? " (proportional to the amount)" : " (all of it)"}.`,
      want === 0 ? `Nothing left to take: the payment's credits were already taken back.${markerLine}` : null,
      shortfall > 0 ? `SHORTFALL: ${shortfall} credits could not be taken back: ${deleted ? "the tenant is deleted" : `the balance was ${balanceBefore}`}. The ledger never goes below zero; the buyer used them. Decide by hand.${markerLine}` : null,
      `Balance now: ${balanceAfter ?? balanceBefore ?? "unknown"}`,
    ].filter(Boolean).join("\n");
    await alert(env, `whop_reversal_${requestId}`.slice(0, 200), lines, { dedupMinutes: ONCE, meta: { ...ids, tenant_id: tenantId, kind: o.kind, granted, taken_before: takenBefore, share: share.credits, credits: take, shortfall, balance_after: balanceAfter ?? balanceBefore } });
    return { status: 200, result: take > 0 ? (shortfall > 0 ? "reversed_with_shortfall" : "reversed") : want === 0 ? "nothing_left" : "shortfall", detail: { ...ids, tenant_id: tenantId, credits: take, shortfall } };
  } catch (e) {
    return dbTrouble(env, `the ${o.kind} ${o.id} of payment ${o.paymentId}`, e);
  }
}

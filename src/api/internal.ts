import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { parseConfig } from "../env";
import { ok, err, waitUntilOf } from "./envelope";
import { safeEqual, bearer } from "./admin";
import { verifyDispatchSignature } from "./dispatch-auth";
import { runWatch } from "../ingest/watch";
import { registerMarket } from "../markets/register";
import { registrationRefused } from "./registration";
import { redact } from "../ops/redact";
import { mergeMeta, META_KEYS } from "../markets/meta";
import { db, rpc } from "../db/supabase";
import { makeJevCaller } from "../jev/client";
import { mintKey } from "./keys";
import { runReconcile } from "../jobs/reconcile";
import { runLimitlessRecorder } from "../jobs/limitless-recorder";
import { scanDeposits } from "../jobs/deposits";
import { drainWebhooks, publishEvent } from "../webhooks/deliver";
import { alert } from "../ops/alerts";
import { Budget, INVOCATION_SUBREQUESTS } from "../ops/budget";
import { OfficialSeries } from "../resolve/schema";
import { CorroborationStatus, hostAllowed, type OfficialCorroboration } from "../resolve/official";
import { PROBE_GROUPS, PROBE_SERIES, probePlan, probeRefusal, runOfficialProbe } from "../ingest/official-probe";
import { MatchBody, MatchRow, matchRefusal } from "../billing/match";
import { paymentCreditedPayload } from "../billing/events";
import { formatUsdc, parseUsdc } from "../billing/tiers";
import { publicBase } from "../billing/top-up";

type Vars = { requestId: string; schemaVersion: string };
export const internal = new Hono<{ Bindings: Env; Variables: Vars }>();

const isAdmin = (c: { req: { header: (n: string) => string | undefined }; env: Env }) => { const k = bearer(c as never); return !!k && safeEqual(k, c.env.ADMIN_API_KEY); };

/**
 * A pg_net dispatch signed for `id` (src/api/dispatch-auth.ts: HMAC over "<id>|<minute>", +-3 min; with opts.seconds a
 * redispatch's stamp to the second is accepted too, migration 024), or the admin bearer for a manual run. null =
 * authorized; otherwise the 403 to answer.
 */
async function dispatchDenied(c: Context<{ Bindings: Env; Variables: Vars }>, id: string, opts: { seconds?: boolean } = {}): Promise<Response | null> {
  if (isAdmin(c)) return null;
  const v = await verifyDispatchSignature(c.env.INTERNAL_HMAC_SECRET, id, c.req.header("x-internal-signature"), c.req.header("x-internal-minute"), Date.now(), opts);
  if (v.ok) return null;
  return err(c, "forbidden", v.reason === "invalid" ? "invalid internal signature" : "bad or stale internal signature", 403);
}

/** claim_watch_dispatch's answer (migration 019). */
const DispatchClaim = z.enum(["claimed", "signature_used", "watch_not_found", "lease_missing", "lease_expired", "lease_superseded"]);
const DISPATCH_REFUSAL: Record<Exclude<z.infer<typeof DispatchClaim>, "claimed">, { status: 404 | 409; message: string }> = {
  signature_used: { status: 409, message: "signature already used" },
  watch_not_found: { status: 404, message: "watch not found" },
  lease_missing: { status: 409, message: "watch not leased: this dispatch is not the current one" },
  lease_expired: { status: 409, message: "watch lease expired: this dispatch arrived after its 120 s lease" },
  lease_superseded: { status: 409, message: "watch leased again since this dispatch's minute: a later dispatch or a tenant fetch holds it" },
};

/**
 * pg_net -> one watch poll. The signature is checked by dispatchDenied (HMAC over "<watch_id>|<YYYY-MM-DDTHH:MM>", +-3 min
 * tolerance; a redispatch of an official release's legs, redispatch_official_legs in migration 024, signs a stamp to the
 * second, "<watch_id>|<YYYY-MM-DDTHH:MM:SS>"). A valid signature is then claimed once (claim_watch_dispatch, migrations
 * 019/024): the (watch_id, stamp) row is inserted first, before any work, so a replayed or duplicated request is refused
 * (409) and two runs of one dispatch can never both resolve or charge; and the watch must hold the lease its dispatch
 * took at the signed time (null = already polled or never leased, past = the request came too late, taken after that =
 * a later dispatch or a tenant fetch is the current run); a claim holds the lease for the run. Refusals answer >= 400,
 * so dispatch_failures() (migration 013) counts them and the 10-minute job alerts. An admin bearer runs the poll by hand,
 * bypassing both checks; that run is marked dispatch=admin in its loop_runs row.
 * Subrequests: the claim is one of the invocation's 50 (Workers Free), counted in the official_release slot holder's
 * worst case (src/ingest/official-watch.ts, "Subrequests per invocation"): with this route's waitUntil, 26 before alerts
 * (51 in the theoretical worst case of every alert of a CPI capture at once, the last alert being the one that fails),
 * and an inline commit reserves its share inside INVOCATION_SUBREQUESTS before it starts (inlinePlan) or does not run.
 */
internal.post("/watch/:id", async (c) => {
  const id = c.req.param("id");
  const admin = isAdmin(c);
  if (!admin) {
    const denied = await dispatchDenied(c, id, { seconds: true });
    if (denied) return denied;
    const minute = c.req.header("x-internal-minute") ?? "";
    // Only select_due_watches() signs, and it signs real watch ids; anything else never reaches the database.
    if (!z.uuid().safeParse(id).success) return err(c, "validation_error", "watch id is not a uuid", 400);
    let claim: z.infer<typeof DispatchClaim>;
    try { claim = DispatchClaim.parse(await rpc(db(c.env), "claim_watch_dispatch", { p_watch: id, p_minute: minute })); }
    catch (e) {
      // Could not record the signature: running anyway would make a replay undetectable. Fail closed; pg_net's answer
      // row makes it visible to dispatch_failures(), and the watch is due again at its next_poll_at.
      return err(c, "UPSTREAM_UNAVAILABLE", `dispatch claim failed, the poll did not run: ${redact(String(e)).slice(0, 200)}`, 503);
    }
    if (claim !== "claimed") {
      const r = DISPATCH_REFUSAL[claim];
      return err(c, r.status === 404 ? "not_found" : "conflict", r.message, r.status);
    }
  } else {
    console.log(JSON.stringify({ job: "watch_dispatch", dispatch: "admin", watch_id: id, note: "manual run: lease and single-use signature not checked" }));
  }
  const cfg = parseConfig(c.env);
  const s = await runWatch(c.env, cfg, id, { waitUntil: waitUntilOf(c), dispatch: admin ? "admin" : "pg_net", base: publicBase(c.env, c.req.url) });
  // pg_net stores this status in net._http_response and dispatch_failures() (migration 013) counts >= 400 as a poll that
  // did not happen. A run that recorded its outcome, 'failure' included (a source error, alerted by the runner's own
  // transition and streak logic), is a delivered dispatch; only a run that could not record itself (loop_runs row or
  // watch bookkeeping) answers 500.
  return ok(c, s, s.recorded === false ? 500 : 200);
});

/** The id dispatch_internal('limitless_record') signs with (migration 018): a watch signature never opens this route. */
export const LIMITLESS_RECORD_ID = "limitless_record";

/**
 * pg_net -> one Limitless recorder run (dispatch_internal, every 10 min; src/jobs/limitless-recorder.ts). Like a watch
 * poll, a run that recorded its loop_runs row answers 200 whatever its outcome (failures are alerted by the recorder's
 * own streak); only a run that could not record itself answers 500, which dispatch_failures() (migration 013) counts.
 * The run's alert goes out under waitUntil, after the answer: pg_net hangs up at 30 s.
 */
internal.post("/limitless/record", async (c) => {
  const denied = await dispatchDenied(c, LIMITLESS_RECORD_ID);
  if (denied) return denied;
  const r = await runLimitlessRecorder(c.env, { waitUntil: waitUntilOf(c) });
  return ok(c, r, r.recorded ? 200 : 500);
});

/**
 * Admin registration (scripts/seed-shadow.ts, plan §16.4 P5). Strict at the top level, so a misspelled "is_test" is a 400
 * rather than a real market on the public record; inside meta, keys outside the whitelist (src/markets/meta.ts) are
 * dropped and reported in meta_dropped. 201 for a new market, 200 when (tenant, platform, external_id) already existed
 * (nothing written: existing, meta_applied [] and the stored is_test say so). A body error answers with the accepted
 * fields and meta keys: seed-shadow sends an empty body first and refuses to register through a Worker whose whitelist
 * differs from its own (an older Worker would store the market and silently drop its meta).
 */
const InternalMarketBody = z.strictObject({
  market: z.unknown().refine((v) => v !== undefined && v !== null, "required"),
  tenant_id: z.uuid().nullish(),
  meta: z.unknown().optional(),
  is_test: z.boolean().optional(),
});

internal.post("/markets", async (c) => {
  if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403);
  const cfg = parseConfig(c.env);
  const body = InternalMarketBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    const message = body.error.issues.map((i) => `body${i.path.length ? "." + i.path.join(".") : ""}: ${i.message}`).join("; ").slice(0, 400);
    return err(c, "validation_error", message, 400, { extra: { accepted_fields: Object.keys(InternalMarketBody.shape), meta_keys: META_KEYS } });
  }
  const meta = mergeMeta(body.data.meta);
  if (!meta.ok) return err(c, "validation_error", `body.meta: ${meta.error}`.slice(0, 400), 400);
  try {
    const r = await registerMarket(c.env, cfg, body.data.market, body.data.tenant_id ?? null, { meta: meta.meta, isTest: body.data.is_test ?? false });
    return ok(c, { market_id: r.marketId, status: r.status, reasons: r.reasons, watches: r.watches, existing: r.existing, is_test: r.isTest, meta_applied: r.metaApplied, meta_dropped: meta.dropped }, r.existing ? 200 : 201);
  } catch (e) {
    return registrationRefused(c, e);
  }
});

internal.get("/markets/:id", async (c) => {
  if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403);
  const client = db(c.env);
  const id = c.req.param("id");
  const [m, w, e, r, l] = await Promise.all([
    client.from("markets").select("*").eq("id", id).single(),
    client.from("watches").select("id, source_kind, source_ref, poll_interval_s, next_poll_at, lease_until, etag, cursor, coverage, last_evidence_hash, last_canonical_hash, last_http_status, last_polled_at, last_error, consecutive_errors, backlog").eq("market_id", id),
    client.from("evidence").select("id, source_kind, source_url, observed_at, claimed_at, fetched_at, http_status, raw_sha256, canonical_sha256, raw_bytes, raw_r2_key, coverage, injection_markers, created_at").eq("market_id", id).order("created_at", { ascending: false }).limit(5),
    client.from("resolutions").select("id, mode, status_row, resolution_status, winning_outcome, confidence_score, error_code, error_reason, caveats, determination_basis, jev_model, thresholds_version, credits_charged, duration_ms, jev_ms, created_at").eq("market_id", id).order("created_at", { ascending: false }).limit(5),
    client.from("loop_runs").select("started_at, outcome, rows_written, duration_ms, error, meta").eq("loop_name", "watch").contains("meta", { market_id: id }).order("started_at", { ascending: false }).limit(5),
  ]);
  if (m.error) return err(c, "not_found", m.error.message, 404);
  return ok(c, { market: m.data, watches: w.data ?? [], evidence: e.data ?? [], resolutions: r.data ?? [], loop_runs: l.data ?? [] });
});

/** Founder-only tenant onboarding for the first 90 days: create a tenant and its first key (raw key shown once). */
internal.post("/tenants", async (c) => {
  if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403);
  const b = (await c.req.json().catch(() => ({}))) as { display_name?: string; contact?: string; wallet_address?: string; plan?: string; credits?: number; environment?: "live" | "test"; strict_v0?: boolean; watch_limit?: number };
  if (!b.display_name) return err(c, "validation_error", "display_name required", 400);
  const client = db(c.env);
  const { data: t, error } = await client.from("tenants").insert({ display_name: b.display_name, contact: b.contact ?? null, wallet_address: b.wallet_address ? b.wallet_address.toLowerCase() : null, plan: b.plan ?? "free", strict_v0: !!b.strict_v0, watch_limit: b.watch_limit ?? 5 }).select("id").single();
  if (error || !t) return err(c, "validation_error", error?.message ?? "tenant insert failed", 400);
  if (b.credits && b.credits > 0) await rpc(client, "grant_credits", { p_tenant: t.id, p_amount: b.credits, p_note: "onboarding grant" });
  const key = await mintKey(b.environment ?? "test");
  const { data: k, error: ke } = await client.from("api_keys").insert({ tenant_id: t.id, key_hash: key.hash, key_prefix: key.prefix, name: "initial", environment: b.environment ?? "test", daily_cap: 1000 }).select("id").single();
  if (ke || !k) return err(c, "internal_error", ke?.message ?? "key insert failed", 500);
  return ok(c, { tenant_id: t.id, key_id: k.id, key: key.raw, note: "Shown once." }, 201);
});

const RecheckBody = z.object({
  series: OfficialSeries,
  period: z.string().regex(/^\d{4}-(?:\d{2}(?:-\d{2})?|Q[1-4])$/),
  corroboration: z.object({
    status: CorroborationStatus,
    source_url: z.string().url().nullable().default(null),
    value_text: z.string().regex(/^[+-]?\d+(?:\.\d+)?$/).nullable().default(null),
    detail: z.string().min(1).max(500),
  }),
  actor: z.string().min(1).max(120),
  reason: z.string().min(8).max(2000),
});

/**
 * The audited way out of sources_disagree (migration 016 recheck_official_corroboration): an operator who checked the
 * second source again supersedes the stored corroboration. The previous value is appended to
 * official_corroboration_history first; the first print itself is never touched. The legs re-resolve on their next
 * poll (the change projection includes the corroboration status); POST /internal/watch/:id runs one at once.
 */
internal.post("/official/recheck", async (c) => {
  if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403);
  const parsed = RecheckBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "validation_error", parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 400), 400);
  const b = parsed.data;
  if (b.corroboration.source_url && !hostAllowed(b.series, b.corroboration.source_url)) return err(c, "validation_error", `corroboration.source_url must be an https URL on the ${b.series} allowlist`, 400);
  const corroboration: OfficialCorroboration = {
    status: b.corroboration.status, source_url: b.corroboration.source_url, value: b.corroboration.value_text === null ? null : Number(b.corroboration.value_text),
    value_text: b.corroboration.value_text, detail: b.corroboration.detail, checked_at: new Date().toISOString(),
  };
  try {
    const row = await rpc<Record<string, unknown>>(db(c.env), "recheck_official_corroboration", { p_series: b.series, p_period: b.period, p_corroboration: corroboration, p_actor: `admin_api:${b.actor}`, p_reason: b.reason });
    await alert(c.env, `official_recheck_${b.series}_${b.period}`, `${b.series} ${b.period}: corroboration re-checked by ${b.actor} to ${corroboration.status}${corroboration.value_text ? ` (${corroboration.value_text})` : ""}. Reason: ${b.reason}`, { dedupMinutes: 1, meta: { series: b.series, period: b.period, recheck_id: row.recheck_id ?? null } });
    return ok(c, row);
  } catch (e) {
    return err(c, "validation_error", String(e).slice(0, 400), 400);
  }
});

const ProbeBody = z.strictObject({
  group: z.enum(PROBE_GROUPS).optional(),
  series: z.array(OfficialSeries).min(1).max(PROBE_SERIES.length).optional(),
  corroboration: z.boolean().optional(),
}).refine((b) => !(b.group && b.series), "give group or series, not both")
  .refine((b) => !b.series || b.series.every((s) => PROBE_SERIES.includes(s)), "election series are not probed one by one: give group elections (the TSE and Élections Québec hosts)")
  .refine((b) => b.group !== undefined || b.series !== undefined, `give group (${PROBE_GROUPS.join(" | ")}) or series: one group per call stays under the 10 ms CPU limit`);

/**
 * Which official sources (and election hosts) answer THIS Worker (src/ingest/official-probe.ts; runbook
 * docs/runbooks/official-probe.md). For each series the rail's own requests for the latest published period, through
 * officialGet (allowlist, ResolveBot UA, timeouts), the rail's parser on the answer, and the corroboration fetch; per
 * request: host, path (no query), status, bytes (or the Content-Length of a dropped body), content-type, server, ms,
 * redirects, and what the parser read. Error and detail texts show a URL as host + path, never its query.
 * No database, no alert, no R2: the answer is the only output. Body (JSON): group "bls" | "central_banks" |
 * "elections", or series [ids]; exactly one of the two is required (an empty body is refused: all groups in one call
 * are over the 10 ms CPU limit). corroboration false skips the corroborating requests (BLS API v1 allows 25 key-less
 * queries a day: the bls group spends 7, and none on the ET day of a scheduled BLS release). Every call is capped at
 * PROBE_MAX_SUBREQUESTS (40) subrequests, redirect hops included; a plan that could need more is refused.
 */
internal.post("/official/probe", async (c) => {
  if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403);
  const text = await c.req.text().catch(() => "");
  let json: unknown = {};
  if (text.trim()) { try { json = JSON.parse(text); } catch { return err(c, "validation_error", "body is not JSON", 400); } }
  const parsed = ProbeBody.safeParse(json);
  if (!parsed.success) return err(c, "validation_error", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ").slice(0, 400), 400, { extra: { groups: PROBE_GROUPS } });
  const plan = probePlan(parsed.data);
  const refused = probeRefusal(plan);
  if (refused) return err(c, "validation_error", refused, 400, { extra: { groups: PROBE_GROUPS } });
  const report = await runOfficialProbe(plan);
  const colo = (c.req.raw as Request & { cf?: { colo?: string } }).cf?.colo ?? null;
  console.log(JSON.stringify({ job: "official_probe", colo, groups: plan.groups, used: report.subrequests.used, hosts: Object.fromEntries(Object.entries(report.hosts).map(([h, s]) => [h, s.statuses])) }));
  return ok(c, { colo, ...report });
});

internal.post("/reconcile", async (c) => { if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403); return ok(c, await runReconcile(c.env)); });
// Its own invocation and the scan never throws, so it gets every subrequest: the way past a block too big for the cron's share.
internal.post("/deposits/scan", async (c) => { if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403); return ok(c, await scanDeposits(c.env, parseConfig(c.env), new Budget(INVOCATION_SUBREQUESTS))); });
/**
 * Credit an unmatched USDC deposit to the tenant that sent it (migration 020 match_deposit; plan §16.4 P3 step 3): the
 * sender wallet was not registered, so the scan recorded it 'unmatched' and alerted deposit_unmatched. Only an unmatched
 * deposit is matched, at the tier rate for its amount, once: a retry answers the same row with replayed=true and writes,
 * alerts and emits nothing. A new match alerts the operator (every manual credit is on the record, not only in the
 * database) and sends payment.credited to the tenant. Subrequests: the RPC, the alert (5), and payment.credited queued
 * with its first attempt under waitUntil (2 + 14), 22 of the invocation's 50.
 */
internal.post("/deposits/match", async (c) => {
  if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403);
  const parsed = MatchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "validation_error", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ").slice(0, 400), 400);
  const b = parsed.data;
  const tx = b.tx_hash.toLowerCase();
  const who = `admin_api:${b.actor}`;
  const { data, error } = await db(c.env).rpc("match_deposit", { p_tx_hash: tx, p_log_index: b.log_index, p_tenant: b.tenant_id, p_actor: who, p_reason: b.reason });
  if (error) {
    const r = matchRefusal(error.code);
    return err(c, r.code, `match_deposit: ${redact(error.message)}`.slice(0, 400), r.status);
  }
  const row = MatchRow.safeParse(Array.isArray(data) ? data[0] : data);
  if (!row.success) {
    // The transaction may have committed: a retry reads the match back (replayed) and never credits twice.
    await alert(c.env, `deposit_match_unreadable_${tx}_${b.log_index}`, `match_deposit answered ${redact(JSON.stringify(data)).slice(0, 300)} for ${tx}#${b.log_index} (tenant ${b.tenant_id}); the match may be recorded. Retry POST /internal/deposits/match to read it back.`, { dedupMinutes: 60 });
    return err(c, "internal_error", "match_deposit answered an unreadable row; the match may be recorded: retry to read it back (a retry never credits twice)", 500);
  }
  const m = row.data;
  const amount = formatUsdc(parseUsdc(m.amount_usdc));
  let queued: number | null = null;
  if (!m.replayed) {
    await alert(c.env, `deposit_matched_${tx}_${b.log_index}`, `Deposit ${tx}#${b.log_index} (${amount} USDC) matched by ${b.actor} to tenant ${m.tenant_id}: ${m.credits} credits at ${m.credits_per_usdc} credits/USDC, balance now ${m.balance_after}. Reason: ${b.reason}`, { dedupMinutes: 1440, meta: { tx_hash: tx, log_index: b.log_index, tenant_id: m.tenant_id, credits: m.credits, actor: who } });
    queued = (await publishEvent(c.env, m.tenant_id, "payment.credited", paymentCreditedPayload({ tx_hash: tx, log_index: b.log_index, amount_usdc: amount, credits: m.credits, balance_after: m.balance_after }), { waitUntil: waitUntilOf(c) })).queued;
  }
  return ok(c, { tx_hash: tx, log_index: b.log_index, ...m, amount_usdc: amount, payment_event: m.replayed ? "not sent again: the deposit was already credited to this tenant" : `queued for ${queued} endpoint(s)` });
});
internal.post("/webhooks/drain", async (c) => { if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403); return ok(c, await drainWebhooks(c.env, 10)); });

/** Read the R2 diagnostics the scheduled handler writes when an insert fails. */
internal.get("/diag", async (c) => {
  if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403);
  const list = await c.env.BACKUPS.list({ prefix: "diag/", limit: 20 });
  const keys = list.objects.map((o) => o.key).sort().reverse();
  const latest = keys[0] ? await (await c.env.BACKUPS.get(keys[0]))?.text() : null;
  return ok(c, { count: keys.length, keys: keys.slice(0, 10), latest });
});

/** GitHub Actions posts eval summaries here with the scoped insert-only key. */
internal.post("/eval-report", async (c) => {
  const k = bearer(c);
  if (!k || !safeEqual(k, c.env.EVAL_REPORT_KEY)) return err(c, "forbidden", "eval report key required", 403);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return err(c, "validation_error", "json body required", 400);
  try {
    const id = await rpc<number>(db(c.env), "report_eval_run", { p: body });
    return ok(c, { id }, 201);
  } catch (e) { return err(c, "validation_error", String(e).slice(0, 300), 400); }
});

/** Latency benchmark from this Worker's colo: N fixed 3k-token probes; writes bench_runs. */
/**
 * One-time Telegram wiring check, run from the Worker because api.telegram.org is unreachable from the founder's network.
 * Sets the bot description, confirms the bot can post in the channel, sends one operator DM, and posts + pins the
 * channel disclaimer (only when the channel has no pinned message yet). Idempotent; never prints the token.
 */
internal.post("/bot/setup", async (c) => {
  if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403);
  const tok = c.env.TELEGRAM_BOT_TOKEN, ch = c.env.TELEGRAM_CHANNEL_ID, op = c.env.TELEGRAM_OPERATOR_CHAT_ID;
  if (!tok || !ch) return err(c, "config_error", "TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID unset", 400);
  const api = async (m: string, body: Record<string, unknown> = {}) => {
    const r = await fetch(`https://api.telegram.org/bot${tok}/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    return (await r.json()) as { ok: boolean; result?: any; description?: string };
  };
  const out: Record<string, unknown> = {};
  const me = await api("getMe"); out.bot = me.ok ? `@${me.result.username}` : me.description;
  if (!me.ok) return ok(c, out, 502);
  const disc = "Automated shadow settlements for long-tail prediction markets. Every verdict is committed by hash before the official outcome and revealed after. Informational signal, not financial advice, not an oracle of record.";
  out.description_set = (await api("setMyDescription", { description: disc })).ok;
  out.short_description_set = (await api("setMyShortDescription", { short_description: "Commit-reveal shadow settlements for long-tail prediction markets. Not financial advice." })).ok;
  const chat = await api("getChat", { chat_id: ch }); out.channel = chat.ok ? { title: chat.result.title, id: chat.result.id, username: chat.result.username ?? null, invite_link: chat.result.invite_link ?? null, pinned: chat.result.pinned_message?.message_id ?? null } : chat.description;
  const adm = await api("getChatMember", { chat_id: ch, user_id: me.result.id }); out.bot_membership = adm.ok ? { status: adm.result.status, can_post: adm.result.can_post_messages ?? null } : adm.description;
  if (op) { const dm = await api("sendMessage", { chat_id: op, text: "Resolve operator alerts are wired. One-time test from the settle-bot." }); out.operator_dm = dm.ok ? "sent" : dm.description; }
  if (chat.ok && !chat.result.pinned_message) {
    const text = `Resolve Settlement Feed\n\nThis channel publishes automated shadow settlements for long-tail prediction markets. Each verdict is posted first as a commitment hash before the market's official outcome, then revealed in a reply once the official resolution lands, so every call can be checked after the fact and none can be edited.\n\nInformational signal only. Not financial advice. Not an oracle of record.\n\nTrack record: ${c.env.RESOLVE_PUBLIC_URL ?? ""}/v1/track-record`;
    const post = await api("sendMessage", { chat_id: ch, text, disable_web_page_preview: true });
    out.disclaimer_post = post.ok ? post.result.message_id : post.description;
    if (post.ok) out.pinned = (await api("pinChatMessage", { chat_id: ch, message_id: post.result.message_id, disable_notification: true })).ok;
  }
  return ok(c, out);
});

internal.post("/bench", async (c) => {
  if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403);
  const cfg = parseConfig(c.env);
  if (!c.env.TYPESAFE_API_KEY) return err(c, "UPSTREAM_UNAVAILABLE", "TYPESAFE_API_KEY not configured", 503);
  const n = Math.min(50, Math.max(3, Number(c.req.query("n") ?? "20")));
  const caller = makeJevCaller({ apiKey: c.env.TYPESAFE_API_KEY, timeoutMs: cfg.jevTimeoutMs * 2 });
  const filler = "The maintainers merged the change after review and the release shipped the same day. ".repeat(120);
  const lat: number[] = [];
  let model = cfg.jevModel;
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    try {
      const r = await caller({ model: cfg.jevModel, state: { market: { event_statement: "The pull request is merged", option_a: "Yes", option_b: "No" }, evidence: { source_kind: "web", delimiter: "bench", note: "benchmark", windows: [filler + ` probe ${i}`] } }, questions: { outcome: { type: "choice", instructions: "Which option the evidence establishes", criteria: { OPTION_A: "Yes", OPTION_B: "No", NOT_DETERMINABLE: "Neither" } }, same_subject: { type: "noul", instructions: "Same subject?" } } });
      model = String((r.json as { model?: string }).model ?? model);
      lat.push(Date.now() - t0);
    } catch (e) { return err(c, "UPSTREAM_UNAVAILABLE", `probe ${i} failed: ${String(e).slice(0, 200)}`, 503); }
  }
  const s = [...lat].sort((a, b) => a - b);
  const p50 = s[Math.floor(s.length / 2)]!, p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!, max = s[s.length - 1]!;
  const colo = ((c.req.raw as Request & { cf?: { colo?: string } }).cf?.colo) ?? null;
  const { error } = await db(c.env).from("bench_runs").insert({ runner: "cf_worker", colo, n, p50_ms: p50, p95_ms: p95, max_ms: max, jev_model: model, git_sha: cfg.gitSha, meta: { latencies: lat } });
  if (error) return err(c, "internal_error", error.message, 500);
  return ok(c, { runner: "cf_worker", colo, n, p50_ms: p50, p95_ms: p95, max_ms: max, model });
});

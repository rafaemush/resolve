import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { parseConfig } from "../env";
import { ok, err, requestId, waitUntilOf } from "./envelope";
import { authenticate, rateLimit, extractApiKey, invalidateKeyCache, type AuthContext } from "./auth";
import { db, rpc, type Db } from "../db/supabase";
import { MarketRegistration, EvidenceInput, type Verdict } from "../resolve/schema";
import { planRoute } from "../resolve";
import { thresholdsFromEnv } from "../resolve/thresholds";
import { resolveWithRuntime, JevUnavailableError, type RuntimeOutput } from "../resolve/runtime";
import { toStrictV0 } from "../resolve/verdict";
import { registerMarket } from "../markets/register";
import { registrationRefused } from "./registration";
import { runWatch } from "../ingest/watch";
import { sha256Hex } from "../resolve/text";
import type { MarketRow } from "../ingest/types";
import { alert } from "../ops/alerts";
import { redact } from "../ops/redact";
import { mintKey, rotationExpiry } from "./keys";
import { followBlock, followCap, followEntitlements, followEvent, followMarket, followRefusal, hasResolvedCommit, onlyMatch, parseMarketRef, FollowBody, Plan, shapeShadow, EARLY_REVEAL_LABEL, MARKET_REF_HINT, type FollowAnswer, type FollowEventAnswer, type FollowTarget, type MarketRef, type ShadowCommitRow, type ShadowMarket, type ShadowReveal } from "../shadow/follows";
import { subscribes } from "../webhooks/deliver";
import { chunks, entitledFollows, exportCsv, exportRows, pricedRow, selectRows, EXPORT_COLUMNS, EXPORT_ROW_CAP, EXPORT_VIEW_COLUMNS, ExportQuery, type ExportFollow, type ExportViewRow } from "../shadow/export";
import { lockedReveal, revealAccess, revealEntitlements, revealReleased, revealRequestId, revealTerms, REVEAL_EVENT_CAP_CREDITS, REVEAL_PRICE_CREDITS, type RevealAnswer } from "../shadow/reveal";
import { DISCLAIMER } from "../bot/commit";
import { noteCharge, noteCrossings, type Crossing } from "../billing/events";
import { effectiveTiers, packQuotes, paygRate } from "../billing/tiers";
import { publicBase, topUp, topUpText, usdcDepositsOffered, USDC_NOT_OFFERED } from "../billing/top-up";
import { publicBasis, publicRoute, publicText, publicVerdictRecord, publicWatchSummary, toPublicVerdict } from "./public-names";
import { challengeMessage, newNonce, registerAnswer, signedBy, REGISTER_RESULTS, SIGNATURE, WALLET_ADDRESS, type RegisterResult } from "../billing/wallet";

type Vars = { requestId: string; schemaVersion: string; auth: AuthContext };
export const v1 = new Hono<{ Bindings: Env; Variables: Vars }>();

const PRICE = { precheck: 0, structured: 1, jev: 5 } as const;

v1.use("*", async (c, next) => {
  const a = await authenticate(c);
  if (!a.ok) return a.response;
  c.set("auth", a.auth);
  const rl = await rateLimit(c, a.auth, { jev: false, jevRpmLimit: 1 });
  if (!rl.allowed) return rl.response;
  await next();
});

/** Hash-not-body request log, off the critical path. */
v1.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  const res = c.res;
  const auth = c.get("auth");
  const clone = res.clone();
  // The request log is the per-request evidence trail: a row that could not be written is an alert, not a log line.
  const logFailed = (why: unknown) => alert(c.env, "api_request_log_failed", `api_request_log insert failed for ${c.req.method} ${c.req.path} (request ${c.get("requestId")}): ${redact(String(why)).slice(0, 200)}`, { dedupMinutes: 60 });
  c.executionCtx.waitUntil((async () => {
    const body = await clone.text();
    const hash = await sha256Hex(body);
    const { error } = await db(c.env).from("api_request_log").insert({
      request_id: c.get("requestId"), api_key_id: auth?.keyId ?? null, tenant_id: auth?.tenantId ?? null, auth_source: "database",
      route: c.req.routePath || c.req.path, method: c.req.method, status: res.status, duration_ms: Date.now() - t0,
      redacted_params: { path: c.req.path, query_keys: [...new URL(c.req.url).searchParams.keys()], content_length: c.req.header("content-length") ?? null },
      response_sha256: hash, client_colo: ((c.req.raw as Request & { cf?: { colo?: string } }).cf?.colo) ?? null, user_agent: (c.req.header("user-agent") ?? "").slice(0, 200),
    });
    if (error) await logFailed(error.message);
  })().catch(logFailed));
});

const ResolveBody = z.object({
  market_id: z.string().uuid().optional(),
  market: MarketRegistration.optional(),
  evidence: z.object({
    source_url: z.string().max(2048).optional(),
    text: z.string().max(200_000).optional(),
    structured: z.unknown().optional(),
    observed_at: z.iso.datetime({ offset: true }).optional(),
    source_kind: z.enum(["tenant_supplied", "github_api", "base_log", "solana_log", "web_fetch"]).default("tenant_supplied"),
  }).optional(),
  fetch: z.boolean().default(false),
}).refine((b) => !!b.market_id || (!!b.market && !!b.evidence), { message: "provide market_id, or market + evidence" });

/** The verdict in its public shape (src/api/public-names.ts): engine_version, web_evidence, public error_reason and checks. */
function verdictResponse(c: Parameters<typeof ok>[0], auth: AuthContext, v: Verdict, extra: Record<string, unknown>) {
  if (auth.strictV0) {
    const s = toStrictV0(v);
    if (s.kind === "http") return err(c, s.code, s.message, s.status, { retryAfterSeconds: 30 });
    return ok(c, { ...s.body, ...extra });
  }
  return ok(c, { ...toPublicVerdict(v), ...extra });
}

/**
 * Money path: the tenant pays for a verdict, not for our outage. refund_credits is idempotent per request; a refund
 * that fails is alerted per request (refund it by hand until P3's refund_pending job).
 */
async function refundOrAlert(env: Env, client: Db, requestId: string, tenantId: string, charged: number, why: string): Promise<number> {
  return rpc<number>(client, "refund_credits", { p_request_id: requestId }).catch(async (e) => {
    await alert(env, `refund_failed_${requestId}`, `refund_credits failed for request ${requestId} (tenant ${tenantId}, ${charged} credit(s) charged for ${why}): ${redact(String(e)).slice(0, 200)}. Refund it by hand.`, { dedupMinutes: 1440, meta: { request_id: requestId, tenant_id: tenantId, credits: charged } });
    return 0;
  });
}

/** A replayed key whose request failed before its verdict was recorded: no verdict will ever exist under that key. */
function notRecordedReplay(c: Parameters<typeof ok>[0], id: string, refunded: unknown) {
  const credits = Number(refunded ?? 0);
  return err(c, "UPSTREAM_UNAVAILABLE", `request ${id} failed before its verdict was recorded${credits > 0 ? ` and its ${credits} credit(s) were refunded` : ""}; send it again with a new Idempotency-Key`, 503, { retryAfterSeconds: 30, extra: { error_reason: "VERDICT_NOT_RECORDED" } });
}

/**
 * A tenant fetch runs a watch outside the pg_net schedule, so it takes the same lease a dispatch holds
 * (lease_watch_now, migration 019): while a dispatched run or another fetch holds it, this fetch does not run, and a
 * dispatch signed before this lease is refused as lease_superseded. Without it two runs of one watch could overlap:
 * duplicate evidence and resolutions, two charges for one change, and runWatch's release of the lease would turn the
 * in-flight dispatch into a 409 that dispatch_failures() alerts on. An RPC error fails closed: running unleased is
 * exactly the overlap. Subrequests: one on top of the pre-019 fetch path.
 */
async function leaseForFetch(client: Db, watchId: string): Promise<"leased" | "busy" | { error: string }> {
  try { return (await rpc<string | null>(client, "lease_watch_now", { p_watch: watchId })) ? "leased" : "busy"; }
  catch (e) { return { error: String(e) }; }
}

v1.post("/resolve", async (c) => {
  const cfg = parseConfig(c.env);
  const auth = c.get("auth");
  const client = db(c.env);
  const parsed = ResolveBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "validation_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 400);
  const body = parsed.data;
  const idem = c.req.header("idempotency-key")?.slice(0, 200) ?? null;

  // 0. Idempotent replay is decided BEFORE any side effect (same id derivation as begin_resolution).
  if (idem) {
    const id = await sha256Hex(`${auth.tenantId}|${idem}`);
    const { data: r } = await client.from("resolutions").select("*").eq("id", id).maybeSingle();
    if (r) {
      c.header("X-Idempotent-Replay", "true");
      if (r.status_row === "failed") return notRecordedReplay(c, id, r.credits_refunded);
      if (r.status_row !== "complete") return ok(c, { request_id: id, status_row: r.status_row, message: "original request still in flight" }, 202);
      const { data: t } = await client.from("tenants").select("credits_balance").eq("id", auth.tenantId).single();
      return ok(c, { request_id: id, ...rowToVerdict(r), replayed: true, credits_charged: r.credits_charged, credits_refunded: r.credits_refunded, balance: t?.credits_balance ?? null });
    }
  }

  // 1. market + evidence
  let market: MarketRow;
  let evidence: EvidenceInput;
  let evidenceId: string | null = null;
  if (body.market_id) {
    const { data: m } = await client.from("markets").select("*").eq("id", body.market_id).eq("tenant_id", auth.tenantId).is("deleted_at", null).maybeSingle();
    if (!m) return err(c, "not_found", "market not found for this tenant", 404);
    market = m as unknown as MarketRow;
    if (body.fetch) {
      const { data: w } = await client.from("watches").select("id").eq("market_id", market.id).eq("active", true).is("deleted_at", null).limit(1).maybeSingle();
      if (!w) return err(c, "validation_error", "market has no active watch to fetch from", 400);
      const leased = await leaseForFetch(client, w.id as string);
      if (leased !== "leased") return leased === "busy"
        ? err(c, "conflict", "a poll of this watch is in progress (a scheduled dispatch or another fetch); retry in a minute", 409)
        : err(c, "UPSTREAM_UNAVAILABLE", `could not lease the watch, the fetch did not run: ${redact(leased.error).slice(0, 200)}`, 503);
      const s = await runWatch(c.env, cfg, w.id as string, { waitUntil: waitUntilOf(c), dispatch: "tenant_fetch", base: publicBase(c.env, c.req.url) });
      if (s.resolution_id) {
        // The verdict as GET /v1/resolutions/:id answers it, never the raw row (it holds the model's own answers).
        const { data: r } = await client.from("resolutions").select("*").eq("id", s.resolution_id).single();
        return ok(c, { request_id: s.resolution_id, watch: publicWatchSummary(s), resolution: r ? resolutionBody(r) : null });
      }
      if (s.outcome === "failure") return err(c, "UPSTREAM_UNAVAILABLE", `fetch failed: ${publicText(s.detail)}`, 503);
    }
    const { data: e } = await client.from("evidence").select("*").eq("market_id", market.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!e) return err(c, "not_found", "no evidence stored for this market yet; register sources or pass evidence inline", 404);
    evidenceId = e.id as string;
    let structured: unknown = undefined;
    let text = (e.excerpt as string | null) ?? "";
    if (e.raw_r2_key && !String(e.source_kind).startsWith("web")) {
      const obj = await c.env.RAW.get(e.raw_r2_key as string);
      if (obj) { const t = await obj.text(); text = t; try { structured = JSON.parse(t); } catch { /* text */ } }
    }
    evidence = { source_kind: e.source_kind as EvidenceInput["source_kind"], source_url: (e.source_url as string | null) ?? undefined, text, structured, observed_at: String(e.source_kind).startsWith("web") ? ((e.claimed_at as string | null) ?? undefined) : (e.observed_at as string), fetched_at: e.fetched_at as string, http_status: (e.http_status as number | null) ?? undefined, coverage: (e.coverage as EvidenceInput["coverage"]) ?? undefined, provenance: (e.provenance as Record<string, unknown>) ?? undefined };
  } else {
    let reg: Awaited<ReturnType<typeof registerMarket>>;
    // registration refusals (e.g. an official_release market whose source does not match its resolver) are the caller's 400
    try { reg = await registerMarket(c.env, cfg, { ...body.market!, platform: body.market!.platform ?? "custom" }, auth.tenantId, { createWatches: false }); }
    catch (e) { return err(c, "validation_error", String(e).slice(0, 400), 400); }
    const { data: m } = await client.from("markets").select("*").eq("id", reg.marketId).single();
    market = m as unknown as MarketRow;
    const ev = body.evidence!;
    evidence = EvidenceInput.parse({ source_kind: ev.source_kind, source_url: ev.source_url, text: ev.text, structured: ev.structured, observed_at: ev.observed_at, fetched_at: new Date().toISOString(), provenance: { inline: true } });
  }

  // 2. price before charge
  const th = thresholdsFromEnv(c.env as unknown as Record<string, string | undefined>, cfg.thresholdsVersion);
  const plan = await planRoute({ marketId: market.id, market, evidence, thresholds: th, spotlightSecret: c.env.SPOTLIGHT_SECRET, model: cfg.jevModel });
  const amount = PRICE[plan.route];
  if (plan.route === "jev") {
    const rl = await rateLimit(c, auth, { jev: true, jevRpmLimit: cfg.jevRpmLimit });
    if (!rl.allowed) return rl.response;
  }

  // 3. INSERT-first idempotent claim + charge (fail-closed)
  type BR = { request_id: string; replayed: boolean; ok: boolean; balance: number; charged: number };
  let br: BR;
  try {
    const r = await rpc<BR[] | BR>(client, "begin_resolution", { p_tenant: auth.tenantId, p_api_key: auth.keyId, p_idempotency_key: idem, p_amount: amount, p_market: market.id, p_mode: "tenant" });
    const row = Array.isArray(r) ? r[0] : r;
    if (!row) throw new Error("begin_resolution returned no row");
    br = row;
  } catch (e) {
    return err(c, "UPSTREAM_UNAVAILABLE", `billing unavailable (${String(e).slice(0, 120)}); no credits charged, no verdict produced`, 503, { retryAfterSeconds: 30, extra: { error_reason: "BILLING_UNAVAILABLE" } });
  }
  if (br.replayed) {
    const { data: r } = await client.from("resolutions").select("*").eq("id", br.request_id).single();
    c.header("X-Idempotent-Replay", "true");
    if (r?.status_row === "failed") return notRecordedReplay(c, br.request_id, r.credits_refunded);
    if (!r || r.status_row !== "complete") return ok(c, { request_id: br.request_id, status_row: r?.status_row ?? "pending", message: "original request still in flight" }, 202);
    return ok(c, { request_id: br.request_id, ...rowToVerdict(r), replayed: true, credits_charged: r.credits_charged, balance: br.balance });
  }
  if (!br.ok) {
    // Where to top up: the card rail while it is offered, else support; never the USDC address (src/billing/top-up.ts).
    const top = topUp(c.env, publicBase(c.env, c.req.url));
    return err(c, "insufficient_credits", `This request costs ${amount} credit(s); balance is ${br.balance}. ${topUpText(top)}`, 402, { extra: { balance: br.balance, price_credits: amount, route: publicRoute(plan.route), top_up: top } });
  }

  // 4. resolve
  let rt: RuntimeOutput;
  try {
    rt = await resolveWithRuntime(c.env, cfg, { marketId: market.id, market, evidence, evidenceId, mode: "tenant", tenantId: auth.tenantId, tenantPlan: auth.plan, apiKeyId: auth.keyId, requestId: br.request_id, creditsCharged: br.charged });
  } catch {
    // ResolutionNotRecordedError, the runtime's only throw: it alerted, ran the Jev accounting and marked the stub failed.
    const refunded = br.charged > 0 ? await refundOrAlert(c.env, client, br.request_id, auth.tenantId, br.charged, "a verdict that was not recorded") : 0;
    return err(c, "UPSTREAM_UNAVAILABLE", `the verdict for request ${br.request_id} could not be recorded${refunded > 0 ? `; the ${refunded} credit(s) charged were refunded` : ""}. Send the request again with a new Idempotency-Key.`, 503, { retryAfterSeconds: 30, extra: { error_reason: "VERDICT_NOT_RECORDED", credits_refunded: refunded } });
  }
  let refunded = 0;
  if (rt.result.verdict.error_code === "UPSTREAM_UNAVAILABLE" && br.charged > 0) refunded = await refundOrAlert(c.env, client, br.request_id, auth.tenantId, br.charged, "an UPSTREAM_UNAVAILABLE verdict");
  // The charge stands: credits.low and the operator's alert once per crossing, off the response path (noteCharge: 1
  // subrequest, 9 at most at the crossing; the key's plan saves the plan read).
  if (br.charged - refunded > 0) {
    const low = noteCharge(c.env, auth.tenantId, br.request_id, { plan: auth.plan, base: publicBase(c.env, c.req.url) });
    const wu = waitUntilOf(c);
    if (wu) wu(low); else await low;
  }
  return verdictResponse(c, auth, rt.result.verdict, { request_id: br.request_id, credits_charged: br.charged - refunded, credits_refunded: refunded, balance: br.balance + refunded, route: publicRoute(plan.route) });
});

/**
 * A stored resolutions row as the public verdict (PublicVerdict's fields; src/api/public-names.ts): the one mapping
 * shared by the replays, GET /v1/resolutions/:id and the fetch:true answer. Stored values keep their internal names.
 */
function rowToVerdict(r: Record<string, unknown>) {
  return publicVerdictRecord({ market_id: r.market_id, resolution_status: r.resolution_status, winning_outcome: r.winning_outcome, confidence_score: Number(r.confidence_score), error_code: r.error_code, error_reason: r.error_reason, caveats: r.caveats, determination_basis: r.determination_basis, checks: r.checks, jev_model: r.jev_model, thresholds_version: r.thresholds_version, latency_ms: r.duration_ms });
}

/** GET /v1/resolutions/:id's body for a stored row. */
function resolutionBody(r: Record<string, unknown>) {
  return { request_id: r.id, ...rowToVerdict(r), credits_charged: r.credits_charged, credits_refunded: r.credits_refunded, created_at: r.created_at };
}

/** GET /v1/markets/:id/resolutions: the columns read, each row answered in public names (jev_model is engine_version). */
const HISTORY_COLUMNS = ["id", "resolution_status", "winning_outcome", "confidence_score", "error_code", "error_reason", "caveats", "determination_basis", "jev_model", "thresholds_version", "credits_charged", "credits_refunded", "created_at"] as const;

/**
 * The tenant's watch_limit is held inside register_market (migration 019) under a lock on the tenant row: active
 * watches plus this market's must fit, and two concurrent registrations cannot both pass. A re-registration of an
 * existing (platform, external_id) returns that market whatever the limit.
 */
v1.post("/markets", async (c) => {
  const cfg = parseConfig(c.env);
  const auth = c.get("auth");
  const body = (await c.req.json().catch(() => null)) as unknown;
  try {
    const r = await registerMarket(c.env, cfg, body, auth.tenantId);
    return ok(c, { market_id: r.marketId, status: r.status, reasons: r.reasons, watches: r.watches }, 201);
  } catch (e) { return registrationRefused(c, e); }
});

v1.get("/markets", async (c) => {
  const { data } = await db(c.env).from("markets").select("id, platform, external_id, condition, status, open_at, deadline_utc, official_outcome, created_at").eq("tenant_id", c.get("auth").tenantId).is("deleted_at", null).order("created_at", { ascending: false }).limit(100);
  return ok(c, { markets: data ?? [] });
});
v1.get("/markets/:id", async (c) => {
  const client = db(c.env);
  const id = c.req.param("id");
  const { data: m } = await client.from("markets").select("*").eq("id", id).eq("tenant_id", c.get("auth").tenantId).is("deleted_at", null).maybeSingle();
  if (!m) return err(c, "not_found", "market not found", 404);
  const { data: w } = await client.from("watches").select("id, source_kind, source_ref, poll_interval_s, next_poll_at, last_polled_at, consecutive_errors, backlog, active").eq("market_id", id).is("deleted_at", null);
  return ok(c, { market: m, watches: w ?? [] });
});
v1.delete("/markets/:id", async (c) => {
  const client = db(c.env);
  const id = c.req.param("id");
  const { data } = await client.from("markets").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("tenant_id", c.get("auth").tenantId).is("deleted_at", null).select("id");
  if (!data?.length) return err(c, "not_found", "market not found", 404);
  await client.from("watches").update({ active: false, deleted_at: new Date().toISOString() }).eq("market_id", id);
  return ok(c, { deleted: id });
});
v1.get("/markets/:id/resolutions", async (c) => {
  const { data } = await db(c.env).from("resolutions").select(HISTORY_COLUMNS.join(", ")).eq("market_id", c.req.param("id")).eq("tenant_id", c.get("auth").tenantId).eq("status_row", "complete").order("created_at", { ascending: false }).limit(50);
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  return ok(c, { resolutions: rows.map((r) => publicVerdictRecord(Object.fromEntries(HISTORY_COLUMNS.map((k) => [k, r[k]])))) });
});

// ---- follows and the private early reveal (plan §17.3 P7-lite) ---------------------------------------------------

const SHADOW_EVENTS = ["shadow.committed", "shadow.revealed"] as const;
/** GET /v1/follows returns the newest this many; active_follows is the full count. */
const FOLLOWS_PAGE = 1000;
const storeDown = (c: Parameters<typeof ok>[0], what: string) => err(c, "UPSTREAM_UNAVAILABLE", `${what} unavailable; retry shortly.`, 503);

/**
 * The tenant's plan as tenants.plan says now (auth caches the key for up to 60 s; a plan change applies at once), and
 * when the tenant was created (the priced reveal's cut-over, src/shadow/reveal.ts revealTerms).
 */
async function tenantPlan(client: Db, tenantId: string): Promise<{ plan: Plan; createdAt: string | null } | { error: string }> {
  const { data, error } = await client.from("tenants").select("plan, created_at").eq("id", tenantId).single();
  if (error) return { error: error.message };
  const plan = Plan.safeParse(data?.plan);
  return plan.success ? { plan: plan.data, createdAt: typeof data?.created_at === "string" ? data.created_at : null } : { error: `unknown plan ${JSON.stringify(data?.plan)}` };
}

/** What a reveal costs this tenant (src/shadow/reveal.ts), as the follow answers state it. */
function revealPrice(plan: Plan, createdAt: string | null) {
  const terms = revealTerms(plan, createdAt);
  return {
    terms, credits_per_resolved_leg: terms === "pays" ? REVEAL_PRICE_CREDITS : 0, event_cap_credits: terms === "pays" ? REVEAL_EVENT_CAP_CREDITS : 0,
    note: terms === "pays"
      ? `Each RESOLVED verdict revealed to you costs ${REVEAL_PRICE_CREDITS} credits, charged once per market when it is first delivered or read, at most ${REVEAL_EVENT_CAP_CREDITS} credits per event; UNRESOLVED and ERROR verdicts are free. At a short balance the reveal is locked (the commitment and a top-up pointer, no verdict) and nothing is charged.`
      : terms === "included_plan" ? "Early reveals are included in this plan." : "Early reveals stay free for this evaluation key until it expires (it was issued before reveals were priced).",
  };
}

/** Low-credit crossings a reveal charge claimed (charge_reveals, migration 023), for noteCrossings. */
const crossingsOf = (answers: readonly RevealAnswer[]): Crossing[] => answers
  .filter((a) => a.low_credit === true && a.low_credit_threshold !== null && a.balance !== null)
  .map((a) => ({ tenantId: a.tenant_id, plan: a.plan, balance: a.balance!, threshold: a.low_credit_threshold!, requestId: revealRequestId(a.tenant_id, a.market_id) }));

/**
 * After a read's reveal charge: credits.low for a crossing it claimed, and the operator's alert when charge_reveals
 * failed (the reveal was answered locked, billing_unavailable) or could not claim the low-credit notice. Off the response
 * path when the request has waitUntil.
 */
async function afterRevealRead(c: Parameters<typeof ok>[0], answers: readonly RevealAnswer[], error: string | null, where: string): Promise<void> {
  const auth = c.get("auth");
  const unclaimed = answers.filter((a) => a.charged > 0 && a.low_credit === null);
  const work = (async () => {
    if (error) await alert(c.env, "shadow_reveal_billing_unavailable", `charge_reveals failed on ${where} (tenant ${auth.tenantId}): ${error}. The read answered the RESOLVED verdicts locked (reason billing_unavailable), nothing charged; included plans read them in full. Check the charge_reveals RPC (migration 023).`, { dedupMinutes: 60, meta: { tenant_id: auth.tenantId } });
    if (unclaimed.length) await alert(c.env, "low_credit_check_failed", `charge_reveals charged tenant ${auth.tenantId} on ${where} but could not claim its low-credit notice (is app_config low_credit_threshold a whole number?); credits.low waits for the next charge.`, { dedupMinutes: 60, meta: { tenant_id: auth.tenantId } });
    await noteCrossings(c.env, crossingsOf(answers), publicBase(c.env, c.req.url));
  })().catch((e) => { console.error(JSON.stringify({ level: "error", job: "reveal_read_notes", tenant_id: auth.tenantId, error: redact(String(e)).slice(0, 200) })); });
  const wu = waitUntilOf(c);
  if (wu) wu(work); else await work;
}

/**
 * The markets read of a market a path names (parseMarketRef), one subrequest: a uuid as it is (every tenant's market, so
 * the follow rules can refuse another tenant's exactly like a missing one); a venue id only among public shadow markets
 * (tenant_id null, not a test market, not deleted), two rows read so that a second match is seen and refused (onlyMatch).
 */
function readMarketRef(client: Db, ref: MarketRef, columns: string) {
  const q = client.from("markets").select(columns);
  return ref.kind === "uuid"
    ? q.eq("id", ref.id).limit(1)
    : q.eq("platform", ref.platform).eq("external_id", ref.externalId).is("tenant_id", null).eq("is_test", false).is("deleted_at", null).limit(2);
}

/** The uuid a market ref names: as given, or the one public shadow market with that venue id (one read); null when none or several. */
async function marketIdOf(client: Db, ref: MarketRef): Promise<{ id: string | null } | { error: string }> {
  if (ref.kind === "uuid") return { id: ref.id };
  const { data, error } = await readMarketRef(client, ref, "id");
  if (error) return { error: error.message };
  return { id: onlyMatch(data as unknown as Array<{ id: string }> | null)?.id ?? null };
}

/**
 * Follow a public shadow market: private early reveals by webhook (shadow.committed, shadow.revealed) and GET /v1/shadow/:id.
 * The market is named by its uuid or its venue id, "<platform>:<external_id>" as /record prints it (the same one read).
 * An optional JSON body {"scope":"event"} follows every open public leg of that market's event (markets.event_key: an
 * official release's legs on every venue, a Polymarket event's legs) in one transaction, all or nothing against the
 * follow limit (follow_event, migration 023); without a body, or with {"scope":"market"}, the one market (follow_market).
 * The answer counts the tenant's endpoints that will receive shadow.committed: an endpoint registered before these events
 * existed was subscribed to the old defaults, and a follow with no subscribed endpoint must say so rather than deliver
 * nothing silently. It also states what a RESOLVED reveal costs this account (src/shadow/reveal.ts).
 */
v1.post("/markets/:id/follow", async (c) => {
  const auth = c.get("auth");
  const ref = parseMarketRef(c.req.param("id"));
  if (!ref) return err(c, "validation_error", MARKET_REF_HINT, 400);
  // no body (or only whitespace) is the one market, as before the event scope existed
  const raw = (await c.req.text().catch(() => "")).trim();
  let json: unknown = {};
  if (raw) { try { json = JSON.parse(raw); } catch { return err(c, "validation_error", 'body must be JSON: {"scope":"event"} or {"scope":"market"}, or no body', 400); } }
  const body = FollowBody.safeParse(json);
  if (!body.success) return err(c, "validation_error", `body: ${body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ").slice(0, 300)}`, 400);
  const client = db(c.env);
  const [{ data: rows, error: me }, plan, { data: eps, error: ee }] = await Promise.all([
    readMarketRef(client, ref, "id, tenant_id, is_test, status, deleted_at, platform, external_id"),
    tenantPlan(client, auth.tenantId),
    // the endpoints enqueueEvent would read for this tenant
    client.from("webhook_endpoints").select("id, events").eq("tenant_id", auth.tenantId).eq("active", true).is("deleted_at", null),
  ]);
  if (me || ee || "error" in plan) return storeDown(c, "market, tenant or webhook store");
  // none, or a venue id that two rows share: answered like any missing market
  const m = onlyMatch(rows as unknown as Array<FollowTarget & { platform: string; external_id: string }> | null);
  if (!m) return err(c, "not_found", "market not found", 404);
  const refusal = followRefusal(m, auth.tenantId);
  if (refusal) return err(c, refusal.code, refusal.message, refusal.status);
  const cap = followCap(plan.plan);
  const subscribed = ((eps ?? []) as Array<{ events: string[] | null }>).filter((e) => subscribes(e, "shadow.committed")).length;
  const delivery = (read: string) => ({
    events: SHADOW_EVENTS, read, endpoints_subscribed: subscribed, reveal_price: revealPrice(plan.plan, plan.createdAt),
    note: "Verdicts arrive as shadow.committed on every active endpoint subscribed to it (POST /v1/webhooks) and at the read URL. Private early reveal, excluded from the public record.",
    ...(subscribed === 0 ? { warning: `No active webhook endpoint of this account is subscribed to shadow.committed, so no webhook will arrive for this follow; read ${read}, or register an endpoint whose events include ${SHADOW_EVENTS.join(" and ")} (POST /v1/webhooks). An endpoint's events are fixed when it is registered.` } : {}),
  });
  if (body.data.scope === "event") {
    let e: FollowEventAnswer;
    // follow_event is one transaction: an error means no follow was recorded.
    try { e = await followEvent(client, auth.tenantId, m.id, cap); }
    catch { return storeDown(c, "follow store (no follow was recorded)"); }
    switch (e.result) {
      case "followed": return ok(c, {
        scope: "event", event_key: e.event_key, market_id: m.id, market: `${m.platform}:${m.external_id}`, following: true,
        legs: e.legs, followed: e.followed, already_following: e.already_following, follows_counted: e.active, follow_limit: cap,
        ...delivery("/v1/shadow/export"),
      }, e.followed > 0 ? 201 : 200);
      case "cap_reached": return err(c, "validation_error", `follow limit (${e.cap} follows of open markets) reached for this plan: this event has ${e.legs} open legs, ${e.already_following} already followed, so following it needs ${e.legs - e.already_following} more follows and this account has ${e.active} of ${e.cap}. Nothing was followed. A follow stops counting when its market settles; unfollow markets (DELETE /v1/markets/:id/follow), follow single legs, or change plans`, 403, { extra: { follow_limit: e.cap, follows_counted: e.active, legs: e.legs, already_following: e.already_following, event_key: e.event_key } });
      case "not_followable": return err(c, "validation_error", `market cannot be followed: ${e.reason}`, 400);
      default: { const never: never = e; throw new Error(`unhandled follow_event answer ${JSON.stringify(never)}`); }
    }
  }
  let a: FollowAnswer;
  // follow_market is one transaction: an error means no follow was recorded.
  try { a = await followMarket(client, auth.tenantId, m.id, cap); }
  catch { return storeDown(c, "follow store (no follow was recorded)"); }
  const followed = (following: { follow_id: string; active: number }, created: boolean) => ok(c, {
    follow_id: following.follow_id, market_id: m.id, market: `${m.platform}:${m.external_id}`, following: true, already_following: !created, follows_counted: following.active, follow_limit: cap,
    ...delivery(`/v1/shadow/${m.id}`),
  }, created ? 201 : 200);
  switch (a.result) {
    case "followed": return followed(a, true);
    case "already_following": return followed(a, false);
    case "cap_reached": return err(c, "validation_error", `follow limit (${a.cap} follows of open markets) reached for this plan; a follow stops counting when its market settles. Unfollow a market (DELETE /v1/markets/:id/follow) or change plans`, 403, { extra: { follow_limit: a.cap, follows_counted: a.active } });
    case "not_followable": return err(c, "validation_error", `market cannot be followed: ${a.reason}`, 400);
    default: { const never: never = a; throw new Error(`unhandled follow answer ${JSON.stringify(never)}`); }
  }
});

v1.delete("/markets/:id/follow", async (c) => {
  const ref = parseMarketRef(c.req.param("id"));
  if (!ref) return err(c, "validation_error", MARKET_REF_HINT, 400);
  const client = db(c.env);
  const id = await marketIdOf(client, ref);
  if ("error" in id) return storeDown(c, "market store");
  if (!id.id) return err(c, "not_found", "market not found", 404);
  const { data, error } = await client.from("market_follows").update({ deleted_at: new Date().toISOString() })
    .eq("tenant_id", c.get("auth").tenantId).eq("market_id", id.id).is("deleted_at", null).select("id");
  if (error) return storeDown(c, "follow store");
  if (!data?.length) return err(c, "not_found", "not following this market", 404);
  return ok(c, { unfollowed: id.id });
});

v1.get("/follows", async (c) => {
  const auth = c.get("auth");
  const client = db(c.env);
  const [{ data, error, count }, counted, plan] = await Promise.all([
    client.from("market_follows").select("id, market_id, created_at, markets(platform, external_id, status, deadline_utc)", { count: "exact" }).eq("tenant_id", auth.tenantId).is("deleted_at", null).order("created_at", { ascending: false }).limit(FOLLOWS_PAGE),
    // what the follow limit counts: follows of open markets (follow_market in migration 014)
    client.from("market_follows").select("id, markets!inner(status, deleted_at)", { count: "exact", head: true }).eq("tenant_id", auth.tenantId).is("deleted_at", null).eq("markets.status", "open").is("markets.deleted_at", null),
    tenantPlan(client, auth.tenantId),
  ]);
  if (error || counted.error || counted.count == null || "error" in plan) return storeDown(c, "follow store");
  type F = { id: string; market_id: string; created_at: string; markets: { platform: string; external_id: string; status: string; deadline_utc: string } | null };
  const follows = ((data ?? []) as unknown as F[]).map((f) => ({
    follow_id: f.id, market_id: f.market_id, followed_at: f.created_at,
    market: f.markets ? `${f.markets.platform}:${f.markets.external_id}` : null, status: f.markets?.status ?? null, deadline_utc: f.markets?.deadline_utc ?? null,
  }));
  const active = count ?? follows.length;
  const limit = followCap(plan.plan);
  // Only after a plan change can a tenant hold more follows of open markets than its limit; the oldest ones deliver.
  const over = limit !== null && counted.count > limit;
  return ok(c, {
    follows, active_follows: active, follows_counted: counted.count, follow_limit: limit, truncated: active > follows.length,
    ...(over ? { warning: `${counted.count} follows of open markets exceed this plan's limit of ${limit}: only the ${limit} oldest receive early reveals. Unfollow markets or change plans.` } : {}),
  });
});

/**
 * Bulk export of the tenant's followed markets (plan §17.3 P7-lite): one row per entitled follow, from v_venue_report
 * (migration 021). Registered before /shadow/:market_id so "export" is never read as a market id. A RESOLVED latest
 * verdict is priced like every reveal (src/shadow/reveal.ts): one charge_reveals() call for every exported RESOLVED row
 * (source read: once per tenant and market, a replay free, never refunded); a row the tenant has not received is exported
 * locked (committed_status and committed_outcome empty, reveal naming why) and the answer carries the top-up pointer, never
 * a 402. Subrequests: EXPORT_SUBREQUESTS (src/shadow/export.ts). CSV (RFC 4180, header row) or the JSON envelope.
 */
v1.get("/shadow/export", async (c) => {
  const q = ExportQuery.safeParse({ platform: c.req.query("platform") || undefined, since: c.req.query("since") || undefined, format: c.req.query("format") || undefined });
  if (!q.success) return err(c, "validation_error", q.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ").slice(0, 400), 400);
  const auth = c.get("auth");
  const client = db(c.env);
  const [plan, { data, error, count }] = await Promise.all([
    tenantPlan(client, auth.tenantId),
    // follow_entitlements' order, (created_at, id), so a created_at tie at the cap drops the same follow it would; the
    // exact count says whether a newer follow was left out (a full page alone cannot: Supabase caps a page at 1,000)
    client.from("market_follows").select("id, market_id, created_at, markets(platform, status, deleted_at)", { count: "exact" })
      .eq("tenant_id", auth.tenantId).is("deleted_at", null).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(EXPORT_ROW_CAP),
  ]);
  if (error || "error" in plan) return storeDown(c, "follow store");
  const follows = (data ?? []) as unknown as ExportFollow[];
  // The oldest EXPORT_ROW_CAP follows are read, so their entitlement is exact; a newer one is not exported, and says so.
  // Without a count, a full page is reported as truncated: never a silent cut.
  const truncated = typeof count === "number" ? count > follows.length : follows.length >= EXPORT_ROW_CAP;
  // An authenticated caller holds a live key: the evaluation rule is met for the calling tenant.
  const ids = entitledFollows(follows, plan.plan, true).filter((f) => !q.data.platform || f.markets?.platform === q.data.platform).map((f) => f.market_id);
  const reads = await Promise.all(chunks(ids).map((part) => client.from("v_venue_report").select(EXPORT_VIEW_COLUMNS.join(", ")).in("market_id", part)));
  if (reads.some((r) => r.error)) return storeDown(c, "report store");
  const view = reads.flatMap((r) => (r.data ?? []) as unknown as ExportViewRow[]);
  // the priced rows: those this export prints whose latest verdict is RESOLVED, in one charge_reveals() call
  const priced = selectRows(view, q.data).filter(pricedRow).map((v) => String(v.market_id));
  const ent = await revealEntitlements(client, priced.map((market_id) => ({ tenant_id: auth.tenantId, market_id, plan: plan.plan })), { resolved: true, source: "read" });
  if (ent.answers.length) await afterRevealRead(c, ent.answers, ent.error, "GET /v1/shadow/export");
  const rows = exportRows(view, q.data, new Map(ent.answers.map((a) => [a.market_id, a])));
  const charged = ent.answers.reduce((n, a) => n + a.charged, 0);
  const locked = ent.answers.filter((a) => !revealReleased(a));
  // balances only fall within one call, so the lowest is the balance after it
  const balances = ent.answers.map((a) => a.balance).filter((b): b is number => b !== null);
  const balance = balances.length ? Math.min(...balances) : null;
  const top = locked.some((a) => a.reason === "insufficient_credits") ? topUp(c.env, publicBase(c.env, c.req.url)) : null;
  if (q.data.format === "csv") {
    c.header("X-Request-Id", requestId(c));
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="resolve-shadow-export.csv"');
    c.header("X-Resolve-Truncated", truncated ? "true" : "false");
    c.header("X-Resolve-Credits-Charged", String(charged));
    c.header("X-Resolve-Locked", String(locked.length));
    return c.body(exportCsv(rows), 200);
  }
  return ok(c, {
    rows, count: rows.length, columns: EXPORT_COLUMNS, truncated, filters: { platform: q.data.platform ?? null, since: q.data.since ?? null },
    credits_charged: charged, locked_rows: locked.length, balance,
    ...(top ? { top_up: top, locked_note: `${locked.length} RESOLVED verdict(s) are locked: each costs ${REVEAL_PRICE_CREDITS} credits (at most ${REVEAL_EVENT_CAP_CREDITS} per event) and the balance is ${balance ?? "unknown"}. Nothing was charged for them. ${topUpText(top)} Then export again: they are charged and released then.` } : {}),
    label: EARLY_REVEAL_LABEL,
    note: `One row per followed market you are entitled to (the oldest ${EXPORT_ROW_CAP} follows are read${truncated ? "; newer follows are not in this export" : ""}): the latest commitment, its verdict and evidence hashes, and once the platform resolves the market, the official outcome, its time and source, the agreement and lead_seconds. A RESOLVED verdict is charged ${REVEAL_PRICE_CREDITS} credits the first time it reaches you (by webhook, GET /v1/shadow/{market_id} or this export; never twice), unless your plan includes reveals; the reveal column says why each row is shown or locked. Never the nonce or the preimage: those appear only in the public reveal, and sha256(preimage) = commitment_sha256 at GET /v1/track-record/verify?hash=.`,
    disclaimer: DISCLAIMER,
  });
});

/**
 * The private early reveal of one followed market (its uuid or venue id): its committed verdicts, never the nonce or the
 * preimage. A venue id costs one read more. When a commit is RESOLVED the read is priced (src/shadow/reveal.ts): one
 * charge_reveals() call (source read: charged once per tenant and market, a replay free, never refunded); a tenant that
 * cannot pay reads every RESOLVED commit locked (its commitment and hashes, verdict null) with the top-up pointer, and a
 * 200, never a 402: the next read after a top-up releases and charges it.
 */
v1.get("/shadow/:market_id", async (c) => {
  const ref = parseMarketRef(c.req.param("market_id"));
  if (!ref) return err(c, "validation_error", MARKET_REF_HINT, 400);
  const client = db(c.env);
  const id = await marketIdOf(client, ref);
  if ("error" in id) return storeDown(c, "market store");
  if (!id.id) return err(c, "not_found", "market not found", 404);
  // The same entitlement as the webhooks (followBlock): a follow above the plan's limit reads nothing either.
  const ent = await followEntitlements(client, id.id, c.get("auth").tenantId);
  if (ent.error) return storeDown(c, "follow store");
  const follow = ent.rows[0];
  if (!follow) return err(c, "not_found", "not following this market (POST /v1/markets/:id/follow first)", 404);
  const block = followBlock(follow);
  if (block) {
    const why = block === "over_follow_limit"
      ? `this follow is number ${follow.open_rank} of your follows of open markets, above this plan's limit of ${followCap(follow.plan)}; unfollow other markets or change plans`
      : "the evaluation has ended: no live key remains on this account";
    return err(c, "validation_error", `early reveal not available: ${why}`, 403);
  }
  const [{ data: market, error: me }, { data: commits, error: ce }] = await Promise.all([
    client.from("markets").select("id, platform, external_id, status, deadline_utc").eq("id", id.id).maybeSingle(),
    client.from("bot_posts").select("id, commitment_sha256, created_at, channel, telegram_date, payload")
      .eq("market_id", id.id).eq("kind", "commit").order("created_at", { ascending: false }).limit(50),
  ]);
  if (me || !market) return storeDown(c, "market store");
  if (ce) return storeDown(c, "commit store");
  const rows = (commits ?? []) as ShadowCommitRow[];
  let reveal: ShadowReveal | null = null;
  let balance: number | null = null;
  if (hasResolvedCommit(rows)) {
    const r = await revealEntitlements(client, [{ tenant_id: follow.tenant_id, market_id: id.id, plan: follow.plan }], { resolved: true, source: "read" });
    const a = r.answers[0]!;
    reveal = { access: revealAccess(a), locked: lockedReveal(a, topUp(c.env, publicBase(c.env, c.req.url)), id.id) };
    balance = a.balance;
    await afterRevealRead(c, r.answers, r.error, `GET /v1/shadow/${id.id}`);
  }
  return ok(c, { ...shapeShadow(market as ShadowMarket, rows, reveal), credits_charged: reveal?.access.credits_charged ?? 0, balance });
});

v1.get("/resolutions/:id", async (c) => {
  const { data } = await db(c.env).from("resolutions").select("*").eq("id", c.req.param("id")).eq("tenant_id", c.get("auth").tenantId).maybeSingle();
  if (!data) return err(c, "not_found", "resolution not found", 404);
  return ok(c, resolutionBody(data));
});
v1.get("/account", async (c) => {
  const auth = c.get("auth");
  const { data: t } = await db(c.env).from("tenants").select("id, display_name, plan, credits_balance, low_credit_notified_at, watch_limit, strict_v0, wallet_address, created_at").eq("id", auth.tenantId).single();
  return ok(c, { tenant: t, key: { id: auth.keyId, environment: auth.environment, requests_today: auth.requestsToday, daily_cap: auth.dailyCap } });
});
v1.get("/usage", async (c) => {
  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? "30")));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const client = db(c.env);
  const [{ data: ledger }, { data: res }] = await Promise.all([
    client.from("credit_ledger").select("delta, reason, created_at").eq("tenant_id", c.get("auth").tenantId).gte("created_at", since).order("created_at", { ascending: false }).limit(1000),
    client.from("resolutions").select("determination_basis, resolution_status, credits_charged, created_at").eq("tenant_id", c.get("auth").tenantId).gte("created_at", since).eq("status_row", "complete").limit(5000),
  ]);
  const byReason: Record<string, number> = {};
  for (const l of ledger ?? []) byReason[l.reason as string] = (byReason[l.reason as string] ?? 0) + Number(l.delta);
  const byBasis: Record<string, number> = {};
  // keyed by the public route name: precheck | structured | web_evidence
  for (const r of res ?? []) { const k = `${publicBasis(r.determination_basis) ?? "precheck"}/${r.resolution_status}`; byBasis[k] = (byBasis[k] ?? 0) + 1; }
  return ok(c, { window_days: days, credits_by_reason: byReason, resolutions_by_route: byBasis, recent_ledger: (ledger ?? []).slice(0, 50) });
});
/**
 * Where and how to pay, with the rates the database credits at (app_config payg_tiers, else the flat CREDITS_PER_USDC
 * credit_from_deposit is passed) and the plan §11 packs they buy. Tiers the database would refuse are never quoted.
 * Only while USDC_DEPOSITS_OFFERED is exactly "1": otherwise 503 before anything is read, with the card pointer instead
 * (no third-party USDC is solicited; the deposit scan is unchanged).
 */
v1.get("/payments/address", async (c) => {
  const cfg = parseConfig(c.env);
  if (!usdcDepositsOffered(c.env)) {
    const top = topUp(c.env, publicBase(c.env, c.req.url));
    return err(c, "UPSTREAM_UNAVAILABLE", `${USDC_NOT_OFFERED}. ${topUpText(top)}`, 503, { extra: { error_reason: "USDC_NOT_OFFERED", top_up: top } });
  }
  if (!c.env.USDC_RECEIVING_ADDRESS) return err(c, "UPSTREAM_UNAVAILABLE", "USDC deposits are not enabled yet; contact support for a credit grant.", 503);
  const client = db(c.env);
  const [{ data: t }, { data: row, error: ce }] = await Promise.all([
    client.from("tenants").select("wallet_address").eq("id", c.get("auth").tenantId).single(),
    client.from("app_config").select("value").eq("key", "payg_tiers").maybeSingle(),
  ]);
  if (ce) return storeDown(c, "pricing");
  const eff = effectiveTiers((row?.value as string | undefined) ?? null, cfg.creditsPerUsdc);
  if ("error" in eff) {
    await alert(c.env, "payg_tiers_invalid", `${eff.error}. payg_credits_per_usdc() refuses it too, so no deposit is credited until app_config payg_tiers is fixed.`, { dedupMinutes: 60 });
    return err(c, "UPSTREAM_UNAVAILABLE", "pricing is unavailable; retry shortly", 503);
  }
  const tiers = [...eff.tiers].sort((a, b) => b.min_usdc - a.min_usdc);
  return ok(c, {
    chain: "base", token: "USDC", token_contract: cfg.usdcContract, receiving_address: c.env.USDC_RECEIVING_ADDRESS, registered_sender_wallet: t?.wallet_address ?? null,
    credits_per_usdc: paygRate(0n, tiers), payg_tiers: tiers, packs: packQuotes(tiers),
    confirmation_policy: "credited when the transfer's block is at or below Base's `safe` tag (typically 5-10 minutes) at the rate of the tier its amount reaches (floor(amount x credits_per_usdc)); deposits from an unregistered wallet are held until mapped",
    register_wallet: "GET /v1/account/wallet/challenge?address=<your 0x address>, sign the message with that wallet (personal_sign), then POST /v1/account/wallet {challenge_id, signature}",
  });
});

// ---- signed wallet registration (plan §16.4 P3 step 3) ------------------------------------------------------------

const WalletAddress = z.string().regex(WALLET_ADDRESS, "address must be 0x followed by 40 hex characters");
const WalletBody = z.strictObject({
  challenge_id: z.uuid(),
  signature: z.string().regex(SIGNATURE, "signature must be the 65-byte 0x-hex personal_sign signature"),
});
const RegisterRow = z.object({ result: z.enum(REGISTER_RESULTS), address: z.string().nullable(), previous_address: z.string().nullable() });

/**
 * A single-use challenge for a wallet the tenant controls (the one it sends USDC from, while USDC deposits are offered:
 * only then does the answer say so). One subrequest: the insert.
 */
v1.get("/account/wallet/challenge", async (c) => {
  const a = WalletAddress.safeParse(c.req.query("address"));
  if (!a.success) return err(c, "validation_error", `address: ${a.error.issues[0]?.message ?? "required"}`, 400);
  const tenantId = c.get("auth").tenantId;
  const address = a.data.toLowerCase();
  const nonce = newNonce();
  const issuedAt = new Date().toISOString();
  const message = challengeMessage({ tenantId, address, nonce, issuedAt });
  const { data, error } = await db(c.env).from("wallet_challenges").insert({ tenant_id: tenantId, address, nonce, message }).select("id, expires_at").single();
  if (error || !data) return storeDown(c, "wallet challenge store (no challenge was issued)");
  return ok(c, {
    challenge_id: data.id, address, message, nonce, issued_at: issuedAt, expires_at: data.expires_at,
    sign: `EIP-191 personal_sign of \`message\`, exactly as given, with the wallet at \`address\`${usdcDepositsOffered(c.env) ? " (the one that will send USDC)" : ""}`,
    submit: "POST /v1/account/wallet {challenge_id, signature}; the challenge is single use",
  });
});

/**
 * Register the wallet that signed the challenge. Subrequests: the challenge read, then register_wallet() (single use,
 * refuses an address another tenant holds, one transaction). The signature is checked here, between the two.
 */
v1.post("/account/wallet", async (c) => {
  const b = WalletBody.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return err(c, "validation_error", b.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ").slice(0, 400), 400);
  const tenantId = c.get("auth").tenantId;
  const client = db(c.env);
  const refuse = (r: Exclude<RegisterResult, "registered">, address: string | null) => {
    const x = registerAnswer(r, address);
    return err(c, x.status === 404 ? "not_found" : "validation_error", x.message, x.status, { extra: { error_reason: x.reason } });
  };
  const { data: ch, error } = await client.from("wallet_challenges").select("id, address, message, expires_at, used_at").eq("id", b.data.challenge_id).eq("tenant_id", tenantId).maybeSingle();
  if (error) return storeDown(c, "wallet challenge store");
  if (!ch) return refuse("not_found", null);
  if (ch.used_at) return refuse("used", ch.address as string);
  if (Date.parse(ch.expires_at as string) <= Date.now()) return refuse("expired", ch.address as string);
  if (!(await signedBy(ch.address as string, ch.message as string, b.data.signature))) {
    return err(c, "validation_error", `the signature is not ${ch.address}'s personal_sign of this challenge's message: sign the message exactly as issued, with that wallet`, 400, { extra: { error_reason: "bad_signature" } });
  }
  let row: z.infer<typeof RegisterRow>;
  try {
    const out = await rpc<unknown>(client, "register_wallet", { p_challenge: ch.id, p_tenant: tenantId });
    row = RegisterRow.parse(Array.isArray(out) ? out[0] : out);
  } catch {
    return storeDown(c, "wallet registration (nothing was registered)");
  }
  if (row.result !== "registered") return refuse(row.result, row.address);
  return ok(c, { wallet_address: row.address, previous_wallet_address: row.previous_address, registered: true, message: registerAnswer("registered", row.address, usdcDepositsOffered(c.env)).message });
});
v1.post("/keys/rotate", async (c) => {
  const auth = c.get("auth");
  const client = db(c.env);
  const key = await mintKey(auth.environment);
  const exp = rotationExpiry(auth.expiresAt, Date.now());
  const { data: k, error } = await client.from("api_keys").insert({ tenant_id: auth.tenantId, key_hash: key.hash, key_prefix: key.prefix, name: "rotated", environment: auth.environment, scopes: auth.scopes, daily_cap: auth.dailyCap, expires_at: exp.newKey }).select("id").single();
  if (error || !k) return err(c, "internal_error", error?.message ?? "key insert failed", 500);
  await client.from("api_keys").update({ expires_at: exp.oldKey }).eq("id", auth.keyId);
  const old = extractApiKey(c); if (old) await invalidateKeyCache(await sha256Hex(old));
  return ok(c, { key: key.raw, key_id: k.id, expires_at: exp.newKey, note: `Shown once. The previous key expires at ${exp.oldKey}.${exp.newKey ? " The new key keeps the previous key's expiry: rotation never extends a key." : ""}` }, 201);
});

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { parseConfig } from "../env";
import { ok, err, waitUntilOf } from "./envelope";
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
import { followBlock, followCap, followEntitlements, followMarket, followRefusal, Plan, shapeShadow, type FollowAnswer, type FollowTarget, type ShadowCommitRow, type ShadowMarket } from "../shadow/follows";
import { subscribes } from "../webhooks/deliver";
import { noteCharge } from "../billing/events";
import { effectiveTiers, packQuotes, paygRate } from "../billing/tiers";
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

function verdictResponse(c: Parameters<typeof ok>[0], auth: AuthContext, v: Verdict, extra: Record<string, unknown>) {
  if (auth.strictV0) {
    const s = toStrictV0(v);
    if (s.kind === "http") return err(c, s.code, s.message, s.status, { retryAfterSeconds: 30 });
    return ok(c, { ...s.body, ...extra });
  }
  return ok(c, { ...v, ...extra });
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
      const s = await runWatch(c.env, cfg, w.id as string, { waitUntil: waitUntilOf(c), dispatch: "tenant_fetch" });
      if (s.resolution_id) {
        const { data: r } = await client.from("resolutions").select("*").eq("id", s.resolution_id).single();
        return ok(c, { request_id: s.resolution_id, watch: s, resolution: r });
      }
      if (s.outcome === "failure") return err(c, "UPSTREAM_UNAVAILABLE", `fetch failed: ${s.detail}`, 503);
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
  if (!br.ok) return err(c, "insufficient_credits", `This request costs ${amount} credit(s); balance is ${br.balance}. Top up at GET /v1/payments/address.`, 402, { extra: { balance: br.balance, price_credits: amount, route: plan.route } });

  // 4. resolve
  let rt: RuntimeOutput;
  try {
    rt = await resolveWithRuntime(c.env, cfg, { marketId: market.id, market, evidence, evidenceId, mode: "tenant", tenantId: auth.tenantId, apiKeyId: auth.keyId, requestId: br.request_id, creditsCharged: br.charged });
  } catch {
    // ResolutionNotRecordedError, the runtime's only throw: it alerted, ran the Jev accounting and marked the stub failed.
    const refunded = br.charged > 0 ? await refundOrAlert(c.env, client, br.request_id, auth.tenantId, br.charged, "a verdict that was not recorded") : 0;
    return err(c, "UPSTREAM_UNAVAILABLE", `the verdict for request ${br.request_id} could not be recorded${refunded > 0 ? `; the ${refunded} credit(s) charged were refunded` : ""}. Send the request again with a new Idempotency-Key.`, 503, { retryAfterSeconds: 30, extra: { error_reason: "VERDICT_NOT_RECORDED", credits_refunded: refunded } });
  }
  let refunded = 0;
  if (rt.result.verdict.error_code === "UPSTREAM_UNAVAILABLE" && br.charged > 0) refunded = await refundOrAlert(c.env, client, br.request_id, auth.tenantId, br.charged, "an UPSTREAM_UNAVAILABLE verdict");
  // The charge stands: credits.low once per crossing, off the response path (noteCharge: 1 subrequest, 3 at the crossing).
  if (br.charged - refunded > 0) {
    const low = noteCharge(c.env, auth.tenantId, br.request_id);
    const wu = waitUntilOf(c);
    if (wu) wu(low); else await low;
  }
  return verdictResponse(c, auth, rt.result.verdict, { request_id: br.request_id, credits_charged: br.charged - refunded, credits_refunded: refunded, balance: br.balance + refunded, route: plan.route });
});

function rowToVerdict(r: Record<string, unknown>) {
  return { market_id: r.market_id, resolution_status: r.resolution_status, winning_outcome: r.winning_outcome, confidence_score: Number(r.confidence_score), error_code: r.error_code, error_reason: r.error_reason, caveats: r.caveats, determination_basis: r.determination_basis, checks: r.checks, jev_model: r.jev_model, thresholds_version: r.thresholds_version, latency_ms: r.duration_ms };
}

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
  const { data } = await db(c.env).from("resolutions").select("id, resolution_status, winning_outcome, confidence_score, error_code, error_reason, caveats, determination_basis, jev_model, thresholds_version, credits_charged, credits_refunded, created_at").eq("market_id", c.req.param("id")).eq("tenant_id", c.get("auth").tenantId).eq("status_row", "complete").order("created_at", { ascending: false }).limit(50);
  return ok(c, { resolutions: data ?? [] });
});

// ---- follows and the private early reveal (plan §17.3 P7-lite) ---------------------------------------------------

const MarketId = z.string().uuid();
const SHADOW_EVENTS = ["shadow.committed", "shadow.revealed"] as const;
/** GET /v1/follows returns the newest this many; active_follows is the full count. */
const FOLLOWS_PAGE = 1000;
const storeDown = (c: Parameters<typeof ok>[0], what: string) => err(c, "UPSTREAM_UNAVAILABLE", `${what} unavailable; retry shortly.`, 503);

/** The tenant's plan as tenants.plan says now (auth caches the key for up to 60 s; a plan change applies at once). */
async function tenantPlan(client: Db, tenantId: string): Promise<{ plan: Plan } | { error: string }> {
  const { data, error } = await client.from("tenants").select("plan").eq("id", tenantId).single();
  if (error) return { error: error.message };
  const plan = Plan.safeParse(data?.plan);
  return plan.success ? { plan: plan.data } : { error: `unknown plan ${JSON.stringify(data?.plan)}` };
}

/**
 * Follow a public shadow market: private early reveals by webhook (shadow.committed, shadow.revealed) and GET /v1/shadow/:id.
 * The answer counts the tenant's endpoints that will receive shadow.committed: an endpoint registered before these events
 * existed was subscribed to the old defaults, and a follow with no subscribed endpoint must say so rather than deliver
 * nothing silently.
 */
v1.post("/markets/:id/follow", async (c) => {
  const auth = c.get("auth");
  const id = MarketId.safeParse(c.req.param("id"));
  if (!id.success) return err(c, "validation_error", "market id must be a uuid", 400);
  const client = db(c.env);
  const [{ data: m, error: me }, plan, { data: eps, error: ee }] = await Promise.all([
    client.from("markets").select("id, tenant_id, is_test, status, deleted_at").eq("id", id.data).maybeSingle(),
    tenantPlan(client, auth.tenantId),
    // the endpoints enqueueEvent would read for this tenant
    client.from("webhook_endpoints").select("id, events").eq("tenant_id", auth.tenantId).eq("active", true).is("deleted_at", null),
  ]);
  if (me || ee || "error" in plan) return storeDown(c, "market, tenant or webhook store");
  const refusal = followRefusal(m as FollowTarget | null, auth.tenantId);
  if (refusal) return err(c, refusal.code, refusal.message, refusal.status);
  const cap = followCap(plan.plan);
  const subscribed = ((eps ?? []) as Array<{ events: string[] | null }>).filter((e) => subscribes(e, "shadow.committed")).length;
  let a: FollowAnswer;
  // follow_market is one transaction: an error means no follow was recorded.
  try { a = await followMarket(client, auth.tenantId, id.data, cap); }
  catch { return storeDown(c, "follow store (no follow was recorded)"); }
  const followed = (following: { follow_id: string; active: number }, created: boolean) => ok(c, {
    follow_id: following.follow_id, market_id: id.data, following: true, already_following: !created, follows_counted: following.active, follow_limit: cap,
    events: SHADOW_EVENTS, read: `/v1/shadow/${id.data}`, endpoints_subscribed: subscribed,
    note: "Verdicts arrive as shadow.committed on every active endpoint subscribed to it (POST /v1/webhooks) and at the read URL. Private early reveal, excluded from the public record.",
    ...(subscribed === 0 ? { warning: `No active webhook endpoint of this account is subscribed to shadow.committed, so no webhook will arrive for this follow; read /v1/shadow/${id.data}, or register an endpoint whose events include ${SHADOW_EVENTS.join(" and ")} (POST /v1/webhooks). An endpoint's events are fixed when it is registered.` } : {}),
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
  const id = MarketId.safeParse(c.req.param("id"));
  if (!id.success) return err(c, "validation_error", "market id must be a uuid", 400);
  const { data, error } = await db(c.env).from("market_follows").update({ deleted_at: new Date().toISOString() })
    .eq("tenant_id", c.get("auth").tenantId).eq("market_id", id.data).is("deleted_at", null).select("id");
  if (error) return storeDown(c, "follow store");
  if (!data?.length) return err(c, "not_found", "not following this market", 404);
  return ok(c, { unfollowed: id.data });
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

/** The private early reveal of one followed market: its committed verdicts, never the nonce or the preimage. */
v1.get("/shadow/:market_id", async (c) => {
  const id = MarketId.safeParse(c.req.param("market_id"));
  if (!id.success) return err(c, "validation_error", "market id must be a uuid", 400);
  const client = db(c.env);
  // The same entitlement as the webhooks (followBlock): a follow above the plan's limit reads nothing either.
  const ent = await followEntitlements(client, id.data, c.get("auth").tenantId);
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
    client.from("markets").select("id, platform, external_id, status, deadline_utc").eq("id", id.data).maybeSingle(),
    client.from("bot_posts").select("id, commitment_sha256, created_at, channel, telegram_date, payload")
      .eq("market_id", id.data).eq("kind", "commit").order("created_at", { ascending: false }).limit(50),
  ]);
  if (me || !market) return storeDown(c, "market store");
  if (ce) return storeDown(c, "commit store");
  return ok(c, shapeShadow(market as ShadowMarket, (commits ?? []) as ShadowCommitRow[]));
});

v1.get("/resolutions/:id", async (c) => {
  const { data } = await db(c.env).from("resolutions").select("*").eq("id", c.req.param("id")).eq("tenant_id", c.get("auth").tenantId).maybeSingle();
  if (!data) return err(c, "not_found", "resolution not found", 404);
  return ok(c, { request_id: data.id, ...rowToVerdict(data), credits_charged: data.credits_charged, credits_refunded: data.credits_refunded, created_at: data.created_at });
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
  for (const r of res ?? []) { const k = `${r.determination_basis ?? "precheck"}/${r.resolution_status}`; byBasis[k] = (byBasis[k] ?? 0) + 1; }
  return ok(c, { window_days: days, credits_by_reason: byReason, resolutions_by_route: byBasis, recent_ledger: (ledger ?? []).slice(0, 50) });
});
/**
 * Where and how to pay, with the rates the database credits at (app_config payg_tiers, else the flat CREDITS_PER_USDC
 * credit_from_deposit is passed) and the plan §11 packs they buy. Tiers the database would refuse are never quoted.
 */
v1.get("/payments/address", async (c) => {
  const cfg = parseConfig(c.env);
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

/** A single-use challenge for the wallet the tenant sends USDC from. One subrequest: the insert. */
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
    sign: "EIP-191 personal_sign of `message`, exactly as given, with the wallet at `address` (the one that will send USDC)",
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
  return ok(c, { wallet_address: row.address, previous_wallet_address: row.previous_address, registered: true, message: registerAnswer("registered", row.address).message });
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

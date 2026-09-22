import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { parseConfig } from "../env";
import { ok, err } from "./envelope";
import { authenticate, rateLimit, extractApiKey, invalidateKeyCache, type AuthContext } from "./auth";
import { db, rpc } from "../db/supabase";
import { MarketRegistration, EvidenceInput, type Verdict } from "../resolve/schema";
import { planRoute } from "../resolve";
import { thresholdsFromEnv } from "../resolve/thresholds";
import { resolveWithRuntime, JevUnavailableError } from "../resolve/runtime";
import { toStrictV0 } from "../resolve/verdict";
import { registerMarket } from "../markets/register";
import { runWatch } from "../ingest/watch";
import { sha256Hex } from "../resolve/text";
import type { MarketRow } from "../ingest/types";

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
  c.executionCtx.waitUntil((async () => {
    const body = await clone.text();
    const hash = await sha256Hex(body);
    await db(c.env).from("api_request_log").insert({
      request_id: c.get("requestId"), api_key_id: auth?.keyId ?? null, tenant_id: auth?.tenantId ?? null, auth_source: "database",
      route: c.req.routePath || c.req.path, method: c.req.method, status: res.status, duration_ms: Date.now() - t0,
      redacted_params: { path: c.req.path, query_keys: [...new URL(c.req.url).searchParams.keys()], content_length: c.req.header("content-length") ?? null },
      response_sha256: hash, client_colo: ((c.req.raw as Request & { cf?: { colo?: string } }).cf?.colo) ?? null, user_agent: (c.req.header("user-agent") ?? "").slice(0, 200),
    });
  })().catch((e) => console.error("api_request_log failed", String(e))));
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
      const s = await runWatch(c.env, cfg, w.id as string);
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
    const reg = await registerMarket(c.env, cfg, { ...body.market!, platform: body.market!.platform ?? "custom" }, auth.tenantId, { createWatches: false });
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
    if (!r || r.status_row !== "complete") return ok(c, { request_id: br.request_id, status_row: r?.status_row ?? "pending", message: "original request still in flight" }, 202);
    return ok(c, { request_id: br.request_id, ...rowToVerdict(r), replayed: true, credits_charged: r.credits_charged, balance: br.balance });
  }
  if (!br.ok) return err(c, "insufficient_credits", `This request costs ${amount} credit(s); balance is ${br.balance}. Top up at GET /v1/payments/address.`, 402, { extra: { balance: br.balance, price_credits: amount, route: plan.route } });

  // 4. resolve
  const rt = await resolveWithRuntime(c.env, cfg, { marketId: market.id, market, evidence, evidenceId, mode: "tenant", tenantId: auth.tenantId, apiKeyId: auth.keyId, requestId: br.request_id, creditsCharged: br.charged });
  let refunded = 0;
  if (rt.result.verdict.error_code === "UPSTREAM_UNAVAILABLE" && br.charged > 0) {
    refunded = await rpc<number>(client, "refund_credits", { p_request_id: br.request_id }).catch(() => 0);
  }
  return verdictResponse(c, auth, rt.result.verdict, { request_id: br.request_id, credits_charged: br.charged - refunded, credits_refunded: refunded, balance: br.balance + refunded, route: plan.route });
});

function rowToVerdict(r: Record<string, unknown>) {
  return { market_id: r.market_id, resolution_status: r.resolution_status, winning_outcome: r.winning_outcome, confidence_score: Number(r.confidence_score), error_code: r.error_code, error_reason: r.error_reason, caveats: r.caveats, determination_basis: r.determination_basis, checks: r.checks, jev_model: r.jev_model, thresholds_version: r.thresholds_version, latency_ms: r.duration_ms };
}

v1.post("/markets", async (c) => {
  const cfg = parseConfig(c.env);
  const auth = c.get("auth");
  const client = db(c.env);
  const body = (await c.req.json().catch(() => null)) as unknown;
  const { count } = await client.from("watches").select("id, markets!inner(tenant_id)", { count: "exact", head: true }).eq("markets.tenant_id", auth.tenantId).eq("active", true).is("deleted_at", null);
  const { data: t } = await client.from("tenants").select("watch_limit").eq("id", auth.tenantId).single();
  const limit = (t?.watch_limit as number | undefined) ?? 5;
  if ((count ?? 0) >= limit) return err(c, "validation_error", `watch limit (${limit}) reached for this plan`, 403, { extra: { watch_limit: limit, active_watches: count } });
  try {
    const r = await registerMarket(c.env, cfg, body, auth.tenantId);
    return ok(c, { market_id: r.marketId, status: r.status, reasons: r.reasons, watches: r.watches }, 201);
  } catch (e) { return err(c, "validation_error", String(e).slice(0, 400), 400); }
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
v1.get("/resolutions/:id", async (c) => {
  const { data } = await db(c.env).from("resolutions").select("*").eq("id", c.req.param("id")).eq("tenant_id", c.get("auth").tenantId).maybeSingle();
  if (!data) return err(c, "not_found", "resolution not found", 404);
  return ok(c, { request_id: data.id, ...rowToVerdict(data), credits_charged: data.credits_charged, credits_refunded: data.credits_refunded, created_at: data.created_at });
});
v1.get("/account", async (c) => {
  const auth = c.get("auth");
  const { data: t } = await db(c.env).from("tenants").select("id, display_name, plan, credits_balance, watch_limit, strict_v0, wallet_address, created_at").eq("id", auth.tenantId).single();
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
v1.get("/payments/address", async (c) => {
  const cfg = parseConfig(c.env);
  const { data: t } = await db(c.env).from("tenants").select("wallet_address").eq("id", c.get("auth").tenantId).single();
  if (!c.env.USDC_RECEIVING_ADDRESS) return err(c, "UPSTREAM_UNAVAILABLE", "USDC deposits are not enabled yet; contact support for a credit grant.", 503);
  return ok(c, { chain: "base", token: "USDC", token_contract: cfg.usdcContract, receiving_address: c.env.USDC_RECEIVING_ADDRESS, registered_sender_wallet: t?.wallet_address ?? null, credits_per_usdc: cfg.creditsPerUsdc, confirmation_policy: "credited when the transfer's block is at or below Base's `safe` tag (typically 5-10 minutes); deposits from an unregistered wallet are held until mapped" });
});
v1.post("/keys/rotate", async (c) => {
  const auth = c.get("auth");
  const client = db(c.env);
  const raw = `rsl_${auth.environment}_${randomKeyBody()}`;
  const hash = await sha256Hex(raw);
  const { data: k, error } = await client.from("api_keys").insert({ tenant_id: auth.tenantId, key_hash: hash, key_prefix: raw.slice(0, 12) + "...", name: "rotated", environment: auth.environment, scopes: auth.scopes, daily_cap: auth.dailyCap }).select("id").single();
  if (error || !k) return err(c, "internal_error", error?.message ?? "key insert failed", 500);
  await client.from("api_keys").update({ expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() }).eq("id", auth.keyId);
  const old = extractApiKey(c); if (old) await invalidateKeyCache(await sha256Hex(old));
  return ok(c, { key: raw, key_id: k.id, note: "Shown once. The previous key expires in 24 hours." }, 201);
});

export function randomKeyBody(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  let s = ""; for (const b of bytes) s += chars[b % chars.length]; return s;
}

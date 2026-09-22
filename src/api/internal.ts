import { Hono } from "hono";
import type { Env } from "../env";
import { parseConfig } from "../env";
import { ok, err } from "./envelope";
import { safeEqual, bearer } from "./admin";
import { hmacHex } from "../resolve/text";
import { runWatch } from "../ingest/watch";
import { registerMarket } from "../markets/register";
import { db, rpc } from "../db/supabase";
import { makeJevCaller } from "../jev/client";
import { sha256Hex } from "../resolve/text";
import { randomKeyBody } from "./v1";

type Vars = { requestId: string; schemaVersion: string };
export const internal = new Hono<{ Bindings: Env; Variables: Vars }>();

const isAdmin = (c: { req: { header: (n: string) => string | undefined }; env: Env }) => { const k = bearer(c as never); return !!k && safeEqual(k, c.env.ADMIN_API_KEY); };

/** pg_net -> one watch poll. Signature = HMAC(secret, "<watch_id>|<YYYY-MM-DDTHH:MM>") over the dispatch minute (+-3 min tolerance). Admin bearer also accepted for manual runs. */
internal.post("/watch/:id", async (c) => {
  const id = c.req.param("id");
  if (!isAdmin(c)) {
    const sig = c.req.header("x-internal-signature") ?? "";
    const minute = c.req.header("x-internal-minute") ?? "";
    const t = Date.parse(minute + ":00Z");
    if (!sig || !Number.isFinite(t) || Math.abs(Date.now() - t) > 3 * 60_000) return err(c, "forbidden", "bad or stale internal signature", 403);
    const expected = await hmacHex(c.env.INTERNAL_HMAC_SECRET, `${id}|${minute}`);
    if (!safeEqual(sig, expected)) return err(c, "forbidden", "invalid internal signature", 403);
  }
  const cfg = parseConfig(c.env);
  const s = await runWatch(c.env, cfg, id);
  return ok(c, s, s.outcome === "failure" ? 500 : 200);
});

internal.post("/markets", async (c) => {
  if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403);
  const cfg = parseConfig(c.env);
  const body = (await c.req.json().catch(() => null)) as { market?: unknown; tenant_id?: string | null } | null;
  if (!body?.market) return err(c, "validation_error", "body.market required", 400);
  try {
    const r = await registerMarket(c.env, cfg, body.market, body.tenant_id ?? null);
    return ok(c, r, 201);
  } catch (e) {
    return err(c, "validation_error", String(e).slice(0, 400), 400);
  }
});

internal.get("/markets/:id", async (c) => {
  if (!isAdmin(c)) return err(c, "forbidden", "admin key required", 403);
  const client = db(c.env);
  const id = c.req.param("id");
  const [m, w, e, r, l] = await Promise.all([
    client.from("markets").select("*").eq("id", id).single(),
    client.from("watches").select("id, source_kind, source_ref, poll_interval_s, next_poll_at, lease_until, etag, cursor, coverage, last_evidence_hash, last_polled_at, last_error, consecutive_errors, backlog").eq("market_id", id),
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
  const raw = `rsl_${b.environment ?? "test"}_${randomKeyBody()}`;
  const { data: k, error: ke } = await client.from("api_keys").insert({ tenant_id: t.id, key_hash: await sha256Hex(raw), key_prefix: raw.slice(0, 12) + "...", name: "initial", environment: b.environment ?? "test", daily_cap: 1000 }).select("id").single();
  if (ke || !k) return err(c, "internal_error", ke?.message ?? "key insert failed", 500);
  return ok(c, { tenant_id: t.id, key_id: k.id, key: raw, note: "Shown once." }, 201);
});

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

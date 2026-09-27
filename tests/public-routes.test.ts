/**
 * The /v1 routes that serve a tenant's verdicts answer in public names (src/api/public-names.ts; plan §2.1, the model
 * vendor's MCA §2.3(a)): POST /v1/resolve (200, 402, the strict_v0 503, both idempotent replays, fetch:true and its
 * failure), GET /v1/resolutions/:id, GET /v1/markets/:id/resolutions and GET /v1/usage, body and headers. The resolver
 * is the real one with a stubbed model call, and the resolutions row is written with the internal names exactly as
 * src/resolve/runtime.ts writes it, so every answer here is mapped from stored internal values.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, strictV0: false, blocked: null as null | "PAID_JEV_DISABLED" }));
vi.mock("../src/db/supabase", () => ({
  db: () => h.db.client,
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/api/auth", () => ({
  authenticate: async () => ({ ok: true, auth: { keyId: "k1", tenantId: "t1", plan: "payg", strictV0: h.strictV0, environment: "test", scopes: [], requestsToday: 0, dailyCap: 1000 } }),
  rateLimit: async () => ({ allowed: true }),
  extractApiKey: () => null,
  invalidateKeyCache: async () => undefined,
}));
vi.mock("../src/markets/register", () => ({ registerMarket: async () => ({ marketId: "m1", status: "open", reasons: [], watches: [] }) }));
vi.mock("../src/ingest/watch", () => ({ runWatch: vi.fn() }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));
vi.mock("../src/billing/events", () => ({ noteCharge: vi.fn(async () => undefined) }));
vi.mock("../src/resolve/runtime", async () => {
  const resolve = await vi.importActual<typeof import("../src/resolve")>("../src/resolve");
  const { DEFAULT_THRESHOLDS } = await vi.importActual<typeof import("../src/resolve/thresholds")>("../src/resolve/thresholds");
  class ResolutionNotRecordedError extends Error {}
  const answers = {
    outcome: { type: "choice", choice: "OPTION_A", confidence: 0.9, probabilities: { OPTION_A: 0.92, OPTION_B: 0.05, NOT_DETERMINABLE: 0.03 } },
    same_subject: { type: "noul", noul: 0.95 }, states_fact_explicitly: { type: "noul", noul: 0.9 }, completed_not_planned: { type: "noul", noul: 0.9 },
    negated_or_reverted: { type: "noul", noul: 0.02 }, contradictory: { type: "noul", noul: 0.03 }, steering: { type: "noul", noul: 0.02 }, authority: { type: "score", score: 3 },
  };
  return {
    JevUnavailableError: resolve.JevUnavailableError, ResolutionNotRecordedError,
    // The real resolver (stubbed model call), then the row src/resolve/runtime.ts writes: internal names, model answers included.
    resolveWithRuntime: vi.fn(async (_env: unknown, _cfg: unknown, o: { marketId: string; market: never; evidence: never; requestId: string }) => {
      const result = await resolve.resolveMarket(
        { marketId: o.marketId, market: o.market, evidence: o.evidence, thresholds: DEFAULT_THRESHOLDS, spotlightSecret: "eval-spotlight-v1", model: "jev-1.13.0", jevBlocked: h.blocked },
        { jev: async () => ({ json: { model: "jev-1.13.0", answers, usage: { input_tokens: 900, output_tokens: 40 } }, latencyMs: 300 }) },
      );
      const v = result.verdict;
      const stub = h.db.tables.resolutions!.find((r) => r.id === o.requestId)!;
      Object.assign(stub, {
        market_id: o.marketId, mode: "tenant", status_row: "complete", resolution_status: v.resolution_status, winning_outcome: v.winning_outcome, confidence_score: v.confidence_score,
        error_code: v.error_code, error_reason: v.error_reason, caveats: v.caveats, determination_basis: v.determination_basis, checks: v.checks,
        jev_answers: result.jev?.response?.answers ?? null, jev_model: v.jev_model, thresholds_version: v.thresholds_version, duration_ms: v.latency_ms, jev_ms: result.jev?.latencyMs ?? null,
      });
      return { result, resolutionId: o.requestId, jevCalls: result.jev ? 1 : 0, jevCostUsd: 0 };
    }),
  };
});

import { v1 } from "../src/api/v1";
import { runWatch } from "../src/ingest/watch";
import { engineVersion, PublicVerdict } from "../src/api/public-names";
import { MarketRegistration } from "../src/resolve/schema";
import { sha256Hex } from "../src/resolve/text";

const NAMES = /jev|typesafe/i;
const ENGINE = engineVersion("jev-1.13.0")!;
// A deadline far ahead, so the inline evidence (fetched now) stays inside the window whenever this runs.
const market = MarketRegistration.parse({
  external_id: "t-1", condition: "Will PR #4821 in openai/openai-python be merged before 2031-01-01 00:00 UTC?", event_statement: "PR #4821 in openai/openai-python is merged",
  option_a: "Yes, merged before the deadline", option_b: "No, not merged before the deadline", positive_option: "OPTION_A", anchors: ["openai/openai-python", "#4821"],
  sources: [{ kind: "web_fetch", ref: "https://github.com/openai/openai-python" }], open_at: "2026-09-01T00:00:00Z", deadline_utc: "2031-01-01T00:00:00Z",
});
const body = JSON.stringify({ market, evidence: { source_kind: "web_fetch", source_url: "https://github.com/openai/openai-python/releases/tag/v1.52.0",
  text: "Release notes for openai/openai-python. Pull request #4821 (add retries to the streaming client) was merged by the maintainers on 2026-09-20 and shipped in v1.52.0. The change is live on PyPI and the changelog lists #4821 under Fixed." } });
const env = { JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "60", SPOTLIGHT_SECRET: "eval-spotlight-v1", SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized", INTERNAL_HMAC_SECRET: "x", ADMIN_API_KEY: "x", EVAL_REPORT_KEY: "x", JEV_PAID_ROUTES_ENABLED: "1" } as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const post = (idem: string, b = body) => v1.request("/resolve", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idem }, body: b }, env, ctx);
const get = (path: string) => v1.request(path, {}, env, ctx);
/** A stored market fetch:true runs a watch of (the body's market_id must be a uuid). */
const WATCHED = "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function newDb(balance = 100) {
  h.db = fakeDb({ markets: [{ id: "m1", tenant_id: "t1", ...market }, { id: WATCHED, tenant_id: "t1", ...market }], resolutions: [], tenants: [{ id: "t1", credits_balance: balance }], credit_ledger: [], api_request_log: [] }, {}, {
    rpc: {
      begin_resolution: async (db, a) => {
        const id = await sha256Hex(`${a.p_tenant}|${a.p_idempotency_key}`);
        if (balance < a.p_amount) return { data: [{ request_id: id, replayed: false, ok: false, balance, charged: 0 }], error: null };
        db.tables.resolutions!.push({ id, tenant_id: a.p_tenant, market_id: a.p_market, status_row: "pending", credits_charged: a.p_amount, credits_refunded: 0, created_at: new Date().toISOString() });
        return { data: [{ request_id: id, replayed: false, ok: true, balance: balance - a.p_amount, charged: a.p_amount }], error: null };
      },
      refund_credits: async (db, a) => {
        const row = db.tables.resolutions!.find((r) => r.id === a.p_request_id)!;
        row.credits_refunded = row.credits_charged;
        return { data: row.credits_charged, error: null };
      },
    },
  });
}
/** The body, parsed; every response read here is also checked for a header that names the model. */
async function read(res: Response): Promise<{ text: string; json: { ok: boolean; data: Row; error?: { code: string; message: string } } & Row }> {
  expect(JSON.stringify([...res.headers]), "response headers").not.toMatch(NAMES);
  const text = await res.text();
  return { text, json: JSON.parse(text) };
}
/** The verdict fields a stored row answers (a stored row carries no evidence summary: the replay never did). */
const VERDICT_KEYS = Object.keys(PublicVerdict.shape).filter((k) => k !== "evidence");
const verdictOf = (d: Row) => Object.fromEntries(VERDICT_KEYS.map((k) => [k, d[k]]));

beforeEach(() => { h.strictV0 = false; h.blocked = null; });

describe("POST /v1/resolve answers in public names", () => {
  it("200: the verdict (web_evidence, engine_version, web_evidence_call) and route web_evidence; the stored row keeps its internal names", async () => {
    newDb();
    const { text, json } = await read(await post("idem-1"));
    expect(json.ok).toBe(true);
    expect(text).not.toMatch(NAMES);
    expect(json.data).toMatchObject({ route: "web_evidence", credits_charged: 5, determination_basis: "web_evidence", engine_version: ENGINE });
    expect(json.data.checks).toContainEqual({ name: "web_evidence_call", pass: true, detail: expect.stringMatching(new RegExp(`^${ENGINE} 900 tokens \\d+ ms$`)) });
    expect(PublicVerdict.safeParse(json.data).success).toBe(true);
    expect(h.db.tables.resolutions![0]).toMatchObject({ determination_basis: "jev", jev_model: "jev-1.13.0" });
  });

  it("the idempotent replay, GET /v1/resolutions/:id and the market's history answer the same public verdict from the stored row", async () => {
    newDb();
    const first = (await read(await post("idem-2"))).json.data;
    const res = await post("idem-2");
    expect(res.headers.get("X-Idempotent-Replay")).toBe("true");
    const replay = await read(res);
    expect(replay.text).not.toMatch(NAMES);
    expect(replay.json.data).toMatchObject({ replayed: true });
    expect(verdictOf(replay.json.data)).toEqual(verdictOf(first));

    const one = await read(await get(`/resolutions/${first.request_id}`));
    expect(one.text).not.toMatch(NAMES);
    expect(verdictOf(one.json.data)).toEqual(verdictOf(first));
    expect(one.json.data).not.toHaveProperty("jev_answers");

    const history = await read(await get("/markets/m1/resolutions"));
    expect(history.text).not.toMatch(NAMES);
    expect(history.json.data.resolutions).toEqual([expect.objectContaining({ id: first.request_id, determination_basis: "web_evidence", engine_version: ENGINE })]);
    expect(Object.keys((history.json.data.resolutions as Row[])[0]!)).toEqual(["id", "resolution_status", "winning_outcome", "confidence_score", "error_code", "error_reason", "caveats", "determination_basis", "engine_version", "thresholds_version", "credits_charged", "credits_refunded", "created_at"]);
  });

  it("GET /v1/usage keys resolutions by the public route name", async () => {
    newDb();
    await post("idem-3");
    const usage = await read(await get("/usage"));
    expect(usage.text).not.toMatch(NAMES);
    expect(Object.keys(usage.json.data.resolutions_by_route as Row)).toEqual([expect.stringMatching(/^web_evidence\//)]);
  });

  it("402: route web_evidence at the top level", async () => {
    newDb(0);
    const { text, json } = await read(await post("idem-4"));
    expect(json).toMatchObject({ ok: false, error: { code: "insufficient_credits" }, route: "web_evidence", price_credits: 5 });
    expect(text).not.toMatch(NAMES);
  });

  it("the gated route: error_reason WEB_EVIDENCE_DISABLED, and the strict_v0 503 names it the same way", async () => {
    h.blocked = "PAID_JEV_DISABLED";
    newDb();
    const plain = await read(await post("idem-5"));
    expect(plain.json.data).toMatchObject({ resolution_status: "ERROR", error_code: "UPSTREAM_UNAVAILABLE", error_reason: "WEB_EVIDENCE_DISABLED", credits_refunded: 5 });
    expect(plain.text).not.toMatch(NAMES);
    expect(h.db.tables.resolutions![0]!.error_reason).toBe("PAID_JEV_DISABLED"); // stored as it was

    h.strictV0 = true;
    const strict = await read(await post("idem-6"));
    expect(strict.json).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: expect.stringContaining("(WEB_EVIDENCE_DISABLED)") } });
    expect(strict.text).not.toMatch(NAMES);
  });

  it("fetch:true: the resolution as GET /v1/resolutions/:id answers it and the run summary in public names, never the raw row", async () => {
    newDb();
    const first = (await read(await post("idem-7"))).json.data;
    h.db.tables.watches = [{ id: "w1", market_id: WATCHED, active: true, lease_until: null }];
    h.db.options.rpc!.lease_watch_now = async () => ({ data: new Date(Date.now() + 120_000).toISOString(), error: null });
    vi.mocked(runWatch).mockResolvedValueOnce({ watch_id: "w1", outcome: "failure", rows_written: 2, detail: "could not look: ERROR/NONE/PAID_JEV_DISABLED; change 0123456789ab kept pending", verdict: "ERROR/NONE/PAID_JEV_DISABLED", resolution_id: String(first.request_id), recorded: true });
    const res = await v1.request("/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ market_id: WATCHED, fetch: true }) }, env, ctx);
    const { text, json } = await read(res);
    expect(res.status).toBe(200);
    expect(text).not.toMatch(NAMES);
    expect(json.data.watch).toMatchObject({ verdict: "ERROR/NONE/WEB_EVIDENCE_DISABLED" });
    expect(verdictOf(json.data.resolution as Row)).toEqual(verdictOf(first));
    expect(json.data.resolution).not.toHaveProperty("jev_answers");
  });

  it("fetch:true that fails without a resolution: the 503 names the gated route by its public name", async () => {
    newDb();
    h.db.tables.watches = [{ id: "w1", market_id: WATCHED, active: true, lease_until: null }];
    h.db.options.rpc!.lease_watch_now = async () => ({ data: new Date(Date.now() + 120_000).toISOString(), error: null });
    vi.mocked(runWatch).mockResolvedValueOnce({ watch_id: "w1", outcome: "failure", rows_written: 0, detail: "Jev unavailable: jev-1.13.0 refused (PAID_JEV_DISABLED); TYPESAFE_API_KEY not configured", verdict: "ERROR/NONE/PAID_JEV_DISABLED", recorded: false }); // no resolution_id: nothing was recorded
    const res = await v1.request("/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ market_id: WATCHED, fetch: true }) }, env, ctx);
    const { text, json } = await read(res);
    expect(res.status).toBe(503);
    expect(json).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: expect.stringContaining("WEB_EVIDENCE_DISABLED") } });
    expect(json.error!.message).toMatch(/^fetch failed: /);
    expect(text).not.toMatch(NAMES);
  });

  it("the replay begin_resolution reports (a concurrent request completed between the lookup and the claim) answers the public verdict", async () => {
    newDb();
    const first = (await read(await post("idem-8"))).json.data;
    const stored = h.db.tables.resolutions!.find((r) => r.id === first.request_id)!;
    expect(stored).toMatchObject({ determination_basis: "jev", jev_model: "jev-1.13.0", jev_ms: 300 });
    // The step-0 lookup finds nothing; the claim then finds the row the concurrent request completed.
    h.db.options.rpc!.begin_resolution = async (db, a) => {
      const id = await sha256Hex(`${a.p_tenant}|${a.p_idempotency_key}`);
      db.tables.resolutions!.push({ ...structuredClone(stored), id });
      return { data: [{ request_id: id, replayed: true, ok: true, balance: 90, charged: 0 }], error: null };
    };
    const res = await post("idem-9");
    expect(res.headers.get("X-Idempotent-Replay")).toBe("true");
    const { text, json } = await read(res);
    expect(res.status).toBe(200);
    expect(text).not.toMatch(NAMES);
    expect(json.data).toMatchObject({ replayed: true, balance: 90, determination_basis: "web_evidence", engine_version: ENGINE });
    expect(verdictOf(json.data)).toEqual(verdictOf(first));
    expect(json.data).not.toHaveProperty("jev_answers");
    expect(json.data).not.toHaveProperty("jev_ms");
  });
});

/**
 * Customer-facing surfaces never name the model or its vendor (plan §2.1; the vendor's Master Customer Agreement
 * §2.3(a)). The public names live in src/api/public-names.ts; this file proves the pure mapping and each surface that
 * serves it: GET /health, the verdict contract and the strict_v0 message, the track record, verify, every webhook event
 * (queued and re-sent from a row stored before the mapping), the config_error body and the OpenAPI document. The /v1
 * routes that serve verdicts are proven in tests/public-routes.test.ts, the Telegram posts in tests/post.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", () => ({
  db: () => h.db.client,
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));

import { app } from "../src/index";
import {
  engineVersion, publicBasis, publicCheck, publicErrorReason, publicEventPayload, publicRoute, publicText, publicTrackRecordRow, publicVerdictRecord,
  publicWatchSummary, toPublicVerdict, venueBasis, PublicVerdict,
} from "../src/api/public-names";
import { venueBasis as followsVenueBasis } from "../src/shadow/follows";
import { EvidenceInput, MarketRegistration, Verdict } from "../src/resolve/schema";
import { DEFAULT_THRESHOLDS } from "../src/resolve/thresholds";
import { resolveMarket, JevUnavailableError } from "../src/resolve";
import { toStrictV0 } from "../src/resolve/verdict";
import { shapeVerify, trackRecordRows, TRACK_RECORD_CACHE_PATH, type VerifyCommit } from "../src/api/public";
import { buildPreimage, buildReveal, committedFields, type CommittedVerdict } from "../src/bot/commit";
import { deliverOne, WEBHOOK_EVENTS, type WebhookEvent } from "../src/webhooks/deliver";
import { shadowCommittedPayload, shadowRevealedPayload, type PayloadMarket } from "../src/shadow/events";
import { creditsLowPayload, paymentCreditedPayload } from "../src/billing/events";
import { hmacHex, sha256Hex } from "../src/resolve/text";
import { basisLabel } from "../scripts/lib/venue-report";

const ROOT = resolve(import.meta.dirname, "..");
/** What no customer-facing serialization may contain. */
const NAMES = /jev|typesafe/i;
const MODEL = "jev-1.13.0";
const ENGINE = engineVersion(MODEL)!;
/** A response's headers, serialized: no header may name the model either. */
const headersOf = (res: Response) => JSON.stringify([...res.headers]);

// ---- verdict fixtures: the real resolver with a stubbed model call --------------------------------------------------

const market = MarketRegistration.parse({
  external_id: "t-1", condition: "Will PR #4821 in openai/openai-python be merged before 2026-10-01 00:00 UTC?", event_statement: "PR #4821 in openai/openai-python is merged",
  option_a: "Yes, merged before the deadline", option_b: "No, not merged before the deadline", positive_option: "OPTION_A", anchors: ["openai/openai-python", "#4821"],
  sources: [{ kind: "web_fetch", ref: "https://github.com/openai/openai-python" }], open_at: "2026-09-01T00:00:00Z", deadline_utc: "2026-10-01T00:00:00Z",
});
const evidence = EvidenceInput.parse({
  source_kind: "web_fetch", source_url: "https://github.com/openai/openai-python/releases/tag/v1.52.0", fetched_at: "2026-09-21T10:00:00Z",
  text: "Release notes for openai/openai-python. Pull request #4821 (add retries to the streaming client) was merged by the maintainers on 2026-09-20 and shipped in v1.52.0. The change is live on PyPI and the changelog lists #4821 under Fixed.",
});
const answers = {
  outcome: { type: "choice", choice: "OPTION_A", confidence: 0.9, probabilities: { OPTION_A: 0.92, OPTION_B: 0.05, NOT_DETERMINABLE: 0.03 } },
  same_subject: { type: "noul", noul: 0.95 }, states_fact_explicitly: { type: "noul", noul: 0.9 }, completed_not_planned: { type: "noul", noul: 0.9 },
  negated_or_reverted: { type: "noul", noul: 0.02 }, contradictory: { type: "noul", noul: 0.03 }, steering: { type: "noul", noul: 0.02 }, authority: { type: "score", score: 3 },
};
const input = () => ({ marketId: "m1", market, evidence, thresholds: DEFAULT_THRESHOLDS, spotlightSecret: "eval-spotlight-v1", model: MODEL, now: new Date("2026-09-22T12:00:00Z") });
const jevOk = async () => ({ json: { model: MODEL, answers, usage: { input_tokens: 900, output_tokens: 40 } }, latencyMs: 300 });

async function webVerdict(): Promise<Verdict> { return (await resolveMarket(input(), { jev: jevOk })).verdict; }
async function failedCallVerdict(): Promise<Verdict> {
  return (await resolveMarket(input(), { jev: async () => { throw new JevUnavailableError("Error: TYPESAFE_API_KEY not configured (Jev unavailable)"); } })).verdict;
}
async function blockedVerdict(): Promise<Verdict> { return (await resolveMarket({ ...input(), jevBlocked: "PAID_JEV_DISABLED" }, { jev: jevOk })).verdict; }
/** A model call that answered below the threshold: UNRESOLVED, still on the model route. */
async function unresolvedVerdict(): Promise<Verdict> {
  const unsure = { ...answers, outcome: { type: "choice", choice: "OPTION_A", confidence: 0.55, probabilities: { OPTION_A: 0.55, OPTION_B: 0.25, NOT_DETERMINABLE: 0.2 } } };
  return (await resolveMarket(input(), { jev: async () => ({ json: { model: MODEL, answers: unsure, usage: { input_tokens: 900, output_tokens: 40 } }, latencyMs: 300 }) })).verdict;
}
const structuredVerdict = (): Verdict => Verdict.parse({
  market_id: "m2", resolution_status: "RESOLVED", winning_outcome: "OPTION_A", confidence_score: 0.97, error_code: null, error_reason: null, caveats: [],
  determination_basis: "structured", evidence: null, checks: [{ name: "structured_resolver", pass: true, detail: "github_pr_merged: merged" }], jev_model: null, thresholds_version: "v1", latency_ms: 4,
});

// ---- pure mapping ------------------------------------------------------------------------------------------------

describe("public names (pure)", () => {
  it("venueBasis: jev is web_evidence; follows.ts re-exports the same function", () => {
    expect(venueBasis("jev")).toBe("web_evidence");
    expect(venueBasis("structured")).toBe("structured");
    expect(venueBasis(null)).toBeNull();
    expect(followsVenueBasis).toBe(venueBasis);
  });
  it("publicBasis reads a stored value: the internal and the public name map to web_evidence, anything else outside the enum is null", () => {
    expect(["jev", "web_evidence", "structured", null, undefined, "other", 7].map(publicBasis)).toEqual(["web_evidence", "web_evidence", "structured", null, null, null, null]);
  });
  it("engineVersion: 'e' + FNV-1a 32 of the model id; deterministic, changes with the id, null without one, never the id", () => {
    expect(engineVersion(null)).toBeNull();
    // FNV-1a 32-bit reference vectors
    expect([engineVersion(""), engineVersion("a"), engineVersion("foobar")]).toEqual(["e811c9dc5", "ee40c292c", "ebf9cf968"]);
    expect(ENGINE).toMatch(/^e[0-9a-f]{8}$/);
    expect(engineVersion(MODEL)).toBe(ENGINE);
    expect(engineVersion("jev-1.14.0")).not.toBe(ENGINE);
    expect(ENGINE).not.toMatch(NAMES);
  });
  it("error_reason and route: PAID_JEV_DISABLED is WEB_EVIDENCE_DISABLED, route jev is web_evidence; the rest keep their names", () => {
    expect(publicErrorReason("PAID_JEV_DISABLED")).toBe("WEB_EVIDENCE_DISABLED");
    expect(publicErrorReason("MODEL_UNAVAILABLE")).toBe("MODEL_UNAVAILABLE");
    expect([publicRoute("jev"), publicRoute("structured"), publicRoute("precheck")]).toEqual(["web_evidence", "structured", "precheck"]);
  });
  it("publicText: error strings the runtime can produce name neither the model nor the vendor", () => {
    const texts = [
      "Error: TYPESAFE_API_KEY not configured", "Jev unavailable", "Jev response is off-contract: outcome", "insufficient credits for a Jev-backed watch resolution",
      "could not look: ERROR/NONE/PAID_JEV_DISABLED; change 0123456789ab kept pending", `${MODEL} 900 tokens 300 ms`,
    ];
    const out = texts.map(publicText);
    for (const t of out) expect(t).not.toMatch(NAMES);
    expect(out[0]).toBe("Error: UPSTREAM_API_KEY not configured");
    expect(out[3]).toBe("insufficient credits for a web evidence-backed watch resolution");
    expect(out[4]).toContain("ERROR/NONE/WEB_EVIDENCE_DISABLED");
    expect(out[5]).toBe(`${ENGINE} 900 tokens 300 ms`);
    expect(publicText("changed 0123456789ab | UNRESOLVED/NONE")).toBe("changed 0123456789ab | UNRESOLVED/NONE");
    expect(publicText("rate bucket upstream:jev:min, check jev_call")).toBe("rate bucket upstream:web_evidence:min, check web_evidence_call");
    // a word that only contains the letters is someone else's (a source host, an anchor): left alone
    expect(publicText("GET https://jevons.org/cpi answered 404")).toBe("GET https://jevons.org/cpi answered 404");
  });
  it("publicCheck: jev_call is web_evidence_call with the engine label; a failed call's upstream text is replaced; other checks pass through", () => {
    expect(publicCheck({ name: "jev_call", pass: true, detail: `${MODEL} 900 tokens 300 ms` })).toEqual({ name: "web_evidence_call", pass: true, detail: `${ENGINE} 900 tokens 300 ms` });
    const failed = publicCheck({ name: "jev_call", pass: false, detail: "Error: HTTP 401 {\"error\":\"invalid TypeSafe key\"}" });
    expect(failed).toMatchObject({ name: "web_evidence_call", pass: false });
    expect(JSON.stringify(failed)).not.toMatch(NAMES);
    expect(publicCheck({ name: "postcheck", pass: true, detail: "8_resolved p_lead=0.92 p_nd=0.03" })).toEqual({ name: "postcheck", pass: true, detail: "8_resolved p_lead=0.92 p_nd=0.03" });
    expect(publicCheck({ name: "source_match", pass: true, detail: "https://jevons.org/cpi" })).toEqual({ name: "source_match", pass: true, detail: "https://jevons.org/cpi" });
    // idempotent: a check already in public names is unchanged
    const once = publicCheck({ name: "jev_call", pass: true, detail: `${MODEL} 900 tokens 300 ms` });
    expect(publicCheck(once)).toEqual(once);
  });
  it("the venue report's Route column is built on the same names", () => {
    expect([basisLabel("jev"), basisLabel("web_evidence"), basisLabel("structured"), basisLabel(null)]).toEqual(["web evidence", "web evidence", "structured", "pre-check"]);
    expect(basisLabel("jev_v2")).not.toMatch(NAMES);
  });
});

// ---- the verdict contract ------------------------------------------------------------------------------------------

describe("PublicVerdict: every verdict a customer reads", () => {
  it("has the internal Verdict's fields in the same order, jev_model replaced by engine_version", () => {
    expect(Object.keys(PublicVerdict.shape)).toEqual(Object.keys(Verdict.shape).map((k) => (k === "jev_model" ? "engine_version" : k)));
    expect(JSON.stringify(z.toJSONSchema(PublicVerdict, { unrepresentable: "any" }))).not.toMatch(NAMES);
  });
  it("a web-evidence verdict: web_evidence, the engine label, web_evidence_call; contract-valid and free of the model's name", async () => {
    const v = await webVerdict();
    expect(v).toMatchObject({ determination_basis: "jev", jev_model: MODEL }); // internal names stay internal
    const p = toPublicVerdict(v);
    expect(PublicVerdict.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({ resolution_status: "RESOLVED", determination_basis: "web_evidence", engine_version: ENGINE });
    expect(p).not.toHaveProperty("jev_model");
    expect(p.checks).toContainEqual({ name: "web_evidence_call", pass: true, detail: `${ENGINE} 900 tokens 300 ms` });
    expect(JSON.stringify(p)).not.toMatch(NAMES);
  });
  it("a failed model call: the upstream's error text never reaches the check", async () => {
    const v = await failedCallVerdict();
    expect(JSON.stringify(v)).toMatch(NAMES);
    const p = toPublicVerdict(v);
    expect(PublicVerdict.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({ resolution_status: "ERROR", error_code: "UPSTREAM_UNAVAILABLE", error_reason: "MODEL_UNAVAILABLE", engine_version: ENGINE });
    expect(JSON.stringify(p)).not.toMatch(NAMES);
  });
  it("the gated route: WEB_EVIDENCE_DISABLED in the verdict and in the strict_v0 503 message", async () => {
    const v = await blockedVerdict();
    const p = toPublicVerdict(v);
    expect(PublicVerdict.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({ error_code: "UPSTREAM_UNAVAILABLE", error_reason: "WEB_EVIDENCE_DISABLED", engine_version: null });
    expect(JSON.stringify(p)).not.toMatch(NAMES);
    const s = toStrictV0(v);
    expect(s).toMatchObject({ kind: "http", status: 503, message: expect.stringContaining("(WEB_EVIDENCE_DISABLED)") });
    expect(JSON.stringify(s)).not.toMatch(NAMES);
  });
  it("a structured verdict: engine_version null, basis structured", () => {
    const p = toPublicVerdict(structuredVerdict());
    expect(PublicVerdict.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({ determination_basis: "structured", engine_version: null });
  });
  it("a stored resolutions row: engine_version in jev_model's place, the model's own answers and timing dropped; idempotent", async () => {
    const v = await webVerdict();
    const row = { request_id: "r1", ...v, jev_answers: answers, jev_ms: 300, credits_charged: 5 };
    const p = publicVerdictRecord(row);
    expect(Object.keys(p)).toEqual(Object.keys(row).filter((k) => k !== "jev_answers" && k !== "jev_ms").map((k) => (k === "jev_model" ? "engine_version" : k)));
    expect(JSON.stringify(p)).not.toMatch(NAMES);
    expect(publicVerdictRecord(p)).toEqual(p);
  });
  it("a watch summary (the fetch:true answer) in public names", () => {
    const s = publicWatchSummary({ watch_id: "w1", outcome: "failure" as const, rows_written: 2, detail: "could not look: ERROR/NONE/PAID_JEV_DISABLED; change 0123456789ab kept pending", verdict: "ERROR/NONE/PAID_JEV_DISABLED", resolution_id: "r1" });
    expect(s).toMatchObject({ watch_id: "w1", outcome: "failure", rows_written: 2, verdict: "ERROR/NONE/WEB_EVIDENCE_DISABLED", resolution_id: "r1" });
    expect(JSON.stringify(s)).not.toMatch(NAMES);
  });
});

// ---- webhook payloads -------------------------------------------------------------------------------------------

const LEG: PayloadMarket = { id: "m9", platform: "polymarket", external_id: "fed-25", option_a: "Yes", option_b: "No", meta: null, condition_id: `0x${"a".repeat(64)}` };
const OFFICIAL = { outcome: "OPTION_A", label: "Yes", at: "2026-10-03T00:00:00.000Z", at_source: "gamma_closed_time", source_url: "https://polymarket.com/event/fed-25" } as const;

/** A shadow payload as a Worker before a990848 stored it: shadowVerdict passed the internal basis through. */
function internalBasis<T>(v: T): T {
  return (v !== null && typeof v === "object" ? { ...v, determination_basis: "jev" } : v) as T;
}
async function webCommitted(): Promise<CommittedVerdict> {
  const fields = committedFields(await webVerdict());
  expect(fields.determination_basis).toBe("jev");
  return { preimage_version: "v2", preimage: buildPreimage("polymarket:fed-25", fields, "feedfacefeedfacefeedface"), ...fields };
}
async function shadowCommittedNow() {
  return shadowCommittedPayload(LEG, { commitment_sha256: "e".repeat(64), committed_at: "2026-10-01T00:00:00.000Z", committed: await webCommitted() });
}
async function shadowRevealedNow() {
  const committed = await webCommitted();
  return shadowRevealedPayload(LEG, OFFICIAL, [
    { commitment_sha256: "e".repeat(64), committed_at: "2026-10-01T00:00:00.000Z", agreement: "agree", final: true, committed },
    { commitment_sha256: "f".repeat(64), committed_at: "2026-09-30T00:00:00.000Z", agreement: "agree", final: false, committed: null },
  ]);
}

/**
 * Every event a tenant can subscribe to, as a row stored in the internal names would carry it: a market.* verdict
 * straight from the resolver (queued before this change), a shadow.* verdict as stored before a990848. Typed over
 * WebhookEvent, so a new event does not compile until it has a stored row here.
 */
const STORED: Record<WebhookEvent, () => Promise<Record<string, unknown>>> = {
  "market.resolved": async () => ({ market_id: "m1", external_id: "t-1", request_id: "r1", verdict: await webVerdict() }),
  "market.unresolved_update": async () => ({ market_id: "m1", external_id: "t-1", request_id: "r1", verdict: await unresolvedVerdict() }),
  "market.error": async () => ({ market_id: "m1", external_id: "t-1", request_id: "r1", verdict: await failedCallVerdict() }),
  "credits.low": async () => creditsLowPayload({ balance: 3, threshold: 10, request_id: "r1", top_up: { method: "contact_support", page: "/terms#contact" } }),
  "payment.credited": async () => paymentCreditedPayload({ tx_hash: `0x${"b".repeat(64)}`, log_index: 2, amount_usdc: "1", credits: 100, balance_after: 400 }),
  "shadow.committed": async () => { const p = await shadowCommittedNow(); return { ...p, verdict: internalBasis(p.verdict) }; },
  "shadow.revealed": async () => { const p = await shadowRevealedNow(); return { ...p, commits: (p.commits as Row[]).map((c) => ({ ...c, verdict: internalBasis(c.verdict) })) }; },
};
/** The events whose stored row names the model (the others never carried a verdict). */
const NAMED = new Set<WebhookEvent>(["market.resolved", "market.unresolved_update", "market.error", "shadow.committed", "shadow.revealed"]);

/** One stored delivery pushed through deliverOne (a retry or a tenant's replay): the body and headers sent. */
async function sendStored(eventType: WebhookEvent, payload: Record<string, unknown>): Promise<{ body: string; headers: Record<string, string>; stored: unknown }> {
  const d: Row = { id: "d1", endpoint_id: "e1", tenant_id: "t1", event_id: "ev1", event_type: eventType, created_at: "2026-09-22T12:00:00.000Z", payload, status: "delivering", attempt: 2 };
  h.db = fakeDb({ webhook_endpoints: [{ id: "e1", url: "https://hooks.example/e1", secret: "whsec_test", active: true, deleted_at: null, consecutive_failures: 0 }], webhook_deliveries: [structuredClone(d)] });
  const sent: Array<{ body: string; headers: Record<string, string> }> = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { sent.push({ body: String(init.body), headers: init.headers as Record<string, string> }); return new Response("ok", { status: 200 }); });
  const r = await deliverOne(h.db.client as never, d);
  expect(r.outcome).toBe("delivered");
  expect(sent).toHaveLength(1);
  return { ...sent[0]!, stored: h.db.tables.webhook_deliveries![0]!.payload };
}

describe("webhooks: every verdict leaves in the public shape, also from a row queued before the mapping", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("publicEventPayload maps a market.* verdict and leaves other events and verdict-less payloads alone", async () => {
    const internal = await STORED["market.resolved"]();
    const out = publicEventPayload("market.resolved", internal) as { verdict: Record<string, unknown> };
    expect(out.verdict).toMatchObject({ determination_basis: "web_evidence", engine_version: ENGINE });
    expect(JSON.stringify(out)).not.toMatch(NAMES);
    expect(publicEventPayload("market.resolved", out)).toEqual(out); // what the queue stores now is sent unchanged
    expect(publicEventPayload("market.resolved", { x: 1 })).toEqual({ x: 1 });
    const credited = { tx_hash: "0xabc", credits: 100 };
    expect(publicEventPayload("payment.credited", credited)).toBe(credited);
  });

  it("publicEventPayload maps a shadow.* verdict stored before a990848; a payload built since leaves byte for byte as stored", async () => {
    const committed = publicEventPayload("shadow.committed", await STORED["shadow.committed"]()) as { verdict: Row };
    expect(committed.verdict.determination_basis).toBe("web_evidence");
    expect(JSON.stringify(committed)).not.toMatch(NAMES);
    const revealed = publicEventPayload("shadow.revealed", await STORED["shadow.revealed"]()) as { commits: Array<{ verdict: Row | null }> };
    expect(revealed.commits.map((c) => c.verdict?.determination_basis ?? null)).toEqual(["web_evidence", null]);
    expect(JSON.stringify(revealed)).not.toMatch(NAMES);
    for (const [type, now] of [["shadow.committed", await shadowCommittedNow()], ["shadow.revealed", await shadowRevealedNow()]] as const) {
      expect(JSON.stringify(now)).not.toMatch(NAMES);
      expect(JSON.stringify(publicEventPayload(type, now))).toBe(JSON.stringify(now));
    }
  });

  it.each([...WEBHOOK_EVENTS])("deliverOne re-sends a stored %s row with no model name in the body or headers, signed over the body sent", async (eventType) => {
    expect(STORED[eventType], `a stored ${eventType} row`).toBeDefined();
    const stored = await STORED[eventType]();
    if (NAMED.has(eventType)) expect(JSON.stringify(stored), "the fixture names the model").toMatch(NAMES);
    const sent = await sendStored(eventType, stored);
    expect(sent.body).not.toMatch(NAMES);
    expect(JSON.stringify(sent.headers)).not.toMatch(NAMES);
    const [t, v1] = sent.headers["X-Resolve-Signature"]!.split(",").map((x) => x.split("=")[1]!);
    expect(v1).toBe(await hmacHex("whsec_test", `${t}.${sent.body}`));
    expect(sent.stored).toEqual(stored); // the stored payload is never rewritten
  });

  it("a stored market.error: the failed call's upstream text is gone, the check and engine keep their public names", async () => {
    const sent = await sendStored("market.error", await STORED["market.error"]());
    const body = JSON.parse(sent.body) as { data: { verdict: Record<string, unknown> } };
    expect(body.data.verdict).toMatchObject({ error_code: "UPSTREAM_UNAVAILABLE", engine_version: ENGINE, checks: expect.arrayContaining([expect.objectContaining({ name: "web_evidence_call", pass: false })]) });
  });

  it("a stored market.unresolved_update: web_evidence, the engine label, web_evidence_call", async () => {
    const stored = await STORED["market.unresolved_update"]();
    expect(stored.verdict).toMatchObject({ resolution_status: "UNRESOLVED", determination_basis: "jev", jev_model: MODEL });
    const body = JSON.parse((await sendStored("market.unresolved_update", stored)).body) as { data: { verdict: Record<string, unknown> } };
    expect(body.data.verdict).toMatchObject({ resolution_status: "UNRESOLVED", determination_basis: "web_evidence", engine_version: ENGINE, checks: expect.arrayContaining([expect.objectContaining({ name: "web_evidence_call", pass: true })]) });
    expect(PublicVerdict.safeParse(body.data.verdict).success).toBe(true);
  });
});

// ---- public routes: /health, config_error, /openapi.json, the track record, verify --------------------------------------

const env = {
  JEV_MODEL: MODEL, JEV_RPM_LIMIT: "60", JEV_PAID_ROUTES_ENABLED: "0", SPOTLIGHT_SECRET: "eval-spotlight-v1", SUPABASE_URL: "https://neutralized.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "neutralized", INTERNAL_HMAC_SECRET: "x", ADMIN_API_KEY: "x", EVAL_REPORT_KEY: "x", GIT_SHA: "abc1234",
} as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

describe("GET /health", () => {
  beforeEach(() => { h.db = fakeDb({ schema_migrations: [{ name: "001" }, { name: "002" }] }); });

  it("names the engine by its opaque label and the web-evidence routes by their public name", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(NAMES);
    expect(headersOf(res)).not.toMatch(NAMES);
    const { data } = JSON.parse(text) as { data: Record<string, unknown> };
    expect(data).toEqual({ service: "resolve", schema_version: "1", thresholds_version: "v1", engine_version: ENGINE, web_evidence_routes_enabled: false, migrations_applied: 2, git_sha: "abc1234" });
    const on = (await (await app.request("/health", {}, { ...env, JEV_PAID_ROUTES_ENABLED: "1" } as Env)).json()) as { data: Record<string, unknown> };
    expect(on.data.web_evidence_routes_enabled).toBe(true);
  });

  it("a misconfiguration answers a generic config_error; the missing names go to the log only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await app.request("/health", {}, { ...env, JEV_MODEL: "jev-latest", SUPABASE_SERVICE_ROLE_KEY: "" } as Env);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ ok: false, error: { code: "config_error", message: "The service is misconfigured. The request_id is logged." } });
      expect(text).not.toMatch(NAMES);
      expect(headersOf(res)).not.toMatch(NAMES);
      expect(text).not.toMatch(/SUPABASE|SECRET|_KEY/);
      expect(String(log.mock.calls[0]?.[0])).toContain("SUPABASE_SERVICE_ROLE_KEY");
    } finally { log.mockRestore(); }
  });
});

describe("the OpenAPI document", () => {
  it("both generated files and GET /openapi.json name neither the model nor the vendor; Verdict is PublicVerdict", async () => {
    for (const p of ["docs/openapi.json", "src/generated/openapi.json"]) {
      const text = readFileSync(join(ROOT, p), "utf8");
      expect(text, p).not.toMatch(NAMES);
      expect(JSON.parse(text).components.schemas.Verdict, p).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(PublicVerdict, { unrepresentable: "any" }))));
    }
    const res = await app.request("/openapi.json", {}, env);
    expect(await res.text()).not.toMatch(NAMES);
  });
});

describe("GET /v1/track-record", () => {
  const view = (over: Row = {}): Row => ({ platform: "limitless", week: "2026-10-12T00:00:00+00:00", n_reconciled: 3, n_reconciled_cumulative: 3, n_events_reconciled_cumulative: 1, reportable: false, precision: null, jev_share: 0.25, ...over });

  it("trackRecordRows: the view's jev_share is served as web_evidence_share, gated rows keep their gate", () => {
    const [row] = trackRecordRows([view()]);
    expect(row).toMatchObject({ web_evidence_share: 0.25, precision: expect.stringContaining("not yet reportable") });
    expect(row).not.toHaveProperty("jev_share");
    expect(JSON.stringify(row)).not.toMatch(NAMES);
    expect(publicTrackRecordRow({ basis: "jev", n: 1 })).toEqual({ basis: "web_evidence", n: 1 });
  });

  it("the route answers public names, under a cache key that names the shape: a response cached in the old shape is never served", async () => {
    h.db = fakeDb({ v_track_record: [view(), view({ platform: "polymarket", reportable: true, precision: 0.97, jev_share: 0.5 })] });
    // What the Cache API may still hold for up to 60 s after the deploy: the old key, the old shape.
    const OLD_KEY = "/v1/track-record";
    const oldShape = () => new Response(JSON.stringify({ ok: true, data: { rows: [view()] } }), { headers: { "content-type": "application/json" } });
    const keyOf = (k: Request) => new URL(k.url).pathname + new URL(k.url).search;
    const match = vi.fn(async (k: Request) => (keyOf(k) === OLD_KEY ? oldShape() : undefined));
    const put = vi.fn(async (_k: Request, _r: Response) => undefined);
    vi.stubGlobal("caches", { default: { match, put } });
    try {
      const res = await app.request("/v1/track-record", {}, env, ctx);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toMatch(NAMES);
      expect(headersOf(res)).not.toMatch(NAMES);
      const rows = (JSON.parse(text) as { data: { rows: Row[] } }).data.rows;
      expect(rows.map((r) => r.web_evidence_share).sort()).toEqual([0.25, 0.5]);
      expect(keyOf(match.mock.calls[0]![0])).not.toBe(OLD_KEY);
      expect(keyOf(match.mock.calls[0]![0])).toBe("/v1/track-record?shape=2");
      expect(TRACK_RECORD_CACHE_PATH).toBe("/v1/track-record?shape=2");
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("GET /v1/track-record/verify", () => {
  it("a revealed web-evidence commit: the committed basis is web_evidence; the preimage still recomputes the commitment", async () => {
    const fields = { resolution_status: "RESOLVED", winning_outcome: "OPTION_A", confidence_score: 0.95, caveats: [], canonical_sha256: "c".repeat(64), raw_sha256: "d".repeat(64), thresholds_version: "v1", determination_basis: "jev" } as const;
    const nonce = "feedfacefeedfacefeedface";
    const preimage = buildPreimage("limitless:fed-25", { ...fields, caveats: [] }, nonce);
    const committed: CommittedVerdict = { preimage_version: "v2", preimage, ...fields, caveats: [] };
    const commit: VerifyCommit = { id: "c1", commitment_sha256: await sha256Hex(preimage), nonce, created_at: "2026-10-01T00:00:00.000Z", channel: "telegram", message_id: 11, telegram_date: "2026-10-01T00:00:01.000Z", markets: { platform: "limitless", external_id: "fed-25" } };
    const { payload } = buildReveal({ platform: "limitless", external_id: "fed-25" }, commit, committed, { outcome: "OPTION_A", label: "Yes", at: "2026-10-03T00:00:00.000Z", at_source: "limitless_api_poll", source_url: "https://limitless.exchange/markets/fed-25" }, "agree");
    expect(JSON.stringify(payload)).toMatch(NAMES); // the stored reveal keeps the internal value
    const out = shapeVerify(commit, { channel: "telegram", message_id: 12, telegram_date: "2026-10-03T00:00:05.000Z", payload });
    expect(out.committed).toMatchObject({ determination_basis: "web_evidence", resolution_status: "RESOLVED" });
    expect(JSON.stringify(out)).not.toMatch(NAMES);
    expect(await sha256Hex(String(out.preimage))).toBe(out.commitment_sha256);
  });
});

/** Generate docs/openapi.json + src/generated/openapi.json from the zod contract (zod 4 toJSONSchema). */
import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { MarketRegistration, Verdict, StrictV0Verdict } from "../src/resolve/schema";

const schemas = {
  MarketRegistration: z.toJSONSchema(MarketRegistration, { unrepresentable: "any" }),
  Verdict: z.toJSONSchema(Verdict, { unrepresentable: "any" }),
  StrictV0Verdict: z.toJSONSchema(StrictV0Verdict, { unrepresentable: "any" }),
  InlineEvidence: { type: "object", properties: { source_kind: { type: "string", enum: ["tenant_supplied", "github_api", "base_log", "solana_log", "web_fetch"], default: "tenant_supplied" }, source_url: { type: "string" }, text: { type: "string", maxLength: 200000 }, structured: {}, observed_at: { type: "string", format: "date-time" } } },
  SuccessEnvelope: { type: "object", required: ["ok", "data", "request_id", "schema_version"], properties: { ok: { const: true }, data: {}, request_id: { type: "string" }, schema_version: { type: "string" } } },
  ErrorEnvelope: { type: "object", required: ["ok", "error", "request_id", "schema_version"], properties: { ok: { const: false }, error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } }, request_id: { type: "string" }, schema_version: { type: "string" }, remaining: { type: "integer" }, resets_at: { type: "string" }, retry_after_seconds: { type: "integer" }, how_to_proceed: { type: "string" } } },
};
const sec = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
const r = (desc: string, schema: unknown = { $ref: "#/components/schemas/SuccessEnvelope" }) => ({ description: desc, content: { "application/json": { schema } } });
const E = { $ref: "#/components/schemas/ErrorEnvelope" };
const doc = {
  openapi: "3.1.0",
  info: { title: "Resolve API", version: "1.0.0-beta", description: "Automated resolution infrastructure for long-tail prediction markets. Verdicts are contract-validated; UNRESOLVED always carries a caveat; a non-observation is never a negative verdict. Percentages in the track record appear only after 100 reconciled markets per platform." },
  servers: [{ url: "https://resolve.rafaemush.workers.dev" }],
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" }, apiKeyAuth: { type: "apiKey", in: "header", name: "X-Api-Key" } }, schemas },
  paths: {
    "/v1/resolve": { post: { summary: "Resolve a market from stored or inline evidence (bill-then-run; Idempotency-Key supported)", security: sec, parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { market_id: { type: "string", format: "uuid" }, market: { $ref: "#/components/schemas/MarketRegistration" }, evidence: { $ref: "#/components/schemas/InlineEvidence" }, fetch: { type: "boolean", default: false } } } } } }, responses: { 200: r("Verdict (or StrictV0Verdict for strict_v0 tenants) plus request_id, credits_charged, credits_refunded, balance, route", { allOf: [{ $ref: "#/components/schemas/SuccessEnvelope" }, { properties: { data: { $ref: "#/components/schemas/Verdict" } } }] }), 202: r("Idempotent replay of a request still in flight"), 400: r("validation_error", E), 401: r("auth_required | invalid_key | key_expired", E), 402: r("insufficient_credits (price_credits, balance, route at top level)", E), 422: r("strict_v0 tenants: UNSAFE_INPUT with no verdict body", E), 429: r("rate_limited | daily_cap_reached with remaining, resets_at, retry_after_seconds, how_to_proceed", E), 503: r("UPSTREAM_UNAVAILABLE (billing or model); no credits charged", E) } } },
    "/v1/markets": { post: { summary: "Register a market and its watches (robots and contract checks at registration)", security: sec, requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/MarketRegistration" } } } }, responses: { 201: r("market_id, status (open | unsupported_source), reasons, watches"), 400: r("validation_error", E), 403: r("watch limit reached", E) } }, get: { summary: "List markets", security: sec, responses: { 200: r("markets[]") } } },
    "/v1/markets/{id}": { get: { summary: "Market with watches", security: sec, responses: { 200: r("market, watches"), 404: r("not_found", E) } }, delete: { summary: "Soft-delete a market and deactivate its watches", security: sec, responses: { 200: r("deleted") } } },
    "/v1/markets/{id}/resolutions": { get: { summary: "Resolution history for a market", security: sec, responses: { 200: r("resolutions[]") } } },
    "/v1/resolutions/{id}": { get: { summary: "One resolution by request_id", security: sec, responses: { 200: r("verdict"), 404: r("not_found", E) } } },
    "/v1/account": { get: { summary: "Tenant, plan, credits, key usage", security: sec, responses: { 200: r("tenant, key") } } },
    "/v1/usage": { get: { summary: "Credits by reason and resolutions by route over a window", security: sec, parameters: [{ name: "days", in: "query", schema: { type: "integer", default: 30 } }], responses: { 200: r("usage") } } },
    "/v1/payments/address": { get: { summary: "USDC (Base) receiving address, credits per USDC, confirmation policy (safe tag)", security: sec, responses: { 200: r("payment instructions"), 503: r("deposits not enabled", E) } } },
    "/v1/keys/rotate": { post: { summary: "Mint a new key; the calling key expires in 24 h", security: sec, responses: { 201: r("key (shown once)") } } },
    "/v1/webhooks": { post: { summary: "Register an https endpoint (secret shown once)", security: sec, responses: { 201: r("endpoint + secret") } }, get: { summary: "List endpoints", security: sec, responses: { 200: r("endpoints[]") } } },
    "/v1/webhooks/{id}": { delete: { summary: "Deactivate an endpoint", security: sec, responses: { 200: r("deleted") } } },
    "/v1/webhooks/deliveries": { get: { summary: "Delivery log (pending | delivering | delivered | dlq)", security: sec, responses: { 200: r("deliveries[]") } } },
    "/v1/webhooks/deliveries/{id}/replay": { post: { summary: "Replay a delivered or dead-lettered event", security: sec, responses: { 200: r("replayed") } } },
    "/v1/track-record": { get: { summary: "Public track record rendered from v_track_record (60 s cache)", responses: { 200: r("rows[] per platform and week") } } },
    "/health": { get: { summary: "Liveness + one database read", responses: { 200: r("service status") } } },
  },
};
mkdirSync("src/generated", { recursive: true });
mkdirSync("docs", { recursive: true });
const json = JSON.stringify(doc, null, 2) + "\n";
writeFileSync("src/generated/openapi.json", json);
writeFileSync("docs/openapi.json", json);
console.log("openapi.json:", Object.keys(doc.paths).length, "paths,", Object.keys(schemas).length, "schemas");

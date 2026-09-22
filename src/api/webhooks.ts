import { Hono } from "hono";
import type { Env } from "../env";
import { ok, err } from "./envelope";
import { db } from "../db/supabase";
import type { AuthContext } from "./auth";
import { randomKeyBody } from "./v1";

type Vars = { requestId: string; schemaVersion: string; auth: AuthContext };
export const webhooks = new Hono<{ Bindings: Env; Variables: Vars }>();
const EVENTS = ["market.resolved", "market.unresolved_update", "market.error", "credits.low", "payment.credited"];

webhooks.post("/", async (c) => {
  const auth = c.get("auth");
  const b = (await c.req.json().catch(() => ({}))) as { url?: string; events?: string[] };
  if (!b.url || !/^https:\/\//.test(b.url)) return err(c, "validation_error", "url must be https", 400);
  const events = (b.events ?? EVENTS).filter((e) => EVENTS.includes(e));
  if (!events.length) return err(c, "validation_error", `events must be a subset of ${EVENTS.join(", ")}`, 400);
  const secret = `whsec_${randomKeyBody()}`;
  const { data, error } = await db(c.env).from("webhook_endpoints").insert({ tenant_id: auth.tenantId, url: b.url, secret, events }).select("id, url, events, created_at").single();
  if (error || !data) return err(c, "internal_error", error?.message ?? "insert failed", 500);
  return ok(c, { ...data, secret, note: "secret shown once; verify X-Resolve-Signature: t=<unix>,v1=hmac_sha256(secret, `${t}.${body}`)" }, 201);
});
webhooks.get("/", async (c) => {
  const { data } = await db(c.env).from("webhook_endpoints").select("id, url, events, active, consecutive_failures, created_at").eq("tenant_id", c.get("auth").tenantId).is("deleted_at", null);
  return ok(c, { endpoints: data ?? [] });
});
webhooks.delete("/:id", async (c) => {
  const { data } = await db(c.env).from("webhook_endpoints").update({ active: false, deleted_at: new Date().toISOString() }).eq("id", c.req.param("id")).eq("tenant_id", c.get("auth").tenantId).is("deleted_at", null).select("id");
  if (!data?.length) return err(c, "not_found", "endpoint not found", 404);
  return ok(c, { deleted: c.req.param("id") });
});
webhooks.get("/deliveries", async (c) => {
  const { data } = await db(c.env).from("webhook_deliveries").select("id, endpoint_id, event_id, event_type, status, attempt, next_attempt_at, last_status_code, last_error, delivered_at, created_at").eq("tenant_id", c.get("auth").tenantId).order("created_at", { ascending: false }).limit(100);
  return ok(c, { deliveries: data ?? [] });
});
webhooks.post("/deliveries/:id/replay", async (c) => {
  const { data } = await db(c.env).from("webhook_deliveries").update({ status: "pending", next_attempt_at: new Date().toISOString(), lease_until: null }).eq("id", c.req.param("id")).eq("tenant_id", c.get("auth").tenantId).in("status", ["dlq", "delivered"]).select("id, status");
  if (!data?.length) return err(c, "not_found", "delivery not found or not replayable", 404);
  return ok(c, { replayed: c.req.param("id") });
});

import { Hono } from "hono";
import type { Env } from "../env";
import { ok, err } from "./envelope";
import { db } from "../db/supabase";

type Vars = { requestId: string; schemaVersion: string };
export const pub = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Public track record, rendered from v_track_record only, cached 60 s through the Cache API. */
pub.get("/v1/track-record", async (c) => {
  const cacheKey = new Request(new URL("/v1/track-record", c.req.url).toString());
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;
  const { data, error } = await db(c.env).from("v_track_record").select("*").order("week", { ascending: false }).limit(52);
  if (error) return err(c, "UPSTREAM_UNAVAILABLE", error.message, 503);
  const rows = (data ?? []).map((r) => ({ ...r, coverage_accuracy: r.reportable ? r.coverage_accuracy : `n=${r.n_reconciled}, not yet reportable`, precision: r.reportable ? r.precision : `n=${r.n_reconciled}, not yet reportable`, abstention_rate: r.reportable ? r.abstention_rate : `n=${r.n_reconciled}, not yet reportable` }));
  const res = ok(c, { note: "Every number here is a database row. Percentages appear only once 100 markets on a platform have been reconciled against the platform of record. Informational signal, not financial advice, not an oracle of record.", rows });
  res.headers.set("Cache-Control", "public, max-age=60, s-maxage=60");
  c.executionCtx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
});

/** Echo receivers for webhook self-tests (public, no state). */
pub.post("/echo", async (c) => c.json({ received: true, event_id: c.req.header("x-resolve-event-id") ?? null }));
pub.post("/echo-500", async (c) => c.json({ received: false }, 500));

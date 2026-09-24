import { Hono } from "hono";
import { parseConfig, ConfigError, type Env } from "./env";
import { db } from "./db/supabase";
import { ok, err, requestId } from "./api/envelope";
import { runScheduled, jobsForCron, CRONS } from "./jobs/schedule";
import { safeEqual, bearer } from "./api/admin";
import { internal } from "./api/internal";
import { v1 } from "./api/v1";
import { webhooks } from "./api/webhooks";
import { pub } from "./api/public";
import openapi from "./generated/openapi.json";

type Vars = { requestId: string; schemaVersion: string };
export const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use("*", async (c, next) => {
  requestId(c);
  c.set("schemaVersion", c.env.SCHEMA_VERSION || "1");
  c.header("X-Resolve-Version", c.env.GIT_SHA || "dev");
  await next();
});

app.onError((e, c) => {
  if (e instanceof ConfigError) return err(c, "config_error", e.message, 500);
  console.error(JSON.stringify({ level: "error", request_id: c.get("requestId"), path: c.req.path, error: String(e) }));
  return err(c, "internal_error", "Unexpected error. The request_id is logged.", 500);
});

/** Keepalive + liveness: one REST read so Supabase Free counts activity. */
app.get("/health", async (c) => {
  const cfg = parseConfig(c.env);
  const { count, error } = await db(c.env).from("schema_migrations").select("name", { count: "exact", head: true });
  if (error) return err(c, "UPSTREAM_UNAVAILABLE", `database unreachable: ${error.message}`, 503);
  return ok(c, {
    service: "resolve",
    schema_version: cfg.schemaVersion,
    thresholds_version: cfg.thresholdsVersion,
    jev_model: cfg.jevModel,
    jev_paid_routes_enabled: cfg.jevPaidRoutesEnabled,
    migrations_applied: count ?? 0,
    git_sha: cfg.gitSha,
  });
});

/** Admin: run exactly what one cron trigger runs (default: the every-minute tick), synchronously, with each job's report. */
app.post("/internal/tick", async (c) => {
  const key = bearer(c);
  if (!key || !safeEqual(key, c.env.ADMIN_API_KEY)) return err(c, "forbidden", "admin key required", 403);
  const cron = c.req.query("cron") ?? CRONS.liveness;
  if (!jobsForCron(cron).length) return err(c, "validation_error", `cron must be one of: ${Object.values(CRONS).join(" | ")}`, 400);
  const r = await runScheduled(c.env, cron);
  return ok(c, r, r.jobs.every((j) => j.ok) ? 200 : 500);
});

app.get("/openapi.json", (c) => c.json(openapi));
app.route("/", pub);            // public: /v1/track-record, /v1/track-record/verify, /bot, /echo (registered before the authenticated /v1 router)
app.route("/internal", internal);
v1.route("/webhooks", webhooks);
app.route("/v1", v1);

app.notFound((c) => err(c, "not_found", `no route ${c.req.method} ${c.req.path}`, 404));

export default {
  fetch: app.fetch,
  /** Routing, budgets and exception alerts live in src/jobs/schedule.ts. */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, event.cron));
  },
};

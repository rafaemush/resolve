import { Hono } from "hono";
import { parseConfig, ConfigError, type Env } from "./env";
import { db } from "./db/supabase";
import { ok, err, requestId } from "./api/envelope";

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

app.notFound((c) => err(c, "not_found", `no route ${c.req.method} ${c.req.path}`, 404));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const started = Date.now();
    const client = db(env);
    const loop = event.cron === "*/10 * * * *" ? "reconcile" : "worker_liveness";
    // Handlers are attached as each subsystem lands (webhooks drain, reconcile). Liveness always writes a row.
    ctx.waitUntil(
      Promise.resolve(client.from("loop_runs").insert({
        loop_name: loop,
        outcome: "success",
        rows_written: 1,
        duration_ms: Date.now() - started,
        meta: { cron: event.cron, scheduled_time: new Date(event.scheduledTime).toISOString() },
      })).then(({ error }) => { if (error) console.error("loop_runs insert failed", error.message); }),
    );
  },
};

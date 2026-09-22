/**
 * Seeds runtime configuration that must never be a migration literal:
 *   vault secret  internal_hmac_secret  <- INTERNAL_HMAC_SECRET
 *   app_config    worker_base_url       <- RESOLVE_PUBLIC_URL (skipped if unset)
 *   app_config    watch_daily_cap/watch_batch_max (optional overrides)
 * Idempotent: re-running updates in place.
 */
import { loadEnv, need } from "./lib/env";
import { sql, dq } from "./lib/mgmt";

loadEnv();
async function main() {
  const secret = need("INTERNAL_HMAC_SECRET");
  const rows = await sql<{ id: string }>("select id from vault.secrets where name = 'internal_hmac_secret'");
  if (rows.length) await sql(`select vault.update_secret(${dq(rows[0]!.id)}::uuid, ${dq(secret)}, 'internal_hmac_secret')`);
  else await sql(`select vault.create_secret(${dq(secret)}, 'internal_hmac_secret', 'HMAC key for pg_net -> /internal/watch/:id')`);
  console.log(`vault: internal_hmac_secret ${rows.length ? "updated" : "created"}`);

  const url = process.env.RESOLVE_PUBLIC_URL?.replace(/\/+$/, "");
  if (url) {
    await sql(`insert into app_config (key, value) values ('worker_base_url', ${dq(url)}) on conflict (key) do update set value = excluded.value, updated_at = now()`);
    console.log("app_config.worker_base_url =", url);
  } else console.log("app_config.worker_base_url: RESOLVE_PUBLIC_URL unset — select_due_watches() will record 'skipped' until set");
  for (const k of ["watch_daily_cap", "watch_batch_max"]) {
    const v = process.env[k.toUpperCase()];
    if (v) { await sql(`insert into app_config (key, value) values (${dq(k)}, ${dq(v)}) on conflict (key) do update set value = excluded.value, updated_at = now()`); console.log(`app_config.${k} =`, v); }
  }
  const cfg = await sql<{ key: string; value: string }>("select key, value from app_config order by 1");
  console.log("app_config:", cfg.map((c) => `${c.key}=${c.value}`).join(" | "));
}
main().catch((e) => { console.error(String(e)); process.exit(1); });

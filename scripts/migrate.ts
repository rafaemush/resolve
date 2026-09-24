/**
 * Migration runner for Resolve (Supabase Free, via the Management API).
 *   npx tsx scripts/migrate.ts [--dry-run]    list applied / pending / DRIFT migrations; reads only
 *   npx tsx scripts/migrate.ts --apply        apply pending migrations in order (refuses while anything drifts)
 *   npx tsx scripts/migrate.ts --verify-live  read the database, not the ledger
 *   npx tsx scripts/migrate.ts --require-applied  reads only; exit 0 when every file is applied and nothing drifts, 1
 *                                              otherwise, 3 when SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN are unset
 *                                              (cannot look: the deploy gate reports it, DRY_RUN=1 as SKIPPED)
 * Applied state lives in public.schema_migrations (name, sha256). DRIFT (a file edited after it ran, or a ledger row
 * whose file is gone) exits 1 and applies nothing: scripts/lib/migrations.ts. Every migration file is written to be
 * idempotent.
 */
import { resolve } from "node:path";
import { loadEnv } from "./lib/env";
import { sql, dq } from "./lib/mgmt";
import { EXIT_CANNOT_CHECK, parseMigrateArgs, readLedger, readMigrationFiles, runMigrations, UsageError, USAGE, type MigrateIo, type Mode } from "./lib/migrations";

const io: MigrateIo = { sql, dq, log: (line) => console.log(line) };

async function verifyLive(): Promise<void> {
  const tables = await sql<{ table_name: string }>("select table_name from information_schema.tables where table_schema='public' order by 1");
  const fns = await sql<{ routine_name: string }>("select routine_name from information_schema.routines where routine_schema='public' order by 1");
  const exts = await sql<{ extname: string; extversion: string }>("select extname, extversion from pg_extension order by 1");
  const jobs = await sql<{ jobname: string; schedule: string; active: boolean }>("select jobname, schedule, active from cron.job order by 1").catch(() => []);
  const rls = await sql<{ tablename: string; rowsecurity: boolean }>("select tablename, rowsecurity from pg_tables where schemaname='public' order by 1");
  console.log("tables:", tables.map((t) => t.table_name).join(", "));
  console.log("functions:", fns.map((f) => f.routine_name).join(", "));
  console.log("extensions:", exts.map((e) => `${e.extname}@${e.extversion}`).join(", "));
  console.log("cron jobs:", jobs.map((j) => `${j.jobname}[${j.schedule}${j.active ? "" : ",inactive"}]`).join(", ") || "(none)");
  const noRls = rls.filter((r) => !r.rowsecurity).map((r) => r.tablename);
  console.log("tables WITHOUT rls:", noRls.length ? noRls.join(", ") : "(none)");
  console.log("ledger:", [...(await readLedger(io)).keys()].join(", ") || "(empty)");
}

async function main(): Promise<number> {
  let mode: Mode;
  try { mode = parseMigrateArgs(process.argv.slice(2)); } catch (e) {
    if (e instanceof UsageError) { console.error(`${e.message}\n${USAGE}`); return 2; }
    throw e;
  }
  loadEnv();
  if (mode === "--require-applied") {
    const missing = ["SUPABASE_PROJECT_REF", "SUPABASE_ACCESS_TOKEN"].filter((k) => !process.env[k]);
    if (missing.length) { console.log(`cannot check the migration ledger: ${missing.join(" and ")} not set`); return EXIT_CANNOT_CHECK; }
  }
  if (mode === "--verify-live") { await verifyLive(); return 0; }
  return runMigrations(mode, readMigrationFiles(resolve(process.cwd(), "supabase/migrations")), io);
}

main().then((code) => process.exit(code), (e) => { console.error(String(e)); process.exit(1); });

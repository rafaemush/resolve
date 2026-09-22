/**
 * Migration runner for Resolve (Supabase Free, via the Management API).
 *   pnpm tsx scripts/migrate.ts --dry-run      list pending migrations
 *   pnpm tsx scripts/migrate.ts --apply        apply pending migrations in order
 *   pnpm tsx scripts/migrate.ts --verify-live  read the database, not the ledger
 * Applied state lives in public.schema_migrations (name, sha256). A file whose
 * sha256 differs from the recorded one is reported as DRIFT and never re-run
 * silently. Every migration file is written to be idempotent.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadEnv } from "./lib/env";
import { sql, dq } from "./lib/mgmt";

loadEnv();
const mode = process.argv[2] ?? "--dry-run";
const dir = resolve(process.cwd(), "supabase/migrations");

async function ensureLedger() {
  await sql(`
    create table if not exists public.schema_migrations (
      name text primary key, sha256 text not null, applied_at timestamptz not null default now());
    alter table public.schema_migrations enable row level security;
    alter table public.schema_migrations force row level security;
    drop policy if exists schema_migrations_service on public.schema_migrations;
    create policy schema_migrations_service on public.schema_migrations for all to service_role using (true) with check (true);
    drop policy if exists schema_migrations_deny on public.schema_migrations;
    create policy schema_migrations_deny on public.schema_migrations for all to anon, authenticated using (false) with check (false);
  `);
}

async function main() {
  await ensureLedger();
  const applied = new Map<string, string>();
  for (const r of await sql<{ name: string; sha256: string }>("select name, sha256 from public.schema_migrations order by name")) applied.set(r.name, r.sha256);
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();

  if (mode === "--verify-live") {
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
    console.log("ledger:", [...applied.keys()].join(", ") || "(empty)");
    return;
  }

  let pending = 0;
  for (const f of files) {
    const body = readFileSync(resolve(dir, f), "utf8");
    const sha = createHash("sha256").update(body).digest("hex");
    const rec = applied.get(f);
    if (rec === sha) { console.log(`= ${f} (applied)`); continue; }
    if (rec && rec !== sha) { console.log(`! ${f} DRIFT: file sha ${sha.slice(0, 12)} != ledger ${rec.slice(0, 12)} — not re-run`); continue; }
    pending++;
    if (mode !== "--apply") { console.log(`+ ${f} (pending)`); continue; }
    process.stdout.write(`> ${f} ... `);
    const t0 = Date.now();
    try {
      await sql(body, { timeoutMs: 300_000 });
    } catch (e) {
      console.log("FAILED");
      console.error(String(e));
      process.exit(1);
    }
    await sql(`insert into public.schema_migrations (name, sha256) values (${dq(f)}, ${dq(sha)}) on conflict (name) do update set sha256 = excluded.sha256, applied_at = now()`);
    console.log(`ok (${Date.now() - t0} ms)`);
  }
  if (mode !== "--apply") console.log(`${pending} pending`);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });

/**
 * Rules of scripts/migrate.ts (tests/migrate.test.ts). public.schema_migrations records (name, sha256) for every
 * applied file. DRIFT is any disagreement between that ledger and supabase/migrations: a file whose sha256 differs from
 * its ledger row (it was edited after it ran), or a ledger row with no file (it was renamed or deleted, and a renamed
 * file would otherwise look pending and run twice). Either way the database was built from text the repo no longer
 * holds, so nothing is applied on top of it and the run exits 1 (plan §16.4 P0 step 5). A person resolves drift; the
 * runner never re-runs a file.
 * --dry-run reads and writes nothing: the ledger table is created only by --apply.
 * --require-applied reads like --dry-run and exits 1 unless every file is applied and nothing drifts: the deploy gate
 * (scripts/deploy.sh) runs it before wrangler, because the Worker it ships may read what a pending migration creates.
 * It is the production gate (wrangler.toml deploys one Worker), so it names the project it reads and refuses a ledger
 * that may not be production's (ledgerTargetRefusal); staging's pending list is --dry-run's.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Mode = "--dry-run" | "--apply" | "--verify-live" | "--require-applied";

export class UsageError extends Error {}
export const USAGE = "usage: npx tsx scripts/migrate.ts [--dry-run (default) | --apply | --verify-live | --require-applied]";
/** --require-applied could not look (no Management API credentials): not "all applied", and not a failure to report as one. */
export const EXIT_CANNOT_CHECK = 3;

/** Exactly one mode (none = --dry-run). Anything else stops, so a typo never becomes a different run. */
export function parseMigrateArgs(argv: readonly string[]): Mode {
  if (argv.length === 0) return "--dry-run";
  if (argv.length > 1) throw new UsageError(`one mode at a time, got: ${argv.join(" ")}`);
  const m = argv[0];
  if (m === "--dry-run" || m === "--apply" || m === "--verify-live" || m === "--require-applied") return m;
  throw new UsageError(`unknown argument "${m}"`);
}

/** Where --require-applied reads the ledger: the effective SUPABASE_PROJECT_REF and what it could have come from. */
export interface LedgerTarget {
  ref: string;
  /** SUPABASE_PROJECT_REF as the shell had it before .env was read (scripts/lib/env.ts never overrides it). */
  shellRef: string | undefined;
  /** SUPABASE_PROJECT_REF in .env. */
  dotenvRef: string | undefined;
  stagingRef: string | undefined;
  /** The SUPABASE_URL the scripts use (https://<ref>.supabase.co), shell first, then .env. */
  supabaseUrl: string | undefined;
}

/**
 * Why this ledger cannot approve a production deploy, or null. A shell that still exports staging's ref after a staging
 * session would otherwise make the gate pass on staging's ledger while production has migrations pending: refused when
 * the ref is STAGING_SUPABASE_PROJECT_REF, when the shell's ref differs from .env's (the gate does not guess which one
 * the Worker reads), or when SUPABASE_URL names another Supabase project.
 */
export function ledgerTargetRefusal(t: LedgerTarget): string | null {
  if (t.stagingRef && t.ref === t.stagingRef) return `SUPABASE_PROJECT_REF ${t.ref} is STAGING_SUPABASE_PROJECT_REF: staging's ledger cannot approve a production deploy (unset SUPABASE_PROJECT_REF in this shell)`;
  if (t.shellRef && t.dotenvRef && t.shellRef !== t.dotenvRef) return `the shell's SUPABASE_PROJECT_REF ${t.shellRef} differs from .env's ${t.dotenvRef}: the gate does not guess which database the Worker reads (unset it in this shell, or fix .env)`;
  if (t.supabaseUrl) {
    let host: string;
    try { host = new URL(t.supabaseUrl).hostname; } catch { return "SUPABASE_URL is not a URL: the gate cannot tell which project the Worker reads"; }
    const m = /^([a-z0-9]+)\.supabase\.co$/.exec(host);
    if (m && m[1] !== t.ref) return `SUPABASE_URL names project ${m[1]} but SUPABASE_PROJECT_REF is ${t.ref}: the gate would read another database's ledger`;
  }
  return null;
}

export interface MigrationFile { name: string; body: string; sha256: string }

const FILE_NAME = /^\d{3}_.+\.sql$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** NNN_name.sql files of a directory in apply order (lexical = numeric for three-digit prefixes). */
export function readMigrationFiles(dir: string): MigrationFile[] {
  return readdirSync(dir).filter((f) => FILE_NAME.test(f)).sort().map((name) => {
    const body = readFileSync(resolve(dir, name), "utf8");
    return { name, body, sha256: sha256(body) };
  });
}

export type Planned =
  | { status: "applied"; file: MigrationFile }
  | { status: "pending"; file: MigrationFile }
  | { status: "drift"; file: MigrationFile; ledgerSha256: string }
  | { status: "missing_file"; name: string; ledgerSha256: string };

/** Pure. Files in order, then ledger rows that have no file. */
export function planMigrations(files: readonly MigrationFile[], ledger: ReadonlyMap<string, string>): Planned[] {
  const out: Planned[] = files.map((file): Planned => {
    const rec = ledger.get(file.name);
    if (rec === undefined) return { status: "pending", file };
    return rec === file.sha256 ? { status: "applied", file } : { status: "drift", file, ledgerSha256: rec };
  });
  const names = new Set(files.map((f) => f.name));
  for (const [name, rec] of [...ledger].sort(([a], [b]) => a.localeCompare(b))) if (!names.has(name)) out.push({ status: "missing_file", name, ledgerSha256: rec });
  return out;
}

export function describePlanned(p: Planned): string {
  switch (p.status) {
    case "applied": return `= ${p.file.name} (applied)`;
    case "pending": return `+ ${p.file.name} (pending)`;
    case "drift": return `! ${p.file.name} DRIFT: file sha ${p.file.sha256.slice(0, 12)} != ledger ${p.ledgerSha256.slice(0, 12)}`;
    case "missing_file": return `! ${p.name} DRIFT: in the ledger (sha ${p.ledgerSha256.slice(0, 12)}) but no such file in supabase/migrations`;
  }
}

/** What a person does about drift; the runner itself never changes a ledger row. */
export function driftHelp(drifted: readonly Planned[]): string[] {
  const lines = [
    `${drifted.length} migration(s) disagree with the ledger; nothing was applied.`,
    "An applied migration must not change: restore it from git (git log -p -- supabase/migrations/<file>) and put the change in a new numbered migration.",
    "Only if a person has checked (--verify-live, psql) that the database already matches the file as it is now, record that by hand:",
  ];
  for (const p of drifted) {
    if (p.status === "drift") lines.push(`  update public.schema_migrations set sha256 = '${p.file.sha256}' where name = '${p.file.name}';`);
    else if (p.status === "missing_file") lines.push(`  (${p.name}: restore the file under its applied name; a rename would run it again)`);
  }
  return lines;
}

/** The ledger table (created by --apply only). Idempotent. */
export const ENSURE_LEDGER = `
    create table if not exists public.schema_migrations (
      name text primary key, sha256 text not null, applied_at timestamptz not null default now());
    alter table public.schema_migrations enable row level security;
    alter table public.schema_migrations force row level security;
    drop policy if exists schema_migrations_service on public.schema_migrations;
    create policy schema_migrations_service on public.schema_migrations for all to service_role using (true) with check (true);
    drop policy if exists schema_migrations_deny on public.schema_migrations;
    create policy schema_migrations_deny on public.schema_migrations for all to anon, authenticated using (false) with check (false);
  `;

export type Sql = (query: string, opts?: { timeoutMs?: number }) => Promise<Array<Record<string, unknown>>>;
export interface MigrateIo { sql: Sql; dq: (value: string) => string; log: (line: string) => void }

/** The ledger as name -> sha256; empty when the table does not exist yet (read-only: never creates it). */
export async function readLedger(io: MigrateIo): Promise<Map<string, string>> {
  const [probe] = await io.sql("select to_regclass('public.schema_migrations') is not null as present");
  const ledger = new Map<string, string>();
  if (probe?.present !== true) return ledger;
  for (const r of await io.sql("select name, sha256 from public.schema_migrations order by name")) ledger.set(String(r.name), String(r.sha256));
  return ledger;
}

/**
 * --dry-run, --require-applied or --apply; returns the exit code. Drift stops all three before anything is applied;
 * --require-applied also exits 1 while anything is pending. Only --apply writes.
 */
export async function runMigrations(mode: "--dry-run" | "--apply" | "--require-applied", files: readonly MigrationFile[], io: MigrateIo): Promise<number> {
  if (mode === "--apply") await io.sql(ENSURE_LEDGER);
  const ledger = await readLedger(io);
  if (!ledger.size) io.log("(ledger empty or absent: every file is pending)");
  const plan = planMigrations(files, ledger);
  for (const p of plan) io.log(describePlanned(p));
  const drifted = plan.filter((p) => p.status === "drift" || p.status === "missing_file");
  if (drifted.length) {
    for (const line of driftHelp(drifted)) io.log(line);
    return 1;
  }
  const pending = plan.flatMap((p) => (p.status === "pending" ? [p.file] : []));
  if (mode === "--dry-run") { io.log(`${pending.length} pending`); return 0; }
  if (mode === "--require-applied") {
    if (!pending.length) { io.log(`all ${files.length} migrations applied`); return 0; }
    io.log(`${pending.length} pending: apply them (npx tsx scripts/migrate.ts --apply) before deploying a Worker that may read them`);
    return 1;
  }
  for (const f of pending) {
    const t0 = Date.now();
    try {
      await io.sql(f.body, { timeoutMs: 300_000 });
    } catch (e) {
      io.log(`> ${f.name} FAILED`);
      io.log(String(e));
      return 1;
    }
    await io.sql(`insert into public.schema_migrations (name, sha256) values (${io.dq(f.name)}, ${io.dq(f.sha256)}) on conflict (name) do update set sha256 = excluded.sha256, applied_at = now()`);
    io.log(`> ${f.name} ok (${Date.now() - t0} ms)`);
  }
  io.log(`${pending.length} applied`);
  return 0;
}

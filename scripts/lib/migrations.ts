/**
 * Rules of scripts/migrate.ts (tests/migrate.test.ts). public.schema_migrations records (name, sha256) for every
 * applied file. DRIFT is any disagreement between that ledger and supabase/migrations: a file whose sha256 differs from
 * its ledger row (it was edited after it ran), or a ledger row with no file (it was renamed or deleted, and a renamed
 * file would otherwise look pending and run twice). Either way the database was built from text the repo no longer
 * holds, so nothing is applied on top of it and the run exits 1 (plan §16.4 P0 step 5). A person resolves drift; the
 * runner never re-runs a file.
 * --dry-run reads and writes nothing: the ledger table is created only by --apply.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Mode = "--dry-run" | "--apply" | "--verify-live";

export class UsageError extends Error {}
export const USAGE = "usage: npx tsx scripts/migrate.ts [--dry-run (default) | --apply | --verify-live]";

/** Exactly one mode (none = --dry-run). Anything else stops, so a typo never becomes a different run. */
export function parseMigrateArgs(argv: readonly string[]): Mode {
  if (argv.length === 0) return "--dry-run";
  if (argv.length > 1) throw new UsageError(`one mode at a time, got: ${argv.join(" ")}`);
  const m = argv[0];
  if (m === "--dry-run" || m === "--apply" || m === "--verify-live") return m;
  throw new UsageError(`unknown argument "${m}"`);
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

/** --dry-run or --apply; returns the exit code. Drift stops both before anything is applied. */
export async function runMigrations(mode: "--dry-run" | "--apply", files: readonly MigrationFile[], io: MigrateIo): Promise<number> {
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

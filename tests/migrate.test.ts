/**
 * scripts/migrate.ts rules (plan §16.4 P0 step 5): DRIFT exits 1 and applies nothing, in --dry-run and in --apply; a
 * ledger row whose file is gone is drift too (a renamed file would otherwise run twice); --dry-run never writes; pending
 * files run in order and stop at the first failure. The database is a fake that records every query.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENSURE_LEDGER, ledgerTargetRefusal, parseMigrateArgs, planMigrations, readMigrationFiles, runMigrations, UsageError, type MigrateIo, type MigrationFile } from "../scripts/lib/migrations";

const file = (name: string, body: string): MigrationFile => ({ name, body, sha256: createHash("sha256").update(body).digest("hex") });
const F1 = file("001_a.sql", "create table a ();"), F2 = file("002_b.sql", "create table b ();"), F3 = file("003_c.sql", "create table c ();");

/** A database whose ledger holds `ledger` (null = no ledger table); `failOn` makes that migration body throw. */
function fakeDb(ledger: Map<string, string> | null, failOn?: string) {
  const queries: string[] = [];
  const lines: string[] = [];
  const io: MigrateIo = {
    dq: (v) => `'${v}'`,
    log: (l) => lines.push(l),
    sql: async (q) => {
      queries.push(q);
      if (q.includes("to_regclass('public.schema_migrations')")) return [{ present: ledger !== null }];
      if (q.startsWith("select name, sha256 from public.schema_migrations")) return [...(ledger ?? new Map())].map(([name, sha256]) => ({ name, sha256 }));
      if (failOn && q === failOn) throw new Error("mgmt sql 400: syntax error");
      return [];
    },
  };
  const bodies = () => queries.filter((q) => [F1, F2, F3].some((f) => f.body === q));
  const writes = () => queries.filter((q) => !q.trimStart().startsWith("select"));
  return { io, queries, lines, bodies, writes };
}

describe("planMigrations", () => {
  it("applied, pending and drift by sha256; ledger rows without a file are drift too", () => {
    const plan = planMigrations([F1, F2, F3], new Map([[F1.name, F1.sha256], [F2.name, "0".repeat(64)], ["000_gone.sql", "f".repeat(64)]]));
    expect(plan.map((p) => p.status)).toEqual(["applied", "drift", "pending", "missing_file"]);
  });
  it("reads the real migrations directory in numeric order", () => {
    const names = readMigrationFiles(resolve(process.cwd(), "supabase/migrations")).map((f) => f.name);
    expect(names.length).toBeGreaterThanOrEqual(14);
    expect(names).toEqual([...names].sort());
    expect(names.every((n) => /^\d{3}_.+\.sql$/.test(n))).toBe(true);
  });
});

describe("runMigrations", () => {
  it("--dry-run: lists pending, exits 0 and sends only SELECTs (the ledger table is never created)", async () => {
    const db = fakeDb(new Map([[F1.name, F1.sha256]]));
    expect(await runMigrations("--dry-run", [F1, F2], db.io)).toBe(0);
    expect(db.writes()).toEqual([]);
    expect(db.lines).toEqual(["= 001_a.sql (applied)", "+ 002_b.sql (pending)", "1 pending"]);
    const none = fakeDb(null);
    expect(await runMigrations("--dry-run", [F1], none.io)).toBe(0);
    expect(none.writes()).toEqual([]);
    expect(none.queries.some((q) => q.startsWith("select name, sha256"))).toBe(false);
  });

  it("DRIFT exits 1 in --dry-run", async () => {
    const db = fakeDb(new Map([[F1.name, "0".repeat(64)]]));
    expect(await runMigrations("--dry-run", [F1, F2], db.io)).toBe(1);
    expect(db.lines).toContain(`! 001_a.sql DRIFT: file sha ${F1.sha256.slice(0, 12)} != ledger 000000000000`);
    expect(db.lines).toContain(`  update public.schema_migrations set sha256 = '${F1.sha256}' where name = '001_a.sql';`);
    expect(db.writes()).toEqual([]);
  });

  it("DRIFT exits 1 in --apply and applies nothing, not even the pending files after it", async () => {
    const db = fakeDb(new Map([[F1.name, F1.sha256], [F2.name, "0".repeat(64)]]));
    expect(await runMigrations("--apply", [F1, F2, F3], db.io)).toBe(1);
    expect(db.bodies()).toEqual([]);
    expect(db.queries.some((q) => q.includes("insert into public.schema_migrations"))).toBe(false);
  });

  it("a ledger row whose file was renamed stops --apply before the renamed file runs a second time", async () => {
    const renamed = file("001_a_renamed.sql", F1.body);
    const db = fakeDb(new Map([[F1.name, F1.sha256]]));
    expect(await runMigrations("--apply", [renamed], db.io)).toBe(1);
    expect(db.bodies()).toEqual([]);
    expect(db.lines.some((l) => l.startsWith("! 001_a.sql DRIFT: in the ledger"))).toBe(true);
  });

  it("--apply runs pending files in order, records each in the ledger and stops at the first failure", async () => {
    const ok = fakeDb(new Map([[F1.name, F1.sha256]]));
    expect(await runMigrations("--apply", [F1, F2, F3], ok.io)).toBe(0);
    expect(ok.queries[0]).toBe(ENSURE_LEDGER);
    expect(ok.bodies()).toEqual([F2.body, F3.body]);
    expect(ok.queries.filter((q) => q.includes("insert into public.schema_migrations")).map((q) => q.includes(`'${F2.sha256}'`) || q.includes(`'${F3.sha256}'`))).toEqual([true, true]);

    const bad = fakeDb(new Map(), F2.body);
    expect(await runMigrations("--apply", [F1, F2, F3], bad.io)).toBe(1);
    expect(bad.bodies()).toEqual([F1.body, F2.body]);
    expect(bad.queries.filter((q) => q.includes("insert into public.schema_migrations"))).toHaveLength(1);
    expect(bad.lines).toContain("> 002_b.sql FAILED");
  });
});

describe("--require-applied (the deploy gate)", () => {
  it("exit 0 only when every file is applied; pending exits 1; nothing is ever written", async () => {
    const all = fakeDb(new Map([[F1.name, F1.sha256], [F2.name, F2.sha256]]));
    expect(await runMigrations("--require-applied", [F1, F2], all.io)).toBe(0);
    expect(all.lines.at(-1)).toBe("all 2 migrations applied");
    const pending = fakeDb(new Map([[F1.name, F1.sha256]]));
    expect(await runMigrations("--require-applied", [F1, F2, F3], pending.io)).toBe(1);
    expect(pending.lines.at(-1)).toContain("2 pending");
    const none = fakeDb(null);
    expect(await runMigrations("--require-applied", [F1], none.io)).toBe(1);
    for (const db of [all, pending, none]) expect(db.writes()).toEqual([]);
  });
  it("drift and a ledger row without its file exit 1", async () => {
    expect(await runMigrations("--require-applied", [F1], fakeDb(new Map([[F1.name, "0".repeat(64)]])).io)).toBe(1);
    expect(await runMigrations("--require-applied", [F1], fakeDb(new Map([[F1.name, F1.sha256], ["000_gone.sql", "f".repeat(64)]])).io)).toBe(1);
  });
});

describe("ledgerTargetRefusal (--require-applied reads production's ledger or refuses)", () => {
  const prod = { ref: "prodref", shellRef: undefined, dotenvRef: "prodref", stagingRef: "stagref", supabaseUrl: "https://prodref.supabase.co" };
  it("production's ref from .env, SUPABASE_URL agreeing: allowed", () => {
    expect(ledgerTargetRefusal(prod)).toBeNull();
    expect(ledgerTargetRefusal({ ...prod, shellRef: "prodref", dotenvRef: undefined, supabaseUrl: undefined })).toBeNull(); // CI: no .env
    expect(ledgerTargetRefusal({ ...prod, supabaseUrl: "https://db.resolve.example" })).toBeNull(); // not a supabase.co host: nothing to compare
  });
  it("a staging session left exported can never approve a production deploy", () => {
    expect(ledgerTargetRefusal({ ...prod, ref: "stagref", shellRef: "stagref" })).toContain("STAGING_SUPABASE_PROJECT_REF");
    // without STAGING_SUPABASE_PROJECT_REF set: the shell overriding .env is refused, not guessed
    expect(ledgerTargetRefusal({ ...prod, ref: "stagref", shellRef: "stagref", stagingRef: undefined })).toContain("differs from .env's prodref");
    // SUPABASE_URL (the database the scripts, and by convention the Worker, use) naming another project
    expect(ledgerTargetRefusal({ ...prod, ref: "otherref", shellRef: undefined, dotenvRef: "otherref", stagingRef: undefined, supabaseUrl: "https://prodref.supabase.co" })).toContain("SUPABASE_URL names project prodref");
    expect(ledgerTargetRefusal({ ...prod, supabaseUrl: "not a url" })).toContain("not a URL");
  });
});

describe("parseMigrateArgs", () => {
  it("one mode, dry run by default; anything else stops", () => {
    expect(parseMigrateArgs([])).toBe("--dry-run");
    for (const m of ["--dry-run", "--apply", "--verify-live", "--require-applied"] as const) expect(parseMigrateArgs([m])).toBe(m);
    for (const argv of [["--aply"], ["--apply", "--dry-run"], ["apply"], ["--apply=1"]]) expect(() => parseMigrateArgs(argv), argv.join(" ")).toThrow(UsageError);
  });
});

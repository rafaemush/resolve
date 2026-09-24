/**
 * Shared pieces of the database self-tests (scripts/selftest-db.ts and every scripts/selftest/*.ts): run a DO block that
 * always raises at the end, so its transaction rolls back and nothing persists, and read the results it raised; print
 * PASS/FAIL per expected key; decide whether a target may be used at all.
 * A block runs through the Supabase Management API against the project .env names, or with `--psql <conninfo>` through
 * psql against any Postgres (a local throwaway cluster with the migrations applied).
 */
import { spawnSync } from "node:child_process";
import { sql } from "./mgmt";

/** Runs one DO block and returns the text of the error it raised (a block that does not raise is a broken test). */
export type BlockRunner = (block: string) => Promise<string>;

const managementApi: BlockRunner = async (block) => {
  try {
    await sql(block);
    return "the block finished without raising: it is not rollback-only";
  } catch (e) {
    const msg = String(e);
    const j = msg.indexOf("{");
    if (j >= 0) { try { return String(JSON.parse(msg.slice(j)).message ?? msg); } catch { /* keep the raw text */ } }
    return msg;
  }
};

function psql(conninfo: string): BlockRunner {
  return async (block) => {
    const r = spawnSync(process.env.PSQL_BIN || "psql", [conninfo, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", block], { encoding: "utf8" });
    if (r.error) return `psql could not run: ${r.error.message}`;
    return r.status === 0 ? "the block finished without raising: it is not rollback-only" : r.stderr;
  };
}

export class UsageError extends Error {}

/** `--psql <conninfo>` picks psql; otherwise the Management API. */
export function blockRunner(argv: readonly string[]): { run: BlockRunner; via: "psql" | "management_api"; conninfo: string | null } {
  const i = argv.indexOf("--psql");
  if (i < 0) return { run: managementApi, via: "management_api", conninfo: null };
  const conninfo = argv[i + 1];
  if (!conninfo || conninfo.startsWith("--")) throw new UsageError("--psql needs a connection string, e.g. --psql postgresql://postgres@localhost:5541/resolve");
  return { run: psql(conninfo), via: "psql", conninfo };
}

/** The JSON a block raised as `<tag> {...}`; null when the block failed some other way (the caller prints `raw`). */
export function raisedResults(tag: string, raw: string): Record<string, unknown> | null {
  const m = raw.match(new RegExp(`${tag} (\\{.*\\})`, "s"));
  if (!m) return null;
  try { return JSON.parse(m[1]!) as Record<string, unknown>; } catch { return null; }
}

/** Print PASS/FAIL per expected key ("a.b" reads a nested key); returns the number of failures. */
export function check(r: Record<string, unknown>, expect: Record<string, unknown>, prefix = ""): number {
  let bad = 0;
  for (const [k, v] of Object.entries(expect)) {
    const got = k.includes(".") ? (r[k.split(".")[0]!] as Record<string, unknown> | undefined)?.[k.split(".")[1]!] : r[k];
    const ok = JSON.stringify(got) === JSON.stringify(v);
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} ${prefix}${k} = ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(v)})`}`);
  }
  return bad;
}

/** The project .env names is staging: both refs set and equal. */
export function targetIsStaging(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.SUPABASE_PROJECT_REF && !!env.STAGING_SUPABASE_PROJECT_REF && env.SUPABASE_PROJECT_REF === env.STAGING_SUPABASE_PROJECT_REF;
}

/**
 * Why a rollback-only block may not run here, or null when it may: the target is staging, or the operator declared a
 * non-production target (RESOLVE_SELFTEST_NON_PRODUCTION=1: a local cluster or another scratch project). A block rolls
 * back, but a test that writes rows inside production's transaction still takes its locks there.
 */
export function nonProductionRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (targetIsStaging(env) || env.RESOLVE_SELFTEST_NON_PRODUCTION === "1") return null;
  return "refused: SUPABASE_PROJECT_REF is not STAGING_SUPABASE_PROJECT_REF and RESOLVE_SELFTEST_NON_PRODUCTION=1 is not set (never run against production)";
}

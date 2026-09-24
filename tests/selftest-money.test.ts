/**
 * scripts/selftest/money.ts, without a database: it refuses any target not declared non-production or equal to the
 * staging project, reads its results from either transport's error text, compares jsonb objects whatever their key
 * order, and every expectation names a key the SQL block really produces (a renamed key would otherwise FAIL forever or,
 * worse, be dropped from the block unnoticed). The block itself runs against Postgres (staging, or a local cluster).
 */
import { describe, expect, it, vi } from "vitest";
import { allowedTarget, check, MONEY_SELFTEST_EXPECT, MONEY_SELFTEST_SQL, parseResults } from "../scripts/selftest/money";

describe("scripts/selftest/money.ts", () => {
  it("runs only against a declared non-production target or the staging project", () => {
    expect(allowedTarget({})).toBe(false);
    expect(allowedTarget({ SUPABASE_PROJECT_REF: "prod" })).toBe(false);
    expect(allowedTarget({ SUPABASE_PROJECT_REF: "prod", STAGING_SUPABASE_PROJECT_REF: "stag" })).toBe(false);
    expect(allowedTarget({ SUPABASE_PROJECT_REF: "stag", STAGING_SUPABASE_PROJECT_REF: "stag" })).toBe(true);
    expect(allowedTarget({ SUPABASE_PROJECT_REF: "", STAGING_SUPABASE_PROJECT_REF: "" })).toBe(false);
    expect(allowedTarget({ RESOLVE_SELFTEST_NON_PRODUCTION: "1" })).toBe(true);
    expect(allowedTarget({ RESOLVE_SELFTEST_NON_PRODUCTION: "true" })).toBe(false);
  });

  it("reads the raised results from psql's stderr and from the Management API's error body", () => {
    const results = { tier_50: 5000, match: { replayed: false } };
    expect(parseResults(`ERROR:  SELFTEST_MONEY ${JSON.stringify(results)}\nCONTEXT:  PL/pgSQL function inline_code_block line 190 at RAISE`)).toEqual(results);
    expect(parseResults(`Error: mgmt sql 400: ${JSON.stringify({ message: `ERROR: P0001: SELFTEST_MONEY ${JSON.stringify(results)}` })}`)).toEqual(results);
    expect(parseResults("ERROR:  relation \"wallet_challenges\" does not exist")).toBeNull();
  });

  it("compares objects whatever the key order jsonb returns them in", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(check({ match: { rate: 110, status: "credited" } }, { match: { status: "credited", rate: 110 } })).toBe(0);
    expect(check({ match: { rate: 100, status: "credited" } }, { match: { status: "credited", rate: 110 } })).toBe(1);
    log.mockRestore();
  });

  it("every expectation is a key the SQL block produces", () => {
    // Two loops build their keys: 'tier_' || replace(amount, '.', '_') [|| '_status'] and 'malformed_' || name.
    const tier = /^tier_(\d+(?:_\d+)?)(?:_status)?$/;
    const malformed = /^malformed_(?!rows_written$)(.+)$/;
    const missing = Object.keys(MONEY_SELFTEST_EXPECT).filter((k) => {
      const t = tier.exec(k), m = malformed.exec(k);
      if (t) return !MONEY_SELFTEST_SQL.includes(`('${t[1]!.replace("_", ".")}', `);
      if (m) return !MONEY_SELFTEST_SQL.includes(`('${m[1]}', `);
      return !MONEY_SELFTEST_SQL.includes(`'${k}'`) && !MONEY_SELFTEST_SQL.includes(`"${k}"`);
    });
    expect(missing).toEqual([]);
    expect(MONEY_SELFTEST_SQL.trim().endsWith("end $$;")).toBe(true);
    expect(MONEY_SELFTEST_SQL).toContain("raise exception 'SELFTEST_MONEY %'");
  });
});

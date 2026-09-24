/**
 * scripts/lib/selftest.ts: the target guard every rollback-only block and the persisting probe rely on, and reading the
 * results a block raised from either transport (Management API JSON error, psql stderr). Nothing here reaches a database.
 */
import { describe, expect, it } from "vitest";
import { blockRunner, conninfoTarget, describeTarget, nonProductionRefusal, raisedResults, targetIsStaging, UsageError } from "../scripts/lib/selftest";

describe("target guard", () => {
  it("staging only when both refs are set and equal; an explicit non-production declaration also passes", () => {
    expect(targetIsStaging({ SUPABASE_PROJECT_REF: "abc", STAGING_SUPABASE_PROJECT_REF: "abc" })).toBe(true);
    expect(targetIsStaging({ SUPABASE_PROJECT_REF: "prod", STAGING_SUPABASE_PROJECT_REF: "abc" })).toBe(false);
    expect(targetIsStaging({ SUPABASE_PROJECT_REF: "", STAGING_SUPABASE_PROJECT_REF: "" })).toBe(false);
    expect(targetIsStaging({})).toBe(false);
    expect(nonProductionRefusal({ SUPABASE_PROJECT_REF: "abc", STAGING_SUPABASE_PROJECT_REF: "abc" })).toBeNull();
    expect(nonProductionRefusal({ SUPABASE_PROJECT_REF: "prod", RESOLVE_SELFTEST_NON_PRODUCTION: "1" })).toBeNull();
    expect(nonProductionRefusal({ SUPABASE_PROJECT_REF: "prod", RESOLVE_SELFTEST_NON_PRODUCTION: "true" })).toContain("refused");
    expect(nonProductionRefusal({ SUPABASE_PROJECT_REF: "prod" })).toContain("never run against production");
  });

  it("through psql only the explicit declaration counts: a staging SUPABASE_PROJECT_REF says nothing about the connection string", () => {
    expect(nonProductionRefusal({ SUPABASE_PROJECT_REF: "abc", STAGING_SUPABASE_PROJECT_REF: "abc" }, "psql")).toContain("RESOLVE_SELFTEST_NON_PRODUCTION=1");
    expect(nonProductionRefusal({ RESOLVE_SELFTEST_NON_PRODUCTION: "1" }, "psql")).toBeNull();
    expect(nonProductionRefusal({ SUPABASE_PROJECT_REF: "abc", STAGING_SUPABASE_PROJECT_REF: "abc" }, "management_api")).toBeNull();
  });

  it("names the target without a user or a password", () => {
    expect(describeTarget({ via: "management_api", conninfo: null }, { SUPABASE_PROJECT_REF: "prodref" })).toBe("Supabase project prodref through the Management API");
    expect(describeTarget({ via: "management_api", conninfo: null }, { SUPABASE_PROJECT_REF: "abc", STAGING_SUPABASE_PROJECT_REF: "abc" })).toContain("(= STAGING_SUPABASE_PROJECT_REF)");
    expect(describeTarget({ via: "management_api", conninfo: null }, {})).toContain("SUPABASE_PROJECT_REF not set");
    expect(describeTarget({ via: "psql", conninfo: "postgresql://postgres:s3cret@localhost:5541/resolve" }, {})).toBe("psql localhost:5541/resolve");
    expect(conninfoTarget("host=db.example port=6543 dbname=postgres user=u password='p w'")).toBe("db.example:6543/postgres");
    expect(conninfoTarget("resolve")).toBe("local socket/resolve");
    for (const t of [conninfoTarget("postgresql://postgres:s3cret@localhost:5541/resolve"), conninfoTarget("host=h password=s3cret")]) expect(t).not.toContain("s3cret");
  });
});

describe("raisedResults", () => {
  it("reads the tagged JSON from a psql error and from the Management API message", () => {
    const psql = 'ERROR:  SELFTEST_FIXES {"a": 1, "b": {"c": [1, 2]}}\nCONTEXT:  PL/pgSQL function inline_code_block line 180 at RAISE\n';
    expect(raisedResults("SELFTEST_FIXES", psql)).toEqual({ a: 1, b: { c: [1, 2] } });
    expect(raisedResults("SELFTEST_FIXES", 'ERROR: P0001: SELFTEST_FIXES {"ok": true}')).toEqual({ ok: true });
    expect(raisedResults("SELFTEST_FIXES", "ERROR:  relation \"post_leases\" does not exist")).toBeNull();
    expect(raisedResults("SELFTEST_FIXES", "SELFTEST_FIXES {not json}")).toBeNull();
  });
});

describe("blockRunner", () => {
  it("the Management API by default, psql with a connection string, a usage error without one", () => {
    expect(blockRunner([]).via).toBe("management_api");
    expect(blockRunner(["--all", "--psql", "postgresql://postgres@localhost:5541/resolve"])).toMatchObject({ via: "psql", conninfo: "postgresql://postgres@localhost:5541/resolve" });
    expect(() => blockRunner(["--psql"])).toThrow(UsageError);
    expect(() => blockRunner(["--psql", "--all"])).toThrow(UsageError);
  });
});

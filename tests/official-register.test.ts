/**
 * official_release registration rules (validateRegistration, pure), the option-label bucket parser behind
 * scripts/official-legs.ts, and a static lint of migration 016 (it is never applied from here).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateRegistration } from "../src/markets/register";
import { buildLegRegistration, parseBucketLabel } from "../src/markets/official-legs";
import type { MarketRegistration } from "../src/resolve/schema";
import { KNOWN_RELEASES } from "../src/resolve/official";

const cpiLeg = (label = "3.4%") => {
  const r = buildLegRegistration({ platform: "limitless", external_id: "30percent-1789462576829", group: { series: "us_cpi_u_nsa_yoy", period: "2026-09", release_at: "2026-10-14T12:30:00Z", title: "September Inflation US - Annual" }, label, open_at: "2026-09-15T08:56:56.799Z", deadline_utc: "2026-10-15T03:59:00Z", criteria: "<p>This market will resolve to the percentage change in the CPI ...</p>" });
  if (!r.ok) throw new Error(r.reason);
  return r.market;
};
const fedLeg = (over: Record<string, unknown> = {}) => {
  const r = buildLegRegistration({ platform: "polymarket", external_id: "12345", group: { series: "fomc_upper_bound", period: "2026-10-28", release_at: "2026-10-28T18:00:00Z", prior_level: 4, title: "Fed Decision in October?" }, label: "25 bps decrease", open_at: "2026-06-17T19:03:23Z", deadline_utc: "2026-10-28T23:59:00Z", criteria: "..." });
  if (!r.ok) throw new Error(r.reason);
  return { ...r.market, ...over } as MarketRegistration;
};
const withResolver = (m: MarketRegistration, over: Record<string, unknown>) => ({ ...m, resolver: { ...(m.resolver as object), ...over } });
const refusal = (input: unknown) => { try { validateRegistration(input); return null; } catch (e) { return String(e); } };

describe("official_release registration", () => {
  it("accepts a built leg: Yes/No, positive Yes, the series source and the resolver", () => {
    const reg = validateRegistration(cpiLeg());
    expect(reg).toMatchObject({ option_a: "Yes", option_b: "No", positive_option: "OPTION_A", sources: [{ kind: "official_release", ref: "official:us_cpi_u_nsa_yoy:2026-09" }] });
    expect(reg.resolver).toMatchObject({ kind: "official_release", series: "us_cpi_u_nsa_yoy", bucket: { label: "3.4%", lo: 3.4, hi: 3.4 }, rounding: "pct_1dp" });
    expect(validateRegistration(fedLeg()).resolver).toMatchObject({ prior_level: 4, rounding: "bps_away_from_zero_25", bucket: { lo: -25, hi: -25 } });
  });
  it("refuses the Bank of Japan: the official source is PDF-only", () => {
    const boj = { ...fedLeg(), sources: [{ kind: "official_release", ref: "official:boj_policy_rate:2026-10-30" }], resolver: { ...(fedLeg().resolver as object), series: "boj_policy_rate", period: "2026-10-30" } };
    expect(refusal(boj)).toContain("official source is PDF-only");
    expect(refusal({ ...cpiLeg(), sources: [{ kind: "official_release", ref: "official:boj_policy_rate:2026-10-30" }] })).toContain("official source is PDF-only");
  });
  it("the source ref must name the resolver's series and period", () => {
    expect(refusal({ ...cpiLeg(), sources: [{ kind: "official_release", ref: "official:us_ppi_fd_nsa_yoy:2026-09" }] })).toContain("does not match resolver us_cpi_u_nsa_yoy:2026-09");
    expect(refusal({ ...cpiLeg(), sources: [{ kind: "official_release", ref: "official:us_cpi_u_nsa_yoy:2026-08" }] })).toContain("does not match");
    expect(refusal({ ...cpiLeg(), sources: [{ kind: "official_release", ref: "https://www.bls.gov/news.release/cpi.nr0.htm" }] })).toContain("not official:<series>:<period>");
  });
  it("takes only official sources (the rail fetches the series' allowlisted hosts itself)", () => {
    const r = refusal({ ...cpiLeg(), sources: [{ kind: "official_release", ref: "official:us_cpi_u_nsa_yoy:2026-09" }, { kind: "web_fetch", ref: "https://www.bls.gov/news.release/cpi.nr0.htm" }] });
    expect(r).toContain("official_release markets take only official:<series>:<period> sources");
    expect(r).toContain("www.bls.gov, api.bls.gov");
    expect(refusal({ ...cpiLeg(), resolver: undefined })).toContain("need an official_release resolver");
  });
  it("the bucket must be non-empty, on the grid, and reachable", () => {
    expect(refusal(withResolver(cpiLeg(), { bucket: { label: "x", lo_inclusive: true, hi_inclusive: true } }))).toContain("neither lo nor hi");
    expect(refusal(withResolver(cpiLeg(), { bucket: { label: "x", lo: 3, hi: 3, lo_inclusive: false, hi_inclusive: false } }))).toContain("is empty");
    expect(refusal(withResolver(fedLeg(), { bucket: { label: "x", lo: 1, hi: 20, lo_inclusive: true, hi_inclusive: true } }))).toContain("no multiple of 25");
  });
  it("release_at may not precede open_at; rate series need prior_level; rounding must fit the unit; the period must fit the series", () => {
    expect(refusal(withResolver(cpiLeg(), { release_at: "2026-09-01T00:00:00Z" }))).toContain("before open_at");
    const noPrior = fedLeg(); delete (noPrior.resolver as { prior_level?: number }).prior_level;
    expect(refusal(noPrior)).toContain("prior_level is required");
    expect(refusal(withResolver(cpiLeg(), { prior_level: 3.4 }))).toContain("prior_level must be absent");
    expect(refusal(withResolver(cpiLeg(), { rounding: "bps_nearest_25_min_25" }))).toContain("does not fit");
    expect(refusal({ ...withResolver(fedLeg(), { period: "2026-10" }), sources: [{ kind: "official_release", ref: "official:fomc_upper_bound:2026-10" }] })).toContain("not a day period");
    expect(refusal({ ...withResolver(fedLeg(), { period: "2026-02-30" }), sources: [{ kind: "official_release", ref: "official:fomc_upper_bound:2026-02-30" }] })).toContain("not a day period");
  });
  // The leg file copies platform market texts, so it lives in the gitignored private/ folder (founder machine only);
  // CI has no copy and skips this check, and seed-shadow --check validates the same rules before anything is registered.
  const LEG_FILE = resolve(import.meta.dirname, "../private/shadow-markets/official-release-2026-09-24.json");
  it.skipIf(!existsSync(LEG_FILE))("every suggested leg in the private leg file passes registration and names its event's scheduled release", () => {
    const file = JSON.parse(readFileSync(LEG_FILE, "utf8")) as { entries: Array<{ market: MarketRegistration }> };
    expect(file.entries).toHaveLength(110);
    for (const e of file.entries) {
      const reg = validateRegistration(e.market);
      const r = reg.resolver as { series: string; period: string; release_at: string };
      expect(Date.parse(r.release_at), `${reg.platform}:${reg.external_id}`).toBe(Date.parse(KNOWN_RELEASES[`${r.series}:${r.period}`]!.release_at));
    }
  });
  it("other markets are untouched", () => {
    const web = { ...cpiLeg(), sources: [{ kind: "web_fetch", ref: "https://example.org/x" }], resolver: undefined };
    expect(refusal(web)).toBeNull();
  });
});

describe("option labels -> buckets", () => {
  const p = (l: string) => parseBucketLabel(l, "percent");
  const b = (l: string) => parseBucketLabel(l, "rate_change_bps");
  it("percent ladders", () => {
    expect(p("≤2.9%")).toEqual({ label: "≤2.9%", hi: 2.9, hi_inclusive: true, lo_inclusive: true });
    expect(p("3.0%")).toEqual({ label: "3.0%", lo: 3, hi: 3, lo_inclusive: true, hi_inclusive: true });
    expect(p("≥3.6%")).toEqual({ label: "≥3.6%", lo: 3.6, lo_inclusive: true, hi_inclusive: true });
    expect(p("2.0–2.4%")).toEqual({ label: "2.0–2.4%", lo: 2, hi: 2.4, lo_inclusive: true, hi_inclusive: true });
    expect(p("2.0-2.4%")).toMatchObject({ lo: 2, hi: 2.4 });
    expect(p("<2.0%")).toEqual({ label: "<2.0%", hi: 2, hi_inclusive: false, lo_inclusive: true });
    expect(p("5.0%+")).toEqual({ label: "5.0%+", lo: 5, lo_inclusive: true, hi_inclusive: true });
    expect(p("5.9%+")).toMatchObject({ lo: 5.9, lo_inclusive: true });
    expect(p("≤5.0%")).toMatchObject({ hi: 5, hi_inclusive: true });
    expect(p("-0.5%")).toMatchObject({ lo: -0.5, hi: -0.5 });
    expect(p("4.0% or more")).toMatchObject({ lo: 4, lo_inclusive: true });
    expect(p("about 3%")).toBeNull();
    expect(p("2.4–2.0%")).toBeNull();
  });
  it("rate-change ladders", () => {
    expect(b("25 bps decrease")).toEqual({ label: "25 bps decrease", lo: -25, hi: -25, lo_inclusive: true, hi_inclusive: true });
    expect(b("50+ bps increase")).toEqual({ label: "50+ bps increase", lo: 50, lo_inclusive: true, hi_inclusive: true });
    expect(b("50+ bps decrease")).toEqual({ label: "50+ bps decrease", hi: -50, hi_inclusive: true, lo_inclusive: true });
    expect(b("No change")).toEqual({ label: "No change", lo: 0, hi: 0, lo_inclusive: true, hi_inclusive: true });
    expect(b("No Change")).toMatchObject({ lo: 0, hi: 0 });
    expect(b("25 bps cut")).toMatchObject({ lo: -25, hi: -25 });
    expect(b("50+ bps cut")).toMatchObject({ hi: -50 });
    expect(b("25 bps hike")).toMatchObject({ lo: 25, hi: 25 });
    expect(b("50+ bps hike")).toMatchObject({ lo: 50 });
    expect(b("Decrease 25 bps")).toMatchObject({ lo: -25, hi: -25 });
    expect(b("Increase")).toMatchObject({ lo: 25, lo_inclusive: true });
    expect(b("10 bps cut")).toBeNull(); // off the 25 bp grid: never guessed
    expect(b("Emergency cut and hike")).toBeNull();
  });
});

describe("migration 016 (static lint; never applied from here)", () => {
  const sql = readFileSync(resolve(import.meta.dirname, "../supabase/migrations/016_official_release.sql"), "utf8");
  const body = sql.replace(/--[^\n]*/g, "");
  it("is one transaction and additive", () => {
    expect(body.trim().startsWith("begin;")).toBe(true);
    expect(body.trim().endsWith("commit;")).toBe(true);
    // top-level statements only: function bodies ($$ ... $$) may update their own tables
    const topLevel = body.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
    expect(topLevel).not.toMatch(/\bdrop\s+table\b|\bdrop\s+column\b|\balter\s+column\b|(^|;)\s*(truncate|delete\s+from|update)\s/im);
    expect(body).toMatch(/create table if not exists official_observations/);
    expect(body).toMatch(/create table if not exists official_fetch_slots/);
  });
  it("comments every new table, column and function; RLS on both tables", () => {
    for (const t of ["official_observations", "official_fetch_slots", "official_corroboration_history"]) {
      expect(body).toContain(`comment on table ${t} is`);
      expect(body).toContain(`select apply_rls('${t}')`);
      const cols = [...body.slice(body.indexOf(`create table if not exists ${t}`)).split(");")[0]!.matchAll(/^\s{2}(\w+)\s+(?:text|numeric|timestamptz|jsonb|integer|bigint)\b/gm)].map((m) => m[1]!);
      expect(cols.length).toBeGreaterThan(4);
      for (const c of cols) expect(body, `${t}.${c}`).toContain(`comment on column ${t}.${c} is`);
    }
    const fns = [...body.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]!);
    expect(fns.sort()).toEqual(["claim_official_fetch", "extend_official_fetch", "official_observations_guard", "recheck_official_corroboration", "record_official_observation"]);
    for (const f of fns) expect(body, f).toMatch(new RegExp(`comment on function public\\.${f}\\(`));
  });
  it("every function sets search_path, is revoked from public/anon/authenticated and granted to service_role only", () => {
    for (const f of ["record_official_observation", "claim_official_fetch", "extend_official_fetch", "recheck_official_corroboration", "official_observations_guard"]) {
      const def = body.slice(body.indexOf(`create or replace function public.${f}(`));
      expect(def.slice(0, def.indexOf("$$")), f).toContain("set search_path = public");
      expect(body, f).toMatch(new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon, authenticated;`));
      expect(body, f).toMatch(new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to service_role;`));
    }
    expect((body.match(/security definer/g) ?? []).length).toBe(4);
  });
  it("(6) the re-check is audited: history is append-only and written before the corroboration is superseded", () => {
    const fn = body.slice(body.indexOf("create or replace function public.recheck_official_corroboration("));
    const def = fn.slice(0, fn.indexOf("end $$;"));
    expect(def.indexOf("insert into official_corroboration_history")).toBeGreaterThan(0);
    expect(def.indexOf("insert into official_corroboration_history")).toBeLessThan(def.indexOf("update official_observations"));
    expect(def).not.toMatch(/set\s+(value|value_text|deciding_text|source_url|raw_sha256|observed_at)\b/);
    expect(body).toMatch(/create trigger official_corroboration_history_append_only before update or delete on official_corroboration_history\s+for each row execute function public\.deny_mutation\(\)/);
    expect(body).toContain("current_setting('resolve.official_recheck', true)");
  });
  it("(11) scripts/selftest-db.ts --official: opt-in, refused on a production target before any block runs, rollback-only, every expectation produced", () => {
    const script = readFileSync(resolve(import.meta.dirname, "../scripts/selftest-db.ts"), "utf8");
    const from = script.indexOf("const OFFICIAL_SELFTEST_SQL = `");
    const block = script.slice(from, script.indexOf("end $$;`;", from));
    expect(block.length).toBeGreaterThan(1000);
    expect(block.trimEnd().endsWith("raise exception 'SELFTEST_OFFICIAL %', out::text;")).toBe(true);
    // opt-in: --official runs only this block, after the target guard that every mode passes first (scripts/lib/selftest.ts,
    // tests/selftest-lib.test.ts)
    const main = script.slice(script.indexOf("async function main()"));
    expect(main).toMatch(/const refusal = nonProductionRefusal\(process\.env, runner\.via\);\s*if \(refusal\) \{[^\n]*return 2; \}/);
    const guard = main.indexOf("nonProductionRefusal(");
    expect(guard).toBeGreaterThan(0);
    for (const run of ['argv.includes("--official")', "rollbackBlocks(", "officialSelftest(", "selftestFiles("]) expect(main.indexOf(run), run).toBeGreaterThan(guard);
    expect(readFileSync(resolve(import.meta.dirname, "../scripts/lib/selftest.ts"), "utf8")).toContain('env.RESOLVE_SELFTEST_NON_PRODUCTION === "1"');
    for (const fn of ["record_official_observation", "claim_official_fetch", "extend_official_fetch", "recheck_official_corroboration"]) expect(block, fn).toContain(`${fn}(`);
    const expectBlock = script.slice(script.indexOf("const OFFICIAL_SELFTEST_EXPECT"), script.indexOf("async function officialSelftest"));
    const keys = [...expectBlock.slice(expectBlock.indexOf("= {")).matchAll(/[{,]\s*([a-z_]+): /g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) expect(block, k).toMatch(new RegExp(`['"]${k}['"]`));
  });
  it("widens the source_kind CHECKs from the live definition instead of replacing them", () => {
    expect(body).toContain("pg_get_constraintdef");
    expect(body).toContain("'watches_source_kind_check'");
    expect(body).toContain("'evidence_source_kind_check'");
    expect(body).toContain("replace(v_def, 'ARRAY[', 'ARRAY[''official_release''::text, ')");
  });
});

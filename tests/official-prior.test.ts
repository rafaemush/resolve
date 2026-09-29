/**
 * prior_level of rate ladders from the rail's own stored first print (src/markets/official-legs.ts derivePriorLevel,
 * priorForGroup) and the testable parts of scripts/official-legs.ts (scripts/lib/official-legs.ts): the prior of every
 * group, the read of official_observations through an in-memory client (no database), the arguments of an ad-hoc
 * ladder, and the private/ output rule. SYNTHETIC first prints throughout.
 */
import { describe, expect, it, vi } from "vitest";
import { derivePriorLevel, priorForGroup, type FirstPrintLookup, type StoredFirstPrint } from "../src/markets/official-legs";
import { DEFAULT_OUT, UsageError, outPathRefusal, parseLegArgs, readFirstPrints, withPriors, type ObservationsClient } from "../scripts/lib/official-legs";
import { fakeDb } from "./lib/fake-db";

const AFTER_OCT = Date.parse("2026-11-01T00:00:00Z");
const BEFORE_OCT = Date.parse("2026-10-01T00:00:00Z");
const prints = (m: Record<string, StoredFirstPrint>): FirstPrintLookup => (s, p) => m[`${s}:${p}`];
const FED_OCT: StoredFirstPrint = { value: 4, value_text: "3-3/4 to 4", observed_at: "2026-10-28T18:00:04Z", doc_period: "2026-10-28" };

describe("derivePriorLevel", () => {
  it("normal case: the level the previous meeting's stored first print set (an FOMC range reads its upper bound)", () => {
    expect(derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({ "fomc_upper_bound:2026-10-28": FED_OCT }), AFTER_OCT))
      .toEqual({ ok: true, prior_period: "2026-10-28", prior_level: 4, value_text: "3-3/4 to 4", observed_at: "2026-10-28T18:00:04Z" });
    // numeric columns arrive as strings from PostgREST; the published text decides when it is a decimal
    expect(derivePriorLevel("ecb_dfr", "2026-12-17", prints({ "ecb_dfr:2026-10-29": { value: "2.25", value_text: "2.25", observed_at: "2026-10-29T13:15:02Z" } }), AFTER_OCT))
      .toMatchObject({ ok: true, prior_period: "2026-10-29", prior_level: 2.25 });
    expect(derivePriorLevel("bcb_selic_target", "2026-12-09", prints({ "bcb_selic_target:2026-11-04": { value: 13.5, value_text: "13.50", observed_at: "2026-11-04T21:40:00Z" } }), Date.parse("2026-12-01T00:00:00Z")))
      .toMatchObject({ ok: true, prior_level: 13.5 });
    expect(derivePriorLevel("bok_base_rate", "2026-11-26", prints({ "bok_base_rate:2026-10-22": { value: 2.75, value_text: "2.75", observed_at: "2026-10-22T01:05:00Z" } }), AFTER_OCT))
      .toMatchObject({ ok: true, prior_period: "2026-10-22", prior_level: 2.75 });
  });

  it("no previous meeting: the first meeting of the calendar, a meeting the calendar does not list", () => {
    const none = prints({});
    expect(derivePriorLevel("fomc_upper_bound", "2026-10-28", none, AFTER_OCT)).toMatchObject({ ok: false, prior_period: null, pending: false, reason: expect.stringMatching(/^previous meeting unknown: .*first FOMC statement/) });
    expect(derivePriorLevel("boe_bank_rate", "2027-09-16", none, AFTER_OCT)).toMatchObject({ ok: false, prior_period: null, reason: "previous meeting unknown: boe_bank_rate:2027-09-16 is not in the release calendar" });
  });

  it("missing print: the previous meeting is known but has no stored first print (pending while it is not yet released)", () => {
    expect(derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({}), AFTER_OCT)).toMatchObject({ ok: false, prior_period: "2026-10-28", pending: false, reason: "no stored first print of fomc_upper_bound:2026-10-28, the meeting before 2026-12-09" });
    expect(derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({}), BEFORE_OCT)).toMatchObject({ ok: false, prior_period: "2026-10-28", pending: true, reason: expect.stringContaining("not released yet: 2026-10-28T18:00:00Z") });
    // a print of another series or period is not the one asked for
    expect(derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({ "ecb_dfr:2026-10-28": FED_OCT, "fomc_upper_bound:2026-09-16": FED_OCT }), AFTER_OCT)).toMatchObject({ ok: false });
  });

  it("a stored row about another period, an unreadable level, or a series that decides no change: the reason", () => {
    expect(derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({ "fomc_upper_bound:2026-10-28": { ...FED_OCT, doc_period: "2026-09-16" } }), AFTER_OCT)).toMatchObject({ ok: false, reason: "the stored first print of fomc_upper_bound:2026-10-28 is about 2026-09-16" });
    expect(derivePriorLevel("ecb_dfr", "2026-12-17", prints({ "ecb_dfr:2026-10-29": { value: "x", value_text: "two and a quarter", observed_at: "2026-10-29T13:15:02Z" } }), AFTER_OCT)).toMatchObject({ ok: false, reason: expect.stringContaining("not a readable level") });
    expect(derivePriorLevel("us_cpi_u_nsa_yoy", "2026-10", prints({}), AFTER_OCT)).toMatchObject({ ok: false, reason: "us_cpi_u_nsa_yoy decides percent: it takes no prior_level" });
  });
});

describe("priorForGroup", () => {
  const dec = { series: "fomc_upper_bound" as const, period: "2026-12-09" };
  const derived = derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({ "fomc_upper_bound:2026-10-28": FED_OCT }), AFTER_OCT);

  it("disagreement: a hand-written prior that differs from the stored first print is refused with both values", () => {
    expect(() => priorForGroup({ ...dec, prior_level: 4.25 }, derived)).toThrow(/hand-written prior_level 4.25 disagrees with the stored first print of fomc_upper_bound:2026-10-28, 3-3\/4 to 4 \(level 4,/);
  });

  it("a hand-written prior equal to the stored first print stands (compared as a level: 4 = 4.00)", () => {
    expect(priorForGroup({ ...dec, prior_level: 4.0 }, derived)).toEqual({ prior_level: 4, note: expect.stringContaining("equals the stored first print of 2026-10-28") });
  });

  it("no hand-written prior: the derived one, or the group is skipped with the reason", () => {
    expect(priorForGroup(dec, derived)).toEqual({ prior_level: 4, note: "prior 4 from the stored first print of fomc_upper_bound:2026-10-28, 3-3/4 to 4 (observed 2026-10-28T18:00:04Z)" });
    expect(priorForGroup(dec, derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({}), AFTER_OCT))).toEqual({ skip: expect.stringMatching(/no prior_level \(no stored first print of fomc_upper_bound:2026-10-28.*not suggested rather than suggested with a guess/) });
    expect(priorForGroup({ series: "fomc_upper_bound", period: "2026-10-28" }, derivePriorLevel("fomc_upper_bound", "2026-10-28", prints({}), AFTER_OCT))).toMatchObject({ skip: expect.stringContaining("previous meeting unknown") });
  });

  it("a hand-written prior with no print to check: kept for a first calendar meeting, refused while the meeting before is not out (a forecast)", () => {
    expect(priorForGroup({ series: "fomc_upper_bound", period: "2026-10-28", prior_level: 4 }, derivePriorLevel("fomc_upper_bound", "2026-10-28", prints({}), AFTER_OCT)))
      .toEqual({ prior_level: 4, note: expect.stringContaining("not checked against a stored first print") });
    expect(priorForGroup({ ...dec, prior_level: 4 }, derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({}), BEFORE_OCT))).toEqual({ skip: expect.stringContaining("is a forecast") });
  });
});

describe("withPriors (scripts/official-legs.ts)", () => {
  const g = (series: string, period: string, prior_level?: number) => ({ series, period, release_at: "2026-10-28T18:00:00Z", title: "t", basis: "b", ...(prior_level !== undefined ? { prior_level } : {}) }) as Parameters<typeof withPriors>[0][number];

  it("the built-in October and November groups (first calendar meetings) keep their hand-written priors and never read the database", async () => {
    const read = vi.fn(async () => prints({}));
    const groups = [g("bok_base_rate", "2026-10-22", 3), g("fomc_upper_bound", "2026-10-28", 4), g("ecb_dfr", "2026-10-29", 2.5), g("bcb_selic_target", "2026-11-04", 13.75), g("boe_bank_rate", "2026-11-05", 3.75), g("us_cpi_u_nsa_yoy", "2026-09"), g("kr_gdp_advance_yoy", "2026-Q3")];
    const r = await withPriors(groups, read, AFTER_OCT);
    expect(read).not.toHaveBeenCalled();
    expect(r.skipped).toEqual([]);
    expect(r.groups.map((x) => x.prior_level)).toEqual([3, 4, 2.5, 13.75, 3.75, undefined, undefined]);
  });

  it("an ad-hoc December ladder: one read of the meeting before it, the derived prior on the group and in its basis", async () => {
    const read = vi.fn(async () => prints({ "fomc_upper_bound:2026-10-28": FED_OCT }));
    const r = await withPriors([g("fomc_upper_bound", "2026-12-09"), g("us_unemployment_rate", "2026-10")], read, AFTER_OCT);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith([{ series: "fomc_upper_bound", period: "2026-10-28" }]);
    expect(r.groups[0]).toMatchObject({ series: "fomc_upper_bound", prior_level: 4, basis: expect.stringMatching(/^b; prior 4 from the stored first print/) });
    expect(r.groups[1]).not.toHaveProperty("prior_level");
  });

  it("no print: the group is skipped with the reason, the others go on; a disagreeing hand-written prior stops the run", async () => {
    const r = await withPriors([g("ecb_dfr", "2026-12-17"), g("us_cpi_u_sa_mom", "2026-10")], async () => prints({}), AFTER_OCT);
    expect(r.groups.map((x) => x.series)).toEqual(["us_cpi_u_sa_mom"]);
    expect(r.skipped).toEqual([{ group: expect.objectContaining({ series: "ecb_dfr" }), reason: expect.stringContaining("no stored first print of ecb_dfr:2026-10-29") }]);
    await expect(withPriors([g("fomc_upper_bound", "2026-12-09", 3.75)], async () => prints({ "fomc_upper_bound:2026-10-28": FED_OCT }), AFTER_OCT)).rejects.toThrow(/3.75 disagrees .* 3-3\/4 to 4/);
  });
});

describe("readFirstPrints", () => {
  const row = (series: string, period: string, value: number | string, extra: Record<string, unknown> = {}) => ({ series, period, value, value_text: String(value), deciding_text: "d", source_url: "https://x", raw_sha256: "a".repeat(64), observed_at: "2026-10-28T18:00:04+00:00", corroboration: null, meta: { doc_period: period }, ...extra });

  it("one select of official_observations; only the asked pairs; doc_period from meta", async () => {
    const db = fakeDb({ official_observations: [row("fomc_upper_bound", "2026-10-28", 4), row("ecb_dfr", "2026-10-29", "2.25"), row("fomc_upper_bound", "2026-10-29", 9), row("boe_bank_rate", "2026-11-05", 3.5, { meta: null })] });
    const look = await readFirstPrints(db.client as unknown as ObservationsClient, [{ series: "fomc_upper_bound", period: "2026-10-28" }, { series: "ecb_dfr", period: "2026-10-29" }, { series: "boe_bank_rate", period: "2026-11-05" }]);
    expect(db.calls).toEqual([{ table: "official_observations", action: "select" }]);
    expect(look("fomc_upper_bound", "2026-10-28")).toEqual({ value: 4, value_text: "4", observed_at: "2026-10-28T18:00:04+00:00", doc_period: "2026-10-28" });
    expect(look("ecb_dfr", "2026-10-29")).toMatchObject({ value: "2.25" });
    expect(look("boe_bank_rate", "2026-11-05")).toMatchObject({ doc_period: null });
    expect(look("fomc_upper_bound", "2026-10-29")).toBeUndefined(); // in the in x in product, not asked for
    expect(look("ecb_dfr", "2026-12-17")).toBeUndefined();
  });

  it("no keys: no read; a read error or a malformed row throws, never reads as 'no print'", async () => {
    const db = fakeDb({});
    expect((await readFirstPrints(db.client as unknown as ObservationsClient, []))("ecb_dfr", "2026-10-29")).toBeUndefined();
    expect(db.calls).toHaveLength(0);
    const failing: ObservationsClient = { from: () => ({ select: () => { const q = { in: () => q, then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "permission denied for table official_observations" } }).then(ok) }; return q as never; } }) };
    await expect(readFirstPrints(failing, [{ series: "ecb_dfr", period: "2026-10-29" }])).rejects.toThrow("official_observations read: permission denied");
    const bad = fakeDb({ official_observations: [{ series: "ecb_dfr", period: "2026-10-29", value: 2.25 }] });
    await expect(readFirstPrints(bad.client as unknown as ObservationsClient, [{ series: "ecb_dfr", period: "2026-10-29" }])).rejects.toThrow();
  });
});

describe("parseLegArgs", () => {
  it("built-in groups: --only and --out, both spellings", () => {
    expect(parseLegArgs([])).toEqual({ out: DEFAULT_OUT, only: null, adhoc: null });
    expect(parseLegArgs(["--only", "us_cpi_u_sa_mom, us_core_cpi_sa_mom", "--out=private/x.json"])).toEqual({ out: "private/x.json", only: ["us_cpi_u_sa_mom", "us_core_cpi_sa_mom"], adhoc: null });
  });

  it("an ad-hoc ladder: one slug, a registry event, a title; the default output names the event", () => {
    expect(parseLegArgs(["--pm-slug", "october-unemployment-rate-2026", "--series", "us_unemployment_rate", "--period", "2026-10", "--title", "October Unemployment Rate"]))
      .toEqual({ out: "private/shadow-markets/official-release-us_unemployment_rate-2026-10.json", only: null, adhoc: { pmSlug: "october-unemployment-rate-2026", series: "us_unemployment_rate", period: "2026-10", title: "October Unemployment Rate" } });
    expect(parseLegArgs(["--lm-slug=fed-decision-in-december-1790000000000", "--series=fomc_upper_bound", "--period=2026-12-09", "--title=Fed Decision in December?", "--out", "private/f.json"]))
      .toEqual({ out: "private/f.json", only: null, adhoc: { slug: "fed-decision-in-december-1790000000000", series: "fomc_upper_bound", period: "2026-12-09", title: "Fed Decision in December?" } });
  });

  it("refuses anything else before a request is made", () => {
    const ok = ["--pm-slug", "x-1", "--series", "us_cpi_u_nsa_yoy", "--period", "2026-10", "--title", "t"];
    const cases: Array<[string[], RegExp]> = [
      [["--apply"], /unknown argument/], [["extra"], /unknown argument/], [["--out"], /needs a value/], [["--out", "--only"], /needs a value/], [["--title", " "], /needs a value/],
      [["--out", "private/a.json", "--out", "private/b.json"], /given twice/],
      [["--only", "us_cpi_u_nsa_yoy", ...ok], /cannot be combined/],
      [[...ok, "--lm-slug", "y"], /exactly one of --pm-slug or --lm-slug/], [ok.slice(2), /exactly one of --pm-slug or --lm-slug/],
      [ok.filter((_, i) => i < 6), /needs --title/], [["--pm-slug", "x", "--title", "t", "--period", "2026-10"], /needs --series/],
      [["--pm-slug", "Bad Slug", "--series", "us_cpi_u_nsa_yoy", "--period", "2026-10", "--title", "t"], /must be a platform slug/],
      [["--pm-slug", "x", "--series", "us_cpi", "--period", "2026-10", "--title", "t"], /not an official_release series/],
      [["--pm-slug", "x", "--series", "boj_policy_rate", "--period", "2026-10-30", "--title", "t"], /refused: official source is PDF-only/],
      [["--pm-slug", "x", "--series", "br_pres_r1_winner", "--period", "2026-10-04", "--title", "t"], /election series/],
      [["--pm-slug", "x", "--series", "fomc_upper_bound", "--period", "2026-12", "--title", "t"], /not a day period/],
      // the last BLS month posted has no fallback in the calendar, so it is not a registry event
      [["--pm-slug", "x", "--series", "us_cpi_u_nsa_yoy", "--period", "2026-11", "--title", "t"], /not in KNOWN_RELEASES/],
      [["--pm-slug", "x", "--series", "fomc_upper_bound", "--period", "2027-09-15", "--title", "t"], /not in KNOWN_RELEASES/],
      [["--pm-slug", "x", "--series", "us_cpi_u_nsa_yoy", "--period", "2026-10", "--title", "t".repeat(201)], /longer than 200/],
    ];
    for (const [argv, re] of cases) {
      expect(() => parseLegArgs(argv), argv.join(" ")).toThrow(UsageError);
      expect(() => parseLegArgs(argv), argv.join(" ")).toThrow(re);
    }
  });
});

describe("outPathRefusal", () => {
  it("writes only a .json file inside the repository's private/ directory", () => {
    expect(outPathRefusal("/repo", "/repo/private/shadow-markets/x.json")).toBeNull();
    expect(outPathRefusal("/repo/", "/repo/private/x.json")).toBeNull();
    expect(outPathRefusal("/repo", "/repo/docs/x.json")).toMatch(/private/);
    expect(outPathRefusal("/repo", "/repo/private-leak/x.json")).toMatch(/private/);
    expect(outPathRefusal("/repo", "/repo/private")).toMatch(/private/);
    expect(outPathRefusal("/repo", "/tmp/x.json")).toMatch(/private/);
    expect(outPathRefusal("/repo", "/repo/private/x.md")).toMatch(/\.json/);
  });
});

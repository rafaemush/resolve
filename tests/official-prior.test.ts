/**
 * prior_level of rate ladders from the rail's own stored first print (src/markets/official-legs.ts derivePriorLevel,
 * storedPrintProblem, priorForGroup), the period of a ladder named on the command line (titlePeriodProblem,
 * platformPeriodProblem), and the testable parts of scripts/official-legs.ts (scripts/lib/official-legs.ts): the prior
 * of every group, the read of official_observations through an in-memory client (no database), the arguments of an
 * ad-hoc ladder, the private/ output rule, and the run itself over in-memory platform reads (suggestLegs).
 * SYNTHETIC first prints and platform objects throughout.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildLegRegistration, derivePriorLevel, platformPeriodProblem, priorForGroup, releasedPrevious, storedPrintProblem, titlePeriodProblem, type FirstPrintLookup, type StoredFirstPrint,
} from "../src/markets/official-legs";
import {
  DEFAULT_OUT, GROUPS, UsageError, outPathRefusal, parseLegArgs, readFirstPrints, selectGroups, suggestLegs, withPriors, type Group, type ObservationsClient, type SuggestIo,
} from "../scripts/lib/official-legs";
import { decideOfficial, knownRelease, officialEvidence, type OfficialCorroboration } from "../src/resolve/official";
import { docFromRow } from "../src/ingest/official-watch";
import { fakeDb } from "./lib/fake-db";

const AFTER_OCT = Date.parse("2026-11-01T00:00:00Z");
const BEFORE_OCT = Date.parse("2026-10-01T00:00:00Z");
const prints = (m: Record<string, StoredFirstPrint>): FirstPrintLookup => (s, p) => m[`${s}:${p}`];
const corr = (status: OfficialCorroboration["status"], value_text: string | null = null): OfficialCorroboration => ({ status, source_url: "https://fred.stlouisfed.org/series/DFEDTARU", value: value_text === null ? null : Number(value_text), value_text, detail: "SYNTHETIC", checked_at: "2026-10-28T18:00:09Z" });
const FED_OCT: StoredFirstPrint = {
  value: 4, value_text: "3-3/4 to 4", observed_at: "2026-10-28T18:00:04Z", doc_period: "2026-10-28", corroboration: corr("agree", "4.00"),
  deciding_text: "October 28, 2026 | the Committee decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent (SYNTHETIC)",
};
const CPI_NOV = "SYNTHETIC. This market will resolve according to the annual inflation rate for November 2026 as published by the BLS on December 10, 2026.";
const CPI_OCT = "SYNTHETIC. This market will resolve according to the annual inflation rate for October 2026 as published by the BLS on November 10, 2026.";
const ECB_OCT: StoredFirstPrint = { value: "2.25", value_text: "2.25", observed_at: "2026-10-29T13:15:02Z", doc_period: "2026-10-29", corroboration: null, deciding_text: "29 October 2026 | deposit facility 2.25% (SYNTHETIC)" };

describe("derivePriorLevel", () => {
  it("normal case: the level the previous meeting's stored first print set (an FOMC range reads its upper bound)", () => {
    expect(derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({ "fomc_upper_bound:2026-10-28": FED_OCT }), AFTER_OCT))
      .toEqual({ ok: true, prior_period: "2026-10-28", prior_level: 4, value_text: "3-3/4 to 4", observed_at: "2026-10-28T18:00:04Z" });
    // numeric columns arrive as strings from PostgREST; the published text decides when it is a decimal
    expect(derivePriorLevel("ecb_dfr", "2026-12-17", prints({ "ecb_dfr:2026-10-29": ECB_OCT }), AFTER_OCT))
      .toMatchObject({ ok: true, prior_period: "2026-10-29", prior_level: 2.25 });
    expect(derivePriorLevel("bcb_selic_target", "2026-12-09", prints({ "bcb_selic_target:2026-11-04": { value: 13.5, value_text: "13.50", observed_at: "2026-11-04T21:40:00Z", corroboration: corr("single_source"), deciding_text: "2026-11-04 | Selic 13,50% (SYNTHETIC)" } }), Date.parse("2026-12-01T00:00:00Z")))
      .toMatchObject({ ok: true, prior_level: 13.5 });
    expect(derivePriorLevel("bok_base_rate", "2026-11-26", prints({ "bok_base_rate:2026-10-22": { value: 2.75, value_text: "2.75", observed_at: "2026-10-22T01:05:00Z", corroboration: corr("unavailable"), deciding_text: "October 22, 2026 | Base Rate 2.75% (SYNTHETIC)" } }), AFTER_OCT))
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
    expect(derivePriorLevel("ecb_dfr", "2026-12-17", prints({ "ecb_dfr:2026-10-29": { ...ECB_OCT, value: "x", value_text: "two and a quarter" } }), AFTER_OCT)).toMatchObject({ ok: false, reason: expect.stringContaining("not a readable level") });
    expect(derivePriorLevel("us_cpi_u_nsa_yoy", "2026-10", prints({}), AFTER_OCT)).toMatchObject({ ok: false, reason: "us_cpi_u_nsa_yoy decides percent: it takes no prior_level" });
  });

  it("a stored print the rail would not decide from is no prior: disputed, differing from its second source, observed early or after the fallback, a text naming another meeting, off the basis-point grid", () => {
    const dec = (row: StoredFirstPrint) => derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({ "fomc_upper_bound:2026-10-28": row }), AFTER_OCT);
    // a stored "disagree" holds every October leg at sources_disagree until an operator re-check
    expect(dec({ ...FED_OCT, corroboration: { ...corr("disagree", "3.75"), detail: "FRED DFEDTARU 3.75" } }))
      .toEqual({ ok: false, prior_period: "2026-10-28", pending: false, reason: "the stored first print of fomc_upper_bound:2026-10-28 (3-3/4 to 4) is disputed: the second source says 3.75 (FRED DFEDTARU 3.75); the rail holds that meeting's legs at sources_disagree" });
    expect(dec({ ...FED_OCT, corroboration: corr("disagree") })).toMatchObject({ ok: false, reason: expect.stringContaining("is disputed: the second source says otherwise") });
    expect(dec({ ...FED_OCT, corroboration: corr("agree", "3.75") })).toMatchObject({ ok: false, reason: expect.stringContaining("differs from its second source 3.75") });
    expect(dec({ ...FED_OCT, observed_at: "2026-10-28T17:00:00Z" })).toMatchObject({ ok: false, reason: "the stored first print of fomc_upper_bound:2026-10-28 was observed 2026-10-28T17:00:00Z, before the scheduled release 2026-10-28T18:00:00Z" });
    expect(dec({ ...FED_OCT, observed_at: "2026-12-09T19:00:00Z" })).toMatchObject({ ok: false, reason: expect.stringContaining("at or after the market's fallback 2026-12-09T19:00:00Z") });
    expect(dec({ ...FED_OCT, deciding_text: "September 16, 2026 | 3-3/4 to 4 percent" })).toMatchObject({ ok: false, reason: expect.stringContaining("its deciding text does not name October 28, 2026") });
    expect(dec({ ...FED_OCT, value: 4.125, value_text: "4.125", corroboration: null })).toMatchObject({ ok: false, reason: expect.stringContaining("(4.125) is not a level in whole basis points") });
    // corroboration that has no number yet, or none recorded, is not a dispute (the rail resolves with a caveat)
    for (const c of [null, corr("unavailable"), corr("single_source"), corr("inconclusive")]) expect(dec({ ...FED_OCT, corroboration: c }), String(c?.status)).toMatchObject({ ok: true, prior_level: 4 });
    // a meeting whose release time the calendar does not state cannot be checked as observed after it
    expect(storedPrintProblem("bok_base_rate", "2026-11-26", null, { ...FED_OCT, doc_period: null, deciding_text: "November 26, 2026 | 2.75%" })).toMatch(/states no release time/);
  });

  it("storedPrintProblem refuses exactly the stored prints decideOfficial would not resolve the meeting's own legs from", () => {
    const leg = buildLegRegistration({ platform: "limitless", external_id: "t-fed-oct-hold", group: { series: "fomc_upper_bound", period: "2026-10-28", release_at: "2026-10-28T18:00:00Z", prior_level: 4, title: "Fed Decision in October?" }, label: "No change", open_at: "2026-09-15T00:00:00Z", deadline_utc: "2026-10-29T00:00:00Z", criteria: "SYNTHETIC" });
    if (!leg.ok) throw new Error(leg.reason);
    const variants: Array<[string, StoredFirstPrint]> = [
      ["clean", FED_OCT], ["no corroboration", { ...FED_OCT, corroboration: null }], ["single source", { ...FED_OCT, corroboration: corr("single_source") }], ["unavailable", { ...FED_OCT, corroboration: corr("unavailable") }],
      ["disagree", { ...FED_OCT, corroboration: corr("disagree", "3.75") }], ["disagree without a number", { ...FED_OCT, corroboration: corr("disagree") }], ["agree but differs", { ...FED_OCT, corroboration: corr("agree", "3.75") }],
      ["observed early", { ...FED_OCT, observed_at: "2026-10-28T17:59:59Z" }], ["after the fallback", { ...FED_OCT, observed_at: "2026-12-09T19:00:00Z" }], ["just before the fallback", { ...FED_OCT, observed_at: "2026-12-09T18:59:59Z" }],
      ["about another period", { ...FED_OCT, doc_period: "2026-09-16" }], ["text names another meeting", { ...FED_OCT, deciding_text: "September 16, 2026 | 3-3/4 to 4" }], ["unreadable", { ...FED_OCT, value: "x", value_text: "n/a" }],
    ];
    const resolved: string[] = [];
    for (const [name, row] of variants) {
      const doc = docFromRow({ series: "fomc_upper_bound", period: "2026-10-28", value: row.value, value_text: row.value_text, deciding_text: row.deciding_text, source_url: "https://www.federalreserve.gov/x", raw_sha256: "a".repeat(64), observed_at: row.observed_at, corroboration: row.corroboration, meta: row.doc_period ? { doc_period: row.doc_period } : {} });
      const d = decideOfficial(leg.market, officialEvidence(doc, "2026-12-10T00:00:00.000Z").evidence);
      expect(storedPrintProblem("fomc_upper_bound", "2026-10-28", knownRelease("fomc_upper_bound", "2026-10-28")!.release_at, row) === null, `${name}: ${d.status} ${d.detail}`).toBe(d.status === "RESOLVED");
      if (d.status === "RESOLVED") resolved.push(name);
    }
    expect(resolved).toEqual(["clean", "no corroboration", "single source", "unavailable", "just before the fallback"]);
  });
});

describe("releasedPrevious", () => {
  it("the meeting before, once its scheduled release has passed; null before it, and for the first calendar meeting", () => {
    expect(releasedPrevious("fomc_upper_bound", "2026-12-09", Date.parse("2026-10-28T17:59:59Z"))).toBeNull();
    expect(releasedPrevious("fomc_upper_bound", "2026-12-09", Date.parse("2026-10-28T18:00:00Z"))).toBe("2026-10-28");
    expect(releasedPrevious("bok_base_rate", "2026-11-26", AFTER_OCT)).toBe("2026-10-22"); // the registry's 10:00 KST
    expect(releasedPrevious("fomc_upper_bound", "2026-10-28", AFTER_OCT)).toBeNull();
    expect(releasedPrevious("ecb_dfr", "2027-09-09", AFTER_OCT)).toBeNull();
  });
});

describe("priorForGroup", () => {
  const dec = { series: "fomc_upper_bound" as const, period: "2026-12-09" };
  const derived = derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({ "fomc_upper_bound:2026-10-28": FED_OCT }), AFTER_OCT);

  it("disagreement: a hand-written prior that differs from the stored first print is refused with both values", () => {
    expect(() => priorForGroup({ ...dec, prior_level: 4.25 }, derived)).toThrow(/hand-written prior_level 4.25 disagrees with the stored first print of fomc_upper_bound:2026-10-28, 3-3\/4 to 4 \(level 4,/);
  });

  it("a hand-written prior equal to the stored first print stands; compared exactly, never at a rounded precision", () => {
    expect(priorForGroup({ ...dec, prior_level: 4.0 }, derived)).toEqual({ prior_level: 4, note: expect.stringContaining("equals the stored first print of 2026-10-28") });
    // 3.999 rounds to 400 bps like 4, but decides a hold at 3-3/4 to 4 as +0.10 bp (a "25 bps increase" under the Fed rounding)
    expect(() => priorForGroup({ ...dec, prior_level: 3.999 }, derived)).toThrow("fomc_upper_bound:2026-12-09: the hand-written prior_level 3.999 is not a level in whole basis points");
    expect(() => priorForGroup({ ...dec, prior_level: 4.001 }, derived)).toThrow(/not a level in whole basis points/);
    expect(() => priorForGroup({ ...dec, prior_level: 4.01 }, derived)).toThrow(/4.01 disagrees with the stored first print/);
    expect(() => priorForGroup({ series: "fomc_upper_bound", period: "2026-10-28", prior_level: Number.NaN }, derivePriorLevel("fomc_upper_bound", "2026-10-28", prints({}), AFTER_OCT))).toThrow(/not a level in whole basis points/);
  });

  it("no hand-written prior: the derived one, or the group is skipped with the reason", () => {
    expect(priorForGroup(dec, derived)).toEqual({ prior_level: 4, note: "prior 4 from the stored first print of fomc_upper_bound:2026-10-28, 3-3/4 to 4 (observed 2026-10-28T18:00:04Z)" });
    expect(priorForGroup(dec, derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({}), AFTER_OCT))).toEqual({ skip: expect.stringMatching(/no prior_level \(no stored first print of fomc_upper_bound:2026-10-28.*not suggested rather than suggested with a guess/) });
    expect(priorForGroup({ series: "fomc_upper_bound", period: "2026-10-28" }, derivePriorLevel("fomc_upper_bound", "2026-10-28", prints({}), AFTER_OCT))).toMatchObject({ skip: expect.stringContaining("previous meeting unknown") });
  });

  it("a hand-written prior with no print to check: kept only for a first calendar meeting; skipped while the meeting before is not out (a forecast) and once it is out without a trusted print (a guess)", () => {
    expect(priorForGroup({ series: "fomc_upper_bound", period: "2026-10-28", prior_level: 4 }, derivePriorLevel("fomc_upper_bound", "2026-10-28", prints({}), AFTER_OCT)))
      .toEqual({ prior_level: 4, note: expect.stringContaining("not checked against a stored first print") });
    expect(priorForGroup({ ...dec, prior_level: 4 }, derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({}), BEFORE_OCT))).toEqual({ skip: expect.stringContaining("is a forecast") });
    // the meeting before is out: no stored print (the rail missed it), a print about another period, a disputed print
    expect(priorForGroup({ ...dec, prior_level: 4.25 }, derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({}), AFTER_OCT)))
      .toEqual({ skip: "fomc_upper_bound:2026-12-09: the hand-written prior_level 4.25 cannot be checked (no stored first print of fomc_upper_bound:2026-10-28, the meeting before 2026-12-09); the group is not suggested rather than suggested with a guess" });
    expect(priorForGroup({ ...dec, prior_level: 4.25 }, derivePriorLevel("fomc_upper_bound", "2026-12-09", prints({ "fomc_upper_bound:2026-10-28": { ...FED_OCT, doc_period: "2026-09-16" } }), AFTER_OCT)))
      .toEqual({ skip: expect.stringContaining("cannot be checked (the stored first print of fomc_upper_bound:2026-10-28 is about 2026-09-16)") });
    expect(priorForGroup({ series: "ecb_dfr", period: "2026-12-17", prior_level: 2.5 }, derivePriorLevel("ecb_dfr", "2026-12-17", prints({ "ecb_dfr:2026-10-29": { ...ECB_OCT, corroboration: corr("disagree", "2.00") } }), Date.parse("2026-11-20T00:00:00Z"))))
      .toEqual({ skip: expect.stringContaining("cannot be checked (the stored first print of ecb_dfr:2026-10-29 (2.25) is disputed") });
  });
});

describe("withPriors (scripts/official-legs.ts)", () => {
  const g = (series: string, period: string, prior_level?: number) => ({ series, period, release_at: "2026-10-28T18:00:00Z", title: "t", basis: "b", ...(prior_level !== undefined ? { prior_level } : {}) }) as Parameters<typeof withPriors>[0][number];

  it("the built-in groups (first calendar meetings) keep their hand-written priors and never read the database", async () => {
    const read = vi.fn(async () => prints({}));
    const r = await withPriors(GROUPS, read, AFTER_OCT);
    expect(read).not.toHaveBeenCalled();
    expect(r.skipped).toEqual([]);
    expect(r.groups.map((x) => `${x.series}:${x.period}=${x.prior_level}`).filter((x) => !x.endsWith("undefined")))
      .toEqual(["bok_base_rate:2026-10-22=3", "fomc_upper_bound:2026-10-28=4", "ecb_dfr:2026-10-29=2.5", "bcb_selic_target:2026-11-04=13.75", "boe_bank_rate:2026-11-05=3.75"]);
    expect(r.groups).toHaveLength(GROUPS.length);
  });

  it("the meeting before is not released yet: no database read at all (no print can exist), the group skipped as pending", async () => {
    const read = vi.fn(async () => prints({ "fomc_upper_bound:2026-10-28": FED_OCT }));
    const r = await withPriors([g("fomc_upper_bound", "2026-12-09"), g("ecb_dfr", "2026-12-17", 2.25)], read, BEFORE_OCT);
    expect(read).not.toHaveBeenCalled();
    expect(r.groups).toEqual([]);
    expect(r.skipped.map((x) => x.reason)).toEqual([
      expect.stringContaining("no prior_level (no stored first print of fomc_upper_bound:2026-10-28, the meeting before 2026-12-09 (not released yet: 2026-10-28T18:00:00Z))"),
      expect.stringContaining("the hand-written prior_level 2.25 is a forecast"),
    ]);
    // once one previous meeting is out, only that one is read
    await withPriors([g("fomc_upper_bound", "2026-12-09"), g("ecb_dfr", "2026-12-17")], read, Date.parse("2026-10-28T20:00:00Z"));
    expect(read).toHaveBeenCalledExactlyOnceWith([{ series: "fomc_upper_bound", period: "2026-10-28" }]);
  });

  it("a disputed or early stored print read from official_observations is no prior: the group is skipped with the reason", async () => {
    const stored = (extra: Record<string, unknown>) => fakeDb({ official_observations: [{ series: "fomc_upper_bound", period: "2026-10-28", value: 4, value_text: "3-3/4 to 4", deciding_text: FED_OCT.deciding_text, source_url: "https://www.federalreserve.gov/x", raw_sha256: "a".repeat(64), observed_at: "2026-10-28T18:00:04+00:00", corroboration: null, meta: { doc_period: "2026-10-28" }, ...extra }] });
    for (const [extra, reason] of [
      [{ corroboration: { ...corr("disagree", "3.75"), detail: "FRED 3.75" } }, "is disputed: the second source says 3.75"],
      [{ observed_at: "2026-10-28T17:00:00+00:00" }, "before the scheduled release 2026-10-28T18:00:00Z"],
    ] as const) {
      const db = stored(extra);
      const r = await withPriors([g("fomc_upper_bound", "2026-12-09")], (keys) => readFirstPrints(db.client as unknown as ObservationsClient, keys), AFTER_OCT);
      expect(r.groups, reason).toEqual([]);
      expect(r.skipped, reason).toEqual([{ group: expect.objectContaining({ series: "fomc_upper_bound" }), reason: expect.stringContaining(reason) }]);
    }
    const clean = stored({});
    expect((await withPriors([g("fomc_upper_bound", "2026-12-09")], (keys) => readFirstPrints(clean.client as unknown as ObservationsClient, keys), AFTER_OCT)).groups).toEqual([expect.objectContaining({ prior_level: 4 })]);
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
    const db = fakeDb({ official_observations: [row("fomc_upper_bound", "2026-10-28", 4), row("ecb_dfr", "2026-10-29", "2.25"), row("fomc_upper_bound", "2026-10-29", 9, { corroboration: { status: "contested" } }), row("boe_bank_rate", "2026-11-05", 3.5, { meta: null })] });
    const look = await readFirstPrints(db.client as unknown as ObservationsClient, [{ series: "fomc_upper_bound", period: "2026-10-28" }, { series: "ecb_dfr", period: "2026-10-29" }, { series: "boe_bank_rate", period: "2026-11-05" }]);
    expect(db.calls).toEqual([{ table: "official_observations", action: "select" }]);
    expect(look("fomc_upper_bound", "2026-10-28")).toEqual({ value: 4, value_text: "4", deciding_text: "d", observed_at: "2026-10-28T18:00:04+00:00", corroboration: null, doc_period: "2026-10-28" });
    expect(look("ecb_dfr", "2026-10-29")).toMatchObject({ value: "2.25" });
    expect(look("boe_bank_rate", "2026-11-05")).toMatchObject({ doc_period: null });
    expect(look("fomc_upper_bound", "2026-10-29")).toBeUndefined(); // in the in x in product, not asked for (and never parsed)
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

  it("the corroboration comes with the print, parsed strictly: one it cannot read throws, never reads as 'none recorded'", async () => {
    const c = corr("disagree", "3.75");
    const db = fakeDb({ official_observations: [row("fomc_upper_bound", "2026-10-28", 4, { corroboration: c })] });
    expect((await readFirstPrints(db.client as unknown as ObservationsClient, [{ series: "fomc_upper_bound", period: "2026-10-28" }]))("fomc_upper_bound", "2026-10-28")).toMatchObject({ corroboration: c });
    const odd = fakeDb({ official_observations: [row("fomc_upper_bound", "2026-10-28", 4, { corroboration: { status: "contested" } })] });
    await expect(readFirstPrints(odd.client as unknown as ObservationsClient, [{ series: "fomc_upper_bound", period: "2026-10-28" }])).rejects.toThrow();
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
      // the one typed period must be the ladder's own: the November-data ladder under the October period, a title without its month
      [["--pm-slug", "november-inflation-us-annual", "--series", "us_cpi_u_nsa_yoy", "--period", "2026-10", "--title", "November Inflation US - Annual"], /--title: the title "November Inflation US - Annual" names November, not only October/],
      [["--pm-slug", "x", "--series", "fomc_upper_bound", "--period", "2026-12-09", "--title", "Fed Decision?"], /names no month, not only December/],
      [["--pm-slug", "x", "--series", "us_cpi_u_nsa_yoy", "--period", "2026-10", "--title", "October or November Inflation"], /names October, November, not only October/],
    ];
    for (const [argv, re] of cases) {
      expect(() => parseLegArgs(argv), argv.join(" ")).toThrow(UsageError);
      expect(() => parseLegArgs(argv), argv.join(" ")).toThrow(re);
    }
  });
});

describe("selectGroups", () => {
  it("the ad-hoc group from the registry (release_at, basis) and marked ad-hoc; else the built-in groups, all or --only", () => {
    const [g] = selectGroups(parseLegArgs(["--pm-slug", "fed-decision-in-december", "--series", "fomc_upper_bound", "--period", "2026-12-09", "--title", "Fed Decision in December?"]));
    expect(g).toEqual({ pmSlug: "fed-decision-in-december", series: "fomc_upper_bound", period: "2026-12-09", release_at: "2026-12-09T19:00:00Z", title: "Fed Decision in December?", basis: knownRelease("fomc_upper_bound", "2026-12-09")!.basis, adhoc: true });
    expect(selectGroups({ only: null, adhoc: null })).toEqual(GROUPS);
    expect(selectGroups({ only: ["us_cpi_u_sa_mom", "ecb_dfr"], adhoc: null }).map((x) => `${x.series}:${x.period}`)).toEqual(["ecb_dfr:2026-10-29", "us_cpi_u_sa_mom:2026-09"]);
    expect(GROUPS.some((x) => x.adhoc)).toBe(false);
    expect(() => selectGroups({ only: ["fomc_upper_bound", "bok_base_rate", "boj_policy_rate"], adhoc: null })).toThrow(new UsageError("--only boj_policy_rate: no ladder group for that series"));
  });
});

describe("the period of a ladder named on the command line", () => {

  it("titlePeriodProblem: the title names the period's month (or quarter) and no other", () => {
    expect(titlePeriodProblem("us_cpi_u_nsa_yoy", "2026-10", "October Inflation US - Annual")).toBeNull();
    expect(titlePeriodProblem("fomc_upper_bound", "2026-12-09", "Fed Decision in December?")).toBeNull();
    expect(titlePeriodProblem("us_nonfarm_payrolls_change", "2026-10", "How many jobs added in OCTOBER?")).toBeNull();
    expect(titlePeriodProblem("kr_gdp_advance_yoy", "2026-Q4", "South Korea GDP growth (YoY) in Q4 2026?")).toBeNull();
    expect(titlePeriodProblem("kr_gdp_advance_yoy", "2026-Q4", "South Korea GDP, fourth quarter")).toBeNull();
    expect(titlePeriodProblem("us_cpi_u_nsa_yoy", "2026-10", "November Inflation US - Annual")).toBe('the title "November Inflation US - Annual" names November, not only October (us_cpi_u_nsa_yoy:2026-10)');
    expect(titlePeriodProblem("kr_gdp_advance_yoy", "2026-Q4", "South Korea GDP growth (YoY) in Q3 2026?")).toMatch(/names Q3, not only Q4/);
    expect(titlePeriodProblem("kr_gdp_advance_yoy", "2026-Q4", "South Korea GDP growth")).toMatch(/names no quarter/);
    expect(titlePeriodProblem("us_cpi_u_nsa_yoy", "2026-13", "October")).toMatch(/names no month or quarter/);
  });

  it("platformPeriodProblem: the platform title, the leg's own text and the year all agree with the period (the finding: the November ladder typed as 2026-10)", () => {
    expect(platformPeriodProblem("us_cpi_u_nsa_yoy", "2026-10", "October Inflation US - Annual", CPI_OCT)).toBeNull();
    expect(platformPeriodProblem("us_cpi_u_nsa_yoy", "2026-10", "November Inflation US - Annual", CPI_NOV)).toMatch(/^platform the title "November Inflation US - Annual" names November, not only October/);
    // a title the operator re-typed to match does not help when the platform's text is about another month
    expect(platformPeriodProblem("us_cpi_u_nsa_yoy", "2026-10", "October Inflation US - Annual", CPI_NOV)).toBe("the platform text does not name October (us_cpi_u_nsa_yoy:2026-10)");
    expect(platformPeriodProblem("us_cpi_u_nsa_yoy", "2026-10", "October Inflation US - Annual", "<p>The annual inflation rate for October as published by the BLS.</p>")).toBe("neither the platform title nor its text names 2026 (us_cpi_u_nsa_yoy:2026-10)");
    expect(platformPeriodProblem("kr_gdp_advance_yoy", "2026-Q4", "South Korea GDP growth (YoY) in Q4 2026?", "Resolves to the advance estimate for the fourth quarter of 2026.")).toBeNull();
    expect(platformPeriodProblem("kr_gdp_advance_yoy", "2026-Q4", "South Korea GDP growth (YoY) in Q4 2026?", "Resolves to the advance estimate for the third quarter.")).toMatch(/text does not name Q4/);
  });
});

describe("suggestLegs (the run of scripts/official-legs.ts over in-memory platform reads)", () => {
  const FED_DEC_TEXT = "SYNTHETIC. This market resolves to the change in the upper bound of the target federal funds range announced after the FOMC meeting of December 8-9, 2026, compared with the level before it.";
  const gamma = (title: string, description: string, labels: string[]) => [{
    id: "ev-1", slug: "ev", title, description, startDate: "2026-10-02T00:00:00Z", endDate: "2026-12-10T00:00:00Z",
    markets: labels.map((l, i) => ({ id: `pm-${i}`, groupItemTitle: l, question: `${title} ${l}`, startDate: "2026-10-02T00:00:00Z", endDate: "2026-12-10T00:00:00Z", description, conditionId: `0x${i}`, slug: `leg-${i}`, closed: false })),
  }];
  const io = (pages: Record<string, unknown>, lookup: FirstPrintLookup = prints({}), nowMs = AFTER_OCT) => {
    const getJson = vi.fn(async (url: string) => pages[url] ?? null);
    const readStored = vi.fn(async () => lookup);
    return { getJson, readStored, nowMs } satisfies SuggestIo;
  };
  const pm = (slug: string) => `https://gamma-api.polymarket.com/events?slug=${slug}`;
  const adhoc = (argv: string[]) => selectGroups(parseLegArgs(argv));
  const FED_DEC = ["--pm-slug", "fed-decision-in-december", "--series", "fomc_upper_bound", "--period", "2026-12-09", "--title", "Fed Decision in December?"];

  it("an ad-hoc December Fed ladder: the prior from the stored October print on every leg, one database read, then the platform", async () => {
    const x = io({ [pm("fed-decision-in-december")]: gamma("Fed Decision in December?", FED_DEC_TEXT, ["No change", "25 bps decrease", "25 bps increase"]) }, prints({ "fomc_upper_bound:2026-10-28": FED_OCT }));
    const r = await suggestLegs(adhoc(FED_DEC), x);
    expect(x.readStored).toHaveBeenCalledExactlyOnceWith([{ series: "fomc_upper_bound", period: "2026-10-28" }]);
    expect(x.readStored.mock.invocationCallOrder[0]).toBeLessThan(x.getJson.mock.invocationCallOrder[0]!);
    expect(r.skipped).toEqual([]);
    expect(r.skipped_groups).toEqual([]);
    expect(r.entries).toHaveLength(3);
    for (const e of r.entries) {
      expect(e.market.resolver).toMatchObject({ kind: "official_release", series: "fomc_upper_bound", period: "2026-12-09", release_at: "2026-12-09T19:00:00Z", prior_level: 4 });
      expect(e.meta.resolver_basis).toMatch(/; prior 4 from the stored first print of fomc_upper_bound:2026-10-28, 3-3\/4 to 4/);
      expect(e.approved).toBe(false);
    }
  });

  it("no trusted print of the meeting before: the group is skipped with the reason and its platform is never asked", async () => {
    for (const lookup of [prints({}), prints({ "fomc_upper_bound:2026-10-28": { ...FED_OCT, corroboration: corr("disagree", "3.75") } })]) {
      const x = io({ [pm("fed-decision-in-december")]: gamma("Fed Decision in December?", FED_DEC_TEXT, ["No change"]) }, lookup);
      const r = await suggestLegs(adhoc(FED_DEC), x);
      expect(x.getJson).not.toHaveBeenCalled();
      expect(r.entries).toEqual([]);
      expect(r.skipped_groups).toEqual([{ group: "fed-decision-in-december", series: "fomc_upper_bound", period: "2026-12-09", reason: expect.stringMatching(/no prior_level \((no stored first print|the stored first print of fomc_upper_bound:2026-10-28 \(3-3\/4 to 4\) is disputed)/) }]);
      expect(r.notes).toEqual([expect.stringMatching(/^fed-decision-in-december: skipped, /)]);
    }
  });

  it("a hand-written prior that disagrees with the stored print stops the run before any platform request", async () => {
    const g: Group = { pmSlug: "fed-decision-in-december", series: "fomc_upper_bound", period: "2026-12-09", release_at: "2026-12-09T19:00:00Z", prior_level: 3.75, title: "Fed Decision in December?", basis: "b" };
    const x = io({}, prints({ "fomc_upper_bound:2026-10-28": FED_OCT }));
    await expect(suggestLegs([g], x)).rejects.toThrow(/hand-written prior_level 3.75 disagrees with the stored first print of fomc_upper_bound:2026-10-28, 3-3\/4 to 4/);
    expect(x.getJson).not.toHaveBeenCalled();
  });

  it("an ad-hoc ladder whose platform title or text is about another period: every leg skipped with the reason, none suggested", async () => {
    const argv = ["--pm-slug", "october-inflation-us-annual", "--series", "us_cpi_u_nsa_yoy", "--period", "2026-10", "--title", "October Inflation US - Annual"];
    const labels = ["≤2.9%", "3.0%", "≥3.1%"];
    // the slug points at the November-data ladder
    const wrong = io({ [pm("october-inflation-us-annual")]: gamma("November Inflation US - Annual", CPI_NOV, labels) });
    const r = await suggestLegs(adhoc(argv), wrong);
    expect(wrong.readStored).not.toHaveBeenCalled();
    expect(r.entries).toEqual([]);
    expect(r.skipped).toHaveLength(3);
    for (const s of r.skipped) expect(s.reason).toMatch(/^not about 2026-10: platform the title "November Inflation US - Annual" names November, not only October/);
    const ok = await suggestLegs(adhoc(argv), io({ [pm("october-inflation-us-annual")]: gamma("October Inflation US - Annual", CPI_OCT, labels) }));
    expect(ok.skipped).toEqual([]);
    expect(ok.entries.map((e) => e.market.resolver)).toEqual(labels.map(() => expect.objectContaining({ series: "us_cpi_u_nsa_yoy", period: "2026-10", release_at: "2026-11-10T13:30:00Z" })));
    // a built-in group is not held to the check (its period was checked against the platform when it was written)
    const builtIn = GROUPS.find((x) => x.pmSlug === "september-inflation-us-monthly")!;
    const b = await suggestLegs([builtIn], io({ [pm("september-inflation-us-monthly")]: gamma("SYNTHETIC ladder", "SYNTHETIC text", ["0.2%"]) }));
    expect(b.entries).toHaveLength(1);
  });

  it("a Limitless ad-hoc group: its legs (Yes/No labels), its Polymarket mirror, the same period check on both platforms' titles", async () => {
    const lmGroup = (title: string) => ({
      title, description: FED_DEC_TEXT, externalSlug: "fed-decision-in-december",
      markets: [{ slug: "fed-dec-hold", title: "No change", description: FED_DEC_TEXT, createdAt: "2026-10-02T00:00:00Z", expirationTimestamp: Date.parse("2026-12-10T00:00:00Z"), outcomeTokens: ["Yes", "No"], id: 1, status: "FUNDED" }],
    });
    const argv = ["--lm-slug", "fed-decision-in-december-1790000000000", "--series", "fomc_upper_bound", "--period", "2026-12-09", "--title", "Fed Decision in December?"];
    const lm = "https://api.limitless.exchange/markets/fed-decision-in-december-1790000000000";
    const x = io({ [lm]: lmGroup("Fed Decision in December?"), [pm("fed-decision-in-december")]: gamma("Fed Decision in December?", FED_DEC_TEXT, ["No change"]) }, prints({ "fomc_upper_bound:2026-10-28": FED_OCT }));
    const r = await suggestLegs(adhoc(argv), x);
    expect(r.entries.map((e) => `${e.market.platform}:${e.market.external_id}:${(e.market.resolver as { prior_level?: number }).prior_level}`)).toEqual(["limitless:fed-dec-hold:4", "polymarket:pm-0:4"]);
    const y = io({ [lm]: lmGroup("Fed Decision in January?"), [pm("fed-decision-in-december")]: gamma("Fed Decision in December?", FED_DEC_TEXT, ["No change"]) }, prints({ "fomc_upper_bound:2026-10-28": FED_OCT }));
    const bad = await suggestLegs(adhoc(argv), y);
    expect(bad.entries.map((e) => e.market.platform)).toEqual(["polymarket"]);
    expect(bad.skipped).toEqual([expect.objectContaining({ platform: "limitless", reason: expect.stringMatching(/^not about 2026-12-09: platform the title "Fed Decision in January\?" names January, not only December/) })]);
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

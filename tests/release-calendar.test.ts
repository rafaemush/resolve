/**
 * The release calendar (src/resolve/release-calendar.ts) and the registry generated from it (KNOWN_RELEASES,
 * src/resolve/official.ts): the rows chain, the generator reproduces every hand-written entry it overlaps, every
 * generated key parses under the rail's period grammar, each family keeps its fallback convention, an event whose
 * fallback needs a date the calendar lacks is absent, and every basis carries its page, read time and UNVERIFIED flags.
 */
import { describe, expect, it } from "vitest";
import { HAND_WRITTEN_RELEASES, KNOWN_RELEASES, OFFICIAL_SERIES, fallbackEndMs, parseOfficialRef, periodValid, type OfficialSeriesId } from "../src/resolve/official";
import { isElectionSeries } from "../src/resolve/election";
import {
  CALENDAR_FAMILY_SERIES, RELEASE_CALENDAR, calendarReleases, easternOffsetHours, etDayStartUtc, previousInCalendar, type CalendarFamily, type CalendarRow,
} from "../src/resolve/release-calendar";

const FAMILIES = Object.keys(CALENDAR_FAMILY_SERIES) as CalendarFamily[];
const seriesOf = (key: string) => key.slice(0, key.indexOf(":")) as OfficialSeriesId;
const periodOf = (key: string) => key.slice(key.indexOf(":") + 1);
const generated = calendarReleases();
const row = (over: Partial<CalendarRow> & Pick<CalendarRow, "family" | "period">): CalendarRow => ({
  release_local: "x", release_at: null, next_release_at: null, date_status: "VERIFIED", time_status: "VERIFIED", source_url: "https://example.gov/schedule", read_at: "2026-09-29T18:00Z", ...over,
});

describe("the calendar rows", () => {
  it("36 rows of the nine families, each family's rows in order and chained: next_release_at is the following row's release_at", () => {
    expect(RELEASE_CALENDAR).toHaveLength(36);
    expect(new Set(RELEASE_CALENDAR.map((r) => r.family))).toEqual(new Set(FAMILIES));
    for (const f of FAMILIES) {
      const rows = RELEASE_CALENDAR.filter((r) => r.family === f);
      expect(rows.map((r) => r.period), f).toEqual([...rows.map((r) => r.period)].sort());
      for (let i = 0; i + 1 < rows.length; i++) {
        const [a, b] = [rows[i]!, rows[i + 1]!];
        if (a.next_release_at !== null && b.release_at !== null) expect(a.next_release_at, `${f} ${a.period}`).toBe(b.release_at);
        else expect(f, `${f} ${a.period}: only the BoK states no times`).toBe("bok_rate");
      }
    }
    for (const r of RELEASE_CALENDAR) {
      expect(r.source_url, `${r.family} ${r.period}`).toMatch(/^https:\/\/www\.(bls\.gov|federalreserve\.gov|ecb\.europa\.eu|bankofengland\.co\.uk|bok\.or\.kr|bcb\.gov\.br)\//);
      expect(Number.isNaN(Date.parse(r.read_at)), r.read_at).toBe(false);
      for (const t of [r.release_at, r.next_release_at]) if (t !== null) expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
      // a time the page does not state is UNVERIFIED and the row says why
      if (r.time_status === "UNVERIFIED") expect(r.note, `${r.family} ${r.period}`).toBeTruthy();
      // central-bank rows: the decision day is the UTC day of the release (the period names the day)
      if (r.release_at && OFFICIAL_SERIES[CALENDAR_FAMILY_SERIES[r.family][0]!].period === "day") expect(r.release_at.slice(0, 10)).toBe(r.period);
    }
  });

  it("every family's series are real, non-election registry series of the family's period kind, each in one family", () => {
    const kind: Record<CalendarFamily, string> = { bls_empsit: "month", bls_cpi: "month", bls_ppi: "month", fomc: "day", ecb: "day", boe: "day", bcb_copom: "day", bok_rate: "day", bok_gdp: "quarter" };
    const all = FAMILIES.flatMap((f) => CALENDAR_FAMILY_SERIES[f].map((s) => [f, s] as const));
    expect(new Set(all.map(([, s]) => s)).size).toBe(all.length);
    for (const [f, s] of all) {
      expect(Object.hasOwn(OFFICIAL_SERIES, s), s).toBe(true);
      expect(isElectionSeries(s), s).toBe(false);
      expect(OFFICIAL_SERIES[s].period, s).toBe(kind[f]);
    }
    // every non-election series of the rail is scheduled by the calendar
    expect(new Set(all.map(([, s]) => s))).toEqual(new Set((Object.keys(OFFICIAL_SERIES) as OfficialSeriesId[]).filter((s) => !isElectionSeries(s))));
    expect(CALENDAR_FAMILY_SERIES.bls_empsit).toEqual(["us_unemployment_rate", "us_nonfarm_payrolls_change"]);
    expect(CALENDAR_FAMILY_SERIES.bls_cpi).toEqual(["us_cpi_u_nsa_yoy", "us_cpi_u_sa_mom", "us_core_cpi_nsa_yoy", "us_core_cpi_sa_mom"]);
  });
});

describe("the registry generated from it", () => {
  it("reproduces release_at and fallback_until of every hand-written entry it overlaps (all 13 non-election ones)", () => {
    const overlap = Object.keys(HAND_WRITTEN_RELEASES).filter((k) => generated.releases[k]);
    expect(overlap.sort()).toEqual([
      "bcb_selic_target:2026-11-04", "boe_bank_rate:2026-11-05", "bok_base_rate:2026-10-22", "ecb_dfr:2026-10-29", "fomc_upper_bound:2026-10-28", "kr_gdp_advance_yoy:2026-Q3",
      "us_core_cpi_nsa_yoy:2026-09", "us_core_cpi_sa_mom:2026-09", "us_cpi_u_nsa_yoy:2026-09", "us_cpi_u_sa_mom:2026-09", "us_nonfarm_payrolls_change:2026-09", "us_ppi_fd_nsa_yoy:2026-09", "us_unemployment_rate:2026-09",
    ]);
    for (const k of overlap) {
      expect({ release_at: generated.releases[k]!.release_at, fallback_until: generated.releases[k]!.fallback_until }, k)
        .toEqual({ release_at: HAND_WRITTEN_RELEASES[k]!.release_at, fallback_until: HAND_WRITTEN_RELEASES[k]!.fallback_until });
    }
    // every hand-written entry the generator does not reproduce is an election day
    for (const k of Object.keys(HAND_WRITTEN_RELEASES)) if (!generated.releases[k]) expect(isElectionSeries(seriesOf(k)), k).toBe(true);
  });

  it("KNOWN_RELEASES is the hand-written entries unchanged plus the generated events they lack, and nothing else", () => {
    for (const [k, v] of Object.entries(HAND_WRITTEN_RELEASES)) expect(KNOWN_RELEASES[k], k).toBe(v);
    const added = Object.keys(KNOWN_RELEASES).filter((k) => !(k in HAND_WRITTEN_RELEASES));
    expect(added.sort()).toEqual(Object.keys(generated.releases).filter((k) => !(k in HAND_WRITTEN_RELEASES)).sort());
    for (const k of added) expect(KNOWN_RELEASES[k]).toEqual(generated.releases[k]);
    expect(added).toHaveLength(27);
    // the registry now reaches past 2026-11-05: the next meetings and months are known events
    for (const k of ["fomc_upper_bound:2026-12-09", "ecb_dfr:2027-06-10", "boe_bank_rate:2027-06-17", "bcb_selic_target:2027-06-16", "us_cpi_u_sa_mom:2026-10", "us_unemployment_rate:2026-10", "us_ppi_fd_nsa_yoy:2026-10"]) expect(added, k).toContain(k);
  });

  it("every generated key parses under the rail's grammar: month for BLS, day for decisions, quarter for GDP", () => {
    for (const k of Object.keys(generated.releases)) {
      const s = seriesOf(k), p = periodOf(k);
      expect(parseOfficialRef(`official:${k}`), k).toEqual({ series: s, period: p });
      expect(periodValid(s, p), k).toBe(true);
      const re = OFFICIAL_SERIES[s].period === "month" ? /^\d{4}-\d{2}$/ : OFFICIAL_SERIES[s].period === "quarter" ? /^\d{4}-Q[1-4]$/ : /^\d{4}-\d{2}-\d{2}$/;
      expect(p, k).toMatch(re);
      const r = generated.releases[k]!;
      expect(Number.isNaN(Date.parse(r.release_at)), k).toBe(false);
      if (r.fallback_until) expect(Date.parse(r.fallback_until), k).toBeGreaterThan(Date.parse(r.release_at));
    }
  });

  it("an event whose fallback needs a next date the calendar lacks is absent, with the reason (never a guessed fallback)", () => {
    const absent = ["us_unemployment_rate:2026-11", "us_nonfarm_payrolls_change:2026-11", "us_cpi_u_nsa_yoy:2026-11", "us_cpi_u_sa_mom:2026-11", "us_core_cpi_nsa_yoy:2026-11", "us_core_cpi_sa_mom:2026-11", "us_ppi_fd_nsa_yoy:2026-11", "bok_base_rate:2026-11-26"];
    for (const k of absent) {
      expect(KNOWN_RELEASES[k], k).toBeUndefined();
      expect(generated.skipped.find((s) => s.key === k)?.reason, k).toMatch(/does not list .*no entry rather than a guessed fallback/);
    }
    expect(generated.skipped.map((s) => s.key).sort()).toEqual([...absent].sort());
    // families whose texts name no fallback need no next date: their last rows are generated
    expect(KNOWN_RELEASES["boe_bank_rate:2027-06-17"]).toMatchObject({ release_at: "2027-06-17T11:00:00Z", fallback_until: null });
    expect(KNOWN_RELEASES["bcb_selic_target:2027-06-16"]).toMatchObject({ release_at: "2027-06-16T21:30:00Z", fallback_until: null });
  });

  it("each family keeps its fallback convention", () => {
    // Employment Situation: 00:00 ET on the next release date (Dec 4 is EST: 05:00Z)
    for (const s of CALENDAR_FAMILY_SERIES.bls_empsit) expect(KNOWN_RELEASES[`${s}:2026-10`]).toMatchObject({ release_at: "2026-11-06T13:30:00Z", fallback_until: "2026-12-04T05:00:00Z" });
    // CPI and PPI: the next release time
    for (const s of CALENDAR_FAMILY_SERIES.bls_cpi) expect(KNOWN_RELEASES[`${s}:2026-10`]).toMatchObject({ release_at: "2026-11-10T13:30:00Z", fallback_until: "2026-12-10T13:30:00Z" });
    expect(KNOWN_RELEASES["us_ppi_fd_nsa_yoy:2026-10"]).toMatchObject({ release_at: "2026-11-13T13:30:00Z", fallback_until: "2026-12-15T13:30:00Z" });
    // FOMC and ECB: the next statement / release time, across the DST change
    expect(KNOWN_RELEASES["fomc_upper_bound:2027-01-27"]).toMatchObject({ release_at: "2027-01-27T19:00:00Z", fallback_until: "2027-03-17T18:00:00Z" });
    expect(KNOWN_RELEASES["ecb_dfr:2027-03-18"]).toMatchObject({ release_at: "2027-03-18T13:15:00Z", fallback_until: "2027-04-29T12:15:00Z" });
    // BoE and Copom: none
    for (const k of Object.keys(KNOWN_RELEASES).filter((k) => ["boe_bank_rate", "bcb_selic_target", "kr_gdp_advance_yoy"].includes(seriesOf(k)))) expect(KNOWN_RELEASES[k]!.fallback_until, k).toBeNull();
    expect(fallbackEndMs({ series: "boe_bank_rate", period: "2026-12-17", release_at: "2026-12-17T12:00:00Z" })).toBe(Date.parse("2026-12-17T12:00:00Z") + 45 * 86_400_000);
    // BoK: the next meeting at 10:00 KST, from the next row (synthetic: the calendar's own next BoK row has no successor)
    const bok = calendarReleases([row({ family: "bok_rate", period: "2027-01-14" }), row({ family: "bok_rate", period: "2027-02-25" })]);
    expect(bok.releases["bok_base_rate:2027-01-14"]).toMatchObject({ release_at: "2027-01-14T01:00:00Z", fallback_until: "2027-02-25T01:00:00Z" });
    expect(bok.skipped).toEqual([{ key: "bok_base_rate:2027-02-25", reason: expect.stringContaining("no entry rather than a guessed fallback") }]);
  });

  it("synthetic rows: the Employment Situation fallback follows EDT in summer, and no rule ever fills a missing date", () => {
    const summer = calendarReleases([row({ family: "bls_empsit", period: "2027-05", release_at: "2027-06-04T12:30:00Z", next_release_at: "2027-07-02T12:30:00Z" })]);
    expect(summer.releases["us_unemployment_rate:2027-05"]).toMatchObject({ release_at: "2027-06-04T12:30:00Z", fallback_until: "2027-07-02T04:00:00Z" });
    const gaps = calendarReleases([
      row({ family: "bls_cpi", period: "2027-01", release_at: "2027-02-10T13:30:00Z" }),
      row({ family: "fomc", period: "2027-07-28", release_at: "2027-07-28T18:00:00Z" }),
      row({ family: "ecb", period: "2027-07-22", release_at: null, next_release_at: "2027-09-09T12:15:00Z" }),
      row({ family: "bls_empsit", period: "2027-06", release_at: "2027-07-02T12:30:00Z" }),
    ]);
    expect(gaps.releases).toEqual({});
    expect(gaps.skipped.map((s) => s.key)).toEqual(["us_cpi_u_nsa_yoy:2027-01", "us_cpi_u_sa_mom:2027-01", "us_core_cpi_nsa_yoy:2027-01", "us_core_cpi_sa_mom:2027-01", "fomc_upper_bound:2027-07-28", "ecb_dfr:2027-07-22", "us_unemployment_rate:2027-06", "us_nonfarm_payrolls_change:2027-06"]);
    expect(gaps.skipped.find((s) => s.key === "ecb_dfr:2027-07-22")?.reason).toContain("states no release time");
  });

  it("every basis names its page, the read time and every UNVERIFIED flag of the row and of the next release", () => {
    for (const r of RELEASE_CALENDAR) {
      for (const s of CALENDAR_FAMILY_SERIES[r.family]) {
        const e = generated.releases[`${s}:${r.period}`];
        if (!e) continue;
        expect(e.basis).toContain(r.source_url);
        expect(e.basis).toContain(`read ${r.read_at}`);
        // the first clause is the release itself: it carries the row's own flag, and only then
        const releaseClause = e.basis.slice(0, e.basis.indexOf(";"));
        expect(releaseClause.includes("(time UNVERIFIED)"), `${s}:${r.period}: ${releaseClause}`).toBe(r.time_status === "UNVERIFIED");
        expect(releaseClause.includes("date UNVERIFIED"), `${s}:${r.period}`).toBe(r.date_status === "UNVERIFIED");
        if (r.note) expect(e.basis).toContain(r.note);
      }
    }
    // the next release's own flag: 2027-04-29 is an UNVERIFIED ECB time, 2027-07-28 is beyond the calendar
    expect(generated.releases["ecb_dfr:2027-03-18"]!.basis).toMatch(/2027-04-29T12:15:00Z \(time UNVERIFIED\)/);
    expect(generated.releases["fomc_upper_bound:2026-12-09"]!.basis).toMatch(/2027-01-27T19:00:00Z \(time UNVERIFIED\)/);
    expect(generated.releases["fomc_upper_bound:2027-06-09"]!.basis).toMatch(/2027-07-28T18:00:00Z \(beyond this calendar: UNVERIFIED\)/);
    expect(generated.releases["bcb_selic_target:2026-12-09"]!.basis).toMatch(/time UNVERIFIED.*earliest time/);
    expect(generated.releases["us_cpi_u_nsa_yoy:2026-10"]!.basis).not.toContain("UNVERIFIED");
  });

  it("synthetic rows: an UNVERIFIED date is flagged in the basis, on the release and on the fallback it sets (no calendar row has one yet)", () => {
    const r = calendarReleases([
      row({ family: "fomc", period: "2027-07-28", release_local: "2027-07-28 14:00 ET", release_at: "2027-07-28T18:00:00Z", next_release_at: "2027-09-22T18:00:00Z", date_status: "UNVERIFIED", note: "tentative date" }),
      row({ family: "fomc", period: "2027-09-22", release_local: "2027-09-22 14:00 ET", release_at: "2027-09-22T18:00:00Z", next_release_at: "2027-11-03T18:00:00Z", date_status: "UNVERIFIED", time_status: "UNVERIFIED", note: "tentative date and time" }),
    ]);
    expect(r.releases["fomc_upper_bound:2027-07-28"]!.basis).toMatch(/^FOMC statement 2027-07-28: 2027-07-28 14:00 ET = 2027-07-28T18:00:00Z \(date UNVERIFIED\); fallback at the next FOMC statement, 2027-09-22T18:00:00Z \(date UNVERIFIED, time UNVERIFIED\),/);
    expect(r.releases["fomc_upper_bound:2027-09-22"]!.basis).toMatch(/^FOMC statement 2027-09-22: 2027-09-22 14:00 ET = 2027-09-22T18:00:00Z \(date UNVERIFIED, time UNVERIFIED\);/);
    const bok = calendarReleases([row({ family: "bok_rate", period: "2027-01-14", release_local: "2027-01-14 KST" }), row({ family: "bok_rate", period: "2027-02-25", date_status: "UNVERIFIED" })]);
    expect(bok.releases["bok_base_rate:2027-01-14"]!.basis).toContain("fallback at the next meeting, 2027-02-25 10:00 KST (date UNVERIFIED)");
  });
});

describe("US Eastern time without a time-zone database", () => {
  it("00:00 ET of the release date agrees with Intl for every day of 2026-2028 (EST 05:00Z, EDT 04:00Z)", () => {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const et = (ms: number) => { const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` }; };
    for (let d = Date.UTC(2026, 0, 1); d < Date.UTC(2029, 0, 1); d += 86_400_000) {
      for (const h of [3.5, 4.5, 12.5, 23.5]) {
        const at = d + h * 3600_000;
        const start = Date.parse(etDayStartUtc(new Date(at).toISOString()));
        expect(et(start), new Date(at).toISOString()).toEqual({ day: et(at).day, hm: "00:00" });
      }
      const noonUtc = d + 12 * 3600_000;
      expect(easternOffsetHours(noonUtc)).toBe(Number(et(noonUtc).hm.slice(0, 2)) === 7 ? 5 : 4);
    }
    expect(etDayStartUtc("2026-11-06T13:30:00Z")).toBe("2026-11-06T05:00:00Z");
    expect(etDayStartUtc("2026-10-02T12:30:00Z")).toBe("2026-10-02T04:00:00Z");
    expect(etDayStartUtc("2026-11-01T12:00:00Z")).toBe("2026-11-01T04:00:00Z"); // the switch day: midnight is still EDT
    expect(etDayStartUtc("2027-03-14T12:00:00Z")).toBe("2027-03-14T05:00:00Z"); // the switch day: midnight is still EST
  });
});

describe("previousInCalendar", () => {
  it("the row before in the family, the last row for the day of its next release, else the reason", () => {
    expect(previousInCalendar("fomc_upper_bound", "2026-12-09")).toMatchObject({ period: "2026-10-28" });
    expect(previousInCalendar("bcb_selic_target", "2027-06-16")).toMatchObject({ period: "2027-04-28" });
    expect(previousInCalendar("bok_base_rate", "2026-11-26")).toMatchObject({ period: "2026-10-22" });
    expect(previousInCalendar("fomc_upper_bound", "2027-07-28")).toMatchObject({ period: "2027-06-09" }); // beyond the rows, named as the last row's next
    expect(previousInCalendar("fomc_upper_bound", "2026-10-28")).toEqual({ reason: expect.stringContaining("first FOMC statement in the release calendar") });
    expect(previousInCalendar("ecb_dfr", "2027-09-09")).toEqual({ reason: "ecb_dfr:2027-09-09 is not in the release calendar" });
    expect(previousInCalendar("br_pres_r1_winner", "2026-10-04")).toEqual({ reason: "br_pres_r1_winner is not in the release calendar" });
  });
});

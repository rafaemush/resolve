/**
 * Election series of the official_release rail: TSE and Élections Québec parsers on the saved files
 * (evals/fixtures/official/), result URLs built only from the configuration, the finality and integrity checks, the
 * event keys (one per platform event), and the registration rules. The resolve paths are covered by the frozen cases
 * in evals/official.ts (groups election_final, election_margin, election_mapping).
 */
import { describe, expect, it } from "vitest";
import { officialFixture as fx } from "../evals/lib/official-fixtures";
import { parseTseConfig, parseTseResult, parseEqResults, tseResultUrl, eqIso, voteStatus } from "../src/ingest/election-parse";
import { ELECTION_SERIES, tseNotFinal, tseIntegrity, eqNotFinal, eqIntegrity, electionRegistrationIssues, normName, namesAgree } from "../src/resolve/election";
import { KNOWN_RELEASES, OFFICIAL_SERIES, fetchGroupOf } from "../src/resolve/official";
import { ElectionSeries } from "../src/resolve/schema";

describe("TSE configuration and URLs", () => {
  it("finds the President first round of the 2026 simulation (its pleito is dated 26/04/2026) and builds the unified file URL from it", () => {
    const c = parseTseConfig(fx("tse_sim2026_config_ele-c.json"), "2026-04-26");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.snap).toMatchObject({ environment: "s", cycle: "ele2026", electionId: "21270" });
    expect(tseResultUrl(c.snap, "AC")).toBe("https://resultados.tse.jus.br/oficial/ele2026/21270/dados/ac/ac-c0001-e021270-u.json");
  });
  it("reports a configuration without the election day as not published (never a guessed id)", () => {
    const c = parseTseConfig(fx("tse_sim2026_config_ele-c.json"), "2026-10-04");
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe("not_published");
  });
  it("reads dvt values exactly; anything else is 'other'", () => {
    expect(voteStatus("Válido")).toBe("valid");
    expect(voteStatus("Anulado sub judice")).toBe("sub_judice");
    expect(voteStatus("Anulado")).toBe("annulled");
    expect(voteStatus("Válido (legenda)")).toBe("other");
  });
});

describe("TSE result files", () => {
  it("2022 national partial (1.99%) and md=S (99.99%) files are not final; the tf=s file is", () => {
    const at = (f: string) => { const p = parseTseResult(fx(f), "2022-10-02"); if (!p.ok) throw new Error(p.detail); return p.snap; };
    expect(tseNotFinal(at("tse_2022_br_c0001_e000544_r_20221002T210340Z.json")).length).toBeGreaterThan(0);
    expect(tseNotFinal(at("tse_2022_br_c0001_e000544_r_20221003T155646Z.json")).join(" ")).toContain("tf=n");
    const fin = at("tse_2022_br_c0001_e000544_r_20221004T163422Z.json");
    expect(tseNotFinal(fin)).toEqual([]);
    expect(tseIntegrity(fin)).toEqual([]);
    expect(fin.candidates.find((c) => c.id === "13")).toMatchObject({ name: "LULA", votes: "57259504", status: "valid" });
    expect(fin.as_of).toBe("2022-10-04T10:27:34-03:00");
  });
  it("the 2026 simulation (EA20) parses, adds up, and carries a sub judice candidate", () => {
    const p = parseTseResult(fx("tse_sim2026_br_c0001_e021270_u.json"), "2026-10-04");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.snap.layout).toBe("ea20");
    expect(p.snap.environment).toBe("s");
    expect(tseIntegrity(p.snap)).toEqual([]);
    expect(p.snap.candidates.some((c) => c.status === "sub_judice")).toBe(true);
  });
  it("a file whose totals do not add up is flagged", () => {
    const body = fx("tse_2022_ac_c0001_e000544_r_20221007T210406Z.json").replace('"vap" : "275582"', '"vap" : "275583"');
    const p = parseTseResult(body, "2022-10-02");
    if (!p.ok) throw new Error(p.detail);
    expect(tseIntegrity(p.snap).join(" ")).toContain("valid candidates add up");
  });
});

describe("Élections Québec results", () => {
  it("normalises the comma before fractional seconds", () => {
    expect(eqIso("2022-10-06T11:55:41,000-04:00")).toBe("2022-10-06T11:55:41.000-04:00");
    expect(eqIso("not a date")).toBeNull();
  });
  it("the 2022 archive is final and consistent", () => {
    const p = parseEqResults(fx("eq_gen2022_resultats.json"));
    if (!p.ok) throw new Error(p.detail);
    expect(p.snap.ridings.length).toBe(125);
    expect(eqNotFinal(p.snap)).toEqual([]);
    expect(eqIntegrity(p.snap)).toEqual([]);
  });
  it("{} is not published yet", () => {
    const p = parseEqResults("{}");
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("not_published");
  });
});

describe("registry and event keys", () => {
  it("every election series is registered with a known release at polls close and its own event key", () => {
    const keys = new Set<string>();
    for (const s of ElectionSeries.options) {
      const d = ELECTION_SERIES[s];
      expect(d).toBeDefined();
      const day = d.authority === "tse" ? "2026-10-04" : "2026-10-05";
      expect(KNOWN_RELEASES[`${s}:${day}`]?.release_at).toBe(d.authority === "tse" ? "2026-10-04T20:00:00Z" : "2026-10-06T00:00:00Z");
      expect(OFFICIAL_SERIES[s].decides).toBe("election");
      keys.add(`official:${s}:${day}`);
    }
    expect(keys.size).toBe(ElectionSeries.options.length);
    expect(ELECTION_SERIES.qc_pq_majority.id).not.toBe(ELECTION_SERIES.qc_seats_pq.id);
  });
  it("one fetch serves every series of the national TSE file and of the Québec file", () => {
    expect(fetchGroupOf("br_pres_r1_winner")).toContain("br_pres_r1_turnout");
    expect(fetchGroupOf("qc_riding_751")).toContain("qc_seats_caq");
    expect(fetchGroupOf("br_pres_r1_first_ac")).toEqual(["br_pres_r1_first_ac"]);
  });
  it("names compare without accents or case", () => {
    expect(normName("Flávio D&apos;Ávila")).toBe("flavio d avila");
    expect(namesAgree("Lula", "LULA")).toBe(true);
    expect(namesAgree("Lula", "JAIR BOLSONARO")).toBe(false);
  });
  it("registration refuses a rank leg without the event's named candidates and a wrong rank bucket", () => {
    const base = { series: "br_pres_r1_third", period: "2026-10-04", rounding: "election_exact" };
    const issues = electionRegistrationIssues({ ...base, bucket: { label: "x", lo: 2, hi: 2, lo_inclusive: true, hi_inclusive: true }, election: { subject: { id: "13", name: "LULA" } } });
    expect(issues.join(" ")).toContain("election.listed");
    expect(issues.join(" ")).toContain("place 3");
  });
});

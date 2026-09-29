/**
 * Election series of the official_release rail: TSE and Élections Québec parsers on the saved files
 * (evals/fixtures/official/), result URLs built only from the configuration, the finality and integrity checks, the
 * event keys (one per platform event: two events on one key are refused), the TSE label mapper (exact names or a
 * curated table, never a word subset), the criteria basis mark, and the registration rules. The resolve paths are covered by the frozen cases
 * in evals/official.ts (groups election_final, election_margin, election_mapping).
 */
import { describe, expect, it } from "vitest";
import { officialFixture as fx } from "../evals/lib/official-fixtures";
import { parseTseConfig, parseTseResult, parseEqResults, tseResultUrl, eqIso, voteStatus } from "../src/ingest/election-parse";
import { ELECTION_SERIES, tseNotFinal, tseIntegrity, eqNotFinal, eqIntegrity, electionRegistrationIssues, normName, namesAgree } from "../src/resolve/election";
import { KNOWN_RELEASES, OFFICIAL_SERIES, fetchGroupOf } from "../src/resolve/official";
import { ElectionSeries } from "../src/resolve/schema";
import { buildElectionLeg, criteriaBasis, eqRegistryFromSnapshot, eventKeyProblems, mapTseCandidate, tseRegistryFromSnapshot, TSE_LABEL_NUMBERS, type TseRegistry } from "../src/markets/election-legs";
import { eventKey } from "../src/markets/event-key";

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
  it("every election series is registered with a known release at polls close", () => {
    for (const s of ElectionSeries.options) {
      const d = ELECTION_SERIES[s];
      expect(d).toBeDefined();
      const day = d.authority === "tse" ? "2026-10-04" : "2026-10-05";
      expect(KNOWN_RELEASES[`${s}:${day}`]?.release_at).toBe(d.authority === "tse" ? "2026-10-04T20:00:00Z" : "2026-10-06T00:00:00Z");
      expect(OFFICIAL_SERIES[s].decides).toBe("election");
    }
  });
  it("two distinct Polymarket events read as the same series and day collide on one event key, and the leg file refuses it", () => {
    // legs built by the production builder, keys by the production eventKey (the leg file's own path)
    const p = parseEqResults(fx("eq_gen2022_resultats.json"));
    if (!p.ok) throw new Error(p.detail);
    const reg = { eq: eqRegistryFromSnapshot(p.snap, "https://donnees.electionsquebec.qc.ca/production/provincial/resultats/resultats.json", "2026-09-27T22:51:18Z") };
    const row = (series: "qc_seats_caq" | "qc_seats_plq", party: string, eventId: string, legId: string) => {
      const b = buildElectionLeg({ series, period: "2026-10-05", release_at: "2026-10-06T00:00:00Z", title: `Seats (${eventId})`, criteria: "Seats won.", labels: ["20+"], party }, { external_id: legId, label: "20+", open_at: "2026-09-01T00:00:00Z", deadline_utc: "2027-01-31T23:59:00Z" }, reg);
      if (!b.ok) throw new Error(b.reason);
      return { event_id: eventId, event_key: eventKey({ platform: "polymarket", external_id: legId, resolver: b.market.resolver, meta: { event_id: eventId } }) };
    };
    const caq = row("qc_seats_caq", "Coalition Avenir Québec", "101", "1001");
    const relisted = row("qc_seats_caq", "Coalition Avenir Québec", "202", "2002"); // a relisted copy of the same event
    const plq = row("qc_seats_plq", "Parti libéral du Québec", "303", "3003");
    expect(caq.event_key).toBe(relisted.event_key); // the real collision
    expect(eventKeyProblems([caq, relisted, plq])).toEqual(["event key official:qc_seats_caq:2026-10-05 is shared by events 101 and 202"]);
    expect(eventKeyProblems([caq, plq, { ...caq, event_id: "101" }])).toEqual([]);
    // and one event whose legs land on two keys is refused too
    expect(eventKeyProblems([caq, { ...plq, event_id: "101" }])).toEqual(["event 101 maps to 2 event keys: official:qc_seats_caq:2026-10-05, official:qc_seats_plq:2026-10-05"]);
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

describe("TSE label mapping: exact ballot or civil name, or the curated table; never a word subset", () => {
  const reg2022 = (() => {
    const p = parseTseResult(fx("tse_2022_br_c0001_e000544_r_20221004T163422Z.json"), "2022-10-02");
    if (!p.ok) throw new Error(p.detail);
    return tseRegistryFromSnapshot(p.snap, "https://resultados.tse.jus.br/oficial/ele2022/544/dados-simplificados/br/br-c0001-e000544-r.json", "2022-10-04T16:34:22Z");
  })();
  // SYNTHETIC registry: names shaped like the 2026 events' labels, ballot numbers invented (no 2026 TSE list was observed)
  const synth: TseRegistry = {
    source_url: "https://resultados.tse.jus.br/oficial/ele2026/0/dados/br/br-c0001-e000000-u.json", fetched_at: "2026-10-04T21:00:00Z", election_day: "2026-10-04",
    candidates: [
      { id: "901", name: "FLÁVIO BOLSONARO", full_name: "FLÁVIO NANTES BOLSONARO" },
      { id: "902", name: "ESCRITOR AUGUSTO CURY", full_name: "AUGUSTO JORGE CURY" },
      { id: "903", name: "JOSÉ SILVA", full_name: null },
      { id: "904", name: "JOSE SILVA", full_name: null },
    ],
  };
  const id = (r: ReturnType<typeof mapTseCandidate>) => (r.ok ? r.subject.id : `refused: ${r.reason}`);

  it("maps exact ballot names and civil names, case and accents ignored", () => {
    expect(id(mapTseCandidate("Lula", reg2022))).toBe("13");
    expect(id(mapTseCandidate("ciro GOMES", reg2022))).toBe("12");
    expect(id(mapTseCandidate("Flavio Bolsonaro", synth))).toBe("901");
    expect(id(mapTseCandidate("Flávio Nantes Bolsonaro", synth))).toBe("901");
  });
  it("refuses a label that only shares words with a candidate (a surname, or part of a ballot name)", () => {
    const bolsonaro = mapTseCandidate("Bolsonaro", reg2022);
    expect(bolsonaro).toMatchObject({ ok: false, partial: true });
    if (!bolsonaro.ok) expect(bolsonaro.reason).toContain("its words are within 22 JAIR BOLSONARO; a word-subset match is never accepted");
    expect(mapTseCandidate("Bolsonaro", synth)).toMatchObject({ ok: false, partial: true });
    expect(mapTseCandidate("Augusto Cury", synth)).toMatchObject({ ok: false, partial: true });
  });
  it("refuses an unmatched label (an off-ballot person who shares a surname is no match at all)", () => {
    for (const l of ["Jair Bolsonaro", "Michelle Bolsonaro", "Tarcísio de Freitas"]) {
      const r = mapTseCandidate(l, synth);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.reason).toContain("matches no TSE candidate"); expect(r.partial).toBeUndefined(); expect(r.unmatched).toBe(true); }
    }
  });
  it("refuses an ambiguous label (two candidates with the same normalized name)", () => {
    const r = mapTseCandidate("Jose Silva", synth);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ambiguous: it matches 903 JOSÉ SILVA and 904 JOSE SILVA");
  });
  it("maps a curated label to its ballot number only when the registry lists that number and no exact name contradicts it", () => {
    expect(TSE_LABEL_NUMBERS["2026-10-04"]).toEqual({}); // no 2026 ballot number has been observed from the TSE
    expect(id(mapTseCandidate("Augusto Cury", synth, { "augusto cury": "902" }))).toBe("902");
    expect(id(mapTseCandidate("Augusto Cury", synth, { "augusto cury": "999" }))).toContain("curated as ballot number 999, which the TSE candidate of 2026-10-04");
    expect(id(mapTseCandidate("Flavio Bolsonaro", synth, { "flavio bolsonaro": "902" }))).toContain("ambiguous: curated as ballot number 902 but it is the exact name of 901");
  });
  it("a rank event that names a candidate by some words only is refused as a whole (its named set is unknown)", () => {
    const ev = { series: "br_pres_r1_winner" as const, period: "2026-10-04", release_at: "2026-10-04T20:00:00Z", title: "Winner", criteria: "Paraphrased rules.", labels: ["Flavio Bolsonaro", "Bolsonaro"] };
    const b = buildElectionLeg(ev, { external_id: "1", label: "Flavio Bolsonaro", open_at: "2026-09-01T00:00:00Z", deadline_utc: "2027-06-30T23:59:00Z" }, { tse: synth });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toContain("so the candidates it names are not known exactly");
    const ok = buildElectionLeg({ ...ev, labels: ["Flavio Bolsonaro", "Jair Bolsonaro"] }, { external_id: "1", label: "Flavio Bolsonaro", open_at: "2026-09-01T00:00:00Z", deadline_utc: "2027-06-30T23:59:00Z" }, { tse: synth });
    expect(ok.ok && (ok.market.resolver as { election?: { listed?: string[] } }).election?.listed).toEqual(["901"]);
    // a curated entry the registry contradicts is a refusal of the event, never a silently shorter named set
    const bad = mapTseCandidate("Augusto Cury", synth, { "augusto cury": "999" });
    expect(bad.ok === false && bad.unmatched).toBeFalsy();
  });
});

describe("criteria basis", () => {
  it("marks a text that settles on a consensus of credible reporting (paraphrased), and nothing else", () => {
    expect(criteriaBasis("<p>Resolves on a consensus of credible\nreporting; the official results decide only if there is ambiguity.</p>")).toBe("consensus_reporting");
    expect(criteriaBasis("Resolves on the official turnout published by the electoral authority.")).toBeNull();
  });
});

/**
 * Election series of the official_release rail: TSE and Élections Québec parsers on the saved files
 * (evals/fixtures/official/), result URLs built only from the configuration, the finality, integrity and completeness
 * checks, the event keys (one per platform event: two events on one key are refused), the TSE label mapper (exact names
 * or a curated table, never a word subset), the Québec seat-margin, PQ-majority and PVQ-seat legs, the criteria basis
 * mark, the registered condition text and the registration rules, each finality flag, integrity check, registration
 * rule and label rule alone (SYNTHETIC edits of the saved files). The resolve paths are also covered by the frozen
 * cases in evals/official.ts (groups election_final, election_margin, election_complete, election_mapping).
 */
import { afterEach, describe, expect, it } from "vitest";
import { officialFixture as fx } from "../evals/lib/official-fixtures";
import { eqApply, QC_TOP_TIE_RIDINGS, type EqOps } from "../evals/lib/eq-synthetic";
import { parseTseConfig, parseTseResult, parseEqResults, tseResultUrl, eqIso, voteStatus } from "../src/ingest/election-parse";
import {
  ELECTION_EVENTS, ELECTION_SERIES, QC_RIDING_COUNT, TSE_POLLS_CLOSE, decideElection, eqCompleteness, eqExpectedRidings, eqFileRefusal, tseFileRefusal, tseNotFinal, tseIntegrity, eqNotFinal, eqIntegrity,
  electionRegistrationIssues, normName, namesAgree, snapshotForSeries, type ElectionSeriesId, type EqSnapshot, type LegResolver,
} from "../src/resolve/election";
import { KNOWN_RELEASES, OFFICIAL_SERIES, fetchGroupOf } from "../src/resolve/official";
import { ElectionSeries } from "../src/resolve/schema";
import { __setRailsForMutationTesting } from "../src/resolve/rails";
import { buildElectionLeg, criteriaBasis, eqRegistryFromSnapshot, eventKeyProblems, legsWithOneKeyPerEvent, mapEqCandidate, mapTseCandidate, seatMarginForeignLabels, tseRegistryFromSnapshot, TSE_LABEL_NUMBERS, type TseRegistry } from "../src/markets/election-legs";
import { eventKey } from "../src/markets/event-key";

afterEach(() => __setRailsForMutationTesting([]));

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

const pendingTse = (caveat: string) => ({ status: "UNRESOLVED", outcome: "NONE", caveats: [caveat] });
describe("TSE capture gate: a final file no leg can decide from is never recorded (tseFileRefusal)", () => {
  const FINAL = fx("tse_2022_br_c0001_e000544_r_20221004T163422Z.json");
  const DAY = "2022-10-02";
  /** SYNTHETIC: the 2022 national final count with replacements, each applying exactly once. */
  const edited = (...edits: Array<[string, string]>) => {
    let body = FINAL;
    for (const [from, to] of edits) { if (body.split(from).length !== 2) throw new Error(`"${from}" is not exactly once`); body = body.replace(from, to); }
    const p = parseTseResult(body, DAY);
    if (!p.ok) throw new Error(p.detail);
    return p.snap;
  };
  /** SYNTHETIC: the final count stamped (dt/ht) on election day at `hms` Brasília time. */
  const stamped = (hms: string) => edited(['"dt" : "04/10/2022", "ht" : "10:27:34"', `"dt" : "02/10/2022", "ht" : "${hms}"`]);
  /** SYNTHETIC: Constituinte Eymael's 16,604 votes under a destination the rail does not read, the totals restated so the file adds up. */
  const unknownDestination = () => edited(
    ['"dvt" : "Válido", "vap" : "16604"', '"dvt" : "Válido (legenda)", "vap" : "16604"'], ['"vv" : "118229719"', '"vv" : "118213115"'],
    ['"vvc" : "118229719"', '"vvc" : "118213115"'], ['"tv" : "123682372"', '"tv" : "123665768"'], ['"c" : "123682372"', '"c" : "123665768"'],
  );
  const turnoutLeg = () => {
    const b = buildElectionLeg({ series: "br_pres_r1_turnout", period: DAY, release_at: "2022-10-02T20:00:00Z", title: "Test: turnout", criteria: "Paraphrased test rules. A value exactly between two brackets resolves to the higher bracket.", labels: ["75-80%"] }, { external_id: "t-turnout", label: "75-80%", open_at: "2022-09-01T00:00:00Z", deadline_utc: "2027-06-30T23:59:00Z" }, {});
    if (!b.ok) throw new Error(b.reason);
    return (snap: ReturnType<typeof edited>) => decideElection(b.market, b.market.resolver as LegResolver, snap, ["first_print", "single_source"]);
  };

  it("the 2022 national final count may be recorded, also stamped exactly at polls close; a second before, or a day the rail has no polls-close time for, is refused", () => {
    expect(tseFileRefusal(edited(), DAY)).toBeNull();
    expect(tseFileRefusal(stamped("17:00:00"), DAY)).toBeNull();
    expect(tseFileRefusal(stamped("16:59:59"), DAY)).toEqual({ kind: "before_polls_close", detail: "the file is stamped 2022-10-02T16:59:59-03:00, before polls closed at 2022-10-02T20:00:00Z (a simulation or another election)" });
    expect(tseFileRefusal(edited(), "2018-10-07")).toMatchObject({ kind: "before_polls_close", detail: expect.stringContaining("no polls-close time for a TSE election on 2018-10-07") });
    // the 2026 time is the event's release_at, which gate 1 of the resolver holds the stamp to
    expect(TSE_POLLS_CLOSE["2026-10-04"]).toBe(ELECTION_EVENTS.find((e) => e.authority === "tse" && e.day === "2026-10-04")!.polls_close);
    expect(TSE_POLLS_CLOSE["2026-10-04"]).toBe(KNOWN_RELEASES["br_pres_r1_winner:2026-10-04"]!.release_at);
  });
  it("refuses the file's own simulation flag, totals that do not add up and a vote destination the rail does not read, each the way every leg refuses it", () => {
    const decide = turnoutLeg();
    expect(decide(edited())).toMatchObject({ status: "RESOLVED", outcome: "OPTION_A" }); // control: 79.05% is in 75-80%
    const simulation = edited(['"f" : "o"', '"f" : "s"']);
    expect(tseFileRefusal(simulation, DAY)).toEqual({ kind: "environment", detail: "the TSE file is from the simulation environment, never a result" });
    expect(decide(simulation)).toMatchObject(pendingTse("awaiting_release"));
    const offByOne = edited(['"vv" : "118229719"', '"vv" : "118229720"']);
    expect(tseFileRefusal(offByOne, DAY)).toEqual({ kind: "inconsistent", detail: "TSE BR file: the valid candidates add up to 118229719, the file's valid votes are 118229720; vvc 118229719 != vv + van + vansj" });
    expect(decide(offByOne)).toMatchObject(pendingTse("totals_inconsistent"));
    const unknown = unknownDestination();
    expect(tseIntegrity(unknown)).toEqual([]); // the file adds up: only the destination refuses it
    expect(tseFileRefusal(unknown, DAY)).toEqual({ kind: "vote_status_unknown", detail: 'vote destination "Válido (legenda)" (27) is not one the rail reads' });
    expect(decide(unknown)).toMatchObject(pendingTse("vote_status_unknown"));
  });
  it("off (rail election_tse_capture_refusal): the capture records any final file", () => {
    __setRailsForMutationTesting(["election_tse_capture_refusal"]);
    for (const s of [edited(['"f" : "o"', '"f" : "s"']), stamped("16:59:59"), edited(['"vv" : "118229719"', '"vv" : "118229720"']), unknownDestination()]) expect(tseFileRefusal(s, DAY)).toBeNull();
    expect(tseFileRefusal(edited(), "2018-10-07")).toBeNull();
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
    // what scripts/election-legs.ts writes: every leg when the keys are one per event, no leg at all otherwise
    const written = (legs: Array<typeof caq>): Array<typeof caq> | string => { try { return legsWithOneKeyPerEvent(legs); } catch (e) { return String(e); } };
    expect(written([caq, plq])).toEqual([caq, plq]);
    expect(written([caq, relisted, plq])).toBe("Error: event keys: event key official:qc_seats_caq:2026-10-05 is shared by events 101 and 202");
    expect(written([caq, { ...plq, event_id: "101" }])).toBe("Error: event keys: event 101 maps to 2 event keys: official:qc_seats_caq:2026-10-05, official:qc_seats_plq:2026-10-05");
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

// ---- Élections Québec: completeness, and the seat-margin, PQ-majority and PVQ-seat legs --------------------------------

const EQ_2022 = "eq_gen2022_resultats.json";
const EQ_DAY = "2022-10-03";
/** The 2022 archive, or a SYNTHETIC body made from it, as the production parser reads it. */
function eqSnap(ops?: EqOps, edit?: (body: string) => string): EqSnapshot {
  let body = fx(EQ_2022);
  if (edit) body = edit(body);
  if (ops) body = eqApply(body, ops);
  const p = parseEqResults(body);
  if (!p.ok) throw new Error(p.detail);
  return p.snap;
}
const PQ = "Parti québécois";
const SEAT_MARGIN = [`${PQ} <10`, `${PQ} 10-19`, `${PQ} 20-29`, `${PQ} 30-39`, `${PQ} 40+`, "Another Party Wins"];
const eqReg = () => ({ eq: eqRegistryFromSnapshot(eqSnap(), "https://donnees.electionsquebec.qc.ca/production/provincial/resultats/resultats.json", "2026-09-27T22:51:18Z") });
function eqLeg(series: ElectionSeriesId, label: string, opts: { party?: string; labels?: string[]; unit?: string; period?: string } = {}) {
  const period = opts.period ?? EQ_DAY;
  const b = buildElectionLeg(
    { series, period, release_at: period === EQ_DAY ? "2022-10-04T00:00:00Z" : "2026-10-06T00:00:00Z", title: `Test: ${series}`, criteria: "Paraphrased test rules.", labels: opts.labels ?? [label], ...(opts.party ? { party: opts.party } : {}), ...(opts.unit ? { unit: opts.unit } : {}) },
    { external_id: `t-${series}`, label, open_at: "2022-09-01T00:00:00Z", deadline_utc: "2027-06-30T23:59:00Z" }, eqReg());
  return b;
}
/** The leg decided from the snapshot as the rail stores it for the series (or from `stored`, a SYNTHETIC stored contest). */
function decide(series: ElectionSeriesId, label: string, snap: EqSnapshot, opts: Parameters<typeof eqLeg>[2] & { stored?: EqSnapshot } = {}) {
  const b = eqLeg(series, label, opts);
  if (!b.ok) throw new Error(b.reason);
  return decideElection(b.market, b.market.resolver as LegResolver, opts.stored ?? snapshotForSeries(series, snap), ["first_print", "single_source"]);
}
const YES = { status: "RESOLVED", outcome: "OPTION_A" }, NO = { status: "RESOLVED", outcome: "OPTION_B" };
const pending = (caveat: string) => ({ status: "UNRESOLVED", outcome: "NONE", caveats: [caveat] });
const PQ_RIDINGS = ["370", "858", "842"]; // Camille-Laurin, Îles-de-la-Madeleine, Matane-Matapédia
const TOP_TIE: EqOps = { trade: [{ parties: ["27", "6"], ridings: QC_TOP_TIE_RIDINGS }] };
const PQ_LEADS: EqOps = { trade: [{ parties: ["27", "8"], ridings: "all" }] };
const PQ_TOP_TIE: EqOps = { trade: [{ parties: ["27", "8"], ridings: "all" }, { parties: ["8", "6"], ridings: QC_TOP_TIE_RIDINGS }] };

describe("Élections Québec completeness: every riding of the election, each once", () => {
  it("the riding count of an election is the rail's own: 125 in 2022, 127 in 2026, none for any other day", () => {
    expect(QC_RIDING_COUNT).toEqual({ "2022-10-03": 125, "2026-10-05": 127 });
    expect(eqExpectedRidings("2026-10-05")).toBe(127);
    expect(eqExpectedRidings("2018-10-01")).toBeUndefined();
    expect(eqExpectedRidings("constructor")).toBeUndefined();
    expect(ELECTION_EVENTS.find((e) => e.authority === "eq")).toMatchObject({ day: "2026-10-05", ridings: 127 });
  });
  it("the 2022 archive is complete; the finality and integrity checks alone do not see a missing riding", () => {
    expect(eqCompleteness(eqSnap(), 125)).toEqual([]);
    const cut = eqSnap({ drop: PQ_RIDINGS });
    expect(cut.ridings).toHaveLength(122);
    expect(eqNotFinal(cut)).toEqual([]);
    expect(eqIntegrity(cut)).toEqual([]);
    expect(eqCompleteness(cut, 125)).toEqual(["the file lists 122 of its 125 ridings"]);
  });
  it("refuses a riding listed twice, a riding count that is not the election's, and an election day without one", () => {
    const twice = eqSnap(undefined, (b) => b.replace('"numeroCirconscription": 842,', '"numeroCirconscription": 370,'));
    expect(twice.ridings).toHaveLength(125);
    expect(eqCompleteness(twice, 125)).toEqual(["riding 370 is listed more than once"]);
    // consistent with itself (124 ridings stated and listed), but the 2022 election had 125
    const restated = eqSnap({ drop: ["842"] }, (b) => b.replace('"nbCirconscription": 125,', '"nbCirconscription": 124,'));
    expect(eqCompleteness(restated, 125)).toEqual(["the file states 124 ridings; the election has 125 (another election's file, or a partial one)"]);
    expect(eqCompleteness(eqSnap(), 127)[0]).toContain("the file states 125 ridings; the election has 127");
    expect(eqCompleteness(eqSnap(), undefined)[0]).toContain("no riding count for this election day");
  });
  it("a riding event's copy is exactly its one riding; two ridings, or another riding, are refused", () => {
    const s = eqSnap();
    const copy = (ids: string[]): EqSnapshot => ({ ...s, ridings: s.ridings.filter((r) => ids.includes(r.id)) });
    expect(eqCompleteness(copy(["730"]), 125, "730")).toEqual([]);
    expect(eqCompleteness(s, 125, "730")).toEqual([]); // the whole file serves a riding event too
    expect(eqCompleteness(copy(["730", "842"]), 125, "730")).toEqual(["the snapshot holds 2 ridings: neither riding 730 alone nor all 125"]);
    expect(eqCompleteness(copy(["842"]), 125, "730")).toEqual(["the riding copy holds riding 842 (Matane-Matapédia), not riding 730"]);
    // one riding is a copy only for a riding event
    expect(eqCompleteness(copy(["730"]), 125)).toEqual(["the file lists 1 of its 125 ridings"]);
    expect(eqCompleteness(copy(["730"]), 127, "730")[0]).toContain("the election has 127");
  });
  it("the rail's own copy for a riding event is that one riding (Taschereau under its 2026 code)", () => {
    const s = eqSnap(undefined, (b) => b.replace('"numeroCirconscription": 730,', '"numeroCirconscription": 751,'));
    const own = snapshotForSeries("qc_riding_751", s);
    expect(own.authority === "eq" && own.ridings.map((r) => r.id)).toEqual(["751"]);
    expect(eqCompleteness(own as EqSnapshot, 125, "751")).toEqual([]);
  });
  it("the reviewer's reproduction: without the 3 ridings the PQ won, the PQ '<3' seats leg is unresolved, never Yes", () => {
    const cut = eqSnap({ drop: PQ_RIDINGS });
    expect(decide("qc_seats_pq", "<3", cut, { party: PQ })).toMatchObject(pending("totals_inconsistent"));
    expect(decide("qc_seat_margin", "Another Party Wins", cut, { party: PQ, labels: SEAT_MARGIN })).toMatchObject(pending("totals_inconsistent"));
    expect(decide("qc_second_place", "Parti libéral du Québec", cut, { labels: ["Parti libéral du Québec", PQ] })).toMatchObject(pending("totals_inconsistent"));
    expect(decide("qc_seats_pq", "<3", eqSnap(), { party: PQ })).toMatchObject(NO); // the whole file: the PQ won 3
    expect(decide("qc_seats_pq", "3-9", eqSnap(), { party: PQ })).toMatchObject(YES);
    // what the check exists for: with the rail off the 122 ridings present are counted as the election
    __setRailsForMutationTesting(["election_qc_complete_file"]);
    expect(decide("qc_seats_pq", "<3", cut, { party: PQ })).toMatchObject(YES);
  });
  it("a riding leg decides from its one-riding copy or the whole file, never from a copy of two ridings or of another riding", () => {
    const s = eqSnap();
    const winner = [...s.ridings.find((r) => r.id === "730")!.candidates].sort((a, b) => Number(b.votes) - Number(a.votes))[0]!.name;
    const copy = (ids: string[]): EqSnapshot => ({ ...s, ridings: s.ridings.filter((r) => ids.includes(r.id)) });
    expect(decide("qc_riding_751", winner, s, { unit: "730" })).toMatchObject(YES);
    expect(decide("qc_riding_751", winner, s, { unit: "730", stored: copy(["730"]) })).toMatchObject(YES);
    expect(decide("qc_riding_751", winner, s, { unit: "730", stored: copy(["730", "842"]) })).toMatchObject(pending("totals_inconsistent"));
    expect(decide("qc_riding_751", winner, s, { unit: "730", stored: copy(["842"]) })).toMatchObject(pending("totals_inconsistent"));
  });
  it("a 2026 leg never decides from a file of 125 ridings", () => {
    const stamped = eqSnap(undefined, (b) => b.replace('"iso8601DateMAJ": "2022-10-06T11:55:41,000-04:00"', '"iso8601DateMAJ": "2026-10-05T23:30:00,000-04:00"'));
    const d = decide("qc_seats_caq", "80+", stamped, { party: "Coalition Avenir Québec", period: "2026-10-05" });
    expect(d).toMatchObject(pending("totals_inconsistent"));
    expect(d.detail).toContain("the file states 125 ridings; the election has 127");
  });
  it("a leg of an election day the rail has no riding count for never decides: the file's own count is not a substitute", () => {
    const d = decide("qc_seats_caq", "80+", eqSnap(), { party: "Coalition Avenir Québec", period: "2018-10-01" });
    expect(d).toMatchObject(pending("totals_inconsistent"));
    expect(d.detail).toContain("no riding count for this election day");
    expect(decide("qc_seats_caq", "80+", eqSnap(), { party: "Coalition Avenir Québec" })).toMatchObject(YES); // the same file for 2022
  });
});

describe("Élections Québec integrity: the whole file adds up", () => {
  const withParty = (s: EqSnapshot, id: string, by: number): EqSnapshot => ({ ...s, parties: s.parties.map((x) => (x.id === id ? { ...x, votes: String(Number(x.votes) + by) } : x)) });
  it("compares every party's total in the statistics, party 0 (the independents) included, with its candidates over the ridings", () => {
    const s = eqSnap();
    expect(eqIntegrity(s)).toEqual([]);
    expect(eqIntegrity(withParty(s, "8", 1000))).toEqual(["party totals do not add up to their candidates' votes: party 8 601708 vs 600708 over the ridings"]);
    expect(eqIntegrity(withParty(s, "0", 1))).toEqual(["party totals do not add up to their candidates' votes: party 0 2122 vs 2121 over the ridings"]);
    // a party whose candidates have votes but that the statistics do not list, and one listed twice
    expect(eqIntegrity({ ...s, parties: s.parties.filter((x) => x.id !== "10") })).toEqual(["party totals do not add up to their candidates' votes: party 10 (not listed) vs 31054 over the ridings"]);
    const twice = eqIntegrity({ ...s, parties: [...s.parties, { ...s.parties.find((x) => x.id === "8")!, votes: "0" }] });
    expect(twice).toEqual(["party 8 is listed more than once in the file's statistics"]);
    // a listed party without a candidate and without votes adds up
    expect(eqIntegrity({ ...s, parties: [...s.parties, { id: "77", abbr: "X", name: "Parti sans candidat", votes: "0" }] })).toEqual([]);
  });
  it("compares the polling stations and the reported polling stations with the ridings'", () => {
    const s = eqSnap();
    expect(eqIntegrity({ ...s, polls_total: String(Number(s.polls_total) + 1), polls_done: String(Number(s.polls_done) + 1) })).toEqual([
      "the ridings' polling stations do not add up to the file's 21898 (nbBureauVote)",
      "the ridings' reported polling stations do not add up to the file's 21898 (nbBureauVoteRempli)",
    ]);
  });
  it("a riding event's one-riding copy cannot show a whole-file sum: the resolver alone decides a riding leg from a file that does not add up", () => {
    // the reviewer's reproduction: nbVoteValide and nbVoteExerce each 1,000 above the ridings' (Taschereau under its 2026 code 751)
    const bad = eqSnap(undefined, (b) => b.replace('"numeroCirconscription": 730,', '"numeroCirconscription": 751,').replace('"nbVoteValide": 4112821,', '"nbVoteValide": 4113821,').replace('"nbVoteExerce": 4169137,', '"nbVoteExerce": 4170137,'));
    expect(eqIntegrity(bad)).toEqual(["the ridings' votes cast do not add up to the file's", "the ridings' valid votes do not add up to the file's"]);
    const copy = snapshotForSeries("qc_riding_751", bad) as EqSnapshot;
    expect(copy.ridings.map((r) => r.id)).toEqual(["751"]);
    expect(eqIntegrity(copy)).toEqual([]);
    expect(eqIntegrity(withParty(copy, "8", 1000))).toEqual([]); // nor a party total
    // which is why the capture refuses the whole file before any series keeps its part (eqFileRefusal, src/ingest/official.ts)
    expect(eqFileRefusal(bad, EQ_DAY)).toEqual({ kind: "inconsistent", problems: eqIntegrity(bad) });
  });
  it("the capture's gate: every riding once first, then the whole file's arithmetic; the consistent 2022 archive passes", () => {
    const s = eqSnap();
    expect(eqFileRefusal(s, EQ_DAY)).toBeNull();
    expect(eqFileRefusal(eqSnap({ drop: PQ_RIDINGS }), EQ_DAY)).toEqual({ kind: "incomplete", problems: ["the file lists 122 of its 125 ridings"] });
    expect(eqFileRefusal(s, "2026-10-05")).toMatchObject({ kind: "incomplete" });
    expect(eqFileRefusal(withParty(s, "8", 1000), EQ_DAY)).toMatchObject({ kind: "inconsistent", problems: [expect.stringContaining("party 8 601708 vs 600708")] });
    const truncated = eqSnap({ unlist: [s.ridings.find((r) => r.id === "842")!.candidates.at(-1)!.id] });
    expect(eqFileRefusal(truncated, EQ_DAY)).toMatchObject({ kind: "inconsistent", problems: [expect.stringContaining("Matane-Matapédia: the candidates add up to 29623, valid 29746"), expect.stringContaining("party 99275 1042 vs 919")] });
    // off: completeness only
    __setRailsForMutationTesting(["election_qc_capture_integrity"]);
    expect(eqFileRefusal(withParty(s, "8", 1000), EQ_DAY)).toBeNull();
  });
  it("every SYNTHETIC operation but drop and unlist leaves the file consistent with itself", () => {
    for (const ops of [TOP_TIE, PQ_LEADS, PQ_TOP_TIE, { dropRestated: ["842"] }, { votes: [["2467", 13241], ["2311", 2062]] }] as EqOps[]) {
      expect(eqIntegrity(eqSnap(ops)), JSON.stringify(ops).slice(0, 80)).toEqual([]);
    }
    expect(eqSnap({ dropRestated: ["842"] }).ridings_total).toBe("124");
  });
});

describe("Québec seat-margin, PQ-majority and PVQ-seat legs", () => {
  const margin = (label: string, snap: EqSnapshot) => decide("qc_seat_margin", label, snap, { party: PQ, labels: SEAT_MARGIN });
  it("2022 as counted (CAQ 88 to 90 seats, PLQ 21 to 22, PQ 3): Another Party Wins is Yes, every PQ margin bucket No", () => {
    const s = eqSnap();
    const d = margin("Another Party Wins", s);
    expect(d).toMatchObject(YES);
    expect(d.detail).toContain("seats by party number 27:88-90, 6:21-22, 40:11, 8:3, 22:0-1");
    for (const l of SEAT_MARGIN.slice(0, 5)) expect(margin(l, s)).toMatchObject(NO);
    expect(decide("qc_pq_majority", "", s, { party: PQ })).toMatchObject(NO);
    expect(decide("qc_pvq_seat", "", s, { party: "Parti vert du Québec" })).toMatchObject(NO);
  });
  it("SYNTHETIC near-tie for the most seats (CAQ 55 to 57, PLQ 54 to 55): Another Party Wins is unresolved, never No", () => {
    const s = eqSnap(TOP_TIE);
    const d = margin("Another Party Wins", s);
    expect(d).toMatchObject(pending("recount_range"));
    expect(d.detail).toContain("seats by party number 27:55-57, 6:54-55");
    expect(d.detail).toContain("which party has the most seats outright is not settled");
    expect(margin(`${PQ} <10`, s)).toMatchObject(NO); // the PQ's 3 seats are never the most
    // the answer the rail must never give: No in place of unsure
    __setRailsForMutationTesting(["election_qc_leader_settled"]);
    expect(margin("Another Party Wins", s)).toMatchObject(NO);
  });
  it("SYNTHETIC exact tie for the most seats with no riding inside the margin (CAQ 55, PLQ 55): Another Party Wins is unresolved", () => {
    // the near-tie above, with Fabre going to the PLQ and Beauce-Nord to the PCQ, each by a lead widened to 2,000 votes
    const trade: EqOps["trade"] = [{ parties: ["27", "6"], ridings: [...QC_TOP_TIE_RIDINGS, "466"] }, { parties: ["27", "22"], ridings: ["806"] }];
    const s = eqSnap({ trade });
    // the leader and the runner-up of the riding trade votes (EqOps.votes restates their parties' totals)
    const wide = (id: string, lead: number): Array<[string, number]> => {
      const c = [...s.ridings.find((r) => r.id === id)!.candidates].sort((a, b) => Number(b.votes) - Number(a.votes));
      const moved = Math.ceil((lead - (Number(c[0]!.votes) - Number(c[1]!.votes))) / 2);
      return [[c[0]!.id, Number(c[0]!.votes) + moved], [c[1]!.id, Number(c[1]!.votes) - moved]];
    };
    const settled = eqSnap({ trade, votes: [...wide("806", 2000), ...wide("466", 2000)] });
    expect(eqIntegrity(settled)).toEqual([]);
    const d = margin("Another Party Wins", settled);
    expect(d.detail).toContain("0 riding(s) inside the recount margin; seats by party number 27:55, 6:55, 40:11, 8:3, 22:1");
    expect(d).toMatchObject(pending("recount_range"));
    for (const l of SEAT_MARGIN.slice(0, 5)) expect(margin(l, settled)).toMatchObject(NO);
  });
  it("SYNTHETIC with the PQ in the CAQ's place (88 to 90 seats): its margin of 66 to 69 is '40+', Another Party Wins is No, the majority leg Yes", () => {
    const s = eqSnap(PQ_LEADS);
    expect(margin(`${PQ} 40+`, s)).toMatchObject(YES);
    expect(margin(`${PQ} 30-39`, s)).toMatchObject(NO);
    expect(margin("Another Party Wins", s)).toMatchObject(NO);
    expect(decide("qc_pq_majority", "", s, { party: PQ })).toMatchObject(YES);
  });
  it("SYNTHETIC with the PQ not settled as the party with the most seats (PQ 55 to 57, PLQ 54 to 55): its margin legs and Another Party Wins are unresolved", () => {
    const s = eqSnap(PQ_TOP_TIE);
    for (const l of SEAT_MARGIN) expect(margin(l, s)).toMatchObject(pending("recount_range"));
    expect(decide("qc_pq_majority", "", s, { party: PQ })).toMatchObject(NO); // 57 at most, under 64
    __setRailsForMutationTesting(["election_qc_leader_settled"]);
    expect(margin(`${PQ} <10`, s)).toMatchObject(NO);
  });
  it("a seat count whose range crosses the fixed bucket is unresolved (SYNTHETIC: the PVQ within 1% of the leader in Fabre)", () => {
    // Fabre: CAQ 10,912, PLQ 10,606 (306 behind, inside 1% of the 34,697 votes cast); the PLQ's and the PVQ's candidates trade parties
    const near = eqSnap({ trade: [{ parties: ["6", "10"], ridings: ["466"] }] });
    const d = decide("qc_pvq_seat", "", near, { party: "Parti vert du Québec" });
    expect(d).toMatchObject(pending("recount_range"));
    expect(d.detail).toContain("party 10's seat count is between 0 and 1");
  });
});

describe("the Québec seat-margin event lists one party", () => {
  const reg = eqReg();
  it("labels that are the subject party's buckets and Another Party Wins are the event the rail reads", () => {
    expect(seatMarginForeignLabels(SEAT_MARGIN, "8", reg.eq)).toEqual([]);
    const b = eqLeg("qc_seat_margin", "Another Party Wins", { party: PQ, labels: SEAT_MARGIN });
    expect(b.ok && b.market.resolver).toMatchObject({ election: { subject: { id: "8" }, other_leader: true } });
  });
  it("an event that adds a bucket for a second party is refused: Another Party Wins, and every other leg of it", () => {
    const labels = [...SEAT_MARGIN, "Coalition Avenir Québec 10-19"];
    expect(seatMarginForeignLabels(labels, "8", reg.eq)).toEqual(["Coalition Avenir Québec 10-19"]);
    for (const label of ["Another Party Wins", `${PQ} <10`, `${PQ} 40+`]) {
      const b = eqLeg("qc_seat_margin", label, { party: PQ, labels });
      expect(b.ok).toBe(false);
      if (!b.ok) expect(b.reason).toContain('the event lists "Coalition Avenir Québec 10-19", not a seat-margin bucket of party 8 (Parti québécois): "Another Party Wins" means a party the event does not list');
    }
  });
  it("a label that is no bucket, names no party, or has no text is refused too", () => {
    expect(seatMarginForeignLabels([`${PQ} <10`, "Tie", `${PQ} majority`, "Nobody 10-19", `${PQ} 0-9`, null, "  "], "8", reg.eq)).toEqual(["Tie", `${PQ} majority`, "Nobody 10-19", `${PQ} 0-9`, "(a leg without a label)", "(a leg without a label)"]);
    expect(eqLeg("qc_seat_margin", `${PQ} <10`, { party: PQ, labels: [`${PQ} <10`, "Other"] }).ok).toBe(false);
  });
});

describe("the registered condition of an election leg", () => {
  it("says Yes and No come from the final count and that the rail abstains inside its margins, never 'otherwise No'", () => {
    const legs = [eqLeg("qc_seats_pq", "<3", { party: PQ }), eqLeg("qc_seat_margin", "Another Party Wins", { party: PQ, labels: SEAT_MARGIN }), eqLeg("qc_pq_majority", "", { party: PQ })];
    for (const b of legs) {
      if (!b.ok) throw new Error(b.reason);
      expect(b.market.condition).toContain("resolves Yes iff the authority's final count puts this leg's value in the bucket, No iff it puts it in another bucket; a value inside the rail's safety margins, or a count that is not final, stays unresolved. Paraphrased test rules.");
      expect(b.market.condition).not.toMatch(/otherwise no/i);
    }
    const first = legs[0]!;
    expect(first.ok && first.market.condition.startsWith('Leg "<3" of "Test: qc_seats_pq" (Quebec general election 2026, seats won by the PQ (Élections Québec)): resolves Yes iff')).toBe(true);
    // the TSE legs are worded by the same line (turnout needs no candidate registry)
    const tie = "A value exactly between two brackets resolves to the higher bracket.";
    const turnout = buildElectionLeg({ series: "br_pres_r1_turnout", period: "2026-10-04", release_at: "2026-10-04T20:00:00Z", title: "Turnout", criteria: tie, labels: ["75-80%"] }, { external_id: "t", label: "75-80%", open_at: "2026-09-01T00:00:00Z", deadline_utc: "2027-06-30T23:59:00Z" }, {});
    if (!turnout.ok) throw new Error(turnout.reason);
    expect(turnout.market.condition).toContain(`stays unresolved. ${tie}`);
    expect(turnout.market.condition).not.toMatch(/otherwise no/i);
  });
});

// ---- each finality flag, integrity check, registration rule and mapping rule alone (SYNTHETIC edits of saved files) ----

const TSE_FINAL_2022 = "tse_2022_br_c0001_e000544_r_20221004T163422Z.json";
/** SYNTHETIC: a saved TSE file with replacements, each applying exactly once, as the production parser reads it. */
function tseEdited(fixture: string, day: string, ...edits: Array<[string, string]>) {
  let body = fx(fixture);
  for (const [from, to] of edits) { if (body.split(from).length !== 2) throw new Error(`"${from}" is not exactly once in ${fixture}`); body = body.replace(from, to); }
  const p = parseTseResult(body, day);
  if (!p.ok) throw new Error(p.detail);
  return p.snap;
}
const tse2022 = (...edits: Array<[string, string]>) => tseEdited(TSE_FINAL_2022, "2022-10-02", ...edits);

describe("TSE finality: every flag is read, not only tf", () => {
  it("a 2022 national file flagged tf=s is still not final when dv, esae or the sections say so, each alone", () => {
    expect(tseNotFinal(tse2022())).toEqual([]);
    expect(tseNotFinal(tse2022(['"dv" : "s"', '"dv" : "n"']))).toEqual(["dv=n (votes may not be published)"]);
    expect(tseNotFinal(tse2022(['"esae" : "n"', '"esae" : "s"']))).toEqual(["esae=s"]);
    expect(tseNotFinal(tse2022(['"st" : "472075"', '"st" : "472074"']))).toEqual(["472074 of 472075 sections totalized"]);
    expect(tseNotFinal(tse2022(['"snt" : "0"', '"snt" : "1"']))).toEqual(["472075 of 472075 sections totalized"]);
    expect(tseNotFinal(tse2022(['"tf" : "s"', '"tf" : "n"']))).toEqual(["tf=n (final totalization not reached)"]);
  });
  it("the EA20 layout's and flag: and=p (count in progress) is not final although tf=s", () => {
    const sim = (...e: Array<[string, string]>) => tseEdited("tse_sim2026_br_c0001_e021270_u.json", "2026-10-04", ...e);
    expect(sim().flags).toMatchObject({ tf: "s", and: "f", dv: "s", esae: "n" });
    expect(tseNotFinal(sim())).toEqual([]);
    expect(tseNotFinal(sim(['"and" : "f"', '"and" : "p"']))).toEqual(["and=p (count not finished)"]);
  });
});

describe("TSE integrity: each check alone", () => {
  it("names the sub judice total, the total votes, the turnout, the electorate's order and a ballot number listed twice", () => {
    expect(tseIntegrity(tse2022())).toEqual([]);
    expect(tseIntegrity(tse2022(['"vansj" : "0"', '"vansj" : "5"']))).toEqual(["the sub judice candidates add up to 0, the file's sub judice votes are 5", "vvc 118229719 != vv + van + vansj"]);
    expect(tseIntegrity(tse2022(['"vb" : "1964779"', '"vb" : "1964780"']))).toEqual(["tv 123682372 != vvc + vb + tvn"]);
    expect(tseIntegrity(tse2022(['"c" : "123682372"', '"c" : "123682371"']))).toEqual(["turnout 123682371 != total votes 123682372"]);
    expect(tseIntegrity(tse2022(['"esi" : "156453354"', '"esi" : "156454012"']))).toEqual(["electorate 156454011 / installed 156454012 / turnout 123682372 out of order"]);
    expect(tseIntegrity(tse2022(['"esi" : "156453354"', '"esi" : "123682371"']))).toEqual(["electorate 156454011 / installed 123682371 / turnout 123682372 out of order"]);
    // Constituinte Eymael (27) under Soraya Thronicke's ballot number 44: the sums are unchanged
    expect(tseIntegrity(tse2022(['"n" : "27"', '"n" : "44"']))).toEqual(["a ballot number appears twice"]);
  });
});

describe("Élections Québec finality and integrity: each check alone", () => {
  const ridingEdit = (s: EqSnapshot, name: string, f: (r: EqSnapshot["ridings"][number]) => EqSnapshot["ridings"][number]): EqSnapshot => {
    if (s.ridings.filter((r) => r.name === name).length !== 1) throw new Error(`riding ${name}`);
    return { ...s, ridings: s.ridings.map((r) => (r.name === name ? f(r) : r)) };
  };
  it("eqNotFinal reads the file's flag, its riding and polling-station counts, and each riding's flag and polling stations", () => {
    const s = eqSnap();
    expect(eqNotFinal(s)).toEqual([]);
    expect(eqNotFinal({ ...s, final: false })).toEqual(["isResultatsFinaux is false"]);
    expect(eqNotFinal({ ...s, ridings_with_result: "124", ridings_without_result: "1" })).toEqual(["124 of 125 ridings have results"]);
    expect(eqNotFinal({ ...s, ridings_without_result: "1" })).toEqual(["125 of 125 ridings have results"]);
    expect(eqNotFinal({ ...s, polls_done: "21896" })).toEqual(["21896 of 21897 polling stations reported"]);
    expect(eqNotFinal(ridingEdit(s, "Abitibi-Est", (r) => ({ ...r, final: false })))).toEqual(["1 riding(s) not final (Abitibi-Est)"]);
    expect(eqNotFinal(ridingEdit(s, "Abitibi-Est", (r) => ({ ...r, polls_done: "125" })))).toEqual(["1 riding(s) not final (Abitibi-Est)"]);
  });
  it("eqIntegrity names the file's votes cast, its registered electors, a riding's votes cast and a candidate number listed twice in a riding", () => {
    const s = eqSnap();
    expect(eqIntegrity({ ...s, rejected: "56317" })).toEqual(["valid 4112821 + rejected 56317 != cast 4169137"]);
    expect(eqIntegrity({ ...s, registered: "4169136" })).toEqual(["cast 4169137 > registered 4169136"]);
    expect(eqIntegrity(ridingEdit(s, "Abitibi-Est", (r) => ({ ...r, rejected: "405" })))).toEqual(["Abitibi-Est: valid + rejected != cast"]);
    expect(eqIntegrity(ridingEdit(s, "Abitibi-Est", (r) => ({ ...r, candidates: r.candidates.map((c, i) => (i === 1 ? { ...c, id: r.candidates[0]!.id } : c)) })))).toEqual(["Abitibi-Est: a candidate number appears twice"]);
  });
  it("party 0 (the independents) is never ranked as a party: SYNTHETIC 2022 file with every CAQ candidate an independent", () => {
    const s = eqSnap();
    const caq = s.parties.find((x) => x.id === "27")!, ind = s.parties.find((x) => x.id === "0")!;
    const independents: EqSnapshot = {
      ...s,
      ridings: s.ridings.map((r) => ({ ...r, candidates: r.candidates.map((c) => (c.party === "27" ? { ...c, party: "0" } : c)) })),
      parties: s.parties.filter((x) => x.id !== "27").map((x) => (x.id === "0" ? { ...x, votes: String(Number(ind.votes) + Number(caq.votes)) } : x)),
    };
    expect(eqIntegrity(independents)).toEqual([]);
    // the independents hold 88 to 90 seats; the parties: the PLQ 21 to 22, QS 11, the PQ 3
    const d = decide("qc_second_place", "Québec solidaire", independents, { labels: ["Québec solidaire", "Parti libéral du Québec"] });
    expect(d).toMatchObject(YES);
    expect(d.detail).toContain("seats by party number 6:21-22, 40:11, 8:3");
    expect(decide("qc_second_place", "Parti libéral du Québec", independents, { labels: ["Québec solidaire", "Parti libéral du Québec"] })).toMatchObject(NO);
  });
});

describe("TSE configuration: one President first round per election day", () => {
  it("a configuration listing two President first-round elections on the day is drift, never the first of them", () => {
    const cfg = JSON.parse(fx("tse_2022_config_ele-c_20221004T163421Z.json")) as { pl: Array<{ e: Array<{ cd: string; tp: string; t: string }> }> };
    expect(parseTseConfig(JSON.stringify(cfg), "2022-10-02")).toMatchObject({ ok: true, snap: { electionId: "544" } });
    const pres = cfg.pl[0]!.e.find((e) => e.tp === "8" && e.t === "1")!;
    cfg.pl[0]!.e.push({ ...pres, cd: "999" });
    const c = parseTseConfig(JSON.stringify(cfg), "2022-10-02");
    expect(c).toMatchObject({ ok: false, reason: "schema_drift" });
    if (!c.ok) expect(c.detail).toContain("lists 2 President first-round elections dated 02/10/2022");
  });
});

describe("registration: every rule of an election leg", () => {
  type RegInput = Parameters<typeof electionRegistrationIssues>[0];
  const pct = (label: string, lo: number | undefined, hi: number | undefined) => ({ label, ...(lo !== undefined ? { lo } : {}), ...(hi !== undefined ? { hi } : {}), lo_inclusive: true, hi_inclusive: hi === undefined });
  const seats = (label: string, lo: number | undefined, hi: number | undefined) => ({ label, ...(lo !== undefined ? { lo } : {}), ...(hi !== undefined ? { hi } : {}), lo_inclusive: true, hi_inclusive: true });
  const at = (k: number) => ({ label: String(k), lo: k, hi: k, lo_inclusive: true, hi_inclusive: true });
  const valid: Record<string, RegInput> = {
    turnout: { series: "br_pres_r1_turnout", period: "2026-10-04", rounding: "election_exact", bucket: pct("75-80%", 75, 80) },
    share: { series: "br_pres_r1_share_lula", period: "2026-10-04", rounding: "election_exact", bucket: pct("45-50%", 45, 50), election: { subject: { id: "13", name: "LULA" } } },
    rank: { series: "br_pres_r1_third", period: "2026-10-04", rounding: "election_exact", bucket: at(3), election: { subject: { id: "15", name: "SIMONE TEBET" }, listed: ["13", "22", "15"] } },
    riding: { series: "qc_riding_751", period: "2026-10-05", rounding: "election_exact", bucket: at(1), election: { subject: { id: "1", name: "Etienne Grandmont" }, unit: "751" } },
    seats: { series: "qc_seats_caq", period: "2026-10-05", rounding: "election_exact", bucket: seats("80+", 80, undefined), election: { subject: { id: "27", name: "CAQ" } } },
    majority: { series: "qc_pq_majority", period: "2026-10-05", rounding: "election_exact", bucket: { label: "at least 64 of 127 seats", lo: 64, lo_inclusive: true, hi_inclusive: true }, election: { subject: { id: "8", name: "Parti québécois" } } },
    margin: { series: "qc_seat_margin", period: "2026-10-05", rounding: "election_exact", bucket: seats("10-19", 10, 19), election: { subject: { id: "8", name: "Parti québécois" } } },
    other: { series: "qc_seat_margin", period: "2026-10-05", rounding: "election_exact", bucket: seats("Another Party Wins", 1, undefined), election: { subject: { id: "8", name: "Parti québécois" }, other_leader: true } },
  };
  const issues = (base: keyof typeof valid, change: Partial<RegInput>) => electionRegistrationIssues({ ...valid[base]!, ...change });
  const leg = (base: keyof typeof valid, e: Partial<NonNullable<RegInput["election"]>>) => ({ election: { ...valid[base]!.election, ...e } });

  it("the valid registrations pass", () => {
    for (const [k, r] of Object.entries(valid)) expect(electionRegistrationIssues(r), k).toEqual([]);
  });
  it("rounding, prior level and the subject's presence", () => {
    expect(issues("turnout", { rounding: "half_up" })).toEqual(["br_pres_r1_turnout decides from exact counts: rounding must be election_exact"]);
    expect(issues("turnout", { prior_level: 79 })).toEqual(["br_pres_r1_turnout has no prior level"]);
    expect(issues("turnout", { election: { subject: { id: "13", name: "LULA" } } })).toEqual(["br_pres_r1_turnout has no subject"]);
    expect(issues("seats", { election: {} })).toEqual(["qc_seats_caq needs election.subject (the authority's id and name for the leg's party)"]);
  });
  it("the subject must be the series' own party or candidate", () => {
    expect(issues("seats", leg("seats", { subject: { id: "6", name: "PLQ" } }))).toEqual(["qc_seats_caq is about party 27; the leg names 6 (PLQ)"]);
    expect(issues("margin", leg("margin", { subject: { id: "27", name: "CAQ" } }))).toEqual(["qc_seat_margin is about party 8; the leg names 27 (CAQ)"]);
    expect(issues("share", leg("share", { subject: { id: "22", name: "JAIR BOLSONARO" } }))).toEqual(["br_pres_r1_share_lula is about Lula; the leg names JAIR BOLSONARO"]);
    expect(issues("share", leg("share", { subject: { id: "13", name: "LUIZ", full_name: "LUIZ INÁCIO LULA DA SILVA" } }))).toEqual([]); // the civil name names him
  });
  it("a riding leg names its series' riding in the 2026 election; no other leg names a riding", () => {
    expect(issues("riding", leg("riding", { unit: "730" }))).toEqual(["qc_riding_751 is riding 751 (Taschereau) in the 2026-10-05 election; the leg names riding 730"]);
    expect(issues("riding", { period: "2022-10-03", ...leg("riding", { unit: "730" }) })).toEqual([]); // a past election's map (the frozen evals)
    expect(issues("riding", { election: { subject: { id: "1", name: "Etienne Grandmont" } } })).toEqual(["qc_riding_751 needs election.unit (the riding)"]);
    expect(issues("seats", leg("seats", { unit: "751" }))).toEqual(["qc_seats_caq takes no riding"]);
  });
  it("a Brazilian rank leg lists the event's named candidates, its own among them; no other leg lists any", () => {
    expect(issues("rank", leg("rank", { listed: ["13", "22"] }))).toEqual(["br_pres_r1_third: the leg's candidate 15 is not among election.listed"]);
    expect(issues("rank", leg("rank", { listed: [] }))).toEqual(["br_pres_r1_third needs election.listed (every candidate the event names, by TSE number)"]);
    expect(issues("share", leg("share", { listed: ["13"] }))).toEqual(["br_pres_r1_share_lula: election.listed applies to Brazilian rank events only"]);
    expect(issues("seats", leg("seats", { other_leader: true }))).toEqual(["qc_seats_caq: other_leader applies to the seat-margin event only"]);
  });
  it("buckets: a place, a fixed bucket, percentages within 0-100 and not empty, whole seats not empty, a seat margin of at least 1", () => {
    expect(issues("turnout", { bucket: { label: "none", lo_inclusive: true, hi_inclusive: true } })).toEqual(['bucket "none" has neither lo nor hi']);
    expect(issues("rank", { bucket: at(2) })).toEqual(["br_pres_r1_third asks about place 3: the bucket must be [3, 3]"]);
    expect(issues("riding", { bucket: at(2) })).toEqual(["qc_riding_751 asks about place 1: the bucket must be [1, 1]"]);
    expect(issues("majority", { bucket: seats("60+", 60, undefined) })).toEqual(["qc_pq_majority's bucket is fixed by the event: at least 64 of 127 seats"]);
    expect(issues("turnout", { bucket: pct("95-105%", 95, 105) })).toEqual(['bucket "95-105%" is outside 0-100%']);
    expect(issues("turnout", { bucket: pct("80-80%", 80, 80) })).toEqual(['bucket "80-80%" is empty']);
    expect(issues("seats", { bucket: seats("80.5+", 80.5, undefined) })).toEqual(['bucket "80.5+" must count whole seats']);
    expect(issues("seats", { bucket: seats("90-80", 90, 80) })).toEqual(['bucket "90-80" is empty']);
    expect(issues("margin", { bucket: seats("0-9", 0, 9) })).toEqual(['bucket "0-9": a seat margin of 0 is a tie ("Other"), never a leg']);
    expect(issues("margin", { bucket: { label: "<10", hi: 10, lo_inclusive: true, hi_inclusive: false } })).toEqual(['bucket "<10": a seat margin of 0 is a tie ("Other"), never a leg']);
    expect(issues("margin", { bucket: seats("1-9", 1, 9) })).toEqual([]);
  });
});

describe("leg builder: the leg's subject, riding and registry are the series' own", () => {
  const reg2022 = () => { const p = parseTseResult(fx(TSE_FINAL_2022), "2022-10-02"); if (!p.ok) throw new Error(p.detail); return tseRegistryFromSnapshot(p.snap, "https://resultados.tse.jus.br/oficial/ele2022/544/dados-simplificados/br/br-c0001-e000544-r.json", "2022-10-04T16:34:22Z"); };
  const spec = { external_id: "t", open_at: "2022-09-01T00:00:00Z", deadline_utc: "2027-06-30T23:59:00Z" };
  it("a party event's text must name the series' party (the CAQ seats event naming the PLQ, the PQ margin event naming the CAQ)", () => {
    const caq = eqLeg("qc_seats_caq", "20+", { party: "Parti libéral du Québec" });
    expect(caq.ok).toBe(false);
    if (!caq.ok) expect(caq.reason).toBe('"Parti libéral du Québec" maps to party 6 (Parti libéral du Québec/Quebec Liberal Party); qc_seats_caq is about party 27');
    const margin = eqLeg("qc_seat_margin", "Another Party Wins", { party: "Coalition Avenir Québec", labels: ["Coalition Avenir Québec 10-19", "Another Party Wins"] });
    expect(margin.ok).toBe(false);
    if (!margin.ok) expect(margin.reason).toContain("qc_seat_margin is about party 8");
    expect(eqLeg("qc_seats_caq", "20+", { party: "Coalition Avenir Québec" }).ok).toBe(true);
  });
  it("the 2026 riding event takes its own riding code only; a past election's map may name another", () => {
    const s = eqSnap();
    const winner = [...s.ridings.find((r) => r.id === "730")!.candidates].sort((a, b) => Number(b.votes) - Number(a.votes))[0]!.name;
    const y2026 = eqLeg("qc_riding_751", winner, { unit: "730", period: "2026-10-05" });
    expect(y2026.ok).toBe(false);
    if (!y2026.ok) expect(y2026.reason).toBe("riding 730 is not qc_riding_751's riding 751 in the 2026-10-05 election");
    expect(eqLeg("qc_riding_751", winner, { unit: "730" }).ok).toBe(true); // the 2022 map
  });
  it("a TSE registry of another election day is refused for every TSE candidate leg", () => {
    const tie = "A value exactly between two brackets resolves to the higher bracket.";
    const ev = (series: ElectionSeriesId, labels: string[]) => ({ series, period: "2026-10-04", release_at: "2026-10-04T20:00:00Z", title: "t", criteria: tie, labels });
    for (const [series, label] of [["br_pres_r1_winner", "Lula"], ["br_pres_r1_share_lula", "45-50%"], ["br_pres_r1_margin", "Lula 5-7.5%"]] as Array<[ElectionSeriesId, string]>) {
      const b = buildElectionLeg(ev(series, [label]), { ...spec, label }, { tse: reg2022() });
      expect(b, series).toMatchObject({ ok: false, reason: "the TSE registry is for 2022-10-02, the event is 2026-10-04" });
      expect(buildElectionLeg({ ...ev(series, [label]), period: "2022-10-02", release_at: "2022-10-02T20:00:00Z" }, { ...spec, label }, { tse: reg2022() }).ok, series).toBe(true);
    }
  });
  it("a Québec candidate label of one word must be the whole name; two words or more may be words of it", () => {
    const reg = eqReg().eq;
    expect(mapEqCandidate("Etienne Grandmont", "730", reg)).toMatchObject({ ok: true, subject: { id: "2505" } });
    expect(mapEqCandidate("Grandmont", "730", reg)).toMatchObject({ ok: false, reason: '"Grandmont" matches no accepted candidate of riding 730' });
    expect(mapEqCandidate("Etienne", "730", reg).ok).toBe(false);
  });
  it("only the exact label 'Another Party Wins' (any case) is the other-party leg; a longer or shorter label is foreign", () => {
    const reg = eqReg().eq;
    expect(seatMarginForeignLabels(["Another Party Wins", "ANOTHER PARTY WINS", " another party wins "], "8", reg)).toEqual([]);
    expect(seatMarginForeignLabels(["Another Party Wins 10+", "Another party", "Another Party Wins Outright"], "8", reg)).toEqual(["Another Party Wins 10+", "Another party", "Another Party Wins Outright"]);
    // the event's own "Another Party Wins" leg is refused with it
    const b = eqLeg("qc_seat_margin", "Another Party Wins", { party: PQ, labels: [...SEAT_MARGIN, "Another Party Wins 10+"] });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toContain('the event lists "Another Party Wins 10+"');
  });
});

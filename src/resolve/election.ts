/**
 * Election series of the official_release rail: binary legs of platform election events decided in code from the
 * electoral authority's own count (TSE for the Brazilian presidential first round of 2026-10-04, Élections Québec for
 * the Quebec general election of 2026-10-05). The rail stores the FIRST FINAL count once per (series, election day) in
 * official_observations (migration 016; the contest travels in meta.contest) and every leg decides from that row.
 * Jev is never called.
 *
 * What decides (every rule fails closed: a leg that cannot be decided exactly stays UNRESOLVED with a caveat):
 *   - finality (rail election_final_count): TSE f=o, tf=s, and=f (EA20), dv=s, esae=n and every section totalized;
 *     Élections Québec isResultatsFinaux on the file and on every riding, every polling station reported.
 *   - integrity: the file's own totals add up (valid votes = the sum of the valid candidates, and so on).
 *   - completeness (rail election_qc_complete_file): an Élections Québec snapshot lists every riding of the election
 *     exactly once, and the election's riding count comes from the rail's registry (QC_RIDING_COUNT), never from the
 *     file alone; a riding event's stored copy holds exactly its one riding. A file that lost ridings would otherwise
 *     count seats from the ridings present. The capture applies the same check before a read can become the first
 *     print or confirm one (src/ingest/official.ts).
 *   - the subject: the leg names an authority id pinned at registration; it must appear exactly once, under the name
 *     it was registered with, or the leg is an ERROR (SUBJECT_MISMATCH), never a guess.
 *   - robustness (rail election_safety_margin): ranks, shares, margins and seat counts are computed exactly from the
 *     integers, and a leg is decided only when the outcome holds with a safety margin on every side:
 *       TSE ranks: every candidate whose order relative to the subject matters is more than 0.1 percentage point of
 *         the valid votes away (BR_RANK_GAP). The final count moved by ~1,400 votes (0.001 pp) between the md=S and
 *         the tf=s files of 2022 (OBSERVED, Wayback captures of br-c0001-e000544-r.json); re-totalizations after court
 *         rulings are of the same order, so 0.1 pp (about 120,000 votes nationally, 440 in Acre) leaves two orders of
 *         magnitude of headroom.
 *       TSE shares, margins and turnout: more than 0.05 percentage point from every bucket edge (BR_EDGE). The texts do
 *         not say how the "reported value" is rounded; any rounding to 1 or 2 decimals moves a value by at most 0.05 pp,
 *         so outside that distance every reading lands in the same bucket.
 *       TSE annulled sub judice votes: every combination of those candidates being validated or not (at most 2^6) must
 *         give the same outcome with the margins above; candidates annulled for good (dvt Anulado) never count.
 *       Élections Québec ridings: the leader must lead every other candidate by more than 1% of the votes cast in the
 *         riding (QC_RIDING_LEAD). The feed is the preliminary count; the next-day recensement can adjust it and a
 *         judicial recount can be asked below 1/1000 of the votes cast, so 1% is ten times the recount threshold. A
 *         riding inside it can go to any candidate within 1% of the leader; seat counts become ranges and a seat,
 *         rank or margin leg is decided only when the whole range gives the same answer.
 *       Élections Québec party ties on seats are broken by valid votes only when the parties are more than 1% of the
 *         valid votes apart (QC_PARTY_VOTES).
 *   - the platform's two readings of a Brazilian rank event ("the listed candidate" / "the named candidates"): the rank
 *     is computed over all candidates and over the event's named ones; only an agreement decides.
 * Pure: no I/O.
 */
import { z } from "zod";
import type { ElectionSeries, OfficialBucket, ElectionLeg, MarketRegistration } from "./schema";
import type { StructuredDecision } from "./structured";
import { railEnabled } from "./rails";

export type ElectionSeriesId = z.infer<typeof ElectionSeries>;
export type ElectionAuthority = "tse" | "eq";
export type ElectionMeasure = "rank_votes" | "share_valid" | "winner_margin" | "turnout" | "riding_winner" | "seats" | "rank_seats" | "seat_margin";

// ---- registry -----------------------------------------------------------------------------------------------------

export interface ElectionSeriesDef {
  id: ElectionSeriesId;
  authority: ElectionAuthority;
  /** TSE: BR or the UF whose file is read; Élections Québec: QC (one file for the whole election). */
  scope: string;
  measure: ElectionMeasure;
  /** Rank measures: the finishing position the event asks about. */
  rank?: number;
  /** Events with one binary leg whose bucket the text fixes (PQ majority: 64 of 127 seats; PVQ: at least one seat). */
  fixedBucket?: OfficialBucket;
  /** Quebec riding events: the 2026 riding (Élections Québec numeroCirconscription and name). */
  riding?: { code: string; name: string };
  /** Quebec party events: the Élections Québec party number the event is about (the leg's subject must be it). */
  subjectId?: string;
  /** Brazil vote-share events: the candidate the event names (every word must be in the subject's TSE names). */
  subjectHint?: string;
  label: string;
}

export const BR_UF_NAMES = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo",
  GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná",
  PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima",
  SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
} as const;
export type BrUf = keyof typeof BR_UF_NAMES;

/**
 * The 21 ridings with a Polymarket winner event, by 2026 riding code (Élections Québec candidatures.json, OBSERVED
 * https://donnees.electionsquebec.qc.ca/production/provincial/candidatures/candidatures.json 2026-09-27T22:51:18Z,
 * Last-Modified 2026-09-22). Codes changed with the 2026 map (Abitibi-Est 648 -> 689), so the code is never reused
 * across elections; the resolver also checks the riding's name in the results file.
 */
export const QC_RIDINGS = {
  "119": "Saint-François", "137": "Richmond", "141": "Drummond-Bois-Francs", "151": "Nicolet-Bécancour", "179": "Beauharnois",
  "199": "La Prairie", "227": "Montarville", "281": "Saint-Henri-Sainte-Anne", "307": "Laurier-Dorion", "317": "Hochelaga-Maisonneuve",
  "319": "Rosemont", "577": "Groulx", "693": "Maskinongé", "697": "Laviolette-Saint-Maurice", "709": "Louis-Hébert",
  "749": "Vanier-Les Rivières", "751": "Taschereau", "757": "Jean-Lesage", "767": "Charlesbourg", "791": "Lévis", "799": "Côte-du-Sud",
} as const;

/** Élections Québec party numbers (numeroPartiPolitique; candidatures.json afpparp_numero, OBSERVED 2026-09-27). */
export const QC_PARTY = { CAQ: "27", PQ: "8", PLQ: "6", QS: "40", PCQ_CONSERVATEUR: "22", PVQ: "10" } as const;

const rankBucket = (k: number, label: string): OfficialBucket => ({ label, lo: k, hi: k, lo_inclusive: true, hi_inclusive: true });

function buildRegistry(): Record<ElectionSeriesId, ElectionSeriesDef> {
  const out = {} as Record<ElectionSeriesId, ElectionSeriesDef>;
  const put = (d: ElectionSeriesDef) => { out[d.id] = d; };
  for (const [uf, name] of Object.entries(BR_UF_NAMES)) {
    put({ id: `br_pres_r1_first_${uf.toLowerCase()}` as ElectionSeriesId, authority: "tse", scope: uf, measure: "rank_votes", rank: 1, label: `Brazil presidential first round 2026, 1st place by valid votes in ${name} (TSE)` });
  }
  put({ id: "br_pres_r1_winner", authority: "tse", scope: "BR", measure: "rank_votes", rank: 1, label: "Brazil presidential first round 2026, 1st place by valid votes nationally (TSE)" });
  put({ id: "br_pres_r1_third", authority: "tse", scope: "BR", measure: "rank_votes", rank: 3, label: "Brazil presidential first round 2026, 3rd place by valid votes nationally (TSE)" });
  put({ id: "br_pres_r1_fourth", authority: "tse", scope: "BR", measure: "rank_votes", rank: 4, label: "Brazil presidential first round 2026, 4th place by valid votes nationally (TSE)" });
  put({ id: "br_pres_r1_margin", authority: "tse", scope: "BR", measure: "winner_margin", label: "Brazil presidential first round 2026, winner and margin over the runner-up in percentage points of valid votes (TSE)" });
  put({ id: "br_pres_r1_turnout", authority: "tse", scope: "BR", measure: "turnout", label: "Brazil presidential first round 2026, turnout: votes cast over eligible voters (TSE)" });
  const share = (id: ElectionSeriesId, hint: string) => put({ id, authority: "tse", scope: "BR", measure: "share_valid", subjectHint: hint, label: `Brazil presidential first round 2026, ${hint}'s share of valid votes (TSE)` });
  share("br_pres_r1_share_lula", "Lula");
  share("br_pres_r1_share_flavio_bolsonaro", "Flavio Bolsonaro");
  share("br_pres_r1_share_renan_santos", "Renan Santos");
  share("br_pres_r1_share_augusto_cury", "Augusto Cury");
  for (const [code, name] of Object.entries(QC_RIDINGS)) {
    put({ id: `qc_riding_${code}` as ElectionSeriesId, authority: "eq", scope: "QC", measure: "riding_winner", rank: 1, riding: { code, name }, label: `Quebec general election 2026, winner of ${name} (riding ${code}, Élections Québec)` });
  }
  const seats = (id: ElectionSeriesId, party: string, name: string) => put({ id, authority: "eq", scope: "QC", measure: "seats", subjectId: party, label: `Quebec general election 2026, seats won by ${name} (Élections Québec)` });
  seats("qc_seats_caq", QC_PARTY.CAQ, "the CAQ");
  seats("qc_seats_pq", QC_PARTY.PQ, "the PQ");
  seats("qc_seats_plq", QC_PARTY.PLQ, "the PLQ");
  seats("qc_seats_pcq", QC_PARTY.PCQ_CONSERVATEUR, "the Parti conservateur du Québec");
  put({ id: "qc_second_place", authority: "eq", scope: "QC", measure: "rank_seats", rank: 2, label: "Quebec general election 2026, 2nd place by seats (ties: valid votes) (Élections Québec)" });
  put({ id: "qc_third_place", authority: "eq", scope: "QC", measure: "rank_seats", rank: 3, label: "Quebec general election 2026, 3rd place by seats (ties: valid votes) (Élections Québec)" });
  put({ id: "qc_pq_majority", authority: "eq", scope: "QC", measure: "seats", subjectId: QC_PARTY.PQ, fixedBucket: { label: "at least 64 of 127 seats", lo: 64, lo_inclusive: true, hi_inclusive: true }, label: "Quebec general election 2026, the PQ wins at least 64 of 127 seats (Élections Québec)" });
  put({ id: "qc_pvq_seat", authority: "eq", scope: "QC", measure: "seats", subjectId: QC_PARTY.PVQ, fixedBucket: { label: "at least one seat", lo: 1, lo_inclusive: true, hi_inclusive: true }, label: "Quebec general election 2026, the PVQ wins at least one seat (Élections Québec)" });
  put({ id: "qc_seat_margin", authority: "eq", scope: "QC", measure: "seat_margin", subjectId: QC_PARTY.PQ, label: "Quebec general election 2026, the party with the most seats and its seat margin over the second (Élections Québec)" });
  return out;
}

export const ELECTION_SERIES: Record<ElectionSeriesId, ElectionSeriesDef> = buildRegistry();

export function isElectionSeries(s: string): s is ElectionSeriesId { return Object.prototype.hasOwnProperty.call(ELECTION_SERIES, s); }

/**
 * The elections the rail is registered for. polls_close is release_at: nothing is fetched before it and a file whose
 * own timestamp precedes it (a simulation, the previous election) never decides.
 */
export interface ElectionEvent { authority: ElectionAuthority; day: string; polls_close: string; basis: string; ridings?: number }
/**
 * Ridings of each Quebec general election the rail reads, by election day: the number of circonscriptions a results file
 * of that election must list, each once. 2026-10-05: 127 (liste_circonscriptions2026.csv and candidatures.json, OBSERVED
 * 2026-09-27; the Polymarket texts say "all 127 seats of the National Assembly"). 2022-10-03: 125 (the Élections Québec
 * archive of that election, read by the frozen cases). An election day that is not here decides nothing.
 */
export const QC_RIDING_COUNT: Readonly<Record<string, number>> = { "2022-10-03": 125, "2026-10-05": 127 };
export function eqExpectedRidings(day: string): number | undefined { return Object.prototype.hasOwnProperty.call(QC_RIDING_COUNT, day) ? QC_RIDING_COUNT[day] : undefined; }
export const ELECTION_EVENTS: ElectionEvent[] = [
  { authority: "tse", day: "2026-10-04", polls_close: "2026-10-04T20:00:00Z", basis: "Brazil general election, first round, Sunday 2026-10-04; polls close 17:00 Brasília time (UTC-3) in every time zone (national hours since 2022; UNVERIFIED for 2026: every TSE host answered 403 from here, 2026-09-27T22:48Z..23:34Z); the TSE publishes no President totals before (dv flag)" },
  { authority: "eq", day: "2026-10-05", polls_close: "2026-10-06T00:00:00Z", ridings: QC_RIDING_COUNT["2026-10-05"]!, basis: "Quebec general election Monday 2026-10-05; results published from 20:00 EDT (OBSERVED https://www.dgeq.org/ 2026-09-27T22:46Z: files update after 20:00 every 2-5 minutes); 127 ridings (liste_circonscriptions2026.csv, candidatures.json)" },
];
export function electionEvent(authority: ElectionAuthority, day: string): ElectionEvent | undefined { return ELECTION_EVENTS.find((e) => e.authority === authority && e.day === day); }

// ---- safety margins ----------------------------------------------------------------------------------------------

/** A rank gap counts only when larger than this share of the valid votes (0.1 percentage point). */
export const BR_RANK_GAP = { num: 1n, den: 1000n } as const;
/** A share, margin or turnout decides only when farther than this from every bucket edge, in percentage points. */
export const BR_EDGE_PP = { num: 5n, den: 100n } as const;
/** A riding leader counts only when ahead of every other candidate by more than this share of the votes cast (1%). */
export const QC_RIDING_LEAD = { num: 1n, den: 100n } as const;
/** A tie on seats is broken by valid votes only when the parties are more than this share of the valid votes apart (1%). */
export const QC_PARTY_VOTES = { num: 1n, den: 100n } as const;
/** More annulled sub judice candidates than this: never decided (2^6 validation combinations are checked). */
export const MAX_SUB_JUDICE = 6;

// ---- the contest snapshot (stored with the first final count) ----------------------------------------------------

const iso = z.iso.datetime({ offset: true });
const Int = z.string().regex(/^\d{1,12}$/, "a non-negative integer as decimal text");
const Id = z.string().regex(/^\d{1,9}$/);

export const TseCandidate = z.object({
  /** The ballot number (TSE n). */
  id: Id,
  /** The ballot name (nome de urna: EA20 nmu, the 2022 simplified file's nm). */
  name: z.string().min(1).max(200),
  /** The civil name when the file carries both (EA20 nm). */
  full_name: z.string().max(300).nullable(),
  /** dvt: Válido -> valid; Anulado -> annulled; Anulado sub judice -> sub_judice; anything else, including "Válido (legenda)", -> other, which the resolver refuses (vote_status_unknown). */
  status: z.enum(["valid", "annulled", "sub_judice", "other"]),
  status_text: z.string().max(60),
  votes: Int,
});
export type TseCandidate = z.infer<typeof TseCandidate>;

export const TseSnapshot = z.object({
  authority: z.literal("tse"),
  layout: z.enum(["ea20", "simplificado_2022"]),
  /** f: o = official results, s = simulation. */
  environment: z.string().max(4),
  election_id: Id,
  /** The pleito's date in the results configuration (ele-c.json pl.dt), as YYYY-MM-DD. */
  election_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** br or the UF, upper case. */
  scope: z.string().regex(/^[A-Z]{2}$/),
  /** Office code (1 = President) and round (t). */
  office: z.string().max(4),
  round: z.string().max(2),
  /** dt/ht: the last totalization, Brasília time. */
  as_of: iso,
  /** dg/hg: when the file was generated. */
  generated_at: iso,
  flags: z.object({ tf: z.string().max(2), and: z.string().max(2).nullable(), dv: z.string().max(2), esae: z.string().max(2), md: z.string().max(2).nullable() }),
  sections: z.object({ total: Int, totalized: Int, not_totalized: Int }),
  /** te (eligible voters: eleitorado apto), esi (in installed sections), c (turnout: comparecimento). */
  electorate: Int,
  electorate_installed: Int,
  turnout: Int,
  /** vv, van, vansj, vb, tvn, tv and vvc (nominal votes counted: valid + annulled + sub judice). */
  votes: z.object({ valid: Int, annulled: Int, sub_judice: Int, blank: Int, null: Int, total: Int, counted: Int }),
  candidates: z.array(TseCandidate).min(1).max(60),
});
export type TseSnapshot = z.infer<typeof TseSnapshot>;

export const EqCandidate = z.object({ id: Id, name: z.string().min(1).max(200), party: z.string().regex(/^\d{1,9}$/), votes: Int });
export const EqRiding = z.object({
  id: Id, name: z.string().min(1).max(200), final: z.boolean(), polls_done: Int, polls_total: Int,
  valid: Int, rejected: Int, cast: Int, candidates: z.array(EqCandidate).min(1).max(40),
});
export type EqRiding = z.infer<typeof EqRiding>;
export const EqSnapshot = z.object({
  authority: z.literal("eq"),
  /** statistiques.iso8601DateMAJ. */
  as_of: iso,
  final: z.boolean(),
  ridings_total: Int, ridings_with_result: Int, ridings_without_result: Int,
  polls_total: Int, polls_done: Int,
  registered: Int, cast: Int, valid: Int, rejected: Int,
  parties: z.array(z.object({ id: z.string().regex(/^\d{1,9}$/), abbr: z.string().max(60), name: z.string().max(200), votes: Int })).max(80),
  ridings: z.array(EqRiding).min(1).max(200),
});
export type EqSnapshot = z.infer<typeof EqSnapshot>;

export const ElectionSnapshot = z.discriminatedUnion("authority", [TseSnapshot, EqSnapshot]);
export type ElectionSnapshot = z.infer<typeof ElectionSnapshot>;

/** The snapshot in its schema's key order (zod rebuilds objects in shape order), so a jsonb round trip keeps its bytes. */
export function canonicalSnapshot(s: unknown): ElectionSnapshot | null {
  const p = ElectionSnapshot.safeParse(s);
  return p.success ? p.data : null;
}

/**
 * The part of a snapshot a series stores: a Quebec riding event keeps the file-wide totals and flags and its own riding
 * (every other riding is irrelevant to it); every other series keeps the whole snapshot.
 */
export function snapshotForSeries(series: ElectionSeriesId, s: ElectionSnapshot): ElectionSnapshot {
  const def = ELECTION_SERIES[series];
  if (s.authority !== "eq" || def.measure !== "riding_winner" || !def.riding) return s;
  const code = def.riding.code;
  const own = s.ridings.filter((r) => r.id === code);
  return own.length ? { ...s, ridings: own } : s;
}

// ---- names ---------------------------------------------------------------------------------------------------------

/** Lower case, accents and punctuation removed, words separated by one space ("Flávio" = "FLAVIO", "D&apos;AVILA" = "d avila"). */
export function normName(s: string): string {
  return s.replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
export const nameTokens = (s: string): string[] => normName(s).split(" ").filter(Boolean);
/** Every word of a is a word of b. */
export const tokensWithin = (a: string, b: string): boolean => { const B = new Set(nameTokens(b)); const A = nameTokens(a); return A.length > 0 && A.every((t) => B.has(t)); };
/** The registered name and the file's name are the same person: equal, or one's words all within the other's. */
export const namesAgree = (a: string, b: string): boolean => normName(a) === normName(b) || tokensWithin(a, b) || tokensWithin(b, a);

// ---- exact arithmetic -------------------------------------------------------------------------------------------

interface Q { num: bigint; den: bigint }
const big = (s: string) => BigInt(s);
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const abs = (x: bigint) => (x < 0n ? -x : x);
/** A bucket bound (a finite JS number such as 5, 38.5 or 0.25) as an exact fraction. */
function q(x: number): Q {
  const s = x.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const [i, f = ""] = s.split(".");
  return { num: BigInt(i! + f), den: 10n ** BigInt(f.length) };
}
const pct = (a: bigint, b: bigint): Q => ({ num: 100n * a, den: b });
const cmp = (a: Q, b: Q): number => { const d = a.num * b.den - b.num * a.den; return d === 0n ? 0 : d > 0n ? 1 : -1; };
/** |a - b| > e (all in the same unit). */
const farther = (a: Q, b: Q, e: Q): boolean => abs(a.num * b.den - b.num * a.den) * e.den > e.num * a.den * b.den;
const show = (x: Q, dp = 4) => { const s = (x.num * 10n ** BigInt(dp)) / x.den; const t = s.toString().padStart(dp + 1, "0"); return `${t.slice(0, -dp)}.${t.slice(-dp)}`; };

/** Does the bucket contain the value, and is the value farther than `edge` from each of its finite bounds? */
function inBucket(v: Q, b: OfficialBucket): boolean {
  if (b.lo !== undefined) { const c = cmp(v, q(b.lo)); if (b.lo_inclusive ? c < 0 : c <= 0) return false; }
  if (b.hi !== undefined) { const c = cmp(v, q(b.hi)); if (b.hi_inclusive ? c > 0 : c >= 0) return false; }
  return true;
}
function nearEdge(v: Q, b: OfficialBucket, edge: Q): number | null {
  for (const x of [b.lo, b.hi]) if (x !== undefined && !farther(v, q(x), edge)) return x;
  return null;
}

type Tri = { v: "yes" } | { v: "no" } | { v: "unsure"; caveat: string; why: string };
const YES: Tri = { v: "yes" };
const NO: Tri = { v: "no" };
const unsure = (caveat: string, why: string): Tri => ({ v: "unsure", caveat, why });

function bucketTri(v: Q, b: OfficialBucket, edge: Q, what: string): Tri {
  const e = nearEdge(v, b, edge);
  if (e !== null) return unsure("near_bucket_edge", `${what} ${show(v)}% is within ${show(edge, 2)} pp of the bucket edge ${e}%`);
  return inBucket(v, b) ? YES : NO;
}

/** The integer bucket [lo, hi] a seat bucket holds (exclusive bounds moved inward). */
function intBucket(b: OfficialBucket): { lo: number; hi: number } {
  const lo = b.lo === undefined ? -Infinity : b.lo_inclusive ? Math.ceil(b.lo) : Math.floor(b.lo) + 1;
  const hi = b.hi === undefined ? Infinity : b.hi_inclusive ? Math.floor(b.hi) : Math.ceil(b.hi) - 1;
  return { lo, hi };
}
function rangeTri(min: number, max: number, b: OfficialBucket, what: string): Tri {
  const { lo, hi } = intBucket(b);
  if (min >= lo && max <= hi) return YES;
  if (max < lo || min > hi) return NO;
  return unsure("recount_range", `${what} is ${min === max ? min : `between ${min} and ${max}`} once ridings inside the recount margin can go either way; the bucket "${b.label}" is not settled`);
}

/** Finishing position of x among others: [best, worst], where only a clear gap orders two candidates. */
function rankRange(x: bigint, others: bigint[], clearly: (a: bigint, b: bigint) => boolean): { best: number; worst: number } {
  let above = 0, notBelow = 0;
  for (const o of others) { if (clearly(o, x)) above++; if (!clearly(x, o)) notBelow++; }
  return { best: 1 + above, worst: 1 + notBelow };
}

// ---- decisions ------------------------------------------------------------------------------------------------------

type Option = "OPTION_A" | "OPTION_B";
const flip = (o: Option): Option => (o === "OPTION_A" ? "OPTION_B" : "OPTION_A");
const unresolvedD = (caveat: string, detail: string): StructuredDecision => ({ status: "UNRESOLVED", outcome: "NONE", caveats: [caveat], detail });
const mismatch = (detail: string): StructuredDecision => ({ status: "ERROR", outcome: "NONE", error_code: "SOURCE_MISMATCH", error_reason: "SUBJECT_MISMATCH", caveats: [], detail });

/** Why a TSE file is not the final count, or [] (the authority's own flags; nothing is inferred). */
export function tseNotFinal(s: TseSnapshot): string[] {
  const p: string[] = [];
  if (s.flags.tf !== "s") p.push(`tf=${s.flags.tf} (final totalization not reached)`);
  if (s.flags.and !== null && s.flags.and !== "f") p.push(`and=${s.flags.and} (count not finished)`);
  if (s.flags.dv !== "s") p.push(`dv=${s.flags.dv} (votes may not be published)`);
  if (s.flags.esae !== "n") p.push(`esae=${s.flags.esae}`);
  if (s.sections.not_totalized !== "0" || s.sections.totalized !== s.sections.total) p.push(`${s.sections.totalized} of ${s.sections.total} sections totalized`);
  return p;
}

/** Arithmetic the TSE file must satisfy before any of its numbers decide ([] = consistent). */
export function tseIntegrity(s: TseSnapshot): string[] {
  const p: string[] = [];
  const v = s.votes;
  const of = (st: TseCandidate["status"]) => sum(s.candidates.filter((c) => c.status === st).map((c) => big(c.votes)));
  if (of("valid") !== big(v.valid)) p.push(`the valid candidates add up to ${of("valid")}, the file's valid votes are ${v.valid}`);
  if (of("sub_judice") !== big(v.sub_judice)) p.push(`the sub judice candidates add up to ${of("sub_judice")}, the file's sub judice votes are ${v.sub_judice}`);
  if (big(v.counted) !== big(v.valid) + big(v.annulled) + big(v.sub_judice)) p.push(`vvc ${v.counted} != vv + van + vansj`);
  if (big(v.total) !== big(v.counted) + big(v.blank) + big(v.null)) p.push(`tv ${v.total} != vvc + vb + tvn`);
  if (big(s.turnout) !== big(v.total)) p.push(`turnout ${s.turnout} != total votes ${v.total}`);
  if (big(s.electorate_installed) > big(s.electorate) || big(s.turnout) > big(s.electorate_installed)) p.push(`electorate ${s.electorate} / installed ${s.electorate_installed} / turnout ${s.turnout} out of order`);
  if (new Set(s.candidates.map((c) => c.id)).size !== s.candidates.length) p.push("a ballot number appears twice");
  return p;
}

export function eqNotFinal(s: EqSnapshot): string[] {
  const p: string[] = [];
  if (!s.final) p.push("isResultatsFinaux is false");
  if (s.ridings_without_result !== "0" || s.ridings_with_result !== s.ridings_total) p.push(`${s.ridings_with_result} of ${s.ridings_total} ridings have results`);
  if (s.polls_done !== s.polls_total) p.push(`${s.polls_done} of ${s.polls_total} polling stations reported`);
  const open = s.ridings.filter((r) => !r.final || r.polls_done !== r.polls_total);
  if (open.length) p.push(`${open.length} riding(s) not final (${open.slice(0, 3).map((r) => r.name).join(", ")})`);
  return p;
}

export function eqIntegrity(s: EqSnapshot): string[] {
  const p: string[] = [];
  if (big(s.valid) + big(s.rejected) !== big(s.cast)) p.push(`valid ${s.valid} + rejected ${s.rejected} != cast ${s.cast}`);
  if (big(s.cast) > big(s.registered)) p.push(`cast ${s.cast} > registered ${s.registered}`);
  const full = big(s.ridings_total) === BigInt(s.ridings.length);
  for (const r of s.ridings) {
    const cand = sum(r.candidates.map((c) => big(c.votes)));
    if (cand !== big(r.valid)) p.push(`${r.name}: the candidates add up to ${cand}, valid ${r.valid}`);
    if (big(r.valid) + big(r.rejected) !== big(r.cast)) p.push(`${r.name}: valid + rejected != cast`);
    if (new Set(r.candidates.map((c) => c.id)).size !== r.candidates.length) p.push(`${r.name}: a candidate number appears twice`);
  }
  // a riding-event copy keeps one riding; the whole-file totals are checked when every riding is there (eqCompleteness
  // refuses every snapshot that is neither)
  if (full) {
    if (sum(s.ridings.map((r) => big(r.cast))) !== big(s.cast)) p.push("the ridings' votes cast do not add up to the file's");
    if (sum(s.ridings.map((r) => big(r.valid))) !== big(s.valid)) p.push("the ridings' valid votes do not add up to the file's");
  }
  return p.slice(0, 5);
}

/**
 * Does the snapshot hold every riding of the election, each once ([] = complete)? expected: the election's riding count
 * from the rail's registry (eqExpectedRidings), so a file that dropped ridings and restated its own nbCirconscription
 * is still refused. copyOf: the riding of a riding event, whose stored copy (snapshotForSeries) is exactly that one
 * riding beside the file-wide statistics; every other snapshot, and a riding event's that is not such a copy, must be
 * the whole file. The finality and integrity checks cannot see a missing riding: the first reads the file-wide
 * statistics and the ridings present, the second adds up the ridings present.
 */
export function eqCompleteness(s: EqSnapshot, expected: number | undefined, copyOf?: string): string[] {
  const p: string[] = [];
  if (expected === undefined) p.push("the rail has no riding count for this election day, so a missing riding could not be told");
  else if (Number(s.ridings_total) !== expected) p.push(`the file states ${s.ridings_total} ridings; the election has ${expected} (another election's file, or a partial one)`);
  if (copyOf !== undefined && s.ridings.length === 1) {
    const r = s.ridings[0]!;
    if (r.id !== copyOf) p.push(`the riding copy holds riding ${r.id} (${r.name}), not riding ${copyOf}`);
    return p;
  }
  if (BigInt(s.ridings.length) !== big(s.ridings_total)) {
    p.push(copyOf !== undefined
      ? `the snapshot holds ${s.ridings.length} ridings: neither riding ${copyOf} alone nor all ${s.ridings_total}`
      : `the file lists ${s.ridings.length} of its ${s.ridings_total} ridings`);
  }
  const seen = new Set<string>(), twice = new Set<string>();
  for (const r of s.ridings) { if (seen.has(r.id)) twice.add(r.id); seen.add(r.id); }
  if (twice.size) p.push(`riding ${[...twice].slice(0, 3).join(", ")} is listed more than once`);
  return p;
}

interface Ctx { r: LegResolver; positive: Option; margin: boolean }
/** The resolver fields an election leg decides from (a structural subset of the official_release resolver). */
export interface LegResolver { series: string; period: string; bucket: OfficialBucket; election?: ElectionLeg }

function finish(results: Tri[], ctx: Ctx, detail: string, caveats: string[]): StructuredDecision {
  const bad = results.find((t): t is Extract<Tri, { v: "unsure" }> => t.v === "unsure");
  if (bad) return unresolvedD(bad.caveat, `${detail}: ${bad.why}`);
  const yes = results.every((t) => t.v === "yes"), no = results.every((t) => t.v === "no");
  if (!yes && !no) return unresolvedD("sub_judice_votes", `${detail}: the outcome depends on whether annulled sub judice votes are validated`);
  return { status: "RESOLVED", outcome: yes ? ctx.positive : flip(ctx.positive), caveats, detail: `${detail}: ${yes ? "Yes" : "No"}` };
}

function subsets<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let m = 0; m < 1 << xs.length; m++) out.push(xs.filter((_, i) => (m >> i) & 1));
  return out;
}

function decideTse(def: ElectionSeriesDef, s: TseSnapshot, ctx: Ctx, caveats: string[]): StructuredDecision {
  const leg = ctx.r.election ?? {};
  if (s.scope !== def.scope) return mismatch(`the file is the ${s.scope} count; ${def.id} reads ${def.scope}`);
  if (s.office !== "1" || s.round !== "1") return mismatch(`the file is office ${s.office} round ${s.round}; ${def.id} is the President, first round`);
  if (s.environment.toLowerCase() !== "o") return unresolvedD("awaiting_release", `the TSE file is from the ${s.environment === "s" ? "simulation" : `"${s.environment}"`} environment, never a result`);
  if (railEnabled("election_final_count")) {
    const nf = tseNotFinal(s);
    if (nf.length) return unresolvedD("count_not_final", `TSE ${s.scope} count not final: ${nf.join("; ")}`);
  }
  const bad = tseIntegrity(s);
  if (bad.length) return unresolvedD("totals_inconsistent", `TSE ${s.scope} file: ${bad.join("; ")}`);
  const unknown = s.candidates.filter((c) => c.status === "other");
  if (unknown.length) return unresolvedD("vote_status_unknown", `vote destination ${unknown.map((c) => `"${c.status_text}" (${c.id})`).join(", ")} is not one the rail reads`);

  let subject: TseCandidate | null = null;
  if (def.measure !== "turnout") {
    const sub = leg.subject;
    if (!sub) return mismatch(`${def.id} needs the leg's candidate`);
    const hits = s.candidates.filter((c) => c.id === sub.id);
    if (hits.length !== 1) return mismatch(`TSE candidate ${sub.id} (${sub.name}) is ${hits.length ? "listed twice" : "not"} in the ${s.scope} count`);
    if (!namesAgree(sub.name, hits[0]!.name)) return mismatch(`TSE candidate ${sub.id} is "${hits[0]!.name}" in the file, registered as "${sub.name}"`);
    subject = hits[0]!;
  }

  const margin = ctx.margin;
  const edge: Q = margin ? BR_EDGE_PP : { num: 0n, den: 1n };
  if (def.measure === "turnout") {
    // votes cast over eligible voters (te); TSE's own pc is over the voters of installed sections (esi): both must agree
    const a = pct(big(s.turnout), big(s.electorate)), b = pct(big(s.turnout), big(s.electorate_installed));
    if (big(s.electorate_installed) === 0n) return unresolvedD("totals_inconsistent", "no installed sections");
    const ta = bucketTri(a, ctx.r.bucket, edge, "turnout over eligible voters"), tb = bucketTri(b, ctx.r.bucket, edge, "turnout over voters of installed sections");
    const detail = `TSE ${s.scope} turnout ${s.turnout} of ${s.electorate} eligible (${show(a)}%), ${s.electorate_installed} in installed sections (${show(b)}%); bucket "${ctx.r.bucket.label}"`;
    if (railEnabled("election_br_turnout_agree") && ta.v !== "unsure" && tb.v !== "unsure" && ta.v !== tb.v) return unresolvedD("turnout_definitions_disagree", `${detail}: the two denominators fall in different buckets`);
    return finish([ta, tb], ctx, detail, caveats);
  }

  const sj = s.candidates.filter((c) => c.status === "sub_judice" && big(c.votes) > 0n);
  if (margin && sj.length > MAX_SUB_JUDICE) return unresolvedD("sub_judice_votes", `${sj.length} candidates have annulled sub judice votes`);
  const scenarios = margin && railEnabled("election_sub_judice") ? subsets(sj) : [[]];
  const x = subject!;
  const listed = leg.listed ? new Set(leg.listed) : null;
  const results = scenarios.map((S) => {
    const valid = s.candidates.filter((c) => c.status === "valid" || S.includes(c));
    const VV = big(s.votes.valid) + sum(S.map((c) => big(c.votes)));
    if (VV === 0n) return unsure("no_valid_votes", "no valid votes");
    const clearly = (a: bigint, b: bigint) => (margin ? (a - b) * BR_RANK_GAP.den > VV * BR_RANK_GAP.num : a > b);
    const vx = valid.includes(x) ? big(x.votes) : 0n;
    const others = valid.filter((c) => c !== x);
    switch (def.measure) {
      case "rank_votes": {
        const k = def.rank!;
        const all = rankRange(vx, others.map((c) => big(c.votes)), clearly);
        const named = listed ? rankRange(vx, others.filter((c) => listed.has(c.id)).map((c) => big(c.votes)), clearly) : null;
        const yesA = all.best === k && all.worst === k, noA = k < all.best || k > all.worst;
        const yesN = !named || (named.best === k && named.worst === k), noN = !named || k < named.best || k > named.worst;
        if (yesA && yesN) return YES;
        if (noA && noN) return NO;
        const where = `${x.name} (${x.id}) ${vx} votes: rank ${all.best === all.worst ? all.best : `${all.best}-${all.worst}`} of all candidates${named ? `, ${named.best === named.worst ? named.best : `${named.best}-${named.worst}`} of the named ones` : ""}`;
        if ((yesA && noN) || (noA && yesN)) return unsure("unlisted_candidate_in_contention", `${where}: a candidate the event does not name is in contention for place ${k}, so its two readings differ`);
        return unsure("near_tie", `${where}: another candidate is within ${margin ? "0.1 pp of the valid votes" : "0 votes"} around place ${k}`);
      }
      case "share_valid":
        return bucketTri(pct(vx, VV), ctx.r.bucket, edge, `${x.name}'s share of valid votes`);
      case "winner_margin": {
        const first = rankRange(vx, others.map((c) => big(c.votes)), clearly);
        if (first.best > 1) return NO;
        if (first.worst !== 1) return unsure("near_tie", `${x.name} (${x.id}) is within ${margin ? "0.1 pp" : "0 votes"} of another candidate for first place`);
        const second = others.reduce((m, c) => (big(c.votes) > m ? big(c.votes) : m), 0n);
        return bucketTri(pct(vx - second, VV), ctx.r.bucket, edge, `${x.name}'s margin over the runner-up`);
      }
      default: return unsure("measure_mismatch", `${def.measure} is not a TSE measure`);
    }
  });
  const top = [...s.candidates].filter((c) => c.status === "valid").sort((a, b) => (big(b.votes) > big(a.votes) ? 1 : big(b.votes) < big(a.votes) ? -1 : 0)).slice(0, 4);
  const detail = `TSE ${s.scope} first round, final count (${s.as_of}; ${s.votes.valid} valid votes; leading ${top.map((c) => `${c.name} ${c.votes}`).join(", ")})${sj.length ? `; ${sj.length} candidate(s) with annulled sub judice votes checked both ways` : ""}; leg "${ctx.r.bucket.label}" for ${x.name} (${x.id})`;
  return finish(results, ctx, detail, caveats);
}

/** The candidates who could win a riding: the leader and everyone not clearly behind the leader. */
function possibleWinners(r: EqRiding, margin: boolean): EqRiding["candidates"] {
  const lead = r.candidates.reduce((m, c) => (big(c.votes) > m ? big(c.votes) : m), 0n);
  const cast = big(r.cast);
  return r.candidates.filter((c) => { const gap = lead - big(c.votes); return margin && railEnabled("election_qc_riding_lead") ? gap * QC_RIDING_LEAD.den <= cast * QC_RIDING_LEAD.num : gap === 0n; });
}

interface SeatRanges { min: Map<string, number>; max: Map<string, number>; votes: Map<string, bigint>; parties: string[]; open: number }
function seatRanges(s: EqSnapshot, margin: boolean): SeatRanges {
  const min = new Map<string, number>(), max = new Map<string, number>(), votes = new Map<string, bigint>();
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  let open = 0;
  for (const r of s.ridings) {
    for (const c of r.candidates) votes.set(c.party, (votes.get(c.party) ?? 0n) + big(c.votes));
    const w = possibleWinners(r, margin);
    if (w.length === 1) inc(min, w[0]!.party); else open++;
    for (const p of new Set(w.map((c) => c.party))) inc(max, p);
  }
  // party 0 is every independent candidate: never a party
  const parties = [...votes.keys()].filter((p) => p !== "0").sort();
  return { min, max, votes, parties, open };
}

function decideEq(def: ElectionSeriesDef, s: EqSnapshot, ctx: Ctx, caveats: string[]): StructuredDecision {
  const leg = ctx.r.election ?? {};
  if (railEnabled("election_final_count")) {
    const nf = eqNotFinal(s);
    if (nf.length) return unresolvedD("count_not_final", `Élections Québec count not final: ${nf.join("; ")}`);
  }
  if (railEnabled("election_qc_complete_file")) {
    const gaps = eqCompleteness(s, eqExpectedRidings(ctx.r.period), def.measure === "riding_winner" ? (leg.unit ?? def.riding?.code) : undefined);
    if (gaps.length) return unresolvedD("totals_inconsistent", `Élections Québec snapshot for the ${ctx.r.period} election is not every riding once: ${gaps.join("; ")}`);
  }
  const bad = eqIntegrity(s);
  if (bad.length) return unresolvedD("totals_inconsistent", `Élections Québec file: ${bad.join("; ")}`);
  const margin = ctx.margin;
  const head = `Élections Québec count of ${s.as_of} (every riding final; ${s.ridings_total} ridings; ${s.cast} votes cast)`;

  if (def.measure === "riding_winner") {
    const sub = leg.subject, unit = leg.unit;
    if (!sub || !unit) return mismatch(`${def.id} needs the leg's candidate and riding`);
    const rs = s.ridings.filter((r) => r.id === unit);
    if (rs.length !== 1) return mismatch(`riding ${unit} is ${rs.length ? "listed twice" : "not"} in the file`);
    const r = rs[0]!;
    if (def.riding && normName(r.name) !== normName(def.riding.name)) return mismatch(`riding ${unit} is "${r.name}" in the file; ${def.id} is ${def.riding.name}`);
    const cs = r.candidates.filter((c) => c.id === sub.id);
    if (cs.length !== 1) return mismatch(`candidate ${sub.id} (${sub.name}) is ${cs.length ? "listed twice" : "not"} in ${r.name}`);
    if (!namesAgree(sub.name, cs[0]!.name)) return mismatch(`candidate ${sub.id} is "${cs[0]!.name}" in the file, registered as "${sub.name}"`);
    const w = possibleWinners(r, margin);
    const lead = [...r.candidates].sort((a, b) => (big(b.votes) > big(a.votes) ? 1 : -1));
    const detail = `${head}; ${r.name}: ${lead.slice(0, 3).map((c) => `${c.name} ${c.votes}`).join(", ")} of ${r.cast} cast; leg ${sub.name} (${sub.id})`;
    const t: Tri = w.length === 1 && w[0]!.id === sub.id ? YES : !w.some((c) => c.id === sub.id) ? NO
      : unsure("recount_range", `the leader's lead is not more than ${margin ? "1% of the votes cast" : "0 votes"} (${w.map((c) => c.name).join(" vs ")})`);
    return finish([t], ctx, detail, caveats);
  }

  const R = seatRanges(s, margin);
  const lo = (p: string) => R.min.get(p) ?? 0, hi = (p: string) => R.max.get(p) ?? 0;
  const range = (p: string) => (lo(p) === hi(p) ? `${lo(p)}` : `${lo(p)}-${hi(p)}`);
  const sub = leg.subject;
  if (!sub) return mismatch(`${def.id} needs the leg's party`);
  if (!R.votes.has(sub.id)) return mismatch(`party ${sub.id} (${sub.name}) has no candidate in the file`);
  const p = sub.id;
  const board = R.parties.filter((x) => hi(x) > 0).sort((a, b) => hi(b) - hi(a)).slice(0, 5).map((x) => `${x}:${range(x)}`).join(", ");
  const detail = `${head}; ${R.open} riding(s) inside the recount margin; seats by party number ${board}; leg "${ctx.r.bucket.label}" for party ${p} (${sub.name})`;
  const votesClearly = (a: string, b: string) => { const d = (R.votes.get(a) ?? 0n) - (R.votes.get(b) ?? 0n); return margin && railEnabled("election_qc_party_votes") ? d * QC_PARTY_VOTES.den > big(s.valid) * QC_PARTY_VOTES.num : d > 0n; };
  const above = (a: string, b: string) => lo(a) > hi(b) || (lo(a) >= hi(b) && votesClearly(a, b));

  switch (def.measure) {
    case "seats": return finish([rangeTri(lo(p), hi(p), def.fixedBucket ?? ctx.r.bucket, `party ${p}'s seat count`)], ctx, detail, caveats);
    case "rank_seats": {
      const k = def.rank!;
      const others = R.parties.filter((x) => x !== p);
      const best = 1 + others.filter((x) => above(x, p)).length, worst = 1 + others.filter((x) => !above(p, x)).length;
      const t: Tri = best === k && worst === k ? YES : k < best || k > worst ? NO
        : unsure("recount_range", `party ${p} finishes between ${best} and ${worst} once ridings inside the recount margin, and valid-vote tie-breaks closer than 1%, can go either way`);
      return finish([t], ctx, detail, caveats);
    }
    case "seat_margin": {
      const others = R.parties.filter((x) => x !== p);
      const maxOther = Math.max(0, ...others.map(hi)), minOtherTop = Math.max(0, ...others.map(lo));
      const pFirst = lo(p) > maxOther;
      const pNotFirst = others.some((x) => lo(x) >= hi(p));
      // a leader that is not settled in every case (a tie, or ridings inside the recount margin that could change it) is
      // never read as "not this leg": the rail abstains (off: answered No)
      const open = (why: string): Tri => (railEnabled("election_qc_leader_settled") ? unsure("recount_range", why) : NO);
      let t: Tri;
      if (leg.other_leader) {
        // "Another Party Wins": a party other than p has strictly the most seats in every case
        const q = others.find((x) => R.parties.every((y) => y === x || hi(y) < lo(x)));
        t = q ? YES : pFirst ? NO : open("which party has the most seats outright is not settled");
      } else if (pNotFirst) t = NO;
      else if (!pFirst) t = open(`party ${p} is not settled as the outright leader (${range(p)} seats vs up to ${maxOther})`);
      else t = rangeTri(lo(p) - maxOther, hi(p) - minOtherTop, ctx.r.bucket, `party ${p}'s seat margin over the second party`);
      return finish([t], ctx, detail, caveats);
    }
    default: return mismatch(`${def.measure} is not an Élections Québec measure`);
  }
}

/**
 * Decide one election leg from the stored first final count (called by decideOfficial after gate 1). contest: the
 * snapshot as stored; caveats: what the rail adds to a verdict (first_print, single_source).
 */
export function decideElection(market: Pick<MarketRegistration, "positive_option">, r: LegResolver, contest: unknown, caveats: string[]): StructuredDecision {
  if (!isElectionSeries(r.series)) return mismatch(`${r.series} is not an election series`);
  const def = ELECTION_SERIES[r.series];
  const s = canonicalSnapshot(contest);
  if (!s) return unresolvedD("value_unreadable", "the stored count is not a readable contest snapshot");
  if (s.authority !== def.authority) return mismatch(`the stored count is from ${s.authority}; ${def.id} reads ${def.authority}`);
  const ctx: Ctx = { r, positive: market.positive_option, margin: railEnabled("election_safety_margin") };
  if (s.authority === "tse") return decideTse(def, s, ctx, caveats);
  return decideEq(def, s, ctx, caveats);
}

// ---- registration -----------------------------------------------------------------------------------------------

const PERCENT_MEASURES: ReadonlySet<ElectionMeasure> = new Set(["share_valid", "winner_margin", "turnout"]);

/** Cross-field rules of an election leg ([] when valid). The generic official_release rules run as well. */
export function electionRegistrationIssues(r: { series: string; period: string; bucket: OfficialBucket; prior_level?: number; rounding: string; election?: ElectionLeg }): string[] {
  if (!isElectionSeries(r.series)) return r.election ? ["election fields apply to election series only"] : [];
  const def = ELECTION_SERIES[r.series];
  const issues: string[] = [];
  const leg = r.election ?? {};
  if (r.rounding !== "election_exact") issues.push(`${r.series} decides from exact counts: rounding must be election_exact`);
  if (r.prior_level !== undefined) issues.push(`${r.series} has no prior level`);
  const known = electionEvent(def.authority, r.period);
  const needsSubject = def.measure !== "turnout";
  if (needsSubject && !leg.subject) issues.push(`${r.series} needs election.subject (the authority's id and name for the leg's ${def.authority === "tse" ? "candidate" : def.measure === "riding_winner" ? "candidate" : "party"})`);
  if (!needsSubject && leg.subject) issues.push(`${r.series} has no subject`);
  if (def.subjectId && leg.subject && leg.subject.id !== def.subjectId) issues.push(`${r.series} is about party ${def.subjectId}; the leg names ${leg.subject.id} (${leg.subject.name})`);
  if (def.subjectHint && leg.subject && !tokensWithin(def.subjectHint, `${leg.subject.name} ${leg.subject.full_name ?? ""}`)) issues.push(`${r.series} is about ${def.subjectHint}; the leg names ${leg.subject.name}`);
  if (def.measure === "riding_winner") {
    if (!leg.unit) issues.push(`${r.series} needs election.unit (the riding)`);
    else if (known && def.riding && leg.unit !== def.riding.code) issues.push(`${r.series} is riding ${def.riding.code} (${def.riding.name}) in the ${r.period} election; the leg names riding ${leg.unit}`);
  } else if (leg.unit) issues.push(`${r.series} takes no riding`);
  if (leg.listed && !(def.authority === "tse" && def.measure === "rank_votes")) issues.push(`${r.series}: election.listed applies to Brazilian rank events only`);
  if (def.authority === "tse" && def.measure === "rank_votes") {
    if (!leg.listed?.length) issues.push(`${r.series} needs election.listed (every candidate the event names, by TSE number)`);
    else if (leg.subject && !leg.listed.includes(leg.subject.id)) issues.push(`${r.series}: the leg's candidate ${leg.subject.id} is not among election.listed`);
  }
  if (leg.other_leader !== undefined && def.measure !== "seat_margin") issues.push(`${r.series}: other_leader applies to the seat-margin event only`);
  const b = r.bucket;
  const finite = [b.lo, b.hi].filter((x): x is number => x !== undefined);
  if (!finite.length) issues.push(`bucket "${b.label}" has neither lo nor hi`);
  if (def.rank !== undefined) {
    if (b.lo !== def.rank || b.hi !== def.rank || !b.lo_inclusive || !b.hi_inclusive) issues.push(`${r.series} asks about place ${def.rank}: the bucket must be [${def.rank}, ${def.rank}]`);
  } else if (def.fixedBucket) {
    const f = def.fixedBucket;
    if (b.lo !== f.lo || b.hi !== f.hi || b.lo_inclusive !== f.lo_inclusive || b.hi_inclusive !== f.hi_inclusive) issues.push(`${r.series}'s bucket is fixed by the event: ${f.label}`);
  } else if (PERCENT_MEASURES.has(def.measure)) {
    if (finite.some((x) => x < 0 || x > 100)) issues.push(`bucket "${b.label}" is outside 0-100%`);
    if (b.lo !== undefined && b.hi !== undefined && cmp(q(b.lo), q(b.hi)) >= 0) issues.push(`bucket "${b.label}" is empty`);
  } else {
    if (finite.some((x) => !Number.isInteger(x) || x < 0)) issues.push(`bucket "${b.label}" must count whole seats`);
    const { lo, hi } = intBucket(b);
    if (lo > hi) issues.push(`bucket "${b.label}" is empty`);
    if (def.measure === "seat_margin" && lo < 1) issues.push(`bucket "${b.label}": a seat margin of 0 is a tie ("Other"), never a leg`);
  }
  return issues;
}

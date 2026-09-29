/**
 * Building election leg registrations (scripts/election-legs.ts). Pure. Every leg's subject is pinned to the
 * authority's own identifier at registration: a label is mapped against the authority's candidate or party list and a
 * label that does not map to exactly one entry is refused, never guessed. A TSE candidate label maps only when its
 * normalized text (case and accents ignored) equals the ballot name or the civil name, or through an entry of the
 * curated table TSE_LABEL_NUMBERS (label -> ballot number, written by hand from the TSE's own list); a word-subset match
 * is refused: the 2026 events list off-ballot people who share a surname with a candidate ("Jair Bolsonaro", "Michelle
 * Bolsonaro" beside Flávio Bolsonaro), so "Bolsonaro" could pin a leg to the wrong person. A Québec candidate label
 * (within one riding) maps on the exact name or when every word of a label of at least two words is a word of the name;
 * a one-word label must match exactly. A party label
 * maps on the exact name or abbreviation, or as words of either ("CAQ" within "ÉCF-CAQ"). Matches are pooled and more
 * than one entry is ambiguous ("PCQ" is both the Parti communiste du Québec's abbreviation and a word of the Parti
 * canadien du Québec's "PCQ/CPQ", while the Polymarket events mean the Parti conservateur, "PCOQ").
 *
 * Buckets: percent labels ("<5%", "5-10%", "15%+") are [lo, hi) because every one of these texts settles a value exactly
 * between two brackets in the higher one (checked on the leg's text, else refused); seat labels ("<5", "5-9", "30+") are
 * whole seats, both ends inclusive.
 *
 * The Québec seat-margin event lists one party's margin buckets and "Another Party Wins", which means a party the event
 * does not list. The rail reads that leg as "a party other than the subject has the most seats", which is the same thing
 * only while the subject is the one party listed: an event with a bucket for a second party, or with a label that is
 * neither, is refused as a whole (seatMarginForeignLabels).
 *
 * The registered condition says what the rail does: Yes and No only from the authority's final count, and unresolved
 * while the count is not final or the value is inside the rail's safety margins (never "otherwise No").
 */
import type { ElectionLeg, ElectionSubject, MarketRegistration, OfficialBucket } from "../resolve/schema";
import { ELECTION_SERIES, electionEvent, normName, nameTokens, type ElectionSeriesId, type TseSnapshot, type EqSnapshot } from "../resolve/election";
import { OFFICIAL_SERIES } from "../resolve/official";

// ---- authority registries --------------------------------------------------------------------------------------------

/** The TSE's candidates for one election (from the TSE's own file: a result file of that election lists every candidate). */
export interface TseRegistry { source_url: string; fetched_at: string; election_day: string; candidates: Array<{ id: string; name: string; full_name: string | null }> }
export interface EqRegistry {
  source_url: string; fetched_at: string;
  candidates: Array<{ id: string; riding: string; name: string; party: string }>;
  parties: Array<{ id: string; abbr: string; name: string }>;
}

/** A TSE result file's candidate table as the registry (the ballot number, ballot name and civil name). */
export function tseRegistryFromSnapshot(s: TseSnapshot, source_url: string, fetched_at: string): TseRegistry {
  if (!/^https:\/\/[a-z0-9.-]+\.tse\.jus\.br\//.test(source_url)) throw new Error(`a TSE registry must come from a tse.jus.br host, not ${source_url}`);
  return { source_url, fetched_at, election_day: s.election_day, candidates: s.candidates.map((c) => ({ id: c.id, name: c.name, full_name: c.full_name })) };
}

/** Élections Québec's candidatures.json (accepted candidacies, etat CON) as the registry. */
export function eqRegistryFromCandidatures(rows: unknown, source_url: string, fetched_at: string): EqRegistry {
  if (!Array.isArray(rows)) throw new Error("candidatures.json is not a list");
  const candidates: EqRegistry["candidates"] = [];
  const parties = new Map<string, { id: string; abbr: string; name: string }>();
  for (const r of rows as Array<Record<string, unknown>>) {
    if (r.etat !== "CON") continue;
    const id = r.numero, riding = r.code_circonscription, party = r.afpparp_numero ?? 0;
    if (typeof id !== "number" || typeof riding !== "number" || typeof party !== "number") throw new Error(`candidatures.json row ${JSON.stringify(r).slice(0, 80)}: numero/code_circonscription/afpparp_numero`);
    candidates.push({ id: String(id), riding: String(riding), name: `${String(r.prenom_bulletin_vote ?? "")} ${String(r.nom_bulletin_vote ?? "")}`.replace(/\s+/g, " ").trim(), party: String(party) });
    if (party !== 0 && typeof r.abreviation_parti === "string" && typeof r.nom_parti === "string") parties.set(String(party), { id: String(party), abbr: r.abreviation_parti, name: r.nom_parti });
  }
  return { source_url, fetched_at, candidates, parties: [...parties.values()] };
}

/** An Élections Québec results file as the registry (past elections: the candidates and parties it reports). */
export function eqRegistryFromSnapshot(s: EqSnapshot, source_url: string, fetched_at: string): EqRegistry {
  return {
    source_url, fetched_at,
    candidates: s.ridings.flatMap((r) => r.candidates.map((c) => ({ id: c.id, riding: r.id, name: c.name, party: c.party }))),
    parties: s.parties.filter((p) => p.id !== "0").map((p) => ({ id: p.id, abbr: p.abbr, name: p.name })),
  };
}

// ---- label mapping -------------------------------------------------------------------------------------------------

/**
 * A refusal. unmatched: the label names nobody on the list (an off-ballot person a rank event may list); partial: it
 * matches some words of a name only. A rank event whose labels include any refusal but unmatched is refused as a whole.
 */
export type MapResult = { ok: true; subject: ElectionSubject } | { ok: false; reason: string; partial?: true; unmatched?: true };

const within = (label: string, name: string | null | undefined): boolean => {
  if (!name) return false;
  const have = new Set(nameTokens(name));
  const want = nameTokens(label);
  return want.length > 0 && want.every((t) => have.has(t));
};
/** subset: "multiword" (a label of two or more words may be a word subset of a name), "any" (any label may). */
type Subset = "multiword" | "any";
function pick<T extends { id: string }>(label: string, pool: T[], names: (x: T) => Array<string | null | undefined>, what: string, show: (x: T) => string, subset: Subset): { ok: true; hit: T } | { ok: false; reason: string } {
  const n = normName(label);
  if (!n) return { ok: false, reason: `empty label` };
  const allowSubset = subset === "any" || (subset === "multiword" && nameTokens(label).length >= 2);
  const hits = new Map<string, T>();
  for (const x of pool) if (names(x).some((m) => m && (normName(m) === n || (allowSubset && within(label, m))))) hits.set(x.id, x);
  if (hits.size === 1) return { ok: true, hit: [...hits.values()][0]! };
  if (!hits.size) return { ok: false, reason: `"${label}" matches no ${what}` };
  return { ok: false, reason: `"${label}" is ambiguous: it matches ${[...hits.values()].map(show).join(" and ")}` };
}

/**
 * Curated TSE labels, per election day: a platform label (normalized with normName) whose text is neither a candidate's
 * ballot name nor civil name, mapped to the ballot number by hand after reading the TSE's own candidate list for that
 * election (never a press report). The number must still be in the registry the leg is built against, and an entry
 * that disagrees with an exact name match refuses the label. Empty for 2026-10-04: every TSE host answered 403 from the
 * founder's machine (2026-09-27), so no 2026 ballot number was observed; add entries only with the TSE list in hand.
 */
export const TSE_LABEL_NUMBERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "2026-10-04": {},
};

const tseSubject = (c: TseRegistry["candidates"][number]): ElectionSubject => ({ id: c.id, name: c.name, ...(c.full_name ? { full_name: c.full_name } : {}) });

/**
 * A TSE candidate label: the exact (normalized) ballot or civil name of one candidate, or a curated entry for the
 * registry's election day. Refused: no match, more than one, a curated number the registry does not list, a curated
 * number that disagrees with an exact match, and a match on some of the words of a name only.
 */
export function mapTseCandidate(label: string, reg: TseRegistry, curated: Readonly<Record<string, string>> = TSE_LABEL_NUMBERS[reg.election_day] ?? {}): MapResult {
  const what = `TSE candidate of ${reg.election_day} (${reg.source_url})`;
  const n = normName(label);
  if (!n) return { ok: false, reason: "empty label" };
  const exact = reg.candidates.filter((c) => [c.name, c.full_name].some((m) => m && normName(m) === n));
  const show = (xs: TseRegistry["candidates"]) => xs.map((c) => `${c.id} ${c.name}`).join(" and ");
  if (exact.length > 1) return { ok: false, reason: `"${label}" is ambiguous: it matches ${show(exact)}` };
  const number = Object.prototype.hasOwnProperty.call(curated, n) ? curated[n]! : null;
  if (number !== null) {
    const listed = reg.candidates.filter((c) => c.id === number);
    if (listed.length !== 1) return { ok: false, reason: `"${label}" is curated as ballot number ${number}, which the ${what} lists ${listed.length ? "more than once" : "nowhere"}` };
    if (exact.length && exact[0]!.id !== number) return { ok: false, reason: `"${label}" is ambiguous: curated as ballot number ${number} but it is the exact name of ${show(exact)}` };
    return { ok: true, subject: tseSubject(listed[0]!) };
  }
  if (exact.length === 1) return { ok: true, subject: tseSubject(exact[0]!) };
  const partial = reg.candidates.filter((c) => within(label, c.name) || within(label, c.full_name));
  if (!partial.length) return { ok: false, unmatched: true, reason: `"${label}" matches no ${what} exactly` };
  return { ok: false, partial: true, reason: `"${label}" matches no ${what} exactly (its words are within ${show(partial)}; a word-subset match is never accepted for TSE legs: add a curated entry to TSE_LABEL_NUMBERS from the TSE's list)` };
}

export function mapEqCandidate(label: string, riding: string, reg: EqRegistry): MapResult {
  const pool = reg.candidates.filter((c) => c.riding === riding);
  if (!pool.length) return { ok: false, reason: `riding ${riding} has no accepted candidacy in ${reg.source_url}` };
  const p = pick(label, pool, (c) => [c.name], `accepted candidate of riding ${riding}`, (c) => `${c.id} ${c.name}`, "multiword");
  return p.ok ? { ok: true, subject: { id: p.hit.id, name: p.hit.name } } : p;
}

/** A party by abbreviation ("CAQ" within "ÉCF-CAQ") or by name ("Coalition Avenir Québec"). */
export function mapEqParty(label: string, reg: EqRegistry): MapResult {
  const p = pick(label, reg.parties, (x) => [x.abbr, x.name], "Élections Québec party", (x) => `${x.id} ${x.abbr} (${x.name})`, "any");
  return p.ok ? { ok: true, subject: { id: p.hit.id, name: p.hit.name } } : p;
}

// ---- criteria basis ---------------------------------------------------------------------------------------------------

/**
 * What a leg's text says settles it, when that is not the authority alone. "consensus_reporting": the market resolves on
 * "a consensus of credible reporting" and turns to the authority's official results only "if there is ambiguity" (the
 * Polymarket Quebec events, and the Brazilian ones except turnout, as saved 2026-09-27). The rail reads the authority's
 * final count either way; whether that reading may stand for such a market is a policy call, so the leg file marks
 * these legs (criteria_basis) and scripts/seed-shadow.ts holds them back unless --accept-consensus-reading is given.
 */
export type CriteriaBasis = "consensus_reporting";
export function criteriaBasis(text: string): CriteriaBasis | null {
  return /\bconsensus\s+of\s+credible\s+reporting\b/i.test(strip(text)) ? "consensus_reporting" : null;
}

// ---- event keys -------------------------------------------------------------------------------------------------------

/**
 * markets.event_key counts and posts one platform event once (src/markets/event-key.ts). An election leg's key is
 * official:<series>:<day>, so two distinct platform events read as the same series and day (a relisted copy such as
 * "...-margin-of-victory" and "...-margin-of-victory-2") would share one key: one fact counted once while two events
 * settle. Every event must have exactly one key and every key exactly one event. [] = consistent.
 */
export function eventKeyProblems(rows: Iterable<{ event_id: string; event_key: string }>): string[] {
  const keysOf = new Map<string, Set<string>>(), eventsOf = new Map<string, Set<string>>();
  for (const { event_id, event_key } of rows) {
    if (!keysOf.has(event_id)) keysOf.set(event_id, new Set());
    keysOf.get(event_id)!.add(event_key);
    if (!eventsOf.has(event_key)) eventsOf.set(event_key, new Set());
    eventsOf.get(event_key)!.add(event_id);
  }
  const out: string[] = [];
  for (const [ev, keys] of keysOf) if (keys.size !== 1) out.push(`event ${ev} maps to ${keys.size} event keys: ${[...keys].sort().join(", ")}`);
  for (const [key, evs] of eventsOf) if (evs.size !== 1) out.push(`event key ${key} is shared by events ${[...evs].sort().join(" and ")}`);
  return out;
}

// ---- buckets ---------------------------------------------------------------------------------------------------------

const N = String.raw`(\d+(?:\.\d+)?)`;
/** "<5%", "5-10%", "15%+" -> [lo, hi) in percent; null for anything else. */
export function percentLegBucket(label: string): OfficialBucket | null {
  const t = label.replace(/[–—−]/g, "-").replace(/\s+/g, "").trim();
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^<${N}%$`).exec(t))) return { label, hi: Number(m[1]), hi_inclusive: false, lo_inclusive: true };
  if ((m = new RegExp(`^${N}%?-${N}%$`).exec(t))) { const lo = Number(m[1]), hi = Number(m[2]); return lo < hi ? { label, lo, hi, lo_inclusive: true, hi_inclusive: false } : null; }
  if ((m = new RegExp(`^${N}%\\+$`).exec(t))) return { label, lo: Number(m[1]), lo_inclusive: true, hi_inclusive: true };
  return null;
}
/** "<5", "5-9", "30+" -> whole seats, both ends inclusive; floor: the smallest value the event can take (a margin: 1). */
export function seatsLegBucket(label: string, floor = 0): OfficialBucket | null {
  const t = label.replace(/[–—−]/g, "-").replace(/\s+/g, "").trim();
  let m: RegExpExecArray | null;
  if ((m = /^<(\d+)$/.exec(t))) { const hi = Number(m[1]); return hi > floor ? { label, ...(floor > 0 ? { lo: floor } : {}), hi, hi_inclusive: false, lo_inclusive: true } : null; }
  if ((m = /^(\d+)-(\d+)$/.exec(t))) { const lo = Number(m[1]), hi = Number(m[2]); return lo <= hi && lo >= floor ? { label, lo, hi, lo_inclusive: true, hi_inclusive: true } : null; }
  if ((m = /^(\d+)\+$/.exec(t))) { const lo = Number(m[1]); return lo >= floor ? { label, lo, lo_inclusive: true, hi_inclusive: true } : null; }
  return null;
}
/** The texts that settle a value exactly between two brackets in the higher one. */
export const TIE_TO_HIGHER = /\bhigher (?:range )?bracket\b/i;

export const ANOTHER_PARTY_WINS = /^another party wins$/i;
/**
 * The active labels of a Québec seat-margin event that are neither "Another Party Wins" nor a margin bucket of the
 * subject party ("PQ 10-19": the party, then whole seats from 1 up). [] = the subject is the one party the event lists,
 * so "Another Party Wins" is "a party other than the subject"; anything else (a bucket for a second party, an unnamed
 * leg, an unreadable bucket) leaves that reading unproven and the event is refused.
 */
export function seatMarginForeignLabels(labels: Array<string | null>, subjectId: string, reg: EqRegistry): string[] {
  const out: string[] = [];
  for (const raw of labels) {
    const l = raw?.trim() ?? "";
    if (ANOTHER_PARTY_WINS.test(l)) continue;
    const m = /^(.*\S)\s+(\S+)$/.exec(l);
    const party = m ? mapEqParty(m[1]!, reg) : null;
    if (!m || !party?.ok || party.subject.id !== subjectId || !seatsLegBucket(m[2]!, 1)) out.push(l || "(a leg without a label)");
  }
  return out;
}

// ---- legs -------------------------------------------------------------------------------------------------------------

export interface ElectionEventInput {
  series: ElectionSeriesId;
  period: string;
  release_at: string;
  /** The event's title on the platform (condition text). */
  title: string;
  /** The event's rules text (HTML allowed). */
  criteria: string;
  /** Every active leg label of the event (a Brazilian rank event: the candidates it names). */
  labels: Array<string | null>;
  /** Quebec party events: the party the event's text names in full or by abbreviation ("Coalition Avenir Québec (CAQ)"). */
  party?: string;
  /**
   * Quebec riding events: the riding's code in the registry's election when it is not the series' 2026 code (a past
   * election's map, for the frozen evals); registration refuses any other code for the 2026 event.
   */
  unit?: string;
}
export interface ElectionLegSpec { external_id: string; label: string | null; open_at: string; deadline_utc: string; criteria?: string }
export interface Registries { tse?: TseRegistry | null; eq?: EqRegistry | null; tseUnavailable?: string }

const strip = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
type Built = { ok: true; market: MarketRegistration } | { ok: false; reason: string };

function tseReg(reg: Registries, period: string): TseRegistry | string {
  if (!reg.tse) return `no TSE candidate registry: ${reg.tseUnavailable ?? "none was given"}; a leg's candidate cannot be pinned to a TSE ballot number`;
  if (reg.tse.election_day !== period) return `the TSE registry is for ${reg.tse.election_day}, the event is ${period}`;
  return reg.tse;
}

/** One leg as a registration: Yes/No, positive = Yes, the resolver's subject pinned to the authority's id. */
export function buildElectionLeg(ev: ElectionEventInput, leg: ElectionLegSpec, reg: Registries): Built {
  const def = ELECTION_SERIES[ev.series];
  const criteria = strip(leg.criteria ?? ev.criteria);
  let bucket: OfficialBucket | null = null;
  let election: ElectionLeg = {};
  let fact: string;
  const label = leg.label?.trim() ?? "";
  const pctBucket = (l: string): OfficialBucket | string => {
    const b = percentLegBucket(l);
    if (!b) return `unrecognised bucket label "${l}"`;
    if (!TIE_TO_HIGHER.test(criteria)) return `"${l}": the text does not say which bracket a value exactly on a boundary settles in, so "X-Y%" cannot be read as [X, Y)`;
    return b;
  };
  switch (def.measure) {
    case "rank_votes": {
      const t = tseReg(reg, ev.period);
      if (typeof t === "string") return { ok: false, reason: t };
      const s = mapTseCandidate(label, t);
      if (!s.ok) return { ok: false, reason: s.reason };
      const listed: string[] = [];
      for (const l of ev.labels) {
        if (!l) continue;
        const m = mapTseCandidate(l, t);
        if (m.ok) { if (!listed.includes(m.subject.id)) listed.push(m.subject.id); }
        // only a label that names nobody on the TSE's list is left out; an ambiguous one, one that names a candidate by some
        // words only, or a curated entry the registry contradicts leaves the named set unknown
        else if (!m.unmatched) return { ok: false, reason: `the event's label ${m.reason}, so the candidates it names are not known exactly` };
      }
      bucket = { label, lo: def.rank!, hi: def.rank!, lo_inclusive: true, hi_inclusive: true };
      election = { subject: s.subject, listed };
      fact = `TSE candidate ${s.subject.name} (ballot number ${s.subject.id}) finished in place ${def.rank} by valid votes in the ${def.scope === "BR" ? "national" : `${def.scope} state`} count of the Brazilian presidential first round of ${ev.period}`;
      break;
    }
    case "share_valid": {
      const t = tseReg(reg, ev.period);
      if (typeof t === "string") return { ok: false, reason: t };
      const s = mapTseCandidate(def.subjectHint!, t);
      if (!s.ok) return { ok: false, reason: `the event's candidate ${s.reason}` };
      const b = pctBucket(label);
      if (typeof b === "string") return { ok: false, reason: b };
      bucket = b; election = { subject: s.subject };
      fact = `TSE candidate ${s.subject.name} (ballot number ${s.subject.id}) received a share of the valid votes in the bucket "${label}" in the Brazilian presidential first round of ${ev.period}`;
      break;
    }
    case "winner_margin": {
      const t = tseReg(reg, ev.period);
      if (typeof t === "string") return { ok: false, reason: t };
      const vic = /^(.*\S)\s+Victory$/i.exec(label);
      const mm = vic ? null : /^(.*\S)\s+(\S+%\+?)$/.exec(label);
      if (!vic && !mm) return { ok: false, reason: `"${label}" names no candidate and margin bucket` };
      const s = mapTseCandidate((vic ?? mm)![1]!, t);
      if (!s.ok) return { ok: false, reason: s.reason };
      if (vic) bucket = { label, lo: 0, lo_inclusive: true, hi_inclusive: true };
      else { const b = pctBucket(mm![2]!); if (typeof b === "string") return { ok: false, reason: b }; bucket = { ...b, label }; }
      election = { subject: s.subject };
      fact = `TSE candidate ${s.subject.name} (ballot number ${s.subject.id}) finished first in the Brazilian presidential first round of ${ev.period} with a margin over the runner-up in the bucket "${label}"`;
      break;
    }
    case "turnout": {
      const b = pctBucket(label);
      if (typeof b === "string") return { ok: false, reason: b };
      bucket = b;
      fact = `Turnout (votes cast over eligible voters) of the Brazilian presidential first round of ${ev.period} is in the bucket "${label}"`;
      break;
    }
    case "riding_winner": {
      if (!reg.eq) return { ok: false, reason: "no Élections Québec candidate registry" };
      const code = ev.unit ?? def.riding!.code;
      const s = mapEqCandidate(label, code, reg.eq);
      if (!s.ok) return { ok: false, reason: s.reason };
      bucket = { label, lo: 1, hi: 1, lo_inclusive: true, hi_inclusive: true };
      election = { subject: s.subject, unit: code };
      fact = `Candidate ${s.subject.name} (Élections Québec candidate ${s.subject.id}) won the riding of ${def.riding!.name} (riding ${code}) in the Quebec general election of ${ev.period}`;
      if (ev.unit && ev.unit !== def.riding!.code && electionEvent("eq", ev.period)) return { ok: false, reason: `riding ${ev.unit} is not ${ev.series}'s riding ${def.riding!.code} in the ${ev.period} election` };
      break;
    }
    case "seats": case "rank_seats": case "seat_margin": {
      if (!reg.eq) return { ok: false, reason: "no Élections Québec party registry" };
      let partyLabel: string;
      if (def.measure === "rank_seats") partyLabel = label;
      else if (def.measure === "seat_margin") partyLabel = ANOTHER_PARTY_WINS.test(label) ? (ev.party ?? "") : (/^(.*\S)\s+\S+$/.exec(label)?.[1] ?? "");
      else partyLabel = ev.party ?? "";
      const s = mapEqParty(partyLabel, reg.eq);
      if (!s.ok) return { ok: false, reason: s.reason };
      if (def.subjectId && s.subject.id !== def.subjectId) return { ok: false, reason: `"${partyLabel}" maps to party ${s.subject.id} (${s.subject.name}); ${ev.series} is about party ${def.subjectId}` };
      if (def.measure === "seat_margin") {
        // the event, not only its "Another Party Wins" leg: every leg of an event the rail cannot read as one party's is refused
        const foreign = seatMarginForeignLabels(ev.labels, s.subject.id, reg.eq);
        if (foreign.length) return { ok: false, reason: `the event lists ${foreign.slice(0, 3).map((l) => `"${l}"`).join(", ")}, not a seat-margin bucket of party ${s.subject.id} (${s.subject.name}): "Another Party Wins" means a party the event does not list, which the rail can read only when ${s.subject.name} is the one party listed; the event is refused` };
      }
      election = { subject: s.subject };
      if (def.measure === "rank_seats") {
        bucket = { label, lo: def.rank!, hi: def.rank!, lo_inclusive: true, hi_inclusive: true };
        fact = `Party ${s.subject.name} (Élections Québec party ${s.subject.id}) finished in place ${def.rank} by seats in the Quebec general election of ${ev.period}`;
      } else if (def.measure === "seats") {
        bucket = def.fixedBucket ?? seatsLegBucket(label);
        if (!bucket) return { ok: false, reason: `unrecognised seat bucket "${label}"` };
        fact = `Party ${s.subject.name} (Élections Québec party ${s.subject.id}) won a number of seats in the bucket "${bucket.label}" in the Quebec general election of ${ev.period}`;
      } else if (ANOTHER_PARTY_WINS.test(label)) {
        bucket = { label, lo: 1, lo_inclusive: true, hi_inclusive: true };
        election = { subject: s.subject, other_leader: true };
        fact = `A party other than ${s.subject.name} (Élections Québec party ${s.subject.id}) won the most seats outright in the Quebec general election of ${ev.period}`;
      } else {
        bucket = seatsLegBucket(/^(.*\S)\s+(\S+)$/.exec(label)?.[2] ?? "", 1);
        if (!bucket) return { ok: false, reason: `unrecognised seat-margin label "${label}"` };
        bucket = { ...bucket, label };
        fact = `Party ${s.subject.name} (Élections Québec party ${s.subject.id}) won the most seats in the Quebec general election of ${ev.period} with a seat margin over the second party in the bucket "${label}"`;
      }
      break;
    }
    default: { const never: never = def.measure; return { ok: false, reason: `unhandled measure ${String(never)}` }; }
  }
  const head = `Leg "${label || bucket.label}" of "${ev.title}" (${OFFICIAL_SERIES[ev.series].label}): resolves Yes iff the authority's final count puts this leg's value in the bucket, No iff it puts it in another bucket; a value inside the rail's safety margins, or a count that is not final, stays unresolved. `;
  const market: MarketRegistration = {
    platform: "polymarket", external_id: leg.external_id,
    condition: (head + criteria).slice(0, 4000),
    event_statement: fact.slice(0, 1000),
    option_a: "Yes", option_b: "No", positive_option: "OPTION_A",
    anchors: [ev.series],
    sources: [{ kind: "official_release", ref: `official:${ev.series}:${ev.period}` }],
    open_at: leg.open_at, deadline_utc: leg.deadline_utc, grace_seconds: 3600,
    resolver: { kind: "official_release", series: ev.series, period: ev.period, release_at: ev.release_at, bucket, rounding: "election_exact", election },
    negative_rule: "explicit_negative", allow_prerelease: false,
  };
  return { ok: true, market };
}

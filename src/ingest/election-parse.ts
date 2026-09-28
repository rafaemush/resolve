/**
 * Pure parsers of the electoral authorities' result files into the rail's contest snapshot (src/resolve/election.ts).
 * Every field the decision reads must be present with the expected type, or the file is schema drift: nothing is
 * inferred and nothing is defaulted.
 *
 * TSE (resultados.tse.jus.br). The configuration ele-c.json names the cycle, each pleito's date and its elections; the
 * President's first round is the election with tp=8 and t=1 in the pleito dated on election day (2022 config OBSERVED
 * through Wayback 20221004163421; the 2026 simulation config OBSERVED 2026-09-27T23:23:16Z puts the cycle "c" inside the
 * pleito and lists directory templates in "arq"). Result files come in two layouts:
 *   - EA20 unified (2024 and 2026): <uf>-c0001-e<6-digit id>-u.json under /oficial/<cycle>/<id>/dados/<uf>/ (the 2026
 *     official path is UNVERIFIED: built by analogy with the simulation files and the 2024 official ones), candidates
 *     under carg[cd=1].agr[].par[].cand[], counts grouped in s{}, e{} and v{}, and the and (n/p/f) flag.
 *   - 2022 simplified: <uf>-c0001-e<id>-r.json, candidates in cand[], counts at the top level, no and flag.
 * Times (dg/hg, dt/ht) are Brasília time, UTC-3 (no daylight saving since 2019).
 *
 * Élections Québec (donnees.electionsquebec.qc.ca). resultats.json: statistiques{} for the whole election and
 * circonscriptions[] with each riding's candidats[]; "{}" while no result is out (page_resultat.js treats it so);
 * iso8601DateMAJ carries a comma before the fraction ("2022-10-06T11:55:41,000-04:00"), which Date.parse refuses.
 */
import type { TseSnapshot, TseCandidate, EqSnapshot } from "../resolve/election";

export type ElectionParse<T> = { ok: true; snap: T } | { ok: false; reason: "not_published" | "schema_drift"; detail: string };
const drift = (detail: string): { ok: false; reason: "schema_drift"; detail: string } => ({ ok: false, reason: "schema_drift", detail: detail.slice(0, 300) });
const notYet = (detail: string): { ok: false; reason: "not_published"; detail: string } => ({ ok: false, reason: "not_published", detail: detail.slice(0, 300) });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);
class Drift extends Error {}
/** A required string field (numbers are accepted as their decimal text). */
function str(o: Obj, k: string, where: string): string {
  const v = o[k];
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new Drift(`${where}.${k} is missing`);
}
/** A required non-negative integer, as decimal text without leading zeros. */
function int(o: Obj, k: string, where: string): string {
  const v = o[k];
  const s = typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === "string" && /^\d{1,12}$/.test(v) ? String(BigInt(v)) : null;
  if (s === null) throw new Drift(`${where}.${k} is not a non-negative integer (${JSON.stringify(v)?.slice(0, 40)})`);
  return s;
}
const opt = (o: Obj, k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);

const ENTITIES: Record<string, string> = { apos: "'", amp: "&", quot: '"', lt: "<", gt: ">", "#39": "'", "#186": "º" };
const decode = (s: string) => s.replace(/&(apos|amp|quot|lt|gt|#39|#186);/g, (_, e: string) => ENTITIES[e]!).trim();

/** "04/10/2022" + "10:27:34" (Brasília) -> "2022-10-04T10:27:34-03:00". */
export function brasiliaIso(d: string, h: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d), t = /^(\d{2}):(\d{2}):(\d{2})$/.exec(h);
  if (!m || !t) return null;
  const s = `${m[3]}-${m[2]}-${m[1]}T${t[1]}:${t[2]}:${t[3]}-03:00`;
  return Number.isNaN(Date.parse(s)) ? null : s;
}
/** "2026-10-04" -> "04/10/2026" (the config's pleito date format). */
export const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

// ---- TSE configuration ---------------------------------------------------------------------------------------------

export interface TseConfig { environment: string; cycle: string; electionId: string; electionDay: string }

/** The expected directory of unified files in the configuration's "arq" list (2026 simulation, OBSERVED). */
export const TSE_UNIFIED_DIR = "<base>/<ambiente>/<ciclo>/<cd_eleicao>/dados/<uf>";

/**
 * The President's first-round election of the pleito dated `day` (YYYY-MM-DD). not_published while the configuration
 * lists no such pleito (the live file carried only 2024 elections on 2026-08-16, Wayback); drift when it lists more than
 * one or its fields changed shape.
 */
export function parseTseConfig(text: string, day: string): ElectionParse<TseConfig> {
  let root: unknown;
  try { root = JSON.parse(text); } catch { return drift("ele-c.json is not JSON"); }
  if (!isObj(root)) return drift("ele-c.json is not an object");
  const env = typeof root.f === "string" ? root.f.toLowerCase() : "";
  if (env !== "o" && env !== "s") return drift(`ele-c.json f=${JSON.stringify(root.f)}`);
  const unified = arr(root.arq)?.find((a) => isObj(a) && a.tp === "u");
  if (unified && (!isObj(unified) || unified.dir !== TSE_UNIFIED_DIR)) return drift(`ele-c.json names the unified-file directory ${JSON.stringify(isObj(unified) ? unified.dir : unified)}, not ${TSE_UNIFIED_DIR}`);
  const pls = arr(root.pl);
  if (!pls) return drift("ele-c.json has no pl list");
  const date = dmy(day);
  const hits: TseConfig[] = [];
  for (const pl of pls) {
    if (!isObj(pl) || pl.dt !== date) continue;
    const cycle = typeof pl.c === "string" ? pl.c : typeof root.c === "string" ? root.c : "";
    if (!/^ele\d{4}$/.test(cycle)) return drift(`pleito ${String(pl.cd)} has no cycle`);
    for (const e of arr(pl.e) ?? []) {
      if (!isObj(e) || e.tp !== "8" || e.t !== "1") continue;
      const president = (arr(e.abr) ?? []).some((a) => isObj(a) && (arr(a.cp) ?? []).some((c) => isObj(c) && c.cd === "1"));
      if (!president) continue;
      if (typeof e.cd !== "string" || !/^\d{1,6}$/.test(e.cd)) return drift(`pleito ${String(pl.cd)}: election code ${JSON.stringify(e.cd)}`);
      hits.push({ environment: env, cycle, electionId: e.cd, electionDay: day });
    }
  }
  if (hits.length > 1) return drift(`ele-c.json lists ${hits.length} President first-round elections dated ${date}`);
  if (!hits.length) return notYet(`ele-c.json (f=${env}) lists no President first-round election dated ${date} yet`);
  return { ok: true, snap: hits[0]! };
}

/** The unified (EA20) result file of one scope, built only from the configuration (never a guessed path). */
export function tseResultUrl(c: Pick<TseConfig, "cycle" | "electionId">, scope: string): string {
  const uf = scope.toLowerCase();
  if (!/^[a-z]{2}$/.test(uf)) throw new Error(`scope ${scope}`);
  return `https://resultados.tse.jus.br/oficial/${c.cycle}/${Number(c.electionId)}/dados/${uf}/${uf}-c0001-e${c.electionId.padStart(6, "0")}-u.json`;
}

// ---- TSE result files ----------------------------------------------------------------------------------------------

/** dvt (destino do voto) -> the candidate's status. Anything unknown is "other", which the resolver refuses to read. */
export function voteStatus(dvt: string): TseCandidate["status"] {
  const n = dvt.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  if (n === "valido") return "valid";
  if (n === "anulado") return "annulled";
  if (n === "anulado sub judice") return "sub_judice";
  return "other";
}

function candidate(c: unknown, where: string, withFullName: boolean): TseCandidate {
  if (!isObj(c)) throw new Drift(`${where} is not an object`);
  const id = str(c, "n", where);
  if (!/^\d{1,9}$/.test(id)) throw new Drift(`${where}.n ${id}`);
  const nm = decode(str(c, "nm", where));
  const nmu = withFullName ? opt(c, "nmu") : null;
  const dvt = str(c, "dvt", where);
  return { id, name: nmu ? decode(nmu) : nm, full_name: nmu ? nm : null, status: voteStatus(dvt), status_text: dvt.slice(0, 60), votes: int(c, "vap", where) };
}

/**
 * A President result file (either layout) as a snapshot. electionDay: the configuration's date of the pleito the file
 * belongs to (the file itself does not state it). Only office 1 is read.
 */
export function parseTseResult(text: string, electionDay: string): ElectionParse<TseSnapshot> {
  let root: unknown;
  try { root = JSON.parse(text); } catch { return drift("the result file is not JSON"); }
  if (!isObj(root)) return drift("the result file is not an object");
  try {
    const asOf = brasiliaIso(str(root, "dt", "file"), str(root, "ht", "file")), gen = brasiliaIso(str(root, "dg", "file"), str(root, "hg", "file"));
    if (!asOf || !gen) throw new Drift("dt/ht or dg/hg are not DD/MM/YYYY and HH:MM:SS");
    const base = {
      authority: "tse" as const, environment: str(root, "f", "file").toLowerCase(), election_id: str(root, "ele", "file"), election_day: electionDay,
      scope: str(root, "cdabr", "file").toUpperCase(), round: str(root, "t", "file"), as_of: asOf, generated_at: gen,
    };
    if (Array.isArray(root.carg)) {
      const s = root.s, e = root.e, v = root.v;
      if (!isObj(s) || !isObj(e) || !isObj(v)) throw new Drift("s, e or v is missing");
      const pres = root.carg.filter((c) => isObj(c) && c.cd === "1");
      if (pres.length !== 1) throw new Drift(`carg has ${pres.length} President entries`);
      const cands: TseCandidate[] = [];
      for (const [i, a] of (arr((pres[0] as Obj).agr) ?? []).entries()) {
        if (!isObj(a)) throw new Drift(`carg.agr[${i}]`);
        for (const [j, p] of (arr(a.par) ?? []).entries()) {
          if (!isObj(p)) throw new Drift(`carg.agr[${i}].par[${j}]`);
          for (const [k, c] of (arr(p.cand) ?? []).entries()) cands.push(candidate(c, `agr[${i}].par[${j}].cand[${k}]`, true));
        }
      }
      if (!cands.length) throw new Drift("no President candidates");
      const snap: TseSnapshot = {
        ...base, layout: "ea20", office: "1",
        flags: { tf: str(root, "tf", "file"), and: str(root, "and", "file"), dv: str(root, "dv", "file"), esae: str(root, "esae", "file"), md: opt(root, "md") },
        sections: { total: int(s, "ts", "s"), totalized: int(s, "st", "s"), not_totalized: int(s, "snt", "s") },
        electorate: int(e, "te", "e"), electorate_installed: int(e, "esi", "e"), turnout: int(e, "c", "e"),
        votes: { valid: int(v, "vv", "v"), annulled: int(v, "van", "v"), sub_judice: int(v, "vansj", "v"), blank: int(v, "vb", "v"), null: int(v, "tvn", "v"), total: int(v, "tv", "v"), counted: int(v, "vvc", "v") },
        candidates: cands,
      };
      return { ok: true, snap };
    }
    const list = arr(root.cand);
    if (!list) throw new Drift("neither carg (EA20) nor cand (2022 simplified)");
    const snap: TseSnapshot = {
      ...base, layout: "simplificado_2022", office: str(root, "carper", "file"),
      flags: { tf: str(root, "tf", "file"), and: null, dv: str(root, "dv", "file"), esae: str(root, "esae", "file"), md: opt(root, "md") },
      sections: { total: int(root, "s", "file"), totalized: int(root, "st", "file"), not_totalized: int(root, "snt", "file") },
      electorate: int(root, "e", "file"), electorate_installed: int(root, "esi", "file"), turnout: int(root, "c", "file"),
      votes: { valid: int(root, "vv", "file"), annulled: int(root, "van", "file"), sub_judice: int(root, "vansj", "file"), blank: int(root, "vb", "file"), null: int(root, "tvn", "file"), total: int(root, "tv", "file"), counted: int(root, "vvc", "file") },
      candidates: list.map((c, i) => candidate(c, `cand[${i}]`, false)),
    };
    return { ok: true, snap };
  } catch (e) {
    if (e instanceof Drift) return drift(e.message);
    throw e;
  }
}

// ---- Élections Québec ----------------------------------------------------------------------------------------------

/** "2022-10-06T11:55:41,000-04:00" -> "2022-10-06T11:55:41.000-04:00" (null when not a timestamp). */
export function eqIso(s: string): string | null {
  const t = s.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}),(\d+)/, "$1.$2");
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/.test(t) && !Number.isNaN(Date.parse(t)) ? t : null;
}

export function parseEqResults(text: string): ElectionParse<EqSnapshot> {
  let root: unknown;
  try { root = JSON.parse(text); } catch { return drift("resultats.json is not JSON"); }
  if (!isObj(root)) return drift("resultats.json is not an object");
  if (Object.keys(root).length === 0) return notYet("resultats.json is {} (no results published yet)");
  try {
    const st = root.statistiques;
    const rid = arr(root.circonscriptions);
    if (!isObj(st) || !rid) throw new Drift("statistiques or circonscriptions is missing");
    const asOf = eqIso(str(st, "iso8601DateMAJ", "statistiques"));
    if (!asOf) throw new Drift(`statistiques.iso8601DateMAJ ${String(st.iso8601DateMAJ).slice(0, 40)}`);
    if (typeof st.isResultatsFinaux !== "boolean") throw new Drift("statistiques.isResultatsFinaux is not a boolean");
    const parties = (arr(st.partisPolitiques) ?? []).map((p, i) => {
      if (!isObj(p)) throw new Drift(`partisPolitiques[${i}]`);
      return { id: int(p, "numeroPartiPolitique", `partisPolitiques[${i}]`), abbr: str(p, "abreviationPartiPolitique", `partisPolitiques[${i}]`).slice(0, 60), name: str(p, "nomPartiPolitique", `partisPolitiques[${i}]`).slice(0, 200), votes: int(p, "nbVoteTotal", `partisPolitiques[${i}]`) };
    });
    const ridings = rid.map((r, i) => {
      const w = `circonscriptions[${i}]`;
      if (!isObj(r)) throw new Drift(w);
      if (typeof r.isResultatsFinaux !== "boolean") throw new Drift(`${w}.isResultatsFinaux is not a boolean`);
      const cands = arr(r.candidats);
      if (!cands?.length) throw new Drift(`${w}.candidats is empty`);
      return {
        id: int(r, "numeroCirconscription", w), name: str(r, "nomCirconscription", w).trim(), final: r.isResultatsFinaux,
        polls_done: int(r, "nbBureauComplete", w), polls_total: int(r, "nbBureauTotal", w),
        valid: int(r, "nbVoteValide", w), rejected: int(r, "nbVoteRejete", w), cast: int(r, "nbVoteExerce", w),
        candidates: cands.map((c, j) => {
          const wc = `${w}.candidats[${j}]`;
          if (!isObj(c)) throw new Drift(wc);
          return { id: int(c, "numeroCandidat", wc), name: `${str(c, "prenom", wc)} ${str(c, "nom", wc)}`.replace(/\s+/g, " ").trim(), party: int(c, "numeroPartiPolitique", wc), votes: int(c, "nbVoteTotal", wc) };
        }),
      };
    });
    const snap: EqSnapshot = {
      authority: "eq", as_of: asOf, final: st.isResultatsFinaux,
      ridings_total: int(st, "nbCirconscription", "statistiques"), ridings_with_result: int(st, "nbCirconscriptionAvecResultat", "statistiques"), ridings_without_result: int(st, "nbCirconscriptionSansResultat", "statistiques"),
      polls_total: int(st, "nbBureauVote", "statistiques"), polls_done: int(st, "nbBureauVoteRempli", "statistiques"),
      registered: int(st, "nbElecteurInscrit", "statistiques"), cast: int(st, "nbVoteExerce", "statistiques"), valid: int(st, "nbVoteValide", "statistiques"), rejected: int(st, "nbVoteRejete", "statistiques"),
      parties, ridings,
    };
    return { ok: true, snap };
  } catch (e) {
    if (e instanceof Drift) return drift(e.message);
    throw e;
  }
}

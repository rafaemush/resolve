/**
 * SYNTHETIC Élections Québec results bodies, built from a saved one (the 2022 archive, evals/fixtures/official/) for the
 * frozen official cases and the unit tests. Every operation works on the body's JSON and must apply, or it throws; the
 * production parser (src/ingest/election-parse.ts) then reads the re-serialized body. Nothing here is a real count.
 * Node only (tests and evals); nothing here is reachable from the Worker.
 */

/**
 * Applied in this order:
 *   drop: ridings (numeroCirconscription) removed from circonscriptions; the file-wide statistics stay as they are, so
 *     the file still states its full riding count;
 *   dropRestated: ridings removed with the file-wide statistics restated as if they had never been part of the election
 *     (riding counts, polling stations, votes, electors, and each party's total and candidate count), so the file is
 *     consistent with itself;
 *   trade: in each named riding ("all": every riding) the two parties' candidates trade parties (number and
 *     abbreviation), so every riding's counts are unchanged while the riding changes hands; the two parties' totals in
 *     the statistics are restated by the votes that changed party; applied in order;
 *   votes: [numeroCandidat, count] pairs: the candidate's vote count set, with its riding's valid votes and votes cast,
 *     the file's valid votes and votes cast and its party's total moved by the same amount; applied in order;
 *   unlist: candidates (numeroCandidat) removed from their riding's list and nothing else: a riding whose candidates no
 *     longer add up to its valid votes (a truncated candidate list);
 *   copy: the ridings a stored contest keeps, standing for a stored riding copy that is not the rail's own
 *     (snapshotForSeries keeps the event's one riding). Applied by the caller to the parsed snapshot, not to the body.
 * Every operation but drop and unlist leaves the file consistent with itself (eqIntegrity), so a SYNTHETIC case fails
 * only where its title says.
 */
export interface EqOps {
  drop?: string[]; dropRestated?: string[]; trade?: Array<{ parties: [string, string]; ridings: string[] | "all" }>;
  votes?: Array<[string, number]>; unlist?: string[]; copy?: string[];
}
/** Does `ops` change the body (every operation but copy, which applies to the parsed snapshot)? */
export const eqChangesBody = (ops: EqOps | undefined): boolean => !!(ops?.drop?.length || ops?.dropRestated?.length || ops?.trade?.length || ops?.votes?.length || ops?.unlist?.length);

interface Cand { numeroCandidat: number; numeroPartiPolitique: number; abreviationPartiPolitique: string; nbVoteTotal: number }
interface Riding {
  numeroCirconscription: number; nomCirconscription: string; nbBureauComplete: number; nbBureauTotal: number;
  nbVoteValide: number; nbVoteRejete: number; nbVoteExerce: number; nbElecteurInscrit: number; candidats: Cand[];
}
interface Party { numeroPartiPolitique: number; nbVoteTotal: number; nbCandidat: number }
export interface EqBody {
  statistiques: {
    partisPolitiques: Party[]; nbBureauVote: number; nbBureauVoteRempli: number; nbVoteValide: number; nbVoteRejete: number; nbVoteExerce: number;
    nbElecteurInscrit: number; nbCirconscription: number; nbCirconscriptionAvecResultat: number; iso8601DateMAJ: string;
  };
  circonscriptions: Riding[];
}

export const eqParse = (body: string): EqBody => JSON.parse(body) as EqBody;
export const eqText = (d: EqBody): string => JSON.stringify(d, null, 2);

/** The body with every EqOps operation but copy applied (what: the body's name in an error). */
export function eqApply(body: string, ops: EqOps, what = "resultats.json"): string {
  const d = eqParse(body);
  const st = d.statistiques;
  const partyOf = (n: number, why: string): Party => {
    const p = st.partisPolitiques.filter((x) => x.numeroPartiPolitique === n);
    if (p.length !== 1) throw new Error(`${what}: ${why}: party ${n} is listed ${p.length} times in the statistics`);
    return p[0]!;
  };
  const take = (id: string, why: string): Riding => {
    const left = d.circonscriptions.filter((r) => String(r.numeroCirconscription) !== id);
    if (left.length !== d.circonscriptions.length - 1) throw new Error(`${what}: ${why} ${id}: ${d.circonscriptions.length - left.length} ridings carry that number`);
    const gone = d.circonscriptions.find((r) => String(r.numeroCirconscription) === id)!;
    d.circonscriptions = left;
    return gone;
  };
  for (const id of ops.drop ?? []) take(id, "drop");
  for (const id of ops.dropRestated ?? []) {
    const r = take(id, "dropRestated");
    st.nbCirconscription--; st.nbCirconscriptionAvecResultat--;
    st.nbBureauVote -= r.nbBureauTotal; st.nbBureauVoteRempli -= r.nbBureauComplete;
    st.nbVoteValide -= r.nbVoteValide; st.nbVoteRejete -= r.nbVoteRejete; st.nbVoteExerce -= r.nbVoteExerce; st.nbElecteurInscrit -= r.nbElecteurInscrit;
    for (const c of r.candidats) { const p = partyOf(c.numeroPartiPolitique, `dropRestated ${id}`); p.nbVoteTotal -= c.nbVoteTotal; p.nbCandidat--; }
  }
  for (const t of ops.trade ?? []) {
    const ridings = t.ridings === "all" ? d.circonscriptions : t.ridings.map((id) => {
      const r = d.circonscriptions.filter((x) => String(x.numeroCirconscription) === id);
      if (r.length !== 1) throw new Error(`${what}: trade: riding ${id} is listed ${r.length} times`);
      return r[0]!;
    });
    for (const r of ridings) {
      const of = (p: string) => r.candidats.filter((c) => String(c.numeroPartiPolitique) === p);
      const a = of(t.parties[0]), b = of(t.parties[1]);
      if (a.length !== 1 || b.length !== 1) throw new Error(`${what}: trade: riding ${r.numeroCirconscription} has ${a.length} and ${b.length} candidates of parties ${t.parties.join(" and ")}`);
      const x = a[0]!, y = b[0]!;
      const was = { n: x.numeroPartiPolitique, abbr: x.abreviationPartiPolitique };
      // x's votes move from x's old party to y's, y's the other way
      const px = partyOf(x.numeroPartiPolitique, "trade"), py = partyOf(y.numeroPartiPolitique, "trade");
      px.nbVoteTotal += y.nbVoteTotal - x.nbVoteTotal; py.nbVoteTotal += x.nbVoteTotal - y.nbVoteTotal;
      x.numeroPartiPolitique = y.numeroPartiPolitique; x.abreviationPartiPolitique = y.abreviationPartiPolitique;
      y.numeroPartiPolitique = was.n; y.abreviationPartiPolitique = was.abbr;
    }
  }
  for (const [id, to] of ops.votes ?? []) {
    if (!Number.isSafeInteger(to) || to < 0) throw new Error(`${what}: votes: candidate ${id} set to ${to}`);
    const hits = d.circonscriptions.flatMap((r) => r.candidats.filter((c) => String(c.numeroCandidat) === id).map((c) => ({ r, c })));
    if (hits.length !== 1) throw new Error(`${what}: votes: candidate ${id} is listed ${hits.length} times`);
    const { r, c } = hits[0]!;
    const by = to - c.nbVoteTotal;
    c.nbVoteTotal = to;
    r.nbVoteValide += by; r.nbVoteExerce += by; st.nbVoteValide += by; st.nbVoteExerce += by;
    partyOf(c.numeroPartiPolitique, `votes ${id}`).nbVoteTotal += by;
  }
  for (const id of ops.unlist ?? []) {
    const rs = d.circonscriptions.filter((r) => r.candidats.some((c) => String(c.numeroCandidat) === id));
    if (rs.length !== 1 || rs[0]!.candidats.filter((c) => String(c.numeroCandidat) === id).length !== 1) throw new Error(`${what}: unlist: candidate ${id} is not listed exactly once`);
    rs[0]!.candidats = rs[0]!.candidats.filter((c) => String(c.numeroCandidat) !== id);
  }
  return eqText(d);
}

/**
 * 33 ridings of the 2022 archive the CAQ won by more than 1% of the votes cast. With the CAQ's and the PLQ's candidates
 * trading parties in them, the CAQ holds 55 seats outright and 57 with Beauce-Nord and Fabre (both inside the 1% margin),
 * the PLQ 54 and 55 with Fabre: which of the two has the most seats is not settled.
 */
export const QC_TOP_TIE_RIDINGS = [
  "104", "110", "120", "126", "132", "138", "144", "150", "204", "206", "210", "212", "216", "218", "220", "226", "230",
  "232", "238", "240", "244", "246", "250", "252", "256", "258", "260", "264", "366", "380", "454", "470", "476",
];

/** Riding and candidate numbers no 2022 or 2026 riding or candidate carries (the invented ridings of eqAs2026). */
const INVENTED = [{ riding: 901, name: "Circonscription synthétique A", from: 0 }, { riding: 903, name: "Circonscription synthétique B", from: 1 }];

/**
 * A saved final file restated as a file of the 2026-10-05 election: stamped after the 2026 polls closed and brought to
 * `ridings` ridings (the 2026 map has 127) by invented ridings, each a copy of one of the file's first ridings under an
 * unused riding number and unused candidate numbers, with every file-wide total and party total moved with it.
 */
export function eqAs2026(body: string, ridings = 127, stamp = "2026-10-05T23:30:00,000-04:00"): EqBody {
  const d = eqParse(body);
  const add = ridings - d.circonscriptions.length;
  if (add < 0 || add > INVENTED.length) throw new Error(`eqAs2026: from ${d.circonscriptions.length} to ${ridings} ridings`);
  const taken = new Set(d.circonscriptions.flatMap((r) => [r.numeroCirconscription, ...r.candidats.map((c) => c.numeroCandidat)]));
  const st = d.statistiques;
  for (const [i, inv] of INVENTED.slice(0, add).entries()) {
    const src = d.circonscriptions[inv.from]!;
    const copy = JSON.parse(JSON.stringify(src)) as Riding;
    copy.numeroCirconscription = inv.riding;
    copy.nomCirconscription = inv.name;
    copy.candidats.forEach((c, j) => { c.numeroCandidat = 9000 + 100 * i + j; });
    if ([copy.numeroCirconscription, ...copy.candidats.map((c) => c.numeroCandidat)].some((n) => taken.has(n))) throw new Error(`eqAs2026: number already used in riding ${inv.riding}`);
    d.circonscriptions.push(copy);
    st.nbCirconscription++; st.nbCirconscriptionAvecResultat++;
    st.nbBureauVote += copy.nbBureauTotal; st.nbBureauVoteRempli += copy.nbBureauComplete;
    st.nbVoteValide += copy.nbVoteValide; st.nbVoteRejete += copy.nbVoteRejete; st.nbVoteExerce += copy.nbVoteExerce; st.nbElecteurInscrit += copy.nbElecteurInscrit;
    for (const c of copy.candidats) {
      const p = st.partisPolitiques.find((x) => x.numeroPartiPolitique === c.numeroPartiPolitique);
      if (!p) throw new Error(`eqAs2026: party ${c.numeroPartiPolitique} is not in the file's list`);
      p.nbVoteTotal += c.nbVoteTotal; p.nbCandidat++;
    }
  }
  st.iso8601DateMAJ = stamp;
  return d;
}

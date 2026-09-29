/**
 * SYNTHETIC Élections Québec results bodies, built from a saved one (the 2022 archive, evals/fixtures/official/) for the
 * frozen official cases and the unit tests. Every operation works on the body's JSON and must apply, or it throws; the
 * production parser (src/ingest/election-parse.ts) then reads the re-serialized body. Nothing here is a real count.
 * Node only (tests and evals); nothing here is reachable from the Worker.
 */

/**
 *   drop: ridings (numeroCirconscription) removed from circonscriptions; the file-wide statistics stay as they are, so
 *     the file still states its full riding count;
 *   trade: in each named riding ("all": every riding) the two parties' candidates trade parties (number and
 *     abbreviation), so every vote count and every total is unchanged while the riding changes hands; applied in order;
 *   copy: the ridings a stored contest keeps, standing for a stored riding copy that is not the rail's own
 *     (snapshotForSeries keeps the event's one riding). Applied by the caller to the parsed snapshot, not to the body.
 */
export interface EqOps { drop?: string[]; trade?: Array<{ parties: [string, string]; ridings: string[] | "all" }>; copy?: string[] }

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

/** The body with EqOps.drop and EqOps.trade applied (what: the body's name in an error). */
export function eqApply(body: string, ops: EqOps, what = "resultats.json"): string {
  const d = eqParse(body);
  for (const id of ops.drop ?? []) {
    const left = d.circonscriptions.filter((r) => String(r.numeroCirconscription) !== id);
    if (left.length !== d.circonscriptions.length - 1) throw new Error(`${what}: drop ${id}: ${d.circonscriptions.length - left.length} ridings carry that number`);
    d.circonscriptions = left;
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
      x.numeroPartiPolitique = y.numeroPartiPolitique; x.abreviationPartiPolitique = y.abreviationPartiPolitique;
      y.numeroPartiPolitique = was.n; y.abreviationPartiPolitique = was.abbr;
    }
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

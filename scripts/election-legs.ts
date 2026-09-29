/**
 * Suggested registrations for the legs of the Polymarket Brazil 2026 first-round and Quebec 2026 general-election events
 * on the official_release rail's election series (src/resolve/election.ts), and the seed-shadow file of those that may be
 * registered. Nothing is registered here.
 *
 *   npx tsx scripts/election-legs.ts [--live] [--tse-registry <registry.json>] [--gamma-dir <dir>] [--eq-candidatures <file>]
 *       [--out <legs.json>] [--seed-out <seed.json>]
 *
 * Inputs (absolute paths under the gitignored private/ folder of the main checkout, never the worktree):
 *   - the gamma events (default: the copies saved 2026-09-27T22:43Z..22:45Z in private/election-fixtures/gamma-events-2026-09-28/;
 *     --live re-reads https://gamma-api.polymarket.com/events?slug=<slug> at most once a second and saves the bodies);
 *   - Élections Québec's accepted candidacies (candidatures.json; default the copy saved 2026-09-27T22:51Z; --live re-reads it);
 *   - the TSE candidate registry: --tse-registry names a JSON {source_url, fetched_at, election_day, file} where file is a TSE
 *     result file of the 2026 President first round saved from a tse.jus.br host (it lists every candidate's ballot number and
 *     names). Without it every Brazilian leg that names a candidate is refused: its subject cannot be pinned to a TSE number.
 * Outputs: private/shadow-markets/election-legs-2026-09-28.json (every leg, built or refused, with reasons) and
 * private/shadow-markets/seed-election-polymarket-2026-09-28.json (scripts/seed-shadow.ts format: approved only for legs of a
 * decidable event type at or under the $50k cap; the others approved:false with the reason; refused legs listed in the header).
 * A leg whose text settles on "a consensus of credible reporting" (the authority only if there is ambiguity) carries
 * "criteria_basis": "consensus_reporting" in both files; scripts/seed-shadow.ts holds those back unless the founder passes
 * --accept-consensus-reading. Nothing is written when two Polymarket events would share one event key, or one event would
 * map to two (legsWithOneKeyPerEvent, src/markets/election-legs.ts).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { buildElectionLeg, eqRegistryFromCandidatures, tseRegistryFromSnapshot, legsWithOneKeyPerEvent, criteriaBasis, type ElectionEventInput, type Registries, type TseRegistry } from "../src/markets/election-legs";
import { ELECTION_SERIES, electionEvent, normName, QC_RIDINGS, BR_UF_NAMES, type ElectionSeriesId } from "../src/resolve/election";
import { knownRelease } from "../src/resolve/official";
import { parseTseResult } from "../src/ingest/election-parse";
import { validateRegistration } from "../src/markets/register";
import { eventKey } from "../src/markets/event-key";
import { OFFICIAL_UA } from "../src/ingest/official";
import { SHADOW_VOLUME_CAP_USD, checkCandidateFile } from "./lib/seed-shadow";
import type { MarketRegistration } from "../src/resolve/schema";

const PRIVATE = "/Users/rafaemush/Desktop/Jev Oracle AI/private";
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const LIVE = process.argv.includes("--live");
const GAMMA_DIR = arg("--gamma-dir") ?? `${PRIVATE}/election-fixtures/gamma-events-2026-09-28`;
const EQ_FILE = arg("--eq-candidatures") ?? `${PRIVATE}/election-fixtures/eq-2026-09-28/candidatures.json.raw`;
const EQ_FETCHED = "2026-09-27T22:51:18Z";
const EQ_URL = "https://donnees.electionsquebec.qc.ca/production/provincial/candidatures/candidatures.json";
const OUT = arg("--out") ?? `${PRIVATE}/shadow-markets/election-legs-2026-09-28.json`;
const SEED_OUT = arg("--seed-out") ?? `${PRIVATE}/shadow-markets/seed-election-polymarket-2026-09-28.json`;
const TSE_REGISTRY = arg("--tse-registry");
/** Every TSE host answered 403 to this machine (research 2026-09-27; re-checked 2026-09-27T23:34:00Z divulgacandcontas, 23:34:04Z resultados). */
const TSE_UNAVAILABLE = "every TSE host answered HTTP 403 to ResolveBot from the founder's machine (divulgacandcontas.tse.jus.br and resultados.tse.jus.br OBSERVED 2026-09-27T23:34Z; the other hosts 22:48Z..23:25Z), so the 2026 candidates' ballot numbers were not observed; rerun with --tse-registry once a TSE file listing them is saved";

// ---- event types ------------------------------------------------------------------------------------------------------

const UF_SLUG: Record<string, keyof typeof BR_UF_NAMES> = {
  acre: "AC", alagoas: "AL", amapa: "AP", amazonas: "AM", bahia: "BA", ceara: "CE", "federal-district": "DF", "espirito-santo": "ES", goias: "GO",
  maranhao: "MA", "mato-grosso": "MT", "mato-grosso-do-sul": "MS", "minas-gerais": "MG", para: "PA", paraiba: "PB", parana: "PR", pernambuco: "PE",
  piaui: "PI", "rio-de-janeiro": "RJ", "rio-grande-do-norte": "RN", "rio-grande-do-sul": "RS", rondonia: "RO", roraima: "RR", "santa-catarina": "SC",
  "sao-paulo": "SP", sergipe: "SE", tocantins: "TO",
};
/** Event types that are NOT registered, and why (criteria the rail cannot compute exactly from the authority's count). */
const REFUSED_TYPES: Array<{ type: string; test: RegExp; reason: string }> = [
  { type: "br_chamber_most_seats", test: /^brazil-chamber-of-deputies-election-winner$/, reason: "counts seats per party OR electoral federation across all 27 states (legs mix parties and federations such as UPB, FE Brasil, PSDB-CIDADANIA); the TSE count gives elected candidates by party, and the federation grouping of the 2026 lists was not observed from a TSE source (403), so the winner cannot be computed exactly" },
  { type: "br_senate_most_seats", test: /^next-brazil-senate-election-most-seats-held$/, reason: "counts ALL 81 seats including the 27 not contested in 2026 (\"All seats, not only the ones contested\"), by the party each senator holds after the election; the TSE count covers only the 54 contested seats" },
  { type: "qc_turnout", test: /^quebec-general-election-turnout$/, reason: "defines turnout as votes cast over ELIGIBLE voters, while Élections Québec publishes votes cast over REGISTERED electors (OBSERVED on the 2022 results page the text cites); eligible voters are not in the feed, so the text's number cannot be computed exactly" },
];
type Typed = { type: string; series: ElectionSeriesId; party?: string };
function classify(slug: string, body: Record<string, unknown>): Typed | { refused: string; type: string } | null {
  for (const r of REFUSED_TYPES) if (r.test.test(slug)) return { refused: r.reason, type: r.type };
  let m: RegExpExecArray | null;
  if ((m = /^brazil-presidential-election-first-round-1st-place-in-(.+)$/.exec(slug))) { const uf = UF_SLUG[m[1]!]; return uf ? { type: "br_pres_r1_first_place_state", series: `br_pres_r1_first_${uf.toLowerCase()}` as ElectionSeriesId } : null; }
  const br: Record<string, [string, ElectionSeriesId]> = {
    "brazil-presidential-election-first-round-winner": ["br_pres_r1_winner_national", "br_pres_r1_winner"],
    "brazil-presidential-election-first-round-3rd-place": ["br_pres_r1_third_place", "br_pres_r1_third"],
    "brazil-presidential-election-first-round-4th-place": ["br_pres_r1_fourth_place", "br_pres_r1_fourth"],
    "brazil-presidential-election-first-round-margin-of-victory": ["br_pres_r1_margin_of_victory", "br_pres_r1_margin"],
    "brazil-presidential-election-first-round-turnout": ["br_pres_r1_turnout", "br_pres_r1_turnout"],
    "brazil-presidential-election-first-round-lula-da-silva-vote-share": ["br_pres_r1_vote_share", "br_pres_r1_share_lula"],
    "brazil-presidential-election-first-round-flavio-bolsonaro-vote-share": ["br_pres_r1_vote_share", "br_pres_r1_share_flavio_bolsonaro"],
    "brazil-presidential-election-first-round-renan-santos-vote-share": ["br_pres_r1_vote_share", "br_pres_r1_share_renan_santos"],
    "brazil-presidential-election-first-round-augusto-cury-vote-share": ["br_pres_r1_vote_share", "br_pres_r1_share_augusto_cury"],
  };
  if (br[slug]) return { type: br[slug]![0], series: br[slug]![1] };
  if ((m = /^(.+)-quebec-national-assembly-election-winner$/.exec(slug))) {
    const code = Object.entries(QC_RIDINGS).find(([, n]) => normName(n) === normName(m![1]!.replace(/-/g, " ")))?.[0];
    return code ? { type: "qc_riding_winner", series: `qc_riding_${code}` as ElectionSeriesId } : null;
  }
  const desc = String(body.description ?? "");
  const named = /\bthe ([A-ZÉ][^()]{3,60}?) \(([A-Z]{2,5})\)/.exec(desc)?.[1];
  const qc: Record<string, [string, ElectionSeriesId]> = {
    "of-seats-won-by-caq-in-the-2026-quebec-general-election": ["qc_seats_per_party", "qc_seats_caq"],
    "of-seats-won-by-pq-in-the-2026-quebec-general-election": ["qc_seats_per_party", "qc_seats_pq"],
    "of-seats-won-by-plq-in-the-2026-quebec-general-election": ["qc_seats_per_party", "qc_seats_plq"],
    "of-seats-won-by-pcq-in-the-2026-quebec-general-election": ["qc_seats_per_party", "qc_seats_pcq"],
    "will-the-pq-win-a-majority-in-the-2026-quebec-general-election": ["qc_pq_majority", "qc_pq_majority"],
    "will-pvq-win-a-seat-in-the-2026-quebec-general-election": ["qc_pvq_wins_seat", "qc_pvq_seat"],
  };
  if (qc[slug]) return { type: qc[slug]![0], series: qc[slug]![1], ...(named ? { party: named } : {}) };
  if (/^quebec-general-election-second-place-/.test(slug)) return { type: "qc_rank_2nd_3rd", series: "qc_second_place" };
  if (/^quebec-general-election-third-place-/.test(slug)) return { type: "qc_rank_2nd_3rd", series: "qc_third_place" };
  if (/^quebec-general-election-of-seats-margin-of-victory/.test(slug)) return { type: "qc_seat_margin", series: "qc_seat_margin", party: "PQ" };
  return null;
}

// ---- inputs -----------------------------------------------------------------------------------------------------------

const sources: Array<{ url: string; http_status: number | null; fetched_at: string; note?: string }> = [];
let last = 0;
async function getText(url: string): Promise<{ status: number | null; text: string | null; fetched_at: string }> {
  const wait = last + 1100 - Date.now(); // at most one request per second
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const fetched_at = new Date().toISOString();
  try {
    const r = await fetch(url, { headers: { "User-Agent": OFFICIAL_UA, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    sources.push({ url, http_status: r.status, fetched_at });
    return { status: r.status, text: r.status === 200 ? await r.text() : null, fetched_at };
  } catch (e) {
    sources.push({ url, http_status: null, fetched_at, note: String(e).slice(0, 160) });
    return { status: null, text: null, fetched_at };
  }
}

interface SavedEvent { fetched_at: string; url: string; status: number; body: Array<Record<string, unknown>> }
async function loadEvents(): Promise<Array<{ slug: string; fetched_at: string; url: string; event: Record<string, unknown> }>> {
  const files = readdirSync(GAMMA_DIR).filter((f) => f.endsWith(".json")).sort();
  const out: Array<{ slug: string; fetched_at: string; url: string; event: Record<string, unknown> }> = [];
  const liveDir = LIVE ? `${PRIVATE}/election-fixtures/gamma-events-${new Date().toISOString().slice(0, 10)}-live` : null;
  if (liveDir) mkdirSync(liveDir, { recursive: true });
  for (const f of files) {
    const saved = JSON.parse(readFileSync(resolve(GAMMA_DIR, f), "utf8")) as SavedEvent;
    const slug = basename(f, ".json");
    if (!LIVE) {
      const event = saved.body?.[0];
      if (event) { out.push({ slug, fetched_at: saved.fetched_at, url: saved.url, event }); sources.push({ url: saved.url, http_status: saved.status, fetched_at: saved.fetched_at, note: "saved copy" }); }
      continue;
    }
    const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
    const g = await getText(url);
    const body = g.text ? (JSON.parse(g.text) as Array<Record<string, unknown>>) : null;
    if (!body?.[0]) { console.log(`live: ${slug} HTTP ${g.status}; using the saved copy of ${saved.fetched_at}`); out.push({ slug, fetched_at: saved.fetched_at, url: saved.url, event: saved.body[0]! }); continue; }
    writeFileSync(resolve(liveDir!, f), JSON.stringify({ fetched_at: g.fetched_at, url, status: g.status, body }));
    out.push({ slug, fetched_at: g.fetched_at, url, event: body[0] });
  }
  return out;
}

async function loadRegistries(): Promise<{ reg: Registries; notes: string[] }> {
  const notes: string[] = [];
  let eqText = readFileSync(EQ_FILE, "utf8"), eqAt = EQ_FETCHED;
  if (LIVE) {
    const g = await getText(EQ_URL);
    if (g.text) { eqText = g.text; eqAt = g.fetched_at; writeFileSync(`${PRIVATE}/election-fixtures/eq-2026-09-28/candidatures.live-${g.fetched_at.slice(0, 19).replace(/:/g, "")}.json`, g.text); }
    else notes.push(`live candidatures.json answered HTTP ${g.status}; the saved copy of ${EQ_FETCHED} was used`);
  }
  const eq = eqRegistryFromCandidatures(JSON.parse(eqText), EQ_URL, eqAt);
  let tse: TseRegistry | null = null;
  if (TSE_REGISTRY) {
    const spec = JSON.parse(readFileSync(TSE_REGISTRY, "utf8")) as { source_url: string; fetched_at: string; election_day: string; file: string };
    const p = parseTseResult(readFileSync(spec.file, "utf8"), spec.election_day);
    if (!p.ok) throw new Error(`--tse-registry ${spec.file}: ${p.reason} ${p.detail}`);
    if (p.snap.environment !== "o") throw new Error(`--tse-registry ${spec.file} is a ${p.snap.environment} (not official) file`);
    tse = tseRegistryFromSnapshot(p.snap, spec.source_url, spec.fetched_at);
    notes.push(`TSE registry: ${tse.candidates.length} candidates from ${tse.source_url} (${tse.fetched_at})`);
  } else notes.push(`TSE registry: none. ${TSE_UNAVAILABLE}`);
  return { reg: { eq, tse, tseUnavailable: TSE_UNAVAILABLE }, notes };
}

// ---- main -------------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const iso = (v: unknown) => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : undefined; };
interface Entry { market: MarketRegistration; meta: Obj; volume_usd: number; approved: boolean; reason?: string; event_type: string; event_id: string; event_key: string; criteria_basis?: "consensus_reporting" }
interface Refused { event_id: string; event_slug: string; event_type: string; leg_id: string; label: string | null; volume_usd: number; reason: string }

async function main() {
  const events = await loadEvents();
  const { reg, notes } = await loadRegistries();
  const built: Entry[] = [];
  const refused: Refused[] = [];
  const types = new Map<string, { type: string; decidable: boolean; reason?: string; events: Set<string>; legs: number; built: number; approved: number }>();
  const typeRow = (type: string, decidable: boolean, reason?: string) => { if (!types.has(type)) types.set(type, { type, decidable, reason, events: new Set(), legs: 0, built: 0, approved: 0 }); return types.get(type)!; };

  for (const { slug, event } of events) {
    const c = classify(slug, event);
    const eventId = String(event.id ?? "");
    const legs = (Array.isArray(event.markets) ? (event.markets as Obj[]) : []).filter((m) => m.active === true && m.closed !== true);
    if (!c) { notes.push(`${slug}: not an event of the election rail; skipped`); continue; }
    if ("refused" in c) {
      const row = typeRow(c.type, false, c.refused); row.events.add(eventId);
      for (const m of legs) { row.legs++; refused.push({ event_id: eventId, event_slug: slug, event_type: c.type, leg_id: String(m.id), label: typeof m.groupItemTitle === "string" && m.groupItemTitle ? m.groupItemTitle : null, volume_usd: Number(m.volumeNum ?? 0), reason: `event type not registered: ${c.refused}` }); }
      continue;
    }
    const def = ELECTION_SERIES[c.series];
    const day = electionEvent(def.authority, def.authority === "tse" ? "2026-10-04" : "2026-10-05")!.day;
    const known = knownRelease(c.series, day)!;
    const row = typeRow(c.type, true); row.events.add(eventId);
    const labels = legs.map((m) => (typeof m.groupItemTitle === "string" && m.groupItemTitle ? m.groupItemTitle : null));
    const ev: ElectionEventInput = { series: c.series, period: day, release_at: known.release_at, title: String(event.title ?? slug), criteria: String(event.description ?? ""), labels, ...(c.party ? { party: c.party } : {}) };
    for (const m of legs) {
      row.legs++;
      const label = typeof m.groupItemTitle === "string" && m.groupItemTitle ? m.groupItemTitle : null;
      const volume = Number(m.volumeNum ?? 0);
      const refuse = (reason: string) => refused.push({ event_id: eventId, event_slug: slug, event_type: c.type, leg_id: String(m.id), label, volume_usd: volume, reason });
      const open_at = iso(m.startDate ?? m.createdAt ?? event.startDate), deadline = iso(m.endDate ?? event.endDate);
      if (!open_at || !deadline) { refuse("no start or end time on the platform object"); continue; }
      const legCriteria = String(m.description ?? event.description ?? "");
      const b = buildElectionLeg(ev, { external_id: String(m.id), label, open_at, deadline_utc: deadline, criteria: legCriteria }, reg);
      if (!b.ok) { refuse(b.reason); continue; }
      try { validateRegistration(b.market); } catch (e) { refuse(String(e).slice(0, 400)); continue; }
      const meta: Obj = { condition_id: String(m.conditionId ?? "").toLowerCase(), slug: m.slug ?? null, event_id: eventId, category: "election_result" };
      if (typeof m.questionID === "string" && /^0x[0-9a-fA-F]{64}$/.test(m.questionID)) meta.question_id = m.questionID.toLowerCase();
      if (typeof m.negRisk === "boolean") meta.neg_risk = m.negRisk;
      const key = eventKey({ platform: "polymarket", external_id: String(m.id), resolver: b.market.resolver, meta });
      const over = volume > SHADOW_VOLUME_CAP_USD;
      row.built++; if (!over) row.approved++;
      // a text that settles on "a consensus of credible reporting" is marked, never decided here (seed-shadow holds it back)
      const basis = criteriaBasis(legCriteria);
      built.push({ market: b.market, meta, volume_usd: volume, approved: !over, ...(over ? { reason: `volume $${volume.toFixed(2)} is over the $${SHADOW_VOLUME_CAP_USD} shadow cap` } : {}), event_type: c.type, event_id: eventId, event_key: key, ...(basis ? { criteria_basis: basis } : {}) });
    }
  }

  // every Polymarket event is its own public event key, and no key is shared by two events: it throws otherwise, and
  // nothing below (neither file) is written
  const entries = legsWithOneKeyPerEvent(built);

  const now = new Date().toISOString();
  const typeRows = [...types.values()].map((t) => ({ type: t.type, decidable: t.decidable, ...(t.reason ? { reason: t.reason } : {}), events: t.events.size, legs: t.legs, legs_built: t.built, legs_approved: t.approved }));
  const counts = {
    events: new Set([...types.values()].flatMap((t) => [...t.events])).size,
    events_with_built_legs: new Set(entries.map((e) => e.event_id)).size, legs: entries.length + refused.length, legs_built: entries.length,
    legs_approved: entries.filter((e) => e.approved).length, legs_over_cap: entries.filter((e) => !e.approved).length, legs_refused: refused.length,
    legs_consensus_reporting: entries.filter((e) => e.criteria_basis === "consensus_reporting").length,
  };
  const doc = { generated_at: now, private: "Copies Polymarket market texts: keep under the gitignored private/ folder only.", sources, registries: { eq: { source_url: reg.eq!.source_url, fetched_at: reg.eq!.fetched_at, candidates: reg.eq!.candidates.length, parties: reg.eq!.parties.length }, tse: reg.tse ? { source_url: reg.tse.source_url, fetched_at: reg.tse.fetched_at, candidates: reg.tse.candidates.length } : null }, counts, event_types: typeRows, notes, entries, refused };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(doc, null, 1) + "\n");

  const seed = {
    header: {
      platform: "polymarket", generated_at: now, source_url: OUT,
      filters: { resolver: "official_release", category: "election_result", series: [...new Set(entries.map((e) => (e.market.resolver as { series: string }).series))].sort() },
      counts: { entries: entries.length, approved: counts.legs_approved, over_cap: counts.legs_over_cap, refused_legs: refused.length, consensus_reporting: counts.legs_consensus_reporting },
      needs_founder_approval: false,
      approval_basis: "structured election legs (official_release election series, src/resolve/election.ts): approved only when the event type is decidable from the authority's final count and the leg's volume is at or under the $50k shadow cap",
      requires: [
        "the Worker built from feat/election-rail deployed (the election series, the election_exact rounding and the election resolver field); migrations 016 and 017 applied (no new migration)",
        "a founder-visible access test before 2026-10-04: POST /internal/official/probe {\"group\":\"elections\"} on the deployed Worker, which GETs https://resultados.tse.jus.br/oficial/comum/config/ele-c.json and https://donnees.electionsquebec.qc.ca/production/provincial/resultats/resultats.json, the rail's own first requests (UNVERIFIED: the TSE hosts answered 403 to this machine; a refused Worker leaves the TSE legs pending, never resolved)",
        "Élections Québec's licence: its attribution notice must be shown at all times wherever the data is used (the rail puts it in every Quebec observation's deciding text; the channel and public pages are the founder's call)",
        "a founder policy decision on entries marked criteria_basis consensus_reporting (the market settles on a consensus of credible reporting and turns to the authority only if there is ambiguity, while the rail reads the authority's final count): scripts/seed-shadow.ts holds every such entry back, in --check and in real runs, unless --accept-consensus-reading is passed",
      ],
      refused_legs: refused,
      event_types: typeRows,
    },
    entries: entries.map((e) => ({ approved: e.approved, needs_review: [], volume_usd: e.volume_usd, ...(e.reason ? { reason: e.reason } : {}), event_type: e.event_type, event_key: e.event_key, ...(e.criteria_basis ? { criteria_basis: e.criteria_basis } : {}), registration: { market: e.market, meta: e.meta, is_test: false } })),
  };
  const check = checkCandidateFile(seed, new Date());
  if (check.fileErrors.length || check.approvedInvalid) throw new Error(`seed file fails seed-shadow --check: ${[...check.fileErrors, ...check.entries.filter((x) => x.approved && x.errors.length).map((x) => `#${x.index} ${x.external_id}: ${x.errors.join("; ")}`)].slice(0, 5).join(" | ")}`);
  writeFileSync(SEED_OUT, JSON.stringify(seed, null, 1) + "\n");

  console.log(`election legs: events=${counts.events} legs=${counts.legs} built=${counts.legs_built} approved=${counts.legs_approved} over_cap=${counts.legs_over_cap} refused=${counts.legs_refused} consensus_reporting=${counts.legs_consensus_reporting}`);
  for (const t of typeRows) console.log(`  ${t.decidable ? "decidable" : "REFUSED  "} ${t.type.padEnd(30)} events=${t.events} legs=${t.legs} built=${t.legs_built} approved=${t.legs_approved}${t.reason ? ` :: ${t.reason.slice(0, 90)}` : ""}`);
  const why = new Map<string, number>();
  for (const r of refused) { const k = r.reason.startsWith("no TSE candidate registry") ? "no TSE candidate registry (TSE 403)" : r.reason.startsWith("event type not registered") ? `type not registered: ${r.event_type}` : r.reason.slice(0, 110); why.set(k, (why.get(k) ?? 0) + 1); }
  for (const [k, n] of why) console.log(`  refused x${n}: ${k}`);
  for (const n of notes) console.log(`note: ${n.slice(0, 300)}`);
  console.log(`-> ${OUT}\n-> ${SEED_OUT}`);
  if (!existsSync(SEED_OUT)) process.exit(1);
}
main().catch((e) => { console.error(String(e)); process.exit(1); });

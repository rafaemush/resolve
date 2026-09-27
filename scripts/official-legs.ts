/**
 * Suggested registrations for every leg of the official_release ladders: the eight Limitless manual negRisk groups
 * and their Polymarket mirrors, and the Polymarket-only BLS ladders (CPI 1-month and core, unemployment rate,
 * payrolls). Nothing is registered: every entry is approved:false for the founder.
 *   npx tsx scripts/official-legs.ts [--only <series>[,<series>...]] [--out private/shadow-markets/official-release-2026-09-24.json]
 *   npx tsx scripts/official-legs.ts --only us_cpi_u_sa_mom,us_core_cpi_nsa_yoy,us_core_cpi_sa_mom,us_unemployment_rate,us_nonfarm_payrolls_change --out private/shadow-markets/official-release-bls-2026-09-27.json
 * Read-only public GETs at most one per second: api.limitless.exchange/markets/<group slug> (X-API-Key only when
 * LIMITLESS_API_KEY is set; never printed) and gamma-api.polymarket.com/events?slug=<the group's externalSlug, or the
 * Polymarket-only group's event slug>. The resolver fields (period, release_at, prior_level) come from the event
 * registry (official schedules, src/resolve/official.ts KNOWN_RELEASES); the bucket comes from each option's own
 * title; rounding from the series. The output copies platform market texts: it belongs under private/ only.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnv } from "./lib/env";
import { buildLegRegistration, type LegGroup } from "../src/markets/official-legs";
import { limitlessLabels, limitlessOutcomeIndex } from "../src/markets/outcomes";
import { validateRegistration } from "../src/markets/register";
import { UNSUPPORTED_OFFICIAL_SERIES, knownRelease } from "../src/resolve/official";
import { OFFICIAL_UA } from "../src/ingest/official";
import type { MarketRegistration } from "../src/resolve/schema";

/** slug: a Limitless group (its Polymarket mirror is found through externalSlug); pmSlug: a Polymarket-only event. */
interface Group extends LegGroup { slug?: string; pmSlug?: string; basis: string }

/** release_at comes from the event registry (src/resolve/official.ts KNOWN_RELEASES): registration refuses any other. */
const scheduled = (series: LegGroup["series"], period: string): string => {
  const k = knownRelease(series, period);
  if (!k) throw new Error(`${series}:${period} is not in KNOWN_RELEASES`);
  return k.release_at;
};

const GROUPS: Group[] = [
  { slug: "september-inflation-us-annual-1789462576803", series: "us_cpi_u_nsa_yoy", period: "2026-09", release_at: scheduled("us_cpi_u_nsa_yoy", "2026-09"), title: "September Inflation US - Annual",
    basis: "BLS CPI schedule: September 2026 -> Oct. 14, 2026 08:30 AM ET (observed)" },
  { slug: "ppi-yoy-september-2026-1789463068607", series: "us_ppi_fd_nsa_yoy", period: "2026-09", release_at: scheduled("us_ppi_fd_nsa_yoy", "2026-09"), title: "PPI YoY - September 2026",
    basis: "BLS PPI schedule: September 2026 -> Oct. 15, 2026 08:30 AM ET (observed)" },
  { slug: "bank-of-korea-decision-in-october-1788169618885", series: "bok_base_rate", period: "2026-10-22", release_at: scheduled("bok_base_rate", "2026-10-22"), prior_level: 3.0, title: "Bank of Korea decision in October?",
    basis: "BoK 2026 MPB dates PDF: October Thursday 22 (observed); 10:00 KST decision time UNVERIFIED (earlier decision items are stamped 10:30 KST); prior 3.00% (raised 2026-08-27)" },
  { slug: "south-korea-gdp-growth-yoy-in-q3-2026-1786348145771", series: "kr_gdp_advance_yoy", period: "2026-Q3", release_at: scheduled("kr_gdp_advance_yoy", "2026-Q3"), title: "South Korea GDP growth (YoY) in Q3 2026?",
    basis: "BoK statistical calendar: 2026-10-27 08:00 KST Real GDP Q3 advance (observed)" },
  { slug: "fed-decision-in-october-1786349804918", series: "fomc_upper_bound", period: "2026-10-28", release_at: scheduled("fomc_upper_bound", "2026-10-28"), prior_level: 4.0, title: "Fed Decision in October?",
    basis: "FOMC calendar: October 27-28 (observed); 2:00 p.m. EDT statement time from the September statement (UNVERIFIED for October); prior upper bound 4.00 (September 16)" },
  { slug: "ecb-interest-rates-october-2026-1789050608644", series: "ecb_dfr", period: "2026-10-29", release_at: scheduled("ecb_dfr", "2026-10-29"), prior_level: 2.5, title: "ECB Interest Rates: October 2026",
    basis: "ECB calendar: 29/10/2026 meeting day 2 (observed); 14:15 CET release time UNVERIFIED; prior DFR 2.50% (September 10, effective 16th)" },
  { slug: "bank-of-brazil-decision-in-november-1789385653368", series: "bcb_selic_target", period: "2026-11-04", release_at: scheduled("bcb_selic_target", "2026-11-04"), prior_level: 13.75, title: "Bank of Brazil decision in November?",
    basis: "Copom November 3-4 (SGS 432 fill ends 04/11/2026; the official calendar page is JS-only); ~18:30 BRT decision time UNVERIFIED; prior Selic 13.75% (meeting 281)" },
  { slug: "bank-of-england-decision-in-november-1789387521621", series: "boe_bank_rate", period: "2026-11-05", release_at: scheduled("boe_bank_rate", "2026-11-05"), prior_level: 3.75, title: "Bank of England decision in November?",
    basis: "BoE MPC dates: Thursday 5 November (observed); 12:00 UK (GMT) from the September pattern (UNVERIFIED for November); prior Bank Rate 3.75%" },
];
// Polymarket-only BLS ladders (gamma events observed 2026-09-27; no Limitless group). Titles as on the platform.
const BLS_CPI_BASIS = "BLS CPI schedule: September 2026 -> Oct. 14, 2026 08:30 AM ET (observed 2026-09-27); Table A of the release";
const BLS_EMPSIT_BASIS = "BLS Employment Situation schedule: September 2026 -> Oct. 02, 2026 08:30 AM ET (observed 2026-09-27); the platform endDate (08:30Z) is not the release time";
GROUPS.push(
  { pmSlug: "september-inflation-us-monthly", series: "us_cpi_u_sa_mom", period: "2026-09", release_at: scheduled("us_cpi_u_sa_mom", "2026-09"), title: "September Inflation US - Monthly", basis: BLS_CPI_BASIS },
  { pmSlug: "core-cpi-yoy-september-2026", series: "us_core_cpi_nsa_yoy", period: "2026-09", release_at: scheduled("us_core_cpi_nsa_yoy", "2026-09"), title: "Core CPI YoY - September 2026", basis: BLS_CPI_BASIS },
  { pmSlug: "core-cpi-mom-september-2026", series: "us_core_cpi_sa_mom", period: "2026-09", release_at: scheduled("us_core_cpi_sa_mom", "2026-09"), title: "Core CPI MoM - September 2026", basis: BLS_CPI_BASIS },
  { pmSlug: "september-unemployment-rate-2026", series: "us_unemployment_rate", period: "2026-09", release_at: scheduled("us_unemployment_rate", "2026-09"), title: "September Unemployment Rate", basis: BLS_EMPSIT_BASIS },
  { pmSlug: "how-many-jobs-added-in-september-2026", series: "us_nonfarm_payrolls_change", period: "2026-09", release_at: scheduled("us_nonfarm_payrolls_change", "2026-09"), title: "How many jobs added in September?", basis: BLS_EMPSIT_BASIS },
);
const REFUSED = [{ slug: "bank-of-japan-decision-in-october-1789388114859", series: "boj_policy_rate", title: "Bank of Japan Decision in October?" }];

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const out = arg("--out") ?? "private/shadow-markets/official-release-2026-09-24.json";
const only = arg("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
for (const s of only ?? []) if (!GROUPS.some((g) => g.series === s)) throw new Error(`--only ${s}: no ladder group for that series`);
const selected = GROUPS.filter((g) => !only || only.includes(g.series));
loadEnv();
const key = process.env.LIMITLESS_API_KEY;

const sources: Array<{ url: string; http_status: number | null; fetched_at: string; note?: string }> = [];
let last = 0;
async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const wait = last + 1100 - Date.now(); // <= 1 request per second
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const fetched_at = new Date().toISOString();
  try {
    const r = await fetch(url, { headers: { "User-Agent": OFFICIAL_UA, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
    sources.push({ url, http_status: r.status, fetched_at });
    if (r.status !== 200) return null;
    return await r.json();
  } catch (e) {
    sources.push({ url, http_status: null, fetched_at, note: String(e).slice(0, 160) });
    return null;
  }
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const iso = (v: unknown) => { const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : undefined; };

interface Entry { market: MarketRegistration; meta: Record<string, unknown>; approved: false }
const entries: Entry[] = [];
const skipped: Array<{ platform: string; group: string; label: string; external_id: string; reason: string }> = [];
const notes: string[] = [];

const groupName = (g: Group) => g.slug ?? g.pmSlug ?? g.title;
const deadlineNotes = new Set<string>();

function add(platform: "limitless" | "polymarket", g: Group, leg: { external_id: string; label: string; open_at?: string; deadline_utc?: string; criteria: string }, meta: Record<string, unknown>) {
  if (!leg.open_at || !leg.deadline_utc) { skipped.push({ platform, group: groupName(g), label: leg.label, external_id: leg.external_id, reason: "no creation or expiration time on the platform object" }); return; }
  const b = buildLegRegistration({ platform, external_id: leg.external_id, group: g, label: leg.label, open_at: leg.open_at, deadline_utc: leg.deadline_utc, criteria: leg.criteria });
  if (!b.ok) { skipped.push({ platform, group: groupName(g), label: leg.label, external_id: leg.external_id, reason: b.reason }); return; }
  try { validateRegistration(b.market); }
  catch (e) { skipped.push({ platform, group: groupName(g), label: leg.label, external_id: leg.external_id, reason: String(e).slice(0, 300) }); return; }
  // The rail decides from the scheduled release whatever the trading close; say so where the platform closes first.
  if (Date.parse(leg.deadline_utc) < Date.parse(g.release_at)) deadlineNotes.add(`${groupName(g)}: the ${platform} deadline ${leg.deadline_utc} is before the release ${g.release_at}; the legs still decide from the release (the deadline is the trading close, not part of the question)`);
  entries.push({ market: b.market, meta: { ...meta, category: "official_release", series: g.series, period: g.period, resolver_basis: g.basis }, approved: false });
}

/** Every open leg of one gamma event, as Polymarket registrations of the group. */
async function addPolymarketEvent(g: Group, slug: string, provider: string): Promise<void> {
  const ev = (await getJson(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`)) as Obj[] | null;
  const event = Array.isArray(ev) ? ev[0] : undefined;
  if (!event) { notes.push(`${groupName(g)}: gamma has no event with slug ${slug} (externalProvider ${provider})`); return; }
  const pms = Array.isArray(event.markets) ? (event.markets as Obj[]) : [];
  for (const m of pms) {
    if (m.closed === true) { skipped.push({ platform: "polymarket", group: groupName(g), label: String(m.groupItemTitle ?? m.question ?? ""), external_id: String(m.id ?? ""), reason: "closed on Polymarket" }); continue; }
    add("polymarket", g, { external_id: String(m.id ?? ""), label: String(m.groupItemTitle ?? ""), open_at: iso(m.startDate ?? m.createdAt ?? event.startDate), deadline_utc: iso(m.endDate ?? event.endDate), criteria: String(m.description ?? event.description ?? "") },
      { condition_id: m.conditionId ?? null, slug: m.slug ?? null, event_id: event.id ?? null, event_slug: event.slug ?? slug });
  }
}

async function main() {
  for (const g of selected) {
    if (!g.slug) { await addPolymarketEvent(g, g.pmSlug!, "none: Polymarket-only ladder"); continue; }
    const lm = (await getJson(`https://api.limitless.exchange/markets/${g.slug}`, key ? { "X-API-Key": key } : {})) as Obj | null;
    if (!lm) { notes.push(`${g.slug}: Limitless GET failed; no legs from it`); continue; }
    const legs = Array.isArray(lm.markets) ? (lm.markets as Obj[]) : [];
    if (!legs.length) notes.push(`${g.slug}: Limitless group returned no sub-markets`);
    for (const m of legs) {
      if (m.hidden === true) { skipped.push({ platform: "limitless", group: g.slug, label: String(m.title ?? ""), external_id: String(m.slug ?? ""), reason: "hidden sub-market" }); continue; }
      // The labels reconcile reads this leg's winningOutcomeIndex with; the venue payload proposes over the same list.
      const labels = limitlessLabels({ outcomeTokens: Array.isArray(m.outcomeTokens) && m.outcomeTokens.every((x) => typeof x === "string") ? (m.outcomeTokens as string[]) : null, tokens: m.tokens && typeof m.tokens === "object" ? (m.tokens as Record<string, unknown>) : null });
      if (!labels || limitlessOutcomeIndex("OPTION_A", { option_a: "Yes", option_b: "No" }, labels) === null || limitlessOutcomeIndex("OPTION_B", { option_a: "Yes", option_b: "No" }, labels) === null) {
        skipped.push({ platform: "limitless", group: g.slug, label: String(m.title ?? ""), external_id: String(m.slug ?? ""), reason: `outcome labels ${JSON.stringify(labels)} do not map Yes and No to one index each: reconcile could not read the outcome` });
        continue;
      }
      add("limitless", g, { external_id: String(m.slug ?? ""), label: String(m.title ?? ""), open_at: iso(m.createdAt), deadline_utc: iso(m.expirationTimestamp), criteria: String(m.description ?? lm.description ?? "") },
        { limitless_slug: m.slug, group_slug: g.slug, ...(str(m.conditionId) ? { condition_id: m.conditionId } : {}), outcome_labels: [...labels], limitless_market_id: m.id ?? null, status: m.status ?? null });
    }
    const meta = (lm.metadata ?? {}) as Obj;
    const ext = str(lm.externalSlug) ?? str(meta.externalSlug);
    if (!ext) { notes.push(`${g.slug}: no externalSlug on the Limitless group; no Polymarket mirror looked up`); continue; }
    await addPolymarketEvent(g, ext, String(meta.externalProvider ?? lm.externalProvider ?? "null"));
  }
  notes.push(...deadlineNotes);
  if (!only) for (const r of REFUSED) notes.push(`${r.slug} (${r.title}): refused, ${UNSUPPORTED_OFFICIAL_SERIES[r.series]}; the market also allows "a consensus of credible reporting"`);

  const lim = entries.filter((e) => e.market.platform === "limitless").length;
  const poly = entries.filter((e) => e.market.platform === "polymarket").length;
  const events = new Set(entries.map((e) => `${(e.market.resolver as { series: string }).series}:${(e.market.resolver as { period: string }).period}`));
  const doc = {
    generated_at: new Date().toISOString(),
    sources,
    counts: { groups: selected.length, limitless_legs: lim, polymarket_legs: poly, distinct_events: events.size },
    ...(only ? { only } : {}),
    needs_founder_approval: true,
    how_to_approve: "set approved:true on the entries to register, then POST each market to /internal/markets (after migration 016 is applied and the Worker with the official_release rail is deployed)",
    refused: only ? [] : REFUSED.map((r) => ({ slug: r.slug, series: r.series, reason: UNSUPPORTED_OFFICIAL_SERIES[r.series] })),
    skipped,
    notes,
    entries,
  };
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 1) + "\n");
  console.log(`official legs: groups=${selected.length} limitless_legs=${lim} polymarket_legs=${poly} distinct_events=${events.size} skipped=${skipped.length} -> ${out}`);
  for (const n of notes) console.log(`note: ${n}`);
  for (const s of skipped) console.log(`skipped ${s.platform} ${s.label} (${s.external_id}): ${s.reason}`);
}
main().catch((e) => { console.error(String(e)); process.exit(1); });

/**
 * Suggested registrations for every leg of the official_release ladders: the eight Limitless manual negRisk groups
 * and their Polymarket mirrors, and the Polymarket-only BLS ladders (CPI 1-month and core, unemployment rate,
 * payrolls), or one ladder named on the command line. Nothing is registered: every entry is approved:false for the founder.
 *   npx tsx scripts/official-legs.ts [--only <series>[,<series>...]] [--out private/shadow-markets/official-release-2026-09-24.json]
 *   npx tsx scripts/official-legs.ts --only us_cpi_u_sa_mom,us_core_cpi_nsa_yoy,us_core_cpi_sa_mom,us_unemployment_rate,us_nonfarm_payrolls_change --out private/shadow-markets/official-release-bls-2026-09-27.json
 *   npx tsx scripts/official-legs.ts --pm-slug <polymarket event slug> --series us_unemployment_rate --period 2026-10 --title "October Unemployment Rate"
 *     (or --lm-slug <limitless group slug>; default --out private/shadow-markets/official-release-<series>-<period>.json)
 * Read-only public GETs at most one per second: api.limitless.exchange/markets/<group slug> (X-API-Key only when
 * LIMITLESS_API_KEY is set; never printed) and gamma-api.polymarket.com/events?slug=<the group's externalSlug, or the
 * Polymarket-only group's event slug>. The resolver fields (period, release_at) come from the event registry (official
 * schedules, src/resolve/official.ts KNOWN_RELEASES, extended from src/resolve/release-calendar.ts); the bucket comes
 * from each option's own title; rounding from the series. prior_level (rate ladders) is the hand-written one, checked
 * against the rail's stored first print of the meeting before it, or derived from that print; without either the
 * group is skipped with the reason. That check is one read-only select of official_observations with the service role
 * (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY from .env, never printed), made only when a group's previous meeting is in
 * the release calendar and already released. An ad-hoc ladder's legs are kept only when the platform's own title and
 * texts are about the period it was named with. The groups and the run live in scripts/lib/official-legs.ts (tested
 * in tests/official-prior.test.ts); this file supplies the network, the database client and the output file. The
 * output copies platform market texts: it is written under private/ only.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadEnv, need } from "./lib/env";
import { REFUSED, USAGE, UsageError, outPathRefusal, parseLegArgs, readFirstPrints, selectGroups, suggestLegs, type Group, type LegArgs, type ObservationsClient } from "./lib/official-legs";
import { UNSUPPORTED_OFFICIAL_SERIES } from "../src/resolve/official";
import { OFFICIAL_UA } from "../src/ingest/official";

let args: LegArgs;
let selected: Group[];
try { args = parseLegArgs(process.argv.slice(2)); selected = selectGroups(args); }
catch (e) { if (e instanceof UsageError) { console.error(`${e.message}\n${USAGE}`); process.exit(2); } throw e; }
const { only, adhoc } = args;
const root = resolve(import.meta.dirname, "..");
const out = resolve(root, args.out);
const refusedOut = outPathRefusal(root, out);
if (refusedOut) { console.error(`${refusedOut}\n${USAGE}`); process.exit(2); }
loadEnv();

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

/** The stored first prints of the meetings before the rate groups: one read-only select, only when some are needed. */
async function readStored(keys: Parameters<typeof readFirstPrints>[1]) {
  const client = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  // the Supabase builder is the ObservationsClient shape (from/select/in, awaitable); its generics are too deep to check here
  return readFirstPrints(client as unknown as ObservationsClient, keys);
}

async function main() {
  const { entries, skipped, skipped_groups: skippedGroups, notes } = await suggestLegs(selected, { getJson, readStored, nowMs: Date.now(), limitlessKey: process.env.LIMITLESS_API_KEY });
  if (!only && !adhoc) for (const r of REFUSED) notes.push(`${r.slug} (${r.title}): refused, ${UNSUPPORTED_OFFICIAL_SERIES[r.series]}; the market also allows "a consensus of credible reporting"`);

  const lim = entries.filter((e) => e.market.platform === "limitless").length;
  const poly = entries.filter((e) => e.market.platform === "polymarket").length;
  const events = new Set(entries.map((e) => `${(e.market.resolver as { series: string }).series}:${(e.market.resolver as { period: string }).period}`));
  const doc = {
    generated_at: new Date().toISOString(),
    sources,
    counts: { groups: selected.length, groups_skipped: skippedGroups.length, limitless_legs: lim, polymarket_legs: poly, distinct_events: events.size },
    ...(only ? { only } : {}),
    ...(adhoc ? { adhoc } : {}),
    needs_founder_approval: true,
    how_to_approve: "set approved:true on the entries to register, then POST each market to /internal/markets (after migration 016 is applied and the Worker with the official_release rail is deployed)",
    refused: only || adhoc ? [] : REFUSED.map((r) => ({ slug: r.slug, series: r.series, reason: UNSUPPORTED_OFFICIAL_SERIES[r.series] })),
    skipped_groups: skippedGroups,
    skipped,
    notes,
    entries,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 1) + "\n");
  console.log(`official legs: groups=${selected.length} groups_skipped=${skippedGroups.length} limitless_legs=${lim} polymarket_legs=${poly} distinct_events=${events.size} skipped=${skipped.length} -> ${relative(root, out)}`);
  for (const n of notes) console.log(`note: ${n}`);
  for (const s of skipped) console.log(`skipped ${s.platform} ${s.label} (${s.external_id}): ${s.reason}`);
}
main().catch((e) => { console.error(String(e)); process.exit(1); });

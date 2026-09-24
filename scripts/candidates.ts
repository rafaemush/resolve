/**
 * Shadow-market candidates for founder approval (plan §16.4 P5, §17.3 P5, §19.2 item 4). Replaces
 * scripts/polymarket-candidates.ts, which walked gamma by ascending volume and returned 0 candidates from 300 markets.
 *
 *   npx tsx scripts/candidates.ts polymarket [--days 21] [--max-volume 50000] [--out docs/shadow-markets] [--force]
 *   npx tsx scripts/candidates.ts limitless  [--days 45] [--max-volume 50000] [--out docs/shadow-markets] [--force]
 *
 * Read-only public GETs, nothing else: gamma /markets/keyset (closed=false, volume_num_max, end_date_min=now,
 * end_date_max=now+days, include_tag=true, 100 per page) or Limitless /markets/active?automationType=manual (25 per
 * page, the API maximum; X-API-Key only when LIMITLESS_API_KEY is set, never printed). Writes
 * <out>/candidates-<platform>-<YYYY-MM-DD>.json: a header {platform, generated_at, source_url, filters, counts,
 * needs_founder_approval: true} and entries that all start approved: false. Curate with the file's how_to_approve, then
 * scripts/seed-shadow.ts. A same-day file that already holds an approved entry is never overwritten without --force.
 * Any HTTP failure stops the run before a file is written: a partial candidate list is not a candidate list.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { loadEnv } from "./lib/env";
import { CandidateFile, type CandidateEntry, type CandidatePlatform } from "./lib/candidates";
import { buildPolymarket } from "./lib/candidates-polymarket";
import { buildLimitless, createdSince } from "./lib/candidates-limitless";
import { checkCandidateFile, SHADOW_VOLUME_CAP_USD } from "./lib/seed-shadow";

const UA = "ResolveBot/1.0";
const GAMMA = "https://gamma-api.polymarket.com/markets/keyset";
const LIMITLESS = "https://api.limitless.exchange/markets/active";
const MAX_PAGES = 400;

class UsageError extends Error {}
const USAGE = "usage: npx tsx scripts/candidates.ts polymarket|limitless [--days N] [--max-volume USD] [--out DIR] [--force]";

interface Args { platform: CandidatePlatform; days: number; maxVolume: number; out: string; force: boolean }

function parseArgs(argv: string[]): Args {
  const platform = argv[0];
  if (platform !== "polymarket" && platform !== "limitless") throw new UsageError(`first argument must be polymarket or limitless, got "${platform ?? ""}"`);
  const out: Args = { platform, days: platform === "polymarket" ? 21 : 45, maxVolume: SHADOW_VOLUME_CAP_USD, out: "docs/shadow-markets", force: false };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--force") { out.force = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new UsageError(`${flag} needs a value`);
    switch (flag) {
      case "--days": out.days = Number(v); if (!Number.isInteger(out.days) || out.days < 1 || out.days > 120) throw new UsageError("--days must be 1..120"); break;
      case "--max-volume": out.maxVolume = Number(v); if (!Number.isFinite(out.maxVolume) || out.maxVolume <= 0 || out.maxVolume > SHADOW_VOLUME_CAP_USD) throw new UsageError(`--max-volume must be in (0, ${SHADOW_VOLUME_CAP_USD}]`); break;
      case "--out": out.out = v; break;
      default: throw new UsageError(`unknown argument "${flag}"`);
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One overwritten progress line on a terminal; every 25th page otherwise, so a log stays readable. */
const progress = (page: number, line: string) => {
  if (process.stderr.isTTY) process.stderr.write(`\r${line}`);
  else if (page % 25 === 0) process.stderr.write(`${line}\n`);
};

/** GET with up to three retries on 429/5xx/network errors; anything else non-200 throws with the status. */
async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(30_000) });
      if (r.ok) return await r.json();
      last = `HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) { last = String(e).slice(0, 200); }
  }
  throw new Error(`GET ${url.split("?")[0]} failed: ${last}`);
}

async function fetchGamma(now: Date, a: Args): Promise<{ rows: unknown[]; sourceUrl: string; filters: Record<string, unknown> }> {
  const filters = { closed: false, volume_num_max: a.maxVolume, end_date_min: now.toISOString(), end_date_max: new Date(now.getTime() + a.days * 86_400_000).toISOString(), include_tag: true, limit: 100 };
  const base = `${GAMMA}?${new URLSearchParams(Object.entries(filters).map(([k, v]) => [k, String(v)])).toString()}`;
  const Page = z.object({ markets: z.array(z.unknown()), next_cursor: z.string().nullish() });
  const rows: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new Error(`gamma: more than ${MAX_PAGES} pages; narrow --days instead of writing a truncated list`);
    const p = Page.safeParse(await getJson(cursor ? `${base}&after_cursor=${encodeURIComponent(cursor)}` : base));
    if (!p.success) throw new Error(`gamma keyset page ${page}: unexpected shape (${p.error.issues[0]?.path.join(".")})`);
    rows.push(...p.data.markets);
    progress(page + 1, `gamma: ${rows.length} markets, page ${page + 1}`);
    cursor = p.data.next_cursor ?? null;
    if (!cursor || !p.data.markets.length) break;
    await sleep(250);
  }
  if (process.stderr.isTTY) process.stderr.write("\n");
  return { rows, sourceUrl: base, filters: { ...filters, pagination: "keyset (after_cursor)", days: a.days } };
}

async function fetchLimitless(a: Args): Promise<{ rows: unknown[]; feedTotal: number; duplicates: number; sourceUrl: string; filters: Record<string, unknown> }> {
  const base = `${LIMITLESS}?automationType=manual&limit=25`;
  const headers: Record<string, string> = process.env.LIMITLESS_API_KEY ? { "X-API-Key": process.env.LIMITLESS_API_KEY } : {};
  const Page = z.object({ data: z.array(z.unknown()), totalMarketsCount: z.number().int().nonnegative() });
  const bySlug = new Map<string, unknown>();
  let feedTotal = 0, seen = 0;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new Error(`limitless: more than ${MAX_PAGES} pages`);
    const p = Page.safeParse(await getJson(`${base}&page=${page}`, headers));
    if (!p.success) throw new Error(`limitless page ${page}: unexpected shape (${p.error.issues[0]?.path.join(".")})`);
    feedTotal = p.data.totalMarketsCount;
    for (const r of p.data.data) {
      seen++;
      const slug = (r as { slug?: unknown }).slug;
      bySlug.set(typeof slug === "string" ? slug : `row-${seen}`, r);
    }
    progress(page, `limitless: ${seen} of ${feedTotal} rows, page ${page}`);
    if (!p.data.data.length || seen >= feedTotal) break;
    await sleep(500);
  }
  if (process.stderr.isTTY) process.stderr.write("\n");
  return { rows: [...bySlug.values()], feedTotal, duplicates: seen - bySlug.size, sourceUrl: `${base}&page=N`, filters: { automationType: "manual (re-checked per row)", limit: 25, days: a.days, max_volume_usd: a.maxVolume, api_key_sent: !!headers["X-API-Key"] } };
}

/** The newest earlier Limitless candidate file's generated_at: the weekly re-scan counts manual markets created since. */
function previousScan(dir: string, today: string): { file: string; generatedAt: Date } | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^candidates-limitless-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(21, 31) < today).sort();
  const last = files[files.length - 1];
  if (!last) return null;
  const at = Date.parse(String((JSON.parse(readFileSync(join(dir, last), "utf8")) as { header?: { generated_at?: unknown } }).header?.generated_at ?? ""));
  return Number.isFinite(at) ? { file: last, generatedAt: new Date(at) } : null;
}

const HOW_TO_APPROVE = "For each market to seed: edit every field listed under needs_review (anchors must appear in the source page; sources must be https pages that state the outcome), empty needs_review, set approved: true. Then run npx tsx scripts/seed-shadow.ts <this file> --check, then --dry-run, then --apply. Unapproved entries are never registered.";

async function main(a: Args): Promise<void> {
  loadEnv();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const dir = resolve(process.cwd(), a.out);
  const path = join(dir, `candidates-${a.platform}-${today}.json`);
  if (existsSync(path) && !a.force) {
    const prior = CandidateFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!prior.success || prior.data.entries.some((e) => e.approved)) throw new Error(`${path} exists and holds curated work (approved entries or an unreadable file); rerun with --force to overwrite it`);
  }

  let header: Record<string, unknown>;
  let entries: CandidateEntry[];
  if (a.platform === "polymarket") {
    const f = await fetchGamma(now, a);
    const b = buildPolymarket(f.rows, { now, days: a.days, maxVolume: a.maxVolume });
    entries = b.entries;
    header = {
      platform: "polymarket", generated_at: now.toISOString(), source_url: f.sourceUrl, filters: f.filters, counts: b.counts, needs_founder_approval: true,
      scoring: "score = 2 x source tier (A official/chain/GitHub = 1, B the subject's own domain = 0.667) + earliness (1 now .. 0 at the window's end) + 0.5 x deadline density (share of the busiest deadline day) + 0.5 official-release family - 0.5 recurring daily/weekly series. One entry per gamma event (representative leg = most volume); legs lists the event's markets in the window.",
      how_to_approve: HOW_TO_APPROVE,
    };
  } else {
    const f = await fetchLimitless(a);
    const b = buildLimitless(f.rows, { now, days: a.days, maxVolume: a.maxVolume });
    const prev = previousScan(dir, today);
    const since = prev?.generatedAt ?? new Date(now.getTime() - 7 * 86_400_000);
    entries = b.entries;
    header = {
      platform: "limitless", generated_at: now.toISOString(), source_url: f.sourceUrl, filters: f.filters,
      counts: { ...b.counts, feed_total: f.feedTotal, duplicate_rows_across_pages: f.duplicates, created_since: { since: since.toISOString(), basis: prev ? `previous scan ${prev.file}` : "no previous scan: the last 7 days", manual_markets_created: createdSince(f.rows, since) } },
      needs_founder_approval: true,
      scoring: "checkability 0..4 per leg: official_release 3; pre_tge/company_news/politics/specials/other 2 with a first-party source URL else 1; price 1 (no any-touch rail yet); sports 0; +1 for a tier-A source (official, chain, GitHub); 0 for X-only sources or AMM legs without outcome labels. One entry per registrable market: group legs are separate entries (a group slug has no outcome), one per group marked representative.",
      how_to_approve: HOW_TO_APPROVE,
    };
  }
  const file = { header, entries };
  const self = checkCandidateFile(file, now);
  if (self.fileErrors.length) throw new Error(`generated file fails its own schema: ${self.fileErrors.join("; ")}`);
  (header.counts as Record<string, unknown>).entries_with_check_errors = self.entries.filter((e) => e.errors.length).length;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`wrote ${path}: ${entries.length} entries (all approved: false)`);
  console.log(JSON.stringify(header.counts, null, 2));
}

let args: Args;
try { args = parseArgs(process.argv.slice(2)); }
catch (e) { console.error(e instanceof UsageError ? `${e.message}\n${USAGE}` : String(e)); process.exit(2); }
main(args).catch((e) => { console.error(`failed, no file written: ${String(e)}`); process.exit(1); });

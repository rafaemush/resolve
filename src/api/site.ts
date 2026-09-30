/**
 * The public site (server-rendered HTML, no client script, no external asset): GET / (what Resolve does, the next
 * scheduled official releases and how many public markets each covers), GET /record (the public record, from the same
 * views the API reads: v_track_record as GET /v1/track-record serves it, and v_venue_report for the per-market commit
 * rows whose hashes GET /v1/track-record/verify checks), GET /pricing, GET /docs, GET /terms, and POST /v1/request-key
 * (a test-key request: stored as a lead with an inbound touch; an evaluation key is issued on the spot and shown once
 * when src/api/evaluation-key.ts allows it, otherwise a person answers by email; the operator is alerted either way,
 * never with the key), and the card checkout's pages: the "Pay by card" form on /pricing (only when card checkout is
 * switched on and configured), POST /billing/checkout (the form: the key in its body, a 303 to Whop) and GET
 * /billing/done (where Whop sends the buyer back; it reads nothing).
 *
 * Rules every page keeps (tests/site.test.ts): every dynamic value is HTML-escaped; no page names the model or its
 * vendor; no accuracy percentage appears before the view marks a platform reportable (100 reconciled markets); no number
 * is printed that is not read from the database or from code; each page makes at most 3 database reads, in parallel;
 * a strict Content-Security-Policy (no script at all; /pricing's form may also post to Whop's checkout host, where the
 * form's answer redirects) and a 60 s public cache (the POST answers: no-store).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { db } from "../db/supabase";
import { ok, err } from "./envelope";
import { trackRecordRows } from "./public";
import { KNOWN_RELEASES, OFFICIAL_SERIES, knownRelease, type OfficialSeriesId } from "../resolve/official";
import { ELECTION_SERIES, isElectionSeries } from "../resolve/election";
import { effectiveTiers, packQuotes, PACKS_USDC, type PaygCredit } from "../billing/tiers";
import { followCap, type Plan } from "../shadow/follows";
import { authenticateKey, perKeyRpm, rateLimit } from "./auth";
import { alert } from "../ops/alerts";
import { maskEmail } from "../ops/redact";
import { EVALUATION_KEY_DAYS, EVALUATION_WATCH_LIMIT, FREE_EVALUATION_CREDITS } from "./keys";
import { issueEvaluationKey, type AutoKeyOutcome } from "./evaluation-key";
import { CARD_PACKS, PACK_IDS, cardCheckoutOffered, isPackId, usd, whopConfig, type WhopConfig } from "../billing/whop";
import { checkoutRefusal, startCheckout } from "./billing";
import { PAY_BY_CARD_PATH } from "../billing/top-up";

type Vars = { requestId: string; schemaVersion: string };
export const site = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---- shared layout -------------------------------------------------------------------------------------------------

export const esc = (v: unknown): string =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const SITE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
/**
 * The policy of a page that carries the card form: the form posts to this site, whose answer is a 303 to Whop's hosted
 * checkout, and browsers apply form-action to that redirect (and to any redirect Whop's page makes within its own
 * domain). Nothing else is loosened; the checkout URL itself must be on the configured host (checkoutUrlAllowed).
 */
export const cardFormCsp = (cfg: Pick<WhopConfig, "checkoutOrigin">): string => SITE_CSP.replace("form-action 'self'", `form-action 'self' ${cfg.checkoutOrigin} https://*.whop.com`);
export const PAGE_MAX_AGE = 60;
const DISCLAIMER = "Informational signal, not financial advice, not an oracle of record.";

/** The public channel link, only when PUBLIC_CHANNEL_URL is an https URL (anything else is omitted, never printed). */
export function channelUrl(env: Pick<Env, "PUBLIC_CHANNEL_URL">): string | null {
  const u = env.PUBLIC_CHANNEL_URL?.trim();
  if (!u) return null;
  try { return new URL(u).protocol === "https:" ? u : null; } catch { return null; }
}

const NAV: Array<[string, string]> = [["/", "Home"], ["/record", "Record"], ["/pricing", "Pricing"], ["/docs", "Docs"], ["/terms", "Terms"]];

export function layout(o: { title: string; path: string; description: string; body: string; channel: string | null }): string {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === o.path ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#5d5d58;--rule:#e3e2de;--code:#f0efeb;--link:#1f5fbf;--accent:#0d6b4f;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe7;--muted:#a3a29c;--rule:#2e2e2b;--code:#22221f;--link:#8ab4f8;--accent:#6fd3ad;--warn:#e7b660}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;background:var(--bg);padding:.4rem}
header{border-bottom:1px solid var(--rule)}
.bar{max-width:60rem;margin:0 auto;padding:.8rem 1rem;display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;align-items:baseline}
.brand{font-weight:700;color:var(--fg);text-decoration:none;margin-right:auto}
nav a{color:var(--muted);text-decoration:none;margin-right:1rem}nav a:last-child{margin-right:0}
nav a[aria-current=page]{color:var(--fg);text-decoration:underline;text-underline-offset:.3em}
main{max-width:60rem;margin:0 auto;padding:2rem 1rem 3rem}
h1{font-size:1.9rem;line-height:1.2;margin:0 0 .6rem}
h2{font-size:1.2rem;margin:2.2rem 0 .6rem;padding-top:1.2rem;border-top:1px solid var(--rule)}
h3{font-size:1rem;margin:1.4rem 0 .4rem}
.lede{color:var(--muted);font-size:1.08rem;margin-top:0}
.muted{color:var(--muted)}.note{border-left:3px solid var(--warn);padding:.4rem .8rem;background:var(--code)}
a{color:var(--link)}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--link);outline-offset:2px}
ul{padding-left:1.2rem}li{margin:.3rem 0}
code,pre{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:4px}
code{padding:.1rem .3rem;overflow-wrap:anywhere}pre{padding:.8rem 1rem;overflow-x:auto}
.table{overflow-x:auto;margin:.6rem 0}
table{border-collapse:collapse;width:100%;font-size:.93rem}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-weight:600;color:var(--muted);white-space:nowrap}
td.n{font-variant-numeric:tabular-nums;white-space:nowrap}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.8rem;margin:1rem 0}
.stat{border:1px solid var(--rule);border-radius:6px;padding:.7rem .9rem}
.stat b{display:block;font-size:1.6rem;font-variant-numeric:tabular-nums}.stat span{color:var(--muted);font-size:.9rem}
form{display:grid;gap:.8rem;max-width:34rem}
label{display:grid;gap:.25rem;font-weight:600;font-size:.95rem}
label small{font-weight:400;color:var(--muted)}
input,textarea,select{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--muted);border-radius:4px;padding:.5rem .6rem;width:100%}
textarea{min-height:6rem}
button{font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:4px;padding:.6rem 1.1rem;justify-self:start;cursor:pointer}
@media (prefers-color-scheme:dark){button{color:#10201a}}
.hp{position:absolute;left:-999px;width:1px;height:1px;overflow:hidden}
footer{max-width:60rem;margin:0 auto;padding:1.5rem 1rem 3rem;border-top:1px solid var(--rule);color:var(--muted);font-size:.9rem}
footer a{color:var(--muted)}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header><div class="bar"><a class="brand" href="/">Resolve</a><nav aria-label="Site">${nav}</nav></div></header>
<main id="main">
${o.body}
</main>
<footer>
<p>${DISCLAIMER} Every verdict is committed by hash before the venue resolves and revealed after.</p>
<p><a href="/openapi.json">OpenAPI</a> · <a href="/v1/track-record">Record (JSON)</a>${o.channel ? ` · <a href="${esc(o.channel)}" rel="noopener">Telegram channel</a>` : ""} · <a href="/bot">ResolveBot</a> · <a href="/terms">Terms</a></p>
</footer>
</body>
</html>`;
}

/** The security and cache headers of every page. */
function page(c: Context<{ Bindings: Env; Variables: Vars }>, html: string, status: 200 | 400 | 401 | 429 | 503 = 200, cache = status === 200, csp = SITE_CSP): Response {
  const res = c.html(html, status);
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Cache-Control", cache ? `public, max-age=${PAGE_MAX_AGE}, s-maxage=${PAGE_MAX_AGE}` : "no-store");
  return res;
}

/** Cache API around a database-backed page (60 s). The Cache API is absent outside Workers: the page renders uncached. */
async function cached(c: Context<{ Bindings: Env; Variables: Vars }>, key: string, render: () => Promise<Response>): Promise<Response> {
  const store = typeof caches === "undefined" ? null : caches.default;
  const req = new Request(new URL(key, c.req.url).toString());
  if (store) { const hit = await store.match(req); if (hit) return hit; }
  const res = await render();
  if (store && res.status === 200 && !/no-store/i.test(res.headers.get("cache-control") ?? "")) {
    try { c.executionCtx.waitUntil(store.put(req, res.clone())); } catch { /* no execution context (tests) */ }
  }
  return res;
}

const utc = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};
const int = (n: number) => n.toLocaleString("en-US");
const PLATFORM_NAME: Record<string, string> = { polymarket: "Polymarket", limitless: "Limitless", custom: "Custom" };
const platformName = (p: string) => PLATFORM_NAME[p] ?? p;

// ---- upcoming releases ---------------------------------------------------------------------------------------------

/**
 * One row of the table: one scheduled release (event_keys: its one event key), or one election, whose contests are
 * each their own series and event key (one per platform event) and share one release time, polls close. ids: the venue
 * ids ("<platform>:<external_id>") of its open markets, sorted, which POST /v1/markets/{id}/follow accepts as printed.
 */
export interface UpcomingRelease { event_key: string; event_keys: string[]; series: OfficialSeriesId; period: string; label: string; release_at: string; markets: Record<string, number>; ids: string[] }
/** The public markets columns the table reads (never a title or criteria text). */
export interface UpcomingMarket { platform: string; event_key: string | null; external_id?: string | null; status?: string | null }

const ELECTION_ROW_LABEL: Record<string, string> = {
  tse: "Brazil presidential election, first round: the TSE's final count (polls close)",
  eq: "Quebec general election: Élections Québec's final count (polls close)",
};

/**
 * Pure. The next release of each series in KNOWN_RELEASES scheduled after `now`, soonest first, with the public markets
 * per platform of each event and the venue ids of the open ones. A later period of a series appears once the earlier one
 * is out, so a registry that holds months ahead never crowds the table (nor the one markets read, which asks only for
 * these event keys); the contests of one election are one row (their markets summed), so an election day never crowds
 * the releases out either.
 */
export function upcomingReleases(now: number, markets: ReadonlyArray<UpcomingMarket>, limit = 20): UpcomingRelease[] {
  const counts = new Map<string, Record<string, number>>();
  const ids = new Map<string, string[]>();
  for (const m of markets) {
    if (!m.event_key) continue;
    const c = counts.get(m.event_key) ?? {};
    c[m.platform] = (c[m.platform] ?? 0) + 1;
    counts.set(m.event_key, c);
    if (m.status === "open" && m.external_id) ids.set(m.event_key, [...(ids.get(m.event_key) ?? []), `${m.platform}:${m.external_id}`]);
  }
  // the soonest future event of each series
  const next = new Map<string, [string, (typeof KNOWN_RELEASES)[string]]>();
  for (const [k, r] of Object.entries(KNOWN_RELEASES)) {
    if (Date.parse(r.release_at) <= now) continue;
    const series = k.slice(0, k.indexOf(":"));
    const cur = next.get(series);
    if (!cur || Date.parse(r.release_at) < Date.parse(cur[1].release_at)) next.set(series, [k, r]);
  }
  const rows = new Map<string, UpcomingRelease>();
  for (const [k, r] of next.values()) {
    const i = k.indexOf(":");
    const series = k.slice(0, i) as OfficialSeriesId;
    const period = k.slice(i + 1);
    const event_key = `official:${k}`;
    const authority = isElectionSeries(series) ? ELECTION_SERIES[series].authority : null;
    const id = authority ? `election:${authority}:${period}` : event_key;
    let row = rows.get(id);
    if (!row) {
      row = { event_key: id, event_keys: [], series, period, label: authority ? ELECTION_ROW_LABEL[authority] ?? authority : OFFICIAL_SERIES[series]?.label ?? series, release_at: r.release_at, markets: {}, ids: [] };
      rows.set(id, row);
    }
    row.event_keys.push(event_key);
    for (const [p, n] of Object.entries(counts.get(event_key) ?? {})) row.markets[p] = (row.markets[p] ?? 0) + n;
    row.ids.push(...(ids.get(event_key) ?? []));
  }
  for (const row of rows.values()) {
    if (row.event_keys.length > 1) row.label = `${row.label}, ${row.event_keys.length} contests`;
    row.ids.sort();
  }
  return [...rows.values()]
    .sort((a, b) => a.release_at.localeCompare(b.release_at) || a.series.localeCompare(b.series))
    .slice(0, limit);
}

/** One read: public, non-test, undeleted markets of the upcoming events (event_key, platform, external_id and status only). */
async function upcomingWithCounts(env: Env, now: number): Promise<{ rows: UpcomingRelease[]; countsOk: boolean }> {
  const keys = upcomingReleases(now, []).flatMap((u) => u.event_keys);
  if (!keys.length) return { rows: [], countsOk: true };
  try {
    const { data, error } = await db(env).from("markets").select("platform, event_key, external_id, status").is("tenant_id", null).eq("is_test", false).is("deleted_at", null).in("event_key", keys);
    if (error) throw new Error(error.message);
    return { rows: upcomingReleases(now, (data ?? []) as UpcomingMarket[]), countsOk: true };
  } catch {
    return { rows: upcomingReleases(now, []), countsOk: false };
  }
}

function upcomingTable(rows: UpcomingRelease[], countsOk: boolean): string {
  if (!rows.length) return `<p class="muted">No scheduled release is registered right now.</p>`;
  const cov = (r: UpcomingRelease) => {
    if (!countsOk) return `<span class="muted">unavailable</span>`;
    const parts = Object.entries(r.markets).sort().map(([p, n]) => `${esc(platformName(p))}: ${int(n)} market${n === 1 ? "" : "s"}`);
    if (!parts.length) return `<span class="muted">none registered yet</span>`;
    // the venue id of each open market, the id POST /v1/markets/{id}/follow takes as printed (never a title)
    const ids = r.ids.length ? `<details><summary>Market ids (${int(r.ids.length)} open)</summary>${r.ids.map((id) => `<code>${esc(id)}</code>`).join(" ")}</details>` : "";
    return parts.join("<br>") + ids;
  };
  return `<div class="table"><table>
<caption class="muted" style="text-align:left;caption-side:bottom;padding-top:.4rem">Scheduled release times as published by each agency or central bank; for an election, the time polls close (the final count comes hours or days later). Markets: public markets Resolve shadows for that release, per venue; each market id (<code>platform:external_id</code>) can be followed as printed: <code>POST /v1/markets/&lt;id&gt;/follow</code>.</caption>
<thead><tr><th scope="col">Release (UTC)</th><th scope="col">Series</th><th scope="col">Period</th><th scope="col">Markets covered</th></tr></thead>
<tbody>${rows.map((r) => `<tr><td class="n">${esc(utc(r.release_at))}</td><td>${esc(r.label)}</td><td class="n">${esc(r.period)}</td><td>${cov(r)}</td></tr>`).join("\n")}</tbody>
</table></div>`;
}

// ---- GET / ---------------------------------------------------------------------------------------------------------

export function requestKeyForm(values: Partial<Record<string, string>> = {}, error: string | null = null): string {
  const v = (k: string) => esc(values[k] ?? "");
  return `<h2 id="request-key">Request a test key</h2>
<p>A free test key carries ${int(FREE_EVALUATION_CREDITS)} credits for ${EVALUATION_KEY_DAYS} days, for structured verdicts, with up to ${EVALUATION_WATCH_LIMIT} watches. Tell us who you are and what you want to settle: the key is shown on the next page, once. One key per email address every ${EVALUATION_KEY_DAYS} days; when a key cannot be issued on the spot, a person reads the request and answers by email.</p>
${error ? `<p class="note" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/v1/request-key">
<label>Name <input name="name" required maxlength="100" autocomplete="name" value="${v("name")}"></label>
<label>Email <input name="email" type="email" required maxlength="254" autocomplete="email" value="${v("email")}"></label>
<label>Company or project <input name="company" required maxlength="200" autocomplete="organization" value="${v("company")}"></label>
<label>What do you want to use it for? <textarea name="purpose" required maxlength="1000">${v("purpose")}</textarea></label>
<label>Venue <small>(optional: the market venue you run or trade on)</small> <input name="venue" maxlength="100" value="${v("venue")}"></label>
<div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
<button type="submit">Request a test key</button>
</form>`;
}

export function landingHtml(o: { upcoming: UpcomingRelease[]; countsOk: boolean; channel: string | null }): string {
  const body = `<h1>Prediction-market outcomes, settled from the official source</h1>
<p class="lede">Resolve reads the official release (a statistics office, a central bank, a public API) and decides each market's outcome from it. It is an API with webhooks for bot operators, data teams and venues.</p>
<h2>How it works</h2>
<ul>
<li><strong>From the source.</strong> For an official release, Resolve reads the publisher's own release after it is published and decides from the published figure, not from news or social posts.</li>
<li><strong>Committed before, revealed after.</strong> Each verdict is posted first as a SHA-256 commitment, before the venue resolves the market. After the venue resolves, the verdict and the text behind the hash are revealed, so anyone can recompute the hash and check that nothing was changed.</li>
<li><strong>Checked against the venue.</strong> Once the venue resolves a market, Resolve compares its verdict with the venue's resolution and publishes the result on the <a href="/record">public record</a>, including disagreements.</li>
<li><strong>No accuracy claim yet.</strong> Percentages appear for a venue once 100 of its markets have been reconciled against the venue's own resolution. Until then the record shows counts and times only.</li>
</ul>
<h2>Next scheduled releases</h2>
${upcomingTable(o.upcoming, o.countsOk)}
<h2>Start</h2>
<ul>
<li><a href="/record">Public record</a>: every commitment, reveal and agreement.</li>
<li><a href="/pricing">Pricing</a>: a free test key, credit packs and monthly plans.</li>
<li><a href="/docs">Docs</a>: request a key, register a market, receive webhooks, verify a commitment.</li>
${o.channel ? `<li><a href="${esc(o.channel)}" rel="noopener">Telegram channel</a>: commitments and reveals as they are posted.</li>\n` : ""}<li><a href="/openapi.json">OpenAPI document</a>.</li>
</ul>
${requestKeyForm()}`;
  return layout({ title: "Resolve", path: "/", description: "Resolve settles prediction-market outcomes from the official source, with every verdict committed by hash before the venue resolves.", body, channel: o.channel });
}

site.get("/", (c) => cached(c, "/?site=1", async () => {
  const now = Date.now();
  const { rows, countsOk } = await upcomingWithCounts(c.env, now);
  return page(c, landingHtml({ upcoming: rows, countsOk, channel: channelUrl(c.env) }), 200, countsOk);
}));

// ---- GET /record ---------------------------------------------------------------------------------------------------

/** v_venue_report columns the record table shows (never a title, criteria text, nonce or preimage). */
export interface RecordRow {
  platform: string; external_id: string; event_key: string | null; committed_at: string | null; latest_committed_at: string | null;
  latest_commitment_sha256: string | null; official_at: string | null; agreement: string | null; n_commits: number | null;
}
export const RECORD_TABLE_ROWS = 25;
/** How many committed rows the page reads to count distinct committed events. */
export const RECORD_READ_CAP = 1000;

export interface RecordSummary {
  events_committed: number; events_committed_capped: boolean; markets_committed: number;
  events_reconciled: number; agree: number; disagree: number; abstained: number; voided: number; unresolved_by_platform: number;
  platforms: Array<{ platform: string; events_reconciled: number; reportable: boolean; row: Record<string, unknown> }>;
}

/** Pure. The page's counts: committed events from the commit rows, reconciled events and agreements from v_track_record. */
export function summarizeRecord(track: readonly Record<string, unknown>[], commits: readonly RecordRow[]): RecordSummary {
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
  const latest = new Map<string, Record<string, unknown>>();
  let voided = 0, unresolved = 0;
  for (const r of track) {
    const p = String(r.platform);
    const cur = latest.get(p);
    if (!cur || String(r.week) > String(cur.week)) latest.set(p, r);
    voided += num(r.voided);
    unresolved += num(r.unresolved_by_platform);
  }
  const shaped = trackRecordRows([...latest.values()]);
  const platforms = shaped.map((row) => ({ platform: String(row.platform), events_reconciled: num(row.n_events_reconciled_cumulative), reportable: row.reportable === true, row }))
    .sort((a, b) => a.platform.localeCompare(b.platform));
  const sum = (k: string) => [...latest.values()].reduce((s, r) => s + num(r[k]), 0);
  const events = new Set(commits.map((r) => `${r.platform}|${r.event_key ?? `${r.platform}:${r.external_id}`}`));
  return {
    events_committed: events.size, events_committed_capped: commits.length >= RECORD_READ_CAP, markets_committed: commits.length,
    events_reconciled: sum("n_events_reconciled_cumulative"), agree: sum("resolved_correct_cumulative"), disagree: sum("resolved_wrong_cumulative"),
    abstained: sum("abstained_cumulative"), voided, unresolved_by_platform: unresolved, platforms,
  };
}

/** Pure. The scheduled release time of an official_release market (its event_key names series and period), else null. */
export function officialReleaseAt(eventKey: string | null): string | null {
  const m = /^official:([a-z0-9_]+):(.+)$/.exec(eventKey ?? "");
  return m ? knownRelease(m[1]!, m[2]!)?.release_at ?? null : null;
}

const pct = (v: unknown) => (typeof v === "number" ? `${(v * 100).toFixed(1)} %` : "");

function recordBody(s: RecordSummary, rows: readonly RecordRow[], upcoming: string): string {
  const stat = (n: number, label: string) => `<div class="stat"><b>${int(n)}</b><span>${label}</span></div>`;
  const young = s.platforms.every((p) => !p.reportable);
  const gate = young
    ? `<p class="note">The record is too young for percentages. Percentages appear for a venue once 100 of its markets have been reconciled against the venue's own resolution. Until then this page shows counts and times only.</p>`
    : "";
  const perPlatform = s.platforms.length ? `<div class="table"><table>
<thead><tr><th scope="col">Venue</th><th scope="col">Events reconciled</th><th scope="col">Per-market precision (95 % interval)</th><th scope="col">Per-event precision (95 % interval)</th></tr></thead>
<tbody>${s.platforms.map((p) => p.reportable
      ? `<tr><td>${esc(platformName(p.platform))}</td><td class="n">${int(p.events_reconciled)}</td><td class="n">${esc(pct(p.row.precision))} (${esc(pct(p.row.wilson_low))} to ${esc(pct(p.row.wilson_high))})</td><td class="n">${esc(pct(p.row.event_precision))} (${esc(pct(p.row.event_wilson_low))} to ${esc(pct(p.row.event_wilson_high))})</td></tr>`
      : `<tr><td>${esc(platformName(p.platform))}</td><td class="n">${int(p.events_reconciled)}</td><td colspan="2" class="muted">not yet reportable: percentages appear at 100 reconciled markets</td></tr>`).join("\n")}</tbody>
</table></div>` : "";
  const table = rows.length ? `<h2>Most recent commitments</h2>
<p class="muted">One row per market, newest first. Market: its id, <code>platform:external_id</code>, which <code>POST /v1/markets/&lt;id&gt;/follow</code> and <code>GET /v1/shadow/&lt;id&gt;</code> accept as printed. Release to commit: seconds from the scheduled official release to the first commitment. The hash links to the public verification of the latest commitment.</p>
<div class="table"><table>
<thead><tr><th scope="col">Market</th><th scope="col">Committed</th><th scope="col">Official release</th><th scope="col">Release to commit</th><th scope="col">Venue resolved</th><th scope="col">Agreement</th><th scope="col">Commitment</th></tr></thead>
<tbody>${rows.map((r) => {
      const rel = officialReleaseAt(r.event_key);
      const secs = rel && r.committed_at ? Math.round((Date.parse(r.committed_at) - Date.parse(rel)) / 1000) : null;
      const hash = r.latest_commitment_sha256 && /^[0-9a-f]{64}$/.test(r.latest_commitment_sha256) ? r.latest_commitment_sha256 : null;
      return `<tr><td><code>${esc(`${r.platform}:${r.external_id}`)}</code></td><td class="n">${esc(utc(r.committed_at))}</td><td class="n">${esc(utc(rel))}</td><td class="n">${secs === null ? "" : `${esc(int(secs))} s`}</td><td class="n">${esc(utc(r.official_at))}</td><td>${esc(r.agreement ?? "pending")}</td><td>${hash ? `<a href="/v1/track-record/verify?hash=${hash}"><code>${hash.slice(0, 12)}…</code></a>` : ""}</td></tr>`;
    }).join("\n")}</tbody>
</table></div>` : `<h2>Most recent commitments</h2>
<p>No public commitment has been recorded yet. The first ones follow the next scheduled releases:</p>
${upcoming}`;
  return `<h1>Public record</h1>
<p class="lede">Every number on this page is read from the database. Test markets are excluded, and each market counts once, by its latest commitment. The same data is served as JSON at <a href="/v1/track-record">/v1/track-record</a>.</p>
<div class="stats">${stat(s.events_committed, s.events_committed_capped ? `events committed (latest ${int(RECORD_READ_CAP)} markets)` : "events committed")}${stat(s.events_reconciled, "events reconciled")}${stat(s.agree, "markets agreed")}${stat(s.disagree, "markets disagreed")}${stat(s.abstained, "markets abstained")}${stat(s.voided, "markets voided")}</div>
${gate}
${perPlatform}
${table}
<h2>How to check a commitment</h2>
<p>Open a commitment's link, or call <code>GET /v1/track-record/verify?hash=&lt;sha256&gt;</code>. Before the reveal it shows only that the commitment was recorded and when. After the reveal it returns the preimage and the nonce: <code>sha256(preimage)</code> must equal the commitment hash.</p>`;
}

site.get("/record", (c) => cached(c, "/record?site=1", async () => {
  const client = db(c.env);
  const now = Date.now();
  const [track, commits, upcoming] = await Promise.all([
    client.from("v_track_record").select("*").order("week", { ascending: false }).limit(52),
    client.from("v_venue_report").select("platform, external_id, event_key, committed_at, latest_committed_at, latest_commitment_sha256, official_at, agreement, n_commits")
      .not("committed_at", "is", null).order("committed_at", { ascending: false }).limit(RECORD_READ_CAP),
    upcomingWithCounts(c.env, now),
  ]);
  const channel = channelUrl(c.env);
  if (track.error || commits.error) {
    return page(c, layout({ title: "Public record · Resolve", path: "/record", description: "The public record of Resolve.", channel, body: `<h1>Public record</h1><p class="note" role="alert">The record store is unavailable right now. Please try again in a minute; nothing on this page is ever shown from a guess.</p>` }), 503);
  }
  const rows = (commits.data ?? []) as RecordRow[];
  const s = summarizeRecord((track.data ?? []) as Record<string, unknown>[], rows);
  const body = recordBody(s, rows.slice(0, RECORD_TABLE_ROWS), upcomingTable(upcoming.rows, upcoming.countsOk));
  return page(c, layout({ title: "Public record · Resolve", path: "/record", description: "Every Resolve commitment, reveal and agreement, read from the database.", channel, body }), 200, upcoming.countsOk);
}));

// ---- GET /pricing --------------------------------------------------------------------------------------------------

const dollars = (cents: number) => usd(cents).replace(/\.00$/, "");
/** "a", "a and b", "a, b and c" (or "or"). */
const listed = (items: string[], last = "and") => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`);
/** The card packs that are sold by card only (not among the invoiced packs, PACKS_USDC): the $20 pack. */
const CARD_ONLY = PACK_IDS.filter((k) => !(PACKS_USDC as readonly string[]).includes(k));
/** The card-only packs as rows of the pack table and entries of the price, while card checkout is offered. */
const cardOnlyPacks = () => CARD_ONLY.map((k) => ({ label: `$${int(CARD_PACKS[k].priceCents / 100)} (card only)`, credits: CARD_PACKS[k].credits }));
/**
 * The pay-as-you-go price on /pricing: the invoiced packs (PACKS_USDC) and, while card checkout is offered, the card-only
 * packs before them, so the Plans row never names a smallest pack other than the one the card form sells.
 */
export const paygPrice = (card: boolean): string => `Packs of ${listed([...(card ? cardOnlyPacks().map((p) => p.label) : []), ...PACKS_USDC.map((u) => `$${int(Number(u))}`)], "or")}`;

/** The plans as sold (docs/pricing.md); follow limits and request rates come from the code that enforces them. */
export const PUBLIC_PLANS: ReadonlyArray<{ plan: Plan | null; name: string; price: string; contents: string }> = [
  { plan: "free", name: "Free test key", price: "$0", contents: "300 credits for 30 days, structured verdicts only." },
  // the price without card checkout; pricingHtml adds the card-only packs while it is offered (paygPrice)
  { plan: "payg", name: "Pay as you go", price: paygPrice(false), contents: "Credits do not expire while the account is open." },
  { plan: "builder", name: "Builder", price: "$99 a month", contents: "12,000 credits a month, 50 watches, webhooks and private early reveals." },
  { plan: "growth", name: "Growth", price: "$399 a month", contents: "60,000 credits a month, 500 watches, a higher request rate." },
  { plan: null, name: "Venue Design Partner", price: "$750 a month", contents: "Your venue's markets, webhooks in your venue's payload shape (including a proposed winning outcome index), and a weekly reconciliation report." },
  { plan: null, name: "Pilot pack", price: "$1,000 for 30 days", contents: "A shorter start for a venue: private early reveals for the markets you name, webhooks in your payload shape and a weekly reconciliation report." },
];

/**
 * The "Pay by card" section of /pricing (and of a refused form answer): what a card pack is, the form that opens a Whop
 * checkout, and the same from code. Shown only when card checkout is offered (src/billing/whop.ts cardCheckoutOffered).
 * The key field is never filled in: no answer repeats a key.
 */
export function payByCardHtml(o: { base: string }): string {
  const options = PACK_IDS.map((p) => `<option value="${p}">${esc(dollars(CARD_PACKS[p].priceCents))}: ${esc(int(CARD_PACKS[p].credits))} credits</option>`).join("");
  return `<h2 id="pay-by-card">Pay by card</h2>
<p>Buy a credit pack for the Resolve developer data API by card. Whop processes the payment as the merchant of record. The credits are added to the account of the key you enter once Whop confirms the payment, usually within a minute.</p>
<ul>
<li>Credits pay for calls to Resolve's own API and nothing else: they are not money, cannot be withdrawn, and cannot be moved to another account.</li>
<li>Credits are a non-refundable prepayment for API services. They do not expire while the account is open.</li>
<li>If a card payment is refunded or charged back, the credits it bought are removed from the account.</li>
<li>A free test key's account becomes pay as you go with its first pack, and the key stops expiring.</li>
</ul>
<form method="post" action="/billing/checkout" autocomplete="off">
<label>API key <small>(sent to Resolve only, to find your account; it is never passed to Whop or shown again)</small> <input name="key" type="password" required maxlength="64" autocomplete="off" spellcheck="false" pattern="rsl_(live|test)_[a-z0-9]{32}"></label>
<label>Pack <select name="pack" required>${options}</select></label>
<button type="submit">Continue to checkout</button>
</form>
<p>From code, the answer carries <code>checkout_url</code>:</p>
<pre>curl -X POST ${esc(o.base)}/v1/billing/checkout \\
  -H "Authorization: Bearer $RESOLVE_KEY" -H 'content-type: application/json' \\
  -d '{"pack":"50"}'</pre>`;
}

export function pricingHtml(o: { packs: PaygCredit[] | null; channel: string | null; card?: { base: string } | null }): string {
  const limits = (p: Plan | null) => {
    if (!p) return `<td class="muted">no follow limit</td><td class="muted">by agreement</td>`;
    const cap = followCap(p);
    return `<td class="n">${p === "free" ? "up to 50 while the key is valid" : cap === null ? "no limit" : `up to ${int(cap)}`}</td><td class="n">${int(perKeyRpm(p))}</td>`;
  };
  const cardRows = o.card ? cardOnlyPacks().map((p) => `<tr><td class="n">${esc(p.label)}</td><td class="n">${esc(int(p.credits))}</td></tr>`).join("") : "";
  const packs = o.packs
    ? `<div class="table"><table><thead><tr><th scope="col">Pack</th><th scope="col">Credits</th></tr></thead><tbody>${cardRows}${o.packs.map((p) => `<tr><td class="n">$${esc(int(Number(p.usdc)))}</td><td class="n">${esc(int(p.credits))}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="muted">Pack credit amounts are unavailable right now; ask us for a quote.</p>`;
  const body = `<h1>Pricing</h1>
<p class="lede">Resolve is a developer data API; credits pay for its calls. Prices are in US dollars. The smallest pack gives 100 credits per dollar; larger packs give more (see the table below).</p>
<h2>Credits per call</h2>
<ul>
<li>A structured verdict (machine-readable sources such as official releases, GitHub objects, on-chain logs): <strong>1 credit</strong>.</li>
<li>A web-evidence verdict (free-text evidence): <strong>5 credits</strong>.</li>
<li>A request the pre-checks settle on their own, or a replay of the same <code>Idempotency-Key</code>: 0 credits.</li>
<li>A verdict that fails because an upstream is unavailable is refunded in credits.</li>
</ul>
<h2>Plans</h2>
<div class="table"><table>
<thead><tr><th scope="col">Plan</th><th scope="col">Price</th><th scope="col">What you get</th><th scope="col">Followed markets (early reveals)</th><th scope="col">Requests per minute per key</th></tr></thead>
<tbody>${PUBLIC_PLANS.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.plan === "payg" ? paygPrice(!!o.card) : p.price)}</td><td>${esc(p.contents)}</td>${limits(p.plan)}</tr>`).join("\n")}</tbody>
</table></div>
<p class="muted">Monthly plans and venue offers are set up by agreement; the figures above are what the plan includes.</p>
<h2>Pay-as-you-go packs</h2>
${packs}
${o.card ? payByCardHtml({ base: o.card.base }) + "\n" : ""}<h2>Payment</h2>
<p>Invoiced in USD; ask us for payment options.${o.card ? ` The ${esc(listed(PACK_IDS.map((k) => dollars(CARD_PACKS[k].priceCents))))} packs can be paid by card (above)${CARD_ONLY.length ? `; the ${esc(listed(CARD_ONLY.map((k) => `${dollars(CARD_PACKS[k].priceCents)} pack (${int(CARD_PACKS[k].credits)} credits)`)))} ${CARD_ONLY.length === 1 ? "is" : "are"} sold by card only` : ""}.` : ""} For the Design Partner offer or the pilot pack, name the markets and a start date and we send an invoice to review before anything is paid.</p>
<p><strong>Credits are a non-refundable prepayment for API services.</strong> They cannot be withdrawn, transferred, or exchanged for money or crypto.</p>
<h2>What we do not claim</h2>
<ul>
<li>No accuracy percentage until 100 markets on a venue have been reconciled; until then, measured facts only.</li>
<li>No lead-time promise and no SLA.</li>
<li>${DISCLAIMER}</li>
</ul>
<p><a href="/#request-key">Request a free test key</a>.</p>`;
  return layout({ title: "Pricing · Resolve", path: "/pricing", description: "Resolve plans: a free test key, credit packs, Builder, Growth, venue Design Partner and a pilot pack.", body, channel: o.channel });
}

site.get("/pricing", (c) => cached(c, "/pricing?site=1", async () => {
  const cfg = whopConfig(c.env);
  const card = cardCheckoutOffered(cfg);
  let packs: PaygCredit[] | null = null;
  try {
    const { data, error } = await db(c.env).from("app_config").select("value").eq("key", "payg_tiers").maybeSingle();
    if (error) throw new Error(error.message);
    const fallback = Number(c.env.CREDITS_PER_USDC);
    if (data || (Number.isInteger(fallback) && fallback >= 1)) {
      const eff = effectiveTiers(((data as { value?: string } | null)?.value) ?? null, fallback);
      if ("tiers" in eff) packs = packQuotes(eff.tiers);
    }
  } catch { packs = null; }
  return page(c, pricingHtml({ packs, channel: channelUrl(c.env), card: card ? { base: baseUrl(c) } : null }), 200, packs !== null, card ? cardFormCsp(cfg) : SITE_CSP);
}));

// ---- GET /docs -----------------------------------------------------------------------------------------------------

export const DOCS_MARKET_EXAMPLE = {
  platform: "custom", external_id: "demo-pr-4821",
  condition: "Will PR #4821 in octo-org/octo-repo be merged before 2026-12-01 00:00 UTC?",
  event_statement: "PR #4821 in octo-org/octo-repo is merged",
  option_a: "Yes", option_b: "No", positive_option: "OPTION_A",
  anchors: ["octo-org/octo-repo", "#4821"],
  sources: [{ kind: "github_api", ref: "repos/octo-org/octo-repo/pulls/4821" }],
  resolver: { kind: "github_pr_merged", repo: "octo-org/octo-repo", pr: 4821 },
  open_at: "2026-10-01T00:00:00Z", deadline_utc: "2026-12-01T00:00:00Z",
} as const;

export function docsHtml(o: { base: string; channel: string | null; card?: boolean }): string {
  const b = esc(o.base);
  const market = esc(JSON.stringify(DOCS_MARKET_EXAMPLE, null, 2));
  const body = `<h1>Quickstart</h1>
<p class="lede">Every call below is in the <a href="/openapi.json">OpenAPI document</a>. Authenticate with <code>Authorization: Bearer &lt;key&gt;</code> (or <code>X-Api-Key</code>).</p>
<h2>1. Request a key</h2>
<p>Use the <a href="/#request-key">form</a>, or:</p>
<pre>curl -X POST ${b}/v1/request-key \\
  -H 'content-type: application/json' \\
  -d '{"name":"Ada","email":"ada@example.com","company":"Example Bots","purpose":"Settle CPI markets for our bot"}'</pre>
<p>The answer carries a test key, once (<code>data.key</code>; the form shows it on the next page). Store it then: Resolve keeps only its hash. A test key starts with <code>rsl_test_</code> and carries ${int(FREE_EVALUATION_CREDITS)} credits for ${EVALUATION_KEY_DAYS} days, for structured verdicts, with up to ${EVALUATION_WATCH_LIMIT} watches. One key per email address every ${EVALUATION_KEY_DAYS} days; when a key cannot be issued on the spot (<code>key_issued: false</code>), a person reads the request and answers by email.</p>
${o.card ? `<p>When the test credits run out, <a href="${PAY_BY_CARD_PATH}">pay by card</a> for a credit pack (step 6): the same key keeps working and stops expiring.</p>\n` : ""}
<h2>2. Register a market</h2>
<pre>curl -X POST ${b}/v1/markets \\
  -H "Authorization: Bearer $RESOLVE_KEY" -H 'content-type: application/json' \\
  -d '${market}'</pre>
<p>The answer carries <code>market_id</code>, <code>status</code> and the watches created. Registering the same <code>external_id</code> again returns the existing market.</p>
<h2>3. Resolve it</h2>
<pre>curl -X POST ${b}/v1/resolve \\
  -H "Authorization: Bearer $RESOLVE_KEY" -H 'content-type: application/json' \\
  -H 'Idempotency-Key: 9f1c0b9e-demo' \\
  -d '{"market_id":"&lt;market_id&gt;","fetch":true}'</pre>
<p>The verdict carries <code>resolution_status</code> (RESOLVED, UNRESOLVED or ERROR), <code>winning_outcome</code>, <code>confidence_score</code> and <code>caveats</code>, plus <code>credits_charged</code> and <code>balance</code>. A replay of the same <code>Idempotency-Key</code> is never charged twice.</p>
<h2>4. Follow a public market and receive webhooks</h2>
<pre>curl -X POST ${b}/v1/webhooks \\
  -H "Authorization: Bearer $RESOLVE_KEY" -H 'content-type: application/json' \\
  -d '{"url":"https://example.com/resolve-hook","events":["shadow.committed","shadow.revealed"]}'

curl -X POST ${b}/v1/markets/polymarket:&lt;external_id&gt;/follow -H "Authorization: Bearer $RESOLVE_KEY"</pre>
<p>A public market is named by its id exactly as the <a href="/record">record</a> and the home page's table of scheduled releases print it, <code>platform:external_id</code> (above, <code>&lt;external_id&gt;</code> is a placeholder, not a real market: copy an id from those pages), or by its uuid. <code>GET /v1/shadow/&lt;id&gt;</code> reads its committed verdicts with the same id. The endpoint's secret is shown once. Each delivery carries <code>X-Resolve-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>, where the hex is HMAC-SHA256 of <code>&lt;t&gt;.&lt;raw body&gt;</code> with that secret, and <code>X-Resolve-Event-Id</code>, by which you drop duplicates. Verify before you parse (Node):</p>
<pre>import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) =&gt; p.split("=")));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) &gt; toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(\`\${parts.t}.\${rawBody}\`).digest("hex");
  const got = String(parts.v1 ?? "");
  return got.length === expected.length &amp;&amp; timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}</pre>
<h2>5. Verify a commitment</h2>
<pre>curl '${b}/v1/track-record/verify?hash=&lt;commitment sha256&gt;'</pre>
<p>After the reveal the answer includes <code>preimage</code>. Recompute the hash and compare:</p>
<pre>printf '%s' "$PREIMAGE" | shasum -a 256</pre>
<p>The output must equal <code>commitment_sha256</code>. The whole record is at <a href="/record">/record</a>.</p>
<h2 id="pay-by-card">6. Pay by card</h2>
<p>Resolve is a developer data API, paid for in credits. The ${esc(listed(PACK_IDS.map((k) => `${dollars(CARD_PACKS[k].priceCents)} (${int(CARD_PACKS[k].credits)} credits)`)))} packs can be paid by card through Whop, which processes the payment as the merchant of record. Open a checkout for the account of your key:</p>
<pre>curl -X POST ${b}/v1/billing/checkout \\
  -H "Authorization: Bearer $RESOLVE_KEY" -H 'content-type: application/json' \\
  -d '{"pack":"50"}'</pre>
<p>Send the buyer to <code>data.checkout_url</code> (the <a href="/pricing#pay-by-card">pricing page</a> has the same as a form). Whop tells Resolve when the payment is confirmed, and the credits are added to the account then, usually within a minute: <code>GET /v1/account</code> shows the balance. Your key is never sent to Whop. A free test key's account becomes pay as you go with its first pack, and the key stops expiring.</p>
<p>Credits are a non-refundable prepayment for API services. They pay for this API only: they cannot be withdrawn or moved to another account, and they do not expire while the account is open. If a card payment is refunded or charged back, the credits it bought are removed from the account.</p>
${o.card ? "" : `<p class="note">Card checkout is not open yet: until it is, <code>POST /v1/billing/checkout</code> answers 503.</p>\n`}`;
  return layout({ title: "Docs · Resolve", path: "/docs", description: "Resolve quickstart: request a key, register a market, resolve it, receive webhooks and verify a commitment.", body, channel: o.channel });
}

const baseUrl = (c: Context<{ Bindings: Env; Variables: Vars }>) => (c.env.RESOLVE_PUBLIC_URL?.replace(/\/+$/, "") || new URL(c.req.url).origin);

site.get("/docs", (c) => page(c, docsHtml({ base: baseUrl(c), channel: channelUrl(c.env), card: cardCheckoutOffered(whopConfig(c.env)) })));

// ---- GET /terms ----------------------------------------------------------------------------------------------------

export function termsHtml(o: { channel: string | null }): string {
  const body = `<h1>Terms</h1>
<p class="lede">Short and plain. Using the API or this site means you accept them.</p>
<h2>What Resolve is</h2>
<p>Resolve provides an informational signal: its reading of whether a market's stated condition happened, from the sources registered for that market. It is not financial advice and not an oracle of record. The venue's own resolution process decides every market; your decisions stay yours.</p>
<h2>Credits</h2>
<p>Credits are a non-refundable prepayment for API services. They are not a balance, deposit or stored value, and cannot be withdrawn, transferred to another account, or exchanged for money or crypto. A verdict that fails because an upstream is unavailable is refunded in credits, never in money. Credits do not expire while the account is open.</p>
<p>When you pay by card, Whop processes the payment as the merchant of record and handles any card dispute. If a card payment is refunded or charged back, the credits it bought are removed from the account (as far as the balance allows).</p>
<h2>No guarantee</h2>
<p>There is no service-level agreement and no lead-time promise. The service is provided as is.</p>
<h2>Acceptable use</h2>
<ul>
<li>Do not use the service for anything unlawful, or to manipulate a market.</li>
<li>Do not register sources you are not allowed to have fetched, or try to reach private networks through them.</li>
<li>Do not share or resell your key, or work around rate limits and caps.</li>
<li>Do not present a Resolve verdict as the venue's official resolution.</li>
</ul>
<p>A key used against these terms may be revoked.</p>
<h2 id="contact">Contact</h2>
<p>Use the <a href="/#request-key">request form</a> and say what it is about; we answer by email. To stop ResolveBot fetching your pages, see <a href="/bot">/bot</a>.</p>`;
  return layout({ title: "Terms · Resolve", path: "/terms", description: "Resolve terms: informational signal, credits, acceptable use and contact.", body, channel: o.channel });
}

site.get("/terms", (c) => page(c, termsHtml({ channel: channelUrl(c.env) })));

// ---- POST /v1/request-key ------------------------------------------------------------------------------------------

const URLISH = /(https?:|www\.|\/\/|[a-z0-9-]+\.(com|net|org|io|xyz|ru|top|info|biz|co|me|app|link|site|online)\b)/i;
const clean = (max: number) => z.string().trim().min(1, "is required").max(max, `must be at most ${max} characters`);

export const KeyRequest = z.object({
  name: clean(100).refine((s) => !URLISH.test(s), "must not contain a link"),
  email: z.string().trim().max(254, "must be at most 254 characters").pipe(z.email("must be an email address")),
  company: clean(200),
  purpose: clean(1000),
  venue: z.string().trim().max(100, "must be at most 100 characters").optional().transform((v) => (v ? v : null)),
  website: z.string().optional(),
});
export type KeyRequest = z.infer<typeof KeyRequest>;

export const REQUEST_KEY_LIMIT = { perIpPerHour: 5, allPerHour: 60 } as const;

/** a***@example.com: the alert names the domain, never the full address (the lead row keeps it). */
export { maskEmail };

const VENUES = new Set(["polymarket", "limitless"]);

/**
 * The page that shows a new evaluation key: the key exactly once, what it can do, where to start, and while card checkout
 * is offered, where to buy credits. Never cached.
 */
export function keyIssuedHtml(o: { key: string; expiresAt: string; base: string; channel: string | null; card?: boolean }): string {
  const body = `<h1>Your test key</h1>
<p class="note" role="alert">Copy it now: this is the only time it is shown. Resolve keeps only a hash of it, so it cannot be shown again or recovered.</p>
<pre><code>${esc(o.key)}</code></pre>
<h2>What it can do</h2>
<ul>
<li>Structured verdicts only: markets settled from machine-readable sources (official releases, GitHub objects, on-chain logs), 1 credit each.</li>
<li>${int(FREE_EVALUATION_CREDITS)} credits, valid ${EVALUATION_KEY_DAYS} days: until ${esc(utc(o.expiresAt))}.</li>
<li>Up to ${EVALUATION_WATCH_LIMIT} watches.</li>
</ul>
<h2>Next</h2>
<p>Send it as <code>Authorization: Bearer &lt;key&gt;</code> (or <code>X-Api-Key</code>). Check it:</p>
<pre>curl ${esc(o.base)}/v1/account -H "Authorization: Bearer $RESOLVE_KEY"</pre>
<p>The <a href="/docs">quickstart</a> registers a market, resolves it and sets up webhooks. <a href="/pricing">Pricing</a> lists what comes after the test key.</p>
${o.card ? `<p>When the ${int(FREE_EVALUATION_CREDITS)} credits run out, <a href="${PAY_BY_CARD_PATH}">pay by card</a> for a credit pack with this key: the credits go to its account and the key stops expiring.</p>\n` : ""}`;
  return layout({ title: "Your test key · Resolve", path: "/v1/request-key", description: "Your Resolve test key.", body, channel: o.channel });
}

/** A known address's tenant created this recently is most likely the same form sent twice (a double click, a reload). */
const DOUBLE_SUBMIT_SECONDS = 600;

/** Pure. What happened to the key, for the operator alert: ids and reasons, never the key. */
export function keyOutcomeLine(o: AutoKeyOutcome): string {
  const hold = (h: string | null) => (h ? `; ${h}` : "");
  switch (o.result) {
    case "issued": return `issued on the spot: tenant ${o.tenantId}, key id ${o.keyId}, ${o.credits} credits, expires ${utc(o.expiresAt)}`;
    case "off": return `not issued (${o.reason}); answer by email`;
    case "known_address": return `not issued: tenant ${o.tenantId} was created for this address ${utc(o.createdAt)}, within ${EVALUATION_KEY_DAYS} days${o.secondsAgo < DOUBLE_SUBMIT_SECONDS ? ` (${o.secondsAgo} s ago: most likely the same form sent twice, so the requester may never have seen the key; issue one by hand)` : ""}; answer by email`;
    case "address_held": return `not issued: another request for this address holds it${o.until ? ` until ${utc(o.until)}` : ""} (one running at the same moment, or one that ended without a key and could not release it); answer by email`;
    case "network_limit": return `not issued: ${o.limit} keys were already issued on the spot to this network today${hold(o.hold)}; answer by email`;
    case "cap_reached": return `not issued: today's cap of ${o.cap} keys issued on the spot is reached${hold(o.hold)}; answer by email (scripts/issue-test-key.ts issues one by hand)`;
    case "db_error": return `not issued: database error at ${o.step}: ${o.detail}${o.tenantId ? `; tenant ${o.tenantId} was created without a key` : ""}${hold(o.hold)}; answer by email`;
  }
}

function wantsJson(c: Context<{ Bindings: Env; Variables: Vars }>, isJsonBody: boolean): boolean {
  return isJsonBody || (c.req.header("accept") ?? "").includes("application/json");
}

site.post("/v1/request-key", async (c) => {
  // No answer of this route is ever cached, JSON or HTML, error or not: one of them carries a key.
  c.header("Cache-Control", "no-store");
  const ctype = (c.req.header("content-type") ?? "").toLowerCase();
  const isJson = ctype.includes("application/json");
  const json = wantsJson(c, isJson);
  const channel = channelUrl(c.env);
  const htmlAnswer = (status: 200 | 400 | 429 | 503, title: string, text: string, form?: { values: Record<string, string>; error: string }) =>
    page(c, layout({ title: `${title} · Resolve`, path: "/v1/request-key", description: title, channel, body: `<h1>${esc(title)}</h1><p>${esc(text)}</p>${form ? requestKeyForm(form.values, form.error) : `<p><a href="/">Back to the home page</a></p>`}` }), status, false);
  const fail = (status: 400 | 429 | 503, code: Parameters<typeof err>[1], title: string, text: string, form?: { values: Record<string, string>; error: string }) =>
    json ? err(c, code, text, status) : htmlAnswer(status, title, text, form);

  let raw: Record<string, unknown>;
  if (Number(c.req.header("content-length") ?? 0) > 16_384) return fail(400, "validation_error", "Request too large", "The request body is too large.");
  try {
    if (isJson) {
      const text = await c.req.text();
      if (text.length > 8192) return fail(400, "validation_error", "Request too large", "The request body is too large.");
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      raw = parsed as Record<string, unknown>;
    } else if (ctype.includes("application/x-www-form-urlencoded")) {
      const text = await c.req.text();
      if (text.length > 8192) return fail(400, "validation_error", "Request too large", "The request body is too large.");
      raw = Object.fromEntries(new URLSearchParams(text));
    } else {
      return fail(400, "validation_error", "Unsupported request", "Send the form, or JSON with content-type application/json.");
    }
  } catch {
    return fail(400, "validation_error", "Invalid request", "The request body could not be read.");
  }
  // "project" is accepted as an alias of "company".
  if (raw.company === undefined && typeof raw.project === "string") raw.company = raw.project;
  const values = Object.fromEntries(["name", "email", "company", "purpose", "venue"].map((k) => [k, typeof raw[k] === "string" ? String(raw[k]).slice(0, 1000) : ""]));
  const p = KeyRequest.safeParse(raw);
  if (!p.success) {
    const msg = p.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ");
    return fail(400, "validation_error", "Please check the form", `Please check the form: ${msg}.`, { values, error: msg });
  }
  const r = p.data;
  // One neutral answer for every request that gets no key (a known address, a limit, a database error, a bot):
  // it never says which.
  const done = () => json
    ? ok(c, { received: true, key_issued: false, note: "No key was issued with this answer. A person reads the request and answers by email." })
    : htmlAnswer(200, "Request received", "Thank you. No key was issued on this page; a person reads your request and answers by email.");
  // A filled honeypot is a bot: it gets the same answer and nothing is stored.
  if (r.website && r.website.trim() !== "") return done();

  const client = db(c.env);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const unavailable = () => fail(503, "UPSTREAM_UNAVAILABLE", "Temporarily unavailable", "We could not take the request right now. Nothing was stored; please try again in a few minutes.");
  // Fail closed: without a working rate limit nothing is stored.
  try {
    const [perIp, all] = await Promise.all([
      client.rpc("rate_limit_hit", { p_key: `request_key:ip:${ip}`, p_window_ms: 3_600_000, p_limit: REQUEST_KEY_LIMIT.perIpPerHour }),
      client.rpc("rate_limit_hit", { p_key: "request_key:all", p_window_ms: 3_600_000, p_limit: REQUEST_KEY_LIMIT.allPerHour }),
    ]);
    if (perIp.error || all.error) return unavailable();
    const first = (d: unknown) => (Array.isArray(d) ? d[0] : d) as { allowed?: boolean } | null;
    if (first(perIp.data)?.allowed !== true || first(all.data)?.allowed !== true) {
      return fail(429, "rate_limited", "Too many requests", "Too many requests from here in the last hour. Please try again later.");
    }
  } catch { return unavailable(); }

  const venue = r.venue;
  const platform = venue && VENUES.has(venue.toLowerCase()) ? venue.toLowerCase() : null;
  const notes = `Inbound test-key request (web form, request ${c.get("requestId")}). Purpose: ${r.purpose}${venue ? `\nVenue: ${venue}` : ""}`;
  let leadId: string;
  try {
    const { data, error } = await client.from("leads").insert({ name: r.name, org: r.company, platform, channel: "form", contact: r.email, status: "prospect", notes }).select("id").single();
    if (error || !data) return unavailable();
    leadId = String((data as { id: string }).id);
  } catch { return unavailable(); }

  // The key, when every check passes (src/api/evaluation-key.ts). Anything else, a database error included, is the
  // neutral answer below with the lead stored and the operator alerted.
  const issued = await issueEvaluationKey(client, { email: r.email, company: r.company, ip, leadId, requestId: c.get("requestId"), now: Date.now(), dailyCap: c.env.REQUEST_KEY_DAILY_CAP });

  let touch = "recorded";
  try {
    const keyNote = issued.result === "issued" ? `evaluation key issued on the spot (key id ${issued.keyId}, expires ${utc(issued.expiresAt)})` : "no key issued on the spot";
    const { error } = await client.rpc("log_touch", { p_lead: leadId, p_kind: "email", p_direction: "in", p_summary: `Test-key request via the web form; ${keyNote}. Purpose: ${r.purpose}`.slice(0, 1200), p_request_id: `request-key:${c.get("requestId")}` });
    if (error) touch = `not recorded (${String(error.message ?? "").slice(0, 120)})`;
  } catch (e) { touch = `not recorded (${String(e).slice(0, 120)})`; }

  const ids = issued.result === "issued" ? { tenant_id: issued.tenantId, key_id: issued.keyId } : (issued.result === "db_error" || issued.result === "known_address") && issued.tenantId ? { tenant_id: issued.tenantId } : {};
  await alert(c.env, `request_key_${leadId}`, [
    "Test-key request (web form)",
    `Name: ${r.name}`, `Project: ${r.company}`, `Purpose: ${r.purpose.slice(0, 600)}`, venue ? `Venue: ${venue}` : null,
    `Email: ${maskEmail(r.email)} (full address in leads ${leadId})`, `Key: ${keyOutcomeLine(issued)}`, `Touch: ${touch}`,
  ].filter(Boolean).join("\n"), { dedupMinutes: 1, meta: { lead_id: leadId, key_result: issued.result, ...ids } });

  if (issued.result !== "issued") return done();
  const card = cardCheckoutOffered(whopConfig(c.env));
  if (json) {
    return ok(c, {
      received: true, key_issued: true, key: issued.key, key_id: issued.keyId, environment: "test", plan: "free", credits: issued.credits,
      watch_limit: EVALUATION_WATCH_LIMIT, expires_at: issued.expiresAt, docs: `${baseUrl(c)}/docs`, ...(card ? { pay_by_card: `${baseUrl(c)}${PAY_BY_CARD_PATH}` } : {}),
      note: "Shown once: Resolve keeps only its hash. Structured verdicts only.",
    });
  }
  return page(c, keyIssuedHtml({ key: issued.key, expiresAt: issued.expiresAt, base: baseUrl(c), channel, card }), 200, false);
});

// ---- POST /billing/checkout, GET /billing/done ---------------------------------------------------------------------

/** The form's body: two short fields. */
const CHECKOUT_FORM_MAX = 4096;

/**
 * The /pricing card form: the key in the form body (a page without script cannot set a header), authenticated and rate
 * limited like any API call, then a 303 to the Whop checkout opened for that key's tenant. Whop receives the tenant id
 * only. No answer repeats the key, every answer is no-store, and the page that carries the form again after a refusal
 * never fills the key in. The flag, the configuration and the pack are checked before the key is read.
 */
site.post("/billing/checkout", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const cfg = whopConfig(c.env);
  const channel = channelUrl(c.env);
  const answer = (status: 400 | 401 | 429 | 503, title: string, text: string) => {
    const form = cardCheckoutOffered(cfg);
    const body = `<h1>${esc(title)}</h1><p>${esc(text)}</p>${form ? payByCardHtml({ base: baseUrl(c) }) : `<p><a href="/pricing">Back to pricing</a></p>`}`;
    return page(c, layout({ title: `${title} · Resolve`, path: "/billing/checkout", description: title, channel, body }), status, false, form ? cardFormCsp(cfg) : SITE_CSP);
  };
  const refused = await checkoutRefusal(c.env, cfg, "POST /billing/checkout");
  if (refused) return answer(503, "Card checkout unavailable", refused.message);
  if (!(c.req.header("content-type") ?? "").toLowerCase().includes("application/x-www-form-urlencoded")) return answer(400, "Unsupported request", "Send the form on the pricing page, or use POST /v1/billing/checkout with your key in the Authorization header.");
  if (Number(c.req.header("content-length") ?? 0) > CHECKOUT_FORM_MAX) return answer(400, "Request too large", "The request body is too large.");
  const text = await c.req.text();
  if (text.length > CHECKOUT_FORM_MAX) return answer(400, "Request too large", "The request body is too large.");
  const f = new URLSearchParams(text);
  const pack = f.get("pack");
  if (!isPackId(pack)) return answer(400, "Please choose a pack", `Choose one of the packs: ${listed(PACK_IDS.map((k) => dollars(CARD_PACKS[k].priceCents)), "or")}.`);
  const a = await authenticateKey(c, f.get("key")?.trim() || null);
  if (!a.ok) {
    // The refusal's own message (auth.ts): it names the problem, never the key.
    const e = (await a.response.clone().json().catch(() => null)) as { error?: { message?: unknown } } | null;
    const msg = typeof e?.error?.message === "string" ? e.error.message : "The key was not accepted.";
    return a.response.status === 429 ? answer(429, "Too many requests", msg) : answer(401, "Key not accepted", msg);
  }
  const rl = await rateLimit(c, a.auth, { jev: false, jevRpmLimit: 1 });
  if (!rl.allowed) return answer(429, "Too many requests", "Too many requests for this key in the last minute. Please try again shortly.");
  const r = await startCheckout(c, cfg, a.auth, pack);
  if (!r.ok) return answer(503, "Checkout unavailable", "The checkout could not be opened right now. Nothing was charged; please try again in a few minutes.");
  return c.redirect(r.url, 303);
});

/** Where Whop sends the buyer back. It reads nothing and trusts no query parameter: the credits come only from Whop's webhook. */
export function billingDoneHtml(o: { channel: string | null }): string {
  const body = `<h1>Thank you</h1>
<p>If the payment went through, Whop confirms it to Resolve directly and the credits are added to your account, usually within a minute. <code>GET /v1/account</code> shows the balance.</p>
<p>If it did not go through, nothing was charged: you can try again from the <a href="/pricing#pay-by-card">pricing page</a>.</p>
<p class="muted">This page does not look at the payment; only Whop's confirmation adds credits.</p>`;
  return layout({ title: "Payment · Resolve", path: "/billing/done", description: "After a card payment for Resolve credits.", body, channel: o.channel });
}

site.get("/billing/done", (c) => page(c, billingDoneHtml({ channel: channelUrl(c.env) })));

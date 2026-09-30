/**
 * The public site (src/api/site.ts): every page answers 200 with zero rows and with sample rows, escapes every dynamic
 * value, never names the model or its vendor, prints no percentage before the view marks a platform reportable, keeps
 * each page to <= 3 database reads, and carries the CSP / nosniff / referrer / cache headers. POST /v1/request-key
 * validates, rate-limits (failing closed), stores a lead plus an inbound touch, and alerts the operator with a masked email;
 * here with keys on the spot switched off (REQUEST_KEY_DAILY_CAP "0"), which is exactly the form without them. The key
 * it issues otherwise is tests/instant-key.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, alerts: [] as Array<{ key: string; text: string }> }));
vi.mock("../src/db/supabase", () => ({ db: () => h.db.client, rpc: async () => { throw new Error("unused"); } }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async (_env: unknown, key: string, text: string) => { h.alerts.push({ key, text }); return { sent: true, deduped: false }; }) }));

import { app } from "../src/index";
import { MarketRegistration } from "../src/resolve/schema";
import { DOCS_INLINE_EVIDENCE_EXAMPLE, DOCS_MARKET_EXAMPLE, DOCS_OFFICIAL_MARKET_EXAMPLE, QUICKSTART_PRINT, maskEmail, officialReleaseAt, SITE_CSP, summarizeRecord, upcomingReleases } from "../src/api/site";
import { validateRegistration } from "../src/markets/register";
import { registrationPolicyIssues } from "../src/markets/policy";
import { EvidenceInput } from "../src/resolve/schema";
import { thresholdsFromEnv } from "../src/resolve/thresholds";
import { resolveMarket } from "../src/resolve";
import { KNOWN_RELEASES } from "../src/resolve/official";

const NAMES = /jev|typesafe/i;
const PAGES = ["/", "/record", "/pricing", "/docs", "/terms"];
const env = { CREDITS_PER_USDC: "100", PUBLIC_CHANNEL_URL: "https://t.me/resolve_feed" } as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const NOW = Date.parse("2026-09-28T00:00:00Z");
const HASH = "ab".repeat(32);
const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

function rateRpc(allowed = true, error: unknown = null) {
  return async () => ({ data: error ? null : [{ allowed, remaining: 0, reset_at: "2026-09-28T01:00:00Z" }], error });
}
const touchRpc = async (db: FakeDb, a: Record<string, any>) => {
  (db.tables.gtm_touches ??= []).push({ id: `t-${db.tables.gtm_touches.length + 1}`, lead_id: a.p_lead, kind: a.p_kind, direction: a.p_direction, summary: a.p_summary, request_id: a.p_request_id });
  return { data: "touch-1", error: null };
};

function sampleDb(): FakeDb {
  return fakeDb({
    markets: [
      { id: "m1", platform: "polymarket", event_key: "official:us_cpi_u_nsa_yoy:2026-09", tenant_id: null, is_test: false, deleted_at: null },
      { id: "m2", platform: "polymarket", event_key: "official:us_cpi_u_nsa_yoy:2026-09", tenant_id: null, is_test: false, deleted_at: null },
      { id: "m3", platform: "limitless", event_key: "official:us_cpi_u_nsa_yoy:2026-09", tenant_id: null, is_test: false, deleted_at: null },
      { id: "m4", platform: "limitless", event_key: "official:us_cpi_u_nsa_yoy:2026-09", tenant_id: null, is_test: true, deleted_at: null },
    ],
    v_track_record: [
      { platform: "polymarket", week: "2026-10-12T00:00:00+00:00", n_events_committed: 2, n_events_reconciled: 1, n_events_reconciled_cumulative: 1, resolved_correct_cumulative: 3, resolved_wrong_cumulative: 1, abstained_cumulative: 0, voided: 0, unresolved_by_platform: 0, reportable: false, precision: null, jev_share: 0 },
    ],
    v_venue_report: [
      { platform: "polymarket", external_id: "<script>alert(1)</script>", event_key: "official:us_unemployment_rate:2026-09", committed_at: "2026-10-02T12:30:41Z", latest_committed_at: "2026-10-02T12:30:41Z", latest_commitment_sha256: HASH, official_at: "2026-10-02T14:00:00Z", agreement: "agree", n_commits: 1 },
      { platform: "limitless", external_id: "fed-oct", event_key: "limitless:group:9", committed_at: "2026-10-01T09:00:00Z", latest_committed_at: "2026-10-01T09:00:00Z", latest_commitment_sha256: "\"><img>", official_at: null, agreement: null, n_commits: 1 },
      { platform: "polymarket", external_id: "never", event_key: "x", committed_at: null, latest_committed_at: null, latest_commitment_sha256: null, official_at: null, agreement: null, n_commits: 0 },
    ],
    app_config: [{ key: "payg_tiers", value: '[{"min_usdc":1000,"credits_per_usdc":120},{"min_usdc":250,"credits_per_usdc":110},{"min_usdc":0,"credits_per_usdc":100}]' }],
  });
}

beforeEach(() => { h.alerts = []; vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("pages", () => {
  for (const [label, mk] of [["zero rows", () => fakeDb({})], ["sample rows", sampleDb]] as const) {
    for (const p of PAGES) {
      it(`${p} answers 200 with ${label}: HTML, headers, no model name, <= 3 reads`, async () => {
        h.db = mk();
        const res = await app.request(p, {}, env, ctx);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.headers.get("content-security-policy")).toBe(SITE_CSP);
        expect(SITE_CSP).toContain("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("referrer-policy")).toBeTruthy();
        expect(res.headers.get("cache-control")).toContain("max-age=60");
        const html = await res.text();
        expect(html).not.toMatch(NAMES);
        expect(JSON.stringify([...res.headers])).not.toMatch(NAMES);
        // no script, no external asset or link: only the channel, example.com, localhost, and the GitHub API URL of the
        // /docs illustration's evidence (a value inside a code sample, not a link)
        expect(html).not.toMatch(/<script|https?:\/\/(?!t\.me\/resolve_feed|example\.com|localhost|api\.github\.com\/repos\/octo-org\/)[a-z]/i);
        expect(h.db.calls.length).toBeLessThanOrEqual(3);
        expect(html).toContain('href="https://t.me/resolve_feed"');
      });
    }
  }

  it("the channel link is omitted when PUBLIC_CHANNEL_URL is unset or not https", async () => {
    h.db = fakeDb({});
    for (const PUBLIC_CHANNEL_URL of [undefined, "javascript:alert(1)", "http://t.me/x"]) {
      const html = await (await app.request("/", {}, { ...env, PUBLIC_CHANNEL_URL } as Env, ctx)).text();
      expect(html).not.toContain("Telegram channel");
      expect(html).not.toContain("javascript:");
    }
  });

  it("/ lists the upcoming known releases with public non-test market counts per venue, and the request form", async () => {
    h.db = sampleDb();
    const html = await (await app.request("/", {}, env, ctx)).text();
    expect(html).toContain("2026-10-14 12:30 UTC");
    expect(html).toContain("Limitless: 1 market<br>Polymarket: 2 markets");
    expect(html).toContain('action="/v1/request-key"');
    for (const l of ["/record", "/pricing", "/docs", "/openapi.json"]) expect(html).toContain(`href="${l}"`);
    // the form says the key is shown on the next page, with its terms from the code that issues it
    expect(html).toContain("A free test key carries 300 credits for 30 days, for structured verdicts, with up to 5 watches");
    expect(html).toContain("the key is shown on the next page, once");
    expect(html).not.toMatch(/no key is issued automatically/i);
  });

  it("upcomingReleases: only releases after now, soonest first", () => {
    const rows = upcomingReleases(Date.parse("2026-10-03T00:00:00Z"), []);
    expect(rows.every((r) => Date.parse(r.release_at) > Date.parse("2026-10-03T00:00:00Z"))).toBe(true);
    expect(rows.map((r) => r.release_at)).toEqual([...rows.map((r) => r.release_at)].sort());
    // the September print is out: the series shows its October data (Nov 6), never the past event
    expect(rows.filter((r) => r.series === "us_unemployment_rate")).toEqual([expect.objectContaining({ period: "2026-10", release_at: "2026-11-06T13:30:00Z" })]);
    expect(Object.keys(KNOWN_RELEASES)).toContain("us_unemployment_rate:2026-09");
  });

  it("upcomingReleases: one row per series, its next release, however far ahead the registry reaches", () => {
    const series = (k: string) => k.slice(0, k.indexOf(":"));
    expect(new Set(Object.keys(KNOWN_RELEASES).filter((k) => series(k) === "fomc_upper_bound")).size).toBeGreaterThan(3); // the calendar holds 2027
    for (const at of ["2026-09-28T00:00:00Z", "2026-10-15T13:00:00Z", "2026-11-11T00:00:00Z", "2027-02-01T00:00:00Z"]) {
      const now = Date.parse(at);
      const rows = upcomingReleases(now, [], 1000).filter((r) => !r.event_key.startsWith("election:"));
      expect(new Set(rows.map((r) => r.series)).size, at).toBe(rows.length);
      for (const r of rows) {
        const soonest = Object.entries(KNOWN_RELEASES).filter(([k, v]) => series(k) === r.series && Date.parse(v.release_at) > now).map(([, v]) => v.release_at).sort()[0];
        expect(r.release_at, `${at} ${r.series}`).toBe(soonest);
      }
      expect(upcomingReleases(now, []).length).toBeLessThanOrEqual(20);
    }
    // before the September CPI is out its October successor is not a row, and its markets are not asked for
    const rows = upcomingReleases(NOW, [{ platform: "polymarket", event_key: "official:us_cpi_u_nsa_yoy:2026-10" }]);
    expect(rows.flatMap((r) => r.event_keys)).not.toContain("official:us_cpi_u_nsa_yoy:2026-10");
    expect(rows.find((r) => r.series === "us_cpi_u_nsa_yoy")).toMatchObject({ period: "2026-09", markets: {} });
    // once it is out, the October CPI is the row, with its markets
    expect(upcomingReleases(Date.parse("2026-10-14T12:31:00Z"), [{ platform: "polymarket", event_key: "official:us_cpi_u_nsa_yoy:2026-10" }]).find((r) => r.series === "us_cpi_u_nsa_yoy"))
      .toMatchObject({ period: "2026-10", release_at: "2026-11-10T13:30:00Z", markets: { polymarket: 1 } });
    // every series of the registry still has a row on the landing date (15 rows: 13 series, 2 elections)
    expect(upcomingReleases(NOW, [])).toHaveLength(15);
  });

  it("upcomingReleases: an election's contests are one row with their markets summed, and never crowd out the releases after it", () => {
    const rows = upcomingReleases(NOW, [
      { platform: "polymarket", event_key: "official:qc_seats_caq:2026-10-05" }, { platform: "polymarket", event_key: "official:qc_riding_751:2026-10-05" },
      { platform: "polymarket", event_key: "official:br_pres_r1_turnout:2026-10-04" },
    ]);
    const qc = rows.filter((r) => r.event_key.startsWith("election:eq:"));
    expect(qc).toHaveLength(1);
    expect(qc[0]).toMatchObject({ event_key: "election:eq:2026-10-05", period: "2026-10-05", release_at: "2026-10-06T00:00:00Z", markets: { polymarket: 2 } });
    expect(qc[0]!.event_keys).toHaveLength(30);
    expect(qc[0]!.label).toContain("30 contests");
    expect(rows.filter((r) => r.event_key.startsWith("election:tse:"))).toEqual([expect.objectContaining({ markets: { polymarket: 1 }, release_at: "2026-10-04T20:00:00Z" })]);
    expect(rows.map((r) => r.event_key)).toContain("official:us_cpi_u_nsa_yoy:2026-09");
    expect(rows.every((r) => r.event_key.startsWith("election:") || r.event_keys.length === 1)).toBe(true);
  });

  it("/record with zero rows says the record is too young and shows upcoming releases", async () => {
    h.db = fakeDb({});
    const html = await (await app.request("/record", {}, env, ctx)).text();
    expect(html).toContain("The record is too young for percentages");
    expect(html).toContain("No public commitment has been recorded yet");
    expect(html).toContain("2026-10-02 12:30 UTC");
    expect(text(html)).not.toMatch(/\d\s*%(?! interval)/);
  });

  it("/record with rows: escaped external_id, verify link, seconds from release to commit, no percentage before n >= 100", async () => {
    h.db = sampleDb();
    const html = await (await app.request("/record", {}, env, ctx)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("polymarket:&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(`href="/v1/track-record/verify?hash=${HASH}"`);
    expect(html).not.toContain("<img>");
    expect(html).toContain("41 s");
    expect(html).toContain("The record is too young for percentages");
    expect(text(html)).not.toMatch(/\d\s*%(?! interval)/);
    expect(text(html)).toContain("2 events committed");
    expect(html).not.toContain("never");
  });

  it("/record prints percentages only once the view marks the platform reportable", async () => {
    h.db = sampleDb();
    h.db.tables.v_track_record = [{ platform: "polymarket", week: "2027-03-01T00:00:00+00:00", n_events_reconciled_cumulative: 100, resolved_correct_cumulative: 150, resolved_wrong_cumulative: 3, abstained_cumulative: 4, reportable: true, precision: 0.9804, wilson_low: 0.94, wilson_high: 0.99, event_precision: 0.97, event_wilson_low: 0.92, event_wilson_high: 0.99 }];
    const html = await (await app.request("/record", {}, env, ctx)).text();
    expect(html).toContain("98.0 %");
    expect(html).not.toContain("too young");
    const s = summarizeRecord(h.db.tables.v_track_record, []);
    expect(s).toMatchObject({ events_reconciled: 100, agree: 150, disagree: 3, abstained: 4 });
  });

  it("/record answers 503 HTML when the store is unavailable", async () => {
    h.db = fakeDb({});
    const from = h.db.client.from;
    h.db.client.from = ((t: string) => (t === "v_track_record" ? { select: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "down" } }) }) }) } : from(t))) as never;
    const res = await app.request("/record", {}, env, ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("officialReleaseAt reads the release time from the event key", () => {
    expect(officialReleaseAt("official:us_unemployment_rate:2026-09")).toBe("2026-10-02T12:30:00Z");
    expect(officialReleaseAt("polymarket:event:1")).toBeNull();
  });

  it("/pricing shows the offers, pack credits from payg_tiers, the payment line and no wallet address", async () => {
    h.db = sampleDb();
    const t = text(await (await app.request("/pricing", {}, env, ctx)).text());
    for (const s of ["$99 a month", "$399 a month", "$750 a month", "$1,000 for 30 days", "300 credits for 30 days", "5,000", "27,500", "120,000", "1 credit", "5 credits", "Invoiced in USD; ask us for payment options", "non-refundable prepayment for API services"]) expect(t).toContain(s);
    expect(t).not.toMatch(/0x[0-9a-f]{40}/i);
  });

  it("/docs: the signature snippet matches the header format; the key terms are the code's", async () => {
    h.db = fakeDb({});
    const html = await (await app.request("/docs", {}, env, ctx)).text();
    expect(html).toContain("X-Resolve-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;");
    for (const p of ["/v1/request-key", "/v1/prints/us_unemployment_rate/2026-09", "/v1/markets", "/v1/resolve", "/v1/webhooks", "/follow", "/v1/track-record/verify"]) expect(html).toContain(p);
    // the key comes back in the answer (tests/instant-key.test.ts), with the terms the code issues
    expect(html).toContain("The answer carries a test key, once (<code>data.key</code>");
    expect(html).toContain("carries 300 credits for 30 days, for structured verdicts, with up to 5 watches");
    expect(html).not.toContain("sends the key by email");
  });

  it("/docs quickstart: key, then ONE curl that returns a first print, then an official-release market and its resolve, then the inline path; the GitHub example only after, labelled an illustration", async () => {
    h.db = fakeDb({});
    const html = await (await app.request("/docs", {}, env, ctx)).text();
    const curls = [...html.matchAll(/<pre>(curl[^<]*?)(?:<\/pre>|\n\n)/g)].map((m) => m[1]!.replace(/\s+/g, " "));
    expect(curls[0]).toContain("/v1/request-key");
    expect(curls[1]).toBe(`curl http://localhost/v1/prints/${QUICKSTART_PRINT.series}/${QUICKSTART_PRINT.period} -H "Authorization: Bearer $RESOLVE_KEY"`);
    expect(curls[2]).toContain("/v1/markets");
    expect(curls[2]).toContain("&quot;official:us_unemployment_rate:2026-09&quot;");
    expect(curls[3]).toContain("/v1/resolve");
    expect(curls[3]).toContain("&quot;fetch&quot;:true".replace(/&quot;/g, '"'));
    expect(curls[4]).toContain("/v1/resolve");
    expect(curls[4]).toContain("&quot;evidence&quot;");
    // the scheduled answer names the registry's release time, from code
    expect(html).toContain(`Until its scheduled release, 2026-10-02 12:30 UTC, the answer is <code>status: "scheduled"</code>`);
    // the made-up GitHub PR is not the quickstart's market any more: it appears only in the labelled illustration
    const pr = html.indexOf("octo-org/octo-repo");
    expect(pr).toBeGreaterThan(html.indexOf("official:us_unemployment_rate:2026-09"));
    expect(html.lastIndexOf("Illustration:", pr)).toBeGreaterThan(html.indexOf("4. Other sources"));
    expect(html.slice(0, html.indexOf("4. Other sources"))).not.toContain("octo-org");
  });

  it("/docs examples are real shapes: the official market passes registration with the scheduled release; the illustration resolves structured from its evidence", async () => {
    const official = validateRegistration(DOCS_OFFICIAL_MARKET_EXAMPLE);
    expect(registrationPolicyIssues(official)).toEqual([]);
    expect(official).toMatchObject({ platform: "custom", positive_option: "OPTION_A", negative_rule: "explicit_negative", sources: [{ kind: "official_release", ref: "official:us_unemployment_rate:2026-09" }] });
    const known = KNOWN_RELEASES["us_unemployment_rate:2026-09"]!;
    expect(official.resolver).toMatchObject({ kind: "official_release", series: "us_unemployment_rate", period: "2026-09", release_at: known.release_at, rounding: "pct_1dp", bucket: { label: "≤3.8%", hi: 3.8 } });
    expect(official.deadline_utc).toBe(known.fallback_until);
    // no apostrophe: every body goes inside a single-quoted shell argument
    expect(JSON.stringify(DOCS_OFFICIAL_MARKET_EXAMPLE)).not.toContain("'");
    expect(JSON.stringify({ market: DOCS_MARKET_EXAMPLE, evidence: DOCS_INLINE_EVIDENCE_EXAMPLE })).not.toContain("'");

    const market = validateRegistration(DOCS_MARKET_EXAMPLE);
    expect(registrationPolicyIssues(market)).toEqual([]);
    const evidence = EvidenceInput.parse({ ...DOCS_INLINE_EVIDENCE_EXAMPLE, fetched_at: "2026-10-01T00:00:00Z", provenance: { inline: true } });
    const th = thresholdsFromEnv({});
    const r = await resolveMarket({ marketId: "m-docs", market, evidence, thresholds: th, spotlightSecret: "docs", model: "none", now: new Date(NOW) }, { jev: async () => { throw new Error("the illustration must never reach the model"); } });
    expect(r.route).toBe("structured");
    expect(r.verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A" });
  });

  it("uses the Cache API when present", async () => {
    h.db = fakeDb({});
    const put = vi.fn(async () => undefined);
    vi.stubGlobal("caches", { default: { match: vi.fn(async () => undefined), put } });
    const res = await app.request("/", {}, env, { waitUntil: (p: Promise<unknown>) => p, passThroughOnException: () => undefined } as unknown as ExecutionContext);
    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe("POST /v1/request-key", () => {
  const off = { ...env, REQUEST_KEY_DAILY_CAP: "0" } as Env;
  const good = { name: "Ada Lovelace", email: "ada@example.com", company: "Example Bots", purpose: "Settle CPI markets", venue: "Polymarket" };
  const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.9" }, body: new URLSearchParams(o).toString() });
  const jsonReq = (o: unknown) => ({ method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify(o) });
  const dbWith = (rate: (db: any, a: Record<string, any>) => Promise<{ data: any; error: any }> = rateRpc()) => fakeDb({}, {}, { rpc: { rate_limit_hit: rate, log_touch: touchRpc } });

  it("form: stores a prospect lead and an inbound touch, alerts with a masked email, answers an HTML confirmation", async () => {
    h.db = dbWith();
    const res = await app.request("/v1/request-key", form(good), off, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe(SITE_CSP);
    expect(await res.text()).toContain("Request received");
    expect(h.db.tables.leads).toHaveLength(1);
    expect(h.db.tables.leads![0]).toMatchObject({ name: "Ada Lovelace", org: "Example Bots", contact: "ada@example.com", status: "prospect", channel: "form", platform: "polymarket" });
    expect(h.db.tables.gtm_touches![0]).toMatchObject({ lead_id: h.db.tables.leads![0]!.id, kind: "email", direction: "in" });
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.text).toContain("Example Bots");
    expect(h.alerts[0]!.text).toContain("Settle CPI markets");
    expect(h.alerts[0]!.text).toContain("a***@example.com");
    expect(h.alerts[0]!.text).not.toContain("ada@example.com");
    expect(h.alerts[0]!.text).toContain("Key: not issued (REQUEST_KEY_DAILY_CAP is 0)");
    expect(h.db.calls.filter((c) => c.table === "rpc:rate_limit_hit")).toHaveLength(2);
    expect(h.db.tables.tenants ?? []).toHaveLength(0);
  });

  it("JSON in, JSON out; 'project' is accepted for company", async () => {
    h.db = dbWith();
    const { company, ...rest } = good;
    const res = await app.request("/v1/request-key", jsonReq({ ...rest, project: company }), off, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { received: true, key_issued: false } });
    expect(h.db.tables.leads![0]!.org).toBe("Example Bots");
  });

  it("rejects a URL in the name, a bad email, missing fields and overlong values; nothing stored", async () => {
    for (const bad of [{ ...good, name: "Win at https://spam.example" }, { ...good, name: "cheap.xyz deals" }, { ...good, email: "nope" }, { ...good, purpose: "" }, { ...good, purpose: "x".repeat(1001) }, { name: "A" }]) {
      h.db = dbWith();
      const res = await app.request("/v1/request-key", jsonReq(bad), off, ctx);
      expect(res.status).toBe(400);
      expect(h.db.tables.leads ?? []).toHaveLength(0);
    }
    h.db = dbWith();
    const res = await app.request("/v1/request-key", form({ ...good, name: "<b>x</b> www.spam.test" }), off, ctx);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("rate limited: 429, nothing stored", async () => {
    h.db = dbWith(rateRpc(false));
    const res = await app.request("/v1/request-key", jsonReq(good), off, ctx);
    expect(res.status).toBe(429);
    expect(h.db.tables.leads ?? []).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
  });

  it("per-IP bucket alone gives 429; the key comes from CF-Connecting-IP, not X-Forwarded-For", async () => {
    const keys: string[] = [];
    h.db = dbWith(async (_db: unknown, a: Record<string, any>) => { keys.push(a.p_key); return { data: [{ allowed: a.p_key !== "request_key:ip:203.0.113.9", remaining: 0, reset_at: "2026-09-28T01:00:00Z" }], error: null }; });
    const res = await app.request("/v1/request-key", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.7" }, body: JSON.stringify(good) }, off, ctx);
    expect(res.status).toBe(429);
    expect(keys).toContain("request_key:ip:203.0.113.9");
    expect(keys.some((k) => k.includes("198.51.100.7"))).toBe(false);
    expect(h.db.tables.leads ?? []).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
  });

  it("rejects an oversized or multipart body with 400", async () => {
    h.db = dbWith();
    let res = await app.request("/v1/request-key", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.9" }, body: "name=" + "a".repeat(20_000) }, off, ctx);
    expect(res.status).toBe(400);
    const fd = new FormData(); fd.set("name", "A");
    res = await app.request("/v1/request-key", { method: "POST", body: fd, headers: { "cf-connecting-ip": "203.0.113.9" } }, off, ctx);
    expect(res.status).toBe(400);
    expect(h.db.tables.leads ?? []).toHaveLength(0);
  });

  it("fails closed with 503 (never 500) when the rate limit or the lead insert cannot be written", async () => {
    h.db = dbWith(rateRpc(true, { message: "db down" }));
    let res = await app.request("/v1/request-key", jsonReq(good), off, ctx);
    expect(res.status).toBe(503);
    h.db = dbWith(async () => { throw new Error("socket"); });
    res = await app.request("/v1/request-key", form(good), off, ctx);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Nothing was stored");
    h.db = dbWith();
    const from = h.db.client.from;
    h.db.client.from = ((t: string) => (t === "leads" ? { insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "x" } }) }) }) } : from(t))) as never;
    res = await app.request("/v1/request-key", jsonReq(good), off, ctx);
    expect(res.status).toBe(503);
    expect(h.alerts).toHaveLength(0);
  });

  it("a filled honeypot gets the same answer and stores nothing", async () => {
    h.db = dbWith();
    const res = await app.request("/v1/request-key", form({ ...good, website: "http://x" }), off, ctx);
    expect(res.status).toBe(200);
    expect(h.db.tables.leads ?? []).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
  });

  it("maskEmail", () => {
    expect(maskEmail("ada@example.com")).toBe("a***@example.com");
    expect(maskEmail("bad")).toBe("***");
  });
});

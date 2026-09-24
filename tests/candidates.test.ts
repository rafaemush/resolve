/**
 * scripts/candidates.ts pipeline (plan §16.4 P5, §17.3 P5), pure and offline: gamma rows are deduped by event with one
 * representative leg, sports / price-threshold / X-only / sourceless markets are excluded, and the Limitless feed is
 * classified (official_release for macro prints, central-bank decisions and election results) with one entry per leg.
 */
import { describe, expect, it } from "vitest";
import { classifyUrl, extractUrls, officialReleaseKind, scanSources, stripHtml, suggestAnchors } from "../scripts/lib/candidates";
import { buildPolymarket, classifyGamma, GammaRow } from "../scripts/lib/candidates-polymarket";
import { buildLimitless, checkability, classifyLimitless, createdSince } from "../scripts/lib/candidates-limitless";
import { MarketRegistration } from "../src/resolve/schema";

const NOW = new Date("2026-09-24T12:00:00Z");
const W = { now: NOW, days: 21, maxVolume: 50_000 };
const COND = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function gamma(over: Partial<Record<string, unknown>> & { id: string }): Record<string, unknown> {
  return {
    question: "Will the BLS report September 2026 CPI above 3.0%?",
    slug: `m-${over.id}`, conditionId: COND(Number(over.id)), questionID: COND(Number(over.id) + 1000),
    description: "Resolves Yes if the Bureau of Labor Statistics CPI release (https://www.bls.gov/cpi/) shows the 12-month change above 3.0%.",
    resolutionSource: "", endDate: "2026-10-14T12:30:00Z", startDate: "2026-09-01T00:00:00Z", volumeNum: 1200,
    outcomes: '["Yes", "No"]', negRisk: false, closed: false, tags: [{ slug: "economy" }, { slug: "cpi" }],
    events: [{ id: "ev-cpi", title: "September CPI", slug: "september-cpi", resolutionSource: "" }],
    ...over,
  };
}

describe("source classification", () => {
  it("names official, election, chain and GitHub sources tier A, the subject's own domain tier B, and the rest not primary", () => {
    const s = "Will Chipotle announce a new CEO?";
    expect(classifyUrl("https://www.bls.gov/cpi/", s)?.cls).toBe("official_statistics");
    expect(classifyUrl("https://www.federalreserve.gov/monetarypolicy/openmarket.htm", s)?.cls).toBe("central_bank");
    expect(classifyUrl("https://www.bok.or.kr/eng/main/main.do", s)?.cls).toBe("central_bank");
    expect(classifyUrl("https://dadosabertos.tse.jus.br/dataset", s)?.cls).toBe("election_authority");
    expect(classifyUrl("https://www.gov.il/en/departments/central-elections-committee/govil-landing-page", s)?.cls).toBe("election_authority");
    expect(classifyUrl("https://www.congress.gov/bill/1", s)?.cls).toBe("government");
    expect(classifyUrl("https://github.com/openai/openai-python/releases", s)?.cls).toBe("github");
    expect(classifyUrl("https://basescan.org/address/0xabc", s)?.cls).toBe("onchain");
    expect(classifyUrl("https://newsroom.chipotle.com/press", s)?.cls).toBe("company_or_project");
    expect(classifyUrl("https://x.com/chipotle", s)?.cls).toBe("social");
    expect(classifyUrl("https://www.reuters.com/markets", s)?.cls).toBe("news");
    expect(classifyUrl("https://polymarket.com/event/x", s)?.cls).toBe("platform");
    expect(classifyUrl("https://deepstatemap.live/", s)?.cls).toBe("third_party");
  });

  it("decodes Limitless HTML and its hrefs; a URL after 'resolution source' is designated", () => {
    const html = `<p>If the ECB cuts, Yes.</p><p>The primary resolution source is France Football (<a href="https://www.francefootball.fr/">FF</a>) &amp; its site.</p><br/>&#39;quoted&#39;\u200b`;
    expect(stripHtml(html)).toBe("If the ECB cuts, Yes.\nThe primary resolution source is France Football ( FF ) & its site.\n\n'quoted'");
    const urls = extractUrls([html]);
    expect(urls).toEqual([{ url: "https://www.francefootball.fr/", bare: false, designated: true }]);
    const scan = scanSources("Ballon d'Or Winner 2026", [html]);
    expect(scan.primary.map((c) => c.cls)).toEqual(["designated_source"]);
    expect(scan.tier).toBe("B");
    expect(extractUrls(["per bls.gov/cpi, not U.S. data"])).toEqual([{ url: "https://bls.gov/cpi", bare: true, designated: false }]);
  });

  it("detects official-release families; central-bank wording wins over a macro word", () => {
    expect(officialReleaseKind("September Inflation US - Annual")).toBe("macro_release");
    expect(officialReleaseKind("Bank of Korea decision in October?")).toBe("central_bank_decision");
    expect(officialReleaseKind("Fed rate cut by __?")).toBe("central_bank_decision");
    expect(officialReleaseKind("Which party will win the House in 2026?")).toBe("election_result");
    expect(officialReleaseKind("Will Donald Trump attend UFC 333?")).toBeNull();
  });

  it("suggests capitalized phrases as anchors, the leg label first, never a bare year", () => {
    expect(suggestAnchors("Will Sudan's Emergency Response Rooms win the Nobel Peace Prize in 2026?")).toEqual(["Sudan's Emergency Response Rooms", "Nobel Peace Prize"]);
    expect(suggestAnchors("Fed Decision in October?", "25 bps decrease")).toEqual(["25 bps decrease", "Fed Decision", "October"]);
    expect(suggestAnchors("Bank of Korea decision in October?")).toEqual(["Bank of Korea", "October"]);
  });
});

describe("Polymarket: exclusions", () => {
  const parse = (o: Record<string, unknown>) => GammaRow.parse(o);
  it("excludes sports by tag and price thresholds by tag or wording", () => {
    expect(classifyGamma(parse(gamma({ id: "1", tags: [{ slug: "sports" }, { slug: "nfl" }] })), W)).toMatchObject({ kind: "excluded", reason: "sports" });
    expect(classifyGamma(parse(gamma({ id: "2", tags: [{ slug: "crypto-prices" }] })), W)).toMatchObject({ kind: "excluded", reason: "price" });
    expect(classifyGamma(parse(gamma({ id: "3", question: "Will Bitcoin reach $150,000 by October 10?", tags: [{ slug: "crypto" }] })), W)).toMatchObject({ kind: "excluded", reason: "price" });
    expect(classifyGamma(parse(gamma({ id: "4", question: "Will Anthropic's valuation be less than $500B at the end of September 2026?", tags: [{ slug: "finance" }] })), W)).toMatchObject({ kind: "excluded", reason: "price" });
    expect(classifyGamma(parse(gamma({ id: "5" })), W)).toMatchObject({ kind: "kept" });
  });

  it("flags requires_x when X is the only concrete source, and keeps a market that also names a primary source", () => {
    const xOnly = gamma({ id: "6", question: "Will Elon Musk post about Mars on Oct 1?", tags: [{ slug: "tech" }], description: "Resolves per posts on X by @elonmusk (https://x.com/elonmusk)." });
    expect(classifyGamma(parse(xOnly), W)).toMatchObject({ kind: "excluded", reason: "requires_x" });
    const both = gamma({ id: "7", description: "Per https://x.com/BLS_gov and the release at https://www.bls.gov/cpi/." });
    const c = classifyGamma(parse(both), W);
    expect(c.kind).toBe("kept");
    if (c.kind === "kept") expect(c.scan.requiresX).toBe(false);
    const none = gamma({ id: "8", question: "Will the Nobel Peace Prize go to an organization?", tags: [{ slug: "awards" }], description: "Per the Norwegian Nobel Committee announcement." });
    expect(classifyGamma(parse(none), W)).toMatchObject({ kind: "excluded", reason: "no_primary_source" });
    // X next to news reporting is not X-only: web evidence exists, just no first-party source.
    const xAndNews = gamma({ id: "16", question: "Will Ruben Gallego leave the Senate?", tags: [{ slug: "politics" }], description: "Per https://x.com/RubenGallego or https://apnews.com/." });
    expect(classifyGamma(parse(xAndNews), W)).toMatchObject({ kind: "excluded", reason: "no_primary_source" });
  });

  it("re-checks the window and the volume cap instead of trusting the query", () => {
    expect(classifyGamma(parse(gamma({ id: "9", endDate: "2026-11-30T00:00:00Z" })), W)).toMatchObject({ kind: "excluded", reason: "outside_window" });
    expect(classifyGamma(parse(gamma({ id: "10", volumeNum: 50_001 })), W)).toMatchObject({ kind: "excluded", reason: "volume_cap" });
  });
});

describe("Polymarket: dedupe by event", () => {
  const rows = [
    gamma({ id: "11", groupItemTitle: "Above 3.0%", volumeNum: 900 }),
    gamma({ id: "12", groupItemTitle: "Above 3.1%", volumeNum: 4000, question: "Will the BLS report September 2026 CPI above 3.1%?" }),
    gamma({ id: "13", groupItemTitle: "Above 3.2%", volumeNum: 100, question: "Will the BLS report September 2026 CPI above 3.2%?" }),
    gamma({ id: "14", question: "Will the Fed cut rates in October 2026?", description: "Per the FOMC statement at https://www.federalreserve.gov/newsevents/pressreleases.htm.", endDate: "2026-10-01T18:00:00Z", events: [{ id: "ev-fed", title: "Fed October", slug: "fed-october" }] }),
    gamma({ id: "15", tags: [{ slug: "sports" }], events: [{ id: "ev-nfl", title: "Jets vs. Lions" }] }),
  ];
  const b = buildPolymarket(rows, W);

  it("emits one entry per event with the most-traded leg as representative and the legs counted", () => {
    expect(b.entries).toHaveLength(2);
    const cpi = b.entries.find((e) => (e.event as { id: string }).id === "ev-cpi")!;
    expect(cpi.registration.market.external_id).toBe("12");
    expect(cpi.event).toMatchObject({ legs: 3, leg_ids: ["11", "12", "13"] });
    expect(b.counts).toMatchObject({ markets_fetched: 5, events_fetched: 3, events_kept: 2, legs_in_kept_events: 4, official_release_events: 2 });
    expect(b.counts.events_excluded.sports).toBe(1);
  });

  it("suggests a registration the Worker schema accepts, with condition_id and the event carried in meta", () => {
    for (const e of b.entries) {
      expect(e.approved).toBe(false);
      expect(e.needs_review).toContain("anchors");
      expect(MarketRegistration.safeParse(e.registration.market).success).toBe(true);
      expect(e.registration.is_test).toBe(false);
    }
    const cpi = b.entries.find((e) => (e.event as { id: string }).id === "ev-cpi")!;
    expect(cpi.registration.meta).toMatchObject({ condition_id: COND(12), slug: "m-12", event_id: "ev-cpi", category: "macro_release" });
    expect(cpi.registration.market).toMatchObject({ option_a: "Yes", option_b: "No", positive_option: "OPTION_A", negative_rule: "explicit_negative", deadline_utc: "2026-10-14T12:30:00.000Z", sources: [{ kind: "web_fetch", ref: "https://www.bls.gov/cpi/" }] });
  });

  it("ranks the earlier deadline first when source quality is equal", () => {
    expect((b.entries[0]!.event as { id: string }).id).toBe("ev-fed");
  });
});

describe("Limitless: classifier and checkability", () => {
  const c = (title: string, categories: string[], extra: Partial<Parameters<typeof classifyLimitless>[0]> = {}) => classifyLimitless({ title, categories, automationType: "manual", ...extra }).category;
  it("puts macro prints, central-bank decisions and election results on official_release whatever the Limitless category", () => {
    expect(c("September Inflation US - Annual", ["Crypto"])).toBe("official_release");
    expect(c("PPI YoY - September 2026", ["Crypto"])).toBe("official_release");
    expect(c("Fed Decision in October?", ["Crypto"])).toBe("official_release");
    expect(c("South Korea GDP growth (YoY) in Q3 2026?", ["Crypto"])).toBe("official_release");
    expect(c("Israeli Legislative Election Winner", ["Politics"])).toBe("official_release");
    expect(c("Balance of Power: 2026 Midterms", ["Crypto"])).toBe("official_release");
    expect(c("Which party will win the House in 2026?", ["Politics"])).toBe("official_release");
  });

  it("separates sports, price ladders, pre-TGE, politics and specials", () => {
    expect(c("Jets vs. Lions", ["Sports"])).toBe("sports");
    expect(c("Team A vs Team B", [], { automationType: "sports" })).toBe("sports");
    expect(c("Morocco to defeat Gabon in the 2027 AFCON qualifiers on Sep 25?", ["Football"])).toBe("sports");
    expect(c("What price will Ethereum hit September 21-27?", ["Crypto"])).toBe("price");
    expect(c("What will Gold (XAUUSD) hit Week of September 21 2026?", ["Crypto"])).toBe("price");
    expect(c("Will Pacifica launch a token by September 30, 2026?", ["Pre-TGE"])).toBe("pre_tge");
    expect(c("Will Nike (NKE) beat quarterly earnings?", ["Crypto"])).toBe("company_news");
    expect(c("Will Donald Trump attend UFC 333?", ["Politics"])).toBe("politics");
    expect(c("Ruben Gallego out as Senator?", ["Politics"])).toBe("politics");
    // An award filed under Specials is not a fixture, even with the "sport" domain property.
    expect(c("Ballon d'Or Winner 2026", ["Specials"], { properties: [{ propertyKeySlug: "domain", value: ["sport"] }] })).toBe("specials");
  });

  it("scores checkability: official release with an official source 4, sports 0, X-only 0, unlabelled AMM 0", () => {
    const official = scanSources("CPI", ["https://www.bls.gov/cpi/"]);
    const none = scanSources("x", ["no links"]);
    const xOnly = scanSources("Pacifica token", ["see https://x.com/pacifica"]);
    expect(checkability("official_release", official, true).score).toBe(4);
    expect(checkability("official_release", none, true).score).toBe(3);
    expect(checkability("politics", none, true).score).toBe(1);
    expect(checkability("sports", official, true).score).toBe(0);
    expect(checkability("pre_tge", xOnly, true).score).toBe(0);
    expect(checkability("official_release", official, false).score).toBe(0);
  });
});

describe("Limitless: feed to entries", () => {
  const exp = Date.parse("2026-10-28T23:59:00Z");
  const leg = (slug: string, title: string, volume: string, order: number, extra: Record<string, unknown> = {}) => ({
    slug, title, description: '<p>Resolves by the FOMC statement (<a href="https://www.federalreserve.gov/monetarypolicy/openmarket.htm">Fed</a>).</p>',
    conditionId: COND(order + 50), groupId: 10013448, createdAt: "2026-06-17T19:03:23Z", expirationTimestamp: exp, volumeFormatted: volume, tradeType: "clob",
    tokens: { yes: "1", no: "2" }, orderInGroup: order, ...extra,
  });
  const feed = [
    { id: 10013448, slug: "fed-decision-in-october-1", title: "Fed Decision in October?", automationType: "manual", marketType: "group", categories: ["Crypto"], expirationTimestamp: exp, createdAt: "2026-06-17T19:03:23Z", outcomeTokens: ["Yes", "No"],
      markets: [leg("25-bps-decrease-1", "25 bps decrease", "10.5", 1), leg("no-change-1", "No change", "80.25", 2), leg("old-leg-1", "June cut", "500", 0, { expirationTimestamp: Date.parse("2026-06-17T00:00:00Z") })] },
    { id: 408781, slug: "jets-vs-lions-1", title: "Jets vs. Lions", automationType: "manual", marketType: "single", categories: ["Sports"], expirationTimestamp: Date.parse("2026-09-28T17:00:00Z"), createdAt: "2026-09-20T00:00:00Z", volumeFormatted: "4.05", conditionId: COND(7), tokens: { yes: "1", no: "2" } },
    { id: 408782, slug: "nemesis-vs-navi-1", title: "Team Nemesis vs Natus Vincere", automationType: "sports", marketType: "single", categories: ["Esports"], expirationTimestamp: exp, createdAt: "2026-09-24T00:00:00Z" },
    { id: 408783, slug: "far-future-1", title: "Xi Jinping out before 2027?", automationType: "manual", marketType: "single", categories: ["Politics"], expirationTimestamp: Date.parse("2026-12-31T00:00:00Z"), createdAt: "2026-09-23T00:00:00Z" },
    { id: 408784, slug: "amm-1", title: "Cameroon to defeat Comoros in the 2027 AFCON qualifiers on Sep 24?", automationType: "manual", marketType: "single", categories: ["Football"], tradeType: "amm", expirationTimestamp: Date.parse("2026-09-25T11:00:00Z"), createdAt: "2026-09-01T00:00:00Z", volumeFormatted: "101.21" },
  ];
  const b = buildLimitless(feed, { now: NOW, days: 45, maxVolume: 50_000 });

  it("drops non-manual rows the query should have excluded, and keeps only in-window legs", () => {
    expect(b.counts).toMatchObject({ rows_fetched: 5, manual_rows: 4, non_manual_rows_dropped: 1, manual_markets_in_window: 3, legs_in_window: 4, legs_outside_window: 1, unlabelled_amm_legs: 1 });
    expect(b.counts.markets_by_category).toMatchObject({ official_release: 1, sports: 2 });
    expect(b.entries.map((e) => e.registration.market.external_id)).toEqual(["amm-1", "jets-vs-lions-1", "25-bps-decrease-1", "no-change-1"]);
  });

  it("registers each group leg by its own slug with the group, condition id and category in meta; one representative per group", () => {
    const legs = b.entries.filter((e) => (e.group as { id: string } | null)?.id === "10013448");
    expect(legs.map((e) => e.representative)).toEqual([false, true]);
    const l = legs[0]!;
    expect(l.category).toBe("official_release");
    expect(l.checkability).toBe(4);
    expect(l.registration.meta).toEqual({ slug: "25-bps-decrease-1", category: "official_release", condition_id: COND(51), group_id: "10013448" });
    expect(l.registration.market).toMatchObject({ platform: "limitless", option_a: "Yes", option_b: "No", event_statement: "Fed Decision in October? — 25 bps decrease", deadline_utc: "2026-10-28T23:59:00.000Z", negative_rule: "explicit_negative" });
    expect(MarketRegistration.safeParse(l.registration.market).success).toBe(true);
    const amm = b.entries.find((e) => e.registration.market.external_id === "amm-1")!;
    expect(amm).toMatchObject({ checkability: 0, category: "sports" });
    expect(amm.needs_review).toContain("options");
  });

  it("counts manual markets created since the previous scan", () => {
    expect(createdSince(feed, new Date("2026-09-19T00:00:00Z"))).toBe(2);
  });
});

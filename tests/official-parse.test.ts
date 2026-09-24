/**
 * The official_release parsers against the bodies saved on 2026-09-24 (evals/fixtures/official/, byte-exact), plus
 * the CPU budget: Workers Free allows 10 ms of CPU per invocation, so every parser must stay well under it on the
 * largest saved body (the BoK decision feed, 886 KB).
 */
import { describe, expect, it } from "vitest";
import { officialFixture as fx, officialFixtureBytes } from "../evals/lib/official-fixtures";
import {
  parseBlsRelease, parseBlsApi, blsApiYoy, findFomcStatement, parseFomcStatement, parseFraction, fredValueOn, findEcbDecision,
  parseEcbRelease, parseEcbDfrCsv, parseBoeRss, iadbValueOn, parseBokDecisionRss, parseBokGdpRss, parseEcosRows, parseBcbHistory, decodeEntities, bytesInclude, usDayLabel,
} from "../src/ingest/official-parse";

const obs = (p: ReturnType<typeof parseBlsRelease>) => { if (!p.ok) throw new Error(`${p.reason}: ${p.detail}`); return p.obs; };

describe("BLS release text", () => {
  it("CPI: the August 2026 release names its month and the unadjusted 12-month change", () => {
    const o = obs(parseBlsRelease(fx("bls_cpi_nr0.html"), "cpi"));
    expect(o).toMatchObject({ period: "2026-08", value: 3.4, value_text: "3.4" });
    expect(o.deciding_text).toBe("CONSUMER PRICE INDEX - AUGUST 2026: Over the last 12 months, the all items index increased 3.4 percent before seasonal adjustment.");
    expect(o.meta.embargoed_until).toBe("8:30 a.m. (ET) Friday, September 11, 2026");
  });
  it("PPI: final demand, unadjusted, 12 months ended in August", () => {
    const o = obs(parseBlsRelease(fx("bls_ppi_nr0.html"), "ppi"));
    expect(o).toMatchObject({ period: "2026-08", value: 5.4, value_text: "5.4" });
    expect(o.deciding_text).toContain("final demand increased 5.4 percent for the 12 months ended in August");
  });
  it("a decrease is signed, an unchanged index is 0.0, and a page without the sentence is schema drift", () => {
    const page = (s: string) => `<html><PRE>CONSUMER PRICE INDEX - SEPTEMBER 2026\n\n${s}</PRE></html>`;
    expect(obs(parseBlsRelease(page("Over the last 12 months, the all\nitems index decreased 0.2 percent before seasonal adjustment."), "cpi"))).toMatchObject({ period: "2026-09", value: -0.2, value_text: "-0.2" });
    expect(obs(parseBlsRelease(page("Over the last 12 months, the all items index was unchanged before seasonal adjustment."), "cpi")).value_text).toBe("0.0");
    expect(parseBlsRelease(page("Prices went up."), "cpi")).toMatchObject({ ok: false, reason: "schema_drift" });
    expect(parseBlsRelease("<html>Access Denied</html>", "cpi")).toMatchObject({ ok: false, reason: "schema_drift" });
  });
  it("API v1 index levels reproduce the published 12-month changes with decimal arithmetic", () => {
    const cpi = parseBlsApi(fx("bls_v1_cpi.json"), "CUUR0000SA0");
    const ppi = parseBlsApi(fx("bls_v1_ppi.json"), "WPUFD4");
    if (!cpi.ok || !ppi.ok) throw new Error("api parse");
    expect(blsApiYoy(cpi.index, "2026-08")).toMatchObject({ tenths: 34, nearTie: false, current: "334.980", base: "323.976" });
    expect(blsApiYoy(cpi.index, "2026-07")).toMatchObject({ tenths: 34 }); // "as it did for the 12 months ending July"
    expect(blsApiYoy(ppi.index, "2026-08")).toMatchObject({ tenths: 54, current: "157.604", base: "149.466" });
    expect(blsApiYoy(cpi.index, "2026-09")).toBeUndefined(); // not published yet: unavailable, never a guess
    expect(cpi.index.has("2025-10")).toBe(false); // "-" (2025 lapse in appropriations) is not a value
    expect(parseBlsApi('{"status":"REQUEST_NOT_PROCESSED","message":["daily threshold"]}', "CUUR0000SA0").ok).toBe(false);
  });
});

describe("Federal Reserve", () => {
  it("finds the statement for its decision day in the monetary feed, and nothing for a future meeting", () => {
    expect(findFomcStatement(fx("fed_press_monetary.xml"), "2026-09-16")).toEqual({ ok: true, url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm", pubDate: "Wed, 16 Sep 2026 18:00:00 GMT" });
    expect(findFomcStatement(fx("fed_press_monetary.xml"), "2026-10-28")).toMatchObject({ ok: false, reason: "not_published" });
  });
  it("reads the target range with hyphenated fractions: '3-3/4 to 4' is an upper bound of 4.00", () => {
    const o = obs(parseFomcStatement(fx("fed_monetary20260916a.html")));
    expect(o).toMatchObject({ period: "2026-09-16", value: 4, value_text: "3-3/4 to 4", direction: "up" });
    expect(o.deciding_text).toBe("September 16, 2026: The Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent");
  });
  it("parses fractions and the lower / maintain wordings", () => {
    expect([parseFraction("3-3/4"), parseFraction("4"), parseFraction("1/4"), parseFraction("4-1/2"), parseFraction("3-4")]).toEqual([3.75, 4, 0.25, 4.5, undefined]);
    const page = (s: string) => `<div id="article"><p class="article__time">October 28, 2026</p><p>${s}</p></div>`;
    expect(obs(parseFomcStatement(page("The Committee decided to lower the target range for the federal funds rate by 1/4 percentage point to 3-1/2 to 3-3/4 percent.")))).toMatchObject({ value: 3.75, direction: "down", period: "2026-10-28" });
    expect(obs(parseFomcStatement(page("The Committee decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent.")))).toMatchObject({ value: 4, direction: "unchanged" });
  });
  it("FRED DFEDTARU is dated by the effective day (decision + 1)", () => {
    expect(fredValueOn(fx("fred_dfedtaru.csv"), "2026-09-16")).toBe("3.75");
    expect(fredValueOn(fx("fred_dfedtaru.csv"), "2026-09-17")).toBe("4.00");
    expect(fredValueOn(fx("fred_dfedtaru.csv"), "2026-10-29")).toBeUndefined();
  });
});

describe("ECB", () => {
  it("finds the 'Monetary policy decisions' release dated the decision day", () => {
    expect(findEcbDecision(fx("ecb_mopo_2026_include.html"), "2026-09-10")).toEqual({ ok: true, url: "https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.mp260910~314e508016.en.html" });
    expect(findEcbDecision(fx("ecb_mopo_2026_include.html"), "2026-10-29")).toMatchObject({ ok: false, reason: "not_published" });
  });
  it("reads the deposit facility rate by name, with the effective date", () => {
    const o = obs(parseEcbRelease(fx("ecb_mp260910.html")));
    expect(o).toMatchObject({ period: "2026-09-10", value: 2.5, value_text: "2.50", direction: "up", meta: { effective_from: "2026-09-16" } });
  });
  it("finds the deposit facility when the older wording lists it last", () => {
    const page = `<main><p class="ecb-publicationDate">29 October 2026</p><p>The interest rates on the main refinancing operations, the marginal lending facility and the deposit facility will remain unchanged at 2.65%, 2.90% and 2.50% respectively.</p></main>`;
    expect(obs(parseEcbRelease(page))).toMatchObject({ period: "2026-10-29", value_text: "2.50", direction: "unchanged" });
  });
  it("DFR data API rows are effective dates", () => {
    expect(parseEcbDfrCsv(fx("ecb_dfr.csv")).slice(-2)).toEqual([{ date: "2026-06-17", value: "2.25" }, { date: "2026-09-16", value: "2.5" }]);
  });
});

describe("Bank of England", () => {
  it("reads 'Bank rate maintained at 3.75% - September 2026 Monetary Policy Summary'", () => {
    const o = obs(parseBoeRss(fx("boe_rss_news.xml"), "September 2026"));
    expect(o).toMatchObject({ period: "2026-09-17", value: 3.75, value_text: "3.75", direction: "unchanged" });
    expect(parseBoeRss(fx("boe_rss_news.xml"), "November 2026")).toMatchObject({ ok: false, reason: "not_published" });
  });
  it("handles the change verbs case-insensitively", () => {
    const feed = (t: string) => `<rss><channel><item><title>${t}</title><pubDate>Thu, 05 Nov 2026 12:00:00 +0000</pubDate></item></channel></rss>`;
    expect(obs(parseBoeRss(feed("Bank Rate reduced to 3.5% - November 2026 Monetary Policy Summary"), "November 2026"))).toMatchObject({ period: "2026-11-05", value: 3.5, direction: "down" });
    expect(obs(parseBoeRss(feed("BANK RATE CUT TO 3.25% – November 2026 Monetary Policy Summary and Minutes"), "November 2026"))).toMatchObject({ value: 3.25, direction: "down" });
    expect(obs(parseBoeRss(feed("Bank Rate increased to 4% - November 2026 Monetary Policy Summary"), "November 2026"))).toMatchObject({ value: 4, direction: "up" });
  });
  it("IADB IUDBEDR row dated the decision day", () => {
    expect(iadbValueOn(fx("boe_iadb_iudbedr.csv"), "2026-09-17")).toBe("3.75");
    expect(iadbValueOn(fx("boe_iadb_iudbedr.csv"), "2026-11-05")).toBeUndefined();
  });
});

describe("Bank of Korea", () => {
  it("reads the decision item by its date, raise and unchanged wordings", () => {
    expect(obs(parseBokDecisionRss(fx("bok_rss_mpd.xml"), "2026-08-27"))).toMatchObject({ period: "2026-08-27", value: 3, value_text: "3.00", direction: "up", meta: { from_level: "2.75" } });
    const may = obs(parseBokDecisionRss(fx("bok_rss_mpd.xml"), "2026-05-28"));
    expect(may).toMatchObject({ value_text: "2.50", direction: "unchanged" });
    expect(may.deciding_text).toBe("(May 28, 2026) The Monetary Policy Board of the Bank of Korea decided today to leave the Base Rate unchanged at 2.50%");
    expect(obs(parseBokDecisionRss(fx("bok_rss_mpd.xml"), "2026-07-16"))).toMatchObject({ value_text: "2.75" }); // title has "(July 16, 2026)" after a space
    expect(parseBokDecisionRss(fx("bok_rss_mpd.xml"), "2026-10-22")).toMatchObject({ ok: false, reason: "not_published" });
  });
  it("'unchanged at 3.00%' in an October item", () => {
    const desc = decodeEntities("&lt;p&gt;The Monetary Policy Board of the Bank of Korea decided today to leave the Base Rate unchanged at 3.00% for the intermeeting period.&lt;/p&gt;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const feed = `<rss><channel><item><title>★Monetary Policy Decision &amp;amp; Opening Remarks to the Press Conference(October 22, 2026)</title><description><![CDATA[${desc}]]></description></item></channel></rss>`;
    expect(obs(parseBokDecisionRss(feed, "2026-10-22"))).toMatchObject({ period: "2026-10-22", value: 3, value_text: "3.00", direction: "unchanged" });
  });
  it("GDP advance estimate: the year-on-year sentence of the quarter's item", () => {
    expect(obs(parseBokGdpRss(fx("bok_rss_press.xml"), "2026-Q2"))).toMatchObject({ period: "2026-Q2", value: 3.7, deciding_text: "Real Gross Domestic Product: Second Quarter of 2026 (Advance Estimate): in year-on-year terms it increased by 3.7 percent" });
    expect(obs(parseBokGdpRss(fx("bok_rss_press.xml"), "2026-Q1")).value_text).toBe("3.6"); // the first print (ECOS now says 3.8)
    expect(parseBokGdpRss(fx("bok_rss_press.xml"), "2026-Q3")).toMatchObject({ ok: false, reason: "not_published" });
  });
  it("ECOS rows (sample key), and 'no data' as an empty list", () => {
    const r = parseEcosRows(fx("ecos_200Y102_10211.json"));
    expect(r.ok && r.rows.find((x) => x.time === "2026Q1")?.value).toBe("3.8");
    const b = parseEcosRows(fx("ecos_722Y001_20260824_20260902.json"));
    expect(b.ok && b.rows.find((x) => x.time === "20260827")?.value).toBe("3");
    expect(parseEcosRows('{"RESULT":{"CODE":"INFO-200","MESSAGE":"no data"}}')).toEqual({ ok: true, rows: [] });
  });
});

describe("Banco Central do Brasil", () => {
  it("selects the ordinary Copom row dated the meeting (BRT), with the previous level", () => {
    const o = obs(parseBcbHistory(fx("bcb_historicotaxasjuros.json"), "2026-09-16"));
    expect(o).toMatchObject({ period: "2026-09-16", value: 13.75, direction: "down", meta: { meeting_number: 281, previous_level: 14 } });
    expect(o.deciding_text).toContain("2026-09-16");
  });
  it("the Nov 4 meeting has no row yet, although SGS 432 already shows 04/11/2026 = 13.75 (forward-filled)", () => {
    expect(fx("bcb_sgs432_ultimos3.json")).toContain('"data":"04/11/2026","valor":"13.75"');
    expect(parseBcbHistory(fx("bcb_historicotaxasjuros.json"), "2026-11-04")).toMatchObject({ ok: false, reason: "not_published" });
  });
  it("the cheap not-yet check never hides schema drift", () => {
    expect(parseBcbHistory("<html>maintenance</html>", "2026-11-04")).toMatchObject({ ok: false, reason: "schema_drift" });
    expect(parseBcbHistory('{"conteudo":[]}', "2026-11-04")).toMatchObject({ ok: false, reason: "schema_drift" });
    expect(parseBokDecisionRss("<rss><channel></channel></rss>", "2026-10-22")).toMatchObject({ ok: false, reason: "schema_drift" });
  });
});

describe("CPU budget (Workers Free: 10 ms per invocation)", () => {
  // CPU time, not wall-clock: process.cpuUsage() deltas are not inflated by other test files running in parallel.
  // Each sample repeats the work so the counter's granularity (a few ms on some kernels) is amortised; the median of
  // the samples is compared with the limit (per parse 5 ms, per 10-read burst 9 ms; the Worker has 10 ms in all).
  const cpuMs = (f: () => unknown, reps: number) => { const u0 = process.cpuUsage(); for (let i = 0; i < reps; i++) f(); const d = process.cpuUsage(u0); return (d.user + d.system) / 1000 / reps; };
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const measure = (f: () => unknown, reps: number) => { f(); return median(Array.from({ length: 7 }, () => cpuMs(f, reps))); };
  const bokFeed = fx("bok_rss_mpd.xml");
  const bokBytes = officialFixtureBytes("bok_rss_mpd.xml");
  const press = fx("bok_rss_press.xml");
  const ppi = fx("bls_ppi_nr0.html");
  const ecb = fx("ecb_mp260910.html");
  const bcb = fx("bcb_historicotaxasjuros.json");
  const cases: Array<[string, () => unknown]> = [
    ["bok decision feed 886 KB, target absent (walks all 100 items)", () => parseBokDecisionRss(bokFeed, "2026-10-22")],
    ["bok decision feed 886 KB, target present", () => parseBokDecisionRss(bokFeed, "2026-08-27")],
    ["bok decision feed 886 KB, bytes -> text -> parse (what the Worker does after arrayBuffer)", () => parseBokDecisionRss(new TextDecoder().decode(bokBytes), "2026-08-27")],
    ["bok press feed 263 KB", () => parseBokGdpRss(press, "2026-Q2")],
    ["bls ppi 132 KB", () => parseBlsRelease(ppi, "ppi")],
    ["ecb release 107 KB", () => parseEcbRelease(ecb)],
    ["bcb history 102 KB", () => parseBcbHistory(bcb, "2026-09-16")],
  ];

  it("parses the largest saved body (BoK decision feed, 886 KB) in < 5 ms of CPU", () => {
    expect(bokFeed.length).toBeGreaterThan(800_000);
    const t = measure(() => parseBokDecisionRss(new TextDecoder().decode(bokBytes), "2026-08-27"), 20);
    console.log(`official parse CPU: bok decision feed, decode + parse, median ${t.toFixed(3)} ms`);
    expect(t).toBeLessThan(5);
  });
  it("a whole burst (10 not-yet reads, as the adapter reads them) of the heaviest sources stays under 9 ms of CPU", () => {
    const bcbBytes = officialFixtureBytes("bcb_historicotaxasjuros.json");
    const burst = (f: () => unknown) => () => { for (let i = 0; i < 10; i++) f(); };
    // src/ingest/official.ts: the BoK feed is only decoded when its bytes mention the decision date
    expect(bytesInclude(bokBytes, "<item>") && !bytesInclude(bokBytes, "October 22, 2026")).toBe(true);
    expect(bytesInclude(bokBytes, "August 27, 2026")).toBe(true);
    const bok = burst(() => (bytesInclude(bokBytes, "<item>") && !bytesInclude(bokBytes, usDayLabel("2026-10-22")) ? null : parseBokDecisionRss(new TextDecoder().decode(bokBytes), "2026-10-22")));
    const bcbBurst = burst(() => parseBcbHistory(new TextDecoder().decode(bcbBytes), "2026-11-04"));
    const tb = measure(bok, 3);
    const tc = measure(bcbBurst, 3);
    console.log(`official parse CPU: 10-read burst, bok decision feed ${tb.toFixed(2)} ms, bcb history ${tc.toFixed(2)} ms`);
    expect(tb).toBeLessThan(9);
    expect(tc).toBeLessThan(9);
  });
  it("every parser stays under 5 ms of CPU on its saved body", () => {
    for (const [name, f] of cases) {
      const t = measure(f, 10);
      console.log(`official parse CPU: ${name}: ${t.toFixed(3)} ms`);
      expect(t, name).toBeLessThan(5);
    }
  });
});

/**
 * Long-tail Polymarket candidates for shadow resolution: open markets with modest volume whose
 * description names a checkable source (GitHub, a release, mainnet, a docs/canonical URL).
 *   pnpm tsx scripts/polymarket-candidates.ts [--max-vol 50000] [--min-vol 200] [--pages 40]
 * Prints JSON lines for founder curation; registration stays a deliberate step (anchors are human-chosen).
 */
const a = process.argv.slice(2);
const get = (k: string, d: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1]! : d; };
const maxVol = Number(get("--max-vol", "50000")), minVol = Number(get("--min-vol", "200")), pages = Number(get("--pages", "40"));
const PATTERN = /github\.com|gitlab\.com|release|version \d|v\d+\.\d+|mainnet|testnet|launch|ship|deploy|etherscan|basescan|solscan|docs\.|changelog|npm|pypi|app store|play store/i;
(async () => {
  let printed = 0, scanned = 0;
  for (let p = 0; p < pages; p++) {
    const url = `https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100&offset=${p * 100}&order=volumeNum&ascending=true`;
    const r = await fetch(url, { headers: { "User-Agent": "ResolveBot/1.0", Accept: "application/json" } });
    if (!r.ok) { console.error("gamma", r.status); break; }
    const j = (await r.json()) as Array<Record<string, unknown>>;
    if (!j.length) break;
    for (const m of j) {
      scanned++;
      const vol = Number(m.volumeNum ?? 0);
      if (vol < minVol || vol > maxVol) continue;
      const desc = String(m.description ?? "");
      if (!PATTERN.test(desc)) continue;
      printed++;
      console.log(JSON.stringify({ id: m.id, slug: m.slug, question: String(m.question ?? "").slice(0, 100), volume: Math.round(vol), end: String(m.endDate ?? "").slice(0, 10), urls: (desc.match(/https?:\/\/[^\s)\]]+/g) ?? []).slice(0, 3), outcomes: m.outcomes, hint: (desc.match(PATTERN) ?? [""])[0] }));
    }
  }
  console.error(`scanned ${scanned} markets, ${printed} candidates (volume ${minVol}..${maxVol})`);
})();

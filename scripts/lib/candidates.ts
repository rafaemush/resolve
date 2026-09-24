/**
 * Shared, pure pieces of the shadow-market candidate pipeline (plan §16.4 P5, §17.3 P5): source classification, text
 * clean-up, suggested anchors, the official-release detector and the candidate-file schema that scripts/candidates.ts
 * writes and scripts/seed-shadow.ts reads. Nothing here touches the network; tests/candidates.test.ts runs it on
 * inline fixtures.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------------------------------------------
// Text

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Decodes the HTML entities the platforms emit (&amp; &#39; &quot; &nbsp; and numeric forms). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k]!;
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(Number(k.slice(1)));
    return m;
  });
}

/** Limitless descriptions are HTML: block ends become newlines, tags go, entities decode, zero-width characters go. */
export function stripHtml(html: string): string {
  const text = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(text)
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------------------------------------------
// URLs and source classes

/**
 * Where a resolution source points. Primary (machine-readable, first-party) classes are accepted; the rest are recorded
 * but never make a market checkable on their own.
 */
export type SourceClass =
  | "central_bank" | "official_statistics" | "election_authority" | "government" | "github" | "onchain" // tier A
  | "company_or_project" // tier B: the subject's own domain
  | "designated_source" // tier B: a site the rules name as THE resolution source (France Football for the Ballon d'Or)
  | "social" | "news" | "platform" | "third_party"; // not primary

export const PRIMARY_A: ReadonlySet<SourceClass> = new Set(["central_bank", "official_statistics", "election_authority", "government", "github", "onchain"]);
export const PRIMARY_B: ReadonlySet<SourceClass> = new Set(["company_or_project", "designated_source"]);

export interface ClassifiedUrl { url: string; host: string; cls: SourceClass }

const SOCIAL = ["x.com", "twitter.com", "facebook.com", "instagram.com", "youtube.com", "youtu.be", "tiktok.com", "t.me", "telegram.org", "reddit.com", "twitch.tv", "truthsocial.com", "threads.net", "bsky.app", "discord.com", "discord.gg", "linkedin.com", "kick.com", "rumble.com"];
const X_HOSTS = ["x.com", "twitter.com"];
const NEWS = ["reuters.com", "apnews.com", "bloomberg.com", "nytimes.com", "wsj.com", "cnn.com", "foxnews.com", "bbc.com", "bbc.co.uk", "thehill.com", "politico.com", "axios.com", "washingtonpost.com", "abcnews.go.com", "cbsnews.com", "nbcnews.com", "msnbc.com", "usatoday.com", "semafor.com", "theinformation.com", "theguardian.com", "ft.com", "cnbc.com", "forbes.com", "businessinsider.com", "coindesk.com", "theblock.co", "decrypt.co", "poder360.com.br", "israelhayom.com", "pressreader.com", "vogue.com", "natesilver.net", "predictionmarketodds.com", "seekingalpha.com", "nasdaq.com"];
/** Prediction platforms, their own trackers and generic hosting/maps: never the source of a fact. */
const PLATFORM = ["polymarket.com", "kalshi.com", "limitless.exchange", "manifold.markets", "amazonaws.com", "goo.gl", "bit.ly", "arcgis.com", "google.com", "docs.google.com", "xtracker.io", "pythdata.app"];
const CENTRAL_BANKS = ["federalreserve.gov", "newyorkfed.org", "stlouisfed.org", "ecb.europa.eu", "boj.or.jp", "bok.or.kr", "bcb.gov.br", "bankofengland.co.uk", "bankofcanada.ca", "rba.gov.au", "rbnz.govt.nz", "snb.ch", "riksbank.se", "norges-bank.no", "banxico.org.mx", "pbc.gov.cn", "banrep.gov.co", "rbi.org.in", "tcmb.gov.tr", "cbr.ru", "bcra.gob.ar", "bcentral.cl", "bundesbank.de", "banque-france.fr", "sbp.org.pk", "bi.go.id", "bnm.gov.my", "mas.gov.sg", "hkma.gov.hk"];
const STATISTICS = ["bls.gov", "bea.gov", "census.gov", "ons.gov.uk", "statcan.gc.ca", "abs.gov.au", "destatis.de", "insee.fr", "istat.it", "ine.es", "ibge.gov.br", "indec.gob.ar", "stats.gov.cn", "kostat.go.kr", "stat.go.jp", "e-stat.go.jp", "ec.europa.eu", "treasury.gov", "eia.gov", "ismworld.org", "sca.isr.umich.edu", "customs.go.kr", "fred.stlouisfed.org", "weather.gov", "noaa.gov", "usgs.gov", "nasa.gov", "cdc.gov"];
const ELECTION_HOST = /(^|\.)(elections?[a-z-]*|izbori|elezioni|wahlen|cvk|onpe|jne|tse|aec|eci|fec|sos|electionsquebec|elecciones|eleicoes)\./;
const GOV_HOST = /(\.(gov|mil|int)$)|(\.(gov|gob|gouv|go|govt|gv|mil)\.[a-z]{2}$)|(\.europa\.eu$)|(\.gc\.ca$)|(\.(jus|leg)\.br$)|(\.admin\.ch$)|(^ch\.ch$)|(^gov\.[a-z]{2}$)/;
const EXPLORERS = ["etherscan.io", "basescan.org", "solscan.io", "polygonscan.com", "arbiscan.io", "optimistic.etherscan.io", "explorer.solana.com", "solana.fm", "blockscout.com", "bscscan.com", "tronscan.org", "mempool.space", "blockchair.com"];

const onHost = (host: string, list: readonly string[]) => list.some((d) => host === d || host.endsWith(`.${d}`));

/** Hosts with two-level public suffixes keep their third label as the "name" (newsroom.chipotle.co.uk -> chipotle). */
export function hostLabel(host: string): string {
  const parts = host.split(".");
  if (parts.length >= 3 && parts[parts.length - 1]!.length === 2 && parts[parts.length - 2]!.length <= 3) return parts[parts.length - 3]!;
  return parts.length >= 2 ? parts[parts.length - 2]! : host;
}

const wordsOf = (s: string) => new Set(s.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/**
 * Pure. `subject` is the market's question and event title: a domain counts as the subject's own (company_or_project)
 * only when its name label appears there as a word ("newsroom.chipotle.com" for a Chipotle market), so a random
 * aggregator never passes as primary.
 */
export function classifyUrl(url: string, subject: string): ClassifiedUrl | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\d*\./, "").replace(/\.$/, "");
  const path = u.pathname.toLowerCase();
  const out = (cls: SourceClass): ClassifiedUrl => ({ url, host, cls });
  if (onHost(host, SOCIAL)) return out("social");
  if (onHost(host, PLATFORM)) return out("platform");
  if (onHost(host, NEWS)) return out("news");
  if (host === "github.com" && /^\/[^/]+\/[^/]+/.test(u.pathname)) return out("github");
  if (onHost(host, EXPLORERS)) return out("onchain");
  if (onHost(host, CENTRAL_BANKS)) return out("central_bank");
  if (ELECTION_HOST.test(`${host}.`) || (GOV_HOST.test(host) && /election/.test(path))) return out("election_authority");
  if (onHost(host, STATISTICS)) return out("official_statistics");
  if (GOV_HOST.test(host)) return out("government");
  const label = hostLabel(host);
  if (label.length >= 3 && wordsOf(subject).has(label)) return out("company_or_project");
  return out("third_party");
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;
/** Bare domains in prose ("per bls.gov") on a short TLD list; a dotted abbreviation like "U.S." never matches. */
const BARE_RE = /(?<![\w@/.-])((?:[a-z0-9-]{2,}\.)+(?:gov|mil|int|org|com|net|io|ai|eu|edu|xyz|app|dev))(?![\w-])(\/[^\s"'<>)\]]*)?/gi;

/** "The resolution source for this market will be ...", "primary resolution source", Limitless's "Outcome verified from". */
const DESIGNATION = /resolution source|outcome verified from/gi;
const DESIGNATION_REACH = 250;

export interface FoundUrl { url: string; bare: boolean; designated: boolean }

/**
 * Pure. URLs from text and raw HTML (href values included), entity-decoded, trailing punctuation trimmed, deduplicated.
 * `designated`: the URL comes from a resolution-source field, or sits within 250 characters after a designation phrase.
 */
export function extractUrls(texts: Array<string | null | undefined>, designatedTexts: Array<string | null | undefined> = []): FoundUrl[] {
  const byKey = new Map<string, FoundUrl>();
  const push = (raw: string, bare: boolean, designated: boolean) => {
    const url = decodeEntities(raw).replace(/[.,;:!?'")\]]+$/, "");
    if (!url) return;
    const key = url.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    const prior = byKey.get(key);
    if (prior) { prior.designated ||= designated; return; }
    byKey.set(key, { url, bare, designated });
  };
  const scan = (t: string, wholeFieldDesignated: boolean) => {
    const marks = [...t.matchAll(DESIGNATION)].map((m) => m.index);
    const near = (i: number) => wholeFieldDesignated || marks.some((d) => i > d && i - d <= DESIGNATION_REACH);
    for (const m of t.matchAll(URL_RE)) push(m[0], false, near(m.index));
    const withoutUrls = t.replace(URL_RE, (u) => " ".repeat(u.length));
    for (const m of withoutUrls.matchAll(BARE_RE)) push(`https://${m[1]}${m[2] ?? ""}`, true, near(m.index));
  };
  for (const t of texts) if (t) scan(t, false);
  for (const t of designatedTexts) if (t) scan(t, true);
  return [...byKey.values()];
}

export interface SourceScan {
  primary: ClassifiedUrl[];
  other: ClassifiedUrl[];
  /** X / Twitter is the only reference (no primary source, no other site): plan §17.3, x.com-only sources abstain. */
  requiresX: boolean;
  /** Some primary reference was found only as a bare domain in prose (the suggested ref needs a look). */
  bareDomain: boolean;
  tier: "A" | "B" | null;
}

/**
 * Pure. Classifies every URL of the texts (rules text) and designatedTexts (resolution-source fields). A designated URL
 * that is otherwise third_party becomes designated_source; a designated news, social or platform URL stays what it is.
 * X-only means an X reference exists and no primary source does.
 */
export function scanSources(subject: string, texts: Array<string | null | undefined>, designatedTexts: Array<string | null | undefined> = []): SourceScan {
  const primary: ClassifiedUrl[] = [], other: ClassifiedUrl[] = [];
  let bareDomain = false;
  for (const { url, bare, designated } of extractUrls(texts, designatedTexts)) {
    let c = classifyUrl(url, subject);
    if (!c) continue;
    if (c.cls === "third_party" && designated) c = { ...c, cls: "designated_source" };
    if (PRIMARY_A.has(c.cls) || PRIMARY_B.has(c.cls)) { primary.push(c); if (bare) bareDomain = true; } else other.push(c);
  }
  const joined = [...texts, ...designatedTexts].filter(Boolean).join("\n");
  const mentionsX = other.some((c) => onHost(c.host, X_HOSTS)) || /\b(posts?|tweets?|account) on X\b|\bX \(formerly Twitter\)|\bTwitter account\b/i.test(joined);
  // News or another site next to the X link is an alternative (web evidence), so the market is not X-only.
  const alternatives = other.some((c) => c.cls !== "platform" && !onHost(c.host, X_HOSTS));
  const tier = primary.some((c) => PRIMARY_A.has(c.cls)) ? "A" : primary.length ? "B" : null;
  return { primary, other, requiresX: mentionsX && primary.length === 0 && !alternatives, bareDomain, tier };
}

/**
 * Price-threshold wording (plan §16.4 P5: excluded until the price_touch rail exists): "reach $150,000", "close above
 * $6,000", "Price Over/Under $933.63", "valuation be less than $500B", "Up or Down", "all-time high".
 */
const PRICE_WORDING = /\b(up or down|all[- ]time high|price of|over\/under)\b|\b(reach|hit|dip to|close (above|below|at)|trade (above|below)|above|below|between|less than|more than|greater than|at least|over|under)\s+\$\s?\d|\b(price|valuation|index|market cap|fdv)\b[^?]*\$\s?\d/i;

/**
 * A threshold on a number, with or without "$": "dip below 4.52%", "hit 5.50%", "at least 2.2M", "close above 6,000",
 * "4.5% or higher". Group 1 or 2 holds a percentage / basis-point unit when there is one.
 */
const THRESHOLD = /\b(?:hit|reach(?:es)?|touch(?:es)?|exceeds?|surpass(?:es)?|(?:dips?|drops?|falls?|rises?|climbs?|goes|go|closes?|ends?|settles?|trades?|finish(?:es)?)\s+(?:above|below|at|to|under|over)|above|below|at least|at most|between|over|under|less than|more than|greater than)\s+[\d.,]*\d\s?(%|bps\b|basis points?)?|[\d.,]*\d\s?(%|bps\b|basis points?)?\s+or\s+(?:higher|more|above|lower|less|below)\b/gi;
/** A bond or note yield: a market rate, quoted in percent. */
const YIELD = /\byields?\b/i;
/** Named index levels (a newspaper or company that shares a name, "Nikkei Asia", "Dow Inc", is not one). */
const INDEX_LEVEL = /\b(S&P 500|SPX|Nasdaq[- ](?:100|Composite)|NDX|Dow Jones|DJIA|Russell 2000|VIX|DXY|dollar index|Nikkei (?:225|average|index)|FTSE 100|DAX|CAC 40|Hang Seng|KOSPI|Sensex|Nifty 50|Euro Stoxx 50|Stoxx 600)(?![\w])/i;
const FX_WORDS = /\b(exchange rates?|forex|fx rates?)\b/i;
/** ISO codes are matched in capitals only, so the English words "try" and "won" never count as a currency. */
const CURRENCY_CODES = /\b(USD|EUR|GBP|JPY|CNY|CNH|RMB|INR|PKR|IRR|TRY|RUB|KRW|BRL|MXN|ARS|CAD|AUD|CHF|ZAR|NGN|UAH|ILS)\b/g;
/** Longest names first, so "Canadian dollars" is one currency (CAD), never CAD plus a bare "dollars". */
const CURRENCY_NAMES: Array<[RegExp, string]> = [
  [/\b(?:US|U\.S\.|American) dollars?\b/gi, "USD"], [/\bCanadian dollars?\b/gi, "CAD"], [/\bAustralian dollars?\b/gi, "AUD"],
  [/\bPakistani rupees?\b/gi, "PKR"], [/\bIndian rupees?\b/gi, "INR"], [/\bMexican pesos?\b/gi, "MXN"], [/\bArgentine pesos?\b/gi, "ARS"],
  [/\bKorean won\b/gi, "KRW"], [/\bBrazilian reais\b|\bBrazilian real\b|\breais\b/gi, "BRL"], [/\bSouth African rand\b/gi, "ZAR"], [/\bSwiss francs?\b/gi, "CHF"],
  [/\b(?:pounds? sterling|British pounds?|sterling)\b/gi, "GBP"], [/\b(?:Japanese )?yen\b/gi, "JPY"], [/\b(?:Chinese )?(?:yuan|renminbi)\b/gi, "CNY"],
  [/\b(?:Iranian )?rials?\b/gi, "IRR"], [/\b(?:Turkish )?lira\b/gi, "TRY"], [/\b(?:Russian )?ro?ubles?\b/gi, "RUB"], [/\beuros?\b/gi, "EUR"],
  [/\bnaira\b/gi, "NGN"], [/\bhryvnias?\b/gi, "UAH"], [/\bshekels?\b/gi, "ILS"], [/\brupees?\b/gi, "INR"], [/\bpesos?\b/gi, "MXN"], [/\bdollars?\b/gi, "USD"],
];

/** Pure. The distinct currencies a text names; a name is blanked once counted so a shorter name cannot count it again. */
export function currenciesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(CURRENCY_CODES)) out.add(m[1]!);
  let rest = text;
  for (const [re, code] of CURRENCY_NAMES) rest = rest.replace(re, (m) => { out.add(code); return " ".repeat(m.length); });
  return out;
}

/**
 * Pure. Price-threshold markets, excluded until the price_touch rail exists (plan §16.4 P5, §17.3 P1a): "$" wording
 * (PRICE_WORDING), or a threshold on a market rate written without "$": a yield in percent ("Will the 5-year Treasury
 * yield dip below 4.52% in September?"), an exchange rate ("Will USD be at least 2.2M Iranian rials on September 30?":
 * two currencies, "exchange rate" or "forex") or a named index level ("S&P 500 close above 6,000"). Routed to jev_web
 * with absence_after_deadline, an any-touch question would turn "no page shows the touch" into NO. The subject has to be
 * a market rate, so an official print that carries a percentage (unemployment rate, CPI, GDP growth, a vote share, a
 * central-bank rate decision) is not caught.
 */
export function isPriceThreshold(text: string): boolean {
  if (PRICE_WORDING.test(text)) return true;
  const thresholds = [...text.matchAll(THRESHOLD)];
  if (!thresholds.length) return false;
  if (YIELD.test(text) && thresholds.some((m) => (m[1] ?? m[2]) !== undefined)) return true;
  return INDEX_LEVEL.test(text) || FX_WORDS.test(text) || currenciesIn(text).size >= 2;
}

// ---------------------------------------------------------------------------------------------------------------
// Official releases (the P1a official_release rail's scope: plan §17.3)

const MACRO = /\b(CPI|PPI|PCE|GDP|inflation|unemployment rate|non-?farm|payrolls|jobs report|PMI|retail sales|exports?|imports?|trade balance|consumer (price|sentiment|confidence)|jobless claims)\b/i;
const CENTRAL_BANK = /\b(fed|fomc|federal reserve|ecb|european central bank|bank of (japan|korea|england|canada|brazil|mexico|israel)|boj|bok|boe|rba|rbi|snb|pboc|copom|selic|central bank|rate (decision|cut|hike)s?|interest rates?|bps (cut|hike|increase|decrease))\b/i;
const ELECTION = /\b(election|elections|midterms?|balance of power|win the (house|senate)|margin of victory|mayoral|referendum|electoral)\b/i;

export type OfficialKind = "macro_release" | "central_bank_decision" | "election_result";

/** Pure. Which official-release family the text names, or null. Central-bank wording wins over a macro word it contains. */
export function officialReleaseKind(text: string): OfficialKind | null {
  if (CENTRAL_BANK.test(text)) return "central_bank_decision";
  if (MACRO.test(text)) return "macro_release";
  if (ELECTION.test(text)) return "election_result";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Suggested registration pieces

const CONNECTORS = new Set(["of", "the", "and", "de", "da", "do", "del", "la", "le", "von", "van", "for"]);
const STOP = new Set(["will", "the", "a", "an", "by", "in", "on", "of", "for", "to", "be", "at", "who", "what", "which", "how", "when", "before", "after", "end", "is", "are", "does", "do", "yes", "no"]);

/**
 * Pure. Capitalized phrases of the question ("Will Sudan's Emergency Response Rooms win the Nobel Peace Prize in 2026?"
 * -> ["Sudan's Emergency Response Rooms", "Nobel Peace Prize"]), the leg label first when there is one. Every anchor must
 * appear verbatim-ish in the evidence (precheck NO_ANCHOR), so these are a starting point the founder edits: the entry
 * lists "anchors" under needs_review.
 */
export function suggestAnchors(question: string, legLabel?: string | null): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.trim().replace(/[?.,:;!]+$/, "");
    if (t.length >= 2 && t.length <= 200 && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  if (legLabel && legLabel.trim() && !/^(yes|no)$/i.test(legLabel.trim())) add(legLabel);
  const tokens = question.replace(/[?!]/g, " ").split(/\s+/).filter(Boolean).map((t) => t.replace(/^[("'\u201c]+|[)"'\u201d,.:;]+$/g, ""));
  const capital = (t: string | undefined) => !!t && /^\p{Lu}/u.test(t) && !STOP.has(t.toLowerCase());
  let run: string[] = [];
  const flush = () => { if (run.length) add(run.join(" ")); run = []; };
  for (const [i, bare] of tokens.entries()) {
    // A capital starts or continues a phrase; a number or $/# only continues one ("Formula 1", "PR #4821"), so a bare
    // year never becomes an anchor on its own; a connector continues one only between capitals ("Bank of Korea").
    const continues = run.length > 0 && (/^[\p{N}$#]/u.test(bare) || (CONNECTORS.has(bare) && capital(tokens[i + 1])));
    if (capital(bare) || continues) run.push(bare); else flush();
  }
  flush();
  if (!out.length) add(question.slice(0, 120));
  return out.slice(0, 3);
}

export const toIso = (v: string | number | null | undefined): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** The schema caps condition at 4000 characters; a longer rule text is cut and flagged for review. */
export function conditionText(text: string, fallback: string): { condition: string; truncated: boolean } {
  const t = text.trim() || fallback.trim();
  if (t.length <= 4000) return { condition: t.length >= 8 ? t : `${t} (see platform rules)`, truncated: false };
  return { condition: `${t.slice(0, 3990).trimEnd()} [cut]`, truncated: true };
}

export function sourceRefs(primary: ClassifiedUrl[]): Array<{ kind: "web_fetch"; ref: string }> {
  return primary.slice(0, 10).map((c) => ({ kind: "web_fetch" as const, ref: c.url }));
}

// ---------------------------------------------------------------------------------------------------------------
// File format (written by scripts/candidates.ts, curated by the founder, read by scripts/seed-shadow.ts)

export const CandidatePlatform = z.enum(["polymarket", "limitless"]);
export type CandidatePlatform = z.infer<typeof CandidatePlatform>;

export const CandidateRegistration = z.object({
  /** The POST /internal/markets `market` body: checked against MarketRegistration by seed-shadow --check. */
  market: z.record(z.string(), z.unknown()),
  meta: z.record(z.string(), z.unknown()),
  is_test: z.boolean(),
});
export type CandidateRegistration = z.infer<typeof CandidateRegistration>;

export const CandidateEntry = z.object({
  /** Only the founder sets this; candidates.ts always writes false. */
  approved: z.boolean(),
  /** Fields the founder must edit or confirm first; seed-shadow refuses an approved entry while this is not empty. */
  needs_review: z.array(z.string()),
  /** Volume in USD of the market being registered (the $50k shadow cap). */
  volume_usd: z.number().nonnegative(),
  registration: CandidateRegistration,
}).loose();
export type CandidateEntry = z.infer<typeof CandidateEntry>;

export const CandidateHeader = z.object({
  platform: CandidatePlatform,
  generated_at: z.string(),
  source_url: z.string(),
  filters: z.record(z.string(), z.unknown()),
  counts: z.record(z.string(), z.unknown()),
  needs_founder_approval: z.boolean(),
}).loose();

export const CandidateFile = z.object({ header: CandidateHeader, entries: z.array(CandidateEntry) });
export type CandidateFile = z.infer<typeof CandidateFile>;

/** header.how_to_approve of every candidate file: the founder's instructions, next to the entries they apply to. */
export const HOW_TO_APPROVE = "For each market to seed: edit every field listed under needs_review (anchors must appear in the source page; sources must be https pages that state the outcome; event_statement must be a declarative fact with no deadline, never the platform's question: \"Will Pacifica launch a token by September 30, 2026?\" becomes \"Pacifica launched its token\", because the resolver asks the model whether that sentence has occurred and checks the deadline itself), empty needs_review, set approved: true. Then run npx tsx scripts/seed-shadow.ts <this file> --check, then --dry-run, then --apply. Unapproved entries are never registered.";

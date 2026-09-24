/**
 * GET /bot (plan §17.3 P6 "/bot"): the page ResolveBot's user agent points at. What the bot fetches and why, how it
 * stays polite, and how a site opts out. Public, no auth, static apart from the configured UA. Every statement here is
 * what the code does: the UA (src/ops/ua.ts), robots.txt per RFC 9309 at registration (src/ingest/robots.ts), the poll
 * cadence (src/markets/source-checks.ts: 300 s, 60 s in the last 24 h before a deadline), conditional requests and
 * Retry-After (src/ingest/web.ts, src/ingest/http.ts), the official-release burst (src/ingest/official-watch.ts), and the
 * web caps (512 KB, 5 checked redirects, 8 s). Pure: botPageHtml renders it.
 */
import { BOT_TOKEN } from "../ops/ua";

export const OPT_OUT_ISSUES_URL = "https://github.com/rafaemush/resolve/issues";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function botPageHtml(ua: string): string {
  const agent = esc(ua);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ResolveBot</title>
<meta name="description" content="What ResolveBot fetches, why, how it stays polite, and how to opt out.">
<style>
  :root { --bg: #fbfbfa; --fg: #1d1d1b; --muted: #5d5d58; --rule: #e3e2de; --code: #f0efeb; --link: #1f5fbf; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe7; --muted: #a3a29c; --rule: #2e2e2b; --code: #22221f; --link: #8ab4f8; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 44rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .5rem; }
  h2 { font-size: 1.15rem; margin: 2.2rem 0 .6rem; padding-top: 1.2rem; border-top: 1px solid var(--rule); }
  p, li { color: var(--fg); }
  .lede { color: var(--muted); margin-top: 0; }
  ul { padding-left: 1.2rem; }
  li { margin: .35rem 0; }
  code, pre { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); border-radius: 4px; }
  code { padding: .1rem .3rem; overflow-wrap: anywhere; }
  pre { padding: .8rem 1rem; overflow-x: auto; }
  a { color: var(--link); }
  footer { margin-top: 3rem; color: var(--muted); font-size: .9rem; }
</style>
</head>
<body>
<main>
<h1>ResolveBot</h1>
<p class="lede">ResolveBot is the fetcher of Resolve, a service that checks whether the stated condition of a prediction market has happened, using the public sources registered for that market.</p>
<p>It identifies itself with this user agent on every request:</p>
<pre id="ua">${agent}</pre>

<h2>What it fetches, and why</h2>
<ul>
  <li>The specific public pages registered as the source of a market (for example an announcement, a results page or a status page), and nothing linked from them.</li>
  <li>Official releases of statistics offices and central banks, around their scheduled release times.</li>
  <li>Public APIs: GitHub repository objects, prediction market platforms' public market data, and public blockchain RPC endpoints.</li>
</ul>
<p>Each fetch is stored with a hash of what was received, so every recorded check can be traced to the exact bytes it was based on. ResolveBot does not log in, submit forms, run JavaScript, or collect personal data.</p>

<h2>How it stays polite</h2>
<ul>
  <li><strong>Declared user agent.</strong> The string above, with a link back to this page.</li>
  <li><strong>robots.txt.</strong> Read per RFC 9309 before a page is registered. If your robots.txt disallows the page for <code>${BOT_TOKEN}</code> (or for all agents), the page is not registered and never fetched. A robots.txt that cannot be read (a server error or a timeout) counts as a disallow.</li>
  <li><strong>Spacing.</strong> A registered page is fetched at most once every 5 minutes, and at most once a minute in the last 24 hours before its market's deadline. An official release is not requested before its scheduled time; one fetcher serves every market that depends on it, with at most 10 requests in the half minute after the release, then at most one a minute.</li>
  <li><strong>Conditional requests.</strong> When your server sends an <code>ETag</code>, ResolveBot sends <code>If-None-Match</code>, so an unchanged page costs a <code>304</code>.</li>
  <li><strong>Back-off.</strong> A <code>Retry-After</code> header pushes the next fetch back (up to an hour).</li>
  <li><strong>Small, bounded requests.</strong> At most 512 KB of a page is read, at most 5 redirects are followed (each one checked before it is requested, and only within the same site), and every request times out after 8 seconds.</li>
</ul>

<h2>How to opt out</h2>
<p>Add a group for ResolveBot to your robots.txt:</p>
<pre>User-agent: ${BOT_TOKEN}
Disallow: /</pre>
<p>robots.txt is read when a page is registered. If a page of yours is already being fetched, or you want it stopped sooner, open an issue at <a href="${OPT_OUT_ISSUES_URL}">${OPT_OUT_ISSUES_URL}</a> with the host or URL, and the fetching is stopped.</p>

<footer>Resolve publishes an informational signal: not financial advice, and not an oracle of record.</footer>
</main>
</body>
</html>
`;
}

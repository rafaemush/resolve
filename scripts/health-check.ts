/**
 * npx tsx scripts/health-check.ts <base url> <git sha>
 * Run by scripts/deploy.sh after wrangler deploy: /health must report <git sha> (scripts/lib/health.ts). Exit 0 when it
 * does, or when this network cannot reach the Worker (a warning: the deploy went through); exit 1 when the Worker
 * answers with another version, a non-200 or another git_sha, or Cloudflare answers 5xx for it on every attempt (it
 * threw or hit a limit); exit 2 on bad arguments. Read-only: one GET per attempt.
 */
import { checkDeployedSha, healthReport } from "./lib/health";

const [url, sha, ...rest] = process.argv.slice(2);
if (!url || !sha || rest.length || !/^https?:\/\/[^\s]+$/.test(url) || !/^[0-9a-f]{40}$/.test(sha)) {
  console.error("usage: npx tsx scripts/health-check.ts <http(s) base url> <full 40-hex git sha>");
  process.exit(2);
}
const outcome = await checkDeployedSha(url, sha, {
  fetch: (u, init) => fetch(u, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (line) => console.log(line),
  attempts: 6,
  waitMs: 5_000,
  timeoutMs: 15_000,
});
const report = healthReport(outcome, url.replace(/\/+$/, ""), sha);
for (const line of report.lines) console.log(line);
process.exit(report.code);

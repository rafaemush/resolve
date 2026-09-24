/**
 * Venue reconciliation report (plan §17.3 P7-lite, §17.5, §19.3): the artifact an evidence-led touch attaches.
 *   npx tsx scripts/venue-report.ts --platform limitless|polymarket|custom|all [--since YYYY-MM-DD] [--out private/reports]
 * Read-only: selects v_venue_report (migration 021) and v_track_record with the service role, nothing else, and writes
 * <out>/venue-report-<platform>-<day>[-since-<day>].md and .csv. The output quotes live rows of the record, so --out must
 * be inside private/ (gitignored). Per venue: markets, distinct events, committed, reconciled distinct events, agreement
 * counts, the web-evidence count (a percentage only once v_track_record marks the platform reportable), lead time
 * p50/p90 over distinct events (at least 5), then one row per market grouped by event; the footer carries the
 * disclaimer, the generation time and the git sha. Rules and rendering: scripts/lib/venue-report.ts.
 * Secrets (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) are read from .env by scripts/lib/env.ts and never printed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadEnv, need } from "./lib/env";
import {
  inWindow, outDirRefusal, parseReportArgs, platformReportable, renderCsv, renderMarkdown, reportBaseName, venueTotals,
  REPORT_PLATFORMS, TRACK_COLUMNS, TrackRow, USAGE, UsageError, VENUE_COLUMNS, VenueRow, type ReportArgs,
} from "./lib/venue-report";
import { redact } from "../src/ops/redact";

/** PostgREST answers at most 1,000 rows per request on Supabase: every read pages until a short page. */
const PAGE = 1000;

function gitSha(): string {
  const r = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" });
  const sha = r.status === 0 ? r.stdout.trim() : "";
  const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  return sha ? `${sha}${dirty.status === 0 && dirty.stdout.trim() ? " (with uncommitted changes)" : ""}` : "unknown";
}

async function main(args: ReportArgs): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const outDir = resolve(root, args.out);
  const refused = outDirRefusal(root, outDir);
  if (refused) throw new UsageError(refused);
  loadEnv();
  const client = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  // ordered on a unique key, so pages never overlap or skip
  const readAll = async (from: string, columns: string, order: string[]): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (let at = 0; ; at += PAGE) {
      const q = order.reduce((b, col) => b.order(col), client.from(from).select(columns));
      const r = await q.range(at, at + PAGE - 1);
      if (r.error) throw new Error(`${from}: ${redact(r.error.message)}`);
      out.push(...(r.data ?? []));
      if ((r.data ?? []).length < PAGE) return out;
    }
  };
  // A column that no longer matches stops the report (zod throws): a row is never skipped or guessed.
  const rows = VenueRow.array().parse(await readAll("v_venue_report", VENUE_COLUMNS, ["market_id"]));
  const track = TrackRow.array().parse(await readAll("v_track_record", TRACK_COLUMNS, ["platform", "week"]));

  const platforms = args.platform === "all" ? REPORT_PLATFORMS.filter((p) => rows.some((r) => r.platform === p)) : [args.platform];
  const sections = platforms.map((p) => {
    const inside = inWindow(rows, p, args.since);
    return { totals: venueTotals(inside, p, platformReportable(track, p)), rows: inside };
  });
  const generatedAt = new Date().toISOString();
  const base = reportBaseName(args.platform, generatedAt, args.since);
  mkdirSync(outDir, { recursive: true });
  const md = join(outDir, `${base}.md`), csv = join(outDir, `${base}.csv`);
  writeFileSync(md, renderMarkdown({ sections, since: args.since, generatedAt, gitSha: gitSha() }));
  writeFileSync(csv, renderCsv(sections));
  for (const s of sections) {
    const t = s.totals;
    console.log(`${t.platform}: ${t.markets} markets, ${t.events} events, ${t.committed} committed, ${t.reconciled_events} reconciled events, reportable ${t.reportable}`);
  }
  if (!sections.length) console.log("no market on any platform yet: the report says so");
  console.log(`wrote ${md.slice(root.length + 1)} and ${csv.slice(root.length + 1)}`);
}

let args: ReportArgs;
try { args = parseReportArgs(process.argv.slice(2)); } catch (e) {
  console.error(e instanceof UsageError ? `${e.message}\n${USAGE}` : String(e));
  process.exit(2);
}
main(args).catch((e) => { console.error(e instanceof UsageError ? e.message : String(e)); process.exit(e instanceof UsageError ? 2 : 1); });

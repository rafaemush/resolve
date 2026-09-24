/**
 * Register the founder-approved entries of a curated candidate file as shadow markets (plan §16.4 P5 step 3-4).
 *
 *   npx tsx scripts/seed-shadow.ts private/shadow-markets/<file>.json [--check | --dry-run (default) | --apply]
 *
 * --check    offline: every entry against the rules of scripts/lib/seed-shadow.ts (MarketRegistration, the meta whitelist,
 *            condition_id on Polymarket, the $50k cap, is_test false, a future deadline, a declarative deadline-free
 *            event_statement, sources that pass the Worker's registration policy, needs_review empty once approved, no
 *            duplicates). Exit 1 when an approved entry fails.
 * --dry-run  --check, then read-only: asks the Worker for its registration contract (an empty POST that it refuses with
 *            400 before any write) and reads production (service role, SELECT only) to show, per approved entry, whether
 *            it would be registered or skipped because (platform, external_id) already exists as a shadow market. An
 *            existing market is verified like a new one (below); one that is not the approved entry is listed as BROKEN
 *            and the exit code is 1.
 * --apply    the same, then for each approved entry not yet present: POST <RESOLVE_PUBLIC_URL, else
 *            https://resolve.rafaemush.workers.dev>/internal/markets {market, meta, is_test: false} with ADMIN_API_KEY,
 *            and read the row back from the database (not from the Worker's answer) to confirm platform, external_id,
 *            is_test, condition_id, every meta key and the sources landed, and that an open market has one active watch
 *            per source. Stops at the first failure; rerunning skips what exists once the same check passes on it (a
 *            market left without its watches by a failed or timed-out registration stops the rerun, named), so the
 *            command is idempotent. An entry whose sources the Worker rules out (a robots.txt rule) is registered as
 *            unsupported_source by the Worker and reported; it has no watches. A check the Worker could not make (an
 *            RPC down, a robots.txt that answered 5xx or 429 or not at all: HTTP 503) stores nothing and stops the run;
 *            rerun it later.
 * Secrets (ADMIN_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) are read from .env by scripts/lib/env.ts and never
 * printed. The founder's ISP blocks *.workers.dev: set RESOLVE_PUBLIC_URL to a reachable host (the custom domain).
 */
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { loadEnv, need } from "./lib/env";
import { checkCandidateFile, parseSeedArgs, UsageError, USAGE, verifyRow, type FileCheck, type SeedArgs, type ShadowRow } from "./lib/seed-shadow";
import { CandidateFile, type CandidateEntry } from "./lib/candidates";
import { mergeMeta, META_KEYS } from "../src/markets/meta";
import { MarketRegistration } from "../src/resolve/schema";
import { redact } from "../src/ops/redact";

const DEFAULT_WORKER = "https://resolve.rafaemush.workers.dev";

class Stop extends Error {}
const say = (line: string) => console.log(line);

function report(check: FileCheck): void {
  for (const f of check.fileErrors) say(`file: ${f}`);
  for (const e of check.entries) {
    if (!e.errors.length) { if (e.approved) say(`ok       #${e.index} ${e.platform}:${e.external_id}`); continue; }
    say(`${e.approved ? "BLOCKED " : "info    "} #${e.index} ${e.platform}:${e.external_id}${e.approved ? "" : " (not approved)"}`);
    for (const x of e.errors) say(`           - ${x}`);
  }
  say(`${check.entries.length} entries, ${check.approved} approved, ${check.approvedInvalid} approved with errors`);
}

const Registered = z.object({
  ok: z.literal(true),
  data: z.object({
    market_id: z.string(),
    status: z.string(),
    reasons: z.array(z.string()),
    watches: z.array(z.object({ id: z.string(), source_kind: z.string() })),
    existing: z.boolean(),
    is_test: z.boolean(),
    meta_applied: z.array(z.string()),
    meta_dropped: z.array(z.string()),
  }),
});

/** An empty body is refused before any write; the 400 names the meta keys this Worker stores. */
async function preflight(worker: string, adminKey: string): Promise<void> {
  const r = await fetch(`${worker}/internal/markets`, { method: "POST", headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30_000) });
  const body = (await r.json().catch(() => null)) as { meta_keys?: unknown } | null;
  if (r.status === 403) throw new Stop(`the Worker at ${worker} refused ADMIN_API_KEY (HTTP 403)`);
  if (r.status !== 400 || !Array.isArray(body?.meta_keys)) throw new Stop(`the Worker at ${worker} does not speak the P5 registration contract (HTTP ${r.status}, no meta_keys): deploy it before seeding, or it would store markets without their meta`);
  const theirs = [...(body!.meta_keys as string[])].sort().join(","), ours = [...META_KEYS].sort().join(",");
  if (theirs !== ours) throw new Stop(`meta whitelist differs: Worker [${theirs}] vs this script [${ours}]; deploy the same commit`);
}

async function findShadow(client: SupabaseClient, platform: string, externalId: string): Promise<ShadowRow | null> {
  const { data, error } = await client.from("markets").select("id, platform, external_id, status, is_test, condition_id, meta, sources").eq("platform", platform).eq("external_id", externalId).is("tenant_id", null).is("deleted_at", null);
  if (error) throw new Stop(`markets read for ${platform}:${externalId}: ${redact(error.message)}`);
  if ((data ?? []).length > 1) throw new Stop(`${platform}:${externalId} exists ${data!.length} times as a shadow market; resolve that by hand first`);
  return ((data ?? [])[0] as ShadowRow | undefined) ?? null;
}

/** Active, not deleted watches of a market: the ones select_due_watches() will lease. */
async function activeWatches(client: SupabaseClient, marketId: string): Promise<number> {
  const { count, error } = await client.from("watches").select("id", { count: "exact", head: true }).eq("market_id", marketId).eq("active", true).is("deleted_at", null);
  if (error || count === null) throw new Stop(`watches read for market ${marketId}: ${redact(error?.message ?? "no count returned")}`);
  return count;
}

const REPAIR = "a registration that stopped part-way or an entry edited after registering; repair or soft-delete that market by hand, then rerun";

async function register(worker: string, adminKey: string, entry: CandidateEntry): Promise<z.infer<typeof Registered>["data"]> {
  const r = await fetch(`${worker}/internal/markets`, {
    method: "POST", headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
    body: JSON.stringify({ market: entry.registration.market, meta: entry.registration.meta, is_test: false }),
    signal: AbortSignal.timeout(60_000),
  });
  const json: unknown = await r.json().catch(() => null);
  const p = Registered.safeParse(json);
  if (!r.ok || !p.success) throw new Stop(`POST /internal/markets answered HTTP ${r.status}: ${redact(JSON.stringify(json)).slice(0, 400)}`);
  return p.data.data;
}

async function main(args: SeedArgs): Promise<number> {
  const now = new Date();
  let json: unknown;
  try { json = JSON.parse(readFileSync(args.file, "utf8")); } catch (e) { throw new Stop(`cannot read ${args.file}: ${String(e).slice(0, 200)}`); }
  const check = checkCandidateFile(json, now);
  report(check);
  if (check.fileErrors.length || check.approvedInvalid) return 1;
  if (args.mode === "check") return 0;
  if (!check.approved) { say("nothing approved: nothing to register"); return 0; }

  loadEnv();
  const worker = (process.env.RESOLVE_PUBLIC_URL || DEFAULT_WORKER).replace(/\/+$/, "");
  const adminKey = need("ADMIN_API_KEY");
  const client = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  say(args.mode === "apply" ? `APPLY: registering through ${worker}` : `DRY RUN: reads only (Worker contract check, database SELECTs). Rerun with --apply to register.`);
  await preflight(worker, adminKey);
  say("worker: registration contract and meta whitelist match");

  const file = CandidateFile.parse(json);
  const platform = file.header.platform;
  let registered = 0, skipped = 0, unsupported = 0, broken = 0;
  for (const [index, entry] of file.entries.entries()) {
    if (!entry.approved) continue;
    const externalId = String(entry.registration.market.external_id);
    // checkCandidateFile already parsed both for every approved entry, so these cannot fail here.
    const meta = mergeMeta(entry.registration.meta);
    if (!meta.ok) throw new Stop(`#${index}: meta: ${meta.error}`);
    const want = { platform, externalId, meta: meta.meta, sources: MarketRegistration.parse(entry.registration.market).sources };
    const existing = await findShadow(client, platform, externalId);
    if (existing) {
      // An existing row is verified like a new one: skipping it unchecked would count a market that never polls as present.
      const problems = verifyRow(existing, await activeWatches(client, existing.id), want);
      if (problems.length) {
        const line = `#${index} ${platform}:${externalId} exists as ${existing.id} (${existing.status}) but is not the approved entry: ${problems.join("; ")} (${REPAIR})`;
        if (args.mode === "apply") throw new Stop(line);
        broken++; say(`BROKEN   ${line}`); continue;
      }
      skipped++; say(`skip     #${index} ${platform}:${externalId} exists as ${existing.id} (${existing.status}), verified`); continue;
    }
    if (args.mode !== "apply") { say(`register #${index} ${platform}:${externalId}`); continue; }
    const r = await register(worker, adminKey, entry);
    const row = await findShadow(client, platform, externalId);
    const problems = verifyRow(row, row ? await activeWatches(client, row.id) : 0, want);
    if (r.existing) say(`note     #${index} the Worker found ${r.market_id} already registered (created since the read above)`);
    if (problems.length) throw new Stop(`#${index} ${platform}:${externalId} (${r.market_id}) did not land as sent: ${problems.join("; ")} (${REPAIR})`);
    if (r.status === "unsupported_source") { unsupported++; say(`UNSUPPORTED #${index} ${platform}:${externalId} ${r.market_id}: ${r.reasons.join(" | ")} (registered, no watches)`); }
    else { registered++; say(`registered #${index} ${platform}:${externalId} ${r.market_id} (${r.watches.length} watch${r.watches.length === 1 ? "" : "es"})`); }
  }
  if (args.mode === "apply") { say(`done: ${registered} registered, ${unsupported} unsupported_source, ${skipped} already present and verified`); return 0; }
  say(`dry run: ${skipped} already present and verified, ${broken} present but not as approved; the rest would be registered`);
  return broken ? 1 : 0;
}

let args: SeedArgs;
try { args = parseSeedArgs(process.argv.slice(2)); }
catch (e) { console.error(e instanceof UsageError ? `${e.message}\n${USAGE}` : String(e)); process.exit(2); }
main(args).then((code) => process.exit(code)).catch((e) => {
  console.error(e instanceof Stop ? `stopped: ${e.message}` : `failed: ${redact(String(e))}`);
  process.exit(1);
});

/**
 * The weekly Limitless re-scan number (plan §17.3, the rank-1 inventory number) and the resolution latency measured so
 * far, from what the recorder wrote (migration 018, src/jobs/limitless-recorder.ts).
 *   npx tsx scripts/limitless-cadence.ts
 * Read-only: selects v_limitless_cadence and limitless_markets with the service role; writes nothing. Secrets
 * (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) are read from .env by scripts/lib/env.ts and never printed.
 * How to read the output: docs/runbooks/limitless-recorder.md.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv, need } from "./lib/env";
import { CadenceRow, RecorderRow, cadenceByWeek, latencySummary, renderCadence } from "./lib/limitless-cadence";
import { redact } from "../src/ops/redact";

/** PostgREST answers at most 1,000 rows per request on Supabase: every read pages until a short page. */
const PAGE = 1000;

async function main(): Promise<void> {
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
  // A column that no longer matches stops the report (zod throws); a row is never skipped.
  const cadence = CadenceRow.array().parse(await readAll("v_limitless_cadence", "iso_week, week_start, category, markets_first_seen, markets_created_in_week, markets_expiring_45d, legs_first_seen", ["week_start", "category"]));
  const rows = RecorderRow.array().parse(await readAll("limitless_markets", "slug, group_slug, market_type, expiration_at, last_pending_at, resolved_seen_at, winning_outcome_index", ["slug"]));
  console.log(renderCadence(cadenceByWeek(cadence), latencySummary(rows, Date.now())));
}

main().catch((e) => { console.error(String(e)); process.exit(1); });

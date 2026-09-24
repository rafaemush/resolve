/**
 * The GTM lead list (plan §17.2 ranking, migration 014): name, platform, fit_rank, status and the last touch of every
 * lead that is not deleted, best fit first.
 *   npx tsx scripts/leads.ts
 * Read-only: selects leads and gtm_touches with the service role and writes nothing. Contacts are never printed
 * (personal data). Record a touch with scripts/log-touch.ts.
 * Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are read from .env by scripts/lib/env.ts and never printed.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv, need } from "./lib/env";
import { leadsTable, parseLeadsArgs, LEADS_USAGE, UsageError, type LeadRow, type TouchRow } from "./lib/touch";
import { redact } from "../src/ops/redact";

/** PostgREST answers at most 1,000 rows per request on Supabase: every read pages until a short page. */
const PAGE = 1000;

async function main(): Promise<void> {
  loadEnv();
  const client = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const readAll = async <T>(from: string, columns: string, build: (q: any) => any, order: string): Promise<T[]> => {
    const out: T[] = [];
    for (let at = 0; ; at += PAGE) {
      const r = await build(client.from(from).select(columns)).order(order).range(at, at + PAGE - 1);
      if (r.error) throw new Error(`${from}: ${redact(r.error.message)}`);
      out.push(...((r.data ?? []) as T[]));
      if ((r.data ?? []).length < PAGE) return out;
    }
  };
  const leads = await readAll<LeadRow>("leads", "id, name, org, platform, fit_rank, status", (q) => q.is("deleted_at", null), "id");
  const touches = await readAll<TouchRow>("gtm_touches", "lead_id, kind, direction, touched_at", (q) => q, "id");
  console.log(leads.length ? leadsTable(leads, touches) : "no leads yet");
}

try { parseLeadsArgs(process.argv.slice(2)); } catch (e) {
  console.error(e instanceof UsageError ? `${e.message}\n${LEADS_USAGE}` : String(e));
  process.exit(2);
}
main().catch((e) => { console.error(String(e)); process.exit(1); });

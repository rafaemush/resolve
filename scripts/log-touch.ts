/**
 * Record one GTM touch through log_touch() (migration 014; plan §17.4 "every touch in gtm_touches", §17.7 gates read
 * from it, never from a chat message).
 *
 *   npx tsx scripts/log-touch.ts --lead "<lead name>" --kind dm|email|call|reply|ops --direction out|in --summary "<text>"
 *                                [--evidence-url <url>] [--override-reason "<why>"] [--request-id <id>] [--dry-run | --apply]
 *
 * Dry run is the default: it reads the lead, whether this request id is already recorded, and (for an outbound pitch)
 * whether a reconciled row exists on the lead's platform, prints exactly what --apply would record, and writes nothing.
 * --lead must name exactly one lead that is not deleted; on a miss the closest names are listed and nothing is written.
 * --request-id defaults to sha256(lead|kind|direction|summary|UTC day), so rerunning the same command the same day
 * returns the touch already recorded instead of writing a second one (the log is append-only). A refusal by the
 * no-cold-pitch gate (SQLSTATE RS002) is printed in plain words with the --override-reason hint.
 * Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are read from .env by scripts/lib/env.ts and never printed.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv, need } from "./lib/env";
import { isPitch, leadCandidates, leadLine, parseTouchArgs, touchRefusal, TOUCH_USAGE, UsageError, type LeadRow, type TouchArgs } from "./lib/touch";
import { redact } from "../src/ops/redact";

class Stop extends Error {}
const say = (line: string) => console.log(line);
function check<T>(what: string, r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Stop(`${what}: ${redact(r.error.message)}`);
  return r.data;
}

async function main(a: TouchArgs): Promise<void> {
  loadEnv();
  const client: SupabaseClient = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  say(a.apply ? "APPLY: recording the touch." : "DRY RUN: nothing is written. Rerun with --apply to record the touch.");

  // 1. exactly one lead
  const exact = check("lead lookup", await client.from("leads").select("id, name, org, platform, fit_rank, status").eq("name", a.lead).is("deleted_at", null)) as LeadRow[];
  if (exact.length > 1) throw new Stop(`${exact.length} leads are named "${a.lead}":\n${exact.map((l) => `  ${leadLine(l)}`).join("\n")}\nRename one by hand first; a touch is recorded against exactly one lead.`);
  const lead = exact[0];
  if (!lead) {
    const all = check("lead list", await client.from("leads").select("id, name, org, platform, fit_rank, status").is("deleted_at", null).order("name").limit(1000)) as LeadRow[];
    const near = leadCandidates(all, a.lead);
    throw new Stop(`no lead is named exactly "${a.lead}". ${near.length ? `Closest:\n${near.map((l) => `  ${leadLine(l)}`).join("\n")}` : `${all.length} lead(s) exist; list them with npx tsx scripts/leads.ts.`}\nNothing was written.`);
  }
  say(`lead: ${leadLine(lead)}`);
  say(`touch: ${a.kind} ${a.direction}${isPitch(a) ? " (an outbound pitch: the no-cold-pitch gate applies)" : ""}`);
  say(`summary: ${a.summary}`);
  if (a.evidenceUrl) say(`evidence_url: ${a.evidenceUrl}`);
  if (a.overrideReason) say(`override_reason: ${a.overrideReason}`);
  say(`request_id: ${a.requestId}${a.derivedRequestId ? " (sha256 of lead|kind|direction|summary|today UTC: a rerun today returns the same touch)" : ""}`);

  // 2. already recorded under this request id?
  const prior = check("request id lookup", await client.from("gtm_touches").select("id, lead_id, kind, direction, summary, touched_at").eq("request_id", a.requestId)) as Array<{ id: string; lead_id: string; touched_at: string }>;
  if (prior[0]) say(`already recorded: touch ${prior[0].id} at ${prior[0].touched_at}; --apply returns it (log_touch refuses the same request id with different content)`);

  // 3. the gate, as advice (the database decides on --apply)
  if (isPitch(a) && !a.overrideReason && !prior[0]) {
    let reconciled = 0;
    if (lead.platform) {
      const r = await client.from("reconciliations").select("id, markets!inner(platform, tenant_id, is_test)", { count: "exact", head: true })
        .eq("markets.platform", lead.platform).is("markets.tenant_id", null).eq("markets.is_test", false).in("agreement", ["agree", "disagree", "abstained", "void"]);
      if (r.error) throw new Stop(`gate check: ${redact(r.error.message)}`);
      reconciled = r.count ?? 0;
    }
    say(reconciled > 0
      ? `gate: ${reconciled} reconciled row(s) on ${lead.platform}: the pitch passes`
      : `gate: no reconciled row on ${lead.platform ?? "(no platform)"}: --apply will be refused (RS002) unless --override-reason says why`);
  }
  if (!a.apply) return;

  const { data, error } = await client.rpc("log_touch", {
    p_lead: lead.id, p_kind: a.kind, p_direction: a.direction, p_summary: a.summary,
    p_evidence_url: a.evidenceUrl, p_override_reason: a.overrideReason, p_request_id: a.requestId,
  });
  if (error) {
    const plain = touchRefusal({ code: error.code, message: redact(error.message) }, a);
    throw new Stop(plain ?? `log_touch: ${redact(error.message)}`);
  }
  if (typeof data !== "string") throw new Stop(`log_touch answered ${JSON.stringify(data).slice(0, 200)}`);
  say(prior[0] ? `touch ${data} (already recorded; nothing new was written)` : `recorded touch ${data}`);
}

let args: TouchArgs;
try { args = parseTouchArgs(process.argv.slice(2), new Date().toISOString().slice(0, 10)); } catch (e) {
  console.error(e instanceof UsageError ? `${e.message}\n${TOUCH_USAGE}` : String(e));
  process.exit(2);
}
main(args).catch((e) => { console.error(e instanceof Stop ? e.message : String(e)); process.exit(1); });

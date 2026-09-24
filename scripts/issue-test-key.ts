/**
 * Issue an evaluation key (rsl_test_...) to a named tenant (plan §17.2 #3: the first ask of a prospect is a
 * structured-only test key; §17.3 P7-lite).
 *
 *   npx tsx scripts/issue-test-key.ts --name "Acme Bots" [--plan free] [--credits N] [--follow <market uuid>,...]
 *                                     [--expires-days 30] [--dry-run | --apply]
 *
 * Dry run is the default: it reads the database and prints exactly what --apply would do, and writes nothing. --apply:
 *   1. reuses the one live tenant whose display_name equals --name, or creates it (plan from --plan, default free;
 *      watch_limit 5 like POST /internal/tenants). An existing tenant's plan is never changed: a different --plan stops.
 *   2. grants --credits (default: 300 on the free plan, the evaluation grant of docs/pricing.md; 0 on a paid plan)
 *      through grant_credits() once per tenant (ledger request_id issue-test-key:<tenant_id>), so a rerun never grants
 *      twice.
 *   3. follows each --follow market through follow_market() with the tenant's plan cap (the rules of
 *      POST /v1/markets/:id/follow; needs migration 014).
 *   4. mints the key last, the way POST /internal/tenants does (src/api/keys.ts: sha256 stored, 12-char prefix), and
 *      prints it exactly once. Each --apply run mints a new key.
 * Any failure stops before the key is minted; every step is idempotent, so the same command can be rerun.
 * Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are read from .env by scripts/lib/env.ts and never printed; the
 * only secret this prints is the new key.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv, need } from "./lib/env";
import { evaluationCredits, grantRequestId, parseTestKeyArgs, UsageError, USAGE, type TestKeyArgs } from "./lib/test-key";
import { mintKey } from "../src/api/keys";
import { followCap, followMarket, followRefusal, Plan, type FollowTarget } from "../src/shadow/follows";
import { redact } from "../src/ops/redact";

interface Tenant { id: string; display_name: string; plan: string; credits_balance: number }
interface MarketRead extends FollowTarget { platform: string; external_id: string }

class Stop extends Error {}
const say = (line: string) => console.log(line);
function check<T>(what: string, r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Stop(`${what}: ${redact(r.error.message)}`);
  return r.data;
}

async function main(args: TestKeyArgs): Promise<void> {
  loadEnv();
  const client: SupabaseClient = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  say(args.apply ? "APPLY: writing to the database." : "DRY RUN: nothing is written. Rerun with --apply to issue the key.");

  // 1. tenant
  const found = check("tenant lookup", await client.from("tenants").select("id, display_name, plan, credits_balance").eq("display_name", args.name).is("deleted_at", null)) as Tenant[];
  if (found.length > 1) throw new Stop(`${found.length} live tenants are named "${args.name}" (${found.map((t) => t.id).join(", ")}); rename one by hand first`);
  let tenant: Tenant | null = found[0] ?? null;
  if (tenant && args.plan && tenant.plan !== args.plan) throw new Stop(`tenant "${args.name}" (${tenant.id}) exists on plan ${tenant.plan}; --plan ${args.plan} is not applied by this script. Change the plan by hand, or rerun without --plan`);
  const plan = Plan.safeParse(tenant?.plan ?? args.plan ?? "free");
  if (!plan.success) throw new Stop(`tenant ${tenant?.id} has an unknown plan ${JSON.stringify(tenant?.plan)}`);
  const cap = followCap(plan.data);
  const credits = evaluationCredits(plan.data, args.credits);
  say(tenant ? `tenant: reuse ${tenant.id} "${tenant.display_name}" (plan ${tenant.plan}, balance ${tenant.credits_balance} credits)` : `tenant: create "${args.name}" (plan ${plan.data}, watch_limit 5)`);

  // 2. markets to follow: the same rules as the API, checked before anything is written
  if (args.follow.length) {
    const markets = check("market lookup", await client.from("markets").select("id, tenant_id, is_test, status, deleted_at, platform, external_id").in("id", args.follow)) as MarketRead[];
    for (const id of args.follow) {
      const m = markets.find((x) => x.id === id) ?? null;
      const refusal = followRefusal(m, tenant?.id ?? "");
      if (refusal) throw new Stop(`--follow ${id}: ${refusal.message}`);
      say(`follow: ${id} (${m!.platform}:${m!.external_id}, ${m!.status})`);
    }
    say(`follow limit on plan ${plan.data}: ${cap ?? "unlimited"} follows of open markets${plan.data === "free" ? "; they deliver only while this tenant holds a live key" : ""}`);
  }

  // 3. the evaluation grant, once per tenant
  let grant: "none" | "skip" | "grant" = "none";
  if (credits > 0) {
    const prior = tenant ? (check("ledger lookup", await client.from("credit_ledger").select("delta, created_at").eq("tenant_id", tenant.id).eq("reason", "grant").eq("request_id", grantRequestId(tenant.id))) as Array<{ delta: number; created_at: string }>) : [];
    grant = prior.length ? "skip" : "grant";
    say(grant === "skip" ? `credits: already granted ${prior[0]!.delta} on ${prior[0]!.created_at}; not granted again` : `credits: grant ${credits}${args.credits === null ? ` (the ${plan.data} plan's default)` : ""} (grant_credits, once per tenant)`);
  } else {
    say(`credits: none granted${args.credits === null ? ` (the ${plan.data} plan has no evaluation grant; pass --credits N)` : ""}`);
  }
  const expiresAt = args.expiresDays > 0 ? new Date(Date.now() + args.expiresDays * 86_400_000).toISOString() : null;
  say(`key: mint one rsl_test_ key${expiresAt ? `, expires ${expiresAt}` : ", no expiry"}; shown once`);
  if (!args.apply) return;

  if (!tenant) {
    tenant = check("tenant insert", await client.from("tenants").insert({ display_name: args.name, plan: plan.data, watch_limit: 5 }).select("id, display_name, plan, credits_balance").single()) as Tenant;
    say(`created tenant ${tenant.id}`);
  }
  if (grant === "grant") {
    const balance = check("grant_credits", await client.rpc("grant_credits", { p_tenant: tenant.id, p_amount: credits, p_note: "evaluation grant (scripts/issue-test-key.ts)", p_request_id: grantRequestId(tenant.id) }));
    say(`granted ${credits} credits; balance ${balance}`);
  }
  for (const id of args.follow) {
    let a;
    try { a = await followMarket(client, tenant.id, id, cap); }
    catch (e) { throw new Stop(`follow ${id}: ${redact(String(e))}`); }
    if (a.result === "cap_reached") throw new Stop(`follow ${id}: follow limit ${a.cap} reached (${a.active} active)`);
    if (a.result === "not_followable") throw new Stop(`follow ${id}: ${a.reason}`);
    say(`${a.result === "followed" ? "following" : "already following"} ${id} (${a.active} active)`);
  }
  const key = await mintKey("test");
  const k = check("key insert", await client.from("api_keys").insert({ tenant_id: tenant.id, key_hash: key.hash, key_prefix: key.prefix, name: "issue-test-key", environment: "test", daily_cap: 1000, expires_at: expiresAt }).select("id").single()) as { id: string };
  say(`key id ${k.id} (${key.prefix})`);
  say(`API key (shown once, not stored anywhere): ${key.raw}`);
}

let args: TestKeyArgs;
try { args = parseTestKeyArgs(process.argv.slice(2)); }
catch (e) {
  console.error(e instanceof UsageError ? `${e.message}\n${USAGE}` : String(e));
  process.exit(2);
}
main(args).catch((e) => {
  console.error(e instanceof Stop ? `stopped, no key minted: ${e.message}` : `failed, no key minted: ${redact(String(e))}`);
  process.exit(1);
});

import { z } from "zod";
import type { Env, Config } from "../env";
import { db, rpc } from "../db/supabase";
import { MarketRegistration, type MarketRegistration as Reg } from "../resolve/schema";
import type { MarketMeta } from "./meta";
import { officialRefusal, officialRegistrationIssues } from "../resolve/official";
import { registrationPolicyIssues, webRenderRefusal, RegistrationError } from "./policy";
import { checkSources, type SourcePlan } from "./source-checks";

export type MarketStatus = "open" | "unsupported_source" | "resolved" | "void" | "closed_unresolved";

export interface RegisterResult {
  marketId: string;
  status: MarketStatus;
  reasons: string[];
  watches: Array<{ id: string; source_kind: string }>;
  /** true: the (tenant, platform, external_id) market already existed and nothing was written (meta and is_test included). */
  existing: boolean;
  /** Whitelisted meta keys written by this call (src/markets/meta.ts); empty for an existing market. */
  metaApplied: string[];
  /** markets.is_test of the returned row. */
  isTest: boolean;
}

export interface RegisterOptions {
  createWatches?: boolean;
  /** Importer metadata, already validated by mergeMeta(); merged into markets.meta, condition_id also into its column. */
  meta?: MarketMeta;
  /** markets.is_test (migration 012): a test market is never posted, reconciled or counted on the public record. */
  isTest?: boolean;
}

/**
 * Schema parse plus the official_release cross-field rules (series/source match, bucket, release_at, prior_level,
 * refused series such as the PDF-only Bank of Japan). Throws with every reason; pure, so tests call it directly.
 */
export function validateRegistration(input: unknown): Reg {
  const refused = officialRefusal(input);
  if (refused) throw new Error(refused);
  const reg: Reg = MarketRegistration.parse(input);
  const issues = officialRegistrationIssues(reg);
  if (issues.length) throw new Error(`official_release registration refused: ${issues.join("; ")}`);
  return reg;
}

/**
 * Everything a watch-creating registration decides before the database, in order: the registration policy
 * (src/markets/policy.ts; pure, so a refused source is never requested, not even its robots.txt), web_render, then
 * the source checks (src/markets/source-checks.ts: subrequest budget, robots, contract code, Solana account).
 * Throws RegistrationError; evals/registration.ts runs it against a stubbed fetch.
 */
export async function planRegistration(env: Env, cfg: Pick<Config, "botUa">, reg: Reg, now = Date.now()): Promise<SourcePlan> {
  const issues = registrationPolicyIssues(reg);
  if (issues.length) throw new RegistrationError({ kind: "invalid", message: `registration refused: ${issues.join("; ")}` });
  const render = webRenderRefusal(reg);
  if (render) throw new RegistrationError({ kind: "invalid", message: render });
  return checkSources(env, cfg, reg, now);
}

const WatchRef = z.object({ id: z.string(), source_kind: z.string() });
const Count = z.number().int().nonnegative();
/** register_market's answer (migration 019). */
const RegisterAnswer = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("created"), market_id: z.string(), status: z.enum(["open", "unsupported_source"]), is_test: z.boolean(), watches: z.array(WatchRef) }),
  z.object({ outcome: z.literal("existing"), market_id: z.string(), status: z.enum(["open", "unsupported_source", "resolved", "void", "closed_unresolved"]), reasons: z.array(z.string()), is_test: z.boolean(), watches: z.array(WatchRef) }),
  z.object({ outcome: z.literal("watch_limit"), watch_limit: Count, active_watches: Count, requested: Count }),
  z.object({ outcome: z.literal("base_watch_cap"), base_watch_cap: Count, active_base_watches: Count, requested: Count }),
]);

/**
 * Validate, run the registration-time policy and source checks, then store the market and its watches in one
 * transaction (register_market, migration 019), which also holds the tenant's watch_limit and the service's Base watch
 * cap under a lock, so two concurrent registrations can never both pass a limit. createWatches false (an inline market
 * on /v1/resolve) stores the market only and skips the policy and the checks: nothing will be fetched for it.
 */
export async function registerMarket(env: Env, cfg: Config, input: unknown, tenantId: string | null, opts: RegisterOptions = {}): Promise<RegisterResult> {
  const reg: Reg = validateRegistration(input);
  const client = db(env);
  // Idempotent registration: the same (tenant, platform, external_id) returns the existing market. A repeat never rewrites
  // it: meta and is_test of a market that may already carry a public commit stay as first registered. Looked up before the
  // checks, so a repeat costs no upstream request and answers the same whatever the sources say today.
  {
    let q = client.from("markets").select("id, status, meta, is_test").eq("platform", reg.platform).eq("external_id", reg.external_id).is("deleted_at", null);
    q = tenantId ? q.eq("tenant_id", tenantId) : q.is("tenant_id", null);
    const { data: existing, error: ee } = await q.maybeSingle();
    // A failed lookup must not fall through to an insert: that is how a duplicate market would be born.
    if (ee) throw new Error(`markets lookup: ${ee.message}`);
    if (existing) {
      const { data: ws } = await client.from("watches").select("id, source_kind").eq("market_id", existing.id).is("deleted_at", null);
      return { marketId: existing.id as string, status: existing.status as MarketStatus, reasons: ((existing.meta as { registration_reasons?: string[] })?.registration_reasons) ?? [], watches: (ws ?? []).map((w) => ({ id: w.id as string, source_kind: w.source_kind as string })), existing: true, metaApplied: [], isTest: existing.is_test === true };
    }
  }
  const plan: SourcePlan = opts.createWatches === false ? { status: "open", reasons: [], watches: [] } : await planRegistration(env, cfg, reg);
  const meta: MarketMeta = opts.meta ?? {};
  const market = {
    platform: reg.platform, external_id: reg.external_id, condition: reg.condition, event_statement: reg.event_statement,
    option_a: reg.option_a, option_b: reg.option_b, positive_option: reg.positive_option, anchors: reg.anchors, sources: reg.sources,
    resolver: reg.resolver ?? null, negative_rule: reg.negative_rule, allow_prerelease: reg.allow_prerelease, open_at: reg.open_at, deadline_utc: reg.deadline_utc,
    grace_seconds: reg.grace_seconds, status: plan.status, meta: { ...meta, registration_reasons: plan.reasons },
    condition_id: meta.condition_id ?? null, is_test: opts.isTest ?? false,
  };
  // markets.event_key is filled by the insert trigger (migration 017, market_event_key: the same rule as eventKey()).
  const answer = RegisterAnswer.safeParse(await rpc(client, "register_market", { p_tenant: tenantId, p_market: market, p_watches: plan.watches }));
  if (!answer.success) throw new Error(`register_market answered off contract: ${answer.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 200)}`);
  const a = answer.data;
  switch (a.outcome) {
    case "created": return { marketId: a.market_id, status: a.status, reasons: plan.reasons, watches: a.watches, existing: false, metaApplied: Object.keys(meta).sort(), isTest: a.is_test };
    // registered by a concurrent request between the lookup above and the transaction
    case "existing": return { marketId: a.market_id, status: a.status, reasons: a.reasons, watches: a.watches, existing: true, metaApplied: [], isTest: a.is_test };
    case "watch_limit": throw new RegistrationError({ kind: "watch_limit", limit: a.watch_limit, active: a.active_watches, requested: a.requested });
    case "base_watch_cap": throw new RegistrationError({ kind: "base_watch_cap", cap: a.base_watch_cap, active: a.active_base_watches, requested: a.requested });
    default: { const never: never = a; throw new Error(`unhandled register_market outcome ${String(never)}`); }
  }
}

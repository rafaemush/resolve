/** Argument rules of scripts/issue-test-key.ts (pure; tests/issue-test-key.test.ts). */
import { Plan, PLANS } from "../../src/shadow/follows";

export interface TestKeyArgs {
  /** tenants.display_name: an existing live tenant with this exact name is reused, otherwise one is created. */
  name: string;
  /** Plan for a new tenant (default free). For an existing tenant it must match: the script never changes a plan. */
  plan: Plan | null;
  /** Credits granted once per tenant through grant_credits (ledger request_id issue-test-key:<tenant_id>). */
  credits: number;
  /** Shadow markets the tenant follows (follow_market, the same cap as POST /v1/markets/:id/follow). */
  follow: string[];
  /** api_keys.expires_at = now + this many days; 0 = no expiry. The Free / evaluation time-box is 30 days (docs/pricing.md). */
  expiresDays: number;
  /** false (the default) = dry run: read and print the plan, write nothing. */
  apply: boolean;
}

export class UsageError extends Error {}

export const USAGE = `usage: npx tsx scripts/issue-test-key.ts --name "<tenant display name>" [--plan ${PLANS.join("|")}] [--credits N]
       [--follow <market uuid>[,<market uuid>...]] [--expires-days N (default 30, 0 = never)] [--dry-run (default) | --apply]`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAGS = new Set(["--name", "--plan", "--credits", "--follow", "--expires-days", "--dry-run", "--apply"]);
const BOOLEAN = new Set(["--dry-run", "--apply"]);

function int(flag: string, v: string, min: number, max: number): number {
  if (!/^\d+$/.test(v)) throw new UsageError(`${flag} must be a whole number, got "${v}"`);
  const n = Number(v);
  if (n < min || n > max) throw new UsageError(`${flag} must be between ${min} and ${max}, got ${n}`);
  return n;
}

/** Pure. Throws UsageError for anything it does not understand, so a typo never becomes a write. */
export function parseTestKeyArgs(argv: string[]): TestKeyArgs {
  const out: TestKeyArgs = { name: "", plan: null, credits: 0, follow: [], expiresDays: 30, apply: false };
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf("=");
    const flag = raw.startsWith("--") && eq > 0 ? raw.slice(0, eq) : raw;
    if (!FLAGS.has(flag)) throw new UsageError(`unknown argument "${raw}"`);
    if (BOOLEAN.has(flag)) {
      if (eq > 0) throw new UsageError(`${flag} takes no value`);
      if (flag === "--apply") out.apply = true; else dryRun = true;
      continue;
    }
    const value = eq > 0 ? raw.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    switch (flag) {
      case "--name": out.name = value.trim(); break;
      case "--plan": {
        const p = Plan.safeParse(value);
        if (!p.success) throw new UsageError(`--plan must be one of ${PLANS.join(", ")}, got "${value}"`);
        out.plan = p.data;
        break;
      }
      case "--credits": out.credits = int(flag, value, 0, 1_000_000); break;
      case "--expires-days": out.expiresDays = int(flag, value, 0, 365); break;
      case "--follow":
        for (const id of value.split(",").map((s) => s.trim()).filter(Boolean)) {
          if (!UUID.test(id)) throw new UsageError(`--follow takes market uuids, got "${id}"`);
          if (!out.follow.includes(id.toLowerCase())) out.follow.push(id.toLowerCase());
        }
        break;
      default: throw new UsageError(`unknown argument "${raw}"`);
    }
  }
  if (out.apply && dryRun) throw new UsageError("--apply and --dry-run are exclusive");
  if (!out.name) throw new UsageError("--name is required");
  if (out.name.length > 200) throw new UsageError("--name is longer than 200 characters");
  return out;
}

/** The ledger request_id that makes the evaluation grant once per tenant (credit_ledger UNIQUE(reason, request_id)). */
export const grantRequestId = (tenantId: string): string => `issue-test-key:${tenantId}`;

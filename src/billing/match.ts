/**
 * Manual deposit matching (plan §16.4 P3 step 3): a USDC transfer from a wallet no tenant registered lands as
 * 'unmatched' (the scan alerts deposit_unmatched), and the operator credits it to the right tenant with match_deposit()
 * (migration 020) through POST /internal/deposits/match. The database decides everything in one transaction (only an
 * unmatched deposit, the tier rate, one purchase row per transfer, who and why recorded); this module reads its answer.
 */
import { z } from "zod";

export const MatchBody = z.strictObject({
  tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "a 0x-prefixed 32-byte transaction hash"),
  log_index: z.number().int().min(0).max(2_147_483_647),
  tenant_id: z.uuid(),
  /** The evidence that the sender is this tenant (a message from them naming the transaction, an invoice...). */
  reason: z.string().trim().min(8).max(2000),
  actor: z.string().trim().min(1).max(120).default("admin"),
});

/** match_deposit's row. replayed = the deposit was already credited to this tenant: nothing was written this time. */
export const MatchRow = z.object({
  status: z.literal("credited"),
  tenant_id: z.string(),
  credits: z.number().int().positive(),
  balance_after: z.number().int().nonnegative(),
  amount_usdc: z.string(),
  // null on a deposit credited before migration 020 recorded rates
  credits_per_usdc: z.number().int().positive().nullable(),
  replayed: z.boolean(),
});
export type MatchRow = z.infer<typeof MatchRow>;

export interface MatchRefusal { status: 400 | 404 | 409 | 503; code: "validation_error" | "not_found" | "UPSTREAM_UNAVAILABLE" }

/**
 * Pure. The HTTP answer for a match_deposit error, by SQLSTATE: P0002 no such deposit or tenant; RS003 the deposit
 * cannot be matched (dust, another tenant's credit, not yet unmatched); 22023 a blank argument. RS004 (app_config
 * payg_tiers unusable: nothing is credited at a guessed rate) and anything else are the server's: nothing was matched
 * and a retry after the fix is safe (the function is idempotent).
 */
export function matchRefusal(sqlstate: string | undefined): MatchRefusal {
  switch (sqlstate) {
    case "P0002": return { status: 404, code: "not_found" };
    case "RS003": return { status: 409, code: "validation_error" };
    case "22023": return { status: 400, code: "validation_error" };
    default: return { status: 503, code: "UPSTREAM_UNAVAILABLE" };
  }
}

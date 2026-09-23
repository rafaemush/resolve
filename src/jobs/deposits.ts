/**
 * USDC (Base) deposits -> credits, only for logs at or below the provider's `safe` tag.
 * Cursor lives in app_config. Money rule: a deposit is never skipped. Logs are handled in
 * chain order and the cursor only moves past blocks whose logs were ALL handled, so a failure
 * is retried on the next scan (credit_from_deposit is INSERT-first, replays return 'duplicate').
 */
import { formatUnits } from "viem";
import type { Env, Config } from "../env";
import { db, rpc } from "../db/supabase";
import { baseLogsProviders, getBlock, hostOf, logsWindow, LogsUnavailableError, type RawLog } from "../ingest/base";
import { alert } from "../ops/alerts";
import { redact } from "../ops/redact";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (addr: string) => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const MAX_WINDOWS_PER_SCAN = 4;

export interface DepositLog { tx: string; logIndex: number; block: number; from: string; amountUsdc: string }
export type CreditFn = (d: DepositLog) => Promise<string>;
export interface ProcessResult { cursor: number; counts: Record<string, number>; failed: (DepositLog & { error: string }) | null }

export function toDepositLog(l: RawLog): DepositLog {
  return {
    tx: l.transactionHash.toLowerCase(),
    logIndex: parseInt(l.logIndex, 16),
    block: parseInt(l.blockNumber, 16),
    from: ("0x" + (l.topics[1] ?? "").slice(-40)).toLowerCase(),
    amountUsdc: formatUnits(BigInt(l.data === "0x" ? "0x0" : l.data), 6),
  };
}

/**
 * Handles the logs of the window (prevCursor, windowTo] in chain order. Zero-value transfers
 * (address-poisoning spam) are skipped: there is nothing to credit and usdc_deposits requires amount > 0.
 * On the first failure the returned cursor stops just before that log's block.
 */
export async function processDeposits(logs: DepositLog[], prevCursor: number, windowTo: number, credit: CreditFn): Promise<ProcessResult> {
  const sorted = [...logs].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const counts: Record<string, number> = {};
  for (const d of sorted) {
    if (Number(d.amountUsdc) <= 0) { counts.zero_value = (counts.zero_value ?? 0) + 1; continue; }
    try {
      const status = await credit(d);
      counts[status] = (counts[status] ?? 0) + 1;
    } catch (e) {
      return { cursor: Math.max(prevCursor, d.block - 1), counts, failed: { ...d, error: redact(String(e)).slice(0, 300) } };
    }
  }
  return { cursor: windowTo, counts, failed: null };
}

export interface ScanResult { scanned: boolean; from?: number; to?: number; found: number; credited: number; detail: string; counts?: Record<string, number> }

export async function scanDeposits(env: Env, cfg: Config): Promise<ScanResult> {
  if (!env.USDC_RECEIVING_ADDRESS) return { scanned: false, found: 0, credited: 0, detail: "USDC_RECEIVING_ADDRESS unset" };
  const started = Date.now();
  const client = db(env);
  const receiver = env.USDC_RECEIVING_ADDRESS.toLowerCase();
  const providers = baseLogsProviders(env);
  const counts: Record<string, number> = {};
  const providerErrors: string[] = [];
  let result: ScanResult;
  let provider = "";
  try {
    const { data: cfgRow, error: cfgErr } = await client.from("app_config").select("value").eq("key", "usdc_cursor_block").maybeSingle();
    if (cfgErr) throw new Error(`app_config read: ${cfgErr.message}`);
    let cursor = cfgRow ? Number(cfgRow.value) : NaN;
    if (!Number.isFinite(cursor)) {
      const first = providers[0];
      if (!first) throw new Error("no Base logs provider configured");
      const safe = await getBlock(first.url, "safe");
      const { error } = await client.from("app_config").upsert({ key: "usdc_cursor_block", value: String(safe.number) });
      if (error) throw new Error(`app_config init: ${error.message}`);
      result = { scanned: true, from: safe.number, to: safe.number, found: 0, credited: 0, detail: "cursor initialized at safe block; scanning forward from now" };
    } else {
      const startCursor = cursor;
      let found = 0, detail = "caught up", failed: ProcessResult["failed"] = null;
      for (let i = 0; i < MAX_WINDOWS_PER_SCAN; i++) {
        const w = await logsWindow(providers, cursor, { address: cfg.usdcContract, topics: [TRANSFER, null, pad(receiver)] });
        provider = hostOf(w.provider);
        providerErrors.push(...w.errors);
        if (w.notModified) { detail = i === 0 ? "no new safe blocks" : "caught up"; break; }
        found += w.logs.length;
        const safeBlock = w.safe.number;
        const r = await processDeposits(w.logs.map(toDepositLog), cursor, w.to, async (d) => {
          const out = await rpc<Array<{ status: string }> | { status: string }>(client, "credit_from_deposit", {
            p_tx_hash: d.tx, p_log_index: d.logIndex, p_from: d.from, p_to: receiver, p_amount_usdc: d.amountUsdc,
            p_block: d.block, p_safe_block: safeBlock, p_credits_per_usdc: cfg.creditsPerUsdc,
          });
          const row = Array.isArray(out) ? out[0] : out;
          if (!row?.status) throw new Error("credit_from_deposit returned no status");
          return row.status;
        });
        for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
        if (r.cursor !== cursor) {
          const { error } = await client.from("app_config").upsert({ key: "usdc_cursor_block", value: String(r.cursor) });
          if (error) throw new Error(`cursor write: ${error.message}`);
          cursor = r.cursor;
        }
        if (r.failed) { failed = r.failed; detail = `stopped at block ${r.failed.block}: ${r.failed.error}`; break; }
        detail = w.to < safeBlock ? "backlog remains" : "caught up";
        if (w.to >= safeBlock) break;
      }
      result = { scanned: !failed, from: startCursor + 1, to: cursor, found, credited: counts.credited ?? 0, detail, counts };
      if (failed) await alert(env, "deposit_scan_stuck", `Deposit ${failed.tx}#${failed.logIndex} (${failed.amountUsdc} USDC from ${failed.from}) failed to credit; the cursor is held at ${cursor} and retries every scan.\n${failed.error}`, { dedupMinutes: 60, meta: { tx: failed.tx, log_index: failed.logIndex } });
      if (counts.unmatched) await alert(env, "deposit_unmatched", `${counts.unmatched} USDC deposit(s) from an unregistered wallet landed as 'unmatched'; match them to a tenant before replying to the sender.`, { dedupMinutes: 5, meta: { from: startCursor + 1, to: cursor } });
    }
  } catch (e) {
    const msg = redact(String(e)).slice(0, 300);
    result = { scanned: false, found: 0, credited: 0, detail: `deposit scan: ${msg}` };
    const range = e instanceof LogsUnavailableError && e.rangeErrors;
    await alert(env, range ? "deposit_scan_rpc_range" : "deposit_scan_failed", `USDC deposit scan failed; deposits are not being credited until it recovers.\n${msg}`, { dedupMinutes: 60 });
  }
  try {
    await client.from("loop_runs").insert({
      loop_name: "deposit_scan",
      outcome: !result.scanned ? "failure" : result.found ? "success" : "no_op",
      rows_written: result.credited,
      duration_ms: Date.now() - started,
      error: result.scanned ? null : result.detail,
      meta: { from: result.from ?? null, to: result.to ?? null, found: result.found, counts, provider, provider_errors: providerErrors.slice(0, 6) },
    });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", job: "deposit_scan_loop_run", error: redact(String(e)) }));
  }
  return result;
}

/**
 * USDC (Base) deposits -> credits, only for logs at or below the provider's `safe` tag.
 * Cursor lives in app_config. Money rule: a deposit is never skipped. Logs are handled in
 * chain order and the cursor only moves past blocks whose logs were ALL handled, so a failure
 * is retried on the next scan (credit_from_deposit is INSERT-first, replays return 'duplicate').
 * The scan runs on a subrequest budget (Workers Free: 50 per invocation, shared with the webhook drain on the 5-minute
 * cron). Its loop_runs row and the one alertMany() that carries every alert of the run are reserved before any work,
 * and each RPC reserves before it is sent, so the scan's own trace survives a backlog. Running out stops the scan
 * before the block it could not finish, like a failed credit does, without calling it one.
 * payment.credited (plan §16.4 P3 step 3): every deposit the run credited is announced to its tenant in one batch after
 * the scan (PAYMENT_EVENTS_COST = 3, whatever the number of credits), reserved together with the run's first credit, so
 * the budget never runs out between a credit and its event. The drain delivers them on the next 5-minute run.
 */
import { formatUnits } from "viem";
import type { Env, Config } from "../env";
import { db, rpc } from "../db/supabase";
import { baseLogsProviders, getBlock, hostOf, logsWindow, LogsUnavailableError, type LogsWindow, type RawLog } from "../ingest/base";
import { alertMany, type AlertItem } from "../ops/alerts";
import { PAYMENT_EVENTS_COST, queuePaymentsCredited, type CreditedDeposit } from "../billing/events";
import { BudgetExhausted, COST, type Budget } from "../ops/budget";
import { redact } from "../ops/redact";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (addr: string) => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const MAX_WINDOWS_PER_SCAN = 4;
/** Reserved before any work: the loop_runs row and the one alertMany() of the run. */
export const SCAN_RESERVE = COST.db + COST.alert;
/** The least a window needs to move the cursor: the safe header, one eth_getLogs and the cursor write. */
const WINDOW_MIN = 2 * COST.http + COST.db;
export const DEPOSIT_ALERT_DEDUP_MINUTES = 60;

export interface DepositLog { tx: string; logIndex: number; block: number; from: string; amountUsdc: string }
export type CreditFn = (d: DepositLog) => Promise<string>;
export interface ProcessResult {
  cursor: number; counts: Record<string, number>; failed: (DepositLog & { error: string }) | null;
  /** The log whose credit the subrequest budget could not cover (the credit threw BudgetExhausted). */
  stoppedAt: DepositLog | null;
}

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
 * On the first failure the returned cursor stops just before that log's block; so does running out of budget, which
 * is reported as stoppedAt, never as a failed credit.
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
      const cursor = Math.max(prevCursor, d.block - 1);
      if (e instanceof BudgetExhausted) return { cursor, counts, failed: null, stoppedAt: d };
      return { cursor, counts, failed: { ...d, error: redact(String(e)).slice(0, 300) }, stoppedAt: null };
    }
  }
  return { cursor: windowTo, counts, failed: null, stoppedAt: null };
}

export interface ScanResult {
  scanned: boolean; from?: number; to?: number; found: number; credited: number; detail: string; counts?: Record<string, number>;
  /** The budget ended the run with backlog left; the next scan continues from `to`. */
  stopped_by_budget: boolean;
  /** Subrequests reserved by the run: an upper bound on those it sent. */
  subrequests: number;
  alerts: string[];
}

/**
 * One scan. The scheduled run gets the 5-minute invocation's share (DEPOSIT_SCAN_SUBREQUESTS, src/jobs/schedule.ts);
 * POST /internal/deposits/scan, its own invocation, gets all of it. Never throws.
 */
export async function scanDeposits(env: Env, cfg: Config, budget: Budget): Promise<ScanResult> {
  const idle = { found: 0, credited: 0, stopped_by_budget: false, subrequests: 0, alerts: [] as string[] };
  if (!env.USDC_RECEIVING_ADDRESS) return { scanned: false, ...idle, detail: "USDC_RECEIVING_ADDRESS unset" };
  if (!budget.take(SCAN_RESERVE)) return { scanned: false, ...idle, detail: `a budget of ${budget.limit} subrequests cannot carry the scan's loop_runs row and alert (${SCAN_RESERVE})` };
  const started = Date.now();
  const client = db(env);
  const receiver = env.USDC_RECEIVING_ADDRESS.toLowerCase();
  const providers = baseLogsProviders(env);
  const filter = { address: cfg.usdcContract, topics: [TRANSFER, null, pad(receiver)] };
  const counts: Record<string, number> = {};
  const providerErrors: string[] = [];
  const items: AlertItem[] = [];
  const credited: CreditedDeposit[] = [];
  const eventProblems: string[] = [];
  let eventsReserved = false;
  let result: Omit<ScanResult, "subrequests" | "alerts">;
  let provider = "";
  let startCursor: number | null = null;
  let cursor = NaN;
  let found = 0;
  try {
    budget.need(COST.db, "the cursor read");
    const { data: cfgRow, error: cfgErr } = await client.from("app_config").select("value").eq("key", "usdc_cursor_block").maybeSingle();
    if (cfgErr) throw new Error(`app_config read: ${cfgErr.message}`);
    cursor = cfgRow ? Number(cfgRow.value) : NaN;
    if (!Number.isFinite(cursor)) {
      const first = providers[0];
      if (!first) throw new Error("no Base logs provider configured");
      budget.need(COST.http + COST.db, "initializing the cursor");
      const safe = await getBlock(first.url, "safe");
      const { error } = await client.from("app_config").upsert({ key: "usdc_cursor_block", value: String(safe.number) });
      if (error) throw new Error(`app_config init: ${error.message}`);
      result = { scanned: true, from: safe.number, to: safe.number, found: 0, credited: 0, detail: "cursor initialized at safe block; scanning forward from now", stopped_by_budget: false };
    } else {
      startCursor = cursor;
      let detail = "caught up", failed: ProcessResult["failed"] = null, stopped = false;
      const budgetStop = (why: string) => { stopped = true; detail = `subrequest budget reached${why}; backlog remains`; };
      for (let i = 0; i < MAX_WINDOWS_PER_SCAN; i++) {
        // The first window always runs: a scan that cannot read one is a failure (below), not a budget stop.
        if (i > 0 && budget.left < WINDOW_MIN) { budgetStop(""); break; }
        budget.need(COST.db, "the cursor write"); // released when the window does not move the cursor
        let w: LogsWindow;
        try {
          w = await logsWindow(providers, cursor, filter, 2000, budget);
        } catch (e) {
          if (i > 0 && e instanceof LogsUnavailableError && e.budgetExhausted) { providerErrors.push(...e.errors); budget.release(COST.db); budgetStop(""); break; }
          throw e;
        }
        provider = hostOf(w.provider);
        providerErrors.push(...w.errors);
        if (w.notModified) { budget.release(COST.db); detail = i === 0 ? "no new safe blocks" : "caught up"; break; }
        found += w.logs.length;
        const safeBlock = w.safe.number;
        const logs = w.logs.map(toDepositLog);
        const r = await processDeposits(logs, cursor, w.to, async (d) => {
          // The run's first credit also reserves the payment.credited batch (released after the scan if nothing credited).
          budget.need(COST.db + (eventsReserved ? 0 : PAYMENT_EVENTS_COST), `crediting ${d.tx}#${d.logIndex}`);
          eventsReserved = true;
          type Credit = { status: string; tenant_id?: string | null; credits?: number };
          const out = await rpc<Credit[] | Credit>(client, "credit_from_deposit", {
            p_tx_hash: d.tx, p_log_index: d.logIndex, p_from: d.from, p_to: receiver, p_amount_usdc: d.amountUsdc,
            p_block: d.block, p_safe_block: safeBlock, p_credits_per_usdc: cfg.creditsPerUsdc,
          });
          const row = Array.isArray(out) ? out[0] : out;
          if (!row?.status) throw new Error("credit_from_deposit returned no status");
          if (row.status === "credited") {
            // Never a throw: the credit is made, and a retry would only answer 'duplicate'.
            if (typeof row.tenant_id === "string" && Number.isInteger(row.credits)) credited.push({ tenant: row.tenant_id, tx: d.tx, logIndex: d.logIndex, amountUsdc: d.amountUsdc, credits: row.credits! });
            else eventProblems.push(`${d.tx}#${d.logIndex}: credit_from_deposit answered credited without its tenant and credits`);
          }
          return row.status;
        });
        for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
        if (r.cursor !== cursor) {
          const { error } = await client.from("app_config").upsert({ key: "usdc_cursor_block", value: String(r.cursor) });
          if (error) throw new Error(`cursor write: ${error.message}`);
          cursor = r.cursor;
        } else budget.release(COST.db);
        if (r.failed) { failed = r.failed; detail = `stopped at block ${r.failed.block}: ${r.failed.error}`; break; }
        if (r.stoppedAt) {
          const block = r.stoppedAt.block;
          budgetStop(` inside block ${block}`);
          // No progress at all means the scan's whole budget did not cover one block's credits; the next scan re-credits
          // the same logs (answered 'duplicate') and stops at the same place, so this needs a person.
          const inBlock = logs.filter((l) => l.block === block).length;
          if (cursor === startCursor) items.push({
            key: "deposit_scan_budget_stuck", dedupMinutes: DEPOSIT_ALERT_DEDUP_MINUTES, meta: { block, logs_in_block: inBlock, budget: budget.limit },
            text: `The USDC deposit scan ran out of its ${budget.limit} subrequests inside block ${block} (${inBlock} deposit logs there) and could not move its cursor past it. Credits already made are kept. If this repeats, the scan is stuck on that block and no later deposit is credited: POST /internal/deposits/scan runs one scan on a whole invocation's budget.`,
          });
          break;
        }
        detail = w.to < safeBlock ? "backlog remains" : "caught up";
        if (w.to >= safeBlock) break;
      }
      result = { scanned: !failed, from: startCursor + 1, to: cursor, found, credited: counts.credited ?? 0, detail, counts, stopped_by_budget: stopped };
      if (failed) items.push({ key: "deposit_scan_stuck", dedupMinutes: DEPOSIT_ALERT_DEDUP_MINUTES, meta: { tx: failed.tx, log_index: failed.logIndex }, text: `Deposit ${failed.tx}#${failed.logIndex} (${failed.amountUsdc} USDC from ${failed.from}) failed to credit; the cursor is held at ${cursor} and retries every scan.\n${failed.error}` });
    }
  } catch (e) {
    const msg = redact(String(e)).slice(0, 300);
    const moved = startCursor !== null && cursor !== startCursor;
    result = { scanned: false, ...(moved ? { from: startCursor! + 1, to: cursor } : {}), found, credited: counts.credited ?? 0, detail: `deposit scan: ${msg}`, counts, stopped_by_budget: false };
    const range = e instanceof LogsUnavailableError && e.rangeErrors;
    items.push({ key: range ? "deposit_scan_rpc_range" : "deposit_scan_failed", dedupMinutes: DEPOSIT_ALERT_DEDUP_MINUTES, text: `USDC deposit scan failed; deposits are not being credited until it recovers.\n${msg}` });
  }
  // On every path, a failed scan included: the credits made before a failure stand, so their tenants hear of them.
  let paymentEvents = 0;
  if (credited.length) {
    try {
      const q = await queuePaymentsCredited(env, credited);
      paymentEvents = q.queued;
      if (q.error) eventProblems.push(q.error);
    } catch (e) {
      eventProblems.push(redact(String(e)).slice(0, 200));
    }
  } else if (eventsReserved) budget.release(PAYMENT_EVENTS_COST);
  if (eventProblems.length) items.push({ key: "payment_event_failed", dedupMinutes: DEPOSIT_ALERT_DEDUP_MINUTES, meta: { deposits: credited.map((c) => `${c.tx}#${c.logIndex}`).slice(0, 20) }, text: `payment.credited was not queued for deposit(s) this scan credited (the credits stand; the tenants were not told): ${eventProblems.join("; ").slice(0, 600)}` });
  // On every path: an 'unmatched' credit from a window before a failure is behind the cursor and never seen again.
  if (counts.unmatched) items.push({ key: "deposit_unmatched", dedupMinutes: 5, meta: { from: result.from ?? null, to: result.to ?? null }, text: `${counts.unmatched} USDC deposit(s) from an unregistered wallet landed as 'unmatched'; credit each to the tenant that sent it with POST /internal/deposits/match {tx_hash, log_index, tenant_id, reason} (usdc_deposits where status = 'unmatched') before replying to the sender.` });
  let unrecorded: string | null = null;
  try {
    const { error } = await client.from("loop_runs").insert({
      loop_name: "deposit_scan",
      outcome: !result.scanned ? "failure" : result.found ? "success" : "no_op",
      rows_written: result.credited,
      duration_ms: Date.now() - started,
      error: result.scanned ? null : result.detail,
      meta: { from: result.from ?? null, to: result.to ?? null, found: result.found, counts, provider, provider_errors: providerErrors.slice(0, 6), stopped_by_budget: result.stopped_by_budget, subrequests: budget.used, payment_events_queued: paymentEvents },
    });
    if (error) unrecorded = redact(error.message).slice(0, 200);
  } catch (e) {
    unrecorded = redact(String(e)).slice(0, 200);
  }
  // The row is the scan's only trace for a person reading loop_runs; losing it rides on the alert reserved above.
  if (unrecorded) items.push({ key: "deposit_scan_unrecorded", dedupMinutes: DEPOSIT_ALERT_DEDUP_MINUTES, text: `The deposit scan's loop_runs row could not be written (${unrecorded}); the scan itself: ${result.detail}` });
  if (items.length) await alertMany(env, items);
  else budget.release(COST.alert);
  return { ...result, subrequests: budget.used, alerts: items.map((i) => i.key) };
}

/**
 * USDC (Base) deposits -> credits, only for transfers at or below the `safe` tag.
 * Sources (the result's detail and loop_runs meta.provider name the one that answered):
 *   alchemy_transfers  alchemy_getAssetTransfers on ALCHEMY_BASE_HTTP_URL, when it is set: the primary source. The public
 *                      Base RPCs refuse Cloudflare Worker egress (OBSERVED 2026-09-27 on every scan: mainnet.base.org
 *                      HTTP 429, base-rpc.publicnode.com HTTP 403) and Alchemy Free caps eth_getLogs at 10 blocks, but its
 *                      transfers API has no range cap. uniqueId "<tx>:log:<N>" carries the block-level logIndex
 *                      (VERIFIED 2026-09-27), so a transfer keys (tx_hash, log_index) exactly as its Transfer log does.
 *   eth_getLogs        the public providers (baseLogsProviders): without Alchemy, or when a transfers call fails (HTTP or
 *                      JSON-RPC error, timeout, a result that is not a page); the scan then continues from wherever the
 *                      transfers path left the cursor.
 * Cursor lives in app_config. Money rule: a deposit is never skipped. Deposits are handled in
 * chain order and the cursor only moves past blocks whose transfers were ALL handled, so a failure
 * is retried on the next scan (credit_from_deposit is INSERT-first, replays return 'duplicate').
 * A transfer the transfers API returns malformed (uniqueId not "<tx hash>:log:<N>", no raw amount, ...) is refused: the
 * cursor holds before its block and an alert names it. One that is positively not a deposit (another contract, another
 * recipient, not erc20) is skipped with an alert and never credited.
 * The scan runs on a subrequest budget (Workers Free: 50 per invocation, shared with the webhook drain on the 5-minute
 * cron). Its loop_runs row and the one alertMany() that carries every alert of the run are reserved before any work,
 * and each RPC reserves before it is sent, so the scan's own trace survives a backlog. Running out stops the scan
 * before the block it could not finish, like a failed credit does, without calling it one.
 * Transfers path cost: the safe header (1), one subrequest per page of up to 1,000 transfers (TRANSFER_PAGE_COST, over
 * any block range), one per deposit credited, and one cursor write for the whole path. Pagination stops when the budget
 * cannot carry another page, with the cursor at the last block fully handled.
 * payment.credited (plan §16.4 P3 step 3): every deposit the run credited is announced to its tenant in one batch after
 * the scan (PAYMENT_EVENTS_COST = 3, whatever the number of credits), reserved together with the run's first credit, so
 * the budget never runs out between a credit and its event. The drain delivers them on the next 5-minute run.
 */
import { formatUnits } from "viem";
import type { Env, Config } from "../env";
import { db, rpc } from "../db/supabase";
import {
  assetTransfersPage, baseCallUrl, baseLogsProviders, getBlock, hostOf, logsWindow, LogsUnavailableError,
  type AssetTransfer, type AssetTransfersPage, type BlockHeader, type LogsWindow, type RawLog,
} from "../ingest/base";
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
/** The transfers source's name in the result's detail and source, and in loop_runs meta.provider. */
export const TRANSFERS_SOURCE = "alchemy_transfers";
/** One page of alchemy_getAssetTransfers (up to 1,000 transfers, over any block range) is one subrequest. */
export const TRANSFER_PAGE_COST = COST.http;
/** The least the transfers path needs to move the cursor: the safe header, one page and the cursor write. */
export const TRANSFERS_MIN = COST.http + TRANSFER_PAGE_COST + COST.db;
/** Pages one scan follows at most (8,000 transfers); on the 5-minute share the budget stops it sooner. */
export const MAX_TRANSFER_PAGES_PER_SCAN = 8;

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

/** A transfer read from alchemy_getAssetTransfers: a deposit, positively not one (skip), or unreadable (refuse). */
export type TransferCheck =
  | { kind: "deposit"; deposit: DepositLog }
  | { kind: "skip"; block: number; ref: string; reason: string }
  /** block is null when the transfer names no block of the requested range: the caller then holds where it is. */
  | { kind: "refuse"; block: number | null; ref: string; reason: string };

const UNIQUE_ID = /^(0x[0-9a-f]{64}):log:(\d+)$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HEX_INT = /^0x[0-9a-f]+$/i;

/**
 * Maps one transfer to the DepositLog its USDC Transfer log gives (toDepositLog): tx = uniqueId's transaction hash
 * (equal to `hash`) lowercased, logIndex = uniqueId's N, from lowercased, amountUsdc = rawContract.value as the exact
 * 6-decimal integer (never the float `value`), block = blockNum. A transfer is skipped only when it says it is not a
 * deposit to `receiver` (another contract, another recipient, not erc20); a missing or malformed field is refused.
 */
export function checkTransfer(t: AssetTransfer, usdc: string, receiver: string, range: { from: number; to: number }): TransferCheck {
  const ref = (typeof t.uniqueId === "string" ? t.uniqueId : typeof t.hash === "string" ? t.hash : "(no uniqueId)").slice(0, 100);
  const bn = typeof t.blockNum === "string" && HEX_INT.test(t.blockNum) ? parseInt(t.blockNum, 16) : NaN;
  const block = Number.isSafeInteger(bn) && bn >= range.from && bn <= range.to ? bn : null;
  const refuse = (reason: string): TransferCheck => ({ kind: "refuse", block, ref, reason });
  if (block === null) return refuse(`blockNum ${String(t.blockNum).slice(0, 24)} is not a block of the range [${range.from}, ${range.to}]`);
  const skip = (reason: string): TransferCheck => ({ kind: "skip", block, ref, reason });
  const contract = t.rawContract?.address;
  if (typeof contract !== "string" || !ADDRESS.test(contract)) return refuse("rawContract.address is not an address");
  if (contract.toLowerCase() !== usdc.toLowerCase()) return skip(`contract ${contract.toLowerCase()} is not USDC`);
  if (typeof t.to !== "string" || !ADDRESS.test(t.to)) return refuse("to is not an address");
  if (t.to.toLowerCase() !== receiver.toLowerCase()) return skip(`to ${t.to.toLowerCase()} is not the receiving address`);
  if (typeof t.category !== "string") return refuse("category is missing");
  if (t.category !== "erc20") return skip(`category ${t.category.slice(0, 20)} is not erc20`);
  const id = typeof t.uniqueId === "string" ? UNIQUE_ID.exec(t.uniqueId) : null;
  if (!id) return refuse("uniqueId is not <tx hash>:log:<N>");
  const tx = id[1]!.toLowerCase();
  const logIndex = Number(id[2]);
  if (!Number.isSafeInteger(logIndex)) return refuse("uniqueId's log index is out of range");
  if (typeof t.hash !== "string" || t.hash.toLowerCase() !== tx) return refuse("hash differs from uniqueId's transaction hash");
  if (typeof t.from !== "string" || !ADDRESS.test(t.from)) return refuse("from is not an address");
  const raw = t.rawContract?.value;
  if (typeof raw !== "string" || !HEX_INT.test(raw)) return refuse("rawContract.value is not a hex integer");
  const decimal = t.rawContract?.decimal;
  if (decimal != null && !(typeof decimal === "string" && HEX_INT.test(decimal) && parseInt(decimal, 16) === 6)) return refuse(`rawContract.decimal ${String(decimal).slice(0, 10)} is not 6`);
  return { kind: "deposit", deposit: { tx, logIndex, block, from: t.from.toLowerCase(), amountUsdc: formatUnits(BigInt(raw), 6) } };
}

export interface ScanResult {
  scanned: boolean; from?: number; to?: number; found: number; credited: number; detail: string; counts?: Record<string, number>;
  /** The source that answered: "alchemy_transfers" or the eth_getLogs provider's host (detail names it too). */
  source?: string;
  /** The budget ended the run with backlog left; the next scan continues from `to`. */
  stopped_by_budget: boolean;
  /** Subrequests reserved by the run: an upper bound on those it sent. */
  subrequests: number;
  alerts: string[];
}

const clip = (e: unknown, n = 160) => redact(String(e)).slice(0, n);

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
  // With Alchemy configured baseCallUrl() is ALCHEMY_BASE_HTTP_URL: the safe header and the transfers come from one node.
  const transfersUrl = env.ALCHEMY_BASE_HTTP_URL ? baseCallUrl(env) : null;
  const filter = { address: cfg.usdcContract, topics: [TRANSFER, null, pad(receiver)] };
  const counts: Record<string, number> = {};
  const providerErrors: string[] = [];
  const items: AlertItem[] = [];
  const credited: CreditedDeposit[] = [];
  const eventProblems: string[] = [];
  const skipped: string[] = [];
  let eventsReserved = false;
  let result: Omit<ScanResult, "subrequests" | "alerts">;
  let source = "";
  let transfersError: string | null = null;
  let pages = 0;
  let startCursor: number | null = null;
  let cursor = NaN;
  let found = 0;

  /** credit_from_deposit for one deposit of either source, checked against the safe block that source read. */
  const creditAt = (safeBlock: number): CreditFn => async (d) => {
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
  };
  /** The caller has reserved its COST.db. */
  const writeCursor = async (to: number) => {
    const { error } = await client.from("app_config").upsert({ key: "usdc_cursor_block", value: String(to) });
    if (error) throw new Error(`cursor write: ${error.message}`);
    cursor = to;
  };
  // Counts are merged before the cursor write that follows them: a write that throws must not lose an 'unmatched'.
  const mergeCounts = (r: ProcessResult) => { for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v; };

  try {
    budget.need(COST.db, "the cursor read");
    const { data: cfgRow, error: cfgErr } = await client.from("app_config").select("value").eq("key", "usdc_cursor_block").maybeSingle();
    if (cfgErr) throw new Error(`app_config read: ${cfgErr.message}`);
    cursor = cfgRow ? Number(cfgRow.value) : NaN;
    if (!Number.isFinite(cursor)) {
      // The safe header from Alchemy when configured (the public providers refuse Worker egress), else the first provider.
      const heads = [...(transfersUrl ? [{ url: transfersUrl, name: TRANSFERS_SOURCE }] : []), ...providers.slice(0, 1).map((p) => ({ url: p.url, name: hostOf(p.url) }))];
      if (!heads.length) throw new Error("no Base logs provider configured");
      budget.need(COST.db, "initializing the cursor");
      let safe: BlockHeader | null = null;
      for (const head of heads) {
        budget.need(COST.http, `the safe header from ${head.name}`);
        try { safe = await getBlock(head.url, "safe"); source = head.name; break; } catch (e) { providerErrors.push(`${head.name}: ${clip(e)}`); }
      }
      if (!safe) throw new Error(`no safe header to initialize the cursor: ${providerErrors.join(" | ")}`);
      const { error } = await client.from("app_config").upsert({ key: "usdc_cursor_block", value: String(safe.number) });
      if (error) throw new Error(`app_config init: ${error.message}`);
      result = { scanned: true, from: safe.number, to: safe.number, found: 0, credited: 0, detail: `cursor initialized at safe block via ${source}; scanning forward from now`, source, stopped_by_budget: false };
    } else {
      const start = cursor;
      startCursor = start;
      // Declared with `as` so the checks after the loops see the closures' assignments.
      let detail = "caught up", failed = null as ProcessResult["failed"], held = false as boolean, stopped = false;
      const budgetStop = (why: string) => { stopped = true; detail = `subrequest budget reached${why}; backlog remains`; };
      /** After mergeCounts and the cursor write: true when the scan stops at this result (a failed credit, the budget). */
      const stopsAt = (r: ProcessResult, deposits: DepositLog[]): boolean => {
        if (r.failed) { failed = r.failed; detail = `stopped at block ${r.failed.block}: ${r.failed.error}`; return true; }
        if (!r.stoppedAt) return false;
        const block = r.stoppedAt.block;
        budgetStop(` inside block ${block}`);
        // No progress at all means the scan's whole budget did not cover one block's credits; the next scan re-credits
        // the same deposits (answered 'duplicate') and stops at the same place, so this needs a person.
        const inBlock = deposits.filter((l) => l.block === block).length;
        if (r.cursor === start) items.push({
          key: "deposit_scan_budget_stuck", dedupMinutes: DEPOSIT_ALERT_DEDUP_MINUTES, meta: { block, logs_in_block: inBlock, budget: budget.limit },
          text: `The USDC deposit scan ran out of its ${budget.limit} subrequests inside block ${block} (${inBlock} deposit logs there) and could not move its cursor past it. Credits already made are kept. If this repeats, the scan is stuck on that block and no later deposit is credited: POST /internal/deposits/scan runs one scan on a whole invocation's budget.`,
        });
        return true;
      };

      if (transfersUrl) {
        budget.need(COST.db, "the cursor write"); // one write for the whole transfers path, released if the cursor does not move
        let handled = cursor; // every transfer at or below this block is handled
        budget.need(COST.http, `the safe header from ${TRANSFERS_SOURCE}`);
        let safe: BlockHeader | null = null;
        try { safe = await getBlock(transfersUrl, "safe"); } catch (e) { transfersError = `safe header: ${clip(e)}`; }
        if (safe && safe.number <= cursor) detail = "no new safe blocks";
        else if (safe) {
          // One query over (cursor, safe], oldest first, continued by pageKey. toBlock must be a number ("safe" is refused).
          const range = { from: cursor + 1, to: safe.number };
          const credit = creditAt(safe.number);
          detail = "backlog remains"; // unless the last page is reached
          let pageKey: string | undefined;
          while (pages < MAX_TRANSFER_PAGES_PER_SCAN) {
            // The first page always runs: a scan that cannot read one is a failure, not a budget stop.
            if (pages > 0 && budget.left < TRANSFER_PAGE_COST) { budgetStop(""); break; }
            budget.need(TRANSFER_PAGE_COST, `page ${pages + 1} of ${TRANSFERS_SOURCE}`);
            let page: AssetTransfersPage;
            try {
              page = await assetTransfersPage(transfersUrl, { fromBlock: range.from, toBlock: range.to, toAddress: receiver, contract: cfg.usdcContract, ...(pageKey ? { pageKey } : {}) });
            } catch (e) { transfersError = `page ${pages + 1}: ${clip(e)}`; break; }
            pages++;
            found += page.transfers.length;
            const checks = page.transfers.map((t) => checkTransfer(t, cfg.usdcContract, receiver, range));
            // A refused transfer holds the cursor before its block (before the whole page when it names none): nothing at
            // or after that block is handled this scan.
            const refused = checks.flatMap((c) => (c.kind === "refuse" ? [c] : []));
            const holdAt = !refused.length ? Infinity : refused.some((c) => c.block === null) ? handled + 1 : Math.min(...refused.map((c) => c.block!));
            // The page's last block may go on in the next page: with a pageKey, the cursor stops just before that block.
            const blocks = checks.flatMap((c) => (c.kind === "deposit" ? [c.deposit.block] : c.block === null ? [] : [c.block]));
            const pageEnd = page.pageKey ? (blocks.length ? Math.max(...blocks) - 1 : handled) : range.to;
            const through = Math.max(handled, Math.min(pageEnd, holdAt - 1));
            for (const c of checks) if (c.kind === "skip" && c.block < holdAt) { counts.skipped = (counts.skipped ?? 0) + 1; skipped.push(`${c.ref}: ${c.reason}`); }
            if (refused.length) {
              counts.refused = (counts.refused ?? 0) + refused.length;
              items.push({
                key: "deposit_transfer_refused", dedupMinutes: DEPOSIT_ALERT_DEDUP_MINUTES, meta: { hold_block: holdAt, transfers: refused.slice(0, 10).map((c) => `${c.ref}: ${c.reason}`) },
                text: `The USDC deposit scan refused ${refused.length} transfer(s) that ${TRANSFERS_SOURCE} returned malformed, and holds its cursor before block ${holdAt}: no deposit at or after that block is credited until the transfers API returns them well-formed (every scan retries). Nothing was credited from them. ${refused.slice(0, 3).map((c) => `${c.ref}: ${c.reason}`).join("; ")}`,
              });
            }
            const deposits = checks.flatMap((c) => (c.kind === "deposit" && c.deposit.block < holdAt ? [c.deposit] : []));
            const r = await processDeposits(deposits, handled, through, credit);
            mergeCounts(r);
            handled = r.cursor;
            if (stopsAt(r, deposits)) break;
            if (refused.length) { held = true; detail = `held before block ${holdAt}: ${refused.length} malformed transfer(s) refused`; break; }
            if (!page.pageKey) { detail = "caught up"; break; }
            if (page.pageKey === pageKey) { transfersError = `page ${pages}: the same pageKey again`; break; }
            pageKey = page.pageKey;
          }
        }
        if (handled !== cursor) await writeCursor(handled);
        else budget.release(COST.db);
        if (transfersError) providerErrors.push(`${TRANSFERS_SOURCE}: ${transfersError}`);
        // It answered for the blocks it handled even when a later page failed; the logs path renames what it reads.
        if (!transfersError || cursor !== start) source = TRANSFERS_SOURCE;
      }

      // eth_getLogs: the source without Alchemy, the fallback when a transfers call failed (from where that path left off).
      if (!transfersUrl || transfersError) {
        for (let i = 0; i < MAX_WINDOWS_PER_SCAN; i++) {
          // The first window always runs: a scan that cannot read one is a failure (below), not a budget stop. A fallback
          // after the transfers path moved the cursor has read something, so there the budget ending is a budget stop.
          const read = i > 0 || cursor !== start;
          if (read && budget.left < WINDOW_MIN) { budgetStop(""); break; }
          budget.need(COST.db, "the cursor write"); // released when the window does not move the cursor
          let w: LogsWindow;
          try {
            w = await logsWindow(providers, cursor, filter, 2000, budget);
          } catch (e) {
            if (read && e instanceof LogsUnavailableError && e.budgetExhausted) { providerErrors.push(...e.errors); budget.release(COST.db); budgetStop(""); break; }
            throw e;
          }
          source = hostOf(w.provider);
          providerErrors.push(...w.errors);
          if (w.notModified) { budget.release(COST.db); detail = i === 0 ? "no new safe blocks" : "caught up"; break; }
          found += w.logs.length;
          const logs = w.logs.map(toDepositLog);
          const r = await processDeposits(logs, cursor, w.to, creditAt(w.safe.number));
          mergeCounts(r);
          if (r.cursor !== cursor) await writeCursor(r.cursor);
          else budget.release(COST.db);
          if (stopsAt(r, logs)) break;
          detail = w.to < w.safe.number ? "backlog remains" : "caught up";
          if (w.to >= w.safe.number) break;
        }
      }
      const fellBack = transfersError ? ` (${TRANSFERS_SOURCE} failed: ${transfersError})` : "";
      result = { scanned: !failed && !held, from: start + 1, to: cursor, found, credited: counts.credited ?? 0, detail: `${detail} via ${source}${fellBack}`, source, counts, stopped_by_budget: stopped };
      if (failed) items.push({ key: "deposit_scan_stuck", dedupMinutes: DEPOSIT_ALERT_DEDUP_MINUTES, meta: { tx: failed.tx, log_index: failed.logIndex }, text: `Deposit ${failed.tx}#${failed.logIndex} (${failed.amountUsdc} USDC from ${failed.from}) failed to credit; the cursor is held at ${cursor} and retries every scan.\n${failed.error}` });
    }
  } catch (e) {
    // Both sources failed (or the database did): name the transfers failure first when the logs fallback followed it.
    const prior = transfersError ? `${TRANSFERS_SOURCE} failed (${transfersError}), then ` : "";
    const msg = redact(prior + String(e)).slice(0, 300 + prior.length);
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
  // On every path, and for the same reason: a skipped transfer is behind the cursor once the scan moves past it.
  if (skipped.length) items.push({ key: "deposit_transfer_skipped", dedupMinutes: DEPOSIT_ALERT_DEDUP_MINUTES, meta: { transfers: skipped.slice(0, 10) }, text: `The USDC deposit scan skipped ${skipped.length} transfer(s) from ${TRANSFERS_SOURCE} that are not USDC deposits to the receiving address (never credited). The query asks for USDC to the receiving address only, so the transfers API answered outside its own filter; check them on a block explorer: ${skipped.slice(0, 3).join("; ")}` });
  let unrecorded: string | null = null;
  try {
    const { error } = await client.from("loop_runs").insert({
      loop_name: "deposit_scan",
      outcome: !result.scanned ? "failure" : result.found ? "success" : "no_op",
      rows_written: result.credited,
      duration_ms: Date.now() - started,
      error: result.scanned ? null : result.detail,
      meta: { from: result.from ?? null, to: result.to ?? null, found: result.found, counts, provider: source, provider_errors: providerErrors.slice(0, 6), stopped_by_budget: result.stopped_by_budget, subrequests: budget.used, payment_events_queued: paymentEvents, ...(transfersUrl ? { transfer_pages: pages } : {}) },
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

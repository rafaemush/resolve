import type { Env } from "../env";
import type { WatchRow, FetchOutcome } from "./types";

interface RpcOk<T> { result: T }
interface RpcErr { error: { code: number; message: string } }

/** Single-block calls (headers by number, eth_getCode, eth_call): Alchemy when configured. */
export function baseCallUrl(env: Env): string { return env.ALCHEMY_BASE_HTTP_URL || env.BASE_FALLBACK_HTTP_URL || "https://mainnet.base.org"; }
/** @deprecated kept for registration-time callers; identical to baseCallUrl. Never use it for eth_getLogs. */
export const baseRpcUrl = baseCallUrl;

export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "ResolveBot/1.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`rpc ${method} HTTP ${res.status}`);
  const j = (await res.json()) as RpcOk<T> | RpcErr;
  if ("error" in j) throw new Error(`rpc ${method}: ${j.error.code} ${j.error.message}`);
  return j.result;
}

const hex = (n: number) => "0x" + n.toString(16);
const num = (h: string) => parseInt(h, 16);
export const hostOf = (url: string) => { try { return new URL(url).host; } catch { return "invalid-url"; } };

export interface BlockHeader { number: number; timestamp: string }
export async function getBlock(url: string, tag: string | number): Promise<BlockHeader> {
  const b = await rpc<{ number: string; timestamp: string }>(url, "eth_getBlockByNumber", [typeof tag === "number" ? hex(tag) : tag, false]);
  return { number: num(b.number), timestamp: new Date(num(b.timestamp) * 1000).toISOString() };
}

/** Binary-search the first block whose timestamp >= target. ~25 RPC calls; registration-time only. */
export async function blockAtOrAfter(url: string, targetIso: string, safe: BlockHeader): Promise<number> {
  const target = Date.parse(targetIso) / 1000;
  let lo = 0, hi = safe.number;
  if (Date.parse(safe.timestamp) / 1000 < target) return safe.number + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await getBlock(url, mid);
    if (Date.parse(b.timestamp) / 1000 >= target) hi = mid; else lo = mid + 1;
  }
  return lo;
}

export async function hasCode(url: string, address: string): Promise<boolean> {
  const code = await rpc<string>(url, "eth_getCode", [address, "safe"]);
  return typeof code === "string" && code !== "0x";
}

export interface RawLog { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }

// ---- eth_getLogs providers ---------------------------------------------------
// Alchemy Free caps eth_getLogs at a 10-block range on Base (probed 2026-09-24: 11 and
// 2,000 blocks -> -32600), so logs always go to public providers. mainnet.base.org
// accepts 2,000-block ranges (10,000 -> -32614); base-rpc.publicnode.com serves recent blocks
// only (historical ranges need a personal token, MEASURED 2026-09-24), so it is a near-head fallback.
export interface LogsProvider { url: string; maxRange: number }
export const DEFAULT_LOGS_PROVIDERS: LogsProvider[] = [
  { url: "https://mainnet.base.org", maxRange: 2000 },
  { url: "https://base-rpc.publicnode.com", maxRange: 2000 },
];

export function baseLogsProviders(env: Pick<Env, "BASE_LOGS_HTTP_URL">): LogsProvider[] {
  const out: LogsProvider[] = [];
  const seen = new Set<string>();
  const add = (p: LogsProvider) => {
    if (!p.url || seen.has(p.url) || /alchemy\.com/i.test(p.url)) return;
    seen.add(p.url);
    out.push(p);
  };
  if (env.BASE_LOGS_HTTP_URL) add({ url: env.BASE_LOGS_HTTP_URL, maxRange: 2000 });
  for (const p of DEFAULT_LOGS_PROVIDERS) add(p);
  return out;
}

const RANGE_ERROR = /block range|range (is )?too (large|wide|big)|limited to a [\d,]+ range|up to a [\d,]+ block range|more than [\d,]+ (results|logs)|query returned more than|exceed(s|ed)? (the )?max(imum)?|response (size|is too large)|HTTP 413/i;
export const isRangeError = (e: unknown): boolean => RANGE_ERROR.test(String(e));

export interface LogsWindow { provider: string; safe: BlockHeader; from: number; to: number; logs: RawLog[]; notModified: boolean; errors: string[] }

export class LogsUnavailableError extends Error {
  constructor(public readonly errors: string[]) { super(`no Base logs provider answered: ${errors.join(" | ").slice(0, 400)}`); }
  get rangeErrors(): boolean { return this.errors.some((e) => isRangeError(e)); }
}

/**
 * Logs for (fromBlock, min(safe, fromBlock + chunk)] read from ONE provider whose own
 * `safe` header bounds the range, so a lagging node can never answer "no logs" for blocks
 * it has not reached. A range error halves the window on that provider (at most 3 times);
 * any other error moves to the next provider. Throws LogsUnavailableError when all fail.
 * The caller must advance its cursor to the returned `to`, never to its own estimate.
 */
export async function logsWindow(
  providers: LogsProvider[], fromBlock: number,
  filter: { address: string; topics?: Array<string | null> }, chunk = 2000,
): Promise<LogsWindow> {
  const errors: string[] = [];
  for (const p of providers) {
    try {
      const safe = await getBlock(p.url, "safe");
      if (safe.number <= fromBlock) return { provider: p.url, safe, from: fromBlock + 1, to: fromBlock, logs: [], notModified: true, errors };
      let span = Math.max(1, Math.min(chunk, p.maxRange));
      for (let attempt = 0; ; attempt++) {
        const to = Math.min(safe.number, fromBlock + span);
        try {
          const logs = await rpc<RawLog[]>(p.url, "eth_getLogs", [{ ...filter, fromBlock: hex(fromBlock + 1), toBlock: hex(to) }]);
          if (!Array.isArray(logs)) throw new Error("eth_getLogs returned a non-array result");
          return { provider: p.url, safe, from: fromBlock + 1, to, logs, notModified: false, errors };
        } catch (e) {
          if (isRangeError(e) && attempt < 3 && span > 1) {
            errors.push(`${hostOf(p.url)} range ${span}: ${String(e).slice(0, 120)}`);
            span = Math.max(1, Math.floor(span / 2));
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      errors.push(`${hostOf(p.url)}: ${String(e).slice(0, 160)}`);
    }
  }
  throw new LogsUnavailableError(errors);
}

/**
 * Poll logs for the watched address over (cursor.block, min(safe, cursor.block + chunk)].
 * The cursor advances only to the window actually read; a window that does not reach `safe` marks backlog.
 */
export async function fetchBaseLogs(env: Env, watch: WatchRow, chunk = 2000): Promise<FetchOutcome> {
  const callUrl = baseCallUrl(env);
  const address = String(watch.source_ref.address ?? "").toLowerCase();
  const topic0 = watch.source_ref.topic0 ? String(watch.source_ref.topic0).toLowerCase() : null;
  if (!/^0x[0-9a-f]{40}$/.test(address)) return { error: "source_ref.address invalid" };
  const t0 = new Date().toISOString();
  try {
    const fromBlock = Number(watch.cursor.block ?? NaN);
    if (!Number.isFinite(fromBlock)) return { error: "cursor.block missing (set at registration)" };
    const w = await logsWindow(baseLogsProviders(env), fromBlock, { address, ...(topic0 ? { topics: [topic0] } : {}) }, chunk);
    if (w.errors.length) console.warn(JSON.stringify({ level: "warn", job: "base_logs", watch_id: watch.id, errors: w.errors }));
    if (w.notModified) {
      return { notModified: true, window: { from: String(watch.cursor.to_ts ?? w.safe.timestamp), to: w.safe.timestamp, status: "ok" }, cursor: { ...watch.cursor, safe_block: w.safe.number, to_ts: w.safe.timestamp } };
    }
    const header = (n: number) => getBlock(callUrl, n).catch(() => getBlock(w.provider, n));
    const toHeader = w.to === w.safe.number ? w.safe : await header(w.to);
    let has_code = watch.cursor.has_code as boolean | undefined;
    if (has_code === undefined) has_code = await hasCode(callUrl, address).catch(() => hasCode(w.provider, address));
    const decorated = [] as Array<Record<string, unknown>>;
    const headerCache = new Map<number, string>([[w.safe.number, w.safe.timestamp], [w.to, toHeader.timestamp]]);
    for (const l of w.logs.slice(0, 50)) {
      const bn = num(l.blockNumber);
      let ts = headerCache.get(bn);
      if (!ts) { ts = (await header(bn)).timestamp; headerCache.set(bn, ts); }
      decorated.push({ address: l.address.toLowerCase(), topics: l.topics.map((t) => t.toLowerCase()), data: l.data, block_number: bn, tx_hash: l.transactionHash, log_index: num(l.logIndex), timestamp: ts });
    }
    const backlog = w.to < w.safe.number;
    const structured = { chain: "base", address, topic0, from_block: w.from, to_block: w.to, safe_block: w.safe.number, logs: decorated, has_code };
    const text = JSON.stringify(structured);
    const fromTs = String(watch.cursor.to_ts ?? watch.cursor.from_ts ?? toHeader.timestamp);
    return {
      evidence: { source_kind: "base_log", text, structured, observed_at: toHeader.timestamp, fetched_at: t0, coverage: { has_code, safe_block: w.safe.number, backlog }, provenance: { chain: "base", address, from_block: w.from, to_block: w.to, safe_block: w.safe.number, rpc_logs: hostOf(w.provider), rpc_calls: hostOf(callUrl), ...(w.errors.length ? { rpc_errors: w.errors } : {}) } },
      rawBytes: new TextEncoder().encode(text),
      window: { from: fromTs, to: toHeader.timestamp, status: "ok" },
      cursor: { ...watch.cursor, block: w.to, to_ts: toHeader.timestamp, safe_block: w.safe.number, has_code },
      backlog,
    };
  } catch (e) {
    return { error: `base rpc: ${String(e).slice(0, 200)}` };
  }
}

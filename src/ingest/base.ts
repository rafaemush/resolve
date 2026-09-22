import type { Env } from "../env";
import type { WatchRow, FetchOutcome } from "./types";

interface RpcOk<T> { result: T }
interface RpcErr { error: { code: number; message: string } }

export function baseRpcUrl(env: Env): string { return env.ALCHEMY_BASE_HTTP_URL || env.BASE_FALLBACK_HTTP_URL || "https://mainnet.base.org"; }

export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`rpc ${method} HTTP ${res.status}`);
  const j = (await res.json()) as RpcOk<T> | RpcErr;
  if ("error" in j) throw new Error(`rpc ${method}: ${j.error.code} ${j.error.message}`);
  return j.result;
}

const hex = (n: number) => "0x" + n.toString(16);
const num = (h: string) => parseInt(h, 16);

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

/**
 * Poll logs for the watched address over [cursor.block+1, min(safe, cursor.block+CHUNK)] at the `safe` tag.
 * The cursor advances only when the chunk succeeded; a chunk that does not reach `safe` marks backlog.
 */
export async function fetchBaseLogs(env: Env, watch: WatchRow, chunk = 2000): Promise<FetchOutcome> {
  const url = baseRpcUrl(env);
  const address = String(watch.source_ref.address ?? "").toLowerCase();
  const topic0 = watch.source_ref.topic0 ? String(watch.source_ref.topic0).toLowerCase() : null;
  if (!/^0x[0-9a-f]{40}$/.test(address)) return { error: "source_ref.address invalid" };
  const t0 = new Date().toISOString();
  try {
    const safe = await getBlock(url, "safe");
    const fromBlock = Number(watch.cursor.block ?? NaN);
    if (!Number.isFinite(fromBlock)) return { error: "cursor.block missing (set at registration)" };
    if (safe.number <= fromBlock) {
      return { notModified: true, window: { from: String(watch.cursor.to_ts ?? safe.timestamp), to: safe.timestamp, status: "ok" }, cursor: { ...watch.cursor, safe_block: safe.number, to_ts: safe.timestamp } };
    }
    const to = Math.min(safe.number, fromBlock + chunk);
    const logs = await rpc<RawLog[]>(url, "eth_getLogs", [{ address, fromBlock: hex(fromBlock + 1), toBlock: hex(to), ...(topic0 ? { topics: [topic0] } : {}) }]);
    const toHeader = to === safe.number ? safe : await getBlock(url, to);
    let has_code = watch.cursor.has_code as boolean | undefined;
    if (has_code === undefined) has_code = await hasCode(url, address);
    const decorated = [] as Array<Record<string, unknown>>;
    const headerCache = new Map<number, string>([[safe.number, safe.timestamp], [to, toHeader.timestamp]]);
    for (const l of logs.slice(0, 50)) {
      const bn = num(l.blockNumber);
      let ts = headerCache.get(bn);
      if (!ts) { ts = (await getBlock(url, bn)).timestamp; headerCache.set(bn, ts); }
      decorated.push({ address: l.address.toLowerCase(), topics: l.topics.map((t) => t.toLowerCase()), data: l.data, block_number: bn, tx_hash: l.transactionHash, log_index: num(l.logIndex), timestamp: ts });
    }
    const backlog = to < safe.number;
    const structured = { chain: "base", address, topic0, from_block: fromBlock + 1, to_block: to, safe_block: safe.number, logs: decorated, has_code };
    const text = JSON.stringify(structured);
    const fromTs = String(watch.cursor.to_ts ?? watch.cursor.from_ts ?? toHeader.timestamp);
    return {
      evidence: { source_kind: "base_log", text, structured, observed_at: toHeader.timestamp, fetched_at: t0, coverage: { has_code, safe_block: safe.number, backlog }, provenance: { chain: "base", address, from_block: fromBlock + 1, to_block: to, safe_block: safe.number, rpc: url.includes("alchemy") ? "alchemy" : "public" } },
      rawBytes: new TextEncoder().encode(text),
      window: { from: fromTs, to: toHeader.timestamp, status: "ok" },
      cursor: { ...watch.cursor, block: to, to_ts: toHeader.timestamp, safe_block: safe.number, has_code },
      backlog,
    };
  } catch (e) {
    return { error: `base rpc: ${String(e).slice(0, 160)}` };
  }
}

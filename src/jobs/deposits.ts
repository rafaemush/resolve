/** USDC (Base) deposits -> credits, only for logs at or below the `safe` tag. Cursor lives in app_config. */
import type { Env, Config } from "../env";
import { db, rpc } from "../db/supabase";
import { baseRpcUrl, getBlock, rpc as ethRpc, type RawLog } from "../ingest/base";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (addr: string) => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

export async function scanDeposits(env: Env, cfg: Config): Promise<{ scanned: boolean; from?: number; to?: number; found: number; credited: number; detail: string }> {
  if (!env.USDC_RECEIVING_ADDRESS) return { scanned: false, found: 0, credited: 0, detail: "USDC_RECEIVING_ADDRESS unset" };
  const client = db(env);
  const url = baseRpcUrl(env);
  const to = env.USDC_RECEIVING_ADDRESS.toLowerCase();
  try {
    const safe = await getBlock(url, "safe");
    const { data: cfgRow } = await client.from("app_config").select("value").eq("key", "usdc_cursor_block").maybeSingle();
    let cursor = cfgRow ? Number(cfgRow.value) : NaN;
    if (!Number.isFinite(cursor)) { cursor = safe.number; await client.from("app_config").upsert({ key: "usdc_cursor_block", value: String(cursor) }); return { scanned: true, from: cursor, to: cursor, found: 0, credited: 0, detail: "cursor initialized at safe block; scanning forward from now" }; }
    if (safe.number <= cursor) return { scanned: true, from: cursor, to: safe.number, found: 0, credited: 0, detail: "no new safe blocks" };
    const end = Math.min(safe.number, cursor + 2000);
    const logs = await ethRpc<RawLog[]>(url, "eth_getLogs", [{ address: cfg.usdcContract, fromBlock: "0x" + (cursor + 1).toString(16), toBlock: "0x" + end.toString(16), topics: [TRANSFER, null, pad(to)] }]);
    let credited = 0;
    for (const l of logs) {
      const from = "0x" + (l.topics[1] ?? "").slice(-40);
      const amount = Number(BigInt(l.data)) / 1e6;
      const r = await rpc<Array<{ status: string; credits: number }> | { status: string; credits: number }>(client, "credit_from_deposit", { p_tx_hash: l.transactionHash, p_log_index: parseInt(l.logIndex, 16), p_from: from, p_to: to, p_amount_usdc: amount, p_block: parseInt(l.blockNumber, 16), p_safe_block: safe.number, p_credits_per_usdc: cfg.creditsPerUsdc });
      const row = Array.isArray(r) ? r[0] : r;
      if (row?.status === "credited") credited++;
    }
    await client.from("app_config").upsert({ key: "usdc_cursor_block", value: String(end) });
    return { scanned: true, from: cursor + 1, to: end, found: logs.length, credited, detail: end < safe.number ? "backlog remains" : "caught up" };
  } catch (e) { return { scanned: false, found: 0, credited: 0, detail: `deposit scan: ${String(e).slice(0, 160)}` }; }
}

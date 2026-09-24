/**
 * The USDC deposit scan on its subrequest budget (plan §16.4 P0 steps 2 and 7): every Base RPC, database call and alert
 * of one scan is counted against the 5-minute invocation's share (DEPOSIT_SCAN_SUBREQUESTS). Before, the scan took no
 * budget, so a catch-up backlog or a run of range errors spent the invocation's 50 and its own alerts and loop_runs row
 * were the calls that failed. Money rule throughout: a deposit is never skipped, whatever the budget cuts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Env } from "../src/env";
import type { RawLog } from "../src/ingest/base";
import { fakeDb, type FakeDb } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", () => ({
  db: () => h.db.client,
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/ops/alerts", () => ({ alertMany: vi.fn(async () => ({ sent: [], deduped: [] })) }));

import { scanDeposits } from "../src/jobs/deposits";
import { DEPOSIT_SCAN_SUBREQUESTS } from "../src/jobs/schedule";
import { alertMany } from "../src/ops/alerts";
import { Budget, COST, INVOCATION_SUBREQUESTS } from "../src/ops/budget";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RECEIVER = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const hex = (n: number | bigint) => "0x" + n.toString(16);
const topic = (addr: string) => "0x" + addr.replace(/^0x/, "").padStart(64, "0");
const env = { USDC_RECEIVING_ADDRESS: RECEIVER } as unknown as Env;
const cfg = { usdcContract: USDC, creditsPerUsdc: 1000 } as Config;

/** A USDC Transfer to the receiver; `from` 0x...bad lands as 'unmatched'. */
function deposit(block: number, logIndex: number, from = "0x00000000000000000000000000000000000000f1"): RawLog {
  return { address: USDC, topics: [TRANSFER, topic(from), topic(RECEIVER)], data: hex(2_500_000n), blockNumber: hex(block), transactionHash: `0x${block.toString(16)}${logIndex.toString(16).padStart(4, "0")}`, logIndex: hex(logIndex) };
}

interface Chain { safe: number; logs: RawLog[]; rangeError?: boolean; down?: (call: number) => boolean }
let chain: Chain;
let rpcCalls: string[];
let credits: Map<string, number>;

beforeEach(() => {
  rpcCalls = []; credits = new Map();
  vi.mocked(alertMany).mockClear();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { method: string; params: Array<{ fromBlock: string; toBlock: string }> };
    rpcCalls.push(`${new URL(url).host} ${body.method}`);
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    const refuse = (message: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message } }));
    if (chain.down?.(rpcCalls.length)) return refuse("rate limited");
    if (body.method === "eth_getBlockByNumber") return reply({ number: hex(chain.safe), timestamp: hex(1_700_000_000) });
    if (chain.rangeError) return refuse("block range too large");
    const { fromBlock, toBlock } = body.params[0]!;
    return reply(chain.logs.filter((l) => parseInt(l.blockNumber, 16) >= parseInt(fromBlock, 16) && parseInt(l.blockNumber, 16) <= parseInt(toBlock, 16)));
  });
});
afterEach(() => vi.unstubAllGlobals());

function newDb(cursor: number) {
  h.db = fakeDb({ app_config: [{ key: "usdc_cursor_block", value: String(cursor) }], loop_runs: [] }, {}, {
    primaryKey: { app_config: "key" },
    rpc: {
      // INSERT-first like the real credit_from_deposit: a replay answers 'duplicate'.
      credit_from_deposit: async (_db, a) => {
        const k = `${a.p_tx_hash}#${a.p_log_index}`;
        const n = (credits.get(k) ?? 0) + 1;
        credits.set(k, n);
        return { data: [{ status: n > 1 ? "duplicate" : a.p_from.endsWith("bad") ? "unmatched" : "credited" }], error: null };
      },
    },
  });
}
const cursorNow = () => Number(h.db.tables.app_config!.find((r) => r.key === "usdc_cursor_block")!.value);
const alertKeys = () => vi.mocked(alertMany).mock.calls.flatMap((c) => c[1]!.map((i) => i.key));

/** One scan; returns what it really sent: Base RPCs + database calls (an rpc counts once) + COST.alert per alertMany(). */
async function scan(budget = new Budget(DEPOSIT_SCAN_SUBREQUESTS)) {
  rpcCalls = []; h.db.calls.length = 0; vi.mocked(alertMany).mockClear();
  const r = await scanDeposits(env, cfg, budget);
  const used = rpcCalls.length + h.db.calls.length + vi.mocked(alertMany).mock.calls.length * COST.alert;
  return { r, used };
}

describe("scanDeposits on the 5-minute invocation's budget", () => {
  it("a catch-up backlog with deposits stays inside the budget every scan, and every deposit is credited once", async () => {
    const logs = [
      deposit(1_500, 0), deposit(1_500, 1), deposit(2_800, 0), deposit(2_800, 1), deposit(2_800, 2), deposit(2_900, 0, "0x0000000000000000000000000000000000000bad"),
      deposit(4_200, 0), deposit(7_000, 0), deposit(7_000, 3), deposit(9_000, 0), deposit(9_999, 5),
    ];
    chain = { safe: 10_000, logs };
    newDb(1_000);
    const first = await scan();
    expect(first.used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(first.r.subrequests).toBeGreaterThanOrEqual(first.used); // reservations bound what was sent
    expect(first.r).toMatchObject({ scanned: true, stopped_by_budget: true });
    expect(first.r.detail).toContain("subrequest budget reached");
    expect(h.db.tables.loop_runs).toHaveLength(1); // its trace survived the backlog

    const raised = [...first.r.alerts];
    let scans = 1;
    for (let last = first.r; last.detail !== "caught up" && scans < 20; scans++) {
      const s = await scan();
      expect(s.used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
      expect(s.r.scanned).toBe(true);
      raised.push(...s.r.alerts);
      last = s.r;
    }
    expect(cursorNow()).toBe(10_000);
    expect(h.db.tables.loop_runs).toHaveLength(scans);
    // Never skipped: each deposit reached credit_from_deposit; a cut inside a block only replays as 'duplicate'.
    expect(new Set(credits.keys()).size).toBe(logs.length);
    expect(raised).toEqual(["deposit_unmatched"]);
  });

  it("range errors on every provider: one failure alert and the loop_runs row, inside the budget", async () => {
    chain = { safe: 50_000, logs: [], rangeError: true };
    newDb(1_000);
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(rpcCalls).toHaveLength(10); // 2 providers x (safe header + eth_getLogs halved three times)
    expect(r.scanned).toBe(false);
    expect(alertKeys()).toEqual(["deposit_scan_rpc_range"]);
    expect(h.db.tables.loop_runs!.map((l) => l.outcome)).toEqual(["failure"]);
    expect(cursorNow()).toBe(1_000);
  });

  it("a third logs provider the budget cannot reach: 'could not look' is a failure, alerted, not an empty window", async () => {
    chain = { safe: 50_000, logs: [], rangeError: true };
    newDb(1_000);
    rpcCalls = []; h.db.calls.length = 0; vi.mocked(alertMany).mockClear();
    const r = await scanDeposits({ ...env, BASE_LOGS_HTTP_URL: "https://base.example" } as Env, cfg, new Budget(DEPOSIT_SCAN_SUBREQUESTS));
    const used = rpcCalls.length + h.db.calls.length + vi.mocked(alertMany).mock.calls.length * COST.alert;
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(r.scanned).toBe(false);
    expect(r.detail).toContain("subrequest budget ran out before a Base logs provider answered");
    expect(alertKeys()).toEqual(["deposit_scan_rpc_range"]);
    expect(h.db.tables.loop_runs!.map((l) => l.outcome)).toEqual(["failure"]);
  });

  it("an 'unmatched' credit before a failing window is still alerted (the cursor already moved past it)", async () => {
    chain = { safe: 10_000, logs: [deposit(1_500, 0, "0x0000000000000000000000000000000000000bad")], down: (call) => call > 2 };
    newDb(1_000);
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(r).toMatchObject({ scanned: false, from: 1_001, to: 3_000 });
    expect(alertKeys().sort()).toEqual(["deposit_scan_failed", "deposit_unmatched"]);
  });

  it("a block with more deposits than one scan can credit alerts instead of looping silently; a whole invocation passes it", async () => {
    const logs = Array.from({ length: 14 }, (_, i) => deposit(1_001, i));
    chain = { safe: 1_500, logs };
    newDb(1_000);
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(r).toMatchObject({ scanned: true, stopped_by_budget: true, to: 1_000 });
    expect(alertKeys()).toEqual(["deposit_scan_budget_stuck"]);
    expect(cursorNow()).toBe(1_000);

    // POST /internal/deposits/scan: its own invocation, the whole budget.
    const manual = await scan(new Budget(INVOCATION_SUBREQUESTS));
    expect(manual.used).toBeLessThanOrEqual(INVOCATION_SUBREQUESTS);
    expect(manual.r).toMatchObject({ scanned: true, stopped_by_budget: false, detail: "caught up" });
    expect(cursorNow()).toBe(1_500);
    expect(credits.size).toBe(14);
  });

  it("a healthy scan with nothing new spends only what it needs and releases the alert reserve", async () => {
    chain = { safe: 1_000, logs: [] };
    newDb(1_000);
    const { r, used } = await scan();
    expect(r).toMatchObject({ scanned: true, detail: "no new safe blocks", alerts: [] });
    expect(used).toBe(3); // cursor read, safe header, loop_runs row
    expect(r.subrequests).toBe(3);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { baseLogsProviders, isRangeError, logsWindow, LogsUnavailableError, type LogsProvider } from "../src/ingest/base";
import { processDeposits, toDepositLog, type DepositLog } from "../src/jobs/deposits";
import { redact } from "../src/ops/redact";

type Handler = (url: string, method: string, params: unknown[]) => unknown;
function stubRpc(handler: Handler) {
  const calls: Array<{ url: string; method: string; params: unknown[] }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    calls.push({ url, method: body.method, params: body.params });
    try {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: handler(url, body.method, body.params) }));
    } catch (e) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: (e as Error).message } }));
    }
  });
  return calls;
}
const header = (n: number) => ({ number: "0x" + n.toString(16), timestamp: "0x" + (1_700_000_000 + n * 2).toString(16) });
const A: LogsProvider = { url: "https://a.example", maxRange: 2000 };
const B: LogsProvider = { url: "https://b.example", maxRange: 2000 };

afterEach(() => vi.unstubAllGlobals());

describe("baseLogsProviders", () => {
  it("never routes eth_getLogs to Alchemy, even when configured as the logs URL", () => {
    const p = baseLogsProviders({ BASE_LOGS_HTTP_URL: "https://base-mainnet.g.alchemy.com/v2/KEY" });
    expect(p.map((x) => x.url)).toEqual(["https://mainnet.base.org", "https://base-rpc.publicnode.com"]);
  });
  it("puts a configured public provider first and de-duplicates", () => {
    const p = baseLogsProviders({ BASE_LOGS_HTTP_URL: "https://base-rpc.publicnode.com" });
    expect(p.map((x) => x.url)).toEqual(["https://base-rpc.publicnode.com", "https://mainnet.base.org"]);
  });
});

describe("logsWindow", () => {
  it("bounds the window by the SAME provider's safe block and returns the window actually read", async () => {
    const calls = stubRpc((_u, m, params) => {
      if (m === "eth_getBlockByNumber") return header(1_000);
      if (m === "eth_getLogs") return [];
      throw new Error("unexpected " + m + JSON.stringify(params));
    });
    const w = await logsWindow([A], 100, { address: "0xabc" });
    expect(w.to).toBe(1_000);
    expect(w.from).toBe(101);
    expect(calls.every((c) => c.url === A.url)).toBe(true);
    const gl = calls.find((c) => c.method === "eth_getLogs")!;
    expect(gl.params[0]).toMatchObject({ fromBlock: "0x65", toBlock: "0x3e8" });
  });
  it("halves the span on a range error instead of failing (Alchemy-style -32600)", async () => {
    const spans: number[] = [];
    stubRpc((_u, m, params) => {
      if (m === "eth_getBlockByNumber") return header(50_000);
      const p = params[0] as { fromBlock: string; toBlock: string };
      const span = parseInt(p.toBlock, 16) - parseInt(p.fromBlock, 16) + 1;
      spans.push(span);
      if (span > 600) throw new Error("You can make eth_getLogs requests with up to a 500 block range");
      return [];
    });
    const w = await logsWindow([A], 10_000, { address: "0xabc" });
    expect(spans).toEqual([2000, 1000, 500]);
    expect(w.to).toBe(10_500);
    expect(w.errors.length).toBe(2);
  });
  it("moves to the next provider on a non-range failure", async () => {
    stubRpc((u, m) => {
      if (u === A.url) throw new Error("rate limited");
      if (m === "eth_getBlockByNumber") return header(300);
      return [{ address: "0xabc", topics: [], data: "0x", blockNumber: "0x96", transactionHash: "0x1", logIndex: "0x0" }];
    });
    const w = await logsWindow([A, B], 100, { address: "0xabc" });
    expect(w.provider).toBe(B.url);
    expect(w.logs).toHaveLength(1);
    expect(w.errors[0]).toContain("a.example");
  });
  it("reports notModified when the provider's safe block is not past the cursor", async () => {
    stubRpc(() => header(100));
    const w = await logsWindow([A], 100, { address: "0xabc" });
    expect(w.notModified).toBe(true);
    expect(w.logs).toEqual([]);
  });
  it("throws LogsUnavailableError (flagged as range) when every provider rejects the range", async () => {
    stubRpc((_u, m) => { if (m === "eth_getBlockByNumber") return header(9_000); throw new Error("block range too large"); });
    const err = await logsWindow([A, B], 100, { address: "0xabc" }).catch((e) => e);
    expect(err).toBeInstanceOf(LogsUnavailableError);
    expect((err as LogsUnavailableError).rangeErrors).toBe(true);
  });
  it("classifies range errors from the providers we probed", () => {
    expect(isRangeError("rpc eth_getLogs: -32600 You can make eth_getLogs requests with up to a 10 block range")).toBe(true);
    expect(isRangeError("rpc eth_getLogs: -32614 eth_getLogs is limited to a 2,000 range")).toBe(true);
    expect(isRangeError("rpc eth_getLogs HTTP 429")).toBe(false);
  });
});

describe("processDeposits (money: never skip a deposit)", () => {
  const d = (block: number, logIndex: number, amountUsdc = "1.5"): DepositLog => ({ tx: `0x${block}${logIndex}`, logIndex, block, from: "0xf", amountUsdc });
  it("advances to the window end when every log is handled, in chain order", async () => {
    const seen: string[] = [];
    const r = await processDeposits([d(12, 1), d(11, 0), d(12, 0)], 10, 20, async (x) => { seen.push(`${x.block}:${x.logIndex}`); return "credited"; });
    expect(seen).toEqual(["11:0", "12:0", "12:1"]);
    expect(r).toMatchObject({ cursor: 20, counts: { credited: 3 }, failed: null });
  });
  it("holds the cursor before the block of the first failed log", async () => {
    const r = await processDeposits([d(11, 0), d(15, 2), d(18, 0)], 10, 20, async (x) => { if (x.block === 15) throw new Error("db down"); return "credited"; });
    expect(r.cursor).toBe(14);
    expect(r.failed?.block).toBe(15);
    expect(r.counts).toEqual({ credited: 1 });
  });
  it("never moves the cursor backwards when the first block of the window fails", async () => {
    const r = await processDeposits([d(11, 0)], 10, 20, async () => { throw new Error("db down"); });
    expect(r.cursor).toBe(10);
  });
  it("skips zero-value transfers (address-poisoning spam) without calling the ledger", async () => {
    const credit = vi.fn(async () => "credited");
    const r = await processDeposits([d(11, 0, "0"), d(12, 0, "0.000001")], 10, 20, credit);
    expect(credit).toHaveBeenCalledTimes(1);
    expect(r.counts).toEqual({ zero_value: 1, credited: 1 });
    expect(r.cursor).toBe(20);
  });
  it("decodes a USDC Transfer log exactly (6 decimals, no float rounding)", () => {
    const l = toDepositLog({ address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", topics: ["0xddf2", "0x000000000000000000000000AbCdEf0000000000000000000000000000000001"], data: "0x" + (123_456_789n).toString(16), blockNumber: "0x10", transactionHash: "0xAB", logIndex: "0x3" });
    expect(l).toEqual({ tx: "0xab", logIndex: 3, block: 16, from: "0xabcdef0000000000000000000000000000000001", amountUsdc: "123.456789" });
  });
});

describe("redact", () => {
  it("strips every credential shape we store or send", () => {
    const s = redact("key=abc123secret https://base-mainnet.g.alchemy.com/v2/AbCdEf123456 Bearer abcdefghijkl apikey_0123456789abcdef rsl_live_abcdefgh12345 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawx postgres://user:pw@host/db");
    expect(s).not.toMatch(/abc123secret|AbCdEf123456|abcdefghijkl|0123456789abcdef|abcdefgh12345|AAHdqTcv|:pw@/);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { baseLogsProviders, fetchBaseLogs, isRangeError, logsWindow, LogsUnavailableError, type LogsProvider } from "../src/ingest/base";
import { MAX_EARLIER_MATCHES, nextEarlierMatches } from "../src/ingest/matches";
import type { WatchRow } from "../src/ingest/types";
import { processDeposits, toDepositLog, type DepositLog } from "../src/jobs/deposits";
import { redact } from "../src/ops/redact";
import { resolveMarket } from "../src/resolve";
import { DEFAULT_THRESHOLDS } from "../src/resolve/thresholds";
import type { EvidenceInput, Resolver } from "../src/resolve/schema";
import { chainMarket } from "../evals/lib/cases";

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

describe("chain evidence carries earlier matches (a window-only view 'proved' absence after a match)", () => {
  const ADDR = "0x1111111111111111111111111111111111111111";
  const TOPIC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const EVM = chainMarket().resolver as Resolver;
  const T0 = Date.parse("2026-09-20T00:00:00Z") / 1000; // block n is mined at T0 + 2n: inside the market window
  const hdr = (n: number) => ({ number: "0x" + n.toString(16), timestamp: "0x" + (T0 + n * 2).toString(16) });
  const rawLog = (block: number, topic = TOPIC) => ({ address: ADDR, topics: [topic], data: "0x", blockNumber: "0x" + block.toString(16), transactionHash: `0x${block.toString(16)}`, logIndex: "0x0" });
  function chain(safe: () => number, logs: ReturnType<typeof rawLog>[]) {
    stubRpc((_u, m, params) => {
      if (m === "eth_getBlockByNumber") return params[0] === "safe" ? hdr(safe()) : hdr(parseInt(String(params[0]), 16));
      if (m === "eth_getLogs") {
        const f = params[0] as { fromBlock: string; toBlock: string };
        return logs.filter((l) => parseInt(l.blockNumber, 16) >= parseInt(f.fromBlock, 16) && parseInt(l.blockNumber, 16) <= parseInt(f.toBlock, 16));
      }
      throw new Error("unexpected " + m);
    });
  }
  const watch = (cursor: Record<string, unknown>): WatchRow => ({ id: "w", market_id: "m", source_kind: "base_log", source_ref: { address: ADDR, topic0: TOPIC }, poll_interval_s: 300, etag: null, cursor, coverage: [], last_evidence_hash: null, consecutive_errors: 0, backlog: false, active: true });

  it("a log matched before the deadline still decides the post-deadline observation of an empty window", async () => {
    let safe = 2_000;
    chain(() => safe, [rawLog(1_500)]);
    const first = await fetchBaseLogs({} as Env, watch({ block: 999, from_ts: "2026-09-01T00:00:00Z", has_code: true }), EVM);
    expect((first.evidence!.structured as { logs: unknown[] }).logs).toHaveLength(1);
    expect(first.cursor!.earlier_matches).toHaveLength(1);

    safe = 3_500; // the next window (2000, 3500] has no log
    const second = await fetchBaseLogs({} as Env, watch(first.cursor!), EVM);
    const s2 = second.evidence!.structured as { logs: unknown[]; earlier_matches: Array<{ tx_hash: string }> };
    expect(s2.logs).toEqual([]);
    expect(s2.earlier_matches.map((l) => l.tx_hash)).toEqual(["0x5dc"]);
    expect(second.cursor!.earlier_matches).toEqual(first.cursor!.earlier_matches);

    // What runWatch attaches after the deadline: contiguous coverage over [open_at, deadline + grace].
    const full = { contiguous: true, from: "2026-08-31T00:00:00Z", to: "2026-10-01T02:00:00Z", errors: 0 };
    const resolve = (ev: EvidenceInput) => resolveMarket({ marketId: "m", market: chainMarket(), evidence: { ...ev, coverage: { ...ev.coverage, ...full } }, thresholds: DEFAULT_THRESHOLDS, spotlightSecret: "eval-spotlight-v1", model: "jev-1.13.0", now: new Date("2026-10-02T12:00:00Z") }, { jev: async () => { throw new Error("must not call jev"); } });
    const r = await resolve(second.evidence!);
    expect(r.verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_A", determination_basis: "structured" });
    // The same window without the carried match is exactly the contradicting NO this prevents.
    const bare = await resolve({ ...second.evidence!, structured: { ...(second.evidence!.structured as object), earlier_matches: [] } });
    expect(bare.verdict).toMatchObject({ resolution_status: "RESOLVED", winning_outcome: "OPTION_B" });
  });

  it("carries only what the resolver counts, earliest first, capped", () => {
    const log = (block: number, topic = TOPIC) => ({ address: ADDR, topics: [topic], block_number: block, tx_hash: `0x${block}` });
    const other = log(10, "0xbbbb");
    expect(nextEarlierMatches(EVM, [], [other, log(11)])).toEqual([log(11)]);
    expect(nextEarlierMatches(undefined, [], [log(11)])).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) => log(20 + i));
    const carried = nextEarlierMatches(EVM, [log(11)], many);
    expect(carried).toHaveLength(MAX_EARLIER_MATCHES);
    expect(carried[0]).toEqual(log(11));
    expect(nextEarlierMatches(EVM, carried, [log(99)])).toBe(carried);
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

/**
 * The USDC deposit scan on alchemy_getAssetTransfers (ALCHEMY_BASE_HTTP_URL set), with eth_getLogs as its fallback.
 * OBSERVED 2026-09-27: both public Base RPCs refuse Worker egress (mainnet.base.org HTTP 429, publicnode HTTP 403), so
 * every scan failed; Alchemy's transfers API has no range cap. Money rules checked here: the amount is the raw 6-decimal
 * integer (never the float `value`), (tx_hash, log_index) is the key the logs path uses (a transfer and its log replay
 * each other as 'duplicate'), nothing malformed is guessed, and the cursor never passes a block that was not handled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Env } from "../src/env";
import type { AssetTransfer, RawLog } from "../src/ingest/base";
import { fakeDb, type FakeDb } from "./lib/fake-db";
import { creditFromDeposit, MIGRATION_020_CONFIG } from "./lib/fake-money";

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

import { checkTransfer, scanDeposits, toDepositLog, MAX_TRANSFER_PAGES_PER_SCAN } from "../src/jobs/deposits";
import { DEPOSIT_SCAN_SUBREQUESTS } from "../src/jobs/schedule";
import { alertMany } from "../src/ops/alerts";
import { Budget, COST, INVOCATION_SUBREQUESTS } from "../src/ops/budget";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RECEIVER = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TENANT_WALLET = "0x00000000000000000000000000000000000000f1";
const OTHER = "0x00000000000000000000000000000000000000cc";
const KEY = "AlchemyKey0123456789abcdef";
const ALCHEMY = `https://base-mainnet.g.alchemy.com/v2/${KEY}`;
const ALCHEMY_HOST = "base-mainnet.g.alchemy.com";
const hex = (n: number | bigint) => "0x" + n.toString(16);
const topic = (addr: string) => "0x" + addr.replace(/^0x/, "").padStart(64, "0");
const txHash = (block: number, logIndex: number) => "0x" + block.toString(16).padStart(32, "0") + logIndex.toString(16).padStart(32, "0");
const env = { USDC_RECEIVING_ADDRESS: RECEIVER, ALCHEMY_BASE_HTTP_URL: ALCHEMY } as unknown as Env;
const cfg = { usdcContract: USDC, creditsPerUsdc: 1000 } as Config;

type Wire = Record<string, unknown>;
/** A transfer as alchemy_getAssetTransfers returns it: 2.5 USDC from the tenant's wallet unless `o` says otherwise. */
function transfer(block: number, logIndex: number, o: { raw?: bigint; value?: number; from?: string; to?: string; contract?: string; category?: string; uniqueId?: unknown; hash?: string } = {}): Wire {
  const hash = o.hash ?? txHash(block, logIndex);
  const raw = o.raw ?? 2_500_000n;
  return {
    blockNum: hex(block), uniqueId: "uniqueId" in o ? o.uniqueId : `${hash}:log:${logIndex}`, hash, from: o.from ?? TENANT_WALLET, to: o.to ?? RECEIVER,
    value: o.value ?? Number(raw) / 1e6, erc721TokenId: null, erc1155Metadata: null, tokenId: null, asset: "USDC", category: o.category ?? "erc20",
    rawContract: { value: hex(raw), address: o.contract ?? USDC, decimal: "0x6" }, metadata: { blockTimestamp: "2026-09-27T00:00:00.000Z" },
  };
}
/** The same deposit as its USDC Transfer log (the eth_getLogs fallback's view). */
function log(block: number, logIndex: number, raw = 2_500_000n): RawLog {
  return { address: USDC, topics: [TRANSFER, topic(TENANT_WALLET), topic(RECEIVER)], data: hex(raw), blockNumber: hex(block), transactionHash: txHash(block, logIndex), logIndex: hex(logIndex) };
}

interface Api {
  safe: number; transfers: Wire[]; pageSize?: number;
  /** A failure injected on the Alchemy URL: an HTTP response, a thrown error (a timeout), or null for a normal answer. */
  fail?: (method: string) => Response | Error | null;
  logs?: RawLog[]; logsDown?: boolean;
}
interface Call { host: string; method: string; params: any[] }
let api: Api;
let calls: Call[];
let creditArgs: Array<Record<string, unknown>>;
let credits: Map<string, number>;

beforeEach(() => {
  calls = []; creditArgs = []; credits = new Map();
  vi.mocked(alertMany).mockClear();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { method: string; params: any[] };
    calls.push({ host: new URL(url).host, method: body.method, params: body.params });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    const header = () => reply({ number: hex(api.safe), timestamp: hex(1_700_000_000) });
    if (url === ALCHEMY) {
      const f = api.fail?.(body.method) ?? null;
      if (f instanceof Error) throw f;
      if (f) return f;
      if (body.method === "eth_getBlockByNumber") return header();
      if (body.method !== "alchemy_getAssetTransfers") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unexpected" } }));
      const q = body.params[0] as { fromBlock: string; toBlock: string; pageKey?: string };
      const from = parseInt(q.fromBlock, 16), to = parseInt(q.toBlock, 16);
      // A transfer whose blockNum does not parse is always returned (the API misbehaving); the rest by range, oldest first.
      const all = api.transfers.filter((t) => { const b = parseInt(String(t.blockNum), 16); return Number.isNaN(b) || (b >= from && b <= to); });
      const size = api.pageSize ?? 1000;
      const offset = q.pageKey ? Number(q.pageKey.split(":")[1]) : 0;
      const next = offset + size < all.length ? `page:${offset + size}` : undefined;
      return reply({ transfers: all.slice(offset, offset + size), ...(next ? { pageKey: next } : {}) });
    }
    // The public providers: down as the Worker sees them, or answering eth_getLogs over the same chain.
    if (api.logsDown) return new Response("", { status: url.includes("publicnode") ? 403 : 429 });
    if (body.method === "eth_getBlockByNumber") return header();
    const { fromBlock, toBlock } = body.params[0] as { fromBlock: string; toBlock: string };
    return reply((api.logs ?? []).filter((l) => parseInt(l.blockNumber, 16) >= parseInt(fromBlock, 16) && parseInt(l.blockNumber, 16) <= parseInt(toBlock, 16)));
  });
});
afterEach(() => vi.unstubAllGlobals());

function newDb(cursor: number, endpoints = false) {
  h.db = fakeDb({
    app_config: [{ key: "usdc_cursor_block", value: String(cursor) }, ...structuredClone(MIGRATION_020_CONFIG)], loop_runs: [],
    tenants: [{ id: "t1", wallet_address: TENANT_WALLET, credits_balance: 0, deleted_at: null }], usdc_deposits: [], credit_ledger: [],
    webhook_endpoints: endpoints ? [{ id: "e1", tenant_id: "t1", active: true, deleted_at: null, events: ["payment.credited"] }] : [], webhook_deliveries: [],
  }, {}, {
    primaryKey: { app_config: "key" },
    rpc: {
      credit_from_deposit: async (db, a) => {
        creditArgs.push({ ...a });
        const k = `${a.p_tx_hash}#${a.p_log_index}`;
        credits.set(k, (credits.get(k) ?? 0) + 1);
        return creditFromDeposit(db, a);
      },
    },
  });
}
const cursorNow = () => Number(h.db.tables.app_config!.find((r) => r.key === "usdc_cursor_block")!.value);
const setCursor = (n: number) => { h.db.tables.app_config!.find((r) => r.key === "usdc_cursor_block")!.value = String(n); };
const alertItems = () => vi.mocked(alertMany).mock.calls.flatMap((c) => c[1]!);
const transferQueries = () => calls.filter((c) => c.method === "alchemy_getAssetTransfers").map((c) => c.params[0] as Record<string, unknown>);

/** One scan; returns what it really sent: RPCs + database calls (an rpc counts once) + COST.alert per alertMany(). */
async function scan(budget = new Budget(DEPOSIT_SCAN_SUBREQUESTS), e: Env = env) {
  calls = []; h.db.calls.length = 0; vi.mocked(alertMany).mockClear();
  const r = await scanDeposits(e, cfg, budget);
  const used = calls.length + h.db.calls.length + vi.mocked(alertMany).mock.calls.length * COST.alert;
  return { r, used };
}

describe("checkTransfer (a transfer read as the deposit its log would give)", () => {
  const range = { from: 1_001, to: 1_500 };
  it("maps a well-formed transfer to exactly what toDepositLog gives its Transfer log: same key, same raw amount", () => {
    const t = transfer(1_100, 4, { raw: 123_456_789n, value: 999.99, from: TENANT_WALLET.toUpperCase().replace("0X", "0x") });
    t.uniqueId = String(t.uniqueId).toUpperCase().replace("0X", "0x").replace(":LOG:", ":log:");
    t.hash = String(t.hash).toUpperCase().replace("0X", "0x");
    const c = checkTransfer(t as AssetTransfer, USDC, RECEIVER, range);
    expect(c).toEqual({ kind: "deposit", deposit: toDepositLog(log(1_100, 4, 123_456_789n)) });
    expect(c).toEqual({ kind: "deposit", deposit: { tx: txHash(1_100, 4), logIndex: 4, block: 1_100, from: TENANT_WALLET, amountUsdc: "123.456789" } });
  });

  it("parses N of uniqueId as the log index and refuses every other uniqueId shape", () => {
    const hash = txHash(1_100, 0);
    expect(checkTransfer(transfer(1_100, 0, { uniqueId: `${hash}:log:17` }) as AssetTransfer, USDC, RECEIVER, range)).toMatchObject({ kind: "deposit", deposit: { tx: hash, logIndex: 17 } });
    for (const uniqueId of [`${hash}:log:`, `${hash}:log:-1`, `${hash}:log:1a`, `${hash}:log:1:x`, `${hash}:transfer:1`, `${hash}`, `0xdead:log:1`, `${hash.slice(2)}:log:1`, ` ${hash}:log:1`, undefined, 7]) {
      const c = checkTransfer(transfer(1_100, 0, { uniqueId }) as AssetTransfer, USDC, RECEIVER, range);
      expect(c, String(uniqueId)).toMatchObject({ kind: "refuse", block: 1_100, reason: "uniqueId is not <tx hash>:log:<N>" });
    }
    expect(checkTransfer(transfer(1_100, 0, { uniqueId: `${hash}:log:99999999999999999999` }) as AssetTransfer, USDC, RECEIVER, range)).toMatchObject({ kind: "refuse", reason: "uniqueId's log index is out of range" });
    expect(checkTransfer(transfer(1_100, 0, { hash: txHash(1_100, 9), uniqueId: `${hash}:log:0` }) as AssetTransfer, USDC, RECEIVER, range)).toMatchObject({ kind: "refuse", reason: "hash differs from uniqueId's transaction hash" });
  });

  it("refuses what it cannot read for certain: the raw amount, its decimals, the sender, a block outside the range", () => {
    const at = (t: Wire) => checkTransfer(t as AssetTransfer, USDC, RECEIVER, range);
    const t = transfer(1_100, 0);
    expect(at({ ...t, rawContract: { address: USDC, decimal: "0x6", value: null } })).toMatchObject({ kind: "refuse", reason: "rawContract.value is not a hex integer" });
    expect(at({ ...t, rawContract: { address: USDC, decimal: "0x6", value: "2.5" } })).toMatchObject({ kind: "refuse", reason: "rawContract.value is not a hex integer" });
    expect(at({ ...t, rawContract: { address: USDC, decimal: "0x12", value: "0x10" } })).toMatchObject({ kind: "refuse", reason: "rawContract.decimal 0x12 is not 6" });
    expect(at({ ...t, from: "0x1234" })).toMatchObject({ kind: "refuse", reason: "from is not an address" });
    expect(at({ ...t, to: null })).toMatchObject({ kind: "refuse", reason: "to is not an address" });
    expect(at({ ...t, rawContract: { value: "0x10", decimal: "0x6", address: null } })).toMatchObject({ kind: "refuse", reason: "rawContract.address is not an address" });
    expect(at({ ...t, category: undefined })).toMatchObject({ kind: "refuse", reason: "category is missing" });
    expect(at(transfer(1_501, 0))).toMatchObject({ kind: "refuse", block: null });
    expect(at({ ...t, blockNum: "safe" })).toMatchObject({ kind: "refuse", block: null });
    // Only the float is off: the raw integer is what is credited.
    expect(at(transfer(1_100, 0, { raw: 1n, value: 5 }))).toMatchObject({ kind: "deposit", deposit: { amountUsdc: "0.000001" } });
  });

  it("skips (never credits) a transfer that says it is not a USDC deposit to the receiving address", () => {
    const at = (t: Wire) => checkTransfer(t as AssetTransfer, USDC, RECEIVER, range);
    expect(at(transfer(1_100, 0, { contract: OTHER }))).toMatchObject({ kind: "skip", block: 1_100, reason: `contract ${OTHER} is not USDC` });
    expect(at(transfer(1_100, 0, { to: OTHER }))).toMatchObject({ kind: "skip", reason: `to ${OTHER} is not the receiving address` });
    expect(at(transfer(1_100, 0, { category: "erc721" }))).toMatchObject({ kind: "skip", reason: "category erc721 is not erc20" });
    expect(at(transfer(1_100, 0, { contract: USDC.toUpperCase().replace("0X", "0x"), to: RECEIVER.toUpperCase().replace("0X", "0x") }))).toMatchObject({ kind: "deposit" });
  });
});

describe("scanDeposits on alchemy_getAssetTransfers", () => {
  it("credits a matched deposit with the exact raw amount, keyed as its log, over one query to the safe block", async () => {
    api = { safe: 1_500, transfers: [transfer(1_100, 4, { raw: 123_456_789n, value: 999.99 })] };
    newDb(1_000);
    const { r, used } = await scan();
    expect(r).toMatchObject({ scanned: true, source: "alchemy_transfers", detail: "caught up via alchemy_transfers", from: 1_001, to: 1_500, found: 1, credited: 1, alerts: [] });
    expect(creditArgs).toEqual([expect.objectContaining({ p_tx_hash: txHash(1_100, 4), p_log_index: 4, p_from: TENANT_WALLET, p_to: RECEIVER, p_amount_usdc: "123.456789", p_block: 1_100, p_safe_block: 1_500 })]);
    expect(h.db.tables.tenants![0]!.credits_balance).toBe(12_345); // floor(123.456789 x 100): the raw integer, not 999.99
    expect(cursorNow()).toBe(1_500);
    // Every RPC went to Alchemy: the safe header, then one page whose toBlock is that header's number ("safe" is refused).
    expect(calls.map((c) => `${c.host} ${c.method}`)).toEqual([`${ALCHEMY_HOST} eth_getBlockByNumber`, `${ALCHEMY_HOST} alchemy_getAssetTransfers`]);
    expect(calls[0]!.params).toEqual(["safe", false]);
    expect(transferQueries()).toEqual([{ fromBlock: hex(1_001), toBlock: hex(1_500), toAddress: RECEIVER, contractAddresses: [USDC], category: ["erc20"], withMetadata: true, excludeZeroValue: false, maxCount: "0x3e8", order: "asc" }]);
    expect(h.db.tables.loop_runs![0]).toMatchObject({ outcome: "success", rows_written: 1, meta: { provider: "alchemy_transfers", transfer_pages: 1, provider_errors: [] } });
    expect(used).toBeLessThanOrEqual(r.subrequests);
    expect(r.subrequests).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
  });

  it("zero transfers over a 200k-block gap: one page moves the cursor to the safe block", async () => {
    api = { safe: 51_870_000, transfers: [] };
    newDb(51_667_928);
    const { r, used } = await scan();
    expect(r).toMatchObject({ scanned: true, detail: "caught up via alchemy_transfers", from: 51_667_929, to: 51_870_000, found: 0, alerts: [] });
    expect(cursorNow()).toBe(51_870_000);
    expect(transferQueries()).toEqual([expect.objectContaining({ fromBlock: hex(51_667_929), toBlock: hex(51_870_000) })]);
    expect(used).toBe(5); // cursor read, safe header, one page, cursor write, loop_runs row
    expect(r.subrequests).toBe(5);
    expect(h.db.tables.loop_runs![0]).toMatchObject({ outcome: "no_op" });
  });

  it("no new safe blocks: nothing is queried past the header and the cursor stays", async () => {
    api = { safe: 1_000, transfers: [] };
    newDb(1_000);
    const { r, used } = await scan();
    expect(r).toMatchObject({ scanned: true, detail: "no new safe blocks via alchemy_transfers", alerts: [] });
    expect(used).toBe(3); // cursor read, safe header, loop_runs row
    expect(cursorNow()).toBe(1_000);
  });

  it("a replayed transfer (credit_from_deposit answers 'duplicate') writes nothing new and still advances", async () => {
    api = { safe: 1_500, transfers: [transfer(1_100, 0)] };
    newDb(1_000, true);
    await scan();
    expect(h.db.tables.webhook_deliveries).toHaveLength(1);
    const before = structuredClone({ deposits: h.db.tables.usdc_deposits, ledger: h.db.tables.credit_ledger, tenants: h.db.tables.tenants, deliveries: h.db.tables.webhook_deliveries });

    setCursor(1_000); // the same range again, as after a cursor write that did not land
    api.safe = 1_600;
    const { r } = await scan();
    expect(r).toMatchObject({ scanned: true, credited: 0, counts: { duplicate: 1 }, detail: "caught up via alchemy_transfers", to: 1_600, alerts: [] });
    expect(credits.get(`${txHash(1_100, 0)}#0`)).toBe(2);
    expect({ deposits: h.db.tables.usdc_deposits, ledger: h.db.tables.credit_ledger, tenants: h.db.tables.tenants, deliveries: h.db.tables.webhook_deliveries }).toEqual(before);
    expect(cursorNow()).toBe(1_600);
  });

  it("a malformed uniqueId is refused: the cursor holds before its block, an alert names it, and nothing is guessed", async () => {
    api = { safe: 1_500, transfers: [transfer(1_100, 0), transfer(1_200, 1, { uniqueId: "0xdead:log:1" }), transfer(1_300, 0)] };
    newDb(1_000);
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(r).toMatchObject({ scanned: false, to: 1_199, credited: 1, counts: { credited: 1, refused: 1 }, alerts: ["deposit_transfer_refused"] });
    expect(r.detail).toBe("held before block 1200: 1 malformed transfer(s) refused via alchemy_transfers");
    expect(cursorNow()).toBe(1_199);
    expect([...credits.keys()]).toEqual([`${txHash(1_100, 0)}#0`]); // neither the refused transfer nor the one after it
    const refused = alertItems().find((i) => i.key === "deposit_transfer_refused")!;
    expect(refused.text).toContain("0xdead:log:1: uniqueId is not <tx hash>:log:<N>");
    expect(refused.meta).toMatchObject({ hold_block: 1_200 });
    expect(h.db.tables.loop_runs![0]).toMatchObject({ outcome: "failure" });

    // Once the API answers it well-formed, the next scan continues from the held block and credits both.
    api.transfers[1] = transfer(1_200, 1);
    const next = await scan();
    expect(transferQueries()[0]).toMatchObject({ fromBlock: hex(1_200) });
    expect(next.r).toMatchObject({ scanned: true, credited: 2, detail: "caught up via alchemy_transfers", alerts: [] });
    expect(cursorNow()).toBe(1_500);
    expect(credits.size).toBe(3);
  });

  it("a transfer naming no block of the range holds the whole page where the cursor is", async () => {
    api = { safe: 1_500, transfers: [transfer(1_100, 0), { ...transfer(1_200, 0), blockNum: "pending" }] };
    newDb(1_000);
    const { r } = await scan();
    expect(r).toMatchObject({ scanned: false, to: 1_000, credited: 0, alerts: ["deposit_transfer_refused"] });
    expect(cursorNow()).toBe(1_000);
    expect(credits.size).toBe(0);
  });

  it("a transfer of another contract, to another address or not erc20 is skipped with an alert, never credited", async () => {
    api = { safe: 1_500, transfers: [transfer(1_100, 0, { contract: OTHER }), transfer(1_150, 2, { to: OTHER }), transfer(1_200, 0, { category: "erc721" }), transfer(1_300, 1)] };
    newDb(1_000);
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(r).toMatchObject({ scanned: true, found: 4, credited: 1, counts: { skipped: 3, credited: 1 }, detail: "caught up via alchemy_transfers", alerts: ["deposit_transfer_skipped"] });
    expect([...credits.keys()]).toEqual([`${txHash(1_300, 1)}#1`]);
    expect(h.db.tables.usdc_deposits).toHaveLength(1);
    expect(cursorNow()).toBe(1_500);
    const skipped = alertItems().find((i) => i.key === "deposit_transfer_skipped")!;
    expect(skipped.text).toContain(`${txHash(1_100, 0)}:log:0: contract ${OTHER} is not USDC`);
    expect(skipped.meta).toMatchObject({ transfers: expect.arrayContaining([expect.stringContaining(`to ${OTHER} is not the receiving address`), expect.stringContaining("category erc721 is not erc20")]) });
  });

  it("follows pageKey over the same range across two pages, crediting each deposit once", async () => {
    api = { safe: 1_500, pageSize: 2, transfers: [transfer(1_100, 0), transfer(1_200, 0), transfer(1_200, 1), transfer(1_400, 0)] };
    newDb(1_000);
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(r).toMatchObject({ scanned: true, found: 4, credited: 4, detail: "caught up via alchemy_transfers", to: 1_500 });
    const [first, second] = transferQueries();
    expect(second).toEqual({ ...first, pageKey: "page:2" });
    expect([...credits.values()]).toEqual([1, 1, 1, 1]);
    expect(h.db.tables.loop_runs![0]!.meta).toMatchObject({ transfer_pages: 2 });
    expect(cursorNow()).toBe(1_500);
  });

  it("the budget ending between pages leaves the cursor at the last block fully handled; the next scan finishes", async () => {
    api = { safe: 1_500, pageSize: 2, transfers: [transfer(1_100, 0), transfer(1_200, 0), transfer(1_200, 1), transfer(1_400, 0)] };
    newDb(1_000);
    // reserve 6, cursor read, cursor write, safe header, page 1 (10), two credits and the payment batch (15): no page 2.
    const { r, used } = await scan(new Budget(15));
    expect(used).toBeLessThanOrEqual(15);
    expect(r).toMatchObject({ scanned: true, stopped_by_budget: true, credited: 2, to: 1_199, detail: "subrequest budget reached; backlog remains via alchemy_transfers" });
    // Block 1200 may go on in page 2, so the cursor stops before it even though 1200#0 was credited.
    expect(cursorNow()).toBe(1_199);
    expect(transferQueries()).toHaveLength(1);

    const next = await scan();
    expect(next.used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(transferQueries()[0]).toMatchObject({ fromBlock: hex(1_200) }); // no block range skipped
    expect(next.r).toMatchObject({ scanned: true, credited: 2, counts: { duplicate: 1, credited: 2 }, detail: "caught up via alchemy_transfers", to: 1_500 });
    expect(credits.size).toBe(4);
    expect(credits.get(`${txHash(1_200, 0)}#0`)).toBe(2); // replayed as 'duplicate', never credited twice
    expect(h.db.tables.tenants![0]!.credits_balance).toBe(4 * 250);
  });

  it("a long backlog of pages stays inside the budget every scan until caught up, and every deposit is credited once", async () => {
    const transfers = Array.from({ length: 30 }, (_, i) => transfer(1_010 + Math.floor(i / 2) * 20, i % 2));
    api = { safe: 2_000, pageSize: 3, transfers };
    newDb(1_000);
    let scans = 0, last = "";
    while (!last.startsWith("caught up") && scans < 20) {
      const s = await scan();
      scans++;
      expect(s.used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
      expect(s.r.scanned).toBe(true);
      expect(transferQueries().length).toBeLessThanOrEqual(MAX_TRANSFER_PAGES_PER_SCAN);
      last = s.r.detail;
    }
    expect(last).toBe("caught up via alchemy_transfers");
    expect(cursorNow()).toBe(2_000);
    expect(credits.size).toBe(30);
    expect(h.db.tables.tenants![0]!.credits_balance).toBe(30 * 250);
  });
});

describe("the eth_getLogs fallback when a transfers call fails", () => {
  const failures: Array<[string, (method: string) => Response | Error | null, string]> = [
    ["an HTTP error on the page", (m) => (m === "alchemy_getAssetTransfers" ? new Response("", { status: 503 }) : null), "page 1: Error: rpc alchemy_getAssetTransfers HTTP 503"],
    ["a JSON-RPC error on the safe header", (m) => (m === "eth_getBlockByNumber" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Your app has exceeded its compute units per second capacity" } })) : null), "safe header: Error: rpc eth_getBlockByNumber: 429 Your app has exceeded its compute units per second capacity"],
    ["a timeout", (m) => (m === "alchemy_getAssetTransfers" ? new DOMException("The operation was aborted due to timeout", "TimeoutError") : null), "page 1: TimeoutError: The operation was aborted due to timeout"],
    ["a result that is not a page", (m) => (m === "alchemy_getAssetTransfers" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { transfers: [null] } })) : null), "page 1: Error: alchemy_getAssetTransfers returned a transfer that is not an object"],
  ];
  it.each(failures)("%s: the scan reads the same range from the logs providers and names both", async (_name, fail, error) => {
    api = { safe: 1_500, transfers: [transfer(1_100, 0)], fail, logs: [log(1_100, 0)] };
    newDb(1_000);
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(r).toMatchObject({ scanned: true, source: "mainnet.base.org", credited: 1, to: 1_500, alerts: [] });
    expect(r.detail).toBe(`caught up via mainnet.base.org (alchemy_transfers failed: ${error})`);
    expect(calls.filter((c) => c.host === "mainnet.base.org").map((c) => c.method)).toEqual(["eth_getBlockByNumber", "eth_getLogs"]);
    expect(h.db.tables.loop_runs![0]!.meta).toMatchObject({ provider: "mainnet.base.org", provider_errors: [`alchemy_transfers: ${error}`] });
    expect(cursorNow()).toBe(1_500);
  });

  const pageTwoFails = () => {
    let pagesServed = 0;
    api = {
      safe: 1_500, pageSize: 2, transfers: [transfer(1_100, 0), transfer(1_200, 0), transfer(1_200, 1), transfer(1_400, 0)],
      fail: (m) => (m === "alchemy_getAssetTransfers" && ++pagesServed > 1 ? new Response("", { status: 500 }) : null),
      logs: [log(1_100, 0), log(1_200, 0), log(1_200, 1), log(1_400, 0)],
    };
    newDb(1_000);
  };

  it("a page failing after progress on the 5-minute share: the progress is written and the rest is a budget stop, not a failure", async () => {
    pageTwoFails();
    // reserve 6, cursor read, cursor write, header, page 1, two credits + the batch (15), page 2 (16): no logs window fits.
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(r).toMatchObject({ scanned: true, stopped_by_budget: true, source: "alchemy_transfers", to: 1_199, credited: 2, alerts: [] });
    expect(r.detail).toBe("subrequest budget reached; backlog remains via alchemy_transfers (alchemy_transfers failed: page 2: Error: rpc alchemy_getAssetTransfers HTTP 500)");
    expect(cursorNow()).toBe(1_199);
  });

  it("a page failing after progress: that progress is kept and the logs path continues from it; the key is shared", async () => {
    pageTwoFails();
    const { r, used } = await scan(new Budget(INVOCATION_SUBREQUESTS)); // POST /internal/deposits/scan
    expect(used).toBeLessThanOrEqual(INVOCATION_SUBREQUESTS);
    expect(r).toMatchObject({ scanned: true, source: "mainnet.base.org", from: 1_001, to: 1_500, credited: 4, counts: { credited: 4, duplicate: 1 } });
    expect(r.detail).toBe("caught up via mainnet.base.org (alchemy_transfers failed: page 2: Error: rpc alchemy_getAssetTransfers HTTP 500)");
    // The logs window starts right after the block the transfers path fully handled (1199), not at the scan's start.
    const getLogs = calls.find((c) => c.method === "eth_getLogs")!;
    expect(getLogs.params[0]).toMatchObject({ fromBlock: hex(1_200) });
    // 1200#0, credited from its transfer, is the same (tx_hash, log_index) as its log: the replay answers 'duplicate'.
    expect(credits.get(`${txHash(1_200, 0)}#0`)).toBe(2);
    expect(h.db.tables.credit_ledger).toHaveLength(4);
    expect(cursorNow()).toBe(1_500);
  });

  it("both sources failing: the failure result and deposit_scan_failed, naming each, with the cursor held", async () => {
    api = { safe: 1_500, transfers: [transfer(1_100, 0)], fail: (m) => (m === "alchemy_getAssetTransfers" ? new Response("", { status: 503 }) : null), logsDown: true };
    newDb(1_000);
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(r).toMatchObject({ scanned: false, credited: 0, alerts: ["deposit_scan_failed"] });
    expect(r.detail).toContain("alchemy_transfers failed (page 1: Error: rpc alchemy_getAssetTransfers HTTP 503), then");
    expect(r.detail).toContain("no Base logs provider answered: mainnet.base.org: Error: rpc eth_getBlockByNumber HTTP 429 | base-rpc.publicnode.com: Error: rpc eth_getBlockByNumber HTTP 403");
    expect(alertItems()[0]!.text).toContain("alchemy_transfers failed");
    expect(h.db.tables.loop_runs!.map((l) => l.outcome)).toEqual(["failure"]);
    expect(cursorNow()).toBe(1_000);
  });

  it("the Alchemy key never reaches the result, loop_runs or an alert, even when an error quotes the URL", async () => {
    api = { safe: 1_500, transfers: [], fail: () => new TypeError(`fetch failed: connect ETIMEDOUT ${ALCHEMY}`), logsDown: true };
    newDb(1_000);
    const { r } = await scan();
    expect(r.scanned).toBe(false);
    const seen = JSON.stringify({ r, runs: h.db.tables.loop_runs, alerts: alertItems() });
    expect(seen).toContain("alchemy_transfers failed");
    expect(seen).not.toContain(KEY);
  });

  it("without ALCHEMY_BASE_HTTP_URL the scan never calls Alchemy (the logs path as before)", async () => {
    api = { safe: 1_500, transfers: [transfer(1_100, 0)], logs: [log(1_100, 0)] };
    newDb(1_000);
    const { r } = await scan(undefined, { USDC_RECEIVING_ADDRESS: RECEIVER } as unknown as Env);
    expect(r).toMatchObject({ scanned: true, credited: 1, source: "mainnet.base.org", detail: "caught up via mainnet.base.org" });
    expect(calls.some((c) => c.host === ALCHEMY_HOST)).toBe(false);
    expect(h.db.tables.loop_runs![0]!.meta).not.toHaveProperty("transfer_pages");
  });
});

describe("cursor initialization", () => {
  it("reads the safe header from Alchemy when it is configured", async () => {
    api = { safe: 51_870_000, transfers: [], logsDown: true };
    newDb(0);
    h.db.tables.app_config = h.db.tables.app_config!.filter((r) => r.key !== "usdc_cursor_block");
    const { r } = await scan();
    expect(r).toMatchObject({ scanned: true, source: "alchemy_transfers", from: 51_870_000, to: 51_870_000, detail: "cursor initialized at safe block via alchemy_transfers; scanning forward from now" });
    expect(cursorNow()).toBe(51_870_000);
    expect(calls.map((c) => c.host)).toEqual([ALCHEMY_HOST]);
  });
});

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

import { checkTransfer, scanDeposits, toDepositLog, MAX_TRANSFER_PAGES_PER_SCAN, TRANSFERS_INDEX_WINDOW } from "../src/jobs/deposits";
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
  /** The transfers index's height (default: everything): nothing above it is returned, and no error says so. */
  indexed?: number;
  /** Answer every pageKey'd page with the pageKey it was asked with (a provider stuck on one page). */
  repeatPageKey?: boolean;
  /**
   * A failure injected on the Alchemy URL: an HTTP response, a thrown error (a timeout), or null for a normal answer.
   * `q` is an alchemy_getAssetTransfers call's query: with toAddress a deposit page, without it the index probe.
   */
  fail?: (method: string, q: Record<string, unknown> | undefined) => Response | Error | null;
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
      const f = api.fail?.(body.method, body.params?.[0]) ?? null;
      if (f instanceof Error) throw f;
      if (f) return f;
      if (body.method === "eth_getBlockByNumber") return header();
      if (body.method !== "alchemy_getAssetTransfers") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unexpected" } }));
      const q = body.params[0] as { fromBlock: string; toBlock: string; pageKey?: string; toAddress?: string };
      const from = parseInt(q.fromBlock, 16), to = parseInt(q.toBlock, 16);
      const indexed = api.indexed ?? Infinity;
      if (!q.toAddress) {
        // The index probe (order desc, maxCount 1): USDC moves in every block, so the newest indexed one in the range.
        const head = Math.min(to, indexed);
        return reply({ transfers: head < from ? [] : [transfer(head, 0, { to: OTHER, hash: txHash(head, 999) })], pageKey: "probe:1" });
      }
      // A transfer whose blockNum does not parse is always returned (the API misbehaving); the rest by range, oldest first.
      const all = api.transfers.filter((t) => { const b = parseInt(String(t.blockNum), 16); return Number.isNaN(b) || (b >= from && b <= to && b <= indexed); });
      const size = api.pageSize ?? 100;
      const offset = q.pageKey ? Number(q.pageKey.split(":")[1]) : 0;
      const next = api.repeatPageKey && q.pageKey ? q.pageKey : offset + size < all.length ? `page:${offset + size}` : undefined;
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
const assetTransferCalls = () => calls.filter((c) => c.method === "alchemy_getAssetTransfers").map((c) => c.params[0] as Record<string, unknown>);
/** The deposit pages (toAddress = the receiving address). */
const transferQueries = () => assetTransferCalls().filter((q) => "toAddress" in q);
/** The index probes (contract only, newest first). */
const probeQueries = () => assetTransferCalls().filter((q) => !("toAddress" in q));
/** A failure on the deposit pages only (the index probe answers). */
const onPage = (f: () => Response | Error) => (m: string, q: Record<string, unknown> | undefined) => (m === "alchemy_getAssetTransfers" && q && "toAddress" in q ? f() : null);

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

  it("reads N in decimal: a real transfer (PROBED 2026-09-27, block 51,870,696) keys exactly as its Transfer log, logIndex 0x29", () => {
    // As alchemy_getAssetTransfers returned it (withMetadata false). Its USDC Transfer log in that block has logIndex 0x29
    // (41): all 115 USDC transfers of the block matched their log's logIndex with N read in decimal, none in hex. Read in
    // hex, "41" would be 65: another primary key than the logs path's, so a block read by both sources would credit twice.
    const hash = "0xc028e360977d9b15171ba9520604ebf3cd8da89661abcc29f58c6bba7ce194e0";
    const from = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59", to = "0xb093da272a66d47b7445ca389cebdc6d3ac7753d";
    const real: Wire = {
      blockNum: "0x3177be8", uniqueId: `${hash}:log:41`, hash, from, to, value: 92794.069938, erc721TokenId: null, erc1155Metadata: null,
      tokenId: null, asset: "USDC", category: "erc20", rawContract: { value: "0x159af523b2", address: USDC, decimal: "0x6" }, metadata: null,
    };
    const itsLog: RawLog = { address: USDC, topics: [TRANSFER, topic(from), topic(to)], data: "0x159af523b2", blockNumber: "0x3177be8", transactionHash: hash, logIndex: "0x29" };
    const c = checkTransfer(real as AssetTransfer, USDC, to, { from: 51_870_001, to: 51_871_000 });
    expect(c).toEqual({ kind: "deposit", deposit: toDepositLog(itsLog) });
    expect(c).toMatchObject({ deposit: { tx: hash, logIndex: 41, block: 51_870_696, amountUsdc: "92794.069938" } });
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
    // Every RPC went to Alchemy: the safe header, the index probe up to it, then one page whose toBlock is the newest indexed
    // block, here the header's number ("safe" is refused as a toBlock).
    expect(calls.map((c) => `${c.host} ${c.method}`)).toEqual([`${ALCHEMY_HOST} eth_getBlockByNumber`, `${ALCHEMY_HOST} alchemy_getAssetTransfers`, `${ALCHEMY_HOST} alchemy_getAssetTransfers`]);
    expect(calls[0]!.params).toEqual(["safe", false]);
    expect(probeQueries()).toEqual([{ fromBlock: hex(1_001), toBlock: hex(1_500), contractAddresses: [USDC], category: ["erc20"], withMetadata: false, excludeZeroValue: false, maxCount: "0x1", order: "desc" }]);
    expect(transferQueries()).toEqual([{ fromBlock: hex(1_001), toBlock: hex(1_500), toAddress: RECEIVER, contractAddresses: [USDC], category: ["erc20"], withMetadata: false, excludeZeroValue: true, maxCount: "0x64", order: "asc" }]);
    expect(h.db.tables.loop_runs![0]).toMatchObject({ outcome: "success", rows_written: 1, meta: { provider: "alchemy_transfers", transfer_pages: 1, transfers_indexed_to: 1_500, provider_errors: [] } });
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
    // The probe looks back TRANSFERS_INDEX_WINDOW blocks from safe, not over the whole gap.
    expect(probeQueries()).toEqual([expect.objectContaining({ fromBlock: hex(51_870_000 - TRANSFERS_INDEX_WINDOW + 1), toBlock: hex(51_870_000) })]);
    expect(used).toBe(6); // cursor read, safe header, index probe, one page, cursor write, loop_runs row
    expect(r.subrequests).toBe(6);
    expect(h.db.tables.loop_runs![0]).toMatchObject({ outcome: "no_op" });
  });

  it("no new safe blocks: nothing is queried past the header and the cursor stays", async () => {
    api = { safe: 1_000, transfers: [] };
    newDb(1_000);
    const { r, used } = await scan();
    expect(r).toMatchObject({ scanned: true, detail: "no new safe blocks via alchemy_transfers", alerts: [] });
    expect(used).toBe(3); // cursor read, safe header, loop_runs row
    expect(r.subrequests).toBe(3); // the cursor write reserved for the path is given back when the cursor does not move
    expect(assetTransferCalls()).toHaveLength(0);
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
    // Block 1200 goes on from page 1 into page 2. Two pages and three credits are the whole 5-minute share: 11 + 1 + 3 + 3.
    api = { safe: 1_500, pageSize: 2, transfers: [transfer(1_100, 0), transfer(1_200, 0), transfer(1_200, 1)] };
    newDb(1_000);
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(r.subrequests).toBe(DEPOSIT_SCAN_SUBREQUESTS - COST.alert); // the alert reserve is given back
    expect(r).toMatchObject({ scanned: true, found: 3, credited: 3, detail: "caught up via alchemy_transfers", to: 1_500 });
    const [first, second] = transferQueries();
    expect(second).toEqual({ ...first, pageKey: "page:2" });
    expect([...credits.values()]).toEqual([1, 1, 1]);
    expect(h.db.tables.loop_runs![0]!.meta).toMatchObject({ transfer_pages: 2 });
    expect(cursorNow()).toBe(1_500);
  });

  it("the budget ending between pages leaves the cursor at the last block fully handled; the next scan finishes", async () => {
    api = { safe: 1_500, pageSize: 2, transfers: [transfer(1_100, 0), transfer(1_200, 0), transfer(1_200, 1), transfer(1_400, 0)] };
    newDb(1_000);
    // reserve 6, cursor read, cursor write, safe header, index probe, page 1 (11), two credits and the payment batch (16):
    // no page 2.
    const { r, used } = await scan(new Budget(16));
    expect(used).toBeLessThanOrEqual(16);
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

describe("the transfers index lagging the safe head (a numeric toBlock past it is answered silently, PROBED 2026-09-27)", () => {
  it("the range ends at the newest indexed block: a deposit in the unindexed tail is credited once the index reaches it", async () => {
    // The index holds blocks up to 1300 while safe is 1500; the deposit at 1400 is not in it yet and nothing says so.
    api = { safe: 1_500, indexed: 1_300, transfers: [transfer(1_100, 0), transfer(1_400, 0)] };
    newDb(1_000);
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(transferQueries()).toEqual([expect.objectContaining({ fromBlock: hex(1_001), toBlock: hex(1_300) })]);
    expect(r).toMatchObject({ scanned: true, credited: 1, to: 1_300, alerts: [], detail: "caught up to the transfers index at block 1300 (safe 1500) via alchemy_transfers" });
    expect(cursorNow()).toBe(1_300); // not 1500: the block range (1300, 1500] is read again next scan
    expect(h.db.tables.loop_runs![0]!.meta).toMatchObject({ transfers_indexed_to: 1_300 });

    api.indexed = 1_600; api.safe = 1_600;
    const next = await scan();
    expect(transferQueries()[0]).toMatchObject({ fromBlock: hex(1_301), toBlock: hex(1_600) });
    expect(next.r).toMatchObject({ scanned: true, credited: 1, detail: "caught up via alchemy_transfers", to: 1_600 });
    expect([...credits.keys()]).toEqual([`${txHash(1_100, 0)}#0`, `${txHash(1_400, 0)}#0`]);
    expect(cursorNow()).toBe(1_600);
  });

  it("an index not yet past the cursor, with the gap inside the window, holds the cursor quietly for the next scan", async () => {
    api = { safe: 1_500, indexed: 1_440, transfers: [transfer(1_460, 0)] };
    newDb(1_450);
    const { r } = await scan();
    expect(r).toMatchObject({ scanned: true, credited: 0, to: 1_450, alerts: [], detail: "transfers index not yet past block 1450 via alchemy_transfers" });
    expect(probeQueries()).toEqual([expect.objectContaining({ fromBlock: hex(1_451), toBlock: hex(1_500) })]);
    expect(transferQueries()).toHaveLength(0);
    expect(r.subrequests).toBe(4); // cursor read, header, probe, loop_runs row
    expect(cursorNow()).toBe(1_450);

    api.indexed = 1_500;
    const next = await scan();
    expect(next.r).toMatchObject({ scanned: true, credited: 1, detail: "caught up via alchemy_transfers", to: 1_500 });
    expect(cursorNow()).toBe(1_500);
  });

  it("an index more than TRANSFERS_INDEX_WINDOW blocks behind safe is a transfers failure: the logs fallback reads the range", async () => {
    const safe = 5_000;
    api = { safe, indexed: safe - TRANSFERS_INDEX_WINDOW, transfers: [transfer(4_000, 0)], logs: [log(4_000, 0)] };
    newDb(3_500);
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(probeQueries()).toEqual([expect.objectContaining({ fromBlock: hex(safe - TRANSFERS_INDEX_WINDOW + 1), toBlock: hex(safe) })]);
    expect(transferQueries()).toHaveLength(0);
    const behind = `index behind: no USDC transfer indexed in the ${TRANSFERS_INDEX_WINDOW} blocks up to safe block ${safe}`;
    expect(r).toMatchObject({ scanned: true, source: "mainnet.base.org", credited: 1, to: safe, detail: `caught up via mainnet.base.org (alchemy_transfers failed: ${behind})` });
    expect(cursorNow()).toBe(safe);

    // Both behind: the failure alert, naming the lag, with the cursor held.
    api = { ...api, logsDown: true };
    newDb(3_500);
    const down = await scan();
    expect(down.r).toMatchObject({ scanned: false, credited: 0, alerts: ["deposit_scan_failed"] });
    expect(down.r.detail).toContain(`alchemy_transfers failed (${behind}), then`);
    expect(cursorNow()).toBe(3_500);
  });
});

describe("pages that do not go on in block order", () => {
  it("a page going back below a block an earlier page held is a transfers failure; the cursor goes back before that block", async () => {
    // Page 1 = [1100, 1300] (pageKey), page 2 = [1200 malformed, 1400]: 1200 is below 1300, which page 1 already handled.
    api = { safe: 1_500, pageSize: 2, transfers: [transfer(1_100, 0), transfer(1_300, 0), transfer(1_200, 1, { uniqueId: "0xdead:log:1" }), transfer(1_400, 0)], logsDown: true };
    newDb(1_000);
    const { r, used } = await scan(new Budget(INVOCATION_SUBREQUESTS));
    expect(used).toBeLessThanOrEqual(INVOCATION_SUBREQUESTS);
    expect(transferQueries()).toHaveLength(2);
    // Nothing on page 2 was handled, the refusal included: the scan does not claim to hold before 1200, it goes back there.
    expect(r.counts).not.toHaveProperty("refused");
    expect([...credits.keys()]).toEqual([`${txHash(1_100, 0)}#0`, `${txHash(1_300, 0)}#0`]);
    expect(r).toMatchObject({ scanned: false, to: 1_199, alerts: ["deposit_scan_failed"] });
    expect(r.detail).toContain("alchemy_transfers failed (page 2: transfers out of block order (block 1200 after block 1300)), then");
    expect(cursorNow()).toBe(1_199); // not 1299: the next scan reads 1200 again

    // In order and well-formed again: 1200#1 is credited, 1300#0 answers 'duplicate', nothing is lost.
    api = { safe: 1_500, pageSize: 2, transfers: [transfer(1_100, 0), transfer(1_200, 1), transfer(1_300, 0), transfer(1_400, 0)] };
    const next = await scan();
    expect(transferQueries()[0]).toMatchObject({ fromBlock: hex(1_200) });
    expect(next.r).toMatchObject({ scanned: true, credited: 2, counts: { credited: 2, duplicate: 1 }, detail: "caught up via alchemy_transfers", to: 1_500 });
    expect(credits.size).toBe(4);
    expect(h.db.tables.tenants![0]!.credits_balance).toBe(4 * 250);
  });

  it("a provider answering the same pageKey again: one repeated page, then the logs fallback from the unfinished block", async () => {
    api = { safe: 1_500, pageSize: 1, repeatPageKey: true, transfers: [transfer(1_100, 0), transfer(1_200, 0), transfer(1_300, 0)], logs: [log(1_100, 0), log(1_200, 0), log(1_300, 0)] };
    newDb(1_000);
    const { r, used } = await scan(new Budget(INVOCATION_SUBREQUESTS));
    expect(used).toBeLessThanOrEqual(INVOCATION_SUBREQUESTS);
    expect(transferQueries().map((q) => q.pageKey)).toEqual([undefined, "page:1"]); // page 2 answered pageKey page:1 again
    expect(r).toMatchObject({ scanned: true, source: "mainnet.base.org", credited: 3, to: 1_500 });
    expect(r.detail).toBe("caught up via mainnet.base.org (alchemy_transfers failed: page 2: the same pageKey again)");
    // Page 2 ended in block 1200 with a pageKey, so the cursor stopped before it and the logs window starts there.
    expect(calls.find((c) => c.method === "eth_getLogs")!.params[0]).toMatchObject({ fromBlock: hex(1_200) });
    expect(credits.get(`${txHash(1_200, 0)}#0`)).toBe(2); // replayed from its log as 'duplicate'
    expect(credits.size).toBe(3);
    expect(cursorNow()).toBe(1_500);
  });

  it("the manual scan stops after MAX_TRANSFER_PAGES_PER_SCAN pages, before its budget does; the next scan goes on", async () => {
    // 40 deposits, one per page: on the whole invocation (50) the budget alone would carry about 17 pages.
    api = { safe: 2_000, pageSize: 1, transfers: Array.from({ length: 40 }, (_, i) => transfer(1_010 + i * 10, 0)) };
    newDb(1_000);
    const { r, used } = await scan(new Budget(INVOCATION_SUBREQUESTS));
    expect(MAX_TRANSFER_PAGES_PER_SCAN).toBe(8);
    expect(transferQueries()).toHaveLength(8);
    expect(r).toMatchObject({ scanned: true, stopped_by_budget: false, credited: 8, detail: "backlog remains via alchemy_transfers", to: 1_079 });
    // loop_runs row, cursor read, header, probe, cursor write, 8 pages, 8 credits, the payment batch: 24 of 50.
    expect(r.subrequests).toBe(24);
    expect(used).toBeLessThanOrEqual(r.subrequests);
    expect(cursorNow()).toBe(1_079); // 1080 was page 8's last block and might have gone on in page 9

    const next = await scan(new Budget(INVOCATION_SUBREQUESTS));
    expect(transferQueries()[0]).toMatchObject({ fromBlock: hex(1_080) });
    expect(next.r).toMatchObject({ credited: 7, counts: { duplicate: 1, credited: 7 } });
  });
});

describe("the eth_getLogs fallback when a transfers call fails", () => {
  const probeAnswers = (t: Wire) => (m: string, q: Record<string, unknown> | undefined) => (m === "alchemy_getAssetTransfers" && q && !("toAddress" in q) ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { transfers: [t] } })) : null);
  // [name, failure, error named, subrequests reserved]: the loop_runs row, the cursor read, what Alchemy was sent (header,
  // probe, page: up to 3), one logs window (header, eth_getLogs, cursor write), one credit and the payment batch (3). The
  // alert and the transfers path's cursor write are reserved and given back: a leak of either shows here.
  const failures: Array<[string, NonNullable<Api["fail"]>, string, number]> = [
    ["an HTTP error on the page", onPage(() => new Response("", { status: 503 })), "page 1: Error: rpc alchemy_getAssetTransfers HTTP 503", 12],
    ["a JSON-RPC error on the safe header", (m) => (m === "eth_getBlockByNumber" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Your app has exceeded its compute units per second capacity" } })) : null), "safe header: Error: rpc eth_getBlockByNumber: 429 Your app has exceeded its compute units per second capacity", 10],
    ["a timeout", onPage(() => new DOMException("The operation was aborted due to timeout", "TimeoutError")), "page 1: TimeoutError: The operation was aborted due to timeout", 12],
    ["a result that is not a page", onPage(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { transfers: [null] } }))), "page 1: Error: alchemy_getAssetTransfers returned a transfer that is not an object", 12],
    ["an HTTP error on the index probe", (m, q) => (m === "alchemy_getAssetTransfers" && q && !("toAddress" in q) ? new Response("", { status: 502 }) : null), "index probe: Error: rpc alchemy_getAssetTransfers HTTP 502", 11],
    ["an index probe answering another contract's transfer", probeAnswers(transfer(1_200, 0, { contract: OTHER })), `index probe: Error: alchemy_getAssetTransfers returned a transfer of ${OTHER}, not ${USDC}`, 11],
    ["an index probe answering a block outside its range", probeAnswers(transfer(1_600, 0)), "index probe: Error: alchemy_getAssetTransfers returned blockNum 0x640, not a block of [1001, 1500]", 11],
  ];
  it.each(failures)("%s: the scan reads the same range from the logs providers and names both", async (_name, fail, error, subrequests) => {
    api = { safe: 1_500, transfers: [transfer(1_100, 0)], fail, logs: [log(1_100, 0)] };
    newDb(1_000);
    const { r, used } = await scan();
    expect(used).toBeLessThanOrEqual(DEPOSIT_SCAN_SUBREQUESTS);
    expect(r.subrequests).toBe(subrequests);
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
      fail: onPage(() => (++pagesServed > 1 ? new Response("", { status: 500 }) : (null as unknown as Response))),
      logs: [log(1_100, 0), log(1_200, 0), log(1_200, 1), log(1_400, 0)],
    };
    newDb(1_000);
  };

  it("a page failing after progress on the 5-minute share: the progress is written and the rest is a budget stop, not a failure", async () => {
    pageTwoFails();
    // reserve 6, cursor read, cursor write, header, probe, page 1, two credits + the batch (16), page 2 (17): no logs window
    // fits.
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
    api = { safe: 1_500, transfers: [transfer(1_100, 0)], fail: onPage(() => new Response("", { status: 503 })), logsDown: true };
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

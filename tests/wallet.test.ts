/**
 * Signed wallet registration (plan §16.4 P3 step 3): the exact challenge text, EIP-191 signatures checked with a
 * throwaway viem account generated here (never a real key), and the two tenant routes over the in-memory database with
 * migration 020's register_wallet() stand-in: single use, expiry, a wrong signer, an address another tenant holds. Also
 * GET /v1/payments/address, where a buyer reads the tiers and how to register the wallet.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";
import { MIGRATION_020_CONFIG, MONEY_RPCS } from "./lib/fake-money";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", () => ({
  // wallet_challenges gets its column defaults (uuid id, expires_at = now() + 10 min) the way Postgres fills them
  db: () => ({
    ...h.db.client,
    from: (t: string) => {
      const q = h.db.client.from(t);
      if (t !== "wallet_challenges") return q;
      return new Proxy(q, { get: (o, k) => (k === "insert" ? (row: Row) => o.insert({ id: crypto.randomUUID(), expires_at: new Date(Date.now() + 600_000).toISOString(), used_at: null, ...row }) : Reflect.get(o, k)) });
    },
  }),
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
    return data;
  },
}));
vi.mock("../src/api/auth", () => ({
  authenticate: async () => ({ ok: true, auth: { keyId: "k1", tenantId: T1, plan: "payg", strictV0: false, environment: "test", scopes: [], requestsToday: 0, dailyCap: 1000 } }),
  rateLimit: async () => ({ allowed: true }),
  extractApiKey: () => null,
  invalidateKeyCache: async () => undefined,
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));
// The real function, recorded: src/billing/wallet.ts calls it once as it loads to build the base-point table.
vi.mock("viem/accounts", async (importOriginal) => {
  const m = await importOriginal<typeof import("viem/accounts")>();
  return { ...m, privateKeyToAddress: vi.fn(m.privateKeyToAddress) };
});

import { v1 } from "../src/api/v1";
import { challengeMessage, registerAnswer, signedBy, REGISTER_RESULTS } from "../src/billing/wallet";
import { alert } from "../src/ops/alerts";
import openapi from "../src/generated/openapi.json";
// Read as this file loads, after src/billing/wallet.ts has: vitest clears mock history before each test.
const atLoad = { calls: [...vi.mocked(privateKeyToAddress).mock.calls], results: [...vi.mocked(privateKeyToAddress).mock.results] };

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const OLD_WALLET = "0x00000000000000000000000000000000000000a1";

describe("CPU: the first registration in an isolate does not build the secp256k1 base-point table", () => {
  it("loading src/billing/wallet.ts multiplies the generator once (key 1, whose address is public), before any request", () => {
    // Without it the first recovery in an isolate took 12-13 ms under workerd, over the 10 ms Workers Free allows.
    expect(atLoad.calls).toEqual([[`0x${"0".repeat(63)}1`]]);
    expect(atLoad.results).toEqual([{ type: "return", value: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" }]);
  });
});

describe("challengeMessage: exactly the text the wallet signs", () => {
  it("five lines, lowercase address, no trailing newline", () => {
    const m = challengeMessage({ tenantId: T1, address: "0xAbCdEf0000000000000000000000000000000001", nonce: "0123456789abcdef0123456789abcdef", issuedAt: "2026-09-24T12:00:00.000Z" });
    expect(m).toBe(`Resolve wallet registration\ntenant: ${T1}\naddress: 0xabcdef0000000000000000000000000000000001\nnonce: 0123456789abcdef0123456789abcdef\nissued: 2026-09-24T12:00:00.000Z`);
  });
});

describe("signedBy: an EIP-191 personal_sign by exactly this address", () => {
  const account = privateKeyToAccount(generatePrivateKey()); // throwaway, generated for this test only
  const other = privateKeyToAccount(generatePrivateKey());
  const message = challengeMessage({ tenantId: T1, address: account.address, nonce: "a".repeat(32), issuedAt: "2026-09-24T12:00:00.000Z" });

  it("accepts the signer's signature, whatever the address's case", async () => {
    const sig = await account.signMessage({ message });
    expect(await signedBy(account.address.toLowerCase(), message, sig)).toBe(true);
    expect(await signedBy(account.address, message, sig)).toBe(true);
  });
  it("refuses another wallet's signature (wrong address) and a signature of other text", async () => {
    expect(await signedBy(account.address.toLowerCase(), message, await other.signMessage({ message }))).toBe(false);
    expect(await signedBy(account.address.toLowerCase(), message + " ", await account.signMessage({ message }))).toBe(false);
  });
  it("a malformed or unrecoverable signature is false, never a throw", async () => {
    expect(await signedBy(account.address, message, "0x1234")).toBe(false);
    expect(await signedBy(account.address, message, "0x" + "f".repeat(130))).toBe(false);
    expect(await signedBy("not-an-address", message, await account.signMessage({ message }))).toBe(false);
  });
});

describe("registerAnswer", () => {
  it("maps every register_wallet result to its status", () => {
    expect(Object.fromEntries(REGISTER_RESULTS.map((r) => [r, registerAnswer(r, "0xab").status]))).toEqual({ registered: 200, not_found: 404, used: 409, expired: 410, taken: 409 });
  });
  it("speaks of sending USDC only while USDC deposits are offered (no third-party USDC is solicited otherwise)", () => {
    expect(registerAnswer("registered", "0xab").message).toBe("wallet 0xab registered to this account");
    expect(registerAnswer("registered", "0xab", false).message).toBe("wallet 0xab registered to this account");
    expect(registerAnswer("registered", "0xab", true).message).toBe("wallet 0xab registered: USDC it sends to the receiving address is credited to this account");
    for (const r of REGISTER_RESULTS) expect(registerAnswer(r, "0xab").message, r).not.toMatch(/usdc|receiving address/i);
  });
  it("the published OpenAPI entries of the wallet routes do not invite USDC deposits either", () => {
    const paths = (openapi as { paths: Record<string, Record<string, { summary: string }>> }).paths;
    expect(paths["/v1/account/wallet/challenge"]!.get!.summary).toMatch(/^Issue a single-use wallet registration challenge \(valid \d+ minutes\) for a wallet this account controls\./);
    expect(paths["/v1/account/wallet"]!.post!.summary).toContain("USDC deposits are not offered unless GET /v1/payments/address answers");
    for (const p of ["/v1/account/wallet/challenge", "/v1/account/wallet"]) expect(JSON.stringify(paths[p]), p).not.toMatch(/sends USDC|send USDC|USDC it sends|receiving address/i);
  });
});

// ---- the routes -----------------------------------------------------------------------------------------------------

const env = { JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "60", SPOTLIGHT_SECRET: "eval-spotlight-v1", SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized", INTERNAL_HMAC_SECRET: "x", ADMIN_API_KEY: "x", EVAL_REPORT_KEY: "x" } as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await v1.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }, env, ctx);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("GET /v1/account/wallet/challenge and POST /v1/account/wallet", () => {
  let account: ReturnType<typeof privateKeyToAccount>;
  beforeEach(() => {
    account = privateKeyToAccount(generatePrivateKey());
    h.db = fakeDb({
      tenants: [
        { id: T1, display_name: "t1", plan: "payg", credits_balance: 0, wallet_address: OLD_WALLET, deleted_at: null },
        { id: T2, display_name: "t2", plan: "payg", credits_balance: 0, wallet_address: null, deleted_at: null },
      ],
      wallet_challenges: [], api_request_log: [],
    }, {}, { rpc: MONEY_RPCS });
  });
  const challenge = async (address = account.address) => (await call("GET", `/account/wallet/challenge?address=${address}`)).body.data as Record<string, string>;
  const sign = (ch: Record<string, string>, by = account) => by.signMessage({ message: ch.message! });

  it("issues a single-use challenge whose stored message is exactly the one returned", async () => {
    const r = await call("GET", `/account/wallet/challenge?address=${account.address}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.address).toBe(account.address.toLowerCase());
    expect(d.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(d.message).toBe(challengeMessage({ tenantId: T1, address: account.address, nonce: d.nonce, issuedAt: d.issued_at }));
    expect(h.db.tables.wallet_challenges).toEqual([expect.objectContaining({ id: d.challenge_id, tenant_id: T1, address: d.address, nonce: d.nonce, message: d.message })]);
  });

  it("refuses a missing or malformed address and stores nothing", async () => {
    for (const q of ["", "?address=", "?address=0x123", `?address=${account.address}00`, "?address=0xZZ00000000000000000000000000000000000000"]) {
      expect((await call("GET", `/account/wallet/challenge${q}`)).status).toBe(400);
    }
    expect(h.db.tables.wallet_challenges).toHaveLength(0);
  });

  it("registers the signing wallet (lowercase), replacing the previous one, and GET /v1/account shows it", async () => {
    const ch = await challenge();
    const r = await call("POST", "/account/wallet", { challenge_id: ch.challenge_id, signature: await sign(ch) });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ wallet_address: account.address.toLowerCase(), previous_wallet_address: OLD_WALLET, registered: true });
    expect(h.db.tables.tenants![0]!.wallet_address).toBe(account.address.toLowerCase());
    expect(h.db.tables.wallet_challenges![0]).toMatchObject({ used_at: expect.any(String), replaced_address: OLD_WALLET });
    expect((await call("GET", "/account")).body.data.tenant.wallet_address).toBe(account.address.toLowerCase());
  });

  it("while USDC deposits are not offered (the default), neither answer invites USDC; exactly \"1\" restores the deposit wording", async () => {
    const ch = await challenge();
    expect(ch.sign).toBe("EIP-191 personal_sign of `message`, exactly as given, with the wallet at `address`");
    const r = await call("POST", "/account/wallet", { challenge_id: ch.challenge_id, signature: await sign(ch) });
    expect(r.body.data.message).toBe(`wallet ${account.address.toLowerCase()} registered to this account`);
    for (const v of [JSON.stringify(ch), JSON.stringify(r.body)]) expect(v).not.toMatch(/usdc|receiving address/i);
    const offered = { ...env, USDC_DEPOSITS_OFFERED: "1" } as unknown as Env;
    const on = async (method: string, path: string, body?: unknown) => (await (await v1.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }, offered, ctx)).json()) as Record<string, any>;
    const ch2 = (await on("GET", `/account/wallet/challenge?address=${account.address}`)).data as Record<string, string>;
    expect(ch2.sign).toContain("(the one that will send USDC)");
    expect((await on("POST", "/account/wallet", { challenge_id: ch2.challenge_id, signature: await sign(ch2) })).data.message).toContain("USDC it sends to the receiving address is credited to this account");
  });

  it("a replayed challenge is 409 challenge_used, even with the same valid signature", async () => {
    const ch = await challenge();
    const signature = await sign(ch);
    expect((await call("POST", "/account/wallet", { challenge_id: ch.challenge_id, signature })).status).toBe(200);
    const again = await call("POST", "/account/wallet", { challenge_id: ch.challenge_id, signature });
    expect([again.status, again.body.error_reason]).toEqual([409, "challenge_used"]);
  });

  it("an expired challenge is 410 and registers nothing", async () => {
    const ch = await challenge();
    h.db.tables.wallet_challenges![0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    const r = await call("POST", "/account/wallet", { challenge_id: ch.challenge_id, signature: await sign(ch) });
    expect([r.status, r.body.error_reason]).toEqual([410, "challenge_expired"]);
    expect(h.db.tables.tenants![0]!.wallet_address).toBe(OLD_WALLET);
  });

  it("a signature by another wallet is 400 bad_signature and leaves the challenge usable", async () => {
    const ch = await challenge();
    const bad = await call("POST", "/account/wallet", { challenge_id: ch.challenge_id, signature: await sign(ch, privateKeyToAccount(generatePrivateKey())) });
    expect([bad.status, bad.body.error_reason]).toEqual([400, "bad_signature"]);
    expect(h.db.tables.wallet_challenges![0]!.used_at).toBeNull();
    expect((await call("POST", "/account/wallet", { challenge_id: ch.challenge_id, signature: await sign(ch) })).status).toBe(200);
  });

  it("an address another tenant holds is 409 wallet_taken; nothing changes and the challenge stays unused", async () => {
    h.db.tables.tenants![1]!.wallet_address = account.address.toLowerCase();
    const ch = await challenge();
    const r = await call("POST", "/account/wallet", { challenge_id: ch.challenge_id, signature: await sign(ch) });
    expect([r.status, r.body.error_reason]).toEqual([409, "wallet_taken"]);
    expect(h.db.tables.tenants![0]!.wallet_address).toBe(OLD_WALLET);
    expect(h.db.tables.wallet_challenges![0]!.used_at).toBeNull();
  });

  it("another tenant's challenge is 404; a malformed body is 400", async () => {
    const ch = await challenge();
    h.db.tables.wallet_challenges![0]!.tenant_id = T2;
    expect((await call("POST", "/account/wallet", { challenge_id: ch.challenge_id, signature: await sign(ch) })).status).toBe(404);
    expect((await call("POST", "/account/wallet", { challenge_id: "nope", signature: "0x00" })).status).toBe(400);
    expect((await call("POST", "/account/wallet", { challenge_id: ch.challenge_id, signature: await sign(ch), extra: 1 })).status).toBe(400);
  });

  it("the database's own single-use check wins a race the read did not see: 409, not a second registration", async () => {
    const ch = await challenge();
    const signature = await sign(ch);
    const rpc = h.db.options.rpc!.register_wallet!;
    h.db.options.rpc!.register_wallet = async (db, a) => { db.tables.wallet_challenges![0]!.used_at = new Date().toISOString(); return rpc(db, a); };
    const r = await call("POST", "/account/wallet", { challenge_id: ch.challenge_id, signature });
    expect([r.status, r.body.error_reason]).toEqual([409, "challenge_used"]);
    expect(h.db.tables.tenants![0]!.wallet_address).toBe(OLD_WALLET);
  });
});

describe("GET /v1/payments/address quotes the tiers the database credits at", () => {
  // USDC deposits switched on (the founder's switch; off by default, tests/money-events.test.ts covers the refusal)
  const withAddress = { ...env, USDC_DEPOSITS_OFFERED: "1", USDC_RECEIVING_ADDRESS: "0x00000000000000000000000000000000000000ee", CREDITS_PER_USDC: "100" } as unknown as Env;
  const get = async () => { const res = await v1.request("/payments/address", { method: "GET" }, withAddress, ctx); return { status: res.status, body: (await res.json()) as Record<string, any> }; };
  beforeEach(() => {
    vi.mocked(alert).mockClear();
    h.db = fakeDb({ tenants: [{ id: T1, wallet_address: OLD_WALLET, deleted_at: null }], app_config: structuredClone(MIGRATION_020_CONFIG), api_request_log: [] });
  });

  it("the payg tiers, the plan §11 packs they buy, the base rate and how to register the sender wallet", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      registered_sender_wallet: OLD_WALLET, credits_per_usdc: 100,
      payg_tiers: [{ min_usdc: 1000, credits_per_usdc: 120 }, { min_usdc: 250, credits_per_usdc: 110 }, { min_usdc: 0, credits_per_usdc: 100 }],
      packs: [{ usdc: "50", credits: 5_000, credits_per_usdc: 100 }, { usdc: "250", credits: 27_500, credits_per_usdc: 110 }, { usdc: "1000", credits: 120_000, credits_per_usdc: 120 }],
    });
    expect(r.body.data.register_wallet).toContain("GET /v1/account/wallet/challenge");
  });
  it("without payg_tiers: the flat rate credit_from_deposit is passed", async () => {
    h.db.tables.app_config = [];
    const r = await get();
    expect(r.body.data).toMatchObject({ credits_per_usdc: 100, payg_tiers: [{ min_usdc: 0, credits_per_usdc: 100 }], packs: [{ usdc: "50", credits: 5_000 }, { usdc: "250", credits: 25_000 }, { usdc: "1000", credits: 100_000 }] });
  });
  it("tiers the database would refuse are never quoted: 503 and an alert", async () => {
    h.db.tables.app_config![0]!.value = '[{"min_usdc":0,"credits_per_usdc":100},{"min_usdc":250,"credits_per_usdc":90}]';
    const r = await get();
    expect(r.status).toBe(503);
    expect(vi.mocked(alert).mock.calls.map((c) => c[1])).toEqual(["payg_tiers_invalid"]);
  });
});

/**
 * Registration-time source checks (src/markets/source-checks.ts) against a stubbed fetch: the Solana account check
 * (exists, not a program, 5 s timeout, any failure to ask = could not verify), the per-registration subrequest budget
 * refused before any request, and a Base RPC failure that refuses instead of storing an unsupported_source market.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { checkSources, verifySolanaAccount, sourceCheckCost, REGISTRATION_CHECK_BUDGET, SOURCE_CHECK_SUBREQUESTS, SOLANA_VERIFY_TIMEOUT_MS } from "../src/markets/source-checks";
import { RegistrationError } from "../src/markets/policy";
import { validateRegistration } from "../src/markets/register";
import { __setRailsForMutationTesting } from "../src/resolve/rails";

const RPC = "https://solana-rpc.test.invalid/";
const ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const ENV = { SOLANA_FALLBACK_HTTP_URL: RPC, BASE_FALLBACK_HTTP_URL: "https://base-rpc.test.invalid/" } as unknown as Env;
const NOW = Date.parse("2026-09-24T12:00:00Z");

afterEach(() => { vi.unstubAllGlobals(); __setRailsForMutationTesting([]); });

function rpcStub(answer: (method: string) => Response | "timeout" | "network") {
  const calls: Array<{ url: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), body, signal: init?.signal });
    const a = answer(String(body.method));
    if (a === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (a === "network") throw new TypeError("fetch failed");
    return a;
  }));
  return calls;
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const account = (value: unknown) => json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } });

const market = (sources: unknown[], extra: Record<string, unknown> = {}) => validateRegistration({
  platform: "custom", external_id: "t-1", condition: "Resolves Yes if the watched source shows the event.", event_statement: "The watched event happened",
  option_a: "Yes", option_b: "No", positive_option: "OPTION_A", anchors: ["event"], sources, open_at: "2026-09-01T00:00:00Z", deadline_utc: "2026-12-31T00:00:00Z", ...extra,
});

describe("verifySolanaAccount", () => {
  it("accepts an existing, non-executable account, asking getAccountInfo with an empty data slice and a timeout", async () => {
    const calls = rpcStub(() => account({ executable: false, owner: "11111111111111111111111111111111", lamports: 1 }));
    expect(await verifySolanaAccount(RPC, ACCOUNT)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ method: "getAccountInfo", params: [ACCOUNT, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }] });
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(SOLANA_VERIFY_TIMEOUT_MS).toBe(5000);
  });

  it("refuses a program id and an account that does not exist", async () => {
    rpcStub(() => account({ executable: true, owner: "BPFLoaderUpgradeab1e11111111111111111111111", lamports: 1 }));
    expect(await verifySolanaAccount(RPC, ACCOUNT)).toMatchObject({ ok: false, refusal: "invalid", message: expect.stringContaining("executable program id") });
    rpcStub(() => account(null));
    expect(await verifySolanaAccount(RPC, ACCOUNT)).toMatchObject({ ok: false, refusal: "invalid", message: expect.stringContaining("does not exist") });
  });

  it("any failure to ask is could-not-verify, never an acceptance", async () => {
    const cases: Array<[string, () => Response | "timeout" | "network", string]> = [
      ["HTTP 503", () => new Response("down", { status: 503 }), "HTTP 503"],
      ["HTTP 429", () => new Response("slow down", { status: 429 }), "HTTP 429"],
      ["RPC error", () => json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limited" } }), "-32005"],
      ["no value field", () => json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 } } }), "without a value"],
      ["no executable flag", () => account({ owner: "x", lamports: 1 }), "without executable"],
      ["timeout", () => "timeout", "timed out"],
      ["network", () => "network", "failed"],
      ["not JSON", () => new Response("<html>", { status: 200 }), "failed"],
    ];
    for (const [name, answer, detail] of cases) {
      rpcStub(answer);
      expect(await verifySolanaAccount(RPC, ACCOUNT), name).toMatchObject({ ok: false, refusal: "unverified", message: expect.stringContaining(detail) });
    }
  });
});

describe("checkSources", () => {
  it("prices each kind's worst case and refuses a registration over the budget before any request", async () => {
    expect(SOURCE_CHECK_SUBREQUESTS.web_fetch).toBe(6);
    expect(sourceCheckCost([{ kind: "base_log" }, { kind: "web_fetch" }])).toBeLessThanOrEqual(REGISTRATION_CHECK_BUDGET);
    const calls = rpcStub(() => new Response(null, { status: 404 }));
    const web = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "web_fetch", ref: `https://s${i}.acme-widget.example/` }));
    await expect(checkSources(ENV, { botUa: "ResolveBot/1.0" }, market(web(6)), NOW)).rejects.toMatchObject({ refusal: { kind: "invalid", message: expect.stringContaining("upstream requests") } });
    await expect(checkSources(ENV, { botUa: "ResolveBot/1.0" }, market([{ kind: "base_log", ref: `base:0x${"1".repeat(40)}` }, { kind: "base_log", ref: `base:0x${"2".repeat(40)}` }]), NOW)).rejects.toBeInstanceOf(RegistrationError);
    expect(calls).toHaveLength(0);
    const plan = await checkSources(ENV, { botUa: "ResolveBot/1.0" }, market(web(5)), NOW);
    expect(plan).toMatchObject({ status: "open", reasons: [] });
    expect(plan.watches).toHaveLength(5);
    expect(calls).toHaveLength(5);
  });

  it("a Base RPC failure refuses the registration as unverified instead of storing an unsupported_source market", async () => {
    rpcStub(() => new Response("bad gateway", { status: 502 }));
    await expect(checkSources(ENV, { botUa: "ResolveBot/1.0" }, market([{ kind: "base_log", ref: `base:0x${"1".repeat(40)}` }]), NOW))
      .rejects.toMatchObject({ refusal: { kind: "unverified", message: expect.stringContaining("could not verify the contract") } });
  });

  it("a Solana program id refuses the registration; with the rail off the account is not asked", async () => {
    const calls = rpcStub(() => account({ executable: true }));
    await expect(checkSources(ENV, { botUa: "ResolveBot/1.0" }, market([{ kind: "solana_log", ref: `solana:${ACCOUNT}` }]), NOW)).rejects.toMatchObject({ refusal: { kind: "invalid" } });
    __setRailsForMutationTesting(["registration_policy"]);
    expect((await checkSources(ENV, { botUa: "ResolveBot/1.0" }, market([{ kind: "solana_log", ref: `solana:${ACCOUNT}` }]), NOW)).status).toBe("open");
    expect(calls).toHaveLength(1);
  });

  it("builds the watch rows: refs normalized, 300 s cadence, 60 s inside the last 24 h and for official_release", async () => {
    rpcStub(() => account({ executable: false }));
    const plan = await checkSources(ENV, { botUa: "ResolveBot/1.0" }, market([{ kind: "github_api", ref: "/repos/acme/widget/pulls/42" }, { kind: "solana_log", ref: `solana:${ACCOUNT}` }]), NOW);
    expect(plan.watches).toEqual([
      { source_kind: "github_api", source_ref: { ref: "repos/acme/widget/pulls/42" }, cursor: {}, poll_interval_s: 300 },
      { source_kind: "solana_log", source_ref: { chain: "solana", account: ACCOUNT }, cursor: { from_ts: "2026-09-01T00:00:00Z" }, poll_interval_s: 300 },
    ]);
    const soon = await checkSources(ENV, { botUa: "ResolveBot/1.0" }, market([{ kind: "github_api", ref: "repos/acme/widget/pulls/42" }], { deadline_utc: "2026-09-25T06:00:00Z" }), NOW);
    expect(soon.watches[0]!.poll_interval_s).toBe(60);
  });
});

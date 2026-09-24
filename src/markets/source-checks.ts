/**
 * Registration-time checks against each source itself, run after the policy (src/markets/policy.ts) and before the
 * database: robots.txt for web pages, contract code and the opening block for Base, the account for Solana. Their
 * result is the watch plan register_market stores (migration 019). evals/registration.ts runs this module against a
 * stubbed fetch.
 *
 * Subrequests (Workers Free: 50 per invocation). POST /v1/markets spends at most 13 outside these checks: auth 5
 * (Cache API match and put, api_keys read, usage bump, check_gates), the idempotency lookup 1 (2 when it finds the
 * market: its watches), register_market 1, the request log insert 1 in waitUntil and that insert's failure alert 5.
 * The checks' worst case per source is SOURCE_CHECK_SUBREQUESTS; a registration whose sum exceeds
 * REGISTRATION_CHECK_BUDGET is refused before any request, so no registration can die of "Too many subrequests"
 * half-way through its checks.
 */
import type { Env, Config } from "../env";
import type { MarketRegistration, WatchSourceKind } from "../resolve/schema";
import { BASE_LOG_REF, SOLANA_LOG_REF } from "../resolve/schema";
import { railEnabled } from "../resolve/rails";
import { robotsAllows, ROBOTS_SUBREQUESTS } from "../ingest/robots";
import { baseCallUrl, getBlock, blockAtOrAfter, hasCode } from "../ingest/base";
import { solanaRpcUrl } from "../ingest/solana";
import { discardBody } from "../ingest/http";
import { parseOfficialRef } from "../resolve/official";
import { RegistrationError } from "./policy";

/** One watch as register_market inserts it. */
export interface WatchSpec { source_kind: WatchSourceKind; source_ref: Record<string, unknown>; cursor: Record<string, unknown>; poll_interval_s: number }
export interface SourcePlan { status: "open" | "unsupported_source"; reasons: string[]; watches: WatchSpec[] }

/**
 * blockAtOrAfter() bisects [0, safe]: ceil(log2(safe + 1)) eth_getBlockByNumber calls, 26 at Base's ~50M blocks of
 * September 2026 and 27 until block 134M.
 */
const BASE_BISECT_STEPS = 27;
/** Worst-case subrequests of each kind's registration-time check. */
export const SOURCE_CHECK_SUBREQUESTS: Readonly<Record<WatchSourceKind, number>> = {
  web_fetch: ROBOTS_SUBREQUESTS,
  web_render: 0,
  base_log: 2 + BASE_BISECT_STEPS, // safe block + eth_getCode + the bisection
  solana_log: 1, // getAccountInfo
  github_api: 0,
  github_events: 0,
  official_release: 0,
};
/** 50 - the 13 above = 37, less 2 spare: one base_log and one web page (35), or five web pages (30), fit one registration. */
export const REGISTRATION_CHECK_BUDGET = 35;

export function sourceCheckCost(sources: ReadonlyArray<{ kind: WatchSourceKind }>): number {
  return sources.reduce((n, s) => n + SOURCE_CHECK_SUBREQUESTS[s.kind], 0);
}

export const SOLANA_VERIFY_TIMEOUT_MS = 5000;
export type AccountCheck = { ok: true } | { ok: false; refusal: "invalid" | "unverified"; message: string };

/**
 * Plan §8: a Solana watch names a specific account or PDA, never a program id. getAccountInfo must show an account
 * that exists and is not executable. Any failure to ask (HTTP error, RPC error, timeout, an answer without a value
 * field) is "could not verify": the registration is refused, never accepted unverified. dataSlice keeps the answer
 * small whatever the account holds.
 */
export async function verifySolanaAccount(url: string, account: string): Promise<AccountCheck> {
  const unverified = (why: string): AccountCheck => ({ ok: false, refusal: "unverified", message: `solana account ${account}: could not verify (${why}); nothing was registered, retry later` });
  let body: { result?: { value?: { executable?: unknown } | null }; error?: { code?: number; message?: string } };
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "ResolveBot/1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [account, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }] }),
      signal: AbortSignal.timeout(SOLANA_VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) { await discardBody(res); return unverified(`getAccountInfo HTTP ${res.status}`); }
    body = (await res.json()) as typeof body;
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return unverified(timeout ? `getAccountInfo timed out after ${SOLANA_VERIFY_TIMEOUT_MS} ms` : `getAccountInfo failed: ${String(e).slice(0, 120)}`);
  }
  if (body.error) return unverified(`getAccountInfo error ${body.error.code ?? "?"} ${String(body.error.message ?? "").slice(0, 120)}`);
  if (!body.result || !("value" in body.result)) return unverified("getAccountInfo answered without a value");
  const v = body.result.value;
  if (v === null || v === undefined) return { ok: false, refusal: "invalid", message: `solana account ${account} does not exist; a watch needs an existing account` };
  if (v.executable === true) return { ok: false, refusal: "invalid", message: `solana account ${account} is an executable program id; register the account or PDA the program writes to (plan §8)` };
  if (v.executable !== false) return unverified("getAccountInfo answered without executable");
  return { ok: true };
}

/**
 * Probe every source and build the watch plan. A source a probe rules out (robots disallow, no contract code) makes
 * the market unsupported_source with a reason, as before; a probe that could not be made refuses the whole
 * registration (RegistrationError "unverified", nothing stored), because an unsupported_source market would be
 * returned as-is by every retry of the same registration.
 */
export async function checkSources(env: Env, cfg: Pick<Config, "botUa">, reg: MarketRegistration, now = Date.now()): Promise<SourcePlan> {
  const cost = sourceCheckCost(reg.sources);
  if (cost > REGISTRATION_CHECK_BUDGET) {
    throw new RegistrationError({ kind: "invalid", message: `the registration-time checks of these sources need up to ${cost} upstream requests and one request allows ${REGISTRATION_CHECK_BUDGET} (base_log ${SOURCE_CHECK_SUBREQUESTS.base_log}, web ${SOURCE_CHECK_SUBREQUESTS.web_fetch}, solana ${SOURCE_CHECK_SUBREQUESTS.solana_log}); register fewer web or chain sources per market` });
  }
  const reasons: string[] = [];
  const specs: Array<Omit<WatchSpec, "poll_interval_s">> = [];
  let refusedOne = false;
  for (const s of reg.sources) {
    switch (s.kind) {
      case "web_fetch": case "web_render": {
        const r = await robotsAllows(s.ref, cfg.botUa);
        if (!r.allowed) { refusedOne = true; reasons.push(`${s.ref}: ${r.reason}`); break; }
        specs.push({ source_kind: s.kind, source_ref: { url: s.ref }, cursor: {} });
        break;
      }
      case "base_log": {
        const address = (BASE_LOG_REF.exec(s.ref)?.[1] ?? s.ref.split(":")[1] ?? "").toLowerCase();
        const url = baseCallUrl(env);
        let openBlock: number | null;
        try {
          const safe = await getBlock(url, "safe");
          openBlock = (await hasCode(url, address)) ? await blockAtOrAfter(url, reg.open_at, safe) : null;
        } catch (e) {
          throw new RegistrationError({ kind: "unverified", message: `base_log ${address}: could not verify the contract (${String(e).slice(0, 120)}); nothing was registered, retry later` });
        }
        if (openBlock === null) { refusedOne = true; reasons.push(`${address}: no contract code at safe tag`); break; }
        const topic0 = reg.resolver?.kind === "evm_log_present" ? reg.resolver.topic0.toLowerCase() : null;
        specs.push({ source_kind: "base_log", source_ref: { chain: "base", address, topic0 }, cursor: { block: openBlock - 1, from_ts: reg.open_at, has_code: true } });
        break;
      }
      case "solana_log": {
        const account = SOLANA_LOG_REF.exec(s.ref)?.[1] ?? s.ref.split(":")[1] ?? "";
        if (railEnabled("registration_policy")) {
          const a = await verifySolanaAccount(solanaRpcUrl(env), account);
          if (!a.ok) throw new RegistrationError({ kind: a.refusal, message: a.message });
        }
        specs.push({ source_kind: "solana_log", source_ref: { chain: "solana", account }, cursor: { from_ts: reg.open_at } });
        break;
      }
      case "official_release": {
        // The adapter fetches only the series' allowlisted hosts (src/resolve/official.ts); nothing to probe here.
        const p = parseOfficialRef(s.ref)!;
        specs.push({ source_kind: "official_release", source_ref: { ref: s.ref, series: p.series, period: p.period }, cursor: {} });
        break;
      }
      case "github_api": case "github_events":
        specs.push({ source_kind: s.kind, source_ref: { ref: s.ref.replace(/^\/+/, "") }, cursor: {} });
        break;
      default: { const never: never = s.kind; throw new Error(`unhandled source kind ${String(never)}`); }
    }
  }
  // As before 019: one refused source makes the whole market unsupported_source, and it gets no watch at all.
  if (refusedOne || !specs.length) return { status: "unsupported_source", reasons, watches: [] };
  const nearDeadline = Date.parse(reg.deadline_utc) - now < 24 * 3600 * 1000;
  // official_release schedules its own next_poll_at (release minute, then its cadence); 60 s is the retry interval
  // the lease applies after a failed poll.
  return { status: "open", reasons, watches: specs.map((w) => ({ ...w, poll_interval_s: w.source_kind === "official_release" || nearDeadline ? 60 : 300 })) };
}

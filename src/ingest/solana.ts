import type { Env } from "../env";
import type { WatchRow, FetchOutcome } from "./types";
import { rpc } from "./base";

export function solanaRpcUrl(env: Env): string {
  return env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : env.SOLANA_FALLBACK_HTTP_URL || "https://api.mainnet-beta.solana.com";
}

interface SigInfo { signature: string; slot: number; blockTime: number | null; err: unknown }

/** Poll new signatures for a specific account (never a program id); at most 20 getTransaction calls per tick. */
export async function fetchSolanaSignatures(env: Env, watch: WatchRow, maxTx = 20): Promise<FetchOutcome> {
  const url = solanaRpcUrl(env);
  const account = String(watch.source_ref.account ?? "");
  if (account.length < 32) return { error: "source_ref.account invalid" };
  const t0 = new Date().toISOString();
  try {
    let accountExists = watch.cursor.account_exists as boolean | undefined;
    if (accountExists === undefined) {
      const info = await rpc<{ value: unknown }>(url, "getAccountInfo", [account, { encoding: "base64" }]);
      accountExists = info?.value !== null && info?.value !== undefined;
    }
    const params: Record<string, unknown> = { limit: 25 };
    if (watch.cursor.sig) params.until = watch.cursor.sig;
    const sigs = await rpc<SigInfo[]>(url, "getSignaturesForAddress", [account, params]);
    const now = new Date().toISOString();
    if (!sigs.length) return { notModified: true, window: { from: String(watch.cursor.to_ts ?? now), to: now, status: "ok" }, cursor: { ...watch.cursor, account_exists: accountExists, to_ts: now } };
    const backlog = sigs.length > maxTx;
    const take = sigs.slice(-maxTx); // oldest of the new batch first when backlogged (list is newest-first)
    const decorated: Array<Record<string, unknown>> = [];
    for (const s of take.reverse()) {
      let logs: string[] = [];
      try {
        const tx = await rpc<{ meta?: { logMessages?: string[] } }>(url, "getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
        logs = tx?.meta?.logMessages ?? [];
      } catch (e) { return { error: `solana getTransaction: ${String(e).slice(0, 120)}` }; }
      const instr = logs.map((l) => /Instruction: (\w+)/.exec(l)?.[1]).filter(Boolean).map((x) => String(x).toLowerCase());
      decorated.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, err: s.err ?? null, discriminator: instr[0] ?? null, instructions: instr, logs: logs.slice(0, 40) });
    }
    const newest = sigs[0]!;
    const toTs = newest.blockTime ? new Date(newest.blockTime * 1000).toISOString() : now;
    const structured = { chain: "solana", account, account_exists: accountExists, signatures: decorated, backlog };
    const text = JSON.stringify(structured);
    return {
      evidence: { source_kind: "solana_log", text, structured, observed_at: toTs, fetched_at: t0, coverage: { account_exists: accountExists, backlog }, provenance: { chain: "solana", account, until: watch.cursor.sig ?? null, newest: newest.signature, rpc: env.HELIUS_API_KEY ? "helius" : "public" } },
      rawBytes: new TextEncoder().encode(text),
      window: { from: String(watch.cursor.to_ts ?? toTs), to: toTs, status: "ok" },
      cursor: { ...watch.cursor, sig: backlog ? take[take.length - 1]!.signature : newest.signature, to_ts: toTs, account_exists: accountExists },
      backlog,
    };
  } catch (e) {
    return { error: `solana rpc: ${String(e).slice(0, 160)}` };
  }
}

import type { Env, Config } from "../env";
import { db } from "../db/supabase";
import { MarketRegistration, type MarketRegistration as Reg } from "../resolve/schema";
import { robotsAllows } from "../ingest/web";
import { baseRpcUrl, getBlock, blockAtOrAfter, hasCode } from "../ingest/base";

export interface RegisterResult { marketId: string; status: "open" | "unsupported_source"; reasons: string[]; watches: Array<{ id: string; source_kind: string }> }

/** Validate, run registration-time source checks (robots, contract code), insert the market and one watch per source. */
export async function registerMarket(env: Env, cfg: Config, input: unknown, tenantId: string | null): Promise<RegisterResult> {
  const reg: Reg = MarketRegistration.parse(input);
  const client = db(env);
  const reasons: string[] = [];
  let status: "open" | "unsupported_source" = "open";
  const watchSpecs: Array<{ source_kind: Reg["sources"][number]["kind"]; source_ref: Record<string, unknown>; cursor: Record<string, unknown> }> = [];
  for (const s of reg.sources) {
    if (s.kind === "web_fetch" || s.kind === "web_render") {
      const r = await robotsAllows(s.ref, cfg.botUa);
      if (!r.allowed) { status = "unsupported_source"; reasons.push(`${s.ref}: ${r.reason}`); continue; }
      watchSpecs.push({ source_kind: s.kind, source_ref: { url: s.ref }, cursor: {} });
    } else if (s.kind === "base_log") {
      const address = s.ref.split(":")[1]?.toLowerCase() ?? "";
      const url = baseRpcUrl(env);
      try {
        const safe = await getBlock(url, "safe");
        const code = await hasCode(url, address);
        if (!code) { status = "unsupported_source"; reasons.push(`${address}: no contract code at safe tag`); continue; }
        const openBlock = await blockAtOrAfter(url, reg.open_at, safe);
        const topic0 = reg.resolver?.kind === "evm_log_present" ? reg.resolver.topic0.toLowerCase() : null;
        watchSpecs.push({ source_kind: "base_log", source_ref: { chain: "base", address, topic0 }, cursor: { block: openBlock - 1, from_ts: reg.open_at, has_code: true } });
      } catch (e) { status = "unsupported_source"; reasons.push(`${address}: rpc failed at registration (${String(e).slice(0, 80)})`); }
    } else if (s.kind === "solana_log") {
      const account = s.ref.split(":")[1] ?? "";
      watchSpecs.push({ source_kind: "solana_log", source_ref: { chain: "solana", account }, cursor: { from_ts: reg.open_at } });
    } else {
      watchSpecs.push({ source_kind: s.kind, source_ref: { ref: s.ref.replace(/^\/+/, "") }, cursor: {} });
    }
  }
  if (!watchSpecs.length) status = "unsupported_source";
  const { data: m, error } = await client.from("markets").insert({
    tenant_id: tenantId, platform: reg.platform, external_id: reg.external_id, condition: reg.condition, event_statement: reg.event_statement,
    option_a: reg.option_a, option_b: reg.option_b, positive_option: reg.positive_option, anchors: reg.anchors, sources: reg.sources,
    resolver: reg.resolver ?? null, negative_rule: reg.negative_rule, allow_prerelease: reg.allow_prerelease, open_at: reg.open_at, deadline_utc: reg.deadline_utc,
    grace_seconds: reg.grace_seconds, status, meta: { registration_reasons: reasons },
  }).select("id").single();
  if (error || !m) throw new Error(`markets insert: ${error?.message ?? "no row"}`);
  const nearDeadline = Date.parse(reg.deadline_utc) - Date.now() < 24 * 3600 * 1000;
  const watches: RegisterResult["watches"] = [];
  if (status === "open") {
    for (const w of watchSpecs) {
      const { data, error: we } = await client.from("watches").insert({ market_id: m.id, source_kind: w.source_kind, source_ref: w.source_ref, cursor: w.cursor, poll_interval_s: nearDeadline ? 60 : 300, next_poll_at: new Date().toISOString() }).select("id, source_kind").single();
      if (we || !data) throw new Error(`watches insert: ${we?.message ?? "no row"}`);
      watches.push({ id: data.id as string, source_kind: data.source_kind as string });
    }
  }
  return { marketId: m.id as string, status, reasons, watches };
}

/**
 * Reconcile shadow verdicts against the platform of record, then reveal.
 * Polymarket: gamma-api (no auth). Limitless: pending an API key (returns pending).
 */
import type { Env } from "../env";
import { db } from "../db/supabase";
import { revealVerdict } from "../bot/commit";
import type { MarketRow } from "../ingest/types";

interface Official { outcome: "OPTION_A" | "OPTION_B" | "VOID" | null; at: string | null; source_url: string | null; detail: string }

async function polymarketOfficial(m: MarketRow): Promise<Official> {
  const url = `https://gamma-api.polymarket.com/markets/${encodeURIComponent(m.external_id)}`;
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "ResolveBot/1.0" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return { outcome: null, at: null, source_url: url, detail: `gamma ${res.status}` };
  const j = (await res.json()) as Record<string, unknown>;
  const parseArr = (v: unknown): string[] => { if (Array.isArray(v)) return v.map(String); try { const a = JSON.parse(String(v)); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
  const outcomes = parseArr(j.outcomes); const prices = parseArr(j.outcomePrices);
  const closed = j.closed === true; const uma = String(j.umaResolutionStatus ?? "");
  if (!closed || (uma && uma !== "resolved")) return { outcome: null, at: null, source_url: url, detail: `closed=${closed} uma=${uma || "n/a"}` };
  const win = prices.findIndex((p) => Number(p) >= 0.99);
  if (win < 0) return { outcome: null, at: null, source_url: url, detail: `no winning price in ${prices.join(",")}` };
  const label = (outcomes[win] ?? "").toLowerCase();
  const optA = m.option_a.toLowerCase(), optB = m.option_b.toLowerCase();
  const outcome = label && (optA === label || optA.startsWith(label)) ? "OPTION_A" : label && (optB === label || optB.startsWith(label)) ? "OPTION_B" : win === 0 ? "OPTION_A" : "OPTION_B";
  const at = typeof j.closedTime === "string" ? new Date(j.closedTime).toISOString() : typeof j.endDate === "string" ? new Date(j.endDate).toISOString() : null;
  return { outcome, at, source_url: `https://polymarket.com/event/${String(j.slug ?? "")}`, detail: `resolved ${outcomes[win]}` };
}

async function officialFor(env: Env, m: MarketRow): Promise<Official> {
  try {
    if (m.platform === "polymarket") return await polymarketOfficial(m);
    if (m.platform === "limitless") return { outcome: null, at: null, source_url: null, detail: env.LIMITLESS_API_KEY ? "limitless reconcile not implemented" : "LIMITLESS_API_KEY unset" };
    return { outcome: null, at: null, source_url: null, detail: "custom markets are reconciled manually" };
  } catch (e) { return { outcome: null, at: null, source_url: null, detail: String(e).slice(0, 120) }; }
}

export async function runReconcile(env: Env): Promise<{ checked: number; resolved: number; reveals: number; disagreements: number; errors: string[] }> {
  const client = db(env);
  const started = Date.now();
  const out = { checked: 0, resolved: 0, reveals: 0, disagreements: 0, errors: [] as string[] };
  const { data: markets } = await client.from("markets").select("*").is("tenant_id", null).eq("status", "open").in("platform", ["polymarket", "limitless"]).is("deleted_at", null).lte("deadline_utc", new Date(Date.now() + 6 * 3600_000).toISOString()).order("deadline_utc").limit(25);
  for (const raw of markets ?? []) {
    const m = raw as unknown as MarketRow;
    out.checked++;
    const off = await officialFor(env, m);
    if (!off.outcome) continue;
    out.resolved++;
    await client.from("markets").update({ status: off.outcome === "VOID" ? "void" : "resolved", official_outcome: off.outcome, official_resolved_at: off.at ?? new Date().toISOString(), official_source_url: off.source_url }).eq("id", m.id);
    const { data: commits } = await client.from("bot_posts").select("id, message_id, commitment_sha256, nonce, resolution_id, posted_at, resolutions(resolution_status, winning_outcome, confidence_score, caveats, thresholds_version, evidence_id)").eq("market_id", m.id).eq("kind", "commit").order("posted_at", { ascending: true });
    for (const c of commits ?? []) {
      const r = (c as unknown as { resolutions: { resolution_status: string; winning_outcome: string; confidence_score: number; caveats: string[]; thresholds_version: string; evidence_id: string | null } | null }).resolutions;
      if (!r || !c.resolution_id) continue;
      const agreement = off.outcome === "VOID" ? "void" : r.resolution_status !== "RESOLVED" ? "abstained" : r.winning_outcome === off.outcome ? "agree" : "disagree";
      if (agreement === "disagree") out.disagreements++;
      const lead = off.at ? Math.round((Date.parse(off.at) - Date.parse(c.posted_at as string)) / 1000) : null;
      await client.from("reconciliations").upsert({ resolution_id: c.resolution_id, market_id: m.id, platform: m.platform, official_outcome: off.outcome, official_at: off.at, agreement, lead_seconds: lead, source_url: off.source_url }, { onConflict: "resolution_id" });
      let canonical: string | null = null;
      if (r.evidence_id) { const { data: e } = await client.from("evidence").select("canonical_sha256").eq("id", r.evidence_id).maybeSingle(); canonical = (e?.canonical_sha256 as string) ?? null; }
      const rv = await revealVerdict(env, m, { id: c.id as string, message_id: c.message_id as number | null, commitment_sha256: c.commitment_sha256 as string, nonce: c.nonce as string, resolution_id: c.resolution_id as string }, { resolution_status: r.resolution_status, winning_outcome: r.winning_outcome, confidence_score: Number(r.confidence_score), caveats: r.caveats ?? [], thresholds_version: r.thresholds_version, canonical_sha256: canonical }, { outcome: off.outcome, at: off.at, source_url: off.source_url, agreement });
      if (rv.posted) out.reveals++;
    }
  }
  await client.from("loop_runs").insert({ loop_name: "settle_bot", verifier_name: "reconcile", verifier_ok: out.disagreements === 0, outcome: out.checked ? (out.resolved ? "success" : "no_op") : "no_op", rows_written: out.resolved, duration_ms: Date.now() - started, meta: out });
  return out;
}

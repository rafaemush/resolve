/**
 * Commit-reveal for shadow verdicts. The commit carries only a hash; the reveal
 * (a reply) carries the verdict and nonce so anyone can recompute the hash.
 */
import type { Env } from "../env";
import { db } from "../db/supabase";
import { sha256Hex } from "../resolve/text";
import { sendMessage, telegramConfigured } from "./telegram";
import type { Verdict } from "../resolve/schema";
import type { MarketRow } from "../ingest/types";

export const DISCLAIMER = "Informational signal, not financial advice, not an oracle of record.";

export function verdictSignature(v: Verdict): string {
  return `${v.resolution_status}|${v.winning_outcome}|${v.error_reason ?? ""}`;
}

export function commitmentInput(marketId: string, v: Verdict, nonce: string): string {
  return `${marketId}|${v.resolution_status}|${v.winning_outcome}|${v.confidence_score.toFixed(2)}|${v.caveats.join(",")}|${v.evidence?.canonical_sha256 ?? ""}|${v.thresholds_version}|${nonce}`;
}

export function marketTag(m: MarketRow): string { return `#${m.platform}-${m.external_id}`.replace(/[^#\w.-]/g, "_").slice(0, 60); }

/** Write the commit (and post it when a channel exists). Deduped per market + verdict signature. */
export async function commitVerdict(env: Env, market: MarketRow, resolutionId: string, v: Verdict): Promise<{ committed: boolean; posted: boolean; reason: string }> {
  const client = db(env);
  const dedup = `commit:${market.id}:${verdictSignature(v)}`;
  const { data: existing } = await client.from("bot_posts").select("id").eq("dedup_key", dedup).maybeSingle();
  if (existing) return { committed: false, posted: false, reason: "already committed for this verdict signature" };
  const nonce = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await sha256Hex(commitmentInput(market.id, v, nonce));
  const evSha = v.evidence?.raw_sha256 ?? "n/a";
  const text = `${marketTag(market)} | verdict committed | sha256 ${hash}\nevidence raw sha256 ${evSha}\n${new Date().toISOString()}\n${DISCLAIMER}`;
  let posted = false, message_id: number | null = null, date: string | null = null, channel: "telegram" | "none" = "none", error: string | undefined;
  if (telegramConfigured(env)) {
    const r = await sendMessage(env, text);
    posted = r.ok; message_id = r.message_id; date = r.date; channel = r.ok ? "telegram" : "none"; error = r.error;
  }
  const { error: ie } = await client.from("bot_posts").insert({
    resolution_id: resolutionId, market_id: market.id, channel, kind: "commit", message_id, telegram_date: date, commitment_sha256: hash, nonce,
    payload: { text, verdict_signature: verdictSignature(v), post_error: error ?? null, evidence_raw_sha256: evSha, canonical_sha256: v.evidence?.canonical_sha256 ?? null }, dedup_key: dedup,
  });
  if (ie) return { committed: false, posted, reason: `bot_posts insert: ${ie.message}` };
  return { committed: true, posted, reason: posted ? "posted" : (error ?? "recorded without channel") };
}

/** Reveal: reply to the commit with the verdict, nonce and the official outcome. */
export async function revealVerdict(env: Env, market: MarketRow, commit: { id: string; message_id: number | null; commitment_sha256: string; nonce: string; resolution_id: string }, v: { resolution_status: string; winning_outcome: string; confidence_score: number; caveats: string[]; thresholds_version: string; canonical_sha256: string | null }, official: { outcome: string; at: string | null; source_url: string | null; agreement: string }): Promise<{ posted: boolean; reason: string }> {
  const client = db(env);
  const dedup = `reveal:${commit.id}`;
  const { data: existing } = await client.from("bot_posts").select("id").eq("dedup_key", dedup).maybeSingle();
  if (existing) return { posted: false, reason: "already revealed" };
  const text = `${marketTag(market)} | reveal for commit ${commit.commitment_sha256.slice(0, 16)}…\nverdict ${v.resolution_status}/${v.winning_outcome} confidence ${v.confidence_score.toFixed(2)} caveats [${v.caveats.join(",")}]\nnonce ${commit.nonce} thresholds ${v.thresholds_version} canonical ${v.canonical_sha256 ?? "n/a"}\nofficial ${official.outcome}${official.at ? " at " + official.at : ""} → ${official.agreement}${official.source_url ? "\n" + official.source_url : ""}\n${DISCLAIMER}`;
  let posted = false, message_id: number | null = null, date: string | null = null, error: string | undefined;
  if (telegramConfigured(env) && commit.message_id) {
    const r = await sendMessage(env, text, { replyTo: commit.message_id });
    posted = r.ok; message_id = r.message_id; date = r.date; error = r.error;
  }
  await client.from("bot_posts").insert({ resolution_id: commit.resolution_id, market_id: market.id, channel: posted ? "telegram" : "none", kind: "reveal", message_id, reply_to_message_id: commit.message_id, telegram_date: date, commitment_sha256: commit.commitment_sha256, nonce: commit.nonce, payload: { text, official, post_error: error ?? null }, dedup_key: dedup });
  return { posted, reason: posted ? "posted" : (error ?? "recorded without channel") };
}

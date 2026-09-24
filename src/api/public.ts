import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { ok, err } from "./envelope";
import { db } from "../db/supabase";
import { CommittedVerdict, type Agreement, type OfficialRecord } from "../bot/commit";

type Vars = { requestId: string; schemaVersion: string };
export const pub = new Hono<{ Bindings: Env; Variables: Vars }>();

/** v_track_record columns that stay NULL until the row is reportable; the route prints the gate instead. */
export const GATED_COLUMNS = ["coverage_accuracy", "reconciled_accuracy", "precision", "abstention_rate", "wilson_low", "wilson_high", "event_precision", "event_wilson_low", "event_wilson_high"] as const;

/**
 * Pure. One v_track_record row as the route serves it: a gated percentage is replaced by the gate text until the view
 * marks the row reportable (100 reconciled distinct events on the platform, migration 017; the legs of a ladder are one
 * event).
 */
export function shapeTrackRecordRow(r: Record<string, unknown>): Record<string, unknown> {
  if (r.reportable === true) return r;
  const n = r.n_events_reconciled_cumulative ?? 0;
  const gate = `n_events=${n} (${r.n_reconciled_cumulative ?? r.n_reconciled ?? 0} markets), not yet reportable: percentages appear at 100 reconciled events`;
  return { ...r, ...Object.fromEntries(GATED_COLUMNS.map((k) => [k, gate])) };
}

/**
 * Public track record, rendered from v_track_record only, cached 60 s through the Cache API. Percentages (cumulative per
 * platform) are shown only once the view marks the row reportable (>= 100 reconciled distinct events on that platform).
 */
pub.get("/v1/track-record", async (c) => {
  const cacheKey = new Request(new URL("/v1/track-record", c.req.url).toString());
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;
  const { data, error } = await db(c.env).from("v_track_record").select("*").order("week", { ascending: false }).limit(52);
  if (error) return err(c, "UPSTREAM_UNAVAILABLE", "track record store unavailable", 503);
  const rows = (data ?? []).map((r) => shapeTrackRecordRow(r as Record<string, unknown>));
  const res = ok(c, { note: "Every number here is a database row; test markets are excluded and each market counts once, by its latest commit. The legs of one multi-outcome event (a ladder) are one event: n_events_* count events, and percentages are cumulative per platform and appear only once 100 events on that platform have been reconciled against the platform of record. precision (per market) and event_precision (an event is wrong if any of its resolved legs disagreed) carry 95 % Wilson intervals. median_lead_seconds uses the platform's own resolution time only; median_lead_seconds_poll uses the first poll that saw the outcome, so it overstates the lead by up to the poll delay. Any commitment can be checked at /v1/track-record/verify?hash=<sha256>. Informational signal, not financial advice, not an oracle of record.", rows });
  res.headers.set("Cache-Control", "public, max-age=60, s-maxage=60");
  c.executionCtx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
});

const VerifyQuery = z.object({ hash: z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hex characters") });

export interface VerifyCommit { id: string; commitment_sha256: string; nonce: string; created_at: string; channel: string; message_id: number | null; telegram_date: string | null; markets: { platform: string; external_id: string } | null }
export interface VerifyReveal { channel: string; message_id: number | null; telegram_date: string | null; payload: Record<string, unknown> }

/**
 * Pure. Before a reveal row exists the answer proves only that the commitment was recorded (and when it was posted):
 * the nonce, the preimage and the committed verdict are never returned, because with them anyone could learn the
 * verdict before the platform resolves. After the reveal, everything needed to recompute sha256(preimage).
 */
export function shapeVerify(commit: VerifyCommit, reveal: VerifyReveal | null): Record<string, unknown> {
  const base = {
    commitment_sha256: commit.commitment_sha256,
    market: commit.markets ? `${commit.markets.platform}:${commit.markets.external_id}` : null,
    committed_at: commit.created_at,
    posted: commit.channel === "telegram",
    posted_at: commit.telegram_date,
    message_id: commit.message_id,
    revealed: reveal !== null,
  };
  if (!reveal) return base;
  const committed = CommittedVerdict.safeParse(reveal.payload.committed);
  const official = (reveal.payload.official ?? null) as OfficialRecord | null;
  return {
    ...base,
    reveal_posted: reveal.channel === "telegram",
    reveal_message_id: reveal.message_id,
    preimage_version: committed.success ? committed.data.preimage_version : null,
    preimage: committed.success ? committed.data.preimage : null,
    nonce: commit.nonce,
    committed: committed.success ? { resolution_status: committed.data.resolution_status, winning_outcome: committed.data.winning_outcome, confidence_score: committed.data.confidence_score, caveats: committed.data.caveats, canonical_sha256: committed.data.canonical_sha256, raw_sha256: committed.data.raw_sha256, thresholds_version: committed.data.thresholds_version, determination_basis: committed.data.determination_basis } : null,
    official,
    agreement: (reveal.payload.agreement ?? null) as Agreement | null,
    how_to_verify: "sha256(preimage) must equal commitment_sha256; the preimage's last field is the nonce.",
  };
}

/** Public commitment lookup for third parties: GET /v1/track-record/verify?hash=<commitment sha256>. */
pub.get("/v1/track-record/verify", async (c) => {
  const q = VerifyQuery.safeParse({ hash: c.req.query("hash") ?? "" });
  if (!q.success) return err(c, "validation_error", "hash must be a commitment sha256: 64 hex characters", 400);
  const client = db(c.env);
  const { data: commit, error } = await client.from("bot_posts").select("id, commitment_sha256, nonce, created_at, channel, message_id, telegram_date, markets(platform, external_id)")
    .eq("kind", "commit").eq("commitment_sha256", q.data.hash.toLowerCase()).order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (error) return err(c, "UPSTREAM_UNAVAILABLE", "track record store unavailable", 503);
  if (!commit) return err(c, "not_found", "no commit with this commitment hash", 404);
  const { data: reveal, error: re } = await client.from("bot_posts").select("channel, message_id, telegram_date, payload").eq("kind", "reveal").eq("dedup_key", `reveal:${commit.id}`).maybeSingle();
  if (re) return err(c, "UPSTREAM_UNAVAILABLE", "track record store unavailable", 503);
  return ok(c, shapeVerify(commit as unknown as VerifyCommit, (reveal as VerifyReveal | null) ?? null));
});

/** Echo receivers for webhook self-tests (public, no state). */
pub.post("/echo", async (c) => c.json({ received: true, event_id: c.req.header("x-resolve-event-id") ?? null }));
pub.post("/echo-500", async (c) => c.json({ received: false }, 500));

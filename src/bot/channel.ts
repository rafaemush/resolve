/**
 * The public commit-reveal channel: one lease, one pacing ceiling, one delivery path (plan §16.4 P2 step 1; §18.2:
 * Telegram takes about 20 messages a minute per channel).
 *
 * Everything that posts a commit or a reveal holds the channel lease (post_leases, migration 017) while it posts: the
 * inline post of a single-market commit (src/bot/commit.ts), the every-minute poster and the reconcile's retry
 * (src/bot/post.ts). So two crons never post the same pending row twice, and the pacing count cannot be raced: at most
 * PACE.messages commit/reveal messages per rolling PACE.windowSeconds, counted by claim_post_lease from bot_posts.posted_at
 * by distinct message_id (the legs of an event share one message). Idle, paced or busy: nothing is posted and the rows
 * stay pending for the next poster run, which is never a lost commitment.
 */
import { z } from "zod";
import type { Env } from "../env";
import type { Db } from "../db/supabase";
import { sendMessage } from "./telegram";
import { alert } from "../ops/alerts";
import { redact } from "../ops/redact";

export const CHANNEL = "telegram_public";
export const PACE = { messages: 15, windowSeconds: 60 } as const;
/** Telegram caps a message at 4096 UTF-16 units; batches are cut below it, never truncated (src/bot/post.ts). */
export const MESSAGE_MAX = 4000;
/**
 * sendMessage's worst case: the 1.2 s throttle, three attempts of up to 8 s and two 429 waits of up to 5 s (35.2 s). A
 * post starts only while this much lease is left, so its receipt is written before another poster can claim the channel.
 */
export const SEND_WORST_MS = 40_000;
/** One inline commit post (one send, its receipt), released right after. */
export const INLINE_LEASE_S = 60;
/** One poster run: sends start only in its first POSTER_LEASE_S - SEND_WORST_MS / 1000 = 50 s; released at the end. */
export const POSTER_LEASE_S = 90;

const ClaimAnswer = z.discriminatedUnion("claimed", [
  z.object({ claimed: z.literal(true), lease_until: z.string(), now: z.string(), messages_in_window: z.number().int().nonnegative() }),
  z.object({ claimed: z.literal(false), reason: z.enum(["idle", "paced", "busy"]) }),
]);

export type ChannelClaim =
  | { claimed: true; session: ChannelSession }
  | { claimed: false; reason: "idle" | "paced" | "busy" | "error"; detail: string };

/** A claimed lease: how many more messages fit under the pacing ceiling, and until when a send may start. */
export class ChannelSession {
  private sent = 0;
  constructor(readonly holder: string, private readonly deadlineMs: number, private readonly messagesInWindow: number) {}
  /** Whether one more message may start now: under the pacing ceiling and early enough in the lease. */
  room(nowMs = Date.now()): "ok" | "paced" | "lease" {
    if (this.messagesInWindow + this.sent >= PACE.messages) return "paced";
    return nowMs + SEND_WORST_MS <= this.deadlineMs ? "ok" : "lease";
  }
  /** Count a message that was sent (or attempted: a failed send may still have reached the channel). */
  count(): void { this.sent++; }
}

function newHolder(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Claim the channel for `seconds` (one subrequest). The deadline is kept on this isolate's clock: the database's
 * lease_until minus its now(), from the moment before the call, so it errs early.
 */
export async function claimChannel(client: Db, seconds: number): Promise<ChannelClaim> {
  const holder = newHolder();
  const t0 = Date.now();
  let data: unknown, error: { message: string } | null;
  try {
    ({ data, error } = await client.rpc("claim_post_lease", { p_channel: CHANNEL, p_holder: holder, p_seconds: seconds, p_max_messages: PACE.messages, p_window_seconds: PACE.windowSeconds }));
  } catch (e) {
    return { claimed: false, reason: "error", detail: redact(String(e)).slice(0, 200) };
  }
  if (error) return { claimed: false, reason: "error", detail: redact(error.message).slice(0, 200) };
  const p = ClaimAnswer.safeParse(data);
  if (!p.success) return { claimed: false, reason: "error", detail: `unexpected claim_post_lease answer ${JSON.stringify(data).slice(0, 200)}` };
  if (!p.data.claimed) return { claimed: false, reason: p.data.reason, detail: `channel ${p.data.reason}` };
  const leaseMs = Date.parse(p.data.lease_until) - Date.parse(p.data.now);
  if (!Number.isFinite(leaseMs)) return { claimed: false, reason: "error", detail: "claim_post_lease answered unreadable times" };
  return { claimed: true, session: new ChannelSession(holder, t0 + leaseMs, p.data.messages_in_window) };
}

/** End the lease early (one subrequest). A failed release only makes the next poster wait for lease_until: logged. */
export async function releaseChannel(client: Db, session: ChannelSession): Promise<void> {
  try {
    const { error } = await client.rpc("release_post_lease", { p_channel: CHANNEL, p_holder: session.holder });
    if (error) console.error(JSON.stringify({ level: "error", job: "channel_release", error: redact(error.message) }));
  } catch (e) {
    console.error(JSON.stringify({ level: "error", job: "channel_release", error: redact(String(e)).slice(0, 200) }));
  }
}

export interface Delivery { posted: boolean; message_id: number | null; error: string | null; alerted: boolean }

/**
 * Post one message that carries `ids` (one commit, one reveal, or the legs of an event) and record the receipt on every
 * row still pending in one update, or the failure on each (note_post_failure): COST.telegram + COST.db subrequests,
 * plus one alert when a receipt is not saved (`alerted`; a caller on a budget reserves it). A post whose receipt cannot
 * be saved leaves its rows pending, so a later run posts them again: alerted, never silent (a duplicate of a commitment
 * is harmless to the record; a lost one is not).
 */
export async function deliverMessage(env: Env, client: Db, ids: string[], kind: "commit" | "reveal", text: string, replyTo: number | null): Promise<Delivery> {
  const r = await sendMessage(env, text, { replyTo });
  if (r.ok) {
    const receipt = { channel: "telegram", message_id: r.message_id, telegram_date: r.date, posted_at: r.date, ...(kind === "reveal" ? { reply_to_message_id: replyTo } : {}) };
    const { data, error } = await client.from("bot_posts").update(receipt).in("id", ids).eq("channel", "pending").select("id");
    if (error) {
      await alert(env, `post_receipt_${ids[0]}`, `${kind} message ${r.message_id} carrying ${ids.length} row(s) (${ids.slice(0, 5).join(", ")}) was posted but its receipt was not saved: ${error.message}. The rows are still pending; the next poster run posts them again.`, { dedupMinutes: 60 });
      return { posted: true, message_id: r.message_id, error: `receipt not saved: ${redact(error.message).slice(0, 200)}`, alerted: true };
    }
    const saved = (data ?? []).length;
    if (saved < ids.length) {
      // Under the lease nothing else posts these rows; a row that was no longer pending means that rule was broken.
      await alert(env, `post_receipt_${ids[0]}`, `${kind} message ${r.message_id} carried ${ids.length} row(s) but only ${saved} were still pending: another poster posted the rest while this one held the channel lease.`, { dedupMinutes: 60 });
      return { posted: true, message_id: r.message_id, error: null, alerted: true };
    }
    return { posted: true, message_id: r.message_id, error: null, alerted: false };
  }
  const postError = redact(r.error ?? "unknown").slice(0, 300);
  const { error } = await client.rpc("note_post_failure", { p_ids: ids, p_error: postError });
  if (error) console.error(JSON.stringify({ level: "error", job: "bot_post", ids: ids.slice(0, 5), error: redact(error.message) }));
  return { posted: false, message_id: null, error: postError, alerted: false };
}

/**
 * The channel poster: pending commits and reveals, posted under the channel lease and its pacing ceiling
 * (src/bot/channel.ts). It runs every minute (src/jobs/schedule.ts, job channel_post) and as the reconcile's retry step
 * (src/jobs/reconcile.ts): one function under one lease, so the two crons never post a row twice.
 *
 * Why batching: every leg of a ladder is its own market with its own watch, so a CPI release commits ~24 legs in the
 * same minute, and Telegram takes about 20 messages a minute per channel. A commit whose event (markets.event_key) has
 * other open legs is recorded pending and left here (src/bot/commit.ts); this poster posts each event as ONE message:
 * a header naming the event, then one line per leg "market <platform>:<external_id> | commitment <sha256>", cut into
 * several messages under MESSAGE_MAX when needed, never truncated. Every leg's row takes its message's message_id and
 * telegram_date (migration 012's trigger allows exactly that pending -> telegram transition, once; legs share the id).
 * An event with one ready row is posted as that row's stored text, byte for byte (what the inline post sends).
 *
 * Reveals are grouped by the commit message they answer: the legs that share one commit message get ONE reply listing
 * each leg's market, commitment, preimage and nonce (chunked), so each leg's commitment is recomputable from the posted
 * text alone and GET /v1/track-record/verify keeps answering per leg. A reveal whose commit message is its own is posted
 * as its stored text. A reveal never reaches the channel before its commit. The legs of a ladder settle in different
 * reconcile runs (25 markets and one subrequest budget per run, each leg's own backoff), so a message's reveals wait
 * while another leg of that message is still open, for at most REVEAL_MAX_WAIT_S.
 */
import { z } from "zod";
import type { Env } from "../env";
import { db, type Db } from "../db/supabase";
import { telegramConfigured } from "./telegram";
import { claimChannel, deliverMessage, releaseChannel, MESSAGE_MAX, POSTER_LEASE_S, type ChannelSession } from "./channel";
import { CommittedVerdict, DISCLAIMER, type Agreement, type OfficialRecord } from "./commit";
import { redact } from "../ops/redact";
import { COST, type Budget } from "../ops/budget";

/** A pending commit posted inline may still have its first attempt in flight this long; the poster leaves it alone. */
export const RETRY_AFTER_S = 60;
/** A batched commit waits this long for the other legs of its event, so a release's legs go out together. */
export const BATCH_QUIET_S = 30;
/** An event whose legs keep arriving is posted anyway once its oldest pending leg has waited this long. */
export const BATCH_MAX_WAIT_S = 120;
/**
 * A commit message whose legs are not all settled has its pending reveals held this long at most (from its oldest
 * pending reveal). Longer than the 10-minute reconcile interval, so legs settled in two consecutive runs share one
 * reply; shorter than the 15-minute unposted alert (src/jobs/reconcile.ts UNPOSTED_ALERT_MINUTES), which a held reveal
 * must never trip (tests/post.test.ts checks both).
 */
export const REVEAL_MAX_WAIT_S = 660;
/** Rows read per run; an event cut by the limit is completed next run. */
export const COMMIT_READ_MAX = 120;
export const REVEAL_READ_MAX = 60;

export interface PendingCommitRow {
  id: string; market_id: string; created_at: string; commitment_sha256: string; payload: Record<string, unknown>;
  markets: { platform: string; external_id: string; event_key?: string | null } | null;
}
export interface PendingRevealRow {
  id: string; market_id: string; created_at: string; commitment_sha256: string; nonce: string; payload: Record<string, unknown>;
  markets: { platform: string; external_id: string; event_key?: string | null } | null;
}

const byCreated = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id);
/** Failed posts so far of a group's rows: a message Telegram keeps refusing goes behind the others instead of blocking them. */
const attemptsOf = (rows: Array<{ payload: Record<string, unknown> }>) => Math.max(0, ...rows.map((r) => Number(r.payload?.post_attempts ?? 0) || 0));
const fairOrder = <G extends { rows: Array<{ created_at: string; id: string; payload: Record<string, unknown> }> }>(a: G, b: G) => attemptsOf(a.rows) - attemptsOf(b.rows) || byCreated(a.rows[0]!, b.rows[0]!);
const refOf = (r: { market_id: string; markets: PendingCommitRow["markets"] }) => (r.markets ? `${r.markets.platform}:${r.markets.external_id}` : r.market_id);

/** Pure. The event a pending row belongs to (markets.event_key); a row read without its market is its own event. */
export function eventOf(r: Pick<PendingCommitRow, "market_id" | "markets">): string {
  return r.markets?.event_key || (r.markets ? `${r.markets.platform}:${r.markets.external_id}` : `market:${r.market_id}`);
}

export interface CommitGroup { eventKey: string; rows: PendingCommitRow[] }

/**
 * Pure. Which pending commits to post now, grouped by event, fewest failed attempts then oldest first, at most
 * maxEvents. A row is ready once
 * its inline attempt cannot be in flight (RETRY_AFTER_S) or, for a batched row, once it has waited BATCH_QUIET_S for
 * its siblings. An event waits while some of its legs are not ready, until its oldest leg has waited BATCH_MAX_WAIT_S.
 */
export function planCommitPosts(rows: PendingCommitRow[], nowMs: number, maxEvents: number): CommitGroup[] {
  const age = (r: PendingCommitRow) => (nowMs - Date.parse(r.created_at)) / 1000;
  const ready = (r: PendingCommitRow) => age(r) >= (r.payload?.batched === true ? BATCH_QUIET_S : RETRY_AFTER_S);
  const events = new Map<string, PendingCommitRow[]>();
  for (const r of [...rows].sort(byCreated)) {
    const k = eventOf(r);
    events.set(k, [...(events.get(k) ?? []), r]);
  }
  const out: CommitGroup[] = [];
  for (const [eventKey, legs] of events) {
    const readyLegs = legs.filter(ready);
    if (!readyLegs.length) continue;
    if (readyLegs.length < legs.length && age(legs[0]!) < BATCH_MAX_WAIT_S) continue;
    out.push({ eventKey, rows: readyLegs });
  }
  return out.sort(fairOrder).slice(0, Math.max(0, maxEvents));
}

export interface Message { text: string; ids: string[] }

const tagOf = (eventKey: string) => `#${eventKey}`.replace(/[^#\w.-]/g, "_").slice(0, 60);
const iso = (t: string) => new Date(Date.parse(t)).toISOString();

/**
 * Pure. Blocks packed greedily into messages of at most `limit` characters: head(part) + blocks + tail. The head is
 * sized for the longest part label, so numbering the parts afterwards never overflows. A message over the limit is a
 * bug, never a truncation: it throws (the scheduled job turns that into an operator alert).
 */
function pack<T extends { id: string; text: string }>(blocks: T[], head: (part: string) => string[], tail: (chunk: T[]) => string[], sep: string, limit: number): Message[] {
  const worstHead = head(" (part 99/99)").join("\n").length;
  const tailLen = blocks.length ? tail(blocks).join("\n").length : 0;
  const room = limit - worstHead - tailLen - 2 * sep.length;
  const chunks: T[][] = [];
  let cur: T[] = [], used = 0;
  for (const b of blocks) {
    const n = b.text.length + sep.length;
    if (cur.length && used + n > room) { chunks.push(cur); cur = []; used = 0; }
    cur.push(b); used += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c, i) => {
    const part = chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : "";
    const text = [head(part).join("\n"), c.map((b) => b.text).join(sep), tail(c).join("\n")].join(sep);
    if (text.length > limit) throw new Error(`a channel message of ${text.length} characters exceeds ${limit}; it is never truncated`);
    return { text, ids: c.map((b) => b.id) };
  });
}

export interface CommitLeg { id: string; ref: string; commitment: string; created_at: string }

/** Pure. The commit message(s) of one event: one line per leg, chunked under `limit`. */
export function commitBatchMessages(eventKey: string, legs: CommitLeg[], limit = MESSAGE_MAX): Message[] {
  const blocks = [...legs].sort(byCreated).map((l) => ({ id: l.id, created_at: l.created_at, text: `market ${l.ref} | commitment ${l.commitment}` }));
  return pack(blocks,
    (part) => [`${tagOf(eventKey)} | ${legs.length} verdicts committed${part}`, `event ${eventKey}`],
    (c) => [
      `recorded ${iso(c[0]!.created_at)} to ${iso(c[c.length - 1]!.created_at)}`,
      "Each verdict and its nonce are revealed as a reply to this message once the platform resolves: sha256(preimage) = commitment.",
      DISCLAIMER,
    ],
    "\n", limit);
}

export interface RevealLeg { id: string; ref: string; commitment: string; nonce: string; committed: CommittedVerdict; official: OfficialRecord; agreement: Agreement }

const officialSource = (o: OfficialRecord) => (o.source_url || o.at ? `official source ${o.source_url ?? "n/a"}${o.at ? ` at ${o.at} (${o.at_source ?? "unlabeled"})` : ""}` : null);

/** Pure. The reveal reply (or replies) for the legs that share one commit message: each leg's preimage and nonce. */
export function revealBatchMessages(eventKey: string, legs: RevealLeg[], limit = MESSAGE_MAX): Message[] {
  const sources = new Set(legs.map((l) => officialSource(l.official)));
  const shared = sources.size === 1 ? [...sources][0]! : null;
  const blocks = legs.map((l) => ({
    id: l.id,
    text: [
      `market ${l.ref} | commitment ${l.commitment}`,
      ...(l.committed.preimage_version === "v1" ? ["v1 preimage: its first field is the internal market id"] : []),
      `preimage ${l.committed.preimage}`,
      `nonce ${l.nonce}`,
      `committed ${l.committed.resolution_status} ${l.committed.winning_outcome} confidence ${l.committed.confidence_score.toFixed(2)} caveats [${l.committed.caveats.join(",")}] -> official ${l.official.outcome ?? "none"}${l.official.label ? ` (${l.official.label})` : ""} -> ${l.agreement}`,
      ...(!shared && officialSource(l.official) ? [officialSource(l.official)!] : []),
    ].join("\n"),
  }));
  return pack(blocks,
    (part) => [
      `${tagOf(eventKey)} | reveal of ${legs.length} committed verdicts${part}`,
      `event ${eventKey}`,
      "format platform:external_id|status|outcome|confidence|caveats|canonical_sha256|thresholds_version|nonce",
      "Check each leg: sha256 of the text after \"preimage \" equals the commitment on its market line.",
      ...(shared ? [shared] : []),
    ],
    () => [DISCLAIMER],
    "\n\n", limit);
}

export interface RevealGroup { replyTo: number; rows: PendingRevealRow[] }
type PostedCommits = ReadonlyMap<string, { channel: string; message_id: number | null }>;

/** Pure. The commit message a pending reveal answers; null while its commit is not posted. */
function replyToOf(r: PendingRevealRow, commits: PostedCommits): number | null {
  const c = commits.get(String(r.payload?.commit_id ?? ""));
  return c && c.channel === "telegram" && c.message_id ? c.message_id : null;
}

/** Pure. The commit messages the pending reveals answer (the ones whose open legs the poster reads). */
export function revealMessageIds(reveals: PendingRevealRow[], commits: PostedCommits): number[] {
  return [...new Set(reveals.map((r) => replyToOf(r, commits)).filter((id): id is number => id !== null))];
}

/**
 * Pure. Pending reveals grouped by the commit message they answer, fewest failed attempts then oldest first, at most
 * maxGroups. A reveal whose commit is not posted yet waits (a reveal never reaches the channel before its commitment).
 * A message with legs still open (openLegs: message_id -> open markets among its commits) is held, so its legs are
 * revealed in one reply, until its oldest pending reveal has waited REVEAL_MAX_WAIT_S. No quiet period is needed once
 * no leg is open: settle_market records a market's reveals in the transaction that closes it.
 */
export function planRevealPosts(reveals: PendingRevealRow[], commits: PostedCommits, openLegs: ReadonlyMap<number, number>, nowMs: number, maxGroups: number): { groups: RevealGroup[]; waiting: number; held: number } {
  let waiting = 0, held = 0;
  const groups = new Map<number, PendingRevealRow[]>();
  for (const r of [...reveals].sort(byCreated)) {
    const replyTo = replyToOf(r, commits);
    if (replyTo === null) { waiting++; continue; }
    groups.set(replyTo, [...(groups.get(replyTo) ?? []), r]);
  }
  const ready: RevealGroup[] = [];
  for (const [replyTo, rows] of groups) {
    const waited = (nowMs - Date.parse(rows[0]!.created_at)) / 1000;
    if ((openLegs.get(replyTo) ?? 0) > 0 && waited < REVEAL_MAX_WAIT_S) { held += rows.length; continue; }
    ready.push({ replyTo, rows });
  }
  return { groups: ready.sort(fairOrder).slice(0, Math.max(0, maxGroups)), waiting, held };
}

const OfficialShape = z.object({
  outcome: z.enum(["OPTION_A", "OPTION_B", "VOID"]).nullable(), label: z.string().nullable(), at: z.string().nullable(),
  at_source: z.enum(["gamma_closed_time", "limitless_api_poll", "first_observed_poll"]).nullable(), source_url: z.string().nullable(),
});
const AgreementShape = z.enum(["agree", "disagree", "void", "abstained", "unresolved_by_platform"]);

/** Pure. A reveal row as a batch leg; null when its payload is not the shape buildReveal writes (it is then posted alone). */
export function revealLeg(r: PendingRevealRow): RevealLeg | null {
  const committed = CommittedVerdict.safeParse(r.payload?.committed);
  const official = OfficialShape.safeParse(r.payload?.official);
  const agreement = AgreementShape.safeParse(r.payload?.agreement);
  if (!committed.success || !official.success || !agreement.success) return null;
  return { id: r.id, ref: refOf(r), commitment: r.commitment_sha256, nonce: r.nonce, committed: committed.data, official: official.data, agreement: agreement.data };
}

export interface PostLimits { commitEvents: number; revealGroups: number }
export interface PostSummary {
  /** claimed: the run held the channel; otherwise why nothing was posted. */
  channel: "claimed" | "idle" | "paced" | "busy" | "error" | "unconfigured" | "budget";
  commits_attempted: number; commits_posted: number; commits_failed: number;
  reveals_posted: number; reveals_waiting: number; reveals_failed: number;
  /** Pending reveals held because another leg of their commit message is still open (at most REVEAL_MAX_WAIT_S). */
  reveals_held: number;
  messages: number;
  /** Why the run stopped before its limits: budget, pacing ceiling, lease time, or a failed send (Telegram refusing). */
  stopped: "budget" | "paced" | "lease" | "failure" | null;
  /** A read or the claim failed: the poster could not look (the caller's run is a failure). */
  errors: string[];
  /** A send failed or its receipt was not saved: recorded on the rows (post_error), alerted after 15 minutes pending. */
  send_errors: string[];
}

type Ctx = { env: Env; client: Db; budget: Budget; session: ChannelSession; out: PostSummary };

/**
 * Send one message under the session: stops (returns false) on the pacing ceiling, the lease deadline, the budget or a
 * failed send. Reserves COST.telegram + COST.db + one alert (released unless a receipt failure spent it).
 */
async function send(x: Ctx, m: Message, kind: "commit" | "reveal", replyTo: number | null): Promise<boolean> {
  const room = x.session.room();
  if (room !== "ok") { x.out.stopped = room; return false; }
  if (!x.budget.take(COST.telegram + COST.db + COST.alert)) { x.out.stopped = "budget"; return false; }
  x.session.count();
  x.out.messages++;
  const d = await deliverMessage(x.env, x.client, m.ids, kind, m.text, replyTo);
  if (!d.alerted) x.budget.release(COST.alert);
  const n = m.ids.length;
  if (kind === "commit") { x.out.commits_attempted += n; if (d.posted) x.out.commits_posted += n; else x.out.commits_failed += n; }
  else if (d.posted) x.out.reveals_posted += n; else x.out.reveals_failed += n;
  if (d.error) x.out.send_errors.push(`${kind} ${m.ids[0]}${n > 1 ? ` (+${n - 1})` : ""}: ${d.error}`);
  if (!d.posted) { x.out.stopped = "failure"; return false; }
  return true;
}

async function postCommits(x: Ctx, maxEvents: number, nowMs: number): Promise<void> {
  if (!x.budget.take(COST.db)) { x.out.stopped = "budget"; return; }
  const { data, error } = await x.client.from("bot_posts").select("id, market_id, created_at, commitment_sha256, payload, markets(platform, external_id, event_key)")
    .eq("kind", "commit").eq("channel", "pending").order("created_at", { ascending: true }).limit(COMMIT_READ_MAX);
  if (error) { x.out.errors.push(`pending commits: ${redact(error.message)}`); return; }
  for (const g of planCommitPosts((data ?? []) as unknown as PendingCommitRow[], nowMs, maxEvents)) {
    const messages: Message[] = g.rows.length === 1
      ? [{ text: String(g.rows[0]!.payload.text ?? ""), ids: [g.rows[0]!.id] }]
      : commitBatchMessages(g.eventKey, g.rows.map((r) => ({ id: r.id, ref: refOf(r), commitment: r.commitment_sha256, created_at: r.created_at })));
    for (const m of messages) if (!(await send(x, m, "commit", null))) return;
  }
}

/**
 * Reads (reserved together, the unneeded ones released): the pending reveals, their commits, and the legs of those
 * commit messages whose markets are still open (one row per open leg, so the answer is at most the legs of the
 * messages read). A read that fails stops the reveals for this run: the poster could not look.
 */
async function postReveals(x: Ctx, maxGroups: number, nowMs: number): Promise<void> {
  if (!x.budget.take(3 * COST.db)) { x.out.stopped = "budget"; return; }
  const { data, error } = await x.client.from("bot_posts").select("id, market_id, created_at, commitment_sha256, nonce, payload, markets(platform, external_id, event_key)")
    .eq("kind", "reveal").eq("channel", "pending").order("created_at", { ascending: true }).limit(REVEAL_READ_MAX);
  if (error) { x.budget.release(2 * COST.db); x.out.errors.push(`pending reveals: ${redact(error.message)}`); return; }
  const reveals = (data ?? []) as unknown as PendingRevealRow[];
  if (!reveals.length) { x.budget.release(2 * COST.db); return; }
  const commitIds = [...new Set(reveals.map((r) => String(r.payload?.commit_id ?? "")))].filter(Boolean);
  const { data: commits, error: ce } = await x.client.from("bot_posts").select("id, channel, message_id").in("id", commitIds);
  if (ce) { x.budget.release(COST.db); x.out.errors.push(`reveal commits: ${redact(ce.message)}`); return; }
  const byId = new Map((commits ?? []).map((c) => [c.id as string, c as { channel: string; message_id: number | null }]));
  const messageIds = revealMessageIds(reveals, byId);
  const openLegs = new Map<number, number>();
  if (!messageIds.length) x.budget.release(COST.db);
  else {
    const { data: open, error: oe } = await x.client.from("bot_posts").select("message_id, markets!inner(status, deleted_at)")
      .eq("kind", "commit").eq("channel", "telegram").in("message_id", messageIds).eq("markets.status", "open").is("markets.deleted_at", null);
    if (oe) { x.out.errors.push(`reveal legs still open: ${redact(oe.message)}`); return; }
    for (const o of open ?? []) openLegs.set(Number(o.message_id), (openLegs.get(Number(o.message_id)) ?? 0) + 1);
  }
  const plan = planRevealPosts(reveals, byId, openLegs, nowMs, maxGroups);
  x.out.reveals_waiting += plan.waiting;
  x.out.reveals_held += plan.held;
  for (const g of plan.groups) {
    const legs = g.rows.map((r) => ({ r, leg: g.rows.length > 1 ? revealLeg(r) : null }));
    const batch = legs.filter((l) => l.leg).map((l) => l.leg!);
    const messages: Message[] = [
      ...(batch.length ? revealBatchMessages(eventOf(g.rows[0]!), batch) : []),
      ...legs.filter((l) => !l.leg).map(({ r }) => ({ text: String(r.payload.text ?? ""), ids: [r.id] })),
    ];
    for (const m of messages) if (!(await send(x, m, "reveal", g.replyTo))) return;
  }
}

/**
 * One poster run: claim the channel (idle, paced or busy: nothing happens), post the ready commits of at most
 * limits.commitEvents events, then the ready reveals of at most limits.revealGroups commit messages, then release. Never
 * throws for a failed send or read (they are counted and listed); a message builder that would exceed Telegram's limit
 * throws. Subrequests: claim + release 2, commit read 1, reveal reads 3, then COST.telegram + COST.db per message plus
 * one alert when a receipt is not saved; everything is reserved from `budget` before it is spent.
 */
export async function postPending(env: Env, budget: Budget, limits: PostLimits, nowMs = Date.now()): Promise<PostSummary> {
  const out: PostSummary = { channel: "unconfigured", commits_attempted: 0, commits_posted: 0, commits_failed: 0, reveals_posted: 0, reveals_waiting: 0, reveals_held: 0, reveals_failed: 0, messages: 0, stopped: null, errors: [], send_errors: [] };
  if (!telegramConfigured(env)) return out;
  // the claim and its release, reserved together so a claimed lease is always released
  if (!budget.take(2 * COST.db)) { out.channel = "budget"; out.stopped = "budget"; return out; }
  const client = db(env);
  const claim = await claimChannel(client, POSTER_LEASE_S);
  if (!claim.claimed) {
    budget.release(COST.db);
    out.channel = claim.reason;
    if (claim.reason === "error") out.errors.push(`claim_post_lease: ${claim.detail}`);
    return out;
  }
  out.channel = "claimed";
  const x: Ctx = { env, client, budget, session: claim.session, out };
  try {
    if (limits.commitEvents > 0) await postCommits(x, limits.commitEvents, nowMs);
    if (limits.revealGroups > 0 && out.stopped === null) await postReveals(x, limits.revealGroups, nowMs);
  } finally {
    await releaseChannel(client, claim.session);
  }
  return out;
}

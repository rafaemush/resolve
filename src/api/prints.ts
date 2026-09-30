/**
 * First prints (plan §22.3 item 6): the official number as the rail recorded it the first time, read from
 * official_observations (migration 016), one row per (series, period), first print wins, never revised.
 *   GET /v1/prints                   every series the rail knows (OFFICIAL_SERIES), with the latest period recorded and
 *                                    the next scheduled release (KNOWN_RELEASES). Free: 0 credits.
 *   GET /v1/prints/{series}/{period} one first print: the value as published, the text it was read from, when the rail
 *                                    saw it, the scheduled release, the source URL, the SHA-256 of the upstream body and
 *                                    the second source's status (never the corroboration jsonb itself: after an audited
 *                                    re-check it carries operator text). 1 credit per served print, charged once per
 *                                    request by charge_read() (migration 022; UNIQUE(reason, request_id) makes a replay of
 *                                    the same Idempotency-Key for the same print free). Before the release, or while the
 *                                    rail has not recorded it yet: {status: "scheduled", release_at}, 0 credits; an
 *                                    unknown series or period, or a release nobody recorded: 404, 0 credits.
 * Both run behind the v1 key middleware (src/api/v1.ts): the key, its daily cap and the per-key rate limit apply as on
 * every /v1 route. Free keys may call them: a print is structured data, no model is involved.
 * The 402 answer points to the card rail only (src/billing/whop.ts cardCheckoutOffered), never to the USDC address.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { ok, err, requestId, waitUntilOf } from "./envelope";
import type { AuthContext } from "./auth";
import { db, rpc } from "../db/supabase";
import { sha256Hex } from "../resolve/text";
import { CorroborationStatus, KNOWN_RELEASES, OFFICIAL_SERIES, missingAfterMs, periodValid, type KnownRelease, type OfficialSeriesId, type SeriesDef } from "../resolve/official";
import { noteCharge } from "../billing/events";
import { cardCheckoutOffered, whopConfig } from "../billing/whop";

type Vars = { requestId: string; schemaVersion: string; auth: AuthContext };
export const prints = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Credits one served first print costs (founder decision 2026-10-01). The list and a scheduled answer cost 0. */
export const PRINT_PRICE_CREDITS = 1;
/** GET /v1/prints reads at most this many recorded prints, newest observed first, to find each series' latest period. */
export const LIST_READ_CAP = 1000;
/** The official_observations columns a print is answered from: never meta (an election's whole count travels there). */
export const PRINT_COLUMNS = ["series", "period", "value", "value_text", "deciding_text", "source_url", "raw_sha256", "observed_at", "corroboration"] as const;

export const VERIFY_HINT = "raw_sha256 is the SHA-256 of the upstream response body the rail read from source_url when it first observed this print (observed_at): a byte-identical copy of that response hashes to it (for example, shasum -a 256). The publisher may change the page afterwards, so a later download need not match.";

/** What `value` is for each kind of series (value_text is always the number exactly as published). */
const UNIT: Record<SeriesDef["decides"], string> = {
  percent: "percent, as published (1 decimal)",
  rate_change_bps: "percent: the policy rate level the decision set (the FOMC: the upper bound of the target range)",
  change_thousands: "thousands: the over-the-month change, as published",
  election: "valid votes in the authority's count",
};

const PERIOD_FORMAT: Record<SeriesDef["period"], string> = { month: "YYYY-MM", quarter: "YYYY-Qn", day: "YYYY-MM-DD" };

export const isSeries = (s: string): s is OfficialSeriesId => Object.prototype.hasOwnProperty.call(OFFICIAL_SERIES, s);

/** Pure. The soonest release of `series` in KNOWN_RELEASES scheduled after `now`, or null. */
export function nextRelease(series: OfficialSeriesId, now: number): { period: string; release_at: string } | null {
  let best: { period: string; release_at: string } | null = null;
  for (const [k, r] of Object.entries(KNOWN_RELEASES)) {
    const i = k.indexOf(":");
    if (k.slice(0, i) !== series || Date.parse(r.release_at) <= now) continue;
    if (!best || Date.parse(r.release_at) < Date.parse(best.release_at)) best = { period: k.slice(i + 1), release_at: r.release_at };
  }
  return best;
}

export interface RecordedPeriod { series: string; period: string; observed_at: string }

/** Pure. Every series in OFFICIAL_SERIES order: its label, unit, period format, latest recorded period and next release. */
export function listSeries(now: number, recorded: readonly RecordedPeriod[]) {
  // Periods of one series share one format (YYYY-MM, YYYY-Qn, YYYY-MM-DD), so the greatest string is the latest period.
  const latest = new Map<string, RecordedPeriod>();
  for (const r of recorded) {
    const cur = latest.get(r.series);
    if (!cur || r.period > cur.period) latest.set(r.series, r);
  }
  return (Object.values(OFFICIAL_SERIES) as SeriesDef[]).map((d) => {
    const l = latest.get(d.id);
    const n = nextRelease(d.id, now);
    return {
      series: d.id, label: d.label, unit: UNIT[d.decides], period_format: PERIOD_FORMAT[d.period],
      latest: l ? { period: l.period, observed_at: new Date(l.observed_at).toISOString(), read: `/v1/prints/${d.id}/${l.period}` } : null,
      next_release: n ? { ...n, read: `/v1/prints/${d.id}/${n.period}` } : null,
    };
  });
}

/** An official_observations row as PostgREST returns PRINT_COLUMNS (numeric may arrive as a number or a string). */
export interface PrintRow {
  series: string; period: string; value: number | string; value_text: string; deciding_text: string; source_url: string;
  raw_sha256: string; observed_at: string; corroboration: unknown;
}

/**
 * Pure. The public body of a recorded first print. corroboration answers its status only: the stored jsonb also holds
 * the second source's detail text and, after an audited re-check, the re-check's id and time.
 */
export function shapePrint(row: PrintRow) {
  const known = KNOWN_RELEASES[`${row.series}:${row.period}`];
  const status = CorroborationStatus.safeParse((row.corroboration as { status?: unknown } | null)?.status);
  return {
    series: row.series, period: row.period, status: "recorded" as const,
    value: Number(row.value), value_text: row.value_text, deciding_text: row.deciding_text,
    observed_at: new Date(row.observed_at).toISOString(), release_at: known?.release_at ?? null,
    source_url: row.source_url, raw_sha256: row.raw_sha256,
    corroboration: status.success ? { status: status.data } : null,
    verify: VERIFY_HINT,
  };
}

/**
 * Pure. The answer for a (series, period) with no recorded print: scheduled while the release is ahead, and for as long
 * after it as the rail itself waits before calling a release not observed (missingAfterMs: 6 h, elections 72 h); null
 * (404) for a period KNOWN_RELEASES does not schedule, or one whose window has passed with nothing recorded.
 */
export function scheduledAnswer(series: OfficialSeriesId, period: string, now: number, known: KnownRelease | undefined = KNOWN_RELEASES[`${series}:${period}`]) {
  if (!known) return null;
  const at = Date.parse(known.release_at);
  if (now >= at + missingAfterMs(series)) return null;
  return {
    series, period, status: "scheduled" as const, release_at: known.release_at,
    note: now < at
      ? `Not released yet: scheduled for ${known.release_at}. Ask again after it; nothing is charged until a first print is served.`
      : `Scheduled for ${known.release_at}; the rail has not recorded the first print yet. Ask again in a minute; nothing is charged until it is served.`,
  };
}

/**
 * The ledger request_id of one read. With an Idempotency-Key it is derived from the tenant, the print and the key, so a
 * replay of the same key for the same print finds the charge already standing (free), and the same key reused for
 * another print is a new read. Without one, the request's own id: every request is charged.
 */
export async function chargeRequestId(o: { tenantId: string; series: string; period: string; idempotencyKey: string | null; requestId: string }): Promise<string> {
  const tail = o.idempotencyKey ? await sha256Hex(`${o.tenantId}|${o.series}|${o.period}|${o.idempotencyKey}`) : o.requestId;
  return `print:${o.series}:${o.period}:${tail}`;
}

/** charge_read()'s answer (migration 022). */
export const ChargeAnswer = z.object({ ok: z.boolean(), replayed: z.boolean(), charged: z.number().int().min(0), balance: z.number().int() });
export type ChargeAnswer = z.infer<typeof ChargeAnswer>;

/** Pure. Where a tenant short of credits buys more: the card rail when it is offered, else the pricing page. Never the USDC address. */
export function topUpHint(env: Env): string {
  return cardCheckoutOffered(whopConfig(env))
    ? "Buy credits by card: POST /v1/billing/checkout, or the form at /pricing#pay-by-card."
    : "See /pricing for credit packs.";
}

const storeDown = (c: Context, what: string) => err(c, "UPSTREAM_UNAVAILABLE", `${what} unavailable; retry shortly. Nothing was charged.`, 503, { retryAfterSeconds: 30 });

prints.get("/", async (c) => {
  const { data, error } = await db(c.env).from("official_observations").select("series, period, observed_at").order("observed_at", { ascending: false }).limit(LIST_READ_CAP);
  if (error) return storeDown(c, "first-print store");
  const series = listSeries(Date.now(), (data ?? []) as RecordedPeriod[]);
  return ok(c, {
    series, count: series.length, credits_charged: 0,
    price_credits: { list: 0, print: PRINT_PRICE_CREDITS },
    read: "GET /v1/prints/{series}/{period}: the first print, 1 credit per served print (a replay of the same Idempotency-Key is free); a release not recorded yet answers status scheduled, 0 credits",
  });
});

prints.get("/:series/:period", async (c) => {
  const auth = c.get("auth");
  const series = c.req.param("series");
  const period = c.req.param("period");
  if (!isSeries(series)) return err(c, "not_found", `unknown series ${JSON.stringify(series.slice(0, 64))}; GET /v1/prints lists every series. Nothing was charged.`, 404);
  const def = OFFICIAL_SERIES[series];
  if (!periodValid(series, period)) return err(c, "not_found", `unknown period ${JSON.stringify(period.slice(0, 32))} for ${series}: its periods are ${PERIOD_FORMAT[def.period]}. Nothing was charged.`, 404);
  const client = db(c.env);
  const { data: row, error } = await client.from("official_observations").select(PRINT_COLUMNS.join(", ")).eq("series", series).eq("period", period).maybeSingle();
  if (error) return storeDown(c, "first-print store");
  if (!row) {
    const s = scheduledAnswer(series, period, Date.now());
    if (!s) {
      const known = KNOWN_RELEASES[`${series}:${period}`];
      return err(c, "not_found", known
        ? `no first print of ${series} ${period} was recorded (its release was scheduled for ${known.release_at}). Nothing was charged.`
        : `no first print of ${series} ${period} is recorded and no release of it is scheduled; GET /v1/prints lists each series' latest period and next release. Nothing was charged.`, 404);
    }
    const { data: t } = await client.from("tenants").select("credits_balance").eq("id", auth.tenantId).maybeSingle();
    return ok(c, { ...s, credits_charged: 0, balance: (t as { credits_balance?: number } | null)?.credits_balance ?? null });
  }

  // Charge-then-serve, once per request: the print is immutable, so a replay only has to find its charge.
  const idem = c.req.header("idempotency-key")?.slice(0, 200) || null;
  const chargeId = await chargeRequestId({ tenantId: auth.tenantId, series, period, idempotencyKey: idem, requestId: requestId(c) });
  let charge: ChargeAnswer;
  try {
    const out = await rpc<unknown>(client, "charge_read", { p_tenant: auth.tenantId, p_amount: PRINT_PRICE_CREDITS, p_request_id: chargeId });
    charge = ChargeAnswer.parse(Array.isArray(out) ? out[0] : out);
  } catch {
    // fail closed: a charge that could not be made or read is never a free print
    return err(c, "UPSTREAM_UNAVAILABLE", "billing unavailable; no credits charged, the print was not served. Retry shortly.", 503, { retryAfterSeconds: 30, extra: { error_reason: "BILLING_UNAVAILABLE" } });
  }
  if (!charge.ok) {
    return err(c, "insufficient_credits", `A first print costs ${PRINT_PRICE_CREDITS} credit; balance is ${charge.balance}. ${topUpHint(c.env)}`, 402, { extra: { balance: charge.balance, price_credits: PRINT_PRICE_CREDITS } });
  }
  if (charge.replayed) c.header("X-Idempotent-Replay", "true");
  if (charge.charged > 0) {
    // credits.low once per crossing, off the response path (as POST /v1/resolve does)
    const low = noteCharge(c.env, auth.tenantId, chargeId);
    const wu = waitUntilOf(c);
    if (wu) wu(low); else await low;
  }
  return ok(c, { ...shapePrint(row as unknown as PrintRow), credits_charged: charge.charged, balance: charge.balance, replayed: charge.replayed });
});

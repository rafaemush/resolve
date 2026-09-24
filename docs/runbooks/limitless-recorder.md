# Limitless resolution-latency recorder

Plan §17.3 (P0 row) and §19.3. Code: `src/jobs/limitless-recorder.ts`. Schema: `supabase/migrations/018_limitless_recorder.sql`. Report: `scripts/limitless-cadence.ts`. Last updated 2026-09-24.

## Why it exists

Nobody has measured how long Limitless takes to resolve a manual market. The "24 to 72 h" figure comes from their docs, not from a measurement. `GET /markets/<slug>` has no resolution timestamp. `updatedAt` is not one: it comes 16 to 22 h *before* `expirationTimestamp` on sampled markets (plan §17.1). On Workers Free, the only honest official time is the first poll that sees the outcome. The same rows also give the weekly creation cadence of manual markets, which is the rank-1 inventory number of plan §17.2.

## What it records

`limitless_markets` has one row per slug:

| Kind | How to recognise it | Has an outcome |
|---|---|---|
| Single market | `market_type = 'single'` | yes |
| Group container (a ladder, e.g. a central-bank decision with one leg per rate outcome) | `market_type = 'group'`, `group_slug` null | no, its legs do |
| Group leg (an option) | `group_slug` = the container's slug | yes |

These columns matter:

- `expiration_at` is Limitless `expirationTimestamp`. Trading stops then (status `LOCKED`), and latency is measured from it.
- `resolved_seen_at` and `winning_outcome_index` record the **first observation of an outcome**. An outcome means `winningOutcomeIndex` is a number (0 = YES, 1 = NO), or `payoutNumerators` are equal and positive with no index. That second case is a void: `meta.void`, index null. Both columns are set once from null and never changed. A trigger enforces this, plus a CHECK that an index needs a sighting. Reconcile uses this time as `official_at` with source `limitless_api_poll`.
- `last_pending_at` is the last observation that still showed no outcome. It is taken on the Worker's clock *before* the request, and it is frozen once the outcome is seen.
- `expired_seen_at` is the first observation with `expired = true`.
- `platform_created_at` is Limitless `createdAt`.
- `first_seen_at` is when the recorder first saw the slug.
- `last_checked_at` and `check_attempts` cover the check phase. A failed check keeps its error in `meta.last_error` and `meta.last_http_status`.

The table is private. `service_role` can read it, and the only way to write it is the `record_limitless_observations()` RPC. No titles or descriptions are stored (Platform Content).

## One run

`pg_cron` job `limitless_recorder` (`*/10 * * * *`) → `dispatch_internal('limitless_record')` → `pg_net` POST `/internal/limitless/record`. The POST is signed like watch dispatches: HMAC(`internal_hmac_secret`, `"limitless_record|<minute>"`), accepted within ±3 min. The signature covers the job id, so a watch signature never opens this route.

Each run is its own Worker invocation and stays within 45 subrequests. Everything below is reserved before any work starts:

| Step | Subrequests |
|---|---|
| Read `app_config` (page cursor `limitless_recorder_page`, failure count `limitless_recorder_failures`) | 1 |
| `GET /markets/active?automationType=manual&page=N&limit=25`: one page per run, rotating, back to page 1 after a short page | 1 |
| `GET /markets/<group slug>`, only for a container whose legs were never recorded (the feed usually has them inline) | ≤ 4 |
| `record_limitless_observations(feed rows)`, which also returns the due list | 1 |
| `GET /markets/<slug>` for expired markets with no outcome yet, never checked first, then least recently checked | ≤ 25 |
| `record_limitless_observations(legs + checks)` | 1 |
| Write `app_config`, the `loop_runs` row (`loop_name = 'limitless_recorder'`), one alert | 2 + 5 |

A run must answer inside `pg_net`'s 30 s timeout. After that `pg_net` hangs up and Cloudflare cancels the invocation, so the run would lose its cursor, its failure count and its `loop_runs` row. So no request starts after 12 s (each has an 8 s timeout, so the last one ends by 20 s). The `loop_runs` row is written before the alert, and the alert (a Telegram DM that can retry for longer than the whole run) goes out under `waitUntil` after the answer.

The feed's `automationType=manual` filter lets other rows through (47 of 296 were `sports` on 2026-09-24). Every row is checked again, and non-manual rows are skipped and counted. An `expirationTimestamp` that is not in milliseconds (for example seconds or nanoseconds) fails the schema: the row is counted as drift and alerted, never stored with a wrong date. `X-API-Key` is sent only when `LIMITLESS_API_KEY` is set. The user agent is ResolveBot's one UA, `ResolveBot/1.0 (+https://resolve.rafaemush.workers.dev/bot)` (wrangler.toml `RESOLVE_BOT_UA`; what it fetches and how to opt out: `GET /bot`). A market is no longer checked 21 days after its expiry with no outcome, the same age at which reconcile closes a market out.

The page cursor goes through the whole feed in about 12 runs, roughly two hours at 296 rows. A market created and expired inside one rotation can be missed. Group legs are observed on every pass of the feed. Single markets drop out of the active feed when they lock, which is why the check phase exists.

## How precise the official time is

The platform resolved the market inside **(`last_pending_at`, `resolved_seen_at`]**. That window is measured for each market, not assumed:

- When 25 or fewer expired markets are pending, every one is checked each run, so the window is at most about 10 minutes plus the run time. This is the ±10 min in plan §17.3.
- With more pending markets, the rotation spreads the checks and the window widens. The window is stored per market, so every row carries its own bound.
- A market first seen already resolved has `last_pending_at` null. Its `resolved_seen_at` is only an upper bound, and it has **no latency**.
- A single market that leaves the feed before `expiration_at` (early resolution) is checked only after `expiration_at` passes. Its window then runs from its last feed sighting, so it is wide but still true.
- `resolved_seen_at` is the database clock at the write, never earlier than the observation. `last_pending_at` is never later than the platform's read. Both bounds stay on the safe side.

Reconcile takes the earliest of three sightings for a Limitless market: its own, the stored first one, and the recorder's. It reads them in one batched select per run. If that read fails, the Limitless market is held for the next run instead of being settled with a later time, and `reconcile_recorder_read` is alerted.

## Reading the cadence

```
npx tsx scripts/limitless-cadence.ts
```

The script is read-only and uses the service role from `.env`. It prints, for each ISO week of first sight and each category:

- **seen**: single markets and group containers first seen that week. The first week includes the backfill of every market that already existed.
- **created**: of those, the ones Limitless created that same week (`platform_created_at`). This is the creation cadence, the weekly re-scan number, and it is valid from the first week.
- **exp<=45d**: of those, the ones expiring within 45 days of first sight. These are the markets a pilot could reconcile soon.
- **legs**: group legs first seen that week.

The script then prints the latency: the markets resolved, the bounded ones and how many of those have a window of 20 min or less, the ones first seen already resolved (no latency), the ones still pending after expiry, and the median and p90 hours from expiry to first sighting over the bounded markets. These are upper bounds, because the true time is inside each window.

The same data in SQL: `select * from v_limitless_cadence order by week_start, category;`

## Alerts and what to do

| Key | When | First look |
|---|---|---|
| `limitless_recorder_failing` (dedup 6 h) | 3 failed runs in a row, or a failed run whose count could not be read | `select started_at, outcome, error, meta from loop_runs where loop_name = 'limitless_recorder' order by started_at desc limit 10;` |
| `limitless_recorder_schema` (dedup 24 h) | Limitless answered rows or legs the schema refuses | the `error` of the latest run names the first failing field; update the schema in `src/jobs/limitless-recorder.ts` |
| `limitless_recorder_stale` (dedup 6 h) | the every-minute tick at :05, :15, … finds the newest `limitless_recorder` run older than 30 min, finds none, or cannot read `loop_runs`: the recorder is not running at all (the cron job removed or inactive, `dispatch_internal` skipping or failing, every POST refused) | `select jobname, schedule, active from cron.job where jobname = 'limitless_recorder';` then `select started_at, outcome, error from loop_runs where loop_name = 'dispatch_internal' order by started_at desc limit 5;`. A `skipped` row means `worker_base_url` or the vault secret is missing (`select_due_watches` then skips too, and the tick alerts `dispatch_skipped`); a `failure` row carries the error text; `success` rows mean the POSTs went out, so see `dispatch_http_failures` |
| `dispatch_http_failures` (dedup 1 h) | the 10-minute dispatch check counts answers ≥ 400 or transport errors from `pg_net`, for watch polls and this route alike (403 = secret mismatch, 500 = the run could not write its `loop_runs` row, a timeout = the run took over 30 s) | the alert carries a breakdown by job: `dispatch_internal` keeps its `pg_net` request id in `loop_runs.meta.request_id`, so the join names `limitless_record` and the rest are watch polls |
| `reconcile_recorder_read` (dedup 6 h) | reconcile could not read `limitless_markets`, so it holds every due Limitless market and retries each run | the error text (a grant, a renamed column, a stale PostgREST schema cache: `notify pgrst, 'reload schema';`) |

A run where one market's check fails is not a failed run. The error stays on that market's row and the market moves to the back of the queue. A run fails when the feed or a write fails, when every check fails, or when the schema drifts.

Right after the recorder's first deploy, run one pass by hand (below): otherwise the tick at the next :05 can find no run yet and raise `limitless_recorder_stale` once.

To run one pass by hand, without printing the key:

```
curl -sS -X POST -H "Authorization: Bearer $ADMIN_API_KEY" "$RESOLVE_PUBLIC_URL/internal/limitless/record"
```

To restart the feed rotation, run `update app_config set value = '1' where key = 'limitless_recorder_page';`. Any unreadable cursor also restarts at 1.

Database assertions for migration 018 roll back and are never run against production. Run them against staging, or against a local cluster with `--psql <uri>`:

```
RESOLVE_SELFTEST_NON_PRODUCTION=1 npx tsx scripts/selftest/recorder.ts
```

## Upgrade path: exact resolution time from the websocket (Workers Paid)

Only the `marketResolved` websocket event carries Limitless's exact `resolutionDate`. Keeping that 24/7 outbound socket open needs a Durable Object, and plan §17.3 puts it on Workers Paid, where it fits the included Durable Object duration. It does not run on Workers Free, and it cannot run as a GitHub Actions job, because their terms treat that as serverless misuse. Build it when Workers Paid is turned on, at the first external test key (plan §17.4, week 4).

Verified 2026-09-24:

- URL `wss://ws.limitless.exchange`, Socket.IO namespace `/markets`, websocket transport only (no long-polling). No authentication is required.
- After connecting, emit `subscribe_market_lifecycle` with no arguments.
- Event `marketResolved`: `{ slug, type, winningOutcome: 'YES' | 'NO', winningIndex, resolutionDate }`.
- The server pings every 25 s. The client answers each ping (the standard Socket.IO heartbeat).

Design:

1. **Durable Object `LimitlessLifecycle`** (one instance). It opens the socket with a Socket.IO client framing: the namespace connect, the subscribe emit, and pong on ping. Confirm the server's Engine.IO protocol version on the first connect instead of assuming it. An alarm checks liveness every minute and reconnects with backoff. A run of reconnect failures raises one alert, `limitless_ws_down`.
2. **On `marketResolved`**, it writes through a new RPC (a new migration) the exact `resolutionDate` into a new column such as `limitless_markets.resolved_at_ws`, with source `limitless_ws`. The same migration widens `reconciliations_official_at_source_check` to admit `limitless_ws`. `resolved_seen_at` stays the poll's first sighting, set once as today.
3. **The websocket and the poll check each other.** `winningIndex` must equal the poll's `winning_outcome_index`. A disagreement is held and alerted, never picked. `resolutionDate` must fall inside (`last_pending_at`, `resolved_seen_at`]. If it does not, one of the two clocks is wrong: alert.
4. **Reconcile prefers `resolved_at_ws`** (exact) over the poll's upper bound when both exist. The poll keeps running as the fallback for any gap in the socket.

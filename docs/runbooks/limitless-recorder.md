# Limitless resolution-latency recorder

Plan §17.3 (P0 row) and §19.3. Code: `src/jobs/limitless-recorder.ts`. Schema: `supabase/migrations/018_limitless_recorder.sql`. Report: `scripts/limitless-cadence.ts`. Websocket listener: `src/jobs/limitless-ws.ts` (last section). Last updated 2026-09-28.

## Why it exists

Nobody has measured how long Limitless takes to resolve a manual market. The "24 to 72 h" figure comes from their docs, not from a measurement. `GET /markets/<slug>` has no resolution timestamp. `updatedAt` is not one: it comes 16 to 22 h *before* `expirationTimestamp` on sampled markets (plan §17.1). The only honest official time reconcile can use today is the first poll that sees the outcome. The websocket listener (last section) records Limitless's exact `resolutionDate` next to it. The same rows also give the weekly creation cadence of manual markets, which is the rank-1 inventory number of plan §17.2.

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

## Websocket listener: the exact resolution time

Code: `src/jobs/limitless-ws.ts` (the Durable Object) and `src/jobs/limitless-ws-protocol.ts` (the framing). Binding: wrangler.toml `LIMITLESS_WS`, class `LimitlessListener`, SQLite backend. No migration.

Only the `marketResolved` websocket event carries Limitless's exact `resolutionDate`. The poll above gives an upper bound within about 10 minutes. The listener adds the exact time next to it and changes nothing a customer sees.

### The protocol (verified 2026-09-28)

A read-only capture from this laptop (Node's built-in WebSocket, 8 minutes) and a 7-minute live run of the listener class itself against the real server confirmed the following. The samples are in `private/limitless-ws/` (gitignored, because they contain market titles):

- Handshake `wss://ws.limitless.exchange/socket.io/?EIO=4&transport=websocket`, no authentication. The server opens with Engine.IO v4: `0{"sid":…,"upgrades":[],"pingInterval":25000,"pingTimeout":60000,"maxPayload":1000000}`.
- The client sends `40/markets,`. The server acks with `40/markets,{"sid":…}`.
- The client emits `42/markets,["subscribe_market_lifecycle"]`. The server answers with two `system` events. The second is `Subscribed to market lifecycle events`. No ack packet comes back.
- The server pings (`2`) every 25 s, and the client answers each one with `3`.
- `marketCreated {slug, title, type, categoryIds, createdAt}` and `marketResolved {slug, type, winningOutcome, winningIndex, resolutionDate}`. The channel carries every market, automated ones included. BTC and ETH 5-minute markets are created and resolved every 5 minutes.

### Where the time goes

The alarm writes through `record_limitless_observations()` with `observed = false, checked = false` rows. For those rows the RPC only merges `meta`. `scripts/selftest/recorder.ts` asserts this on Postgres (`ws_meta_only`). The alarm writes:

- `meta.ws`: `{resolution_date, winning_index, winning_outcome, trade_type, received_at, source: "limitless_ws", poll_index?}`. This is the first event for the slug, and it is never replaced.
- `meta.ws_latest`: the same shape, written when a later event for the slug says something different.

`resolved_seen_at` and `winning_outcome_index` stay the poll's first sighting. Reconcile still uses the poll's time. Making reconcile prefer the websocket time needs a migration: a column such as `resolved_at_ws`, with `reconciliations_official_at_source_check` widened to admit `limitless_ws`. That comes once the two clocks have been compared on real markets.

Unknown slugs are never inserted. Automated markets would swamp `v_limitless_cadence`. An event for a slug the table does not have stays queued in the object. It is looked up once more after 2 min (a poll insert racing the event), then dropped and counted in the day summary (`meta.unknown_dropped`, with up to 10 sample slugs). Later lookups could not help: the poll imports only manual markets from `/markets/active`, so a market already resolved is never inserted afterwards. A manual market the poll never saw before it resolved is not recorded by either path.

Every 10 min the alarm cross-checks the rows the poll resolved in the last day that carry `meta.ws`, once per slug: an index that differs from `winning_outcome_index`, or a `resolution_date` outside `(last_pending_at, resolved_seen_at]`, raises `limitless_ws_index_disagrees`. The flush also compares the indexes in the rarer order (poll first). Compare the websocket and the poll by hand:

```sql
select slug, expiration_at, last_pending_at, resolved_seen_at, winning_outcome_index,
       (meta->'ws'->>'resolution_date')::timestamptz as ws_resolved_at, (meta->'ws'->>'winning_index')::int as ws_index,
       (meta->'ws'->>'resolution_date')::timestamptz > coalesce(last_pending_at, '-infinity')
         and (meta->'ws'->>'resolution_date')::timestamptz <= coalesce(resolved_seen_at, 'infinity') as inside_poll_window,
       meta ? 'ws_latest' as changed
  from limitless_markets where meta ? 'ws' order by ws_resolved_at desc limit 50;
```

### One instance, liveness, deploys

- **One instance.** There is one instance, named `limitless-lifecycle`. The cron's `pingListener()` is the only code that addresses it, and any other name is refused. The object holds the socket 24/7, which comes to 128 MB × 86,400 s = 10,800 GB-s a day.
- **Workers Free.** Free includes 13,000 GB-s a day **per account**, shared with every other Worker on the account (OilFlow and the email Workers included). This instance alone uses 83% of it. Past any free limit "further operations of that type will fail" until 00:00 UTC, for every Durable Object on the account. Do not enable the listener on Free without checking the account's Durable Object duration in the dashboard first; Workers Paid is the intended home.
- **Workers Paid.** Paid includes 400,000 GB-s a month, and this uses about 328,000. Requests and storage are far inside the included amounts either way.
- **Alarm.** The object runs a 60 s alarm. It reconnects when due, with a backoff of 1 s doubling to 60 s, reset after a minute of stable connection. It drops a socket that has had no server ping for pingInterval + pingTimeout (85 s), as an Engine.IO v4 client does. It also drops one that has had no subscription confirmation 30 s after the namespace ack. It flushes the queue, writes `loop_runs` and raises alerts.
- **Why the alarm matters.** An outbound socket keeps the object in memory for 15 minutes at most. After that, the alarm is what stops the 70-140 s idle eviction.
- **Cron ping.** The every-minute cron also pings the object, after the channel poster (a connect can take up to 10 s). This creates it on the first deploy, with `locationHint: "enam"` (next to Supabase us-east-1; the location is permanent), and restarts it after an eviction.
- **Deploys.** Every deploy shuts the object down. The stored alarm, or the next cron ping, reconnects within about a minute. Events emitted during that gap are not replayed. The poll still covers those markets.
- **Switch.** Only `LIMITLESS_WS_ENABLED = "1"` in wrangler.toml `[vars]` runs the listener; it ships `"0"`. Off: the cron stops pinging, and the object clears its alarm, forgets its outage clock (switching back on is not an outage) and stays idle. Its queue is kept for when it is switched back on.

### Turning it on (post-deploy check)

The outbound websocket was verified from Node on the laptop only, not through workerd (`fetch` + `Upgrade: websocket` -> `res.webSocket`) and not from Cloudflare egress, which has refused other providers before (the Base RPCs). So:

1. Optionally first run it under `wrangler dev` with `LIMITLESS_WS_ENABLED=1` and watch `GET /status` on the object reach `phase: "open", subscribed: true`.
2. Deploy the change to `"1"` on its own, with nothing else in the deploy.
3. Within 2 minutes there must be a row: `select started_at, meta from loop_runs where loop_name = 'limitless_ws' and meta->>'kind' = 'connected' order by started_at desc limit 1;` and no `job_limitless_ws_exception` in `alerts`.
4. If not, set it back to `"0"` and deploy: a refused upgrade loops connect failures and bills full duration.

### Alerts and rows

| Key | When | First look |
|---|---|---|
| `limitless_ws_down` (dedup 15 min) | no connection that stayed subscribed for a minute, for 15 min; once per outage | `select started_at, outcome, error, meta from loop_runs where loop_name = 'limitless_ws' order by started_at desc limit 10;` (`meta.last_close`, `meta.attempts`) |
| `limitless_ws_recovered` (dedup 1 h) | stable again after an outage that alerted | nothing to do |
| `limitless_ws_schema` (dedup 24 h) | a `marketResolved` payload the listener refuses (a missing or non-date `resolutionDate`, a bad slug, a date more than 5 min in the future) | `parseResolved` in `src/jobs/limitless-ws.ts` |
| `limitless_ws_index_disagrees` (dedup 6 h; slugs found inside the window wait for the next send) | the websocket's `winningIndex` differs from the poll's `winning_outcome_index`, or its `resolutionDate` is outside `(last_pending_at, resolved_seen_at]` (flush and the 10-min cross-check) | both are on the row; nothing picks between them |
| `limitless_ws_write_failing` (dedup 6 h) | 15 alarms in a row could not read `limitless_markets` or call the RPC | the alert's error text. Events stay queued for up to 7 days |
| `job_limitless_ws_exception` (dedup 1 h) | the cron's ping threw (the binding is missing, or the object is failing) | `wrangler tail`, and the Durable Objects page of the dashboard |

`loop_runs` rows with `loop_name = 'limitless_ws'`: `meta.kind = 'connected'` for each (re)connect, `'down'` for each outage alert, and `'day'` once per UTC day with the counters (frames, pings, events, written, duplicates, unknown retried and dropped, connects, closes, stale drops, connected and down ms). A day row is a failure when the day had a 15-minute outage or a failed flush. There is never a row per message.

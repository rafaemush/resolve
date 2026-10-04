# Resolve pricing

Resolve is a developer data API: credits pay for its calls. Prices are in US dollars, paid by card through Whop (the merchant of record). Last updated 2026-10-05.

## Credits

One credit is $0.01.

| What you call | Credits |
|---|---|
| Structured verdict (machine-readable sources: GitHub API objects, Base and Solana logs, numeric thresholds) | 1 |
| Web-evidence verdict (free-text evidence read by Resolve's evidence battery) | 5 |
| A first print (`GET /v1/prints/{series}/{period}`: an official number as first published, with its source and hash) | 1 |
| The list of series (`GET /v1/prints`), or a first print not recorded yet (`status: scheduled`) | 0 |
| A request the deterministic pre-checks settle on their own (for example unsafe input, or no anchor in the evidence) | 0 |
| A replay of the same `Idempotency-Key` | 0 (never charged twice) |
| The private early reveal of a RESOLVED verdict, on the Free and Pay as you go plans: charged once per followed market, the first time the verdict reaches you (a `shadow.committed` webhook, `GET /v1/shadow/{market_id}` or `GET /v1/shadow/export`), at most 2,000 credits per event. Included in Builder, Growth, Platform and the venue offers (the pilot pack and Design Partner) | 25 |
| An early reveal of an UNRESOLVED or ERROR verdict, a later commit of a market already revealed to you, a re-read, a retry, any commit of a market that has settled (public by then) | 0 |

A verdict that cannot be produced because an upstream is unavailable (`error_code: UPSTREAM_UNAVAILABLE`) is refunded to your account in full.

Web-evidence verdicts are not generally available yet. Until they are, paid plans are quoted on structured verdicts only, and a request routed to web evidence answers `UPSTREAM_UNAVAILABLE` and is refunded. The public shadow track record runs web-evidence verdicts today, as best effort.

**Credits are a non-refundable prepayment for API services.** They are not a balance, wallet, deposit or stored value: they cannot be withdrawn, transferred to another account, or exchanged for money or crypto, and Resolve holds no funds on your behalf. A refund of a failed verdict returns credits, never money. Credits do not expire while the account is open. If a card payment is refunded or charged back, the credits it bought are removed from the account (as far as the balance allows).

## Plans

| Plan | Price | Included | Watches | Follows (private early reveals) | Requests per minute per key |
|---|---|---|---|---|---|
| Free | $0 | 300 credits with an evaluation key, valid 30 days from issue | 5 | up to 50 while the key is valid | 60 |
| Pay as you go | packs from $20 (by card) | credits do not expire while the account is open | 5 | up to 500 | 60 |
| Builder | $99 / month | 12,000 credits a month | 50 | up to 50 | 60 |
| Growth | $399 / month | 60,000 credits a month | 500 | up to 500 | 300 |
| Platform | $1,500 to $3,000 / month, invoiced | by agreement | by agreement | unlimited | 600 |

**Free.** An evaluation key (`rsl_test_...`) for structured verdicts only, with 300 credits and up to 5 watches: a request from it that is routed to web evidence answers `UPSTREAM_UNAVAILABLE` and is refunded, also once web-evidence verdicts are generally available. The request form on the home page (or `POST /v1/request-key`) issues it on the spot and shows it once: one key per email address every 30 days, 3 keys a day per network, up to a daily number of keys; past any of these, a person reads the request and answers by email. Resolve also issues it by hand to a named integration. An evaluation key may follow up to 50 shadow markets while it is valid, so the early reveal can be judged before buying; each RESOLVED reveal costs 25 of its 300 credits (UNRESOLVED and ERROR verdicts are free). An evaluation key issued before 2026-10-06 keeps free reveals until it expires. When the key expires (30 days after issue) or is revoked, its follows stop: no further `shadow.committed` or `shadow.revealed` webhook is sent. Rotating the key does not extend it: the new key keeps the old key's expiry. There are no discounts.

**Pay as you go.** Up to 500 follows of open markets; each RESOLVED reveal costs 25 credits, at most 2,000 per event. Credit packs:

| Pack | Credits | Bonus |
|---|---|---|
| $20 (card only) | 2,000 | none |
| $50 | 5,000 | none |
| $250 (the standard pack) | 27,500 | 10 % |
| $1,000 | 120,000 | 20 % |

**Pay by card.** The $20, $50 and $250 packs can be paid by card through Whop, which processes the payment as the merchant of record and handles card disputes; $20 = 2,000 credits, card only. Buying needs a Resolve key (the free test key from the form works): the "Pay by card" form on `/pricing`, or `POST /v1/billing/checkout` with `{"pack": "20"}`, `{"pack": "50"}` or `{"pack": "250"}` and the key in the `Authorization` header, which answers `checkout_url`, Whop's hosted checkout for that key's account. Whop receives the account id, never the key. The credits are added once Whop confirms the payment, usually within a minute, as one ledger entry per payment; a free test key's account then moves to pay as you go and the key stops expiring. A card refund or chargeback removes the credits that payment bought (a partial refund its share); if they were already used, the account keeps a balance of zero, never below. When the balance runs out, the `402 insufficient_credits` answer of `POST /v1/resolve` points here (`top_up`: `POST /v1/billing/checkout` and `/pricing#pay-by-card`), and `credits.low` warns once when a charge leaves your balance below 500 credits (again after your next purchase), with the same `top_up`.

**Self-serve USDC deposits are not offered.** `GET /v1/payments/address` answers 503 ("USDC deposits are not offered", with the card pointer), and no answer of the API points to a USDC address. Packs are paid by card; the venue offers below are invoiced, and their USDC settlement is arranged per invoice (the address route is opened for that pilot alone).

**Pilot pack ($1,000, 30 days, for a venue).** Private early reveals for every market you name that Resolve shadows (the pilot account has no follow limit), webhooks in your platform's payload shape, a weekly reconciliation report for your markets (commit time, official time, lead time, agreement, share of web-evidence verdicts), and a named contact. Paid in USDC against an invoice, with a W-9 and a one-page pilot letter (details: [pilot-pack.md](pilot-pack.md)). Resolve is operated by its founder as an individual until its operating entity exists; the invoice, the W-9 and the letter are issued on that basis.

**Design Partner ($750 / month).** Prepaid monthly in USDC, month to month: custom sources for one platform, early reveals for all of that platform's markets (the account has no follow limit), the weekly reconciliation report. No SLA and no master agreement; it converts to Platform once the operating entity exists.

**Builder ($99 / month).** 12,000 credits, 50 watches, webhooks, and private early reveals on up to 50 followed markets, included (no per-reveal charge); the Builder offer covers Polymarket long-tail markets.

**Growth ($399 / month).** 60,000 credits, 500 watches, 300 requests per minute per key, up to 500 follows, early reveals included. Bulk export of the whole record is planned and not available yet; every plan can export its own followed markets with `GET /v1/shadow/export` (CSV or JSON).

**Platform ($1,500 to $3,000 / month).** Invoiced under a master services agreement: typically $2,000 a month for a resolution desk and $3,000 a month with a creator-market settlement path. Lead time is measured and reported; there is no lead-time guarantee before 100 reconciled distinct events. Available once Resolve's operating entity exists and counsel has signed off.

## Private early reveals

Follow a public shadow market with `POST /v1/markets/{id}/follow` (open, non-test shadow markets only; `DELETE` to stop, `GET /v1/follows` to list). To follow a whole event in one call, send the body `{"scope":"event"}`: every open leg of that market's event is followed (an official release's legs on every venue, a Polymarket event's legs), all or nothing against your follow limit; the answer says how many legs were followed and how many you already followed. The follow limits in the table count follows of open markets: once a followed market settles, its follow no longer counts. If a plan changes to a lower limit, the oldest follows up to the new limit keep receiving early reveals and the rest stop until you unfollow markets or change plans; `GET /v1/follows` warns when this applies. From then on:

- `GET /v1/shadow/{market_id}` returns every committed verdict for the market, newest first: the verdict, its `commitment_sha256`, when it was committed and posted, and the evidence hashes.
- A webhook endpoint subscribed to `shadow.committed` receives each new committed verdict as soon as its commitment is recorded; `shadow.revealed` delivers the official outcome, the agreement and the preimage of each commitment once the platform resolves.
- Both events carry a `venue` object in the platform's own identifiers: on Limitless `slug`, `group_slug`, `condition_id` and `proposed_winning_outcome_index` (0 = YES, 1 = NO); on Polymarket `condition_id`, `slug`, `event_id` and `proposed_outcome_label`. The proposal is `null` unless the committed verdict is RESOLVED.
- `GET /v1/shadow/export?platform=&since=&format=csv` (or `json`) returns one row per followed market: the latest commitment, its verdict and evidence hashes, and once the platform resolves the market, the official outcome, its time and source, the agreement and the lead time.
- An endpoint receives only the events it was registered with, and its events cannot be changed later. An endpoint registered before the `shadow.*` events existed is not subscribed to them. The follow response reports `endpoints_subscribed`, the number of your active endpoints that will receive `shadow.committed`, and adds a `warning` when that number is 0. In that case, register an endpoint whose `events` include `shadow.committed` and `shadow.revealed` (`POST /v1/webhooks`).

**The price of a reveal.** On the Free and Pay as you go plans a RESOLVED verdict costs 25 credits, charged once per followed market the first time it reaches you (by webhook, `GET /v1/shadow/{market_id}` or the export, whichever comes first), at most 2,000 credits per event (the legs of one event share the cap). Later commits of the same market, re-reads and retries are free, and so are UNRESOLVED and ERROR verdicts. Builder, Growth, Platform and the venue offers include reveals. Every reveal says what it cost (`reveal.credits_charged`), and the charge is one ledger entry (`GET /v1/usage`).

- **Locked.** When the balance cannot pay for a leg, the webhook and `GET /v1/shadow/{market_id}` still carry the market, the `commitment_sha256`, when it was committed and the evidence hashes, but `verdict` is `null`, the `venue` object proposes nothing, and a `locked` object gives the reason (`insufficient_credits`), the price, the balance and `top_up` (where to buy credits). Nothing is charged. These reads answer 200, never 402. After a top-up, the next read (or the next commit's webhook) releases the verdict and charges it then. In the export a locked row has empty `committed_status` and `committed_outcome`, and its `reveal` column says why.
- **Refund.** A reveal charged for a `shadow.committed` webhook is refunded once, automatically, if Resolve did not attempt to deliver it to any of your endpoints within 10 minutes of `committed_at` (it could not be queued, or the queue was behind) and you did not read it in the meantime. An endpoint you deactivate or delete before the attempt counts as attempted. Once a delivery was attempted in time the charge stands, whatever your endpoint answered: the request carried the verdict, and it stays readable, free, at `GET /v1/shadow/{market_id}`. A reveal charged by a read (`GET /v1/shadow/{market_id}` or the export) is not refunded: the verdict was in the answer.
- **Settled markets.** Once a market settles, its commitments are public (`GET /v1/track-record/verify`, the `shadow.revealed` webhook): reading them is free on every plan, and `reveal.reason` (the export's `reveal` column) says `public`.
- **Delivery order.** Webhooks of reveals you paid for are delivered first, then those of plans that include reveals, then the rest.
- **What "committed" means.** `committed_at` is the time the commitment row was recorded (the `created_at` of the commit in the record), the time `/record` counts from the scheduled release as "Release to commit". The public Telegram post of the commitment is a separate step: the channel poster posts the legs of an event as one message, at most 15 messages a minute, so the post can come later than the commit. For an official release, the leg whose fetch reads the first print commits in that same run when the print was recorded within 15 seconds of the scheduled release, and the other legs of the event are started at once instead of at their next once-a-minute poll; otherwise every leg commits on its next poll. This describes how the work is scheduled; it is not a lead-time figure (see below).

Early reveals are labeled "private early reveal — excluded from the public record". They never include the nonce or the preimage before the public reveal, so every commitment stays checkable by anyone: `sha256(preimage) = commitment_sha256` at `GET /v1/track-record/verify?hash=`.

## What we never claim

- No accuracy percentage appears in any offer, message or invoice before 100 distinct events on that platform have been reconciled against the platform of record (the legs of one multi-outcome event count once). Before that, we quote only your own markets' reconciled rows and measured lead times. The public track record (`GET /v1/track-record`) shows percentages only after 100 reconciled events per platform, counted the same way.
- No lead-time claim before lead time has been measured on at least 30 distinct events.
- Resolve is an informational signal: not financial advice and not an oracle of record.

## Status (2026-10-05)

Early reveals are priced: 25 credits per RESOLVED leg on the Free and Pay as you go plans, at most 2,000 credits per event, refunded when Resolve does not attempt the webhook within 10 minutes; included in Builder, Growth, Platform and the venue offers; free once the market settles. An evaluation key issued before 2026-10-06 keeps free reveals until it expires; Pay as you go has no such date. Pay as you go follows up to 500 open markets, and `{"scope":"event"}` follows every open leg of an event in one call.

## Status (2026-10-01)

Card checkout through Whop is live (switched on 2026-09-30): the $20, $50 and $250 packs, the "Pay by card" form on `/pricing` and `POST /v1/billing/checkout`. USDC deposits are not offered.

## Status (2026-09-25)

In the API: verdicts, watches, webhooks with the first delivery attempt at the event, follows, `GET /v1/shadow`, the `shadow.committed` / `shadow.revealed` events with a `venue` object in the platform's own identifiers (Limitless slug, condition id and proposed `winningOutcomeIndex`; Polymarket condition id, slug, event id and proposed outcome label), and the export of your followed markets (`GET /v1/shadow/export`). Prepared per customer, not self-serve yet: the weekly reconciliation report, monthly plan debits, pack bonuses and bulk export of the whole record.

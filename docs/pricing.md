# Resolve pricing

Prices are in US dollars and paid in USDC on Base. Last updated 2026-09-24.

## Credits

One credit is $0.01.

| What you call | Credits |
|---|---|
| Structured verdict (machine-readable sources: GitHub API objects, Base and Solana logs, numeric thresholds) | 1 |
| Web-evidence verdict (free-text evidence read by Resolve's evidence battery) | 5 |
| A request the deterministic pre-checks settle on their own (for example unsafe input, or no anchor in the evidence) | 0 |
| A replay of the same `Idempotency-Key` | 0 (never charged twice) |

A verdict that cannot be produced because an upstream is unavailable (`error_code: UPSTREAM_UNAVAILABLE`) is refunded to your account in full.

Web-evidence verdicts are not generally available yet. Until they are, paid plans are quoted on structured verdicts only, and a request routed to web evidence answers `UPSTREAM_UNAVAILABLE` and is refunded. The public shadow track record runs web-evidence verdicts today, as best effort.

**Credits are a non-refundable prepayment for API services.** They are not a balance, wallet, deposit or stored value: they cannot be withdrawn, transferred to another account, or exchanged for money or crypto, and Resolve holds no funds on your behalf. A refund of a failed verdict returns credits, never money.

## Plans

| Plan | Price | Included | Watches | Follows (private early reveals) | Requests per minute per key |
|---|---|---|---|---|---|
| Free | $0 | 300 credits with an evaluation key, valid 30 days from issue | 5 | not included (see below) | 60 |
| Pay as you go | packs from $50 | credits never expire | 5 | up to 50 | 60 |
| Builder | $99 / month | 12,000 credits a month | 50 | up to 50 | 60 |
| Growth | $399 / month | 60,000 credits a month | 500 | up to 500 | 300 |
| Platform | $1,500 to $3,000 / month, invoiced | by agreement | by agreement | unlimited | 600 |

**Free.** An evaluation key (`rsl_test_...`) for structured verdicts, issued to a named integration, with 300 credits. Early reveals are not a Free feature; an evaluation key may follow up to 50 shadow markets while it is valid, so the early reveal can be judged before buying. When the key expires (30 days after issue) or is revoked, its follows stop: no further `shadow.committed` or `shadow.revealed` webhook is sent. Rotating the key does not extend it: the new key keeps the old key's expiry. There are no discounts.

**Pay as you go.** Credit packs:

| Pack | Credits | Bonus |
|---|---|---|
| $50 (the smallest purchase) | 5,000 | none |
| $250 (the standard pack) | 27,500 | 10 % |
| $1,000 | 120,000 | 20 % |

Register the wallet you pay from: `GET /v1/account/wallet/challenge?address=<your address>` returns a message; sign it with that wallet (`personal_sign`) and send the signature with `POST /v1/account/wallet` within 10 minutes. Then send USDC on Base from that wallet to the address `GET /v1/payments/address` returns. The deposit is credited once Base marks its block safe (typically 5 to 10 minutes), at the rate of the tier its amount reaches: 100 credits per USDC, 110 from $250, 120 from $1,000 (amount x rate, rounded down), so each pack above arrives as one ledger entry. A deposit from an unregistered wallet is held until it is matched to your account. A `payment.credited` webhook reports each credit, and `credits.low` warns once when a charge leaves your balance below 500 credits (again after your next purchase).

**Pilot pack ($1,000, 30 days, for a venue).** Private early reveals for every market you name, webhooks in your platform's payload shape, a weekly reconciliation report for your markets (commit time, official time, lead time, agreement, share of web-evidence verdicts), and a named contact. Paid in USDC against an invoice, with a W-8BEN and a one-page pilot letter. Resolve is operated by its founder as an individual until its operating entity exists; the invoice, the W-8BEN and the letter are issued on that basis.

**Design Partner ($750 / month).** Prepaid monthly in USDC, month to month: custom sources for one platform, early reveals for all of that platform's markets, the weekly reconciliation report. No SLA and no master agreement; it converts to Platform once the operating entity exists.

**Builder ($99 / month).** 12,000 credits, 50 watches, webhooks, and private early reveals on up to 50 followed markets; the Builder offer covers Polymarket long-tail markets.

**Growth ($399 / month).** 60,000 credits, 500 watches, 300 requests per minute per key, up to 500 follows. Bulk export is planned and not available yet.

**Platform ($1,500 to $3,000 / month).** Invoiced under a master services agreement: typically $2,000 a month for a resolution desk and $3,000 a month with a creator-market settlement path. Lead time is measured and reported; there is no lead-time guarantee before 100 reconciled markets. Available once Resolve's operating entity exists and counsel has signed off.

## Private early reveals

Follow a public shadow market with `POST /v1/markets/{id}/follow` (open, non-test shadow markets only; `DELETE` to stop, `GET /v1/follows` to list). The follow limits in the table count follows of open markets: once a followed market settles, its follow no longer counts. If a plan changes to a lower limit, the oldest follows up to the new limit keep receiving early reveals and the rest stop until you unfollow markets or change plans; `GET /v1/follows` warns when this applies. From then on:

- `GET /v1/shadow/{market_id}` returns every committed verdict for the market, newest first: the verdict, its `commitment_sha256`, when it was committed and posted, and the evidence hashes.
- A webhook endpoint subscribed to `shadow.committed` receives each new committed verdict as soon as its commitment is recorded; `shadow.revealed` delivers the official outcome, the agreement and the preimage of each commitment once the platform resolves.
- An endpoint receives only the events it was registered with, and its events cannot be changed later. An endpoint registered before the `shadow.*` events existed is not subscribed to them. The follow response reports `endpoints_subscribed`, the number of your active endpoints that will receive `shadow.committed`, and adds a `warning` when that number is 0. In that case, register an endpoint whose `events` include `shadow.committed` and `shadow.revealed` (`POST /v1/webhooks`).

Early reveals are labeled "private early reveal — excluded from the public record". They never include the nonce or the preimage before the public reveal, so every commitment stays checkable by anyone: `sha256(preimage) = commitment_sha256` at `GET /v1/track-record/verify?hash=`.

## What we never claim

- No accuracy percentage appears in any offer, message or invoice before 100 markets on that platform have been reconciled against the platform of record, counted by distinct event (the legs of one multi-outcome event count once). Before that, we quote only your own markets' reconciled rows and measured lead times. The public track record (`GET /v1/track-record`) shows percentages only after 100 reconciled markets per platform.
- No lead-time claim before lead time has been measured on at least 30 distinct events.
- Resolve is an informational signal: not financial advice and not an oracle of record.

## Status (2026-09-24)

In the API: verdicts, watches, webhooks with the first delivery attempt at the event, follows, `GET /v1/shadow`, and the `shadow.committed` / `shadow.revealed` events. Prepared per customer, not self-serve yet: venue-shaped payloads, the weekly reconciliation report, monthly plan debits, pack bonuses and bulk export.

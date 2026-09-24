# Resolve for venues: Design Partner and the 30-day pilot

Resolve checks whether the stated condition of a prediction market has happened, from the sources registered for it, and commits every verdict publicly as a hash before the platform resolves. For a venue, that gives three things: an independent, pre-committed check of each manual resolution, a record you can point to when a resolution is questioned, and an audit log anyone can recompute. Prices are in US dollars and paid in USDC on Base. Last updated 2026-09-25.

## Two ways to start

### Design Partner: $750 a month

- Custom sources for one platform: we register and maintain the sources for your markets.
- Private early reveals for all of that platform's markets we shadow: each verdict reaches you by webhook when its commitment is recorded, before the public reveal.
- Webhooks in your platform's own identifiers (below).
- The weekly reconciliation report for your markets.
- Prepaid monthly in USDC, month to month. No SLA and no master agreement; it converts to a Platform agreement once Resolve's operating entity exists.

### 30-day venue pilot: $1,000

- Private early reveals for every market you name, for 30 days.
- Webhooks in your platform's own identifiers (below).
- The weekly reconciliation report for your markets.
- A named contact for the pilot.
- Paid once in USDC against an invoice, with a W-8BEN and a one-page pilot letter. The payment is credited to your account as the $1,000 pack: 120,000 credits for API calls.

Resolve is operated by its founder as an individual until its operating entity exists; the invoice, the W-8BEN and the pilot letter are issued on that basis.

## What you receive

**Webhooks in your platform's shape.** Every `shadow.committed` and `shadow.revealed` event carries a `venue` object next to the verdict, the commitment hash and the evidence hashes:

| Platform | `venue` fields |
|---|---|
| Limitless | `slug`, `group_slug`, `condition_id`, `proposed_winning_outcome_index` (0 = YES, 1 = NO, the index Limitless reports) |
| Polymarket | `condition_id`, `slug`, `event_id`, `proposed_outcome_label` |

A proposal is present only when the committed verdict is RESOLVED. When the evidence does not settle the market, the verdict is UNRESOLVED with its reasons and the proposal is `null`: Resolve abstains rather than guesses.

**The weekly reconciliation report.** Per market: when a verdict first became determinable, when it was committed and posted, when the first webhook reached you, the platform's official time and where that time comes from, the agreement, and the lead time. Per venue: markets, distinct events, reconciled events, agreement counts, and lead time p50 and p90 once at least five distinct events have a measured lead. Markets are named by their platform ids only. Every number comes from Resolve's record, and every commitment can be checked at `GET /v1/track-record/verify?hash=<sha256>`.

**An export.** `GET /v1/shadow/export?platform=&since=&format=csv` returns your followed markets as CSV or JSON: commitment, verdict, evidence hashes, and after the platform resolves, the official outcome, time, agreement and lead time.

## What it is not

- Not financial advice and not an oracle of record. Your resolution process stays yours; Resolve is an independent check beside it. Resolve never trades.
- No accuracy figure is quoted before 100 markets on your platform have been reconciled against your own outcomes, counted by distinct event (the legs of one multi-outcome event count once). Until then we quote only your own reconciled rows and the lead time measured on them.
- No lead-time guarantee. Lead time is measured and reported, never promised.
- No SLA during the pilot or the Design Partner term.
- Structured verdicts (machine-readable sources such as official statistics releases and central-bank decisions, GitHub objects, on-chain logs) are what the paid offer covers today. Verdicts that read free-text web evidence run on the public record as best effort and are reported apart; a request that cannot be answered for an upstream reason is refunded.
- We do not republish your market titles or resolution criteria without your written permission. Reports and posts name markets by slug and id.

## How to pay

1. Register the wallet you will pay from: `GET /v1/account/wallet/challenge?address=<your address>` returns a message; sign it with that wallet (`personal_sign`) and send the signature with `POST /v1/account/wallet` within 10 minutes.
2. Send USDC on Base (chain id 8453, USDC contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) from that wallet to the receiving address `GET /v1/payments/address` returns. The invoice states the same address; if the two ever differ, do not send, and ask.
3. The payment is credited once Base marks its block safe, typically 5 to 10 minutes; a `payment.credited` webhook reports it. Send the transaction hash with the invoice number so accounts can match it.

**Credits are a non-refundable prepayment for API services.** They are not a balance, wallet, deposit or stored value: they cannot be withdrawn, transferred to another account, or exchanged for money or crypto, and Resolve holds no funds on your behalf.

## Next step

Name the markets (or the category of markets) you want covered and a start date. You receive the pilot letter and the invoice for review before anything is paid.

Resolve publishes an informational signal: not financial advice, and not an oracle of record.

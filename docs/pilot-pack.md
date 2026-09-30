# Resolve for venues: Design Partner and the 30-day pilot

Resolve checks whether the stated condition of a prediction market has happened, from the sources registered for it, and commits every verdict publicly as a hash before the platform resolves. For a venue, that gives three things: an independent, pre-committed check of each manual resolution, a record you can point to when a resolution is questioned, and an audit log anyone can recompute. Prices are in US dollars, paid against an invoice. Last updated 2026-10-01.

## Two ways to start

### Design Partner: $750 a month

- Custom sources for one platform: we register and maintain the sources for your markets.
- Private early reveals for all of that platform's markets we shadow: each verdict reaches you by webhook when its commitment is recorded, before the public reveal. The account has no follow limit, so every one of those markets can be followed.
- Webhooks in your platform's own identifiers (below).
- The weekly reconciliation report for your markets.
- Prepaid monthly against an invoice, month to month. No SLA and no master agreement; it converts to a Platform agreement once Resolve's operating entity exists.

### 30-day venue pilot: $1,000

- Private early reveals for every market you name that Resolve shadows, for 30 days. The pilot account has no follow limit (the plan limits on the pricing page do not apply to it), so every named market can be followed.
- Webhooks in your platform's own identifiers (below).
- The weekly reconciliation report for your markets.
- A named contact for the pilot.
- Paid once against an invoice, with a W-9 and a one-page pilot letter. The payment is credited to your account as the $1,000 pack: 120,000 credits for API calls.

Resolve is operated by its founder as an individual until its operating entity exists; the invoice, the W-9 and the pilot letter are issued on that basis.

## What you receive

**Webhooks in your platform's shape.** Every `shadow.committed` and `shadow.revealed` event carries a `venue` object next to the verdict, the commitment hash and the evidence hashes:

| Platform | `venue` fields |
|---|---|
| Limitless | `slug`, `group_slug`, `condition_id`, `proposed_winning_outcome_index` (0 = YES, 1 = NO, the index Limitless reports) |
| Polymarket | `condition_id`, `slug`, `event_id`, `proposed_outcome_label` |

A proposal is present only when the committed verdict is RESOLVED. When the evidence does not settle the market, the verdict is UNRESOLVED with its reasons and the proposal is `null`: Resolve abstains rather than guesses.

**The weekly reconciliation report.** Per market: when a verdict first became determinable, when it was committed and posted, when its first `shadow.committed` webhook was delivered to your account (your deliveries only), the platform's official time and where that time comes from, the agreement, and the lead time. Per venue: markets, distinct events, reconciled events, agreement counts, and lead time p50 and p90 once at least five distinct events have a measured lead. Markets are named by their platform ids only. Every number comes from Resolve's record, and every commitment can be checked at `GET /v1/track-record/verify?hash=<sha256>`.

**An export.** `GET /v1/shadow/export?platform=&since=&format=csv` returns your followed markets as CSV or JSON: commitment, verdict, evidence hashes, and after the platform resolves, the official outcome, time, agreement and lead time.

## What it is not

- Not financial advice and not an oracle of record. Your resolution process stays yours; Resolve is an independent check beside it. Resolve never trades.
- No accuracy figure is quoted before 100 distinct events on your platform have been reconciled against your own outcomes (the legs of one multi-outcome event count once). Until then we quote only your own reconciled rows and the lead time measured on them.
- No lead-time guarantee. Lead time is measured and reported, never promised.
- No SLA during the pilot or the Design Partner term.
- Structured verdicts (machine-readable sources such as official statistics releases and central-bank decisions, GitHub objects, on-chain logs) are what the paid offer covers today. Verdicts that read free-text web evidence run on the public record as best effort and are reported apart; a request that cannot be answered for an upstream reason is refunded.
- We do not republish your market titles or resolution criteria without your written permission. Reports and posts name markets by slug and id.

## How to pay

1. You receive the pilot letter and the invoice for review before anything is paid. The invoice states how to pay it.
2. Resolve does not accept payment in USDC at present: no invoice names a wallet address, and `GET /v1/payments/address` answers that USDC deposits are not offered. Do not send USDC to any address for these offers.
3. Quote the invoice number with the payment. Once it is received, it is credited to the account named on the invoice: the $1,000 pack (120,000 credits) for the pilot, or the month's Design Partner prepayment.

**Credits are a non-refundable prepayment for API services.** They are not a balance, wallet, deposit or stored value: they cannot be withdrawn, transferred to another account, or exchanged for money or crypto, and Resolve holds no funds on your behalf.

## Next step

Name the markets (or the category of markets) you want covered and a start date. You receive the pilot letter and the invoice for review before anything is paid.

Resolve publishes an informational signal: not financial advice, and not an oracle of record.

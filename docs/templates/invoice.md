# Invoice

<!-- Template. Replace every <placeholder>; delete the line of the offer that does not apply. Keep the filled copy
     under private/ (gitignored), never in the repository. -->

| | |
|---|---|
| Invoice number | `<INV-YYYY-NNN>` |
| Issue date | `<YYYY-MM-DD>` |
| Due date | `<YYYY-MM-DD>` |
| Customer reference or PO | `<PO number, or "none">` |

**From**
`<Founder's full legal name>`, an individual operating Resolve
`<Street address>`, `<City>`, `<Country>`
`<Contact email or handle>`
Tax identification: `<tax id, or "none">`

**Bill to**
`<Customer legal name>`
`<Registered address>`
Attention: `<Accounts payable contact>`

## Services

| Description | Service period | Qty | Unit price (USD) | Amount (USD) |
|---|---|---|---|---|
| Resolve 30-day venue pilot for `<platform>` markets, as described in the pilot letter dated `<YYYY-MM-DD>` | `<start date>` to `<end date>` | 1 | 1,000.00 | 1,000.00 |
| Resolve Design Partner, `<platform>`, month of `<Month YYYY>` (prepaid) | `<start date>` to `<end date>` | 1 | 750.00 | 750.00 |
| **Total due** | | | | **`<amount>`** |

Taxes: `<none charged, or the tax and rate that applies: confirm with counsel>`.

## Payment

- Pay in USDC on Base (chain id 8453), USDC contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. For this invoice, 1 USDC settles 1 US dollar.
- Receiving address: `<0x receiving address, exactly as GET /v1/payments/address returns it>`. If the address your account's API returns differs from this one, do not send; ask first.
- Send from the wallet registered to your Resolve account: `<0x registered sender wallet>`. A payment from an unregistered wallet is held until it is matched to your account.
- After sending, reply with the transaction hash and this invoice number.

## Terms

- The payment is credited to account `<Resolve tenant id>` as `<120,000 credits (the $1,000 pack) | the month's Design Partner prepayment>`. Credits are a non-refundable prepayment for API services. They are not a balance, wallet, deposit or stored value: they cannot be withdrawn, transferred to another account, or exchanged for money or crypto, and Resolve holds no funds on the customer's behalf.
- Resolve publishes an informational signal: not financial advice, and not an oracle of record. No service level is part of this invoice.
- Resolve is operated by its founder as an individual until its operating entity exists; this invoice is issued on that basis. A W-9 is provided on request.

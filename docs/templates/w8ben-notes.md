# W-8BEN notes

> **Not tax or legal advice.** These are working notes for filling in IRS Form W-8BEN as a non-US individual. They do not
> say what tax you owe or whether a treaty applies to you. Confirm every choice with counsel before signing.

<!-- Keep the filled form under private/ (gitignored) or outside the repository: it holds personal data. -->

## What it is

Form W-8BEN ("Certificate of Foreign Status of Beneficial Owner for United States Tax Withholding and Reporting (Individuals)") is a statement, signed under penalty of perjury, that the payee is an individual who is not a US person, with the payee's country of residence and, optionally, a claim to a reduced rate of US withholding under a tax treaty.

- It is for **individuals**. A company uses Form W-8BEN-E instead; once Resolve's operating entity exists, the entity files that one.
- It is **given to the payer** (the withholding agent), never sent to the IRS.
- It generally stays valid until the last day of the third calendar year after the year it is signed (signed in `<YYYY>`: valid through 31 December of `<YYYY + 3>`), unless something on it changes, in which case a new one is due within 30 days.
- Download the current revision and its instructions from irs.gov (search "Form W-8BEN"); fill in the revision the payer asks for.

## When a payer asks for it

- A US company, or a payer with US tax reporting, asks before paying a non-US person so it can document why it does or does not withhold US tax.
- A non-US company (for example a Cayman Islands company) may ask for it as part of vendor onboarding even when it has no US withholding duty; its accounts-payable policy decides that.
- For Resolve: the pilot pack is issued by the founder as an individual, so the individual form applies. Send it with the invoice when the payer's onboarding asks for it; do not send it unasked.

## Field by field (non-US individual)

**Part I, Identification of Beneficial Owner**

| Line | What goes there | Notes |
|---|---|---|
| 1 | Name of individual who is the beneficial owner | Your full legal name as on your passport or national id. |
| 2 | Country of citizenship | `<country>`. |
| 3 | Permanent residence address | Street, city, postal code, country where you live for tax purposes. Not a P.O. box or an "in care of" address. |
| 4 | Mailing address | Only if different from line 3. |
| 5 | US taxpayer identification number (SSN or ITIN) | Usually left blank if you have none. A treaty claim can require one in some cases: confirm with counsel. |
| 6a | Foreign tax identifying number | Your tax number in your country of residence (`<national tax number>`). Required in most cases for a payee in a country that issues one. |
| 6b | Check if FTIN not legally required | Only if your country does not require one for you; confirm before ticking. |
| 7 | Reference number(s) | Optional: the invoice number or the payer's vendor id helps them file it. |
| 8 | Date of birth (MM-DD-YYYY) | Note the US order: month, day, year. |

**Part II, Claim of Tax Treaty Benefits** (lines 9 and 10)

- Line 9: the treaty country, if you claim a treaty benefit. Line 10: the article, the rate, the type of income and why you qualify.
- **Treaty claim: confirm with counsel.** Whether a treaty between your country of residence and the United States covers fees for services performed outside the United States, and which article applies, is a question for counsel. If no treaty benefit is claimed, leave Part II blank.

**Part III, Certification**

- Sign, date (MM-DD-YYYY) and print your name. Read the certifications first: they include that you are not a US person and that the income is not effectively connected with a US trade or business (or, if it is, that it is not subject to tax under a treaty).
- If any statement is not true for you, stop and ask counsel.

## Before sending

- The name on line 1 matches the invoice's "From" name.
- The address on line 3 matches the invoice.
- Keep a copy with the invoice under private/.
- Note the date it expires, and when anything on it changes.

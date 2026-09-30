# W-9 notes

> **Not tax or legal advice.** These are working notes for filling in IRS Form W-9 as a US individual. They do not say
> what tax you owe. Confirm anything you are unsure of with a tax preparer before signing.

<!-- Keep the filled form under private/ (gitignored) or outside the repository: it holds personal data (the SSN). -->

## What it is

Form W-9 ("Request for Taxpayer Identification Number and Certification") is a statement, signed under penalty of perjury, that gives a payer the payee's correct US taxpayer identification number and certifies that the payee is a US person.

- A US citizen is a **US person wherever they live**: the W-9 applies, never the W-8BEN. **Never sign a W-8BEN** as a US person: it certifies that the signer is not a US person.
- It is for the individual as long as Resolve has no operating entity. Once an entity exists, the entity gives its own W-9 with its EIN.
- It is **given to the payer** (the requester), never sent to the IRS.
- It has no fixed expiry: give a new one when something on it changes (name, address, TIN).
- Download the current revision and its instructions from irs.gov (search "Form W-9"); fill in the revision the payer asks for.

## When a payer asks for it

- A US company, a payment platform or a marketplace asks before paying a US person so it can report the payments to the IRS (for example on a Form 1099) and does not have to apply backup withholding.
- A non-US company (for example a Cayman Islands company) may ask for it as part of vendor onboarding; its accounts-payable policy decides that.
- For Resolve: the pilot pack is issued by the founder as an individual, so the individual form applies. Send it with the invoice when the payer's onboarding asks for it; do not send it unasked.

## Field by field (US individual, no business entity)

| Line | What goes there | Notes |
|---|---|---|
| 1 | Name | Your name as shown on your income tax return. |
| 2 | Business name / disregarded entity name | Blank unless you use a registered business name (`<business name>`). |
| 3a | Federal tax classification | Tick "Individual/sole proprietor". |
| 3b | Foreign partners, owners or beneficiaries | Blank: it is for partnerships, trusts and estates. |
| 4 | Exemptions | Blank for an individual. |
| 5 | Address | Street, apartment or suite: where the payer will mail tax forms (`<US address>`). |
| 6 | City, state, ZIP code | `<city, state, ZIP>`. |
| 7 | Account number(s) | Optional: the invoice number or the payer's vendor id (`<invoice number>`). |
| Part I | Taxpayer identification number | Your SSN (`<SSN>`). An EIN only if the payer asks for the business's number and you have one. |

**Part II, Certification**

- Sign and date. Read the certifications first: the TIN is correct, you are not subject to backup withholding (cross out item 2 if the IRS has told you that you are), you are a US citizen or other US person, and the FATCA code entered (if any) is correct.
- If any statement is not true for you, stop and ask a tax preparer.

## Before sending

- The name on line 1 matches the invoice's "From" name.
- The address on lines 5 and 6 matches the invoice.
- Send it by a secure channel the payer names (their vendor portal, not plain email where avoidable): it carries your SSN.
- Keep a copy with the invoice under private/.

# Venue pilot and Design Partner accounts

The offer: `docs/pilot-pack.md` and the pilot letter template `docs/templates/pilot-letter.md`. Plan §17.2 (#1), §17.5, §19.3. Code: `src/shadow/follows.ts` (follow limits), `src/shadow/venue.ts` (the `venue` object), `scripts/venue-report.ts` (the weekly report). Last updated 2026-09-25.

## Why the account needs its plan set

Both offers promise early reveals for every market in scope: every market the venue names for the pilot, or all of the platform's shadowed markets for Design Partner. A follow delivers only while it is within the plan's follow limit (`followCap`). Free and Builder allow 50 follows of open markets, PAYG and Growth 500, Platform no limit. The export and the webhooks apply the same rule. A USDC deposit credits the account (migration 020 `match_deposit`) but never changes `tenants.plan`. So a pilot account left on `payg` gets `cap_reached` at its 501st open follow, and those markets get no early reveal and no export row; it also pays 25 credits per RESOLVED reveal (at most 2,000 per event, `src/shadow/reveal.ts`), which the offers include. On `platform` reveals are included. Limitless alone has 267 manual markets (plan §17.2).

`tenants.plan` sets two things only: the follow limit, and the per-key rate limit (600 requests a minute on `platform`). Every follow, export and webhook read `tenants.plan` as it is at that moment, so a change applies at once.

## Steps

1. **Account on an uncapped plan.** For a new venue, create it with `POST /internal/tenants` and `{"display_name": "<venue>", "plan": "platform", "environment": "live"}`. For an account that already exists, the founder runs this in the Supabase SQL editor of `resolve-prod`: `update tenants set plan = 'platform' where id = '<tenant id>';`
2. **Markets registered.** Register the named markets with `scripts/seed-shadow.ts` from a candidate file generated on or after 2026-09-25 (`npx tsx scripts/candidates.ts limitless`). `--check` refuses a Limitless entry that has no `meta.outcome_labels` (the labels the proposed `winningOutcomeIndex` is taken over) and a group leg that has no `meta.group_slug`. A file from 2026-09-24 has neither, so regenerate it. A market registered without `group_slug` carries `group_slug: null` in its `venue` object.
3. **Follows and an endpoint.** With the venue's key, `POST /v1/webhooks` with `events` that include `shadow.committed` and `shadow.revealed`, then `POST /v1/markets/{id}/follow` for each market. A follow answer with `endpoints_subscribed: 0` means no webhook will arrive.
4. **Check before the pilot letter is sent.** With the venue's key, `GET /v1/follows` must show `follow_limit: null`, no `warning`, and `follows_counted` equal to the number of open markets in scope. Put the tenant id in the letter (item 1).
5. **Weekly report.** Run `npx tsx scripts/venue-report.ts --platform <platform> --tenant <tenant id>`. The first-delivered column shows only this tenant's deliveries (`v_venue_deliveries`, migration 021). A report without `--tenant` has no delivery column. The script prints how many markets have a delivery for the tenant. If that number is 0, check the tenant id, the follows and the endpoint before you send the report.
6. **After the pilot.** If the venue does not continue, set the plan back: `update tenants set plan = 'payg' where id = '<tenant id>';`. After that only its 500 oldest follows of open markets deliver, each RESOLVED reveal is charged 25 credits, and `GET /v1/follows` warns about the rest. If it continues as Design Partner, leave the plan as it is.

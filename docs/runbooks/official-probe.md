# Official source probe (from the Worker)

Code: `src/ingest/official-probe.ts`, route `POST /internal/official/probe` (`src/api/internal.ts`). Tests: `tests/official-probe.test.ts`. Last updated 2026-09-29.

## Why it exists

Public Base RPC endpoints answered a laptop but refused Cloudflare Worker egress (429/403). The official_release rail had never fetched live from the Worker. Its first live release is the BLS Employment Situation on 2026-10-02 12:30Z. This route shows which official hosts, and which election hosts for the next rails, answer the Worker **before** a release depends on them.

## What one call does

- **Every official series except the election contests** (or the ones asked for): the rail's own requests for the **latest published** period. It uses the same URLs through `officialGet`, so the series allowlist, the ResolveBot UA, the 8 s timeouts and redirects checked by hand all apply. Then the rail's parser runs on the answer. The latest period comes from the document itself: a BLS page states its month, and a feed or index lists its decisions (the newest one the parser accepts is taken). One BLS page is fetched once for all the series it states, as the slot holder does.
- **Corroboration.** When the primary gave a value, the call runs the rail's `fetchCorroboration` for it and reports `agree`, `disagree`, `unavailable`, `inconclusive` or `single_source`. When the primary gave no value (the host refused it, for example), the corroboration URL is still requested once and its latest row is reported as `reachability_only`.
- **Election hosts:** fixed constants only (`ELECTION_PROBES`): `https://resultados.tse.jus.br/`, `https://resultados.tse.jus.br/oficial/comum/config/ele-c.json`, `https://www.electionsquebec.qc.ca/` and `https://donnees.electionsquebec.qc.ca/production/provincial/resultats/resultats.json`. The TSE config and the Élections Québec results file are the election rail's own first requests, so this group is its access test before polls close (2026-10-04 20:00Z and 2026-10-06 00:00Z). The TSE config path is the one the public results app used in 2022 and 2024 and is unverified for 2026; a 404 from it still shows that the host answers. The Québec results file answers `{}` until polls close. A redirect is followed only to a host on that list. Bodies are counted, not parsed. The election series themselves (`br_pres_r1_*`, `qc_*`) have no latest period to read and are refused in `series`.
- **Writes nothing.** There is no database call, no R2 write, no alert and no Telegram message. The JSON answer (and one `console.log` summary line for `wrangler tail`) is the only output. One failing host never stops the others.

## Usage

Run one call per group. A body without `group` or `series` (an empty one included) is refused with a 400 that lists the groups. The CPU limit on Workers Free is 10 ms per invocation. Measured warm in Node, `central_banks` takes about 9 ms (most of it the BoK decision feed, about 0.9 MB), `bls` about 2 ms and `elections` well under 1 ms. All three groups in one call would take about 12 ms, over the limit.

```sh
URL=https://resolve.rafaemush.workers.dev
curl -sS -X POST -H "Authorization: Bearer <ADMIN_API_KEY>" -H "content-type: application/json" -d '{"group":"bls"}'           "$URL/internal/official/probe"
curl -sS -X POST -H "Authorization: Bearer <ADMIN_API_KEY>" -H "content-type: application/json" -d '{"group":"central_banks"}' "$URL/internal/official/probe"
curl -sS -X POST -H "Authorization: Bearer <ADMIN_API_KEY>" -H "content-type: application/json" -d '{"group":"elections"}'     "$URL/internal/official/probe"
```

| Body field | Values | Effect |
|---|---|---|
| `group` | `bls` | The 7 series read from www.bls.gov: CPI (4 series, one page), Employment Situation (2 series, one page), PPI. 3 page requests + 7 BLS API v1 requests = 10 (3 on a BLS release day, see below) |
| | `central_banks` | fomc_upper_bound, ecb_dfr, boe_bank_rate, bok_base_rate, kr_gdp_advance_yoy, bcb_selic_target: 8 primary + 5 corroboration = 13. `planned` says 14: from 1 January until the ECB's first meeting of the year, the current year's index names no decision, so the previous year's index is read as well |
| | `elections` | the 4 election URLs above = 4 |
| `series` | array of series ids | only these series (not together with `group`), e.g. `{"series":["us_unemployment_rate"]}` = 2 requests |
| `corroboration` | `false` | skip the corroborating requests |
| (neither `group` nor `series`) | | refused with a 400 |

- Every call is capped at **40 subrequests**, redirect hops included (Workers Free allows 50). Past the cap, a request reports `request budget exhausted` and is not made. A plan that could need more than 40 before redirects is refused with a 400.
- Without a key, the BLS API v1 allows **25 queries a day**, possibly per shared egress IP. The `bls` group spends 7 of them. On the ET day of any scheduled BLS release (the BLS entries of `KNOWN_RELEASES` in `src/resolve/official.ts`: 2026-10-02, 10-14, 10-15, 11-06, 11-10 and 11-13 at the moment. The December releases are not registry events until BLS posts its 2027 schedule, because their fallback is the next release; see `src/resolve/release-calendar.ts`), the probe does not request the BLS API at all, even with `"corroboration": true`. Each BLS corroboration then reads `skipped` with the reason, and `data.bls_api_hold` names the release. The quota that day belongs to the rail. To test api.bls.gov, run the probe the day before a release.
- If a call answers Cloudflare error 1102 or a bare 503 (the CPU limit), narrow it to fewer series with `series`.

## Reading the answer

`data.hosts` gives, per host, the status of every exchange and `answered_200`. That is the first thing to check. `data.series_results[]` gives, per series, the `period` and value the primary parsed and the corroboration's status. `data.requests[]` gives, per request: `role` (primary, corroboration or election), `host`, `path` (a query string is shown as `?…`), `status`, `bytes` (a body that was read), `content_length` (the Content-Length header of a 3xx or non-200 body that was dropped unread, when the host sent one), `content_type`, `server`, `ms` (summed over redirect hops), `redirects`, `hops[]`, `error` and `parsed[]` (what the rail's parser read: `ok`, `period`, `value_text`, or the parse error). `data.colo` is the Cloudflare location the call ran in.

No query string is echoed anywhere in the answer. Every `error` and `detail` text shows a URL, including a redirect target the upstream chose, as host + path with its query as `?…`. Anything shaped like a credential is then redacted.

**Day-dated series (boe_bank_rate, bok_base_rate, bcb_selic_target).** Here `period` is the date the document itself gives: the BoE item's pubDate, the date in the BoK item title, and the Copom meeting date (BRT). The rail asks for the market's scheduled decision day and answers pending unless the document gives exactly that day. The probe cannot know the schedule, so check `period` against the scheduled date of that latest meeting. For the BoE the item is matched by month, and the pubDate leads the `detail` (`pubDate Thu, 17 Sep 2026 12:00:00 +0100; …`). A pubDate a day off the MPC date means the rail would never observe the value.

A host that answers 403 or 429 with `server: AkamaiGHost` or a Cloudflare challenge page refuses the Worker. `content_length` tells the two apart without reading the body: a challenge page is several KB of HTML, a bare "Access Denied" much less. The rail cannot use such a host from the Worker, so its fallback has to be decided before the release.

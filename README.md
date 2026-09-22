# Resolve

Automated resolution infrastructure for long-tail prediction markets: register a market condition and its sources, and get back a strict, contract-validated verdict with evidence hashes and provenance.

```
{ market_id, resolution_status: RESOLVED|UNRESOLVED|ERROR, winning_outcome: OPTION_A|OPTION_B|NONE,
  confidence_score: 0.00-0.99, error_code: null|INSUFFICIENT_DATA|SOURCE_MISMATCH|UNSAFE_INPUT|UPSTREAM_UNAVAILABLE, ... }
```

How a verdict is produced: deterministic pre-checks (hidden-Unicode and injection markers, source allow-list, anchor localization, time window, integrity, language) → structured resolvers for machine-readable sources (GitHub API, Base and Solana logs, numeric thresholds) with a coverage proof before any negative verdict → otherwise one call to TypeSafe's Jev model with a fixed battery of typed questions → threshold post-checks → a verdict the database itself refuses to store if it violates the contract invariants.

Stack: TypeScript on Cloudflare Workers, Supabase Postgres (pg_cron + pg_net scheduling), Jev (`jev-1.13.0`, pinned).

## Evals

`evals/cases/*.jsonl` is a frozen failure-injection suite (classes A–I: clean structured, clean unstructured, insufficient/corrupt, source mismatch, ambiguous, malicious, router refusals, upstream faults, absence without coverage). `pnpm eval --mode replay` grades it deterministically; `pnpm eval:mutate` switches off one rail at a time and requires the suite to go red for a grader reason.

Every published accuracy or latency number is rendered from database rows (`eval_runs`, `bench_runs`, `v_track_record`), never typed by hand. No number is published until it exists.

## Status

Pre-launch. Nothing here is financial advice or an oracle of record.

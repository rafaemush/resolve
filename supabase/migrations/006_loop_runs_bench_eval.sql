-- Migration 006 — loop_runs, bench_runs, eval_runs (Resolve, 2026-09-22).
--
-- WHY: a job that runs, exits 0 and writes nothing is `no_op`, not `success`
-- (OilFlow migration 247). verifier_name <> loop_name is a DB CHECK so no loop
-- can grade itself. bench_runs and eval_runs exist so every public latency or
-- accuracy number traces to a row written by a machine, never typed by hand.

begin;

create table if not exists loop_runs (
  id            bigint generated always as identity primary key,
  loop_name     text not null,
  started_at    timestamptz not null default now(),
  duration_ms   integer not null default 0 check (duration_ms >= 0),
  outcome       text not null check (outcome in ('success','failure','skipped','no_op')),
  rows_written  integer not null default 0 check (rows_written >= 0),
  cost_usd      numeric(10,6) not null default 0,
  verifier_name text,
  verifier_ok   boolean,
  error         text,
  meta          jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  constraint loop_runs_verifier_is_not_author check (verifier_name is null or verifier_name <> loop_name)
);
comment on table loop_runs is 'One row per watch invocation, cron tick, reconcile pass and heartbeat. rows_written=0 with exit 0 is recorded as no_op so silent no-ops are visible.';
create index if not exists idx_loop_runs_name_time on loop_runs (loop_name, started_at desc);
create index if not exists idx_loop_runs_bad on loop_runs (loop_name, started_at desc) where outcome in ('failure','no_op');
select apply_rls('loop_runs');

create table if not exists bench_runs (
  id         bigint generated always as identity primary key,
  runner     text not null check (runner in ('cf_worker','gh_actions_us','laptop_pk','other')),
  colo       text,
  n          integer not null check (n > 0),
  p50_ms     integer not null,
  p95_ms     integer not null,
  max_ms     integer not null,
  jev_model  text not null,
  git_sha    text,
  ran_at     timestamptz not null default now(),
  meta       jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object')
);
comment on table bench_runs is 'Latency benchmark rows. Public copy may quote only what a row here shows, per runner/colo.';
select apply_rls('bench_runs');

create table if not exists eval_runs (
  id             bigint generated always as identity primary key,
  suite_sha256   text not null,
  git_sha        text,
  mode           text not null check (mode in ('replay','live','mutate')),
  model          text,
  cases          integer not null,
  passed         integer not null,
  false_resolved integer not null,
  recall         numeric(5,4),
  brier          numeric(6,4),
  ece            numeric(6,4),
  p50_ms         integer,
  cost_usd       numeric(10,6) not null default 0,
  runner_region  text,
  grader_fail    integer not null default 0,
  harness_error  integer not null default 0,
  mutation       text,
  ran_at         timestamptz not null default now(),
  meta           jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object')
);
comment on table eval_runs is 'Every failure-injection suite run, inserted through /internal/eval-report with a scoped key. suite_sha256 pins the frozen case set; git_sha pins the code.';
drop trigger if exists eval_runs_append_only on eval_runs;
create trigger eval_runs_append_only before update or delete on eval_runs for each row execute function deny_mutation();
select apply_rls('eval_runs');

create or replace function public.report_eval_run(p jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into eval_runs (suite_sha256, git_sha, mode, model, cases, passed, false_resolved, recall, brier, ece, p50_ms, cost_usd, runner_region, grader_fail, harness_error, mutation, meta)
  values (p->>'suite_sha256', p->>'git_sha', p->>'mode', p->>'model', (p->>'cases')::int, (p->>'passed')::int, (p->>'false_resolved')::int,
          (p->>'recall')::numeric, (p->>'brier')::numeric, (p->>'ece')::numeric, (p->>'p50_ms')::int, coalesce((p->>'cost_usd')::numeric, 0),
          p->>'runner_region', coalesce((p->>'grader_fail')::int, 0), coalesce((p->>'harness_error')::int, 0), p->>'mutation', coalesce(p->'meta', '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.report_eval_run(jsonb) from public;
grant execute on function public.report_eval_run(jsonb) to service_role;

commit;

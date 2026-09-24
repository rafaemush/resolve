#!/usr/bin/env bash
# Deploy gate for the Resolve Worker (plan §16.4 P0 steps 4-5, §19.2 item 7). The Worker is deployed only from a clean,
# committed tree on which every gate below is green, and the deployed Worker must then report that commit on /health.
# That commit must already be on origin/main, so /health.git_sha always names a commit anyone can read in the public
# repo's main; DRY_RUN=1 only notes what a real deploy would refuse. No override: `pnpm run deploy:raw` is the hatch.
#
#   pnpm run deploy       gates, then wrangler deploy --var GIT_SHA:<HEAD>, then GET /health must answer git_sha = HEAD
#   pnpm run deploy:dry   DRY_RUN=1: the same gates, nothing deployed
#   (plain `pnpm deploy` is pnpm's own workspace command and never reaches this file; `npm run deploy` works too.
#    `pnpm run deploy:raw` is the ungated escape hatch: it ships without GIT_SHA, so /health then says "dev".)
#
# Gates (all of them run, so one run shows every red; any red stops the deploy). CI runs the same ones:
#   typecheck, vitest, frozen eval suite = authored cases, eval replay (no --skip-missing: a missing Jev fixture is red),
#   mutation harness --strict (a mutation that stays green is red), OpenAPI document = contract, Worker bundle builds
#   (wrangler --dry-run, no upload), and the gates left HEAD and the tree as they found them.
# Not a gate yet: selftest-db's rollback-only block (plan §16.4 P0 step 4). It runs against whatever database .env names
# and its concurrency probe persists rows, so it joins once staging exists and the script is split (P0 steps 3, 10).
#
# Credentials: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment, else from this repo's .env. Only
# those two keys and the non-secret RESOLVE_PUBLIC_URL are read from .env by this shell; no value is ever printed. The
# two Cloudflare values reach wrangler deploy only: every gate and the health check run with both defined as empty,
# which scripts/lib/env.ts keeps (it never replaces a variable that is already defined, so evals/run.ts cannot re-import
# them from .env), and both wrangler calls get --env-file of an empty file, since wrangler otherwise loads .env itself
# and replaces an empty value from it. The real deploy therefore uses exactly the source printed before it; with
# neither set, wrangler uses its own login. The gates run with EVAL_LIVE=0, so no test or eval can call a paid API.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
cd "$(git rev-parse --show-toplevel)"

DEFAULT_PUBLIC_URL="https://resolve.rafaemush.workers.dev"

say() { printf '%s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

# DRY_RUN must be exactly 0 or 1: DRY_RUN=true meaning "deploy for real" would be the worst possible misreading.
case "${DRY_RUN:-0}" in
  0) dry=0 ;;
  1) dry=1 ;;
  *) printf 'deploy: DRY_RUN must be 0 or 1, got "%s"\n' "$DRY_RUN" >&2; exit 2 ;;
esac

# Production runs only commits on origin/main: an unpushed commit or an unmerged branch is refused, whatever branch
# name is checked out (the commit is what ships). origin/main is the ref this clone updated on its last push or fetch
# (no network here): a stale ref can refuse a pushed commit (push or fetch, then rerun) but never pass one that was
# never on the remote's main.
if ! git merge-base --is-ancestor HEAD refs/remotes/origin/main 2>/dev/null; then
  unpublished="HEAD $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD)) is not on origin/main: push it to main first (git push origin main) so the deployed commit is one the public repo's main has"
  [ "$dry" = 1 ] || die "refused: $unpublished"
  say "note: $unpublished; DRY_RUN=1 runs the gates, a real deploy refuses"
elif behind=$(git rev-list --count HEAD..refs/remotes/origin/main) && [ "$behind" -gt 0 ]; then
  say "note: HEAD is $behind commit(s) behind origin/main: this deploys an older commit of main"
fi

for bin in tsc vitest tsx wrangler; do
  [ -x "node_modules/.bin/$bin" ] || die "node_modules/.bin/$bin is missing: run pnpm install --frozen-lockfile first"
done

# The deploy ships HEAD, so everything must be committed: an untracked file under src/ would be bundled unreviewed.
dirty=$(git status --porcelain --untracked-files=normal)
if [ -n "$dirty" ]; then
  say "deploy: refused, the working tree is not clean (commit or stash first):" >&2
  printf '%s\n' "$dirty" | head -n 25 >&2 || true
  exit 1
fi
head_sha=$(git rev-parse HEAD)

# The value of one key in ./.env, parsed like scripts/lib/env.ts (KEY=VALUE, the last one wins, one pair of surrounding
# quotes dropped). Nothing else in the file reaches this shell.
dotenv_value() {
  local key=$1 line val
  [ -f .env ] || return 0
  line=$(grep -E "^[[:space:]]*${key}[[:space:]]*=" .env | tail -n 1 || true)
  [ -n "$line" ] || return 0
  val=${line#*=}
  val=${val%$'\r'}
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  if [ "${#val}" -ge 2 ] && { [[ $val == \"*\" ]] || [[ $val == \'*\' ]]; }; then val=${val:1:${#val}-2}; fi
  printf '%s' "$val"
}

# Where each Cloudflare credential comes from (never its value). Exported just before wrangler deploy, never earlier.
cf_token=${CLOUDFLARE_API_TOKEN:-} cf_token_src="environment"
cf_account=${CLOUDFLARE_ACCOUNT_ID:-} cf_account_src="environment"
if [ -z "$cf_token" ]; then cf_token=$(dotenv_value CLOUDFLARE_API_TOKEN); cf_token_src=".env"; fi
if [ -z "$cf_account" ]; then cf_account=$(dotenv_value CLOUDFLARE_ACCOUNT_ID); cf_account_src=".env"; fi
[ -n "$cf_token" ] || cf_token_src="not set"
[ -n "$cf_account" ] || cf_account_src="not set"

public_url=${RESOLVE_PUBLIC_URL:-}
[ -n "$public_url" ] || public_url=$(dotenv_value RESOLVE_PUBLIC_URL)
[ -n "$public_url" ] || public_url=$DEFAULT_PUBLIC_URL
public_url=${public_url%/}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# wrangler's --env-file: an empty file, so wrangler never loads .env (see Credentials above)
no_env="$tmp/empty.env"
: >"$no_env"

export EVAL_LIVE=0 WRANGLER_SEND_METRICS=false

say "deploy gate: HEAD $head_sha ($(git log -1 --format=%s | cut -c1-80))"
say "mode: $([ "$dry" = 1 ] && echo "DRY_RUN=1, gates only" || echo "gates, then deploy to $public_url")"

gate_names=()
gate_results=()
gate_secs=()
failed=0

# Run one gate (a command with both Cloudflare values defined as empty, or a function of this script) and record
# PASS/FAIL and the time taken.
without_cf() { env CLOUDFLARE_API_TOKEN= CLOUDFLARE_ACCOUNT_ID= "$@"; }
run_gate() {
  local name=$1 t0=$SECONDS rc=0
  shift
  say ""
  say "=== gate: $name: $*"
  if declare -F "$1" >/dev/null; then "$@" || rc=$?; else without_cf "$@" || rc=$?; fi
  gate_names+=("$name")
  gate_secs+=("$((SECONDS - t0))")
  if [ "$rc" -eq 0 ]; then gate_results+=("PASS"); else gate_results+=("FAIL (exit $rc)"); failed=$((failed + 1)); fi
}

tree_unchanged() {
  local now
  now=$(git rev-parse HEAD)
  [ "$now" = "$head_sha" ] || { say "HEAD moved from $head_sha to $now while the gates ran"; return 1; }
  [ -z "$(git status --porcelain --untracked-files=normal)" ] || { say "a gate changed the working tree:"; git status --short; return 1; }
  say "HEAD and the working tree are as the gates found them"
}

run_gate "typecheck" npx tsc --noEmit
run_gate "vitest" npx vitest run
run_gate "eval suite frozen" npx tsx evals/build.ts --check
run_gate "eval replay" npx tsx evals/run.ts --mode replay
run_gate "mutations strict" npx tsx evals/mutate.ts --strict
run_gate "openapi" npx tsx scripts/openapi.ts --check
run_gate "worker bundle" npx wrangler deploy --dry-run --env-file "$no_env" --outdir "$tmp/bundle" --var "GIT_SHA:$head_sha"
run_gate "tree unchanged" tree_unchanged

say ""
say "gate summary: HEAD ${head_sha:0:12}$([ "$dry" = 1 ] && echo ", DRY_RUN=1")"
for i in "${!gate_names[@]}"; do
  printf '  %-15s %-20s %4ss\n' "${gate_results[$i]}" "${gate_names[$i]}" "${gate_secs[$i]}"
done
if [ "$failed" -gt 0 ]; then
  say "$failed of ${#gate_names[@]} gates red: nothing deployed"
  exit 1
fi
say "all ${#gate_names[@]} gates green"
say "cloudflare credentials: CLOUDFLARE_API_TOKEN $cf_token_src, CLOUDFLARE_ACCOUNT_ID $cf_account_src$([ "$cf_token_src" = "not set" ] && echo " (wrangler deploy will use wrangler login)")"

if [ "$dry" = 1 ]; then
  say "DRY_RUN=1: not deploying"
  exit 0
fi

say ""
say "=== deploy: wrangler deploy --var GIT_SHA:$head_sha"
[ -z "$cf_token" ] || export CLOUDFLARE_API_TOKEN="$cf_token"
[ -z "$cf_account" ] || export CLOUDFLARE_ACCOUNT_ID="$cf_account"
npx wrangler deploy --env-file "$no_env" --var "GIT_SHA:$head_sha" || die "wrangler deploy failed (its output is above); /health was not checked"

# /health must report the commit just deployed (scripts/lib/health.ts): the Worker answering with another version, a
# non-200 or another git_sha fails, and so does Cloudflare's own 5xx on every attempt (the Worker threw or hit a limit);
# not reaching it from this network (the founder's ISP blocks *.workers.dev) warns.
say ""
say "=== health: $public_url/health must report git_sha $head_sha"
without_cf npx tsx scripts/health-check.ts "$public_url" "$head_sha" \
  || die "deployed $head_sha, but the Worker does not report it (above)"

/**
 * runWatch end to end with the I/O edges replaced: an in-memory stand-in for the PostgREST calls runWatch makes,
 * a stubbed fetch for GitHub, and mocks for the resolver runtime, the commit bot and alerts. Proves the §16.2
 * defects are gone at the level that matters: rows written, R2 objects, resolutions, alerts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, Config } from "../src/env";

type Row = Record<string, unknown>;
type Filter = [op: "eq" | "gte" | "or", col: string, val: unknown];

const h = vi.hoisted(() => {
  const LOOKED = { resolution_status: "UNRESOLVED", winning_outcome: "NONE", error_code: null, error_reason: null } as Row;
  const state = {
    watch: {} as Row, evidence: [] as Row[], resolutions: [] as Row[], loopRuns: [] as Row[],
    failEvidenceInsert: false, failLoopRuns: false, failWatchUpdate: false, seq: 0, verdict: LOOKED,
  };
  // PostgREST or=(a.is.null,a.neq.X) with SQL semantics: neq never matches NULL.
  const orTerm = (r: Row, term: string) => {
    const [c, op, ...rest] = term.split(".");
    const v = rest.join(".");
    if (op === "is" && v === "null") return r[c!] === null || r[c!] === undefined;
    if (op === "neq") return r[c!] !== null && r[c!] !== undefined && r[c!] !== v;
    throw new Error(`fake client: unsupported or term ${term}`);
  };
  const match = (r: Row, f: Filter[]) => f.every(([op, c, v]) => (op === "eq" ? r[c] === v : op === "gte" ? String(r[c]) >= String(v) : String(v).split(",").some((t) => orTerm(r, t))));
  class Q implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
    action: "select" | "insert" | "update" = "select";
    payload: Row | undefined;
    filters: Filter[] = [];
    head = false;
    constructor(private table: string) {}
    select(_cols?: string, opts?: { head?: boolean }) { if (this.action === "select") this.head = !!opts?.head; return this; }
    insert(p: Row) { this.action = "insert"; this.payload = p; return this; }
    update(p: Row) { this.action = "update"; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.filters.push(["eq", c, v]); return this; }
    gte(c: string, v: unknown) { this.filters.push(["gte", c, v]); return this; }
    or(expr: string) { this.filters.push(["or", "", expr]); return this; }
    order() { return this; }
    limit() { return this; }
    single() { return Promise.resolve(this.exec()); }
    maybeSingle() { return Promise.resolve(this.exec()); }
    then<A, B>(ok?: ((v: { data: unknown; error: unknown; count?: number }) => A | PromiseLike<A>) | null, no?: ((e: unknown) => B | PromiseLike<B>) | null) { return Promise.resolve(this.exec()).then(ok, no); }
    exec(): { data: unknown; error: unknown; count?: number } {
      const t = this.table;
      if (t === "watches" && this.action === "select") return { data: structuredClone(state.watch ?? null), error: null };
      if (t === "watches" && this.action === "update") {
        if (state.failWatchUpdate) return { data: null, error: { code: "23514", message: "new row violates check constraint" } };
        Object.assign(state.watch, structuredClone(this.payload)); return { data: null, error: null };
      }
      if (t === "loop_runs") {
        if (state.failLoopRuns) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
        state.loopRuns.push(this.payload!); return { data: null, error: null };
      }
      if (t === "evidence" && this.action === "insert") {
        if (state.failEvidenceInsert) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
        const p = this.payload!;
        if (state.evidence.some((e) => e.market_id === p.market_id && e.raw_sha256 === p.raw_sha256)) return { data: null, error: { code: "23505", message: "duplicate key" } };
        const row = { id: `ev${++state.seq}`, ...p };
        state.evidence.push(row);
        return { data: { id: row.id }, error: null };
      }
      if (t === "evidence" && this.action === "select") return { data: state.evidence.find((e) => match(e, this.filters)) ?? null, error: null };
      if (t === "evidence" && this.action === "update") { for (const e of state.evidence) if (match(e, this.filters)) Object.assign(e, this.payload); return { data: null, error: null }; }
      if (t === "resolutions" && this.action === "select" && this.head) return { data: null, error: null, count: state.resolutions.filter((r) => match(r, this.filters)).length };
      if (t === "resolutions" && this.action === "update") { for (const r of state.resolutions) if (match(r, this.filters)) Object.assign(r, this.payload); return { data: null, error: null }; }
      throw new Error(`fake client: unexpected ${this.action} on ${t}`);
    }
  }
  // Shadow runs never call an RPC; tenant tests install begin_resolution / refund_credits answers.
  const rpc = vi.fn(async (_client: unknown, fn: string, _args: Row): Promise<unknown> => { throw new Error(`rpc ${fn} not expected`); });
  return { state, LOOKED, rpc, client: { from: (t: string) => new Q(t) } };
});

vi.mock("../src/db/supabase", () => ({ db: () => h.client, rpc: h.rpc }));
vi.mock("../src/resolve/runtime", () => ({
  JevUnavailableError: class extends Error {},
  // The real runtime calls beforeJev (bill-then-run) right before Jev; a could-not-look verdict comes back as a
  // complete row with error_code UPSTREAM_UNAVAILABLE, exactly like src/resolve/runtime.ts writes it.
  resolveWithRuntime: vi.fn(async (_env: unknown, _cfg: unknown, o: { marketId: string; evidenceId: string | null; creditsCharged: number; beforeJev?: () => Promise<void> }) => {
    if (o.beforeJev) await o.beforeJev();
    const v = h.state.verdict;
    const id = `res${h.state.resolutions.length + 1}`;
    h.state.resolutions.push({ id, market_id: o.marketId, evidence_id: o.evidenceId, status_row: "complete", error_code: v.error_code, credits_refunded: 0, created_at: new Date().toISOString() });
    return { resolutionId: id, jevCalls: 0, jevCostUsd: 0, result: { verdict: v, pre: { windows: [], markers: [] } } };
  }),
}));
vi.mock("../src/bot/commit", () => ({ commitVerdict: vi.fn(async () => ({ committed: true, posted: false, reason: "recorded without channel" })) }));
vi.mock("../src/webhooks/deliver", () => ({ enqueueEvent: vi.fn() }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { runWatch } from "../src/ingest/watch";
import { resolveWithRuntime } from "../src/resolve/runtime";
import { alert } from "../src/ops/alerts";
import { commitVerdict } from "../src/bot/commit";
import { enqueueEvent } from "../src/webhooks/deliver";
import { projectForChange } from "../src/ingest/projection";
import { sha256Hex } from "../src/resolve/text";

const WATCH_ID = "11111111-1111-4111-8111-111111111111";
const MARKET_ID = "22222222-2222-4222-8222-222222222222";
const RATE_LIMIT_403 = '{"message":"API rate limit exceeded for 162.158.0.1. (But here\'s the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)","documentation_url":"https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting"}';
const repo = (n: number) => ({ id: 1, full_name: "openai/openai-python", stargazers_count: 27_000 + n, forks_count: 4_000 + n, open_issues_count: 300 + n, pushed_at: `2026-09-23T06:0${n}:00Z`, updated_at: `2026-09-23T06:0${n}:30Z` });
const pr = (n: number, merged_at: string | null = null) => ({ number: 4821, state: merged_at ? "closed" : "open", merged: !!merged_at, merged_at, closed_at: merged_at, draft: false, title: "retry on 529", merge_commit_sha: "9f1c", updated_at: `2026-09-23T06:0${n}:59Z`, head: { ref: "x", sha: `h${n}`, repo: repo(n) }, base: { ref: "main", sha: "b", repo: repo(n) } });

function market(deadlineMsFromNow: number): Row {
  return {
    id: MARKET_ID, tenant_id: null, status: "open", platform: "custom", external_id: "smoke-pr", condition: "c", event_statement: "e", option_a: "a", option_b: "b", positive_option: "OPTION_A",
    anchors: ["openai/openai-python"], sources: [{ kind: "github_api", ref: "repos/openai/openai-python/pulls/4821" }], open_at: "2026-09-01T00:00:00Z",
    deadline_utc: new Date(Date.now() + deadlineMsFromNow).toISOString(), grace_seconds: 3600, resolver: { kind: "github_pr_merged", repo: "openai/openai-python", pr: 4821 }, negative_rule: "absence_after_deadline", allow_prerelease: false,
  };
}
function resetWatch(over: Row = {}, deadlineMsFromNow = 7 * 86_400_000) {
  h.state.watch = {
    id: WATCH_ID, market_id: MARKET_ID, source_kind: "github_api", source_ref: { ref: "repos/openai/openai-python/pulls/4821" }, poll_interval_s: 300,
    next_poll_at: new Date(Date.now() + 300_000).toISOString(), etag: null, cursor: {}, coverage: [], last_evidence_hash: null, last_canonical_hash: null, last_http_status: null,
    consecutive_errors: 0, backlog: false, active: true, markets: market(deadlineMsFromNow), ...over,
  };
}
function serve(status: number, body: string, headers: Record<string, string> = {}) {
  vi.stubGlobal("fetch", async () => new Response(body, { status, headers: { "content-type": "application/json", date: new Date().toUTCString(), ...headers } }));
}
/** GitHub's conditional GET: 304 when If-None-Match carries the current etag. */
function serveConditional(body: string, etag: string) {
  vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => {
    const date = new Date().toUTCString();
    if ((init?.headers as Record<string, string> | undefined)?.["If-None-Match"] === etag) return new Response(null, { status: 304, headers: { etag, date } });
    return new Response(body, { status: 200, headers: { "content-type": "application/json", etag, date } });
  });
}
const COULD_NOT_LOOK = { resolution_status: "ERROR", winning_outcome: "NONE", error_code: "UPSTREAM_UNAVAILABLE", error_reason: "MODEL_UNAVAILABLE" };

let put: ReturnType<typeof vi.fn>;
const env = () => ({ RAW: { put } }) as unknown as Env;
const cfg = { botUa: "ResolveBot/test" } as Config;
const alertKeys = () => vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes]);

beforeEach(() => {
  Object.assign(h.state, { evidence: [], resolutions: [], loopRuns: [], failEvidenceInsert: false, failLoopRuns: false, failWatchUpdate: false, seq: 0, verdict: h.LOOKED });
  put = vi.fn(async () => ({}));
  vi.mocked(resolveWithRuntime).mockClear();
  vi.mocked(alert).mockClear();
  vi.mocked(commitVerdict).mockClear();
  vi.mocked(enqueueEvent).mockClear();
  h.rpc.mockClear();
  resetWatch();
});
afterEach(() => vi.unstubAllGlobals());

describe("runWatch change detection (§16.2: 42/42 PR polls stored and re-resolved)", () => {
  it("counter-only changes are no_ops; a merge is a change", async () => {
    serve(200, JSON.stringify(pr(1)));
    const r1 = await runWatch(env(), cfg, WATCH_ID);
    expect(r1.outcome).toBe("success");
    expect(r1.detail).toMatch(/^first_observation /);
    expect(h.state.evidence).toHaveLength(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(resolveWithRuntime).toHaveBeenCalledTimes(1);
    const w1 = { ...h.state.watch };
    expect(w1.last_http_status).toBe(200);
    expect(w1.last_evidence_hash).toBe(h.state.evidence[0]!.raw_sha256);
    expect(w1.last_canonical_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(w1.last_canonical_hash).not.toBe(w1.last_evidence_hash);

    serve(200, JSON.stringify(pr(7)));
    const r2 = await runWatch(env(), cfg, WATCH_ID);
    expect(r2.outcome).toBe("no_op");
    expect(r2.rows_written).toBe(0);
    expect(h.state.evidence).toHaveLength(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(resolveWithRuntime).toHaveBeenCalledTimes(1);
    expect(h.state.watch.last_canonical_hash).toBe(w1.last_canonical_hash);
    expect(h.state.watch.last_evidence_hash).toBe(w1.last_evidence_hash);
    expect(h.state.watch.lease_until).toBeNull();
    expect((h.state.watch.cursor as Row).updated_at).toBe("2026-09-23T06:07:59Z"); // cursor advanced on the no_op
    expect((h.state.watch.coverage as Row[]).at(-1)!.status).toBe("ok");

    serve(200, JSON.stringify(pr(8, "2026-09-23T06:08:30Z")));
    const r3 = await runWatch(env(), cfg, WATCH_ID);
    expect(r3.outcome).toBe("success");
    expect(r3.detail).toMatch(/^changed /);
    expect(h.state.evidence).toHaveLength(2);
    expect(resolveWithRuntime).toHaveBeenCalledTimes(2);
    expect(h.state.loopRuns.map((l) => l.outcome)).toEqual(["success", "no_op", "success"]);
  });

  it("after deadline + grace an unchanged projection is stored once for the absence proof, then no_op", async () => {
    const lastHash = await sha256Hex(projectForChange("github_api", { kind: "github_pr_merged" }, { source_kind: "github_api", structured: pr(1), fetched_at: new Date().toISOString() }));
    resetWatch({ last_canonical_hash: lastHash, last_evidence_hash: "0".repeat(64) }, -2 * 86_400_000);
    serve(200, JSON.stringify(pr(3)));
    const r1 = await runWatch(env(), cfg, WATCH_ID);
    expect(r1.outcome).toBe("success");
    expect(r1.detail).toMatch(/^post_deadline_observation /);
    expect(h.state.evidence).toHaveLength(1);
    expect(resolveWithRuntime).toHaveBeenCalledTimes(1);

    serve(200, JSON.stringify(pr(4)));
    const r2 = await runWatch(env(), cfg, WATCH_ID);
    expect(r2.outcome).toBe("no_op");
    expect(h.state.evidence).toHaveLength(1);
    expect(resolveWithRuntime).toHaveBeenCalledTimes(1);
  });
});

describe("runWatch failures never become evidence (§16.2: 28 HTTP 403 bodies became verdicts)", () => {
  it("403 rate limit: no evidence, no resolution, status and streak recorded, deferred, alerts at the transition and at 3", async () => {
    resetWatch({ last_http_status: 200 });
    const reset = Math.floor(Date.now() / 1000) + 1800;
    serve(403, RATE_LIMIT_403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
    const r1 = await runWatch(env(), cfg, WATCH_ID);
    expect(r1.outcome).toBe("failure");
    expect(r1.detail).toContain("github 403");
    expect(h.state.evidence).toHaveLength(0);
    expect(put).not.toHaveBeenCalled();
    expect(resolveWithRuntime).not.toHaveBeenCalled();
    expect(h.state.watch).toMatchObject({ last_http_status: 403, consecutive_errors: 1, last_canonical_hash: null });
    expect(Math.abs(Date.parse(String(h.state.watch.next_poll_at)) - reset * 1000)).toBeLessThan(2000);
    expect((h.state.watch.coverage as Row[]).at(-1)!.status).toBe("gap");
    expect(alertKeys()).toEqual([[`watch_http_${WATCH_ID}`, 360]]);

    await runWatch(env(), cfg, WATCH_ID);
    await runWatch(env(), cfg, WATCH_ID);
    expect(h.state.watch.consecutive_errors).toBe(3);
    expect(alertKeys()).toEqual([[`watch_http_${WATCH_ID}`, 360], [`watch_errors_${WATCH_ID}`, 360]]);
    expect(h.state.evidence).toHaveLength(0);

    serve(200, JSON.stringify(pr(1)));
    const ok = await runWatch(env(), cfg, WATCH_ID);
    expect(ok.outcome).toBe("success");
    expect(h.state.watch).toMatchObject({ last_http_status: 200, consecutive_errors: 0, last_error: null });
  });

  it("R2 put failure: the evidence row names no object, the run is a failure, the operator is alerted", async () => {
    put = vi.fn(async () => { throw new Error("R2 503 internal error"); });
    serve(200, JSON.stringify(pr(1)));
    const r = await runWatch(env(), cfg, WATCH_ID);
    expect(r.outcome).toBe("failure");
    expect(r.detail).toMatch(/^r2 put failed \(evidence ev1 stored without raw_r2_key\)/);
    expect(h.state.evidence).toHaveLength(1);
    expect(h.state.evidence[0]!.raw_r2_key).toBeNull();
    expect(alertKeys()).toEqual([["r2_put_failed", 60]]);
    expect(h.state.watch.last_canonical_hash).toMatch(/^[0-9a-f]{64}$/); // observed and resolved; not re-stored next poll
  });

  it("an evidence insert failure leaves the hashes unchanged so the next poll retries", async () => {
    h.state.failEvidenceInsert = true;
    serve(200, JSON.stringify(pr(1)));
    const r = await runWatch(env(), cfg, WATCH_ID);
    expect(r.outcome).toBe("failure");
    expect(r.detail).toContain("evidence insert");
    expect(resolveWithRuntime).not.toHaveBeenCalled();
    expect(h.state.watch).toMatchObject({ last_canonical_hash: null, last_evidence_hash: null, consecutive_errors: 1 });
    h.state.failEvidenceInsert = false;
    const r2 = await runWatch(env(), cfg, WATCH_ID);
    expect(r2.outcome).toBe("success");
    expect(resolveWithRuntime).toHaveBeenCalledTimes(1);
  });
});

describe("a verdict that could not look is never consumed (Jev gated, over budget, breaker open, key missing)", () => {
  it("before the deadline: the change stays pending, the etag is not stored, and the next poll resolves it", async () => {
    h.state.verdict = COULD_NOT_LOOK;
    serveConditional(JSON.stringify(pr(1)), 'W/"e1"');
    const r1 = await runWatch(env(), cfg, WATCH_ID);
    expect(r1.outcome).toBe("failure");
    expect(r1.detail).toMatch(/^could not look: ERROR\/NONE\/MODEL_UNAVAILABLE; change [0-9a-f]{12} kept pending$/);
    expect(r1.rows_written).toBe(2); // the observation and the resolution row are kept
    expect(commitVerdict).not.toHaveBeenCalled(); // an outage is not a verdict on the public record
    expect(h.state.watch).toMatchObject({ last_canonical_hash: null, etag: null, consecutive_errors: 1, last_evidence_hash: h.state.evidence[0]!.raw_sha256 });

    h.state.verdict = h.LOOKED; // Jev is back; the page did not change
    const r2 = await runWatch(env(), cfg, WATCH_ID);
    expect(r2.outcome).toBe("success"); // not a 304 no_op: the unstored etag cannot hide the pending change
    expect(r2.detail).toMatch(/^first_observation /);
    expect(resolveWithRuntime).toHaveBeenCalledTimes(2);
    expect(commitVerdict).toHaveBeenCalledTimes(1);
    expect(h.state.watch).toMatchObject({ etag: 'W/"e1"', consecutive_errors: 0, last_error: null });
    expect(h.state.watch.last_canonical_hash).toMatch(/^[0-9a-f]{64}$/);

    const r3 = await runWatch(env(), cfg, WATCH_ID);
    expect(r3.outcome).toBe("no_op"); // consumed now: the conditional GET answers 304
    expect(resolveWithRuntime).toHaveBeenCalledTimes(2);
  });

  it("after the deadline: an outage at the post-deadline observation is retried, not counted as resolved", async () => {
    const lastHash = await sha256Hex(projectForChange("github_api", { kind: "github_pr_merged" }, { source_kind: "github_api", structured: pr(1), fetched_at: new Date().toISOString() }));
    resetWatch({ last_canonical_hash: lastHash, last_evidence_hash: "0".repeat(64) }, -2 * 86_400_000);
    h.state.verdict = COULD_NOT_LOOK;
    serve(200, JSON.stringify(pr(3)));
    const r1 = await runWatch(env(), cfg, WATCH_ID);
    expect(r1.outcome).toBe("failure");
    expect(h.state.resolutions).toHaveLength(1);
    expect(h.state.watch.last_canonical_hash).toBe(lastHash);

    h.state.verdict = h.LOOKED;
    serve(200, JSON.stringify(pr(4)));
    const r2 = await runWatch(env(), cfg, WATCH_ID);
    expect(r2.outcome).toBe("success");
    expect(r2.detail).toMatch(/^post_deadline_observation /);
    expect(resolveWithRuntime).toHaveBeenCalledTimes(2);

    serve(200, JSON.stringify(pr(5)));
    const r3 = await runWatch(env(), cfg, WATCH_ID);
    expect(r3.outcome).toBe("no_op");
    expect(resolveWithRuntime).toHaveBeenCalledTimes(2);
  });

  it("retries back off and the streak alerts at 3", async () => {
    h.state.verdict = COULD_NOT_LOOK;
    serve(200, JSON.stringify(pr(1)));
    for (let i = 0; i < 3; i++) await runWatch(env(), cfg, WATCH_ID);
    expect(h.state.watch.consecutive_errors).toBe(3);
    const wait = Date.parse(String(h.state.watch.next_poll_at)) - Date.now();
    expect(wait).toBeGreaterThan(1_190_000); // 300 s doubled twice
    expect(wait).toBeLessThanOrEqual(1_200_000);
    expect(alertKeys()).toEqual([[`watch_errors_${WATCH_ID}`, 360]]);
  });

  it("tenant market: the bill-then-run charge is refunded and no tenant event is queued", async () => {
    resetWatch({ markets: { ...market(7 * 86_400_000), tenant_id: "33333333-3333-4333-8333-333333333333" } });
    h.rpc.mockImplementation(async (_c: unknown, fn: string) => {
      if (fn === "begin_resolution") return [{ request_id: "stub1", ok: true, charged: 5 }];
      if (fn === "refund_credits") return 5;
      throw new Error(`rpc ${fn} not expected`);
    });
    h.state.verdict = COULD_NOT_LOOK;
    serve(200, JSON.stringify(pr(1)));
    const r = await runWatch(env(), cfg, WATCH_ID);
    expect(r.outcome).toBe("failure");
    expect(h.rpc.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["begin_resolution", expect.objectContaining({ p_amount: 5 })],
      ["refund_credits", { p_request_id: "stub1" }],
    ]);
    expect(h.state.resolutions.at(-1)).toMatchObject({ id: r.resolution_id, credits_refunded: 5 });
    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("tenant market: a verdict the runtime could not record (it threw after the charge) is refunded too", async () => {
    resetWatch({ markets: { ...market(7 * 86_400_000), tenant_id: "33333333-3333-4333-8333-333333333333" } });
    h.rpc.mockImplementation(async (_c: unknown, fn: string) => {
      if (fn === "begin_resolution") return [{ request_id: "stub2", ok: true, charged: 5 }];
      if (fn === "refund_credits") return 5;
      throw new Error(`rpc ${fn} not expected`);
    });
    vi.mocked(resolveWithRuntime).mockImplementationOnce(async (_env, _cfg, o) => {
      await o.beforeJev!();
      throw new Error("request r1: resolutions insert: canceling statement due to statement timeout");
    });
    serve(200, JSON.stringify(pr(1)));
    const r = await runWatch(env(), cfg, WATCH_ID);
    expect(r.outcome).toBe("failure");
    expect(r.detail).toContain("resolutions insert");
    expect(h.rpc.mock.calls.map((c) => c[1])).toEqual(["begin_resolution", "refund_credits"]);
    expect(h.state.watch.last_canonical_hash).toBeNull(); // the change stays pending: the next poll resolves it again
  });
});

describe("dispatch outcome (migration 013: dispatch_failures() counts pg_net answers >= 400)", () => {
  it("a run that recorded its outcome, failure included, is a delivered dispatch; one that could not record itself is not", async () => {
    serve(200, JSON.stringify(pr(1)));
    expect((await runWatch(env(), cfg, WATCH_ID)).recorded).toBe(true);
    serve(403, RATE_LIMIT_403);
    const failed = await runWatch(env(), cfg, WATCH_ID);
    expect([failed.outcome, failed.recorded]).toEqual(["failure", true]);
    h.state.failLoopRuns = true;
    serve(200, JSON.stringify(pr(2)));
    expect((await runWatch(env(), cfg, WATCH_ID)).recorded).toBe(false);
  });

  it("a failing watch whose streak cannot be saved is not a delivered dispatch either", async () => {
    h.state.failWatchUpdate = true;
    serve(403, RATE_LIMIT_403);
    const r = await runWatch(env(), cfg, WATCH_ID);
    expect([r.outcome, r.recorded]).toEqual(["failure", false]);
    expect(h.state.loopRuns).toHaveLength(1);
  });

  it("a watch that cannot be loaded alerts: there is no streak to carry it", async () => {
    h.state.watch = null as unknown as Row;
    const r = await runWatch(env(), cfg, WATCH_ID);
    expect([r.outcome, r.recorded]).toEqual(["failure", true]);
    expect(alertKeys()).toEqual([["watch_load_failed", 60]]);
  });
});

/**
 * runWatch end to end with the I/O edges replaced: an in-memory stand-in for the PostgREST calls runWatch makes,
 * a stubbed fetch for GitHub, and mocks for the resolver runtime, the commit bot and alerts. Proves the §16.2
 * defects are gone at the level that matters: rows written, R2 objects, resolutions, alerts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, Config } from "../src/env";

type Row = Record<string, unknown>;
type Filter = [op: "eq" | "gte", col: string, val: unknown];

const h = vi.hoisted(() => {
  const state = {
    watch: {} as Row, evidence: [] as Row[], resolutions: [] as Row[], loopRuns: [] as Row[],
    failEvidenceInsert: false, seq: 0,
  };
  const match = (r: Row, f: Filter[]) => f.every(([op, c, v]) => (op === "eq" ? r[c] === v : String(r[c]) >= String(v)));
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
    order() { return this; }
    limit() { return this; }
    single() { return Promise.resolve(this.exec()); }
    maybeSingle() { return Promise.resolve(this.exec()); }
    then<A, B>(ok?: ((v: { data: unknown; error: unknown; count?: number }) => A | PromiseLike<A>) | null, no?: ((e: unknown) => B | PromiseLike<B>) | null) { return Promise.resolve(this.exec()).then(ok, no); }
    exec(): { data: unknown; error: unknown; count?: number } {
      const t = this.table;
      if (t === "watches" && this.action === "select") return { data: structuredClone(state.watch), error: null };
      if (t === "watches" && this.action === "update") { Object.assign(state.watch, structuredClone(this.payload)); return { data: null, error: null }; }
      if (t === "loop_runs") { state.loopRuns.push(this.payload!); return { data: null, error: null }; }
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
      throw new Error(`fake client: unexpected ${this.action} on ${t}`);
    }
  }
  return { state, client: { from: (t: string) => new Q(t) } };
});

vi.mock("../src/db/supabase", () => ({ db: () => h.client, rpc: async () => { throw new Error("rpc not expected in shadow watch runs"); } }));
vi.mock("../src/resolve/runtime", () => ({
  JevUnavailableError: class extends Error {},
  resolveWithRuntime: vi.fn(async (_env: unknown, _cfg: unknown, o: { marketId: string; evidenceId: string | null }) => {
    const id = `res${h.state.resolutions.length + 1}`;
    h.state.resolutions.push({ id, market_id: o.marketId, evidence_id: o.evidenceId, status_row: "complete", created_at: new Date().toISOString() });
    return { resolutionId: id, jevCalls: 0, jevCostUsd: 0, result: { verdict: { resolution_status: "UNRESOLVED", winning_outcome: "NONE", error_reason: null }, pre: { windows: [], markers: [] } } };
  }),
}));
vi.mock("../src/bot/commit", () => ({ commitVerdict: vi.fn(async () => ({ committed: true, posted: false, reason: "recorded without channel" })) }));
vi.mock("../src/webhooks/deliver", () => ({ enqueueEvent: vi.fn() }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { runWatch } from "../src/ingest/watch";
import { resolveWithRuntime } from "../src/resolve/runtime";
import { alert } from "../src/ops/alerts";
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

let put: ReturnType<typeof vi.fn>;
const env = () => ({ RAW: { put } }) as unknown as Env;
const cfg = { botUa: "ResolveBot/test" } as Config;
const alertKeys = () => vi.mocked(alert).mock.calls.map((c) => [c[1], c[3]?.dedupMinutes]);

beforeEach(() => {
  Object.assign(h.state, { evidence: [], resolutions: [], loopRuns: [], failEvidenceInsert: false, seq: 0 });
  put = vi.fn(async () => ({}));
  vi.mocked(resolveWithRuntime).mockClear();
  vi.mocked(alert).mockClear();
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
    const lastHash = await sha256Hex(projectForChange("github_api", "github_pr_merged", { source_kind: "github_api", structured: pr(1), fetched_at: new Date().toISOString() }));
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

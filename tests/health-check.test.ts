/**
 * The post-deploy check of scripts/deploy.sh (scripts/lib/health.ts): only the Worker's own answer (it carries
 * X-Resolve-Version) can pass or fail a deploy. A network error or a block page is "could not look from here", a
 * warning; another version after every retry, a non-200 or another git_sha in the body fails. fetch is a fake.
 */
import { describe, expect, it } from "vitest";
import { checkDeployedSha, healthReport, type HealthDeps, type HealthOutcome } from "../scripts/lib/health";

const SHA = "a".repeat(40), OLD = "b".repeat(40);
const URL_ = "https://resolve.example.dev";
const worker = (version: string, gitSha: string, status = 200) =>
  new Response(JSON.stringify(status === 200 ? { ok: true, data: { service: "resolve", git_sha: gitSha } } : { ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "database unreachable" } }), { status, headers: { "x-resolve-version": version, "content-type": "application/json" } });

function deps(answers: Array<Response | Error>): HealthDeps & { calls: string[]; slept: number[]; lines: string[] } {
  const calls: string[] = [], slept: number[] = [], lines: string[] = [];
  return {
    calls, slept, lines,
    fetch: async (url) => { calls.push(url); const a = answers.shift(); if (!a) throw new Error("no more answers"); if (a instanceof Error) throw a; return a; },
    sleep: async (ms) => { slept.push(ms); },
    log: (l) => lines.push(l),
    attempts: 4, waitMs: 5000, timeoutMs: 15000,
  };
}

describe("checkDeployedSha", () => {
  it("ok when the Worker reports HEAD in the header and in /health's git_sha", async () => {
    const d = deps([worker(SHA, SHA)]);
    expect(await checkDeployedSha(`${URL_}/`, SHA, d)).toEqual({ kind: "ok" });
    expect(d.calls).toEqual([`${URL_}/health`]);
  });

  it("waits for the new version to reach the colo, then passes", async () => {
    const d = deps([worker(OLD, OLD), worker("dev", "dev"), worker(SHA, SHA)]);
    expect(await checkDeployedSha(URL_, SHA, d)).toEqual({ kind: "ok" });
    expect(d.slept).toEqual([5000, 5000]);
  });

  it("stale when the Worker still reports another version after every attempt", async () => {
    const d = deps([worker(OLD, OLD), worker(OLD, OLD), worker(OLD, OLD), worker(OLD, OLD)]);
    expect(await checkDeployedSha(URL_, SHA, d)).toEqual({ kind: "stale", version: OLD });
    expect(d.calls).toHaveLength(4);
    expect(d.slept).toHaveLength(3);
  });

  it("unhealthy when the version matches but /health is not 200 or its git_sha differs", async () => {
    expect(await checkDeployedSha(URL_, SHA, deps([worker(SHA, SHA, 503)]))).toMatchObject({ kind: "unhealthy", status: 503, gitSha: null });
    expect(await checkDeployedSha(URL_, SHA, deps([worker(SHA, OLD)]))).toMatchObject({ kind: "unhealthy", status: 200, gitSha: OLD });
    const html = new Response("<html>ok</html>", { status: 200, headers: { "x-resolve-version": SHA } });
    expect(await checkDeployedSha(URL_, SHA, deps([html]))).toMatchObject({ kind: "unhealthy", gitSha: null });
  });

  it("unreachable on a network error and not_worker on an answer without X-Resolve-Version: no retries, no verdict", async () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const d = deps([err]);
    expect(await checkDeployedSha(URL_, SHA, d)).toEqual({ kind: "unreachable", detail: "TypeError: fetch failed: ECONNRESET" });
    const block = new Response("<html>blocked</html>", { status: 200 });
    expect(await checkDeployedSha(URL_, SHA, deps([block]))).toEqual({ kind: "not_worker", status: 200 });
    const redirect = new Response(null, { status: 302, headers: { location: "http://block.example/" } });
    expect(await checkDeployedSha(URL_, SHA, deps([redirect]))).toEqual({ kind: "not_worker", status: 302 });
  });
});

describe("healthReport", () => {
  it("only the Worker's own wrong answer fails the deploy; could-not-look is a warning with the command to check by hand", () => {
    const cases: Array<[HealthOutcome, 0 | 1]> = [
      [{ kind: "ok" }, 0],
      [{ kind: "unreachable", detail: "x" }, 0],
      [{ kind: "not_worker", status: 200 }, 0],
      [{ kind: "stale", version: OLD }, 1],
      [{ kind: "unhealthy", status: 503, gitSha: null, body: "" }, 1],
    ];
    for (const [o, code] of cases) expect(healthReport(o, URL_, SHA).code, o.kind).toBe(code);
    expect(healthReport({ kind: "unreachable", detail: "x" }, URL_, SHA).lines.join("\n")).toContain(`curl -s ${URL_}/health (git_sha must be ${SHA})`);
  });
});

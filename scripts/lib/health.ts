/**
 * The post-deploy check of scripts/deploy.sh (tests/health-check.test.ts): GET <url>/health must report the commit just
 * deployed. X-Resolve-Version, which the Worker sets on every response (src/index.ts), tells the Worker's own answer
 * apart from a proxy or an ISP block page (the founder's ISP blocks *.workers.dev). No answer, or an answer without that
 * header, means this network could not look: a warning, since the deploy itself went through. The Worker answering with
 * another version after every retry, or /health answering non-200 or with another git_sha, is a failure.
 */
import { z } from "zod";

export type HealthOutcome =
  | { kind: "ok" }
  | { kind: "unreachable"; detail: string }
  | { kind: "not_worker"; status: number }
  | { kind: "stale"; version: string }
  | { kind: "unhealthy"; status: number; gitSha: string | null; body: string };

export interface HealthDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** A new version can take a few seconds to reach every colo. */
  attempts: number;
  waitMs: number;
  timeoutMs: number;
}

const HealthBody = z.object({ data: z.object({ git_sha: z.string() }) });

export async function checkDeployedSha(baseUrl: string, sha: string, deps: HealthDeps): Promise<HealthOutcome> {
  const url = `${baseUrl.replace(/\/+$/, "")}/health`;
  let version = "";
  for (let attempt = 1; attempt <= deps.attempts; attempt++) {
    let res: Response;
    try {
      // manual: a redirect is somebody else's answer (the Worker never redirects /health)
      res = await deps.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(deps.timeoutMs) });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      return { kind: "unreachable", detail: [String(e), cause?.code ?? cause?.message].filter(Boolean).join(": ").slice(0, 200) };
    }
    const text = await res.text().catch(() => "");
    version = res.headers.get("x-resolve-version") ?? "";
    if (!version) return { kind: "not_worker", status: res.status };
    if (version === sha) {
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* a non-JSON body is unhealthy below */ }
      const body = HealthBody.safeParse(json);
      const gitSha = body.success ? body.data.data.git_sha : null;
      return res.status === 200 && gitSha === sha ? { kind: "ok" } : { kind: "unhealthy", status: res.status, gitSha, body: text.slice(0, 300) };
    }
    deps.log(`attempt ${attempt}/${deps.attempts}: the Worker still reports ${version}`);
    if (attempt < deps.attempts) await deps.sleep(deps.waitMs);
  }
  return { kind: "stale", version };
}

/** Exit code and the lines to print. Only the Worker's own answer can fail a deploy; not reaching it is a warning. */
export function healthReport(o: HealthOutcome, baseUrl: string, sha: string): { code: 0 | 1; lines: string[] } {
  const byHand = `WARN: check by hand from another network: curl -s ${baseUrl}/health (git_sha must be ${sha})`;
  switch (o.kind) {
    case "ok": return { code: 0, lines: [`deployed: /health reports git_sha ${sha}`] };
    case "unreachable": return { code: 0, lines: [`WARN: ${baseUrl} is unreachable from this network (${o.detail}); the deploy went through.`, byHand] };
    case "not_worker": return { code: 0, lines: [`WARN: ${baseUrl}/health answered HTTP ${o.status} without X-Resolve-Version: not the Worker's answer (a proxy or a block page); the deploy went through.`, byHand] };
    case "stale": return { code: 1, lines: [`FAIL: deployed, but the Worker still reports version ${o.version}, not ${sha}`] };
    case "unhealthy": return { code: 1, lines: [`FAIL: deployed ${sha}, but /health answered HTTP ${o.status} with git_sha ${JSON.stringify(o.gitSha)}: ${o.body}`] };
  }
}

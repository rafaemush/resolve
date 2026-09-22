/** Jev HTTP client (I/O). Budget, breaker and spend accounting live in the API layer. */
import type { JevCaller } from "../resolve";
import { JevUnavailableError } from "../resolve";
import type { JevRequest } from "../resolve/jev";

export interface JevClientOptions {
  apiKey: string;
  timeoutMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Called after every attempt with timing and status, for jev_calls rows. */
  onAttempt?: (info: { status: number | null; latencyMs: number; inputTokens: number; outputTokens: number; error?: string }) => void;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

export function makeJevCaller(opts: JevClientOptions): JevCaller {
  const base = (opts.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  return async (req: JevRequest) => {
    if (!opts.apiKey || opts.apiKey.includes("NEUTRALIZED")) throw new JevUnavailableError("TYPESAFE_API_KEY not configured", "MODEL_UNAVAILABLE");
    const body = JSON.stringify(req);
    let lastErr: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now();
      let status: number | null = null;
      try {
        const res = await f(`${base}/v1/systemone`, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json", "User-Agent": "resolve-worker/0.1" },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        status = res.status;
        const latencyMs = Date.now() - t0;
        const text = await res.text();
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { /* handled below */ }
        const usage = (json as { usage?: { input_tokens?: number; output_tokens?: number } } | null)?.usage;
        opts.onAttempt?.({ status, latencyMs, inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0, ...(res.ok ? {} : { error: text.slice(0, 200) }) });
        if (res.ok && json !== null) return { json, latencyMs, status };
        lastErr = `HTTP ${status}: ${text.slice(0, 200)}`;
        if (!RETRYABLE.has(status)) throw new JevUnavailableError(lastErr, "MODEL_UNAVAILABLE", status);
      } catch (e) {
        if (e instanceof JevUnavailableError) throw e;
        lastErr = String(e);
        opts.onAttempt?.({ status, latencyMs: Date.now() - t0, inputTokens: 0, outputTokens: 0, error: lastErr.slice(0, 200) });
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 250)));
    }
    throw new JevUnavailableError(lastErr ?? "Jev unavailable", "MODEL_UNAVAILABLE");
  };
}

/** USD cost of a call; an unknown model bills at 100x list so it can never read as free. */
export function jevCostUsd(model: string, pinnedModel: string, inputTokens: number, usdPerMtok: number): number {
  const rate = model === pinnedModel || /^jev-\d+\.\d+\.\d+$/.test(model) ? usdPerMtok : usdPerMtok * 100;
  return (inputTokens / 1_000_000) * rate;
}

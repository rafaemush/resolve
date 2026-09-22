import { need } from "./env";

/** Supabase Management API SQL runner. Runs the text as one batch; returns rows of the last statement. */
export async function sql<T = Record<string, unknown>>(query: string, opts: { timeoutMs?: number } = {}): Promise<T[]> {
  const ref = need("SUPABASE_PROJECT_REF");
  const token = need("SUPABASE_ACCESS_TOKEN");
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`mgmt sql ${res.status}: ${text.slice(0, 2000)}`);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Dollar-quote a string for safe embedding in SQL. */
export function dq(value: string): string {
  const tag = "q" + Math.random().toString(36).slice(2, 8);
  if (value.includes(`$${tag}$`)) return dq(value);
  return `$${tag}$${value}$${tag}$`;
}

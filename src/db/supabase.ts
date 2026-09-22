import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";

export type Db = SupabaseClient;

/** Service-role client. One per request (Workers isolate globals across requests are fine, but keep it simple and stateless). */
export function db(env: Env): Db {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-client-info": "resolve-worker" } },
  });
}

/** Call a SECURITY DEFINER RPC and throw on any error (callers decide fail-open vs fail-closed). */
export async function rpc<T = unknown>(client: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`rpc ${fn}: ${error.code ?? ""} ${error.message}`);
  return data as T;
}

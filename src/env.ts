/**
 * Worker environment: bindings, plain vars (wrangler.toml [vars]) and secrets
 * (`wrangler secret put`). parseConfig() refuses to run without the values the
 * money and safety paths depend on, and parses every number once.
 */
export interface Env {
  RAW: R2Bucket;
  BACKUPS: R2Bucket;
  // vars
  JEV_MODEL: string;
  JEV_RPM_LIMIT: string;
  JEV_USD_PER_MTOK: string;
  JEV_TIMEOUT_MS: string;
  JEV_PAID_ROUTES_ENABLED: string;
  JEV_DAILY_USD_CEILING: string;
  THRESHOLDS_VERSION: string;
  SCHEMA_VERSION: string;
  CREDITS_PER_USDC: string;
  USDC_BASE_CONTRACT: string;
  BASE_FALLBACK_HTTP_URL: string;
  SOLANA_FALLBACK_HTTP_URL: string;
  RESOLVE_BOT_UA: string;
  // secrets
  TYPESAFE_API_KEY?: string;
  SPOTLIGHT_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  INTERNAL_HMAC_SECRET: string;
  ADMIN_API_KEY: string;
  EVAL_REPORT_KEY: string;
  GITHUB_TOKEN?: string;
  ALCHEMY_BASE_HTTP_URL?: string;
  HELIUS_API_KEY?: string;
  LIMITLESS_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHANNEL_ID?: string;
  TELEGRAM_OPERATOR_CHAT_ID?: string;
  USDC_RECEIVING_ADDRESS?: string;
  RESOLVE_PUBLIC_URL?: string;
  GIT_SHA?: string;
}

export interface Config {
  jevModel: string;
  jevRpmLimit: number;
  jevUsdPerMtok: number;
  jevTimeoutMs: number;
  jevPaidRoutesEnabled: boolean;
  jevDailyUsdCeiling: number;
  thresholdsVersion: string;
  schemaVersion: string;
  creditsPerUsdc: number;
  usdcContract: string;
  baseFallbackUrl: string;
  solanaFallbackUrl: string;
  botUa: string;
  publicUrl: string | null;
  gitSha: string;
}

export class ConfigError extends Error {
  constructor(public readonly missing: string[]) {
    super(`missing or invalid config: ${missing.join(", ")}`);
  }
}

const REQUIRED: (keyof Env)[] = [
  "JEV_MODEL",
  "JEV_RPM_LIMIT",
  "SPOTLIGHT_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "INTERNAL_HMAC_SECRET",
  "ADMIN_API_KEY",
  "EVAL_REPORT_KEY",
];

function num(v: string | undefined, fallback: number, missing: string[], name: string, opts: { min?: number } = {}): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || (opts.min !== undefined && n < opts.min)) {
    missing.push(name);
    return fallback;
  }
  return n;
}

export function parseConfig(env: Env): Config {
  const missing: string[] = [];
  for (const k of REQUIRED) if (!env[k] || String(env[k]).trim() === "") missing.push(k);
  // A model id must be a pinned version in production; jev-latest silently moves thresholds.
  if (env.JEV_MODEL && !/^jev-\d+\.\d+\.\d+$/.test(env.JEV_MODEL)) missing.push("JEV_MODEL (pin a version like jev-1.13.0)");
  const cfg: Config = {
    jevModel: env.JEV_MODEL,
    jevRpmLimit: num(env.JEV_RPM_LIMIT, 0, missing, "JEV_RPM_LIMIT", { min: 1 }),
    jevUsdPerMtok: num(env.JEV_USD_PER_MTOK, 0.042, missing, "JEV_USD_PER_MTOK", { min: 0 }),
    jevTimeoutMs: num(env.JEV_TIMEOUT_MS, 2500, missing, "JEV_TIMEOUT_MS", { min: 100 }),
    jevPaidRoutesEnabled: env.JEV_PAID_ROUTES_ENABLED === "1",
    jevDailyUsdCeiling: num(env.JEV_DAILY_USD_CEILING, 1.0, missing, "JEV_DAILY_USD_CEILING", { min: 0 }),
    thresholdsVersion: env.THRESHOLDS_VERSION || "v1",
    schemaVersion: env.SCHEMA_VERSION || "1",
    creditsPerUsdc: num(env.CREDITS_PER_USDC, 100, missing, "CREDITS_PER_USDC", { min: 1 }),
    usdcContract: (env.USDC_BASE_CONTRACT || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").toLowerCase(),
    baseFallbackUrl: env.BASE_FALLBACK_HTTP_URL || "https://mainnet.base.org",
    solanaFallbackUrl: env.SOLANA_FALLBACK_HTTP_URL || "https://api.mainnet-beta.solana.com",
    botUa: env.RESOLVE_BOT_UA || "ResolveBot/1.0",
    publicUrl: env.RESOLVE_PUBLIC_URL ? env.RESOLVE_PUBLIC_URL.replace(/\/+$/, "") : null,
    gitSha: env.GIT_SHA || "dev",
  };
  if (missing.length) throw new ConfigError(missing);
  return cfg;
}

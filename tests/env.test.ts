import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError, type Env } from "../src/env";

const base = {
  JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "1200", JEV_USD_PER_MTOK: "0.042", JEV_TIMEOUT_MS: "2500",
  JEV_PAID_ROUTES_ENABLED: "0", JEV_DAILY_USD_CEILING: "1.00", THRESHOLDS_VERSION: "v1", SCHEMA_VERSION: "1",
  CREDITS_PER_USDC: "100", USDC_BASE_CONTRACT: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  BASE_FALLBACK_HTTP_URL: "https://mainnet.base.org", SOLANA_FALLBACK_HTTP_URL: "https://api.mainnet-beta.solana.com",
  RESOLVE_BOT_UA: "ResolveBot/1.0", SPOTLIGHT_SECRET: "s", SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "k", INTERNAL_HMAC_SECRET: "h", ADMIN_API_KEY: "a", EVAL_REPORT_KEY: "e",
} as unknown as Env;

describe("parseConfig", () => {
  it("parses a complete env", () => {
    const cfg = parseConfig(base);
    expect(cfg.jevRpmLimit).toBe(1200);
    expect(cfg.jevPaidRoutesEnabled).toBe(false);
    expect(cfg.usdcContract).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  });
  it("refuses to boot without the safety/money secrets", () => {
    const { SPOTLIGHT_SECRET: _s, INTERNAL_HMAC_SECRET: _h, ...rest } = base as unknown as Record<string, string>;
    expect(() => parseConfig(rest as unknown as Env)).toThrow(ConfigError);
    try { parseConfig(rest as unknown as Env); } catch (e) { expect((e as ConfigError).missing).toEqual(expect.arrayContaining(["SPOTLIGHT_SECRET", "INTERNAL_HMAC_SECRET"])); }
  });
  it("rejects an unpinned model id (jev-latest moves thresholds)", () => {
    expect(() => parseConfig({ ...base, JEV_MODEL: "jev-latest" })).toThrow(/pin a version/);
  });
  it("rejects a non-numeric rpm limit instead of defaulting it", () => {
    expect(() => parseConfig({ ...base, JEV_RPM_LIMIT: "lots" })).toThrow(ConfigError);
  });
});

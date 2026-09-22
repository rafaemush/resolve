// Test harness safety (port of OilFlow tests/conftest.py):
// credentials are overwritten with syntactically valid dead placeholders so a
// unit test can never spend money or touch production, and outbound fetches to
// the model/API hosts throw unless EVAL_LIVE=1 is set explicitly.
const LIVE = process.env.EVAL_LIVE === "1";

if (!LIVE) {
  process.env.TYPESAFE_API_KEY = "apikey_TEST_NEUTRALIZED_0000000000000000";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "neutralized";
  process.env.SUPABASE_URL = "https://neutralized.invalid";
  process.env.GITHUB_TOKEN = "neutralized";
  process.env.TELEGRAM_BOT_TOKEN = "neutralized";
}
process.env.JEV_MODEL ??= "jev-1.13.0";
process.env.THRESHOLDS_VERSION ??= "v1";
process.env.SPOTLIGHT_SECRET = LIVE ? (process.env.SPOTLIGHT_SECRET ?? "eval-spotlight-v1") : "eval-spotlight-v1";

const BLOCKED_HOSTS = ["api.typesafe.ai", "supabase.co", "api.telegram.org", "api.github.com", "alchemy.com", "helius-rpc.com"];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!LIVE && BLOCKED_HOSTS.some((h) => url.includes(h))) {
    throw new Error(`tests/setup.ts: outbound fetch to ${url} blocked (set EVAL_LIVE=1 to allow)`);
  }
  return realFetch(input, init);
}) as typeof fetch;

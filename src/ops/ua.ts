/**
 * ResolveBot's one user agent (plan §8 politeness, §17.3 P6 "/bot"). Every request Resolve makes to a source, a
 * platform API or an RPC endpoint sends it, so a site operator who sees it can read GET /bot and opt out with a robots.txt
 * group for the product token. The Worker's value is wrangler.toml RESOLVE_BOT_UA (parseConfig().botUa); code that has
 * no Env (scripts, registration-time RPC checks) sends RESOLVE_BOT_UA itself, the same string.
 */
import type { Env } from "../env";

/** The robots.txt product token ResolveBot obeys (src/ingest/robots.ts matches the part of the UA before "/"). */
export const BOT_TOKEN = "ResolveBot";
/** Where the bot page is served (GET /bot, src/api/bot.ts). */
export const BOT_PAGE_URL = "https://resolve.rafaemush.workers.dev/bot";
export const RESOLVE_BOT_UA = `${BOT_TOKEN}/1.0 (+${BOT_PAGE_URL})`;

/** The configured UA (wrangler.toml RESOLVE_BOT_UA), else RESOLVE_BOT_UA; never empty. */
export function botUa(env?: Partial<Pick<Env, "RESOLVE_BOT_UA">> | null): string {
  const v = env?.RESOLVE_BOT_UA?.trim();
  return v ? v : RESOLVE_BOT_UA;
}

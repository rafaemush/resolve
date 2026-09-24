/**
 * robots.txt at registration (plan §8: disallowed => the market registers as unsupported_source), read per RFC 9309:
 *   2xx  the rules decide (our UA's group, else "*"; the longest matching rule wins, Allow on a tie)
 *   3xx  followed, at most ROBOTS_MAX_REDIRECTS hops, every hop through the web URL policy (a redirect to a private
 *        address is not followed: disallow); more hops = unavailable = allow (2.3.1.2)
 *   4xx  unavailable = allow (2.3.1.3), except 429: a rate limit is the server declining to answer now, not the
 *        file's absence, so it reads as unreachable (Google's crawlers read 429 the same way)
 *   5xx, 429, timeout, network error  unreachable = complete disallow (2.3.1.4), flagged `unreachable`: the page is
 *        not fetched, and the registration is refused as "could not verify" (503, nothing stored, retry), never stored
 *        as unsupported_source. RFC 9309 makes this state temporary; an unsupported_source market would be answered
 *        as-is to every retry of the same external_id, turning one outage into a permanent verdict. "Found nothing" is
 *        not "could not look".
 * Rail registration_policy off = the pre-P1a reading (redirects followed blindly; any failure allowed).
 */
import { railEnabled } from "../resolve/rails";
import { webUrlProblem } from "../markets/policy";
import { discardBody } from "./http";

/** robots.txt rule -> anchored regex: '*' matches any run of characters, a trailing '$' anchors the end. */
export function ruleToRegex(rule: string): RegExp {
  const endAnchored = rule.endsWith("$");
  const raw = endAnchored ? rule.slice(0, -1) : rule;
  const escaped = raw.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + escaped + (endAnchored ? "$" : ""));
}

/** unreachable: the file could not be read (5xx, 429, timeout, network error); allowed is then false. */
export interface RobotsResult { allowed: boolean; reason: string; unreachable?: true }

export const ROBOTS_MAX_REDIRECTS = 5;
export const ROBOTS_TIMEOUT_MS = 5000;
/** Worst-case subrequests of one robotsAllows(): the robots.txt request plus every redirect hop (each hop is a fetch). */
export const ROBOTS_SUBREQUESTS = 1 + ROBOTS_MAX_REDIRECTS;
const BODY_MAX = 200_000;

/** Pure: the verdict of a robots.txt body for `url` and our UA's product token (the part before "/"). */
export function robotsVerdict(body: string, url: URL, botUa: string): RobotsResult {
  const botName = botUa.split("/")[0]!.toLowerCase();
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[] }> = [];
  let cur: { agents: string[]; disallow: string[]; allow: string[] } | null = null;
  for (const raw of body.slice(0, BODY_MAX).split("\n")) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const v = rest.join(":").trim();
    const key = (k ?? "").trim().toLowerCase();
    if (key === "user-agent") { if (!cur || cur.disallow.length || cur.allow.length) { cur = { agents: [], disallow: [], allow: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); }
    else if (cur && key === "disallow") cur.disallow.push(v);
    else if (cur && key === "allow") cur.allow.push(v);
  }
  const g = groups.find((x) => x.agents.some((a) => a === botName)) ?? groups.find((x) => x.agents.includes("*"));
  if (!g) return { allowed: true, reason: "no matching group" };
  const path = url.pathname + url.search;
  const matches = (rule: string) => rule !== "" && ruleToRegex(rule).test(path);
  const dis = g.disallow.filter(matches).sort((a, b) => b.length - a.length)[0];
  const al = g.allow.filter(matches).sort((a, b) => b.length - a.length)[0];
  if (dis && (!al || al.length < dis.length)) return { allowed: false, reason: `robots.txt disallows ${dis} for ${g.agents.join(",")}` };
  return { allowed: true, reason: "allowed" };
}

const get = (target: string, botUa: string, redirect: "manual" | "follow") =>
  fetch(target, { headers: { "User-Agent": botUa }, redirect, signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS), cf: { cacheTtl: 86400, cacheEverything: true } } as RequestInit);

/** Whether our UA may fetch `url`. At most ROBOTS_SUBREQUESTS requests. */
export async function robotsAllows(url: string, botUa: string): Promise<RobotsResult> {
  let u: URL;
  try { u = new URL(url); } catch { return { allowed: false, reason: "invalid url" }; }
  if (!railEnabled("registration_policy")) return legacyRobots(u, botUa);
  let target = `${u.origin}/robots.txt`;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try { res = await get(target, botUa, "manual"); }
    catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      return { allowed: false, unreachable: true, reason: `robots.txt ${timeout ? `timed out after ${ROBOTS_TIMEOUT_MS} ms` : `unreachable (${String(e).slice(0, 80)})`}: complete disallow (RFC 9309 2.3.1.4)` };
    }
    const s = res.status;
    if (s >= 300 && s < 400) {
      const loc = res.headers.get("location");
      await discardBody(res);
      if (hop >= ROBOTS_MAX_REDIRECTS) return { allowed: true, reason: `robots.txt redirected more than ${ROBOTS_MAX_REDIRECTS} times: unavailable, allowed (RFC 9309 2.3.1.2)` };
      let next: string;
      try { next = new URL(loc ?? "", target).href; } catch { next = ""; }
      if (!loc || !next) return { allowed: false, reason: `robots.txt ${s} without a usable Location: complete disallow` };
      const bad = webUrlProblem(next);
      if (bad) return { allowed: false, reason: `robots.txt redirects to ${next}, which is not fetched (${bad}): complete disallow` };
      target = next;
      continue;
    }
    if (s >= 200 && s < 300) return robotsVerdict(await res.text(), u, botUa);
    await discardBody(res);
    if (s === 429 || s >= 500) return { allowed: false, unreachable: true, reason: `robots.txt answered ${s}: unreachable, complete disallow (RFC 9309 2.3.1.4)` };
    if (s >= 400) return { allowed: true, reason: `robots.txt ${s}: unavailable, allowed (RFC 9309 2.3.1.3)` };
    return { allowed: false, reason: `robots.txt answered ${s}: complete disallow` };
  }
}

/** The pre-P1a reading, kept only for the mutation harness (rail registration_policy off). */
async function legacyRobots(u: URL, botUa: string): Promise<RobotsResult> {
  let body = "";
  try {
    const res = await get(`${u.origin}/robots.txt`, botUa, "follow");
    if (res.status === 404) return { allowed: true, reason: "no robots.txt" };
    if (!res.ok) return { allowed: true, reason: `robots.txt ${res.status} (treated as allow)` };
    body = await res.text();
  } catch { return { allowed: true, reason: "robots.txt unreachable (treated as allow)" }; }
  return robotsVerdict(body, u, botUa);
}

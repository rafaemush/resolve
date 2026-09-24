/**
 * Change detection for watches. A poll stores evidence and re-resolves only when the PROJECTION of what it
 * fetched changed: the fields a verdict can depend on, serialized deterministically. Raw bytes are the wrong
 * key (§16.2): a GitHub PR embeds head.repo/base.repo with live counters (stargazers_count, forks_count,
 * open_issues_count, pushed_at), so 42/42 fetches of an unchanged PR had distinct hashes; a web page's HTML
 * changed on 7/7 polls while its text did not. The projection is used for change detection only; evidence
 * rows keep raw_sha256 / canonical_sha256 exactly as before (commitments and reveals hash those).
 */
import type { EvidenceInput } from "../resolve/schema";
import { canonicalize } from "../resolve/text";
import { railEnabled } from "../resolve/rails";
import { getPath, parseNumber } from "../resolve/structured";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON with object keys sorted at every depth; array order is kept (it is meaningful for logs and events). */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  if (isObj(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Keys that move without the resource changing: counters, URLs, activity timestamps, sizes. */
const VOLATILE_KEY = /(_count|_url|^url$|pushed_at|updated_at|stargazers|watchers|forks|open_issues|subscribers|network_count|^size$)/;

export function stripVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const k of Object.keys(v).sort()) if (!VOLATILE_KEY.test(k)) out[k] = stripVolatile(v[k]);
  return out;
}

const pick = (o: Obj, k: string): unknown => (o[k] === undefined ? null : o[k]);

/**
 * A pull request's deciding fields. base_repo (the full_name string, never the repo object) is the subject the
 * structured resolver checks; a rename moves it only through a redirect, which the adapter already refuses.
 */
function projectPr(o: Obj): Obj {
  const base = isObj(o.base) ? o.base : {};
  const baseRepo = isObj(base.repo) ? base.repo : {};
  return {
    number: pick(o, "number"), state: pick(o, "state"), merged: pick(o, "merged"), merged_at: pick(o, "merged_at"),
    closed_at: pick(o, "closed_at"), draft: pick(o, "draft"), title: pick(o, "title"), base_ref: pick(base, "ref"),
    base_repo: pick(baseRepo, "full_name"), merge_commit_sha: pick(o, "merge_commit_sha"),
  };
}

function projectIssue(o: Obj): Obj {
  const labels = (Array.isArray(o.labels) ? o.labels : []).map((l) => (isObj(l) ? String(l.name ?? "") : String(l))).sort();
  return { number: pick(o, "number"), state: pick(o, "state"), state_reason: pick(o, "state_reason"), closed_at: pick(o, "closed_at"), title: pick(o, "title"), labels };
}

function projectRelease(o: Obj): Obj {
  return { id: pick(o, "id"), tag_name: pick(o, "tag_name"), name: pick(o, "name"), draft: pick(o, "draft"), prerelease: pick(o, "prerelease"), published_at: pick(o, "published_at") };
}

const looksLikePr = (o: Obj) => "merged_at" in o && isObj(o.head) && isObj(o.base);
const looksLikeRelease = (o: unknown): o is Obj => isObj(o) && typeof o.tag_name === "string";
const looksLikeIssue = (o: Obj, resolverKind: string | undefined) =>
  "number" in o && "state" in o && (resolverKind === "github_issue_closed" || Array.isArray(o.labels) || "state_reason" in o);

export type GithubShape = "pr" | "issue" | "release" | "release_list" | "other";

/** Which projection applies. By shape, so a PR fetched for a Jev-routed market (no resolver) is still projected. */
export function githubShape(resolverKind: string | undefined, json: unknown): GithubShape {
  if (Array.isArray(json)) return json.length > 0 && json.every(looksLikeRelease) ? "release_list" : "other";
  if (!isObj(json)) return "other";
  if (looksLikePr(json)) return "pr";
  if (looksLikeRelease(json)) return "release";
  if (looksLikeIssue(json, resolverKind)) return "issue";
  return "other";
}

function projectGithub(resolverKind: string | undefined, json: unknown): string {
  const shape = githubShape(resolverKind, json);
  switch (shape) {
    case "pr": return stableStringify({ shape, value: projectPr(json as Obj) });
    case "issue": return stableStringify({ shape, value: projectIssue(json as Obj) });
    case "release": return stableStringify({ shape, value: projectRelease(json as Obj) });
    case "release_list": {
      const list = (json as Obj[]).map(projectRelease).sort((a, b) => Number(a.id) - Number(b.id) || String(a.tag_name).localeCompare(String(b.tag_name)));
      return stableStringify({ shape, value: list });
    }
    case "other": return stableStringify({ shape, value: stripVolatile(json) });
    default: { const never: never = shape; throw new Error(`unhandled github shape ${String(never)}`); }
  }
}

/** Unprojected text: what the resolver itself reads. Used as the fallback and when the rail is off. */
function rawText(ev: EvidenceInput): string {
  return ev.text ?? (ev.structured !== undefined ? JSON.stringify(ev.structured) : "");
}

/** What change detection needs from a market's resolver: its kind, and the path a numeric_threshold reads. */
export interface ChangeResolver { kind: string; path?: string }

/**
 * Chain sources: the matches carried from earlier windows (src/ingest/matches.ts) followed by this window's ordered
 * logs / signatures. to_block, safe_block, backlog and the other cursor fields move on every poll; a match moving
 * from the window into earlier_matches is not a change.
 */
function projectChain(s: unknown, key: "logs" | "signatures"): string | null {
  if (!isObj(s) || !Array.isArray(s[key])) return null;
  const earlier = Array.isArray(s.earlier_matches) ? s.earlier_matches : [];
  return stableStringify([...earlier, ...(s[key] as unknown[])]);
}

/**
 * official_release: series|period|first-print value|corroboration status. The stored first print never changes
 * (migration 016), so every poll after the first is a no_op; only an audited corroboration re-check
 * (recheck_official_corroboration) changes the status, and that re-resolves the legs held at sources_disagree.
 * "release_not_observed" is its own value, so the 6 h marker is stored once and the first print that follows it is a
 * change.
 */
function projectOfficial(s: unknown): string | null {
  if (!isObj(s) || typeof s.series !== "string" || typeof s.period !== "string") return null;
  if (s.kind === "official_missing") return `official|${s.series}|${s.period}|release_not_observed`;
  if (s.kind !== "official_observation" || typeof s.value_text !== "string") return null;
  const status = isObj(s.corroboration) && typeof s.corroboration.status === "string" ? s.corroboration.status : "none";
  return `official|${s.series}|${s.period}|${s.value_text}|${status}`;
}

function projectSource(sourceKind: string, resolverKind: string | undefined, ev: EvidenceInput): string {
  const s = ev.structured;
  switch (sourceKind) {
    case "github_api":
    case "github_events":
      return s !== undefined && s !== null ? projectGithub(resolverKind, s) : canonicalize(rawText(ev)).text;
    case "web_fetch":
    case "web_render":
      return canonicalize(rawText(ev)).text;
    case "base_log":
      return projectChain(s, "logs") ?? canonicalize(rawText(ev)).text;
    case "solana_log":
      return projectChain(s, "signatures") ?? canonicalize(rawText(ev)).text;
    case "official_release":
      return projectOfficial(s) ?? canonicalize(rawText(ev)).text;
    default:
      return canonicalize(rawText(ev)).text;
  }
}

/**
 * The deterministic string whose sha256 decides whether a poll is a change. Anything unrecognised falls back to
 * canonical text.
 * numeric_threshold reads one number by path from the structured payload, else the numbers near the anchors in the
 * full text (src/resolve/structured.ts). The source projections drop exactly such values (a repo's
 * stargazers_count is a volatile key; a PR projection keeps no counters), so a threshold crossing would never be a
 * change: the value read at the path joins the projection, and without one the projection is the canonical text
 * the fallback reads.
 */
export function projectForChange(sourceKind: string, resolver: ChangeResolver | undefined, ev: EvidenceInput): string {
  if (!railEnabled("stable_projection")) return rawText(ev);
  const projected = projectSource(sourceKind, resolver?.kind, ev);
  if (resolver?.kind !== "numeric_threshold") return projected;
  const s = ev.structured;
  const value = resolver.path && s !== undefined && s !== null ? parseNumber(getPath(s, resolver.path)) : undefined;
  return value === undefined ? canonicalize(rawText(ev)).text : stableStringify({ projected, numeric: { path: resolver.path, value } });
}

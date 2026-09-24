/**
 * Registration policy for the sources a watch will fetch (plan §16.4 P1 step 4, §19.3). Pure: tests and
 * scripts/seed-shadow.ts --check call it directly, and registerMarket runs it before any upstream request, so a refused
 * source is never fetched, not even its robots.txt.
 *   * per kind, a ref names exactly one resource a resolver reads (the grammar in src/resolve/schema.ts);
 *   * a chain or GitHub resolver and the market's sources name the same subject: a resolver pointed at another repo, PR,
 *     contract or account turns every poll into a SOURCE_MISMATCH verdict on the public record;
 *   * a web source is a public https URL (the Worker must never be pointed at link-local, loopback or private
 *     addresses). Only literals can be checked: a Worker has no resolver API, so a public name that resolves to a
 *     private address is not caught here (Cloudflare's network does not route to the tenant's private networks). The
 *     same check runs outside the rail on every web poll and every redirect hop (src/ingest/web.ts, src/ingest/robots.ts).
 * Rail registration_policy off = registration runs none of this (the pre-P1a behaviour), for the mutation harness only.
 */
import { railEnabled } from "../resolve/rails";
import { GITHUB_API_REF, GITHUB_EVENTS_REF, BASE_LOG_REF, SOLANA_LOG_REF, type MarketRegistration, type Resolver } from "../resolve/schema";

/** Why a registration was not stored. The API layer maps each kind to one status (src/api/registration.ts). */
export type RegistrationRefusal =
  /** The registration itself is wrong (policy, grammar, a program id, too many checks): 400, nothing stored. */
  | { kind: "invalid"; message: string }
  /** A check could not be made (an RPC failed or timed out): 503, nothing stored, the same request may be retried. */
  | { kind: "unverified"; message: string }
  /** The tenant's active watches plus this market's would exceed tenants.watch_limit (register_market, migration 019). */
  | { kind: "watch_limit"; limit: number; active: number; requested: number }
  /** Active base_log watches plus this market's would exceed app_config max_base_watches (register_market). */
  | { kind: "base_watch_cap"; cap: number; active: number; requested: number };

export class RegistrationError extends Error {
  constructor(readonly refusal: RegistrationRefusal) {
    super(refusalMessage(refusal));
    this.name = "RegistrationError";
  }
}

export function refusalMessage(r: RegistrationRefusal): string {
  switch (r.kind) {
    case "invalid": case "unverified": return r.message;
    case "watch_limit": return `watch limit (${r.limit}) reached for this plan: ${r.active} active watch${r.active === 1 ? "" : "es"}, this market adds ${r.requested}`;
    case "base_watch_cap": return `the service's Base watch capacity (${r.cap} active base_log watches) is reached: ${r.active} active, this market adds ${r.requested}. Register it later or without its base_log source.`;
    default: { const never: never = r; throw new Error(`unhandled refusal ${String(never)}`); }
  }
}

// ---- web URLs ---------------------------------------------------------------------------------------------------

/** IPv4 CIDRs a web source may not name: this network, private, CGNAT, loopback, link-local, benchmarking, multicast, reserved. */
const IPV4_BLOCKED: ReadonlyArray<readonly [string, number, string]> = [
  ["0.0.0.0", 8, "this network"], ["10.0.0.0", 8, "private"], ["100.64.0.0", 10, "carrier-grade NAT"], ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"], ["172.16.0.0", 12, "private"], ["192.168.0.0", 16, "private"], ["198.18.0.0", 15, "benchmarking"],
  ["224.0.0.0", 4, "multicast"], ["240.0.0.0", 4, "reserved"],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

/** Why a dotted IPv4 literal is not a public address, or null. */
export function ipv4Problem(ip: string): string | null {
  const n = ipv4ToInt(ip);
  if (n === null) return `${ip} is not an IPv4 address`;
  for (const [base, bits, what] of IPV4_BLOCKED) {
    const size = 2 ** (32 - bits);
    const start = ipv4ToInt(base)!;
    if (n >= start && n < start + size) return `${ip} is a ${what} address (${base}/${bits})`;
  }
  return null;
}

/** An IPv6 literal (without brackets) as eight 16-bit groups; an embedded dotted IPv4 tail is accepted. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[2]!);
    if (v4 === null) return null;
    s = `${dotted[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const read = (h: string) => (h === "" ? [] : h.split(":"));
  const head = read(halves[0]!), tail = halves.length === 2 ? read(halves[1]!) : [];
  if ([...head, ...tail].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((g) => parseInt(g, 16));
}

/** Why an IPv6 literal (without brackets) is not a public address, or null. */
export function ipv6Problem(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (!g) return `${ip} is not an IPv6 address`;
  const zeroUpTo = (k: number) => g.slice(0, k).every((x) => x === 0);
  if (g.every((x) => x === 0)) return `${ip} is the unspecified address (::)`;
  if (zeroUpTo(7) && g[7] === 1) return `${ip} is the loopback address (::1)`;
  if ((g[0]! & 0xfe00) === 0xfc00) return `${ip} is a unique-local address (fc00::/7)`;
  if ((g[0]! & 0xffc0) === 0xfe80) return `${ip} is a link-local address (fe80::/10)`;
  if ((g[0]! & 0xff00) === 0xff00) return `${ip} is a multicast address (ff00::/8)`;
  // ::ffff:a.b.c.d (IPv4-mapped) and the deprecated ::a.b.c.d (IPv4-compatible) reach the IPv4 address they carry.
  if (zeroUpTo(5) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
    const p = ipv4Problem(v4);
    if (p) return `${ip} maps to ${p}`;
  }
  return null;
}

const NON_PUBLIC_SUFFIXES = [".local", ".internal", ".localhost"];

/**
 * Why a URL may not be fetched as a tenant-supplied web source, or null. https only (the scheme a registered page is
 * compared on), no userinfo (credentials would be sent upstream and stored in markets.sources), the default port only,
 * and a host that is a public name or a public address literal. Hosts are read after WHATWG URL parsing, which turns
 * "0x7f.1" and "2130706433" into 127.0.0.1 and ::ffff:127.0.0.1 into ::ffff:7f00:1, so no spelling slips past.
 * allowHttp: http is accepted too; only for polling a web watch stored before migration 019 as http (src/ingest/web.ts),
 * never for a registration.
 */
export function webUrlProblem(raw: string, opts: { allowHttp?: boolean } = {}): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return `${raw} is not an absolute URL`; }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) return `${raw} is not https`;
  if (u.username || u.password) return `${u.host}: credentials in the URL`;
  if (u.port !== "") return `${u.host}: port ${u.port} is not the https default`;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) { const p = ipv6Problem(host.slice(1, -1)); return p ? `${raw}: ${p}` : null; }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) { const p = ipv4Problem(host); return p ? `${raw}: ${p}` : null; }
  if (host === "localhost" || NON_PUBLIC_SUFFIXES.some((s) => host.endsWith(s))) return `${raw}: ${host} is not a public host`;
  if (!host.includes(".")) return `${raw}: single-label host ${host} is not a public host`;
  return null;
}

// ---- source refs and the resolver --------------------------------------------------------------------------------

export type GithubResource = "pulls" | "issues" | "releases" | "release_tag" | "events" | "repo";
export interface GithubRef { repo: string; resource: GithubResource; number?: number; tag?: string }

/** A github_api / github_events ref by the grammar of src/resolve/schema.ts, or null. A leading "/" is accepted (it is stripped on insert). */
export function parseGithubRef(kind: "github_api" | "github_events", rawRef: string): GithubRef | null {
  const ref = rawRef.replace(/^\/+/, "");
  if (kind === "github_events") {
    const m = GITHUB_EVENTS_REF.exec(ref);
    return m ? { repo: `${m[1]}/${m[2]}`, resource: "events" } : null;
  }
  const m = GITHUB_API_REF.exec(ref);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  if (m[3]) return { repo, resource: m[3] as "pulls" | "issues", number: Number(m[4]) };
  if (m[5]) return m[6] ? { repo, resource: "release_tag", tag: m[6] } : { repo, resource: "releases" };
  return { repo, resource: "repo" };
}

const GITHUB_API_FORMS = "repos/{owner}/{repo}/pulls/{n}, repos/{owner}/{repo}/issues/{n}, repos/{owner}/{repo}/releases or repos/{owner}/{repo}/releases/tags/{tag}";

/** Why one source's ref breaks its kind's grammar, or null. official_release refs are validated by the official rail. */
export function sourceRefProblem(s: { kind: string; ref: string }, resolver: Resolver | undefined): string | null {
  switch (s.kind) {
    case "github_api": {
      const g = parseGithubRef("github_api", s.ref);
      if (!g) return `github_api ref ${s.ref} is not one of ${GITHUB_API_FORMS}`;
      // The repository document carries only counters: useful to a numeric_threshold (stars, forks; projected by path,
      // evals ING-108), to nothing else. A deliberate addition to plan §16.4 P1 step 4's list of GitHub resources: a
      // read-only document of the same repository, fetched with the same token.
      if (g.resource === "repo" && resolver?.kind !== "numeric_threshold") return `github_api ref ${s.ref} names a repository, which only a numeric_threshold resolver reads; use one of ${GITHUB_API_FORMS}`;
      return null;
    }
    case "github_events": return parseGithubRef("github_events", s.ref) ? null : `github_events ref ${s.ref} is not repos/{owner}/{repo}/events`;
    case "base_log": return BASE_LOG_REF.test(s.ref) ? null : `base_log ref ${s.ref} is not base:0x followed by 40 hex characters`;
    case "solana_log": return SOLANA_LOG_REF.test(s.ref) ? null : `solana_log ref ${s.ref} is not solana: followed by a base58 account of 32-44 characters`;
    case "web_fetch": case "web_render": return webUrlProblem(s.ref);
    case "official_release": return null;
    default: return `unknown source kind ${s.kind}`;
  }
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Why the resolver and the sources name different subjects. A chain or GitHub resolver needs at least one source of
 * its kind, and every such source must name its subject: the repository (case-insensitive, as GitHub treats it), and
 * the resource the resolver reads (merged_at is only on pulls/{pr}; a closed issue on issues/{issue}; a release on the
 * release list or on its own tag); the contract address (case-insensitive hex); the Solana account (base58 is
 * case-sensitive). Sources whose ref breaks its grammar are reported by sourceRefProblem instead.
 */
export function resolverSourceProblems(reg: Pick<MarketRegistration, "sources" | "resolver">): string[] {
  const r = reg.resolver;
  if (!r) return [];
  const out: string[] = [];
  switch (r.kind) {
    case "github_pr_merged": case "github_issue_closed": case "github_release_published": {
      const gh = reg.sources.filter((s) => s.kind === "github_api" || s.kind === "github_events");
      if (!gh.length) return [`resolver ${r.kind} needs a github_api source on ${r.repo}`];
      for (const s of gh) {
        const g = parseGithubRef(s.kind as "github_api" | "github_events", s.ref);
        if (!g) continue;
        if (!sameRepo(g.repo, r.repo)) { out.push(`source ${s.ref} is on ${g.repo}, the resolver ${r.kind} on ${r.repo}`); continue; }
        if (g.resource === "events") continue;
        if (r.kind === "github_pr_merged" && !(g.resource === "pulls" && g.number === r.pr)) out.push(`resolver github_pr_merged reads merged_at from repos/${r.repo}/pulls/${r.pr}; source ${s.ref} is another resource`);
        if (r.kind === "github_issue_closed" && !(g.resource === "issues" && g.number === r.issue)) out.push(`resolver github_issue_closed reads repos/${r.repo}/issues/${r.issue}; source ${s.ref} is another resource`);
        if (r.kind === "github_release_published" && !(g.resource === "releases" || (g.resource === "release_tag" && g.tag === r.tag))) out.push(`resolver github_release_published reads repos/${r.repo}/releases or releases/tags/${r.tag}; source ${s.ref} is another resource`);
      }
      return out;
    }
    case "evm_log_present": {
      const logs = reg.sources.filter((s) => s.kind === "base_log");
      if (!logs.length) return [`resolver evm_log_present needs a base_log source on ${r.address}`];
      for (const s of logs) {
        const m = BASE_LOG_REF.exec(s.ref);
        if (m && m[1]!.toLowerCase() !== r.address.toLowerCase()) out.push(`source ${s.ref} watches ${m[1]}, the resolver evm_log_present reads ${r.address}`);
      }
      return out;
    }
    case "solana_sig_present": {
      const accts = reg.sources.filter((s) => s.kind === "solana_log");
      if (!accts.length) return [`resolver solana_sig_present needs a solana_log source on ${r.account}`];
      for (const s of accts) {
        const m = SOLANA_LOG_REF.exec(s.ref);
        if (m && m[1] !== r.account) out.push(`source ${s.ref} watches ${m[1]}, the resolver solana_sig_present reads ${r.account}`);
      }
      return out;
    }
    case "numeric_threshold": case "official_release": return [];
    default: { const never: never = r; throw new Error(`unhandled resolver ${String(never)}`); }
  }
}

/** Every policy problem of a watch-creating registration; empty = allowed. Empty with the rail off. */
export function registrationPolicyIssues(reg: Pick<MarketRegistration, "sources" | "resolver">): string[] {
  if (!railEnabled("registration_policy")) return [];
  const refs = reg.sources.map((s) => sourceRefProblem(s, reg.resolver)).filter((p): p is string => p !== null);
  return [...refs, ...resolverSourceProblems(reg)];
}

/** web_render needs Browser Rendering (plan §16.4 P6); until it ships a web_render watch could only ever fail. */
export function webRenderRefusal(reg: Pick<MarketRegistration, "sources">): string | null {
  const r = reg.sources.find((s) => s.kind === "web_render");
  return r ? `web_render source ${r.ref} is refused until Browser Rendering ships (plan §16.4 P6); register it as web_fetch if the page is server-rendered` : null;
}

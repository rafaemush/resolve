/**
 * Every curl a customer page prints (/docs, the key page, the /pricing card section) parses against the OpenAPI document
 * (src/generated/openapi.json, served at /openapi.json): the command is valid shell (every body sits in one quoted
 * argument), its method and path are an operation of the document, an authenticated operation carries a key header, a
 * header or query parameter it sends is one the operation declares, and its body is JSON with a declared content type
 * that the operation's request schema accepts (zod's fromJSONSchema over the document's own schema). A placeholder such
 * as <market_id> stands for a value of the parameter's type and is substituted before the check.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import openapi from "../src/generated/openapi.json";
import { docsHtml, keyIssuedHtml, payByCardHtml } from "../src/api/site";

type Op = { security?: unknown[]; parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown }>; requestBody?: { content: Record<string, { schema: unknown }> } };
const doc = openapi as unknown as { paths: Record<string, Record<string, Op>>; components: { schemas: Record<string, unknown> } };
const BASE = "https://resolve.example.com";

/** The document's schemas as $defs, so a $ref into components resolves inside one JSON Schema. */
const DEFS = JSON.parse(JSON.stringify(doc.components.schemas).replace(/#\/components\/schemas\//g, "#/$defs/")) as Record<string, unknown>;
const toZod = (schema: unknown) => z.fromJSONSchema(JSON.parse(JSON.stringify({ ...(schema as object), $defs: DEFS }).replace(/#\/components\/schemas\//g, "#/$defs/")));

/** Values a placeholder stands for, by what it names. */
const PLACEHOLDERS: Record<string, string> = { "<market_id>": "11111111-1111-4111-8111-111111111111", "<commitment sha256>": "ab".repeat(32) };
const fill = (s: string) => Object.entries(PLACEHOLDERS).reduce((acc, [k, v]) => acc.split(k).join(v), s);

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Shell commands of a script: a newline outside quotes ends one, a backslash-newline outside quotes continues it. */
function shellCommands(text: string): string[] {
  const out: string[] = [];
  let cur = "", quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === "'") { cur += ch; if (ch === "'") quote = null; continue; }
    if (quote === '"') { cur += ch; if (ch === "\\" && i + 1 < text.length) cur += text[++i]; else if (ch === '"') quote = null; continue; }
    if (ch === "\\" && text[i + 1] === "\n") { cur += " "; i++; continue; }
    if (ch === "\n") { out.push(cur); cur = ""; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim()).filter(Boolean);
}

/** Every curl command in the page's <pre> blocks (a body may span lines inside its quotes). */
export function curlsOf(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<pre>([\s\S]*?)<\/pre>/g)) {
    for (const cmd of shellCommands(decode(m[1]!.replace(/<[^>]+>/g, "")))) if (cmd.startsWith("curl ")) out.push(cmd);
  }
  return out;
}

/** POSIX-shell words: single quotes are literal, double quotes keep $VAR as written, a backslash escapes outside quotes. */
export function shellWords(cmd: string): string[] {
  const words: string[] = [];
  let cur = "", inWord = false, i = 0;
  while (i < cmd.length) {
    const ch = cmd[i]!;
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) throw new Error(`unterminated single quote in: ${cmd.slice(0, 120)}`);
      cur += cmd.slice(i + 1, end); inWord = true; i = end + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) { if (cmd[j] === "\\") j++; }
      if (j >= cmd.length) throw new Error(`unterminated double quote in: ${cmd.slice(0, 120)}`);
      cur += cmd.slice(i + 1, j).replace(/\\(["\\$`])/g, "$1"); inWord = true; i = j + 1; continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) { cur += cmd[i + 1]; inWord = true; i += 2; continue; }
    if (/\s/.test(ch)) { if (inWord) { words.push(cur); cur = ""; inWord = false; } i++; continue; }
    if ("|;&<>".includes(ch)) throw new Error(`shell operator ${ch} outside quotes in: ${cmd.slice(0, 120)}`);
    cur += ch; inWord = true; i++;
  }
  if (inWord) words.push(cur);
  return words;
}

interface Curl { method: string; url: URL; headers: Record<string, string>; body: string | null }

/** A placeholder is what the reader replaces before running the command, so it is filled in before the shell reads it. */
export function parseCurl(cmd: string): Curl {
  const w = shellWords(fill(cmd));
  if (w[0] !== "curl") throw new Error(`not a curl: ${cmd}`);
  let method: string | null = null, url: string | null = null, body: string | null = null;
  const headers: Record<string, string> = {};
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (a === "-X") method = w[++i]!;
    else if (a === "-H") { const h = w[++i]!; const k = h.indexOf(":"); headers[h.slice(0, k).trim().toLowerCase()] = h.slice(k + 1).trim(); }
    else if (a === "-d" || a === "--data") body = w[++i]!;
    else if (a.startsWith("-")) throw new Error(`unknown curl option ${a}`);
    else if (url === null) url = a;
    else throw new Error(`a second URL ${a} in: ${cmd}`);
  }
  if (!url) throw new Error(`no URL in: ${cmd}`);
  return { method: method ?? (body === null ? "GET" : "POST"), url: new URL(url), headers, body };
}

const templates = Object.keys(doc.paths).map((t) => ({ t, re: new RegExp(`^${t.replace(/\{[^}]+\}/g, "([^/]+)")}$`), names: [...t.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!), literal: !t.includes("{") }));

/** The problems of one curl against the document; [] when it parses. */
export function curlProblems(c: Curl): string[] {
  const p: string[] = [];
  const path = c.url.pathname;
  const hit = templates.filter((x) => x.re.test(path)).sort((a, b) => Number(b.literal) - Number(a.literal))[0];
  if (!hit) return [`no OpenAPI path matches ${path}`];
  const op = doc.paths[hit.t]![c.method.toLowerCase()];
  if (!op) return [`${c.method} ${hit.t} is not an operation of the document`];
  const params = op.parameters ?? [];
  const values = hit.re.exec(path)!.slice(1).map(decodeURIComponent);
  hit.names.forEach((name, i) => {
    const d = params.find((x) => x.in === "path" && x.name === name);
    if (d?.schema && !toZod(d.schema).safeParse(values[i]).success) p.push(`path parameter ${name}=${values[i]} does not fit its schema`);
  });
  for (const [k, v] of c.url.searchParams) {
    const d = params.find((x) => x.in === "query" && x.name === k);
    if (!d) p.push(`query parameter ${k} is not declared`);
    else if (d.schema && !toZod(d.schema).safeParse(v).success) p.push(`query parameter ${k}=${v} does not fit its schema`);
  }
  for (const d of params.filter((x) => x.in === "query" && x.required)) if (!c.url.searchParams.has(d.name)) p.push(`required query parameter ${d.name} is missing`);
  const keyed = /^Bearer \S+$/.test(c.headers.authorization ?? "") || !!c.headers["x-api-key"];
  if (op.security?.length && !keyed) p.push(`${c.method} ${hit.t} needs a key: no Authorization: Bearer or X-Api-Key header`);
  for (const h of Object.keys(c.headers)) {
    if (["authorization", "x-api-key", "content-type"].includes(h)) continue;
    if (!params.some((x) => x.in === "header" && x.name.toLowerCase() === h)) p.push(`header ${h} is not a declared parameter of ${c.method} ${hit.t}`);
  }
  if (c.body !== null) {
    if (!op.requestBody) return [...p, `${c.method} ${hit.t} takes no body`];
    const ctype = c.headers["content-type"];
    const content = ctype ? op.requestBody.content[ctype] : undefined;
    if (!content) return [...p, `content-type ${ctype ?? "(none)"} is not one of ${Object.keys(op.requestBody.content).join(", ")}`];
    let json: unknown;
    try { json = JSON.parse(c.body); } catch (e) { return [...p, `body is not JSON: ${String(e)}`]; }
    const r = toZod(content.schema).safeParse(json);
    if (!r.success) p.push(`body does not fit the request schema: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return p;
}

const PAGES: Array<[string, string]> = [
  ["/docs (card open)", docsHtml({ base: BASE, channel: null, card: true })],
  ["/docs (card not open)", docsHtml({ base: BASE, channel: null, card: false })],
  ["the key page", keyIssuedHtml({ key: `rsl_test_${"a".repeat(32)}`, expiresAt: "2026-10-31T00:00:00Z", base: BASE, channel: null })],
  ["/pricing pay by card", payByCardHtml({ base: BASE })],
];

describe("every curl on a customer page parses against the OpenAPI document", () => {
  for (const [name, html] of PAGES) {
    it(name, () => {
      const curls = curlsOf(html);
      expect(curls.length, name).toBeGreaterThan(0);
      for (const cmd of curls) {
        const c = parseCurl(cmd);
        expect(c.url.origin, cmd).toBe(BASE);
        expect(curlProblems(c), cmd.slice(0, 160)).toEqual([]);
      }
    });
  }

  it("/docs prints the quickstart's calls, and the key page's next call is the free list of first prints", () => {
    const ops = curlsOf(PAGES[0]![1]).map((cmd) => { const c = parseCurl(cmd); return `${c.method} ${c.url.pathname}`; });
    expect(ops).toEqual([
      "POST /v1/request-key", "GET /v1/prints/us_unemployment_rate/2026-09", "POST /v1/markets", "POST /v1/resolve", "POST /v1/resolve",
      "POST /v1/webhooks", "POST /v1/markets/polymarket:$EXTERNAL_ID/follow", "GET /v1/track-record/verify", "POST /v1/billing/checkout",
    ]);
    expect(curlsOf(PAGES[2]![1]).map((cmd) => { const c = parseCurl(cmd); return `${c.method} ${c.url.pathname}`; })).toEqual(["GET /v1/prints"]);
  });

  it("the checker refuses what the document does not allow (it is not vacuous)", () => {
    const bad = (cmd: string) => curlProblems(parseCurl(cmd));
    expect(bad(`curl ${BASE}/v1/nowhere`)).toEqual(["no OpenAPI path matches /v1/nowhere"]);
    expect(bad(`curl -X DELETE ${BASE}/v1/prints`)[0]).toContain("is not an operation");
    expect(bad(`curl ${BASE}/v1/prints`)[0]).toContain("needs a key");
    expect(bad(`curl ${BASE}/v1/prints/not_a_series/2026-09 -H "Authorization: Bearer $K"`)[0]).toContain("path parameter series");
    expect(bad(`curl ${BASE}/v1/prints/us_unemployment_rate/Sept -H "Authorization: Bearer $K"`)[0]).toContain("path parameter period");
    expect(bad(`curl ${BASE}/v1/prints -H "Authorization: Bearer $K" -H 'X-Debug: 1'`)[0]).toContain("header x-debug");
    expect(bad(`curl -X POST ${BASE}/v1/resolve -H "Authorization: Bearer $K" -H 'content-type: application/json' -d '{"market_id":"m-1","fetch":true}'`)[0]).toContain("body does not fit");
    expect(bad(`curl -X POST ${BASE}/v1/markets -H "Authorization: Bearer $K" -H 'content-type: application/json' -d '{"platform":"custom"}'`)[0]).toContain("body does not fit");
    expect(bad(`curl -X POST ${BASE}/v1/billing/checkout -H "Authorization: Bearer $K" -H 'content-type: text/plain' -d '{"pack":"50"}'`)[0]).toContain("content-type text/plain");
    expect(bad(`curl -X POST ${BASE}/v1/billing/checkout -H "Authorization: Bearer $K" -H 'content-type: application/json' -d '{"pack":"7"}'`)[0]).toContain("body does not fit");
    expect(bad(`curl '${BASE}/v1/track-record/verify?hash=nope'`)[0]).toContain("query parameter hash");
    expect(() => parseCurl(`curl -d '{"a":"it's"}' ${BASE}/v1/resolve`)).toThrow(/unterminated|operator/);
  });
});

/**
 * GET /bot (plan §17.3 P6) and ResolveBot's one user agent: the page renders without auth, shows the UA the Worker sends
 * and both ways to opt out (a robots.txt group for ResolveBot, or an issue), names no person and no model; wrangler.toml
 * declares the same UA, and no file under src/ or scripts/ hard-codes another one.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { botPageHtml, OPT_OUT_ISSUES_URL } from "../src/api/bot";
import { BOT_TOKEN, botUa, RESOLVE_BOT_UA } from "../src/ops/ua";
import { robotsVerdict } from "../src/ingest/robots";

const ROOT = resolve(import.meta.dirname, "..");

describe("GET /bot", () => {
  it("public HTML with the UA, the robots.txt opt-out and the issues link; no auth, no database", async () => {
    const res = await app.request("/bot", { method: "GET" }, { RESOLVE_BOT_UA } as unknown as Env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(RESOLVE_BOT_UA);
    expect(html).toContain("User-agent: ResolveBot\nDisallow: /");
    expect(html).toContain(`href="${OPT_OUT_ISSUES_URL}"`);
    expect(OPT_OUT_ISSUES_URL).toBe("https://github.com/rafaemush/resolve/issues");
    expect(html).toMatch(/If-None-Match/);
    expect(html).toMatch(/Retry-After/);
    expect(html).toMatch(/RFC 9309/);
  });
  it("shows the configured UA (escaped), and the shared constant when none is configured", async () => {
    expect(botPageHtml("ResolveBot/1.0 (+<x>)")).toContain("ResolveBot/1.0 (+&lt;x&gt;)");
    const res = await app.request("/bot", { method: "GET" }, {} as unknown as Env);
    expect(await res.text()).toContain(RESOLVE_BOT_UA);
  });
  it("says robots.txt covers registered web pages only, and that official releases and public APIs opt out by issue", () => {
    const html = botPageHtml(RESOLVE_BOT_UA);
    expect(html).toContain("<strong>robots.txt, for web pages.</strong> Read per RFC 9309 before a web page is registered as a source.");
    expect(html).toContain("Official releases and public APIs (the second and third items above) are not checked against robots.txt.");
    expect(html).toContain("<p>For web pages, add a group for ResolveBot to your robots.txt:</p>");
    expect(html).toMatch(/it does not cover official releases or public APIs\. For those, [^<]*open an issue at <a href="https:\/\/github\.com\/rafaemush\/resolve\/issues">/);
    expect(html).not.toMatch(/per-host|per host/i);
  });
  it("the OpenAPI summary of /bot claims only what the code does: per-page spacing, robots.txt for web pages", () => {
    for (const p of ["docs/openapi.json", "src/generated/openapi.json"]) {
      const summary = JSON.parse(readFileSync(join(ROOT, p), "utf8")).paths["/bot"].get.summary as string;
      expect(summary, p).not.toMatch(/per-host|per host/i);
      expect(summary, p).toContain("per-page spacing");
      expect(summary, p).toContain("robots.txt for web pages");
    }
  });
  it("names no person, no email address and no model; claims no accuracy", () => {
    const html = botPageHtml(RESOLVE_BOT_UA);
    expect(html).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
    expect(html).not.toMatch(/jev|typesafe|accura|DCM|24.72 h/i);
  });
  it("the opt-out on the page is one robots.txt actually honors: a ResolveBot group disallowing / refuses every page", () => {
    const body = "User-agent: *\nAllow: /\n\nUser-agent: ResolveBot\nDisallow: /\n";
    expect(robotsVerdict(body, new URL("https://example.org/news/1"), RESOLVE_BOT_UA).allowed).toBe(false);
    expect(RESOLVE_BOT_UA.split("/")[0]).toBe(BOT_TOKEN);
  });
});

describe("ResolveBot's one user agent", () => {
  it("wrangler.toml RESOLVE_BOT_UA is the shared constant, which links to /bot", () => {
    const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
    expect(toml).toContain(`RESOLVE_BOT_UA = "${RESOLVE_BOT_UA}"`);
    expect(RESOLVE_BOT_UA).toBe("ResolveBot/1.0 (+https://resolve.rafaemush.workers.dev/bot)");
    expect(botUa({ RESOLVE_BOT_UA: "  " })).toBe(RESOLVE_BOT_UA);
    expect(botUa(undefined)).toBe(RESOLVE_BOT_UA);
  });
  it("no file under src/ or scripts/ hard-codes a ResolveBot UA or the placeholder domain (src/ops/ua.ts is the one place)", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|js|sh|json)$/.test(f)) files.push(p);
      }
    };
    walk(join(ROOT, "src"));
    walk(join(ROOT, "scripts"));
    const offenders = files.filter((p) => !p.endsWith(join("src", "ops", "ua.ts")) && !p.endsWith(join("src", "api", "bot.ts")) && !p.includes(join("src", "generated")))
      .filter((p) => /ResolveBot\/|resolve\.example/.test(readFileSync(p, "utf8")));
    expect(offenders.map((p) => p.slice(ROOT.length + 1))).toEqual([]);
  });
});

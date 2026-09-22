import { describe, it, expect } from "vitest";
import { ruleToRegex } from "../src/ingest/robots";

describe("robots rule matching", () => {
  it("treats wildcards as runs, not as a prefix cut", () => {
    expect(ruleToRegex("/*/pulse").test("/vercel/pulse")).toBe(true);
    expect(ruleToRegex("/*/pulse").test("/vercel/next.js/releases")).toBe(false);
    expect(ruleToRegex("/*/*/pull/*/").test("/openai/openai-python/pull/4821/files")).toBe(true);
    expect(ruleToRegex("/").test("/anything")).toBe(true);
    expect(ruleToRegex("/blog$").test("/blog")).toBe(true);
    expect(ruleToRegex("/blog$").test("/blog/next-15")).toBe(false);
    expect(ruleToRegex("/api/").test("/api/v1")).toBe(true);
    expect(ruleToRegex("/api/").test("/apiary")).toBe(false);
  });
});

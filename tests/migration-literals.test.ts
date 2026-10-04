/**
 * Every COMMENT ON ... IS '<literal>' in supabase/migrations closes its literal right before the statement's ";" (or a
 * "||" concatenation). A lone apostrophe inside the text ("the tenant's own") ends the literal early and the rest of the
 * text is read as SQL: Postgres refuses the whole file (migration 023's first staging apply, 2026-10-05, failed with
 * "syntax error at or near s"), and two of them can even balance each other, so a quote count alone cannot see it.
 * Static, no database.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(__dirname, "../supabase/migrations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

/** The character after each COMMENT ON literal, with the literal's first 60 characters, for every comment of a file. */
function commentLiteralEnds(sql: string): Array<{ next: string; head: string }> {
  const out: Array<{ next: string; head: string }> = [];
  const re = /\bcomment\s+on\b[\s\S]*?\bis\s+'((?:[^']|'')*)'\s*(\S)/gi;
  for (let m = re.exec(sql); m; m = re.exec(sql)) out.push({ next: m[2]!, head: m[1]!.slice(0, 60) });
  return out;
}

describe("COMMENT ON literals in every migration", () => {
  it("finds the migrations", () => expect(files.length).toBeGreaterThanOrEqual(22));
  for (const f of files) {
    it(`${f}: every comment literal ends at ";" or "||"`, () => {
      const bad = commentLiteralEnds(readFileSync(resolve(DIR, f), "utf8")).filter((c) => c.next !== ";" && c.next !== "|");
      expect(bad, `a lone ' inside a comment text (write '' for an apostrophe): ${JSON.stringify(bad)}`).toEqual([]);
    });
  }
  it("catches the defect it exists for", () => {
    expect(commentLiteralEnds("comment on column t.c is 'the tenant''s own';").map((c) => c.next)).toEqual([";"]);
    expect(commentLiteralEnds("comment on column t.c is 'the tenant's own removal is not Resolve's lateness.';").map((c) => c.next)).toEqual(["s"]);
  });
});

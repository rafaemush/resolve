/**
 * scripts/seed-shadow.ts rules (plan §16.4 P5 step 3), pure: --check refuses a Polymarket entry without condition_id,
 * a market over the $50k cap, is_test true, a past deadline, a non-https source, meta outside the whitelist, a question or
 * a deadline in event_statement, an approval with needs_review left and duplicates; only approved entries block. The
 * read-back (after --apply, and for a row a rerun finds already present) compares the database row and its active
 * watches with what was sent.
 */
import { describe, expect, it } from "vitest";
import { checkCandidateFile, eventStatementProblem, parseSeedArgs, UsageError, verifyRow } from "../scripts/lib/seed-shadow";

const NOW = new Date("2026-09-24T12:00:00Z");
const CID = `0x${"cd".repeat(32)}`;

function entry(over: { approved?: boolean; needs_review?: string[]; volume_usd?: number; market?: Record<string, unknown>; meta?: Record<string, unknown>; is_test?: boolean } = {}) {
  return {
    approved: over.approved ?? true,
    needs_review: over.needs_review ?? [],
    volume_usd: over.volume_usd ?? 1200,
    score: 3.1,
    registration: {
      market: {
        platform: "polymarket", external_id: "637022", condition: "Resolves Yes if the BLS CPI release shows the 12-month change above 3.0%.",
        event_statement: "September 2026 CPI is above 3.0%", option_a: "Yes", option_b: "No", positive_option: "OPTION_A", anchors: ["Consumer Price Index"],
        sources: [{ kind: "web_fetch", ref: "https://www.bls.gov/news.release/cpi.nr0.htm" }], open_at: "2026-09-01T00:00:00Z", deadline_utc: "2026-10-14T12:30:00Z",
        negative_rule: "explicit_negative", ...over.market,
      },
      meta: over.meta ?? { condition_id: CID, slug: "cpi-above-3", event_id: "ev1" },
      is_test: over.is_test ?? false,
    },
  };
}
const file = (entries: unknown[], platform = "polymarket") => ({ header: { platform, generated_at: NOW.toISOString(), source_url: "https://gamma-api.polymarket.com/markets/keyset", filters: {}, counts: {}, needs_founder_approval: true }, entries });
const errorsOf = (e: unknown, platform?: string) => checkCandidateFile(file([e], platform), NOW).entries[0]!.errors;

describe("seed-shadow --check", () => {
  it("passes a complete approved Polymarket entry", () => {
    const c = checkCandidateFile(file([entry()]), NOW);
    expect(c).toMatchObject({ platform: "polymarket", fileErrors: [], approved: 1, approvedInvalid: 0 });
    expect(c.entries[0]!.errors).toEqual([]);
  });

  it("refuses a Polymarket entry without meta.condition_id", () => {
    expect(errorsOf(entry({ meta: { slug: "x" } }))).toEqual([expect.stringContaining("meta.condition_id is required")]);
    expect(errorsOf(entry({ meta: { slug: "x" }, market: { platform: "limitless", external_id: "x-1" } }), "limitless")).toEqual([]);
  });

  it("enforces the $50k cap, is_test false, a future deadline and https sources", () => {
    expect(errorsOf(entry({ volume_usd: 50_000.01 }))).toEqual([expect.stringContaining("over the $50000 shadow cap")]);
    expect(errorsOf(entry({ is_test: true }))).toEqual([expect.stringContaining("is_test must be false")]);
    expect(errorsOf(entry({ market: { deadline_utc: "2026-09-24T11:59:59Z", open_at: "2026-09-01T00:00:00Z" } }))).toEqual([expect.stringContaining("is not in the future")]);
    expect(errorsOf(entry({ market: { sources: [{ kind: "web_fetch", ref: "http://www.bls.gov/cpi/" }] } }))).toEqual([expect.stringContaining("is not https")]);
  });

  it("validates the market with the Worker's schema, the platform and the meta whitelist", () => {
    expect(errorsOf(entry({ market: { anchors: [] } }))[0]).toMatch(/^market\.anchors/);
    expect(errorsOf(entry({ market: { platform: "limitless" } }))).toEqual([expect.stringContaining("the file is for polymarket")]);
    expect(errorsOf(entry({ meta: { condition_id: CID, volume: 3 } }))).toEqual(["meta keys outside the whitelist: volume"]);
    expect(errorsOf(entry({ meta: { condition_id: "0x1" } }))[0]).toMatch(/^meta: condition_id/);
  });

  it("blocks an approval while needs_review is not empty; an unapproved entry never blocks", () => {
    const c = checkCandidateFile(file([entry({ needs_review: ["anchors"] }), entry({ approved: false, needs_review: ["anchors"], market: { external_id: "2" }, volume_usd: 90_000 })]), NOW);
    expect(c.entries[0]!.errors).toEqual([expect.stringContaining("needs_review still lists anchors")]);
    expect(c.entries[1]!.errors).toEqual([expect.stringContaining("shadow cap")]);
    expect(c).toMatchObject({ approved: 1, approvedInvalid: 1 });
  });

  it("refuses the second of two entries with the same external_id", () => {
    const c = checkCandidateFile(file([entry(), entry()]), NOW);
    expect(c.entries[1]!.errors).toEqual(["duplicate of entry 0 (polymarket:637022)"]);
  });

  it("reports a file that is not a candidate file", () => {
    expect(checkCandidateFile({ entries: [] }, NOW).fileErrors[0]).toMatch(/^header/);
  });
});

describe("seed-shadow arguments", () => {
  it("defaults to a dry run and refuses anything ambiguous", () => {
    expect(parseSeedArgs(["f.json"])).toEqual({ file: "f.json", mode: "dry-run" });
    expect(parseSeedArgs(["f.json", "--check"])).toEqual({ file: "f.json", mode: "check" });
    expect(parseSeedArgs(["--apply", "f.json"])).toEqual({ file: "f.json", mode: "apply" });
    expect(() => parseSeedArgs(["f.json", "--apply", "--dry-run"])).toThrow(UsageError);
    expect(() => parseSeedArgs(["f.json", "--aply"])).toThrow(UsageError);
    expect(() => parseSeedArgs(["a.json", "b.json"])).toThrow(UsageError);
    expect(() => parseSeedArgs([])).toThrow(UsageError);
  });
});

describe("seed-shadow event_statement rule", () => {
  it("refuses a question, an interrogative opener or deadline wording; a declarative fact passes", () => {
    expect(eventStatementProblem("Will the 5-year Treasury yield dip below 4.52% in September?")).toMatch(/question mark/);
    expect(eventStatementProblem("Fed Decision in October? — 25 bps decrease")).toMatch(/question mark/);
    expect(eventStatementProblem("Which party will win the House in 2026")).toMatch(/^starts with "Which"/);
    expect(eventStatementProblem("Who wins the Ballon d'Or 2026")).toMatch(/^starts with "Who"/);
    expect(eventStatementProblem("Pacifica launched a token by September 30, 2026")).toMatch(/^names a deadline \("by September"\)/);
    expect(eventStatementProblem("The pull request was merged before the deadline")).toMatch(/^names a deadline/);
    expect(eventStatementProblem("Pacifica launched its token")).toBeNull();
    expect(eventStatementProblem("September 2026 CPI is above 3.0%")).toBeNull();
    expect(eventStatementProblem("The FOMC lowered the federal funds target range by 25 basis points")).toBeNull();
    // Not questions and not dates: the organization, a name after "by", a "?" inside a URL.
    expect(eventStatementProblem("WHO declared mpox a public health emergency")).toBeNull();
    expect(eventStatementProblem("The bill was signed by Janet Yellen and May Holdings")).toBeNull();
    expect(eventStatementProblem("The page https://example.gov/results?id=7 lists the winner")).toBeNull();
  });

  it("blocks an approved entry whose event_statement is the platform's question", () => {
    expect(errorsOf(entry({ market: { event_statement: "Will September 2026 CPI be above 3.0%?" } }))).toEqual(["event_statement contains a question mark: write it as a declarative fact"]);
  });
});

describe("seed-shadow read-back", () => {
  const sources = [{ kind: "web_fetch", ref: "https://www.bls.gov/cpi/" }, { kind: "web_fetch", ref: "https://www.bls.gov/schedule/" }];
  const want = { platform: "polymarket", externalId: "637022", meta: { condition_id: CID, slug: "s" }, sources };
  // jsonb stores object keys in its own order: the comparison must not depend on it.
  const row = { id: "m1", platform: "polymarket", external_id: "637022", status: "open", is_test: false, condition_id: CID, meta: { condition_id: CID, slug: "s", registration_reasons: [] }, sources: sources.map((s) => ({ ref: s.ref, kind: s.kind })) };
  it("accepts the row that landed as sent and names every difference otherwise", () => {
    expect(verifyRow(row, 2, want)).toEqual([]);
    expect(verifyRow(null, 0, want)).toEqual(["no row found after registration"]);
    expect(verifyRow({ ...row, is_test: true, condition_id: null, meta: { registration_reasons: [] } }, 2, want)).toEqual([
      "is_test is not false", `condition_id null != ${CID}`, `meta.condition_id is undefined, expected "${CID}"`, 'meta.slug is undefined, expected "s"',
    ]);
  });

  it("names an open market left with fewer watches than sources (a registration that stopped part-way)", () => {
    expect(verifyRow(row, 1, want)).toEqual(["open with 1 active watch for 2 sources"]);
    expect(verifyRow(row, 0, want)).toEqual(["open with 0 active watches for 2 sources"]);
    // unsupported_source never gets watches, and a terminal status has them deactivated: nothing to count.
    expect(verifyRow({ ...row, status: "unsupported_source" }, 0, want)).toEqual([]);
    expect(verifyRow({ ...row, status: "resolved" }, 0, want)).toEqual([]);
  });

  it("names an existing row whose sources are not the approved entry's", () => {
    expect(verifyRow({ ...row, sources: [sources[0]] }, 1, want)).toEqual([
      "sources are [web_fetch https://www.bls.gov/cpi/], the entry lists [web_fetch https://www.bls.gov/cpi/, web_fetch https://www.bls.gov/schedule/]",
    ]);
  });
});

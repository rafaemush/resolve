/**
 * scripts/seed-shadow.ts rules (plan §16.4 P5 step 3), pure: --check refuses a Polymarket entry without condition_id,
 * a market over the $50k cap, is_test true, a past deadline, a non-https source, meta outside the whitelist, an approval
 * with needs_review left and duplicates; only approved entries block. The read-back after --apply compares the database
 * row with what was sent.
 */
import { describe, expect, it } from "vitest";
import { checkCandidateFile, parseSeedArgs, UsageError, verifyRow } from "../scripts/lib/seed-shadow";

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

describe("seed-shadow read-back", () => {
  const row = { id: "m1", platform: "polymarket", external_id: "637022", status: "open", is_test: false, condition_id: CID, meta: { condition_id: CID, slug: "s", registration_reasons: [] } };
  it("accepts the row that landed as sent and names every difference otherwise", () => {
    expect(verifyRow(row, "polymarket", "637022", { condition_id: CID, slug: "s" })).toEqual([]);
    expect(verifyRow(null, "polymarket", "637022", {})).toEqual(["no row found after registration"]);
    expect(verifyRow({ ...row, is_test: true, condition_id: null, meta: { registration_reasons: [] } }, "polymarket", "637022", { condition_id: CID, slug: "s" })).toEqual([
      "is_test is not false", `condition_id null != ${CID}`, `meta.condition_id is undefined, expected "${CID}"`, 'meta.slug is undefined, expected "s"',
    ]);
  });
});

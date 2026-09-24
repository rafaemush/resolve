/**
 * scripts/log-touch.ts and scripts/leads.ts rules (migration 014's log_touch and no-cold-pitch gate), pure, no network:
 * argument parsing (dry run unless --apply, anything unexpected stops before a write), the derived request id (the same
 * touch the same day is the same id, so a retry is idempotent), what counts as a pitch, lead suggestions on a miss, the
 * RS002 refusal in plain words with the override hint, and the lead table.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { isPitch, leadCandidates, leadsTable, parseLeadsArgs, parseTouchArgs, touchRefusal, touchRequestId, UsageError, type LeadRow } from "../scripts/lib/touch";

const DAY = "2026-10-28";
const base = ["--lead", "Limitless Labs", "--kind", "dm", "--direction", "out", "--summary", "Sent the reconciliation report; asked for a call by Nov 4"];

describe("parseTouchArgs", () => {
  it("defaults: dry run, derived request id, no evidence or override", () => {
    const a = parseTouchArgs(base, DAY);
    expect(a).toMatchObject({ lead: "Limitless Labs", kind: "dm", direction: "out", evidenceUrl: null, overrideReason: null, derivedRequestId: true, apply: false });
    expect(a.requestId).toMatch(/^[0-9a-f]{64}$/);
    expect(parseTouchArgs([...base, "--dry-run"], DAY).apply).toBe(false);
  });
  it("every flag, both --flag value and --flag=value", () => {
    const a = parseTouchArgs(["--lead=  TypeSafe ", "--kind=ops", "--direction", "out", "--summary=Follow-up #1 (day 7)", "--evidence-url", "https://mail.example/thread/1", "--override-reason", "vendor request, not a pitch", "--request-id", "typesafe-day7", "--apply"], DAY);
    expect(a).toEqual({ lead: "TypeSafe", kind: "ops", direction: "out", summary: "Follow-up #1 (day 7)", evidenceUrl: "https://mail.example/thread/1", overrideReason: "vendor request, not a pitch", requestId: "typesafe-day7", derivedRequestId: false, apply: true });
  });
  it("refuses what it does not understand, and blanks", () => {
    const bad: string[][] = [
      [], base.slice(0, 6), ["--lead", "", ...base.slice(2)], [...base, "--kind", "sms"], ["--lead", "x", "--kind", "sms", "--direction", "out", "--summary", "s"],
      ["--lead", "x", "--kind", "dm", "--direction", "sideways", "--summary", "s"], ["--lead", "x", "--kind", "dm", "--direction", "out", "--summary", "   "],
      [...base, "--override-reason", "  "], [...base, "--evidence-url", "not a url"], [...base, "--evidence-url", "ftp://x.example/a"], [...base, "--request-id", " "],
      [...base, "--apply", "--dry-run"], [...base, "--apply=yes"], [...base, "--lead"], [...base, "extra"], [...base, "--nope", "x"],
    ];
    for (const argv of bad) expect(() => parseTouchArgs(argv, DAY), argv.join(" ")).toThrow(UsageError);
  });
  it("a summary may start with dashes as long as it is not a flag", () => {
    expect(parseTouchArgs(["--lead", "x", "--kind", "reply", "--direction", "out", "--summary", "-- thanks, see you Tuesday"], DAY).summary).toBe("-- thanks, see you Tuesday");
  });
});

describe("the derived request id", () => {
  it("is sha256(lead|kind|direction|summary|day): deterministic, so a retry the same day is the same touch", () => {
    const a = parseTouchArgs(base, DAY), b = parseTouchArgs(base, DAY);
    expect(a.requestId).toBe(b.requestId);
    expect(a.requestId).toBe(createHash("sha256").update(`Limitless Labs|dm|out|${base[7]}|${DAY}`).digest("hex"));
    expect(touchRequestId({ lead: "Limitless Labs", kind: "dm", direction: "out", summary: base[7]!, day: DAY })).toBe(a.requestId);
  });
  it("changes with the day and with any part of the touch", () => {
    const id = parseTouchArgs(base, DAY).requestId;
    expect(parseTouchArgs(base, "2026-10-29").requestId).not.toBe(id);
    expect(parseTouchArgs(base.map((x) => (x === "dm" ? "email" : x)), DAY).requestId).not.toBe(id);
    expect(parseTouchArgs([...base.slice(0, 7), `${base[7]}.`], DAY).requestId).not.toBe(id);
  });
  it("ignores surrounding whitespace in the arguments (the stored values are trimmed too)", () => {
    expect(parseTouchArgs(base.map((x) => (x === "Limitless Labs" ? " Limitless Labs " : x)), DAY).requestId).toBe(parseTouchArgs(base, DAY).requestId);
  });
});

describe("the gate, refusals and leads", () => {
  it("a pitch is an outbound dm, email or call; reply and ops never are; inbound never is", () => {
    for (const kind of ["dm", "email", "call"] as const) { expect(isPitch({ kind, direction: "out" })).toBe(true); expect(isPitch({ kind, direction: "in" })).toBe(false); }
    for (const kind of ["reply", "ops"] as const) expect(isPitch({ kind, direction: "out" })).toBe(false);
  });
  it("RS002 is printed plainly with the override hint; a deleted lead says so; 23505 names the request id problem", () => {
    const gate = touchRefusal({ code: "RS002", message: "no-cold-pitch gate: no reconciled row on platform limitless for lead 1; an outbound dm needs one, or an override_reason" }, { kind: "dm", overrideReason: null })!;
    expect(gate).toMatch(/^REFUSED by the no-cold-pitch gate \(RS002\)/);
    expect(gate).toContain('--override-reason "<why>"');
    expect(touchRefusal({ code: "RS002", message: "lead 1 is deleted: no new touch" }, { kind: "dm", overrideReason: null })).toMatch(/deleted lead/);
    expect(touchRefusal({ code: "23505", message: "log_touch: request_id x already records touch y with different content" }, { kind: "dm", overrideReason: null })).toMatch(/--request-id/);
    expect(touchRefusal({ code: "57014", message: "timeout" }, { kind: "dm", overrideReason: null })).toBeNull();
  });
  const leads: LeadRow[] = [
    { id: "1", name: "Limitless Labs", org: "Limitless", platform: "limitless", fit_rank: 1, status: "prospect" },
    { id: "2", name: "Adjacent", org: null, platform: "polymarket", fit_rank: 2, status: "contacted" },
    { id: "3", name: "Polysyncer team", org: "Polysyncer", platform: "polymarket", fit_rank: null, status: "prospect" },
    { id: "4", name: "TypeSafe", org: "TypeSafe", platform: null, fit_rank: null, status: "contacted" },
  ];
  it("on a miss the closest leads are suggested (containment first), never a guess", () => {
    expect(leadCandidates(leads, "limitless").map((l) => l.id)).toEqual(["1"]);
    expect(leadCandidates(leads, "Polysyncer").map((l) => l.id)).toEqual(["3"]);
    expect(leadCandidates(leads, "labs of limitless").map((l) => l.id)).toEqual(["1"]);
    expect(leadCandidates(leads, "zzz")).toEqual([]);
  });
  it("leads table: best fit first, unranked last, with the last touch; no contact column", () => {
    const table = leadsTable(leads, [
      { lead_id: "2", kind: "dm", direction: "out", touched_at: "2026-10-20T10:00:00Z" },
      { lead_id: "2", kind: "reply", direction: "in", touched_at: "2026-10-22T10:00:00Z" },
      { lead_id: "4", kind: "ops", direction: "out", touched_at: "2026-09-23T10:00:00Z" },
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/^name\s+platform\s+fit_rank\s+status\s+last touch$/);
    expect(lines.slice(2, 6).map((l) => l.split(/\s{2,}/)[0])).toEqual(["Limitless Labs", "Adjacent", "Polysyncer team", "TypeSafe"]);
    expect(lines[3]).toContain("2026-10-22 reply in");
    expect(lines[2]).toContain("never");
    expect(lines.at(-1)).toBe("4 lead(s)");
    expect(() => parseLeadsArgs(["--all"])).toThrow(UsageError);
    expect(() => parseLeadsArgs([])).not.toThrow();
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCases, runIngestSuite } from "../evals/ingest";

describe("frozen ingestion cases (evals/ingest.ts)", () => {
  it("the frozen file and manifest match the authored cases", () => {
    const { body, manifest } = renderCases();
    expect(readFileSync(resolve(process.cwd(), "evals/ingest-cases/cases.jsonl"), "utf8")).toBe(body);
    expect(readFileSync(resolve(process.cwd(), "evals/ingest-cases/manifest.sha256"), "utf8")).toBe(manifest);
  });
  it("every case passes with every rail on", async () => {
    const s = await runIngestSuite({ quiet: true });
    expect(s.outcomes.filter((o) => o.result !== "pass")).toEqual([]);
    expect(s.cases).toBeGreaterThanOrEqual(15);
  });
});

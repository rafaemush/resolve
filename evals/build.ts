/**
 * Freeze authored cases to JSONL + manifest.
 *   pnpm eval:build          write evals/cases/<class>.jsonl and evals/manifest.sha256
 *   pnpm eval:build --check  rebuild in memory and fail if the frozen files differ (CI guard)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { MarketRegistration, EvidenceInput } from "../src/resolve/schema";
import type { EvalCase } from "./lib/cases";

const CLASSES = ["a_structured", "b_clean", "c_insufficient", "d_mismatch", "e_ambiguous", "f_malicious", "g_router", "h_faults", "i_absence"] as const;
const dir = resolve(process.cwd(), "evals/cases");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function renderAll(): Promise<{ files: Record<string, string>; manifest: string; count: number }> {
  const files: Record<string, string> = {};
  const seen = new Set<string>();
  let count = 0;
  for (const c of CLASSES) {
    const mod = (await import(`./classes/${c}.ts`)) as { cases: EvalCase[] };
    const lines: string[] = [];
    for (const k of mod.cases) {
      if (seen.has(k.id)) throw new Error(`duplicate case id ${k.id}`);
      seen.add(k.id);
      const m = MarketRegistration.safeParse(k.market);
      if (!m.success) throw new Error(`${k.id}: market invalid: ${m.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
      const e = EvidenceInput.safeParse(k.evidence);
      if (!e.success) throw new Error(`${k.id}: evidence invalid: ${e.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
      if (["C", "D", "F", "G", "H", "I"].includes(k.class) && (k.expect.status === "RESOLVED" || k.expect.status_any?.includes("RESOLVED"))) throw new Error(`${k.id}: class ${k.class} may never expect RESOLVED`);
      lines.push(JSON.stringify({ ...k, market: m.data, evidence: e.data }));
      count++;
    }
    files[`${c}.jsonl`] = lines.join("\n") + "\n";
  }
  const manifestLines = Object.entries(files).map(([f, body]) => `${sha(body)}  ${f}`);
  const suite = sha(manifestLines.join("\n"));
  manifestLines.push(`${suite}  SUITE`);
  return { files, manifest: manifestLines.join("\n") + "\n", count };
}

async function main() {
  const { files, manifest, count } = await renderAll();
  const check = process.argv.includes("--check");
  mkdirSync(dir, { recursive: true });
  let drift = 0;
  for (const [f, body] of Object.entries(files)) {
    const p = resolve(dir, f);
    if (check) { if (!existsSync(p) || readFileSync(p, "utf8") !== body) { console.log(`DRIFT ${f}`); drift++; } }
    else writeFileSync(p, body);
  }
  const mp = resolve(process.cwd(), "evals/manifest.sha256");
  if (check) { if (!existsSync(mp) || readFileSync(mp, "utf8") !== manifest) { console.log("DRIFT manifest.sha256"); drift++; } }
  else writeFileSync(mp, manifest);
  const suite = manifest.trim().split("\n").pop()!.split("  ")[0];
  console.log(`${check ? "checked" : "froze"} ${count} cases across ${Object.keys(files).length} classes; suite ${suite!.slice(0, 16)}`);
  if (drift) { console.log(`${drift} frozen file(s) differ from the authored cases — run pnpm eval:build and commit`); process.exit(1); }
}
if (process.argv[1] && process.argv[1].endsWith("build.ts")) main().catch((e) => { console.error(String(e)); process.exit(1); });

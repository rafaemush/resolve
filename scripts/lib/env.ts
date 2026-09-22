import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Minimal .env loader (KEY=VALUE, # comments). Never logs values. */
export function loadEnv(file = ".env"): Record<string, string> {
  const path = resolve(process.cwd(), file);
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  for (const [k, v] of Object.entries(out)) if (process.env[k] === undefined) process.env[k] = v;
  return out;
}

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} (see .env.example)`);
  return v;
}

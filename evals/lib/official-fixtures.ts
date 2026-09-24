/**
 * The official-release response bodies saved on 2026-09-24 (evals/fixtures/official/, provenance.json lists the URL,
 * fetch time, HTTP status and sha256 of each). Bodies over 20 KB are stored gzip-compressed and byte-exact.
 * Node only (tests and evals); nothing here is reachable from the Worker.
 */
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";

export const OFFICIAL_FIXTURE_DIR = resolve(import.meta.dirname, "../fixtures/official");

export function officialFixtureBytes(name: string): Uint8Array {
  const plain = resolve(OFFICIAL_FIXTURE_DIR, name);
  if (existsSync(plain)) return new Uint8Array(readFileSync(plain));
  const gz = `${plain}.gz`;
  if (existsSync(gz)) return new Uint8Array(gunzipSync(readFileSync(gz)));
  throw new Error(`official fixture ${name} not found in ${OFFICIAL_FIXTURE_DIR}`);
}

export function officialFixture(name: string): string {
  return new TextDecoder().decode(officialFixtureBytes(name));
}

/** When the saved body was fetched (provenance.json), used as the observation time in frozen cases. */
export function officialFixtureFetchedAt(name: string): string {
  const p = JSON.parse(readFileSync(resolve(OFFICIAL_FIXTURE_DIR, "provenance.json"), "utf8")) as { files: Record<string, { fetched_at?: string }> };
  const at = p.files[name]?.fetched_at;
  if (!at) throw new Error(`no fetched_at for ${name} in provenance.json`);
  return at;
}

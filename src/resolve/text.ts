/** Text canonicalization, hidden-Unicode handling, fuzzy anchor search, hashing. Pure. */

// Tag block, zero-width, word joiner, BOM, bidi embeddings/overrides/isolates.
const ZERO_WIDTH = /[​-‍⁠﻿]/gu;
const BIDI_AND_TAGS = /[‪-‮⁦-⁩\u{E0000}-\u{E007F}]/gu;

export interface Canonical {
  text: string;
  zeroWidthRemoved: number;
  bidiOrTagRemoved: number;
}

export function canonicalize(input: string): Canonical {
  let zeroWidthRemoved = 0;
  let bidiOrTagRemoved = 0;
  const nfkc = input.normalize("NFKC");
  const t1 = nfkc.replace(BIDI_AND_TAGS, () => { bidiOrTagRemoved++; return ""; });
  const t2 = t1.replace(ZERO_WIDTH, () => { zeroWidthRemoved++; return ""; });
  const text = t2
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, zeroWidthRemoved, bidiOrTagRemoved };
}

/** Lowercase letters/digits only, runs of anything else become one space. Returns the fuzzy string and a map from fuzzy index to source index. */
export function fuzzyIndex(text: string): { fuzzy: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let i = 0;
  let lastSpace = true;
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      out.push(ch.toLowerCase());
      map.push(i);
      lastSpace = false;
    } else if (!lastSpace) {
      out.push(" ");
      map.push(i);
      lastSpace = true;
    }
    i += ch.length;
  }
  return { fuzzy: out.join("").trim(), map };
}

export function fuzzyKey(s: string): string {
  return fuzzyIndex(s).fuzzy;
}

export interface AnchorHit { anchor: string; start: number; end: number; mode: "verbatim" | "case_insensitive" | "fuzzy" }

/** Locate an anchor in canonical text: verbatim, then case-insensitive, then fuzzy (punctuation/whitespace-insensitive). */
export function findAnchor(text: string, anchor: string, fz?: { fuzzy: string; map: number[] }): AnchorHit | null {
  const a = anchor.normalize("NFKC").trim();
  if (!a) return null;
  let idx = text.indexOf(a);
  if (idx >= 0) return { anchor, start: idx, end: idx + a.length, mode: "verbatim" };
  idx = text.toLowerCase().indexOf(a.toLowerCase());
  if (idx >= 0) return { anchor, start: idx, end: idx + a.length, mode: "case_insensitive" };
  const f = fz ?? fuzzyIndex(text);
  const fa = fuzzyKey(a);
  if (!fa) return null;
  const fi = f.fuzzy.indexOf(fa);
  if (fi < 0) return null;
  const start = f.map[fi] ?? 0;
  const endMapped = f.map[fi + fa.length - 1];
  const end = (endMapped ?? start) + 1;
  return { anchor, start, end, mode: "fuzzy" };
}

/** Merge overlapping [start,end) ranges after padding, in order. */
export function windowsAround(hits: AnchorHit[], text: string, pad = 400): Array<{ start: number; end: number }> {
  const ranges = hits
    .map((h) => ({ start: Math.max(0, h.start - pad), end: Math.min(text.length, h.end + pad) }))
    .sort((x, y) => x.start - y.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rough token estimate for budgeting (4 chars/token). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

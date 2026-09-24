/**
 * RFC 4180 CSV: a header row, CRLF line breaks, and a field quoted (with every quote doubled) when it holds a comma, a
 * quote, CR or LF, or starts or ends with a space. null and undefined are empty fields; numbers and booleans are
 * written as they print. Used by GET /v1/shadow/export and scripts/venue-report.ts. Pure.
 *
 * Formula injection (OWASP "CSV Injection"): a spreadsheet evaluates a cell that starts with = + - @ (also after leading
 * spaces, or in their full-width forms), or with a tab, CR or LF, as a formula, and quoting does not stop it. Such a
 * string cell is written with a leading apostrophe, inside quotes, so it reads as text: "'=1+1". Platform data reaches
 * these files (Limitless slugs, custom external ids), so every string is checked. Number-typed values are never
 * prefixed: lead_seconds -120 stays a number.
 */
export type CsvValue = string | number | boolean | null | undefined;

/** A string a spreadsheet would read as a formula. */
export const FORMULA_START = /^(?:[\t\r\n]|[\s\u3000]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/u;

export function csvField(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" && FORMULA_START.test(v)) return `"'${v.replace(/"/g, '""')}"`;
  const s = String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header row plus one line per row, each ending in CRLF (the last line too, as RFC 4180 allows). */
export function toCsv<K extends string>(columns: readonly K[], rows: ReadonlyArray<Partial<Record<K, CsvValue>>>): string {
  const line = (cells: CsvValue[]) => cells.map(csvField).join(",") + "\r\n";
  return line([...columns]) + rows.map((r) => line(columns.map((c) => r[c]))).join("");
}

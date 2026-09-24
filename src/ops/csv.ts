/**
 * RFC 4180 CSV: a header row, CRLF line breaks, and a field quoted (with every quote doubled) when it holds a comma, a
 * quote, CR or LF, or starts or ends with a space. null and undefined are empty fields; numbers and booleans are
 * written as they print. Used by GET /v1/shadow/export and scripts/venue-report.ts. Pure.
 */
export type CsvValue = string | number | boolean | null | undefined;

export function csvField(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header row plus one line per row, each ending in CRLF (the last line too, as RFC 4180 allows). */
export function toCsv<K extends string>(columns: readonly K[], rows: ReadonlyArray<Partial<Record<K, CsvValue>>>): string {
  const line = (cells: CsvValue[]) => cells.map(csvField).join(",") + "\r\n";
  return line([...columns]) + rows.map((r) => line(columns.map((c) => r[c]))).join("");
}

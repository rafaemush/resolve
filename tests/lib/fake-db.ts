/**
 * In-memory stand-in for the PostgREST query shapes the commit/reconcile code uses: select (eq on a column or an
 * embedded "a.b" path, in, lte, is null, order, limit, single, maybeSingle, head count), insert (+ select().single()),
 * upsert with onConflict/ignoreDuplicates, update. Unique columns answer 23505 like Postgres. Every executed query is
 * one entry in `calls`, so a test can count subrequests. Triggers are not emulated: scripts/selftest-db.ts proves
 * those against real Postgres.
 */
type Row = Record<string, any>;
type Filter = (r: Row) => boolean;

export interface FakeDb {
  tables: Record<string, Row[]>;
  calls: Array<{ table: string; action: string }>;
  client: { from: (table: string) => Query };
}

const path = (r: Row, col: string): unknown => col.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), r);
let seq = 0;

class Query implements PromiseLike<{ data: any; error: any; count?: number | null }> {
  private action: "select" | "insert" | "upsert" | "update" = "select";
  private payload: Row[] = [];
  private patch: Row = {};
  private filters: Filter[] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private head = false;
  private count = false;
  private returning = false;
  private conflict: { col: string; ignore: boolean } | null = null;

  constructor(private db: FakeDb, private table: string, private unique: Record<string, string[]>) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.action === "select") { this.head = !!opts?.head; this.count = !!opts?.count; } else this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]) { this.action = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows: Row | Row[], opts: { onConflict: string; ignoreDuplicates?: boolean }) { this.action = "upsert"; this.payload = Array.isArray(rows) ? rows : [rows]; this.conflict = { col: opts.onConflict, ignore: !!opts.ignoreDuplicates }; return this; }
  update(patch: Row) { this.action = "update"; this.patch = patch; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => path(r, col) === v); return this; }
  in(col: string, vs: unknown[]) { this.filters.push((r) => vs.includes(path(r, col))); return this; }
  lte(col: string, v: string) { this.filters.push((r) => String(path(r, col)) <= v); return this; }
  is(col: string, v: null) { this.filters.push((r) => (path(r, col) ?? null) === v); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderBy = { col, asc: opts?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  single() { return Promise.resolve(this.exec(true)); }
  maybeSingle() { return Promise.resolve(this.exec(true)); }
  then<A, B>(ok?: ((v: { data: any; error: any; count?: number | null }) => A | PromiseLike<A>) | null, no?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.exec(false)).then(ok, no);
  }

  private rows(): Row[] { return (this.db.tables[this.table] ??= []); }
  private conflictOn(row: Row, cols: string[]): string | null {
    for (const c of cols) if (row[c] != null && this.rows().some((r) => r[c] === row[c])) return c;
    return null;
  }

  private exec(one: boolean): { data: any; error: any; count?: number | null } {
    this.db.calls.push({ table: this.table, action: this.action });
    const uniq = this.unique[this.table] ?? [];
    if (this.action === "insert" || this.action === "upsert") {
      const inserted: Row[] = [];
      for (const p of this.payload) {
        if (this.conflict && this.rows().some((r) => r[this.conflict!.col] === p[this.conflict!.col])) {
          if (this.conflict.ignore) continue;
          return { data: null, error: { code: "42P10", message: "fake: upsert update path not emulated" } };
        }
        const c = this.conflictOn(p, uniq);
        if (c) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint (${c})` } };
        const row = { id: `${this.table}-${++seq}`, created_at: new Date().toISOString(), ...structuredClone(p) };
        this.rows().push(row);
        inserted.push(row);
      }
      if (!this.returning) return { data: null, error: null };
      return { data: one ? structuredClone(inserted[0] ?? null) : structuredClone(inserted), error: null };
    }
    const matched = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.action === "update") { for (const r of matched) Object.assign(r, structuredClone(this.patch)); return { data: null, error: null }; }
    if (this.head) return { data: null, error: null, count: matched.length };
    let out = [...matched];
    if (this.orderBy) { const { col, asc } = this.orderBy; out.sort((a, b) => (String(path(a, col)) < String(path(b, col)) ? -1 : String(path(a, col)) > String(path(b, col)) ? 1 : 0) * (asc ? 1 : -1)); }
    if (this.max !== null) out = out.slice(0, this.max);
    return { data: one ? structuredClone(out[0] ?? null) : structuredClone(out), error: null, ...(this.count ? { count: matched.length } : {}) };
  }
}

export function fakeDb(tables: Record<string, Row[]> = {}, unique: Record<string, string[]> = {}): FakeDb {
  const db: FakeDb = { tables, calls: [], client: { from: (t: string) => new Query(db, t, unique) } };
  return db;
}

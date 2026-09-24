/**
 * In-memory stand-in for the PostgREST query shapes the commit/reconcile code uses: select (eq on a column or an
 * embedded "a.b" path, in, lt, lte, gte, is null, order, limit, single, maybeSingle, head count), insert (+ select().single()),
 * upsert (on onConflict, else the table's primary key: FakeDbOptions.primaryKey, default "id"; ignoreDuplicates skips,
 * otherwise the row is merged like ON CONFLICT DO UPDATE), update (+ select() returns the updated rows), and rpc()
 * through test-supplied stand-ins. Unique columns and partial
 * unique indexes (e.g. uq_reconciliations_final) answer 23505 like Postgres; an ON CONFLICT target covers only its own
 * column, exactly as in Postgres. Every executed query or rpc is one entry in `calls`, so a test can count
 * subrequests; the queries an rpc stand-in runs internally are not. Triggers are not emulated: scripts/selftest-db.ts
 * proves those against real Postgres.
 */
export type Row = Record<string, any>;
type Filter = (r: Row) => boolean;

/** At most one row per value of `col` among the rows matching `where` (CREATE UNIQUE INDEX ... (col) WHERE ...). */
export interface PartialUnique { name: string; col: string; where: (r: Row) => boolean }
export type RpcStandIn = (db: FakeDb, args: Record<string, any>) => Promise<{ data: any; error: any }>;
export interface FakeDbOptions { partialUnique?: Record<string, PartialUnique[]>; rpc?: Record<string, RpcStandIn>; primaryKey?: Record<string, string> }

export interface FakeDb {
  tables: Record<string, Row[]>;
  calls: Array<{ table: string; action: string }>;
  client: { from: (table: string) => Query; rpc: (fn: string, args: Record<string, any>) => Promise<{ data: any; error: any }> };
  options: FakeDbOptions;
  /** true while an rpc stand-in runs: its internal queries are part of one subrequest. */
  inRpc: boolean;
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
  upsert(rows: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.action = "upsert"; this.payload = Array.isArray(rows) ? rows : [rows];
    this.conflict = { col: opts.onConflict ?? this.db.options.primaryKey?.[this.table] ?? "id", ignore: !!opts.ignoreDuplicates };
    return this;
  }
  update(patch: Row) { this.action = "update"; this.patch = patch; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => path(r, col) === v); return this; }
  in(col: string, vs: unknown[]) { this.filters.push((r) => vs.includes(path(r, col))); return this; }
  lt(col: string, v: string) { this.filters.push((r) => path(r, col) != null && String(path(r, col)) < v); return this; }
  lte(col: string, v: string) { this.filters.push((r) => String(path(r, col)) <= v); return this; }
  gte(col: string, v: string) { this.filters.push((r) => String(path(r, col)) >= v); return this; }
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
  /** The partial unique index `candidate` would violate, ignoring the row it replaces (an update). */
  private partialConflict(candidate: Row, self: Row | null): string | null {
    for (const u of this.db.options.partialUnique?.[this.table] ?? []) {
      if (!u.where(candidate)) continue;
      if (this.rows().some((r) => r !== self && u.where(r) && r[u.col] === candidate[u.col])) return u.name;
    }
    return null;
  }

  private exec(one: boolean): { data: any; error: any; count?: number | null } {
    if (!this.db.inRpc) this.db.calls.push({ table: this.table, action: this.action });
    const uniq = this.unique[this.table] ?? [];
    const dup = (c: string) => ({ data: null, error: { code: "23505", message: `duplicate key value violates unique constraint (${c})` } });
    if (this.action === "insert" || this.action === "upsert") {
      const inserted: Row[] = [];
      for (const p of this.payload) {
        // NULL never conflicts, as in Postgres.
        const existing = this.conflict && p[this.conflict.col] != null ? this.rows().find((r) => r[this.conflict!.col] === p[this.conflict!.col]) : undefined;
        if (existing) {
          if (this.conflict!.ignore) continue;
          Object.assign(existing, structuredClone(p));
          inserted.push(existing);
          continue;
        }
        const c = this.conflictOn(p, uniq) ?? this.partialConflict(p, null);
        if (c) return dup(c);
        const row = { id: `${this.table}-${++seq}`, created_at: new Date().toISOString(), ...structuredClone(p) };
        this.rows().push(row);
        inserted.push(row);
      }
      if (!this.returning) return { data: null, error: null };
      return { data: one ? structuredClone(inserted[0] ?? null) : structuredClone(inserted), error: null };
    }
    const matched = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.action === "update") {
      for (const r of matched) { const c = this.partialConflict({ ...r, ...this.patch }, r); if (c) return dup(c); }
      for (const r of matched) Object.assign(r, structuredClone(this.patch));
      return { data: this.returning ? structuredClone(matched) : null, error: null };
    }
    if (this.head) return { data: null, error: null, count: matched.length };
    let out = [...matched];
    if (this.orderBy) { const { col, asc } = this.orderBy; out.sort((a, b) => (String(path(a, col)) < String(path(b, col)) ? -1 : String(path(a, col)) > String(path(b, col)) ? 1 : 0) * (asc ? 1 : -1)); }
    if (this.max !== null) out = out.slice(0, this.max);
    return { data: one ? structuredClone(out[0] ?? null) : structuredClone(out), error: null, ...(this.count ? { count: matched.length } : {}) };
  }
}

export function fakeDb(tables: Record<string, Row[]> = {}, unique: Record<string, string[]> = {}, options: FakeDbOptions = {}): FakeDb {
  const db: FakeDb = {
    tables, calls: [], options, inRpc: false,
    client: {
      from: (t: string) => new Query(db, t, unique),
      // One subrequest, one transaction: the stand-in's writes are rolled back when it answers an error.
      rpc: async (fn: string, args: Record<string, any>) => {
        db.calls.push({ table: `rpc:${fn}`, action: "rpc" });
        const impl = options.rpc?.[fn];
        if (!impl) return { data: null, error: { code: "PGRST202", message: `fake: no stand-in for rpc ${fn}` } };
        const snapshot = structuredClone(db.tables);
        db.inRpc = true;
        try {
          const r = await impl(db, structuredClone(args));
          if (r.error) { for (const k of Object.keys(db.tables)) delete db.tables[k]; Object.assign(db.tables, snapshot); }
          return r;
        } finally { db.inRpc = false; }
      },
    },
  };
  return db;
}

// In-memory fake SupabaseClient covering the query shapes used by
// src/supabase/*.ts. There is no real Supabase project to test against in
// this build, so the direct-from-app Supabase paths are tested against this
// fake instead. It is intentionally narrow — not a general PostgREST
// emulator, and it does NOT emulate RLS: firm-isolation tests seed rows in
// two firms and check the repo's own org_id filters (see `queries`).

export interface FakeTableRow {
  [key: string]: unknown;
}

export interface FakeFilter {
  col: string;
  op: 'eq' | 'neq' | 'in' | 'is' | 'not.is' | 'ilike' | 'gt' | 'gte' | 'lt' | 'lte';
  val: unknown;
}

export interface FakeQueryLog {
  table: string;
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  filters: FakeFilter[];
  payload?: unknown;
}

export interface FakeError {
  code?: string;
  message: string;
}

type Op = FakeQueryLog['op'];

export class FakeSupabaseDb {
  tables = new Map<string, FakeTableRow[]>();
  storageObjects = new Map<string, Buffer>(); // key: `${bucket}/${path}`
  /** Every executed query, for asserting e.g. that each firm-table query filtered by org_id. */
  queries: FakeQueryLog[] = [];
  /** Unique column sets per table (null values never conflict, like a partial unique index). */
  uniques = new Map<string, string[][]>();
  private failures: { table: string; op?: Op; error: FakeError }[] = [];
  /** Realtime channels opened through the fake client. */
  channels: FakeChannel[] = [];

  table(name: string): FakeTableRow[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  /** Make every subsequent query on `table` (optionally only of kind `op`) return `error`. */
  failWith(table: string, error: FakeError, op?: Op): void {
    this.failures.push({ table, op, error });
  }

  clearFailures(): void {
    this.failures = [];
  }

  failureFor(table: string, op: Op): FakeError | null {
    return this.failures.find((f) => f.table === table && (!f.op || f.op === op))?.error ?? null;
  }
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, '0')}`;
}

function likeToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function matches(row: FakeTableRow, f: FakeFilter): boolean {
  const v = row[f.col];
  switch (f.op) {
    case 'eq':
      return v !== null && v !== undefined && v === f.val;
    case 'neq':
      return v !== f.val;
    case 'in':
      return (f.val as unknown[]).includes(v);
    case 'is':
      return f.val === null ? v === null || v === undefined : v === f.val;
    case 'not.is':
      return f.val === null ? v !== null && v !== undefined : v !== f.val;
    case 'ilike':
      return typeof v === 'string' && likeToRegex(String(f.val)).test(v);
    case 'gt':
      return (v as string) > (f.val as string);
    case 'gte':
      return (v as string) >= (f.val as string);
    case 'lt':
      return (v as string) < (f.val as string);
    case 'lte':
      return (v as string) <= (f.val as string);
  }
}

type Result = { data: unknown; error: FakeError | null; count?: number | null };

class FakeQueryBuilder implements PromiseLike<Result> {
  private op: Op = 'select';
  private payloadRows: FakeTableRow[] = [];
  private patch: FakeTableRow = {};
  private filters: FakeFilter[] = [];
  private orderBys: { col: string; ascending: boolean }[] = [];
  private limitN: number | null = null;
  private returning = false;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  private head = false;
  private countRequested = false;
  private conflictCols: string[] = ['jid'];
  private ignoreDuplicates = false;
  private insertedSingle = false;

  constructor(
    private db: FakeSupabaseDb,
    private tableName: string,
  ) {}

  select(_cols = '*', opts?: { count?: 'exact'; head?: boolean }) {
    if (this.op === 'select') {
      this.head = Boolean(opts?.head);
      this.countRequested = Boolean(opts?.count);
    } else {
      this.returning = true;
    }
    return this;
  }

  insert(payload: FakeTableRow | FakeTableRow[]) {
    this.op = 'insert';
    this.insertedSingle = !Array.isArray(payload);
    this.payloadRows = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  upsert(payload: FakeTableRow | FakeTableRow[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = 'upsert';
    if (opts?.onConflict) this.conflictCols = opts.onConflict.split(',').map((c) => c.trim());
    this.ignoreDuplicates = Boolean(opts?.ignoreDuplicates);
    this.payloadRows = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(patch: FakeTableRow) {
    this.op = 'update';
    this.patch = patch;
    return this;
  }

  delete() {
    this.op = 'delete';
    return this;
  }

  eq(col: string, val: unknown) {
    return this.filter(col, 'eq', val);
  }
  neq(col: string, val: unknown) {
    return this.filter(col, 'neq', val);
  }
  in(col: string, val: unknown[]) {
    return this.filter(col, 'in', val);
  }
  is(col: string, val: unknown) {
    return this.filter(col, 'is', val);
  }
  not(col: string, operator: string, val: unknown) {
    if (operator !== 'is') throw new Error(`fakeSupabase: not(${operator}) unsupported`);
    return this.filter(col, 'not.is', val);
  }
  ilike(col: string, val: string) {
    return this.filter(col, 'ilike', val);
  }
  gt(col: string, val: unknown) {
    return this.filter(col, 'gt', val);
  }
  gte(col: string, val: unknown) {
    return this.filter(col, 'gte', val);
  }
  lt(col: string, val: unknown) {
    return this.filter(col, 'lt', val);
  }
  lte(col: string, val: unknown) {
    return this.filter(col, 'lte', val);
  }

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orderBys.push({ col, ascending: opts?.ascending ?? true });
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  single() {
    this.mode = 'single';
    return this;
  }

  maybeSingle() {
    this.mode = 'maybe';
    return this;
  }

  then<T1 = Result, T2 = never>(resolve?: ((v: Result) => T1 | PromiseLike<T1>) | null, reject?: ((e: unknown) => T2 | PromiseLike<T2>) | null): PromiseLike<T1 | T2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(resolve, reject);
  }

  private filter(col: string, op: FakeFilter['op'], val: unknown) {
    this.filters.push({ col, op, val });
    return this;
  }

  private execute(): Result {
    this.db.queries.push({ table: this.tableName, op: this.op, filters: [...this.filters], payload: this.op === 'update' ? this.patch : this.op === 'select' || this.op === 'delete' ? undefined : this.payloadRows });
    const failure = this.db.failureFor(this.tableName, this.op);
    if (failure) return { data: null, error: failure };

    const table = this.db.table(this.tableName);
    let affected: FakeTableRow[] = [];

    if (this.op === 'insert' || this.op === 'upsert') {
      const staged: FakeTableRow[] = [];
      for (const p of this.payloadRows) {
        const row: FakeTableRow = { ...p };
        if (this.op === 'upsert') {
          const idx = table.findIndex((r) => this.conflictCols.every((c) => r[c] === row[c]));
          if (idx >= 0) {
            if (!this.ignoreDuplicates) {
              table[idx] = { ...table[idx], ...row };
              affected.push(table[idx]);
            }
            continue;
          }
        }
        if (row.id === undefined) row.id = newId();
        const conflict = this.uniqueConflict([...table, ...staged], row);
        if (conflict) return { data: null, error: conflict };
        staged.push(row);
      }
      table.push(...staged);
      affected.push(...staged);
    } else {
      const hit = table.filter((r) => this.filters.every((f) => matches(r, f)));
      if (this.op === 'update') {
        for (const r of hit) {
          const next = { ...r, ...this.patch };
          const conflict = this.uniqueConflict(
            table.filter((o) => o !== r),
            next,
          );
          if (conflict) return { data: null, error: conflict };
        }
        for (const r of hit) Object.assign(r, this.patch);
        affected = hit;
      } else if (this.op === 'delete') {
        this.db.tables.set(
          this.tableName,
          table.filter((r) => !hit.includes(r)),
        );
        affected = hit;
      } else {
        affected = hit;
      }
    }

    if (this.op !== 'select' && !this.returning) return { data: null, error: null };

    let rows = [...affected];
    for (const o of [...this.orderBys].reverse()) {
      rows.sort((a, b) => {
        const av = a[o.col] as string | number | null;
        const bv = b[o.col] as string | number | null;
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp = av < bv ? -1 : 1;
        return o.ascending ? cmp : -cmp;
      });
    }
    const count = rows.length;
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    const copies = rows.map((r) => ({ ...r }));

    if (this.head) return { data: null, error: null, count };
    if (this.mode === 'single') {
      if (copies.length !== 1) return { data: null, error: { code: 'PGRST116', message: `expected 1 row, got ${copies.length}` } };
      return { data: copies[0], error: null };
    }
    if (this.mode === 'maybe') {
      if (copies.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
      return { data: copies[0] ?? null, error: null };
    }
    void this.insertedSingle;
    return { data: copies, error: null, count: this.countRequested ? count : null };
  }

  private uniqueConflict(existing: FakeTableRow[], row: FakeTableRow): FakeError | null {
    for (const cols of this.db.uniques.get(this.tableName) ?? []) {
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      if (existing.some((r) => r !== row && cols.every((c) => r[c] === row[c]))) {
        return { code: '23505', message: `duplicate key value violates unique constraint (${cols.join(', ')})` };
      }
    }
    return null;
  }
}

class FakeStorageBucket {
  constructor(
    private db: FakeSupabaseDb,
    private bucket: string,
  ) {}

  async createSignedUrl(path: string, ttlSeconds: number) {
    const key = `${this.bucket}/${path}`;
    if (!this.db.storageObjects.has(key)) {
      return { data: null, error: new Error('Object not found') };
    }
    return { data: { signedUrl: `https://fake.local/${key}?ttl=${ttlSeconds}` }, error: null };
  }
}

export class FakeChannel {
  handlers: { filter: Record<string, unknown>; cb: (payload: { eventType: string; new: FakeTableRow; old: FakeTableRow }) => void }[] = [];
  subscribed = false;
  removed = false;

  constructor(readonly name: string) {}

  on(_type: string, filter: Record<string, unknown>, cb: (payload: { eventType: string; new: FakeTableRow; old: FakeTableRow }) => void) {
    this.handlers.push({ filter, cb });
    return this;
  }

  subscribe(cb?: (status: string) => void) {
    this.subscribed = true;
    cb?.('SUBSCRIBED');
    return this;
  }

  /** Test helper: deliver a postgres_changes event to this channel's handlers. */
  emit(eventType: 'INSERT' | 'UPDATE' | 'DELETE', row: FakeTableRow, old: FakeTableRow = {}) {
    for (const h of this.handlers) h.cb({ eventType, new: row, old });
  }
}

export function createFakeSupabaseClient(db = new FakeSupabaseDb()) {
  return {
    __db: db,
    from(tableName: string) {
      return new FakeQueryBuilder(db, tableName);
    },
    storage: {
      from(bucket: string) {
        return new FakeStorageBucket(db, bucket);
      },
    },
    channel(name: string) {
      const ch = new FakeChannel(name);
      db.channels.push(ch);
      return ch;
    },
    removeChannel(ch: FakeChannel) {
      ch.removed = true;
      return Promise.resolve('ok');
    },
  };
}

import { randomUUID } from 'crypto';
import type { DbResult, QueryBuilder, StorageFileApi, SupabaseLike } from '../../src/db/types';

/**
 * A strict, in-memory stand-in for @supabase/supabase-js used by every test
 * in this suite (there is no live Supabase project available in this
 * environment — see core-server/README.md for exactly what a real project
 * needs before these guarantees are verified against real Postgres RLS and
 * Storage policies).
 *
 * This is NOT a "returns whatever you ask for" mock. It enforces the
 * policies declared in supabase/migrations/*.sql, including the firm
 * tenancy migration (crmex.md §15.4):
 *  - firm tables (message_history / image_sessions / contact_meta): members
 *    of row.org_id may read; client inserts must be in one of the caller's
 *    firms AND attributed to the caller; contact_meta updates likewise;
 *    image_sessions has no client write policy at all
 *  - organizations / org_members: members read; no client writes
 *  - org_invitations / org_audit_log: owners/admins read; no client writes
 *  - RLS-enabled-with-no-policies (default deny for non-service roles) on
 *    app_settings / admin_audit_log / usage_daily / org_usage_daily
 *  - Storage `user-images`: read (download / sign / list) only when the
 *    first folder is a firm the caller belongs to; writes service-only
 *  - Unique constraints that application code relies on for races
 *    (org_members PK, org_usage_daily PK, org_invitations.token_hash) —
 *    violations return Postgres code 23505
 *  - JWT verification via auth.getUser (project/expiry checks)
 *
 * A client created in 'service' mode bypasses every RLS/Storage policy
 * above (constraints still apply), the same way the real service role key
 * does — that's what makes the repository-layer scoping tests meaningful:
 * this fake will happily let a bug in application code read cross-firm
 * data in service mode, exactly like the real thing would.
 */

// ---------------------------------------------------------------------------
// Fake auth tokens
// ---------------------------------------------------------------------------

export const FAKE_PROJECT_ID = 'fake-test-project';

export interface FakeTokenOptions {
  sub: string;
  /** app_metadata.role — the ONLY role source the auth middleware may honor. */
  appRole?: 'user' | 'admin';
  /** user_metadata.role — must NEVER grant privilege (ROLE-02). */
  userRole?: string;
  /** Auth user email; defaults to `<sub>@example.test`. Pass null for no email. */
  email?: string | null;
  /** Whether Supabase Auth reports the email as confirmed; defaults to true. */
  emailVerified?: boolean;
  /** user_metadata.full_name (display only). */
  fullName?: string;
  project?: string;
  /** epoch seconds; defaults to one hour from now. */
  exp?: number;
}

export function makeFakeToken(opts: FakeTokenOptions): string {
  const payload = {
    sub: opts.sub,
    appRole: opts.appRole ?? 'user',
    userRole: opts.userRole,
    email: opts.email === undefined ? `${opts.sub.toLowerCase()}@example.test` : opts.email,
    emailVerified: opts.emailVerified ?? true,
    fullName: opts.fullName,
    project: opts.project ?? FAKE_PROJECT_ID,
    exp: opts.exp ?? Math.floor(Date.now() / 1000) + 3600,
  };
  return `fake.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

export function makeExpiredToken(sub: string): string {
  // exp=1 (1970-01-01T00:00:01Z) is expired relative to any clock a test
  // could plausibly use — real wall time or a fixed fake clock — avoiding
  // any dependency on how far "now" the test's FakeDb clock is set to.
  return makeFakeToken({ sub, exp: 1 });
}

export function makeWrongProjectToken(sub: string): string {
  return makeFakeToken({ sub, project: 'a-different-project' });
}

export const MALFORMED_TOKEN = 'this-is-not-a-valid-token';

// ---------------------------------------------------------------------------
// In-memory database + storage
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

/** Firm-owned data tables (org_id not null, members read). */
const FIRM_DATA_TABLES = new Set(['message_history', 'image_sessions', 'contact_meta']);
/** Tenancy tables readable by members of the row's firm. `organizations` keys the firm by `id`. */
const MEMBER_READ_TABLES: Record<string, string> = { organizations: 'id', org_members: 'org_id' };
/** Tenancy tables readable by the firm's owners/admins only. */
const MANAGER_READ_TABLES = new Set(['org_invitations', 'org_audit_log']);
const DENY_ALL_TABLES = new Set(['app_settings', 'admin_audit_log', 'usage_daily', 'org_usage_daily']);
/** Tables carrying the guard_org_id trigger (org_id immutable after insert, even for the service role). */
const ORG_ID_GUARDED_TABLES = new Set([...FIRM_DATA_TABLES]);

type IdKind = 'serial' | 'uuid' | 'none';

const TABLE_META: Record<string, { id: IdKind; hasCreatedAt: boolean; hasUpdatedAt: boolean; unique?: string[][]; defaults?: Row }> = {
  message_history: { id: 'serial', hasCreatedAt: true, hasUpdatedAt: false },
  image_sessions: { id: 'serial', hasCreatedAt: true, hasUpdatedAt: true },
  contact_meta: { id: 'serial', hasCreatedAt: false, hasUpdatedAt: false, unique: [['org_id', 'jid']] },
  usage_daily: { id: 'none', hasCreatedAt: false, hasUpdatedAt: false, unique: [['user_id', 'day']] },
  app_settings: { id: 'none', hasCreatedAt: false, hasUpdatedAt: false, unique: [['key']] },
  admin_audit_log: { id: 'serial', hasCreatedAt: true, hasUpdatedAt: false },
  organizations: { id: 'uuid', hasCreatedAt: true, hasUpdatedAt: false, defaults: { plan: 'free' } },
  org_members: { id: 'none', hasCreatedAt: true, hasUpdatedAt: false, unique: [['org_id', 'user_id']] },
  org_invitations: {
    id: 'uuid',
    hasCreatedAt: true,
    hasUpdatedAt: false,
    unique: [['token_hash']],
    defaults: { accepted_at: null, accepted_by: null, revoked_at: null },
  },
  org_audit_log: { id: 'serial', hasCreatedAt: true, hasUpdatedAt: false },
  org_usage_daily: {
    id: 'none',
    hasCreatedAt: false,
    hasUpdatedAt: false,
    unique: [['org_id', 'day']],
    defaults: { images_generated: 0, messages_drafted: 0, messages_sent: 0, storage_bytes: 0 },
  },
};

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

export type FilterOp = 'eq' | 'is' | 'gt' | 'in';

export interface CallLogEntry {
  table: string;
  op: string;
  /** `eq` filters are logged as { column, value }; other operators also carry `op`. */
  filters: Array<{ column: string; value: unknown; op?: Exclude<FilterOp, 'eq'> }>;
}

export class FakeDb {
  tables: Record<string, Row[]> = Object.fromEntries(Object.keys(TABLE_META).map((t) => [t, [] as Row[]]));
  storage = new Map<string, StoredObject>();
  signedUrls = new Map<string, { path: string; expiresAt: number }>();
  callLog: CallLogEntry[] = [];
  projectId = FAKE_PROJECT_ID;

  private nextIds: Record<string, number> = {};
  private clockFn: () => number = () => Date.now();

  now(): number {
    return this.clockFn();
  }

  setClock(fn: () => number): void {
    this.clockFn = fn;
  }

  nextId(table: string): number {
    const current = this.nextIds[table] ?? 0;
    this.nextIds[table] = current + 1;
    return current + 1;
  }

  /** Fills id / timestamps / column defaults the way Postgres would. */
  applyDefaults(table: string, row: Row): Row {
    const meta = TABLE_META[table];
    const full = { ...(meta?.defaults ?? {}), ...row };
    if (meta?.id === 'serial' && full.id === undefined) full.id = this.nextId(table);
    if (meta?.id === 'uuid' && full.id === undefined) full.id = randomUUID();
    if (meta?.hasCreatedAt && full.created_at === undefined) full.created_at = new Date(this.now()).toISOString();
    if (meta?.hasUpdatedAt && full.updated_at === undefined) full.updated_at = new Date(this.now()).toISOString();
    return full;
  }

  /** Returns the violated unique key's columns, or null. `ignore` is the row being updated. */
  uniqueViolation(table: string, row: Row, ignore?: Row): string[] | null {
    for (const cols of TABLE_META[table]?.unique ?? []) {
      if (cols.some((c) => row[c] === undefined || row[c] === null)) continue;
      if (this.tables[table].some((r) => r !== ignore && cols.every((c) => r[c] === row[c]))) return cols;
    }
    return null;
  }

  /** Test convenience: insert a row directly, bypassing RLS (as the service role would). */
  seed(table: string, row: Row): Row {
    const full = this.applyDefaults(table, row);
    this.tables[table].push(full);
    return clone(full);
  }

  seedObject(path: string, bytes: Buffer, contentType = 'image/png'): void {
    this.storage.set(path, { bytes, contentType });
  }

  isMember(orgId: unknown, userId: string | undefined): boolean {
    return !!userId && this.tables.org_members.some((m) => m.org_id === orgId && m.user_id === userId);
  }

  hasRole(orgId: unknown, userId: string | undefined, roles: string[]): boolean {
    return !!userId && this.tables.org_members.some((m) => m.org_id === orgId && m.user_id === userId && roles.includes(m.role));
  }
}

export type ClientMode = 'service' | 'user' | 'anon';

interface ClientContext {
  db: FakeDb;
  mode: ClientMode;
  userId?: string;
}

interface Filter {
  column: string;
  op: FilterOp;
  value: unknown;
}

interface QueryRequest {
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
  filters: Filter[];
  insertRows?: Row[];
  updatePatch?: Row;
  upsertConflict?: string;
}

function matchesFilter(row: Row, f: Filter): boolean {
  const actual = row[f.column];
  switch (f.op) {
    case 'eq':
      return actual === f.value;
    case 'is':
      return f.value === null ? actual === null || actual === undefined : actual === f.value;
    case 'gt':
      if (actual === null || actual === undefined) return false;
      if (typeof actual === 'string' && typeof f.value === 'string' && !Number.isNaN(Date.parse(actual)) && !Number.isNaN(Date.parse(f.value))) {
        return Date.parse(actual) > Date.parse(f.value);
      }
      return (actual as number) > (f.value as number);
    case 'in':
      return (f.value as unknown[]).includes(actual);
  }
}

const RLS_DENIED = { message: 'new row violates row-level security policy', code: '42501' };

function executeQuery(ctx: ClientContext, table: string, req: QueryRequest): DbResult<Row[]> {
  const rows = ctx.db.tables[table];
  if (!rows) return { data: null, error: { message: `unknown table "${table}"` } };

  ctx.db.callLog.push({
    table,
    op: req.op,
    filters: req.filters.map((f) => (f.op === 'eq' ? { column: f.column, value: f.value } : { column: f.column, value: f.value, op: f.op })),
  });

  const service = ctx.mode === 'service';
  const uid = ctx.mode === 'user' ? ctx.userId : undefined;

  function canRead(row: Row): boolean {
    if (service) return true;
    if (DENY_ALL_TABLES.has(table)) return false;
    if (FIRM_DATA_TABLES.has(table)) return ctx.db.isMember(row.org_id, uid);
    if (table in MEMBER_READ_TABLES) return ctx.db.isMember(row[MEMBER_READ_TABLES[table]], uid);
    if (MANAGER_READ_TABLES.has(table)) return ctx.db.hasRole(row.org_id, uid, ['owner', 'admin']);
    return false; // unknown to the policy model => deny
  }

  /** Insert WITH CHECK. Tables without an insert policy deny every client insert. */
  function canInsert(row: Row): boolean {
    if (service) return true;
    if (table === 'message_history' || table === 'contact_meta') return ctx.db.isMember(row.org_id, uid) && row.user_id === uid;
    return false;
  }

  /** Update USING (visible) + WITH CHECK (patched). Only contact_meta has an update policy. */
  function canUpdate(before: Row, after: Row): boolean {
    if (service) return true;
    if (table !== 'contact_meta') return false;
    return ctx.db.isMember(before.org_id, uid) && ctx.db.isMember(after.org_id, uid) && after.user_id === uid;
  }

  const filtered = () => req.filters.reduce((acc, f) => acc.filter((r) => matchesFilter(r, f)), rows.filter(canRead));

  switch (req.op) {
    case 'select':
      return { data: filtered().map(clone), error: null };

    case 'insert':
    case 'upsert': {
      const inserted: Row[] = [];
      for (const raw of req.insertRows ?? []) {
        const row: Row = { ...raw };

        if (req.op === 'upsert' && req.upsertConflict) {
          const conflictCols = req.upsertConflict.split(',').map((s) => s.trim());
          const existing = rows.find((r) => conflictCols.every((c) => r[c] === row[c]));
          if (existing) {
            if (!canUpdate(existing, { ...existing, ...row })) return { data: null, error: RLS_DENIED };
            Object.assign(existing, row);
            inserted.push(clone(existing));
            continue;
          }
        }

        if (!canInsert(row)) {
          return {
            data: null,
            error: DENY_ALL_TABLES.has(table) ? { message: 'permission denied for table (RLS enabled, no policy)', code: '42501' } : RLS_DENIED,
          };
        }
        const full = ctx.db.applyDefaults(table, row);
        const violated = ctx.db.uniqueViolation(table, full);
        if (violated) {
          return { data: null, error: { message: `duplicate key value violates unique constraint (${violated.join(', ')})`, code: '23505' } };
        }
        rows.push(full);
        inserted.push(clone(full));
      }
      return { data: inserted, error: null };
    }

    case 'update': {
      const updated: Row[] = [];
      for (const row of filtered()) {
        const patched = { ...row, ...req.updatePatch };
        // guard_org_id trigger: org_id is immutable on firm tables, for every role including service.
        if (ORG_ID_GUARDED_TABLES.has(table) && patched.org_id !== row.org_id) {
          return { data: null, error: { message: 'org_id is immutable', code: '42501' } };
        }
        if (!canUpdate(row, patched)) continue; // no policy / with-check fails => row silently not updated
        if (ctx.db.uniqueViolation(table, patched, row)) {
          return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
        }
        Object.assign(row, req.updatePatch);
        updated.push(clone(row));
      }
      return { data: updated, error: null };
    }

    case 'delete': {
      // No table has a client delete policy in the current migrations.
      if (!service) return { data: [], error: null };
      const deleted: Row[] = [];
      for (const row of filtered()) {
        const idx = rows.indexOf(row);
        if (idx !== -1) {
          rows.splice(idx, 1);
          deleted.push(clone(row));
        }
      }
      return { data: deleted, error: null };
    }

    default:
      return { data: null, error: { message: `unsupported op` } };
  }
}

/**
 * Every query resolves on a later macrotask, like a network round trip.
 * Without this, a whole request handler would run inside one microtask
 * burst and concurrent HTTP requests in a test would never interleave
 * between a read and a conditional write — race tests would pass vacuously.
 */
function roundTrip(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeQueryBuilder implements QueryBuilder {
  private filters: Filter[] = [];
  private op: QueryRequest['op'] = 'select';
  private insertRows?: Row[];
  private updatePatch?: Row;
  private upsertConflict?: string;

  constructor(
    private ctx: ClientContext,
    private table: string,
  ) {}

  select(_columns?: string): QueryBuilder {
    return this;
  }
  insert(row: Row | Row[]): QueryBuilder {
    this.op = 'insert';
    this.insertRows = Array.isArray(row) ? row : [row];
    return this;
  }
  update(patch: Row): QueryBuilder {
    this.op = 'update';
    this.updatePatch = patch;
    return this;
  }
  delete(): QueryBuilder {
    this.op = 'delete';
    return this;
  }
  upsert(row: Row, opts?: { onConflict?: string }): QueryBuilder {
    this.op = 'upsert';
    this.insertRows = [row];
    this.upsertConflict = opts?.onConflict;
    return this;
  }
  eq(column: string, value: unknown): QueryBuilder {
    this.filters.push({ column, op: 'eq', value });
    return this;
  }
  is(column: string, value: null | boolean): QueryBuilder {
    this.filters.push({ column, op: 'is', value });
    return this;
  }
  gt(column: string, value: unknown): QueryBuilder {
    this.filters.push({ column, op: 'gt', value });
    return this;
  }
  in(column: string, values: readonly unknown[]): QueryBuilder {
    this.filters.push({ column, op: 'in', value: [...values] });
    return this;
  }
  order(): QueryBuilder {
    return this;
  }
  limit(): QueryBuilder {
    return this;
  }

  private run(): DbResult<Row[]> {
    return executeQuery(this.ctx, this.table, {
      op: this.op,
      filters: this.filters,
      insertRows: this.insertRows,
      updatePatch: this.updatePatch,
      upsertConflict: this.upsertConflict,
    });
  }

  async single(): Promise<DbResult<Row>> {
    await roundTrip();
    const result = this.run();
    if (result.error) return { data: null, error: result.error };
    const rows = result.data ?? [];
    if (rows.length !== 1) return { data: null, error: { message: `Expected exactly one row, got ${rows.length}` } };
    return { data: rows[0], error: null };
  }

  async maybeSingle(): Promise<DbResult<Row>> {
    await roundTrip();
    const result = this.run();
    if (result.error) return { data: null, error: result.error };
    const rows = result.data ?? [];
    if (rows.length > 1) return { data: null, error: { message: `Expected at most one row, got ${rows.length}` } };
    return { data: rows[0] ?? null, error: null };
  }

  then<TResult1 = DbResult<Row[]>, TResult2 = never>(
    onfulfilled?: ((value: DbResult<Row[]>) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): PromiseLike<TResult1 | TResult2> {
    return roundTrip()
      .then(() => this.run())
      .then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

function createFakeStorageBucket(ctx: ClientContext, bucketId: string): StorageFileApi {
  const KNOWN_BUCKET = 'user-images';

  /** firm_images_read: first folder must be a firm the caller belongs to. */
  function readDenied(path: string): boolean {
    if (ctx.mode === 'service') return false;
    if (ctx.mode === 'anon') return true;
    const firstFolder = path.split('/')[0];
    return !ctx.db.isMember(firstFolder, ctx.userId);
  }

  /** No client insert/update/delete policies on storage.objects: writes are service-only. */
  function writeDenied(): boolean {
    return ctx.mode !== 'service';
  }

  return {
    async upload(path, bytes, opts) {
      if (bucketId !== KNOWN_BUCKET) return { data: null, error: { message: 'unknown bucket' } };
      if (writeDenied()) return { data: null, error: RLS_DENIED };
      ctx.db.storage.set(path, { bytes: Buffer.from(bytes), contentType: opts?.contentType ?? 'application/octet-stream' });
      return { data: { path }, error: null };
    },

    async download(path) {
      if (bucketId !== KNOWN_BUCKET) return { data: null, error: { message: 'unknown bucket' } };
      if (readDenied(path)) return { data: null, error: { message: 'not authorized' } };
      const obj = ctx.db.storage.get(path);
      if (!obj) return { data: null, error: { message: 'Object not found' } };
      return { data: obj.bytes, error: null };
    },

    async remove(paths) {
      if (bucketId !== KNOWN_BUCKET) return { data: null, error: { message: 'unknown bucket' } };
      if (writeDenied()) return { data: null, error: { message: 'not authorized' } };
      for (const p of paths) ctx.db.storage.delete(p);
      return { data: paths.map((name) => ({ name })), error: null };
    },

    async createSignedUrl(path, expiresInSeconds) {
      if (bucketId !== KNOWN_BUCKET) return { data: null, error: { message: 'unknown bucket' } };
      if (readDenied(path)) return { data: null, error: { message: 'not authorized' } };
      if (!ctx.db.storage.has(path)) return { data: null, error: { message: 'Object not found' } };
      const expiresAt = ctx.db.now() + expiresInSeconds * 1000;
      const token = `tok_${Math.random().toString(36).slice(2)}_${expiresAt}`;
      ctx.db.signedUrls.set(token, { path, expiresAt });
      return {
        data: { signedUrl: `https://fake.storage.local/${bucketId}/${path}?token=${token}`, expiresAt },
        error: null,
      };
    },

    async list(prefix, opts) {
      if (bucketId !== KNOWN_BUCKET) return { data: null, error: { message: 'unknown bucket' } };
      if (ctx.mode === 'anon') return { data: [], error: null };
      if (ctx.mode === 'user' && readDenied(`${prefix}/x`)) return { data: [], error: null };
      const entries: Array<{ name: string; metadata?: { size?: number } }> = [];
      for (const [path, obj] of ctx.db.storage.entries()) {
        const slash = path.lastIndexOf('/');
        const dir = slash === -1 ? '' : path.slice(0, slash);
        const filename = slash === -1 ? path : path.slice(slash + 1);
        if (dir !== prefix) continue;
        if (opts?.search && filename !== opts.search) continue;
        entries.push({ name: filename, metadata: { size: obj.bytes.length } });
      }
      return { data: entries, error: null };
    },
  };
}

async function getUser(db: FakeDb, token: string) {
  if (!token || !token.startsWith('fake.')) {
    return { data: { user: null }, error: { message: 'invalid token format' } };
  }
  let payload: {
    sub: string;
    appRole?: string;
    userRole?: string;
    email?: string | null;
    emailVerified?: boolean;
    fullName?: string;
    project?: string;
    exp?: number;
  };
  try {
    payload = JSON.parse(Buffer.from(token.slice('fake.'.length), 'base64url').toString('utf8'));
  } catch {
    return { data: { user: null }, error: { message: 'malformed token' } };
  }
  if (!payload.sub) {
    return { data: { user: null }, error: { message: 'malformed token: missing sub' } };
  }
  if (payload.project !== db.projectId) {
    return { data: { user: null }, error: { message: 'token issued for a different project' } };
  }
  const nowSec = Math.floor(db.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < nowSec) {
    return { data: { user: null }, error: { message: 'token expired' } };
  }
  return {
    data: {
      user: {
        id: payload.sub,
        email: payload.email ?? null,
        email_confirmed_at: payload.email && payload.emailVerified !== false ? '2026-01-01T00:00:00.000Z' : null,
        app_metadata: { role: payload.appRole },
        // Exposed only so a test can construct a client-side attempt at
        // privilege escalation (ROLE-02) — auth middleware must never read
        // `role` from here.
        user_metadata: { role: payload.userRole, full_name: payload.fullName },
      } as any,
    },
    error: null,
  };
}

export interface CreateFakeClientOptions {
  db: FakeDb;
  mode: ClientMode;
  userId?: string;
}

export function createFakeSupabaseClient(opts: CreateFakeClientOptions): SupabaseLike {
  const ctx: ClientContext = { db: opts.db, mode: opts.mode, userId: opts.userId };
  return {
    auth: { getUser: (token: string) => getUser(opts.db, token) },
    from: (table: string) => new FakeQueryBuilder(ctx, table),
    storage: { from: (bucket: string) => createFakeStorageBucket(ctx, bucket) },
  };
}

/** ISO-11: fetch bytes through a signed URL string, honoring its TTL. Not part of SupabaseLike — signed URLs are plain HTTP in reality. */
export function fetchViaSignedUrl(db: FakeDb, signedUrl: string, atMs: number): { bytes: Buffer } | { error: string } {
  const url = new URL(signedUrl);
  const token = url.searchParams.get('token');
  if (!token) return { error: 'missing token' };
  const entry = db.signedUrls.get(token);
  if (!entry) return { error: 'unknown or revoked token' };
  if (atMs > entry.expiresAt) return { error: 'signed URL expired' };
  const obj = db.storage.get(entry.path);
  if (!obj) return { error: 'object not found' };
  return { bytes: obj.bytes };
}

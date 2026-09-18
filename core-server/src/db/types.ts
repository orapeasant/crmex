// Minimal structural interface over the subset of @supabase/supabase-js we
// actually use. Both the real client (cast at the boundary in src/index.ts)
// and the strict in-memory fake used by tests (test/fakes/fakeSupabaseClient.ts)
// satisfy this shape. Keeping it narrow is what makes the fake tractable and
// what makes repositories unit-testable without a real database.

export interface DbError {
  message: string;
  code?: string;
}

export interface DbResult<T> {
  data: T | null;
  error: DbError | null;
}

export interface QueryBuilder<T = any> extends PromiseLike<DbResult<T[]>> {
  select(columns?: string): QueryBuilder<T>;
  insert(row: Record<string, unknown> | Record<string, unknown>[]): QueryBuilder<T>;
  update(patch: Record<string, unknown>): QueryBuilder<T>;
  delete(): QueryBuilder<T>;
  upsert(row: Record<string, unknown>, opts?: { onConflict?: string }): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  /** PostgREST's IS operator (`is null`). */
  is(column: string, value: null | boolean): QueryBuilder<T>;
  gt(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, values: readonly unknown[]): QueryBuilder<T>;
  order(column: string, opts?: { ascending?: boolean }): QueryBuilder<T>;
  limit(n: number): QueryBuilder<T>;
  single(): Promise<DbResult<T>>;
  maybeSingle(): Promise<DbResult<T>>;
}

export interface StorageDownloadResult {
  data: Buffer | Blob | null;
  error: DbError | null;
}

export interface StorageFileApi {
  upload(
    path: string,
    body: Buffer,
    opts?: { contentType?: string; upsert?: boolean },
  ): Promise<{ data: { path: string } | null; error: DbError | null }>;
  download(path: string): Promise<StorageDownloadResult>;
  remove(paths: string[]): Promise<{ data: unknown; error: DbError | null }>;
  createSignedUrl(
    path: string,
    expiresInSeconds: number,
  ): Promise<{ data: { signedUrl: string; expiresAt?: number } | null; error: DbError | null }>;
  list(
    prefix: string,
    opts?: { search?: string },
  ): Promise<{ data: Array<{ name: string; metadata?: { size?: number } }> | null; error: DbError | null }>;
}

export interface AuthUser {
  id: string;
  email?: string | null;
  /** Set by Supabase Auth once the address is verified (always set for Google sign-in). */
  email_confirmed_at?: string | null;
  app_metadata?: { role?: string };
  /** User-writable. Display purposes only — never an authorization input. */
  user_metadata?: { full_name?: string; name?: string; [key: string]: unknown };
}

export interface SupabaseLike {
  auth: {
    getUser(token: string): Promise<{ data: { user: AuthUser | null }; error: DbError | null }>;
  };
  from(table: string): QueryBuilder;
  storage: { from(bucket: string): StorageFileApi };
}

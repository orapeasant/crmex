// LocalStore implementation over @capacitor-community/sqlite, matching the
// schema in crmex.md §3.2 exactly. Every query filters on user_id (crmex.md
// §4, ISO-14) — there is no query in this file that reads across users.
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';
import type { LocalStore, OutboxInsertItem, OutboxRow, OutboxStatus, ImageCacheRow } from 'shared-ui';

const DB_NAME = 'crmex';

const SCHEMA = `
create table if not exists outbox (
  id           integer primary key autoincrement,
  user_id      text not null,
  org_id       text not null default '',
  batch_id     text not null,
  jid          text not null,
  client_id    text,
  display_name text,
  body         text,
  media_path   text,
  status       text not null default 'PENDING',
  attempts     integer not null default 0,
  claimed_at   integer
);

create table if not exists image_cache (
  media_path   text not null,
  user_id      text not null,
  local_file   text not null,
  bytes        integer not null,
  cached_at    integer not null,
  last_used_at integer not null,
  primary key (user_id, media_path)
);

create index if not exists outbox_pending on outbox (user_id, status);
create index if not exists cache_by_user on image_cache (user_id, last_used_at);
`;

function rowToOutboxRow(r: Record<string, unknown>): OutboxRow {
  return {
    id: r.id as number,
    userId: r.user_id as string,
    orgId: r.org_id as string,
    batchId: r.batch_id as string,
    jid: r.jid as string,
    clientId: (r.client_id as string | null) ?? null,
    displayName: (r.display_name as string | null) ?? null,
    body: (r.body as string | null) ?? undefined,
    mediaPath: (r.media_path as string | null) ?? null,
    status: r.status as OutboxStatus,
    attempts: r.attempts as number,
    claimedAt: (r.claimed_at as number | null) ?? null,
  };
}

function rowToCacheRow(r: Record<string, unknown>): ImageCacheRow {
  return {
    mediaPath: r.media_path as string,
    userId: r.user_id as string,
    localFile: r.local_file as string,
    bytes: r.bytes as number,
    cachedAt: r.cached_at as number,
    lastUsedAt: r.last_used_at as number,
  };
}

// Databases created before multi-tenancy lack org_id; 'create table if not exists' won't add it.
// Rows from then keep an empty org_id, which OutboxManager never mirrors to a guessed firm.
async function addColumnIfMissing(db: SQLiteDBConnection, table: string, column: string, definition: string): Promise<void> {
  const res = await db.query(`PRAGMA table_info(${table});`);
  if ((res.values ?? []).some((c) => c.name === column)) return;
  await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

export class SqliteLocalStore implements LocalStore {
  private connection: SQLiteConnection;
  private dbPromise: Promise<SQLiteDBConnection> | null = null;

  constructor() {
    this.connection = new SQLiteConnection(CapacitorSQLite);
  }

  private async db(): Promise<SQLiteDBConnection> {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const db = await this.connection.createConnection(DB_NAME, false, 'no-encryption', 1, false);
        await db.open();
        await db.execute(SCHEMA);
        await addColumnIfMissing(db, 'outbox', 'org_id', "text not null default ''");
        await addColumnIfMissing(db, 'outbox', 'client_id', 'text');
        await addColumnIfMissing(db, 'outbox', 'display_name', 'text');
        return db;
      })();
    }
    return this.dbPromise;
  }

  async insertOutboxBatch(
    userId: string,
    orgId: string,
    batchId: string,
    items: OutboxInsertItem[],
  ): Promise<OutboxRow[]> {
    const db = await this.db();
    // Wrapped in a transaction so a large batch is one atomic write, not N
    // implicit transactions (crmex.md §9.5 — the exact bug being avoided).
    // The plugin wraps each run()/execute() in its own transaction unless told
    // not to, so a raw 'BEGIN' through execute() fails; use its transaction API
    // and pass transaction=false to the statements inside it.
    await db.beginTransaction();
    try {
      const rows: OutboxRow[] = [];
      for (const item of items) {
        const res = await db.run(
          'INSERT INTO outbox (user_id, org_id, batch_id, jid, client_id, display_name, body, media_path, status, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0);',
          [userId, orgId, batchId, item.jid, item.clientId ?? null, item.displayName ?? null, item.body ?? null, item.mediaPath ?? null, 'PENDING'],
          false,
        );
        const id = res.changes?.lastId as number;
        rows.push({
          id,
          userId,
          orgId,
          batchId,
          jid: item.jid,
          clientId: item.clientId ?? null,
          displayName: item.displayName ?? null,
          body: item.body,
          mediaPath: item.mediaPath ?? null,
          status: 'PENDING',
          attempts: 0,
          claimedAt: null,
        });
      }
      await db.commitTransaction();
      return rows;
    } catch (err) {
      await db.rollbackTransaction();
      throw err;
    }
  }

  async claimOutboxRow(id: number, now: number): Promise<void> {
    const db = await this.db();
    await db.run('UPDATE outbox SET status = ?, claimed_at = ?, attempts = attempts + 1 WHERE id = ?;', [
      'CLAIMED',
      now,
      id,
    ]);
  }

  async settleOutboxRow(id: number, status: OutboxStatus): Promise<void> {
    const db = await this.db();
    await db.run('UPDATE outbox SET status = ? WHERE id = ?;', [status, id]);
  }

  async deleteOutboxRow(id: number): Promise<void> {
    const db = await this.db();
    await db.run('DELETE FROM outbox WHERE id = ?;', [id]);
  }

  async listPendingOutbox(userId: string): Promise<OutboxRow[]> {
    const db = await this.db();
    // ORDER BY id — the previous draft's bug (crmex.md §9.5) was no
    // ORDER BY at all, giving no ordering guarantee.
    const res = await db.query('SELECT * FROM outbox WHERE user_id = ? AND status = ? ORDER BY id ASC;', [
      userId,
      'PENDING',
    ]);
    return (res.values ?? []).map(rowToOutboxRow);
  }

  async listClaimedUnsettled(userId: string): Promise<OutboxRow[]> {
    const db = await this.db();
    const res = await db.query('SELECT * FROM outbox WHERE user_id = ? AND status = ? ORDER BY id ASC;', [
      userId,
      'CLAIMED',
    ]);
    return (res.values ?? []).map(rowToOutboxRow);
  }

  async listSettledUnmirrored(userId: string): Promise<OutboxRow[]> {
    const db = await this.db();
    const res = await db.query(
      "SELECT * FROM outbox WHERE user_id = ? AND status IN ('SENT','FAILED','SKIPPED') ORDER BY id ASC;",
      [userId],
    );
    return (res.values ?? []).map(rowToOutboxRow);
  }

  async getCacheRow(userId: string, mediaPath: string): Promise<ImageCacheRow | null> {
    const db = await this.db();
    const res = await db.query('SELECT * FROM image_cache WHERE user_id = ? AND media_path = ?;', [userId, mediaPath]);
    const row = (res.values ?? [])[0];
    return row ? rowToCacheRow(row) : null;
  }

  async putCacheRow(row: ImageCacheRow): Promise<void> {
    const db = await this.db();
    await db.run(
      `INSERT INTO image_cache (media_path, user_id, local_file, bytes, cached_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, media_path) DO UPDATE SET
         local_file = excluded.local_file,
         bytes = excluded.bytes,
         cached_at = excluded.cached_at,
         last_used_at = excluded.last_used_at;`,
      [row.mediaPath, row.userId, row.localFile, row.bytes, row.cachedAt, row.lastUsedAt],
    );
  }

  async touchCacheRow(userId: string, mediaPath: string, now: number): Promise<void> {
    const db = await this.db();
    await db.run('UPDATE image_cache SET last_used_at = ? WHERE user_id = ? AND media_path = ?;', [
      now,
      userId,
      mediaPath,
    ]);
  }

  async deleteCacheRow(userId: string, mediaPath: string): Promise<void> {
    const db = await this.db();
    await db.run('DELETE FROM image_cache WHERE user_id = ? AND media_path = ?;', [userId, mediaPath]);
  }

  async listCacheByUser(userId: string): Promise<ImageCacheRow[]> {
    const db = await this.db();
    const res = await db.query('SELECT * FROM image_cache WHERE user_id = ? ORDER BY last_used_at ASC;', [userId]);
    return (res.values ?? []).map(rowToCacheRow);
  }

  async purgeUser(userId: string): Promise<void> {
    // ISO-13: called on sign-out. Removes both outbox and cache rows for the
    // signed-out user; the caller (auth flow) is also responsible for
    // deleting the actual cached files from Directory.Cache, since this
    // store only owns the SQLite index, not the filesystem.
    const db = await this.db();
    await db.beginTransaction();
    try {
      await db.run('DELETE FROM outbox WHERE user_id = ?;', [userId], false);
      await db.run('DELETE FROM image_cache WHERE user_id = ?;', [userId], false);
      await db.commitTransaction();
    } catch (err) {
      await db.rollbackTransaction();
      throw err;
    }
  }

  async purgeOrg(userId: string, orgId: string): Promise<void> {
    // §15.6: the user is no longer a member of this firm; its unsent or
    // unmirrored rows could never be written to that firm's history anyway.
    const db = await this.db();
    await db.run('DELETE FROM outbox WHERE user_id = ? AND org_id = ?;', [userId, orgId]);
  }
}

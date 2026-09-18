// In-memory LocalStore used by unit/integration tests and as a reference
// implementation. Mirrors the SQLite schema in crmex.md §3.2 exactly enough
// that behavioural tests (ordering, user isolation, status transitions)
// exercise the real contract rather than a shortcut.
import type { LocalStore, OutboxInsertItem, OutboxRow, OutboxStatus, ImageCacheRow } from '../types.js';

export class InMemoryLocalStore implements LocalStore {
  private outboxRows: OutboxRow[] = [];
  private nextId = 1;
  private cache = new Map<string, ImageCacheRow>(); // key: `${userId} ${mediaPath}`

  async insertOutboxBatch(userId: string, orgId: string, batchId: string, items: OutboxInsertItem[]): Promise<OutboxRow[]> {
    const rows: OutboxRow[] = items.map((item) => ({
      id: this.nextId++,
      userId,
      orgId,
      batchId,
      jid: item.jid,
      clientId: item.clientId ?? null,
      displayName: item.displayName ?? null,
      body: item.body,
      mediaPath: item.mediaPath ?? null,
      status: 'PENDING' as OutboxStatus,
      attempts: 0,
      claimedAt: null,
    }));
    this.outboxRows.push(...rows);
    // Return copies so callers mutating the returned array don't corrupt state.
    return rows.map((r) => ({ ...r }));
  }

  async claimOutboxRow(id: number, now: number): Promise<void> {
    const row = this.mustFind(id);
    row.status = 'CLAIMED';
    row.claimedAt = now;
    row.attempts += 1;
  }

  async settleOutboxRow(id: number, status: OutboxStatus): Promise<void> {
    const row = this.mustFind(id);
    row.status = status;
  }

  async deleteOutboxRow(id: number): Promise<void> {
    this.outboxRows = this.outboxRows.filter((r) => r.id !== id);
  }

  async listPendingOutbox(userId: string): Promise<OutboxRow[]> {
    // ORDER BY id — the previous draft's documented bug was no ORDER BY at
    // all (crmex.md §9.5); this store always returns insertion order.
    return this.outboxRows
      .filter((r) => r.userId === userId && r.status === 'PENDING')
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ ...r }));
  }

  async listClaimedUnsettled(userId: string): Promise<OutboxRow[]> {
    return this.outboxRows
      .filter((r) => r.userId === userId && r.status === 'CLAIMED')
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ ...r }));
  }

  async listSettledUnmirrored(userId: string): Promise<OutboxRow[]> {
    return this.outboxRows
      .filter((r) => r.userId === userId && (r.status === 'SENT' || r.status === 'FAILED' || r.status === 'SKIPPED'))
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ ...r }));
  }

  async getCacheRow(userId: string, mediaPath: string): Promise<ImageCacheRow | null> {
    const row = this.cache.get(this.cacheKey(userId, mediaPath));
    return row ? { ...row } : null;
  }

  async putCacheRow(row: ImageCacheRow): Promise<void> {
    this.cache.set(this.cacheKey(row.userId, row.mediaPath), { ...row });
  }

  async touchCacheRow(userId: string, mediaPath: string, now: number): Promise<void> {
    const row = this.cache.get(this.cacheKey(userId, mediaPath));
    if (row) row.lastUsedAt = now;
  }

  async deleteCacheRow(userId: string, mediaPath: string): Promise<void> {
    this.cache.delete(this.cacheKey(userId, mediaPath));
  }

  async listCacheByUser(userId: string): Promise<ImageCacheRow[]> {
    return Array.from(this.cache.values())
      .filter((r) => r.userId === userId)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
      .map((r) => ({ ...r }));
  }

  async purgeUser(userId: string): Promise<void> {
    this.outboxRows = this.outboxRows.filter((r) => r.userId !== userId);
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(`${userId} `)) this.cache.delete(key);
    }
  }

  async purgeOrg(userId: string, orgId: string): Promise<void> {
    this.outboxRows = this.outboxRows.filter((r) => !(r.userId === userId && r.orgId === orgId));
  }

  private cacheKey(userId: string, mediaPath: string): string {
    return `${userId} ${mediaPath}`;
  }

  private mustFind(id: number): OutboxRow {
    const row = this.outboxRows.find((r) => r.id === id);
    if (!row) throw new Error(`No outbox row with id ${id}`);
    return row;
  }
}

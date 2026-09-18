import type { SupabaseLike } from '../db/types';
import { ContentionError } from '../lib/errors';
import { UNIQUE_VIOLATION } from './orgsRepo';

export interface OrgUsageRow {
  org_id: string;
  day: string;
  images_generated: number;
  messages_drafted: number;
  messages_sent: number;
  storage_bytes: number;
}

export type CounterColumn = 'images_generated' | 'messages_drafted' | 'storage_bytes';

const MAX_CAS_ATTEMPTS = 8;

function todayUtc(now: () => number): string {
  return new Date(now()).toISOString().slice(0, 10);
}

/**
 * org_usage_daily (crmex.md §15.3), keyed (org_id, day) so quotas reset at
 * UTC midnight and one firm's usage never touches another's row.
 *
 * Concurrency: without a SQL function (no new migrations) there is no single
 * "increment if below limit" statement available through PostgREST, so
 * increments are compare-and-set: read the counter, then
 * `UPDATE ... SET col = v+1 WHERE org_id = $ AND day = $ AND col = v`.
 * Postgres re-evaluates that WHERE on the locked row, so two concurrent
 * writers that read the same v cannot both succeed — the loser re-reads and
 * retries. That makes the limit exact (never exceeded) across processes and
 * instances. Under sustained contention on one firm's row a request can
 * exhaust its retries and fail with 503 CONTENTION rather than over-count.
 */
export function createOrgUsageRepo(db: SupabaseLike, now: () => number = Date.now) {
  async function getForDay(orgId: string, day: string): Promise<OrgUsageRow | null> {
    const { data, error } = await db.from('org_usage_daily').select('*').eq('org_id', orgId).eq('day', day).maybeSingle();
    if (error) throw new Error(`orgUsageRepo.getForDay failed: ${error.message}`);
    return (data as OrgUsageRow | null) ?? null;
  }

  async function ensureRow(orgId: string, day: string): Promise<OrgUsageRow> {
    const existing = await getForDay(orgId, day);
    if (existing) return existing;
    const fresh = { org_id: orgId, day, images_generated: 0, messages_drafted: 0, messages_sent: 0, storage_bytes: 0 };
    const { error } = await db.from('org_usage_daily').insert(fresh);
    // A concurrent request created the row first — fine, read theirs.
    if (error && error.code !== UNIQUE_VIOLATION) throw new Error(`orgUsageRepo.ensureRow failed: ${error.message}`);
    const row = await getForDay(orgId, day);
    if (!row) throw new Error('orgUsageRepo.ensureRow: row missing after insert');
    return row;
  }

  /**
   * Adds `delta` to `column` for today, unless the result would exceed
   * `limit` (pass Infinity for no limit). Returns false — without writing —
   * when the limit would be exceeded.
   */
  async function addIfWithin(orgId: string, column: CounterColumn, delta: number, limit: number): Promise<boolean> {
    const day = todayUtc(now);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const row = await ensureRow(orgId, day);
      const current = Number(row[column]) || 0;
      if (current + delta > limit) return false;
      const { data, error } = await db
        .from('org_usage_daily')
        .update({ [column]: current + delta })
        .eq('org_id', orgId)
        .eq('day', day)
        .eq(column, row[column])
        .select();
      if (error) throw new Error(`orgUsageRepo.addIfWithin failed: ${error.message}`);
      const updated = Array.isArray(data) ? data : data ? [data] : [];
      if (updated.length === 1) return true;
      // Lost the race: someone changed the counter between read and write.
    }
    throw new ContentionError();
  }

  return {
    todayUtc: () => todayUtc(now),

    async getToday(orgId: string): Promise<OrgUsageRow> {
      const day = todayUtc(now);
      return (
        (await getForDay(orgId, day)) ?? {
          org_id: orgId,
          day,
          images_generated: 0,
          messages_drafted: 0,
          messages_sent: 0,
          storage_bytes: 0,
        }
      );
    },

    /** Atomically claims one unit of `column` below `limit`. False = quota reached. */
    reserve(orgId: string, column: 'images_generated' | 'messages_drafted', limit: number): Promise<boolean> {
      return addIfWithin(orgId, column, 1, limit);
    },

    /** Gives back a reservation (e.g. the provider call failed before producing anything). Never goes below 0. */
    async release(orgId: string, column: 'images_generated' | 'messages_drafted'): Promise<void> {
      const day = todayUtc(now);
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
        const row = await getForDay(orgId, day);
        if (!row || row[column] <= 0) return;
        const { data, error } = await db
          .from('org_usage_daily')
          .update({ [column]: row[column] - 1 })
          .eq('org_id', orgId)
          .eq('day', day)
          .eq(column, row[column])
          .select();
        if (error) throw new Error(`orgUsageRepo.release failed: ${error.message}`);
        if ((Array.isArray(data) ? data : data ? [data] : []).length === 1) return;
      }
      throw new ContentionError();
    },

    async addStorageBytes(orgId: string, bytes: number): Promise<void> {
      await addIfWithin(orgId, 'storage_bytes', bytes, Infinity);
    },
  };
}

export type OrgUsageRepo = ReturnType<typeof createOrgUsageRepo>;

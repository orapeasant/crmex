// Groups message_history rows into send batches for the History view.
import type { MessageHistoryRow } from '../supabase/repo.js';

export interface BatchSummary {
  batchId: string;
  orgId: string;
  senderId: string | null;
  /** Earliest row time in the batch. */
  startedAt: string;
  body: string | null;
  mediaPath: string | null;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
}

export function groupHistoryBatches(rows: MessageHistoryRow[]): BatchSummary[] {
  const byBatch = new Map<string, BatchSummary>();
  for (const r of rows) {
    let b = byBatch.get(r.batch_id);
    if (!b) {
      b = { batchId: r.batch_id, orgId: r.org_id, senderId: r.user_id, startedAt: r.created_at, body: r.body, mediaPath: r.media_path, total: 0, sent: 0, failed: 0, skipped: 0 };
      byBatch.set(r.batch_id, b);
    }
    b.total++;
    if (r.status === 'SENT') b.sent++;
    else if (r.status === 'FAILED') b.failed++;
    else if (r.status === 'SKIPPED') b.skipped++;
    if (r.created_at < b.startedAt) b.startedAt = r.created_at;
    if (!b.body && r.body) b.body = r.body;
    if (!b.mediaPath && r.media_path) b.mediaPath = r.media_path;
  }
  return Array.from(byBatch.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function memberLabel(member: { display_name: string | null; email: string | null } | undefined, fallback = 'Unknown member'): string {
  return member?.display_name?.trim() || member?.email?.trim() || fallback;
}

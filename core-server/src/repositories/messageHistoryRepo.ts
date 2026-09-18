import type { SupabaseLike } from '../db/types';

export interface MessageHistoryRow {
  id: number | string;
  org_id: string;
  /** Sender. Null once that account is deleted (history stays with the firm). */
  user_id: string | null;
  jid: string;
  display_name: string | null;
  body: string | null;
  media_path: string | null;
  media_sha256: string | null;
  status: string;
  error_reason: string | null;
  batch_id: string;
  created_at: string;
  resolved_at: string | null;
}

/**
 * message_history access (crmex.md §3.1). Used read-only by the retention
 * job (src/jobs/retention.ts) to determine which storage objects have been
 * sent (RET-03..05) — retention must never delete a message_history row
 * (the record that something was sent outlives the file), only read it.
 */
export function createMessageHistoryRepo(db: SupabaseLike) {
  return {
    async listAll(): Promise<MessageHistoryRow[]> {
      const { data, error } = await db.from('message_history').select('*');
      if (error) throw new Error(`messageHistoryRepo.listAll failed: ${error.message}`);
      return (data as MessageHistoryRow[] | null) ?? [];
    },
  };
}

export type MessageHistoryRepo = ReturnType<typeof createMessageHistoryRepo>;

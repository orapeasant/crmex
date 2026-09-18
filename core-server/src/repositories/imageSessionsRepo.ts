import type { SupabaseLike } from '../db/types';
import type { PromptHistoryEntry } from '../providers/types';

export interface ImageSessionRow {
  id: number | string;
  org_id: string;
  /** Who created the session. Not an access control: any member of org_id may use it (§15.5). Null once that account is deleted. */
  user_id: string | null;
  prompt_history: PromptHistoryEntry[];
  current_path: string | null;
  source: 'generated' | 'searched';
  created_at: string;
  updated_at: string;
}

export interface CreateImageSessionInput {
  promptHistory: PromptHistoryEntry[];
  currentPath: string;
  source: 'generated' | 'searched';
}

/**
 * `id` is a bigserial (numeric) column, but it arrives here as a string
 * whenever it came from an Express route param (`req.params.sessionId`).
 * Postgres coerces this automatically in a real `.eq('id', ...)` query;
 * this normalizes it the same way so an id of "5" matches a stored row
 * whose id is the number 5.
 */
function normalizeId(id: number | string): number | string {
  if (typeof id === 'number') return id;
  return /^\d+$/.test(id) ? Number(id) : id;
}

/**
 * image_sessions access (crmex.md §3.1, §15.3). core-server uses the service
 * role key, which bypasses RLS entirely (§4), so EVERY method here filters
 * by the membership-verified orgId in application code — that filter is the
 * real isolation control from core-server's side, RLS is the client-direct-
 * access backstop. Never add a method that reads/writes this table without
 * an orgId parameter (listAll is the retention job's documented exception).
 */
export function createImageSessionsRepo(db: SupabaseLike) {
  return {
    async create(orgId: string, userId: string, input: CreateImageSessionInput): Promise<ImageSessionRow> {
      const { data, error } = await db
        .from('image_sessions')
        .insert({
          org_id: orgId,
          user_id: userId,
          prompt_history: input.promptHistory,
          current_path: input.currentPath,
          source: input.source,
        })
        .select();
      if (error) throw new Error(`imageSessionsRepo.create failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('imageSessionsRepo.create: no row returned');
      return row as ImageSessionRow;
    },

    /** Returns null (never another firm's row) if `id` isn't in orgId. */
    async getInOrg(orgId: string, id: number | string): Promise<ImageSessionRow | null> {
      const { data, error } = await db
        .from('image_sessions')
        .select('*')
        .eq('id', normalizeId(id))
        .eq('org_id', orgId)
        .maybeSingle();
      if (error) throw new Error(`imageSessionsRepo.getInOrg failed: ${error.message}`);
      return (data as ImageSessionRow | null) ?? null;
    },

    /** No-op (returns null) if `id` isn't in orgId — never touches another firm's row. */
    async updateInOrg(
      orgId: string,
      id: number | string,
      // org_id is deliberately not patchable: a DB trigger (guard_org_id) rejects any change to it.
    patch: Partial<Pick<ImageSessionRow, 'current_path' | 'prompt_history' | 'updated_at'>>,
    ): Promise<ImageSessionRow | null> {
      const { data, error } = await db
        .from('image_sessions')
        .update(patch)
        .eq('id', normalizeId(id))
        .eq('org_id', orgId)
        .select();
      if (error) throw new Error(`imageSessionsRepo.updateInOrg failed: ${error.message}`);
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return (rows[0] as ImageSessionRow | undefined) ?? null;
    },

    async deleteInOrg(orgId: string, id: number | string): Promise<void> {
      const { error } = await db.from('image_sessions').delete().eq('id', normalizeId(id)).eq('org_id', orgId);
      if (error) throw new Error(`imageSessionsRepo.deleteInOrg failed: ${error.message}`);
    },

    /** Used by the retention job, which operates across firms but deletes each row scoped by its own org_id. */
    async listAll(): Promise<ImageSessionRow[]> {
      const { data, error } = await db.from('image_sessions').select('*');
      if (error) throw new Error(`imageSessionsRepo.listAll failed: ${error.message}`);
      return (data as ImageSessionRow[] | null) ?? [];
    },
  };
}

export type ImageSessionsRepo = ReturnType<typeof createImageSessionsRepo>;

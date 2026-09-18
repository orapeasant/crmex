import type { SupabaseLike } from '../db/types';

export interface InvitationRow {
  id: string;
  org_id: string;
  email: string | null;
  role: 'admin' | 'member';
  token_hash: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
}

/**
 * org_invitations (crmex.md §15.2). Only token hashes are ever stored or
 * queried; the plaintext token never reaches this layer.
 */
export function createInvitationsRepo(db: SupabaseLike) {
  return {
    async create(input: {
      orgId: string;
      email: string | null;
      role: 'admin' | 'member';
      tokenHash: string;
      createdBy: string;
      expiresAt: string;
    }): Promise<InvitationRow> {
      const { data, error } = await db
        .from('org_invitations')
        .insert({
          org_id: input.orgId,
          email: input.email,
          role: input.role,
          token_hash: input.tokenHash,
          created_by: input.createdBy,
          expires_at: input.expiresAt,
        })
        .select();
      if (error) throw new Error(`invitationsRepo.create failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('invitationsRepo.create: no row returned');
      return row as InvitationRow;
    },

    /** Pending = not accepted, not revoked, not expired — filtered in the query, scoped by org. */
    async listPending(orgId: string, nowIso: string): Promise<InvitationRow[]> {
      const { data, error } = await db
        .from('org_invitations')
        .select('*')
        .eq('org_id', orgId)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false });
      if (error) throw new Error(`invitationsRepo.listPending failed: ${error.message}`);
      return (data as InvitationRow[] | null) ?? [];
    },

    async getByTokenHash(tokenHash: string): Promise<InvitationRow | null> {
      const { data, error } = await db.from('org_invitations').select('*').eq('token_hash', tokenHash).maybeSingle();
      if (error) throw new Error(`invitationsRepo.getByTokenHash failed: ${error.message}`);
      return (data as InvitationRow | null) ?? null;
    },

    /** Conditional: only a still-pending invitation in this org is revoked. Returns null otherwise. */
    async revoke(orgId: string, id: string, nowIso: string): Promise<InvitationRow | null> {
      const { data, error } = await db
        .from('org_invitations')
        .update({ revoked_at: nowIso })
        .eq('id', id)
        .eq('org_id', orgId)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .select();
      if (error) throw new Error(`invitationsRepo.revoke failed: ${error.message}`);
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return (rows[0] as InvitationRow | undefined) ?? null;
    },

    /**
     * Single-use claim. One UPDATE ... WHERE accepted_at IS NULL AND
     * revoked_at IS NULL AND expires_at > now: Postgres re-checks the WHERE
     * clause on the locked row, so of N concurrent claims exactly one gets a
     * row back. Returns null if the claim lost or the invitation isn't pending.
     */
    async claim(id: string, tokenHash: string, userId: string, nowIso: string): Promise<InvitationRow | null> {
      const { data, error } = await db
        .from('org_invitations')
        .update({ accepted_at: nowIso, accepted_by: userId })
        .eq('id', id)
        .eq('token_hash', tokenHash)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .gt('expires_at', nowIso)
        .select();
      if (error) throw new Error(`invitationsRepo.claim failed: ${error.message}`);
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return (rows[0] as InvitationRow | undefined) ?? null;
    },

    /** Compensation only: undo a claim by this user if the membership insert failed. */
    async unclaim(id: string, userId: string): Promise<void> {
      const { error } = await db
        .from('org_invitations')
        .update({ accepted_at: null, accepted_by: null })
        .eq('id', id)
        .eq('accepted_by', userId);
      if (error) throw new Error(`invitationsRepo.unclaim failed: ${error.message}`);
    },
  };
}

export type InvitationsRepo = ReturnType<typeof createInvitationsRepo>;

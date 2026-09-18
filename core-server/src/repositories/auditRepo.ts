import type { SupabaseLike } from '../db/types';

export type OrgAuditAction =
  | 'member.add'
  | 'member.remove'
  | 'member.role'
  | 'invitation.create'
  | 'invitation.revoke'
  | 'invitation.accept';

/**
 * org_audit_log (crmex.md §15.7) and admin_audit_log (§13.3/§15.8). Records
 * who did what to which entity — never field contents (no emails, names,
 * roles-as-values or tokens in these rows).
 */
export function createAuditRepo(db: SupabaseLike) {
  return {
    async orgEvent(input: { orgId: string; actorId: string; action: OrgAuditAction; entity: string; entityId: string }): Promise<void> {
      const { error } = await db.from('org_audit_log').insert({
        org_id: input.orgId,
        actor_id: input.actorId,
        action: input.action,
        entity: input.entity,
        entity_id: input.entityId,
      });
      if (error) throw new Error(`auditRepo.orgEvent failed: ${error.message}`);
    },

    /** Operator directory reads (§15.8). `after` carries only the scope read (e.g. which firm id), never results. */
    async adminEvent(input: { actorId: string; action: string; scope?: Record<string, string> }): Promise<void> {
      const { error } = await db.from('admin_audit_log').insert({
        actor_id: input.actorId,
        action: input.action,
        after: input.scope ?? null,
      });
      if (error) throw new Error(`auditRepo.adminEvent failed: ${error.message}`);
    },
  };
}

export type AuditRepo = ReturnType<typeof createAuditRepo>;

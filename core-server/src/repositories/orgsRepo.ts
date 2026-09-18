import type { SupabaseLike } from '../db/types';

export type OrgRole = 'owner' | 'admin' | 'member';

export interface OrganizationRow {
  id: string;
  name: string;
  plan: string;
  created_by: string | null;
  created_at: string;
}

export interface OrgMemberRow {
  org_id: string;
  user_id: string;
  role: OrgRole;
  email: string | null;
  display_name: string | null;
  created_at: string;
}

/** Postgres unique_violation. */
export const UNIQUE_VIOLATION = '23505';

/**
 * organizations + org_members (crmex.md §15.3). core-server uses the service
 * role, so every membership read here is keyed by an explicit org_id and/or
 * user_id passed in by the caller — the membership lookup in
 * getMembership() is the authorization check for every firm-scoped request,
 * and is intentionally never cached.
 */
export function createOrgsRepo(db: SupabaseLike) {
  return {
    async getMembership(orgId: string, userId: string): Promise<OrgMemberRow | null> {
      const { data, error } = await db
        .from('org_members')
        .select('*')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw new Error(`orgsRepo.getMembership failed: ${error.message}`);
      return (data as OrgMemberRow | null) ?? null;
    },

    async listMembershipsForUser(userId: string): Promise<OrgMemberRow[]> {
      const { data, error } = await db.from('org_members').select('*').eq('user_id', userId);
      if (error) throw new Error(`orgsRepo.listMembershipsForUser failed: ${error.message}`);
      return (data as OrgMemberRow[] | null) ?? [];
    },

    async listMembers(orgId: string): Promise<OrgMemberRow[]> {
      const { data, error } = await db.from('org_members').select('*').eq('org_id', orgId).order('created_at', { ascending: true });
      if (error) throw new Error(`orgsRepo.listMembers failed: ${error.message}`);
      return (data as OrgMemberRow[] | null) ?? [];
    },

    async countOwners(orgId: string): Promise<number> {
      const { data, error } = await db.from('org_members').select('user_id').eq('org_id', orgId).eq('role', 'owner');
      if (error) throw new Error(`orgsRepo.countOwners failed: ${error.message}`);
      return ((data as unknown[] | null) ?? []).length;
    },

    async getOrgsByIds(ids: readonly string[]): Promise<OrganizationRow[]> {
      if (ids.length === 0) return [];
      const { data, error } = await db.from('organizations').select('*').in('id', ids);
      if (error) throw new Error(`orgsRepo.getOrgsByIds failed: ${error.message}`);
      return (data as OrganizationRow[] | null) ?? [];
    },

    async getOrg(orgId: string): Promise<OrganizationRow | null> {
      const { data, error } = await db.from('organizations').select('*').eq('id', orgId).maybeSingle();
      if (error) throw new Error(`orgsRepo.getOrg failed: ${error.message}`);
      return (data as OrganizationRow | null) ?? null;
    },

    /** Operator directory only (§15.8): organizations have no firm data. */
    async listAllOrgs(): Promise<OrganizationRow[]> {
      const { data, error } = await db.from('organizations').select('*').order('created_at', { ascending: true });
      if (error) throw new Error(`orgsRepo.listAllOrgs failed: ${error.message}`);
      return (data as OrganizationRow[] | null) ?? [];
    },

    /** Operator directory only: org_id -> seat count. Reads org_id alone. */
    async countMembersByOrg(): Promise<Map<string, number>> {
      const { data, error } = await db.from('org_members').select('org_id');
      if (error) throw new Error(`orgsRepo.countMembersByOrg failed: ${error.message}`);
      const counts = new Map<string, number>();
      for (const row of (data as Array<{ org_id: string }> | null) ?? []) {
        counts.set(row.org_id, (counts.get(row.org_id) ?? 0) + 1);
      }
      return counts;
    },

    async createOrg(name: string, createdBy: string): Promise<OrganizationRow> {
      const { data, error } = await db.from('organizations').insert({ name, created_by: createdBy }).select();
      if (error) throw new Error(`orgsRepo.createOrg failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('orgsRepo.createOrg: no row returned');
      return row as OrganizationRow;
    },

    async deleteOrg(orgId: string): Promise<void> {
      const { error } = await db.from('organizations').delete().eq('id', orgId);
      if (error) throw new Error(`orgsRepo.deleteOrg failed: ${error.message}`);
    },

    /**
     * Returns { conflict: true } instead of throwing when (org_id, user_id)
     * already exists, so callers can resolve a concurrent insert race.
     */
    async addMember(input: {
      orgId: string;
      userId: string;
      role: OrgRole;
      email: string | null;
      displayName: string | null;
    }): Promise<{ row: OrgMemberRow; conflict: false } | { row: null; conflict: true }> {
      const { data, error } = await db
        .from('org_members')
        .insert({
          org_id: input.orgId,
          user_id: input.userId,
          role: input.role,
          email: input.email,
          display_name: input.displayName,
        })
        .select();
      if (error?.code === UNIQUE_VIOLATION) return { row: null, conflict: true };
      if (error) throw new Error(`orgsRepo.addMember failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('orgsRepo.addMember: no row returned');
      return { row: row as OrgMemberRow, conflict: false };
    },

    async updateMemberRole(orgId: string, userId: string, role: OrgRole): Promise<OrgMemberRow | null> {
      const { data, error } = await db.from('org_members').update({ role }).eq('org_id', orgId).eq('user_id', userId).select();
      if (error) throw new Error(`orgsRepo.updateMemberRole failed: ${error.message}`);
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return (rows[0] as OrgMemberRow | undefined) ?? null;
    },

    async removeMember(orgId: string, userId: string): Promise<OrgMemberRow | null> {
      const { data, error } = await db.from('org_members').delete().eq('org_id', orgId).eq('user_id', userId).select();
      if (error) throw new Error(`orgsRepo.removeMember failed: ${error.message}`);
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return (rows[0] as OrgMemberRow | undefined) ?? null;
    },

    /** Compensation only: put back a membership row exactly as it was. */
    async restoreMember(row: OrgMemberRow): Promise<void> {
      const { error } = await db.from('org_members').insert({ ...row });
      if (error && error.code !== UNIQUE_VIOLATION) throw new Error(`orgsRepo.restoreMember failed: ${error.message}`);
    },
  };
}

export type OrgsRepo = ReturnType<typeof createOrgsRepo>;

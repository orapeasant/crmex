import { randomBytes } from 'crypto';
import type { OrgMemberRow, OrgRole, OrganizationRow, OrgsRepo } from '../repositories/orgsRepo';
import type { InvitationRow, InvitationsRepo } from '../repositories/invitationsRepo';
import type { AuditRepo, OrgAuditAction } from '../repositories/auditRepo';
import { sha256Hex } from '../lib/hash';
import { AppError, ConflictError, InsufficientRoleError, NotFoundError } from '../lib/errors';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_URL_PREFIX = 'crmex://invite/';

export interface OrgServiceDeps {
  orgsRepo: OrgsRepo;
  invitationsRepo: InvitationsRepo;
  auditRepo: AuditRepo;
  now: () => number;
}

/** The verified caller, as attached by the auth middleware. */
export interface Caller {
  userId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

export interface OrgPayload {
  id: string;
  name: string;
  plan: string;
  role: OrgRole;
  createdAt: string;
}

export interface MemberPayload {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: OrgRole;
  joinedAt: string;
}

export interface InvitationPayload {
  id: string;
  email: string | null;
  role: 'admin' | 'member';
  createdAt: string;
  expiresAt: string;
}

export class InvitationInvalidError extends AppError {
  constructor() {
    // One code and message for unknown / expired / revoked / already used.
    super(404, 'INVITATION_INVALID', 'This invitation is invalid or has expired');
  }
}

export class InvitationEmailMismatchError extends AppError {
  constructor() {
    super(403, 'INVITATION_EMAIL_MISMATCH', 'This invitation was sent to a different email address');
  }
}

class LastOwnerError extends ConflictError {
  constructor() {
    super('LAST_OWNER', 'A firm must keep at least one owner');
  }
}

function toOrgPayload(org: OrganizationRow, role: OrgRole): OrgPayload {
  return { id: org.id, name: org.name, plan: org.plan, role, createdAt: org.created_at };
}

export function toMemberPayload(m: OrgMemberRow): MemberPayload {
  return { userId: m.user_id, email: m.email, displayName: m.display_name, role: m.role, joinedAt: m.created_at };
}

function toInvitationPayload(i: InvitationRow): InvitationPayload {
  return { id: i.id, email: i.email, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at };
}

export function hashInvitationToken(token: string): string {
  return sha256Hex(Buffer.from(token, 'utf8'));
}

/**
 * Firm and membership management (crmex.md §15.2, §15.6, §15.7). Every
 * function takes the membership-verified orgId/role from the request (never
 * the body) and re-reads the target membership from the database.
 *
 * Concurrency caveat (no transactions through PostgREST, no new SQL
 * functions): the last-owner rule is enforced check-then-act with a
 * post-write recount that compensates (restores the row / role) if the firm
 * was left ownerless. Two owners demoting or removing each other at the
 * same instant can both pass the pre-check; the recount then reverts at
 * least one of them, but there is a brief window in which the firm has no
 * owner. A `security definer` SQL function would close this fully.
 */
export function createOrgService(deps: OrgServiceDeps) {
  const nowIso = () => new Date(deps.now()).toISOString();

  async function audit(orgId: string, actorId: string, action: OrgAuditAction, entity: string, entityId: string) {
    try {
      await deps.auditRepo.orgEvent({ orgId, actorId, action, entity, entityId });
    } catch (err) {
      // The membership change has already happened; failing the request now
      // would tell the client it didn't. Surface loudly in the server log.
      // eslint-disable-next-line no-console
      console.error('org audit write failed:', action, orgId, (err as Error).message);
    }
  }

  async function assertOwnersRemain(orgId: string, compensate: () => Promise<void>): Promise<void> {
    if ((await deps.orgsRepo.countOwners(orgId)) > 0) return;
    await compensate();
    throw new LastOwnerError();
  }

  return {
    async listMyOrgs(userId: string): Promise<OrgPayload[]> {
      const memberships = await deps.orgsRepo.listMembershipsForUser(userId);
      const orgs = await deps.orgsRepo.getOrgsByIds(memberships.map((m) => m.org_id));
      const byId = new Map(orgs.map((o) => [o.id, o]));
      return memberships
        .filter((m) => byId.has(m.org_id))
        .map((m) => toOrgPayload(byId.get(m.org_id)!, m.role));
    },

    async createOrg(caller: Caller, name: string): Promise<OrgPayload> {
      const org = await deps.orgsRepo.createOrg(name, caller.userId);
      try {
        const added = await deps.orgsRepo.addMember({
          orgId: org.id,
          userId: caller.userId,
          role: 'owner',
          email: caller.email,
          displayName: caller.displayName,
        });
        if (added.conflict) throw new Error('owner membership already exists for a brand-new org');
      } catch (err) {
        // Never leave an ownerless firm behind.
        await deps.orgsRepo.deleteOrg(org.id).catch(() => {});
        throw err;
      }
      await audit(org.id, caller.userId, 'member.add', 'org_member', caller.userId);
      return toOrgPayload(org, 'owner');
    },

    async listMembers(orgId: string): Promise<MemberPayload[]> {
      return (await deps.orgsRepo.listMembers(orgId)).map(toMemberPayload);
    },

    /** Owner only (enforced by the route); last owner may not be demoted. */
    async changeRole(orgId: string, actorId: string, targetUserId: string, role: OrgRole): Promise<MemberPayload> {
      const target = await deps.orgsRepo.getMembership(orgId, targetUserId);
      if (!target) throw new NotFoundError('Member not found');
      if (target.role === role) return toMemberPayload(target);

      if (target.role === 'owner' && (await deps.orgsRepo.countOwners(orgId)) <= 1) throw new LastOwnerError();

      const updated = await deps.orgsRepo.updateMemberRole(orgId, targetUserId, role);
      if (!updated) throw new NotFoundError('Member not found');
      if (target.role === 'owner') {
        await assertOwnersRemain(orgId, async () => {
          await deps.orgsRepo.updateMemberRole(orgId, targetUserId, 'owner');
        });
      }
      await audit(orgId, actorId, 'member.role', 'org_member', targetUserId);
      return toMemberPayload(updated);
    },

    /**
     * Anyone may remove themselves. Otherwise: owner removes anyone; admin
     * removes members only; member removes no one. Last owner never.
     */
    async removeMember(orgId: string, actorId: string, actorRole: OrgRole, targetUserId: string): Promise<void> {
      const isSelf = actorId === targetUserId;
      if (!isSelf && actorRole === 'member') throw new InsufficientRoleError();

      const target = await deps.orgsRepo.getMembership(orgId, targetUserId);
      if (!target) throw new NotFoundError('Member not found');

      if (!isSelf && actorRole === 'admin' && target.role !== 'member') {
        throw new InsufficientRoleError('Admins can remove members only');
      }
      if (target.role === 'owner' && (await deps.orgsRepo.countOwners(orgId)) <= 1) throw new LastOwnerError();

      const removed = await deps.orgsRepo.removeMember(orgId, targetUserId);
      if (!removed) throw new NotFoundError('Member not found');
      if (removed.role === 'owner') {
        await assertOwnersRemain(orgId, () => deps.orgsRepo.restoreMember(removed));
      }
      await audit(orgId, actorId, 'member.remove', 'org_member', targetUserId);
    },

    async listPendingInvitations(orgId: string): Promise<InvitationPayload[]> {
      return (await deps.invitationsRepo.listPending(orgId, nowIso())).map(toInvitationPayload);
    },

    /** Owner may invite admin|member; admin may invite member only (route already excluded members). */
    async createInvitation(
      orgId: string,
      actorId: string,
      actorRole: OrgRole,
      input: { email: string | null; role: 'admin' | 'member' },
    ): Promise<{ invitation: InvitationPayload; token: string; inviteUrl: string }> {
      if (actorRole === 'member' || (actorRole === 'admin' && input.role !== 'member')) {
        throw new InsufficientRoleError(actorRole === 'admin' ? 'Admins can invite members only' : undefined);
      }
      const token = randomBytes(32).toString('base64url');
      const row = await deps.invitationsRepo.create({
        orgId,
        email: input.email,
        role: input.role,
        tokenHash: hashInvitationToken(token),
        createdBy: actorId,
        expiresAt: new Date(deps.now() + INVITATION_TTL_MS).toISOString(),
      });
      await audit(orgId, actorId, 'invitation.create', 'org_invitation', row.id);
      return { invitation: toInvitationPayload(row), token, inviteUrl: INVITE_URL_PREFIX + token };
    },

    async revokeInvitation(orgId: string, actorId: string, invitationId: string): Promise<void> {
      const revoked = await deps.invitationsRepo.revoke(orgId, invitationId, nowIso());
      if (!revoked) throw new NotFoundError('Invitation not found');
      await audit(orgId, actorId, 'invitation.revoke', 'org_invitation', invitationId);
    },

    async acceptInvitation(caller: Caller, token: string): Promise<OrgPayload> {
      const tokenHash = hashInvitationToken(token);
      const invitation = await deps.invitationsRepo.getByTokenHash(tokenHash);
      const now = deps.now();
      if (
        !invitation ||
        invitation.accepted_at ||
        invitation.revoked_at ||
        new Date(invitation.expires_at).getTime() <= now
      ) {
        throw new InvitationInvalidError();
      }

      const org = await deps.orgsRepo.getOrg(invitation.org_id);
      if (!org) throw new InvitationInvalidError();

      // Already a member: return the existing membership, consume nothing, change no role.
      const existing = await deps.orgsRepo.getMembership(invitation.org_id, caller.userId);
      if (existing) return toOrgPayload(org, existing.role);

      if (invitation.email) {
        const matches =
          caller.emailVerified && !!caller.email && caller.email.trim().toLowerCase() === invitation.email.trim().toLowerCase();
        if (!matches) throw new InvitationEmailMismatchError();
      }

      const claimed = await deps.invitationsRepo.claim(invitation.id, tokenHash, caller.userId, new Date(now).toISOString());
      if (!claimed) throw new InvitationInvalidError();

      let added;
      try {
        added = await deps.orgsRepo.addMember({
          orgId: invitation.org_id,
          userId: caller.userId,
          role: invitation.role,
          email: caller.email,
          displayName: caller.displayName,
        });
      } catch (err) {
        await deps.invitationsRepo.unclaim(invitation.id, caller.userId).catch(() => {});
        throw err;
      }

      if (added.conflict) {
        // The caller became a member concurrently (e.g. via another invitation):
        // give this one back and return what they already have.
        await deps.invitationsRepo.unclaim(invitation.id, caller.userId).catch(() => {});
        const membership = await deps.orgsRepo.getMembership(invitation.org_id, caller.userId);
        if (!membership) throw new InvitationInvalidError();
        return toOrgPayload(org, membership.role);
      }

      await audit(invitation.org_id, caller.userId, 'invitation.accept', 'org_invitation', invitation.id);
      await audit(invitation.org_id, caller.userId, 'member.add', 'org_member', caller.userId);
      return toOrgPayload(org, added.row.role);
    },
  };
}

export type OrgService = ReturnType<typeof createOrgService>;

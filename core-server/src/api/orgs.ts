import { Router, type Request } from 'express';
import { z } from 'zod';
import type { OrgService, Caller } from '../agent/orgService';
import type { OrgsRepo } from '../repositories/orgsRepo';
import { requireOrgMember, requireOrgRole } from '../auth/orgMiddleware';

const CreateOrgSchema = z.object({ name: z.string().trim().min(1).max(120) });
const ChangeRoleSchema = z.object({ role: z.enum(['owner', 'admin', 'member']) });
const CreateInvitationSchema = z.object({
  // Optional; empty string is treated as "no email" (QR/link invitation).
  email: z
    .union([z.string().trim().toLowerCase().email().max(320), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  role: z.enum(['admin', 'member']),
});
// Path ids are only ever compared against rows already scoped by the verified org.
const UserIdParam = z.string().min(1).max(128);
const InvitationIdParam = z.string().uuid();

export function callerFrom(req: Request): Caller {
  return {
    userId: req.userId!,
    email: req.userEmail ?? null,
    emailVerified: req.userEmailVerified ?? false,
    displayName: req.userDisplayName ?? null,
  };
}

/**
 * /api/v1/orgs — firm creation and membership management (crmex.md §15.2).
 * No X-Org-Id here: the :orgId path param is the selector, and
 * requireOrgMember verifies it against org_members on every request.
 * Nothing about identity, firm or role is read from a request body.
 */
export function createOrgsRouter(deps: { orgService: OrgService; orgsRepo: OrgsRepo }): Router {
  const router = Router();
  const member = requireOrgMember(deps.orgsRepo, 'param');
  const { orgService } = deps;

  router.get('/', async (req, res, next) => {
    try {
      res.status(200).json({ orgs: await orgService.listMyOrgs(req.userId!) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { name } = CreateOrgSchema.parse(req.body);
      res.status(201).json({ org: await orgService.createOrg(callerFrom(req), name) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:orgId/members', member, async (req, res, next) => {
    try {
      res.status(200).json({ members: await orgService.listMembers(req.orgId!) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:orgId/members/:userId', member, requireOrgRole('owner'), async (req, res, next) => {
    try {
      const targetUserId = UserIdParam.parse(req.params.userId);
      const { role } = ChangeRoleSchema.parse(req.body);
      res.status(200).json({ member: await orgService.changeRole(req.orgId!, req.userId!, targetUserId, role) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:orgId/members/:userId', member, async (req, res, next) => {
    try {
      const targetUserId = UserIdParam.parse(req.params.userId);
      await orgService.removeMember(req.orgId!, req.userId!, req.orgRole!, targetUserId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get('/:orgId/invitations', member, requireOrgRole('owner', 'admin'), async (req, res, next) => {
    try {
      res.status(200).json({ invitations: await orgService.listPendingInvitations(req.orgId!) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:orgId/invitations', member, requireOrgRole('owner', 'admin'), async (req, res, next) => {
    try {
      const input = CreateInvitationSchema.parse(req.body);
      const result = await orgService.createInvitation(req.orgId!, req.userId!, req.orgRole!, input);
      // The plaintext token exists only in this response; only its hash is stored.
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:orgId/invitations/:invitationId', member, requireOrgRole('owner', 'admin'), async (req, res, next) => {
    try {
      const parsed = InvitationIdParam.safeParse(req.params.invitationId);
      if (!parsed.success) {
        // Same answer as "no such pending invitation in this firm".
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitation not found' } });
        return;
      }
      await orgService.revokeInvitation(req.orgId!, req.userId!, parsed.data);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** POST /api/v1/invitations/accept — the token is the only input; email comes from the verified user. */
export function createInvitationsRouter(deps: { orgService: OrgService }): Router {
  const router = Router();
  const AcceptSchema = z.object({ token: z.string().min(1).max(200) });

  router.post('/accept', async (req, res, next) => {
    try {
      const { token } = AcceptSchema.parse(req.body);
      res.status(200).json({ org: await deps.orgService.acceptInvitation(callerFrom(req), token) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

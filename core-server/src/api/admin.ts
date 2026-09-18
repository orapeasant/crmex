import { Router } from 'express';
import { requireAdmin } from '../auth/adminMiddleware';
import type { OrgsRepo } from '../repositories/orgsRepo';
import type { AuditRepo } from '../repositories/auditRepo';
import { toMemberPayload } from '../agent/orgService';
import { isUuid } from '../lib/paths';
import { NotFoundError } from '../lib/errors';

export interface AdminRouterDeps {
  orgsRepo: OrgsRepo;
  auditRepo: AuditRepo;
}

/**
 * Operator routes (crmex.md §13, §15.8). The admin portal itself is not
 * built; these exist so the role gate is exercised end to end (ROLE-01..05)
 * and so the operator can read the tenant directory: firms (name, plan,
 * created date, seat count) and each firm's members (name, email, role,
 * joined date). They read ONLY organizations and org_members — never a firm
 * data table (clients, message_history, image_sessions, usage, prompts).
 *
 * Every directory read is written to admin_audit_log BEFORE the data is
 * read; if the audit write fails, the read is refused (fail closed).
 */
export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();

  router.get('/_ping', requireAdmin, (req, res) => {
    res.status(200).json({ ok: true, role: req.userRole });
  });

  router.get('/orgs', requireAdmin, async (req, res, next) => {
    try {
      await deps.auditRepo.adminEvent({ actorId: req.userId!, action: 'directory.orgs.read' });
      const [orgs, counts] = await Promise.all([deps.orgsRepo.listAllOrgs(), deps.orgsRepo.countMembersByOrg()]);
      res.status(200).json({
        orgs: orgs.map((o) => ({ id: o.id, name: o.name, plan: o.plan, createdAt: o.created_at, memberCount: counts.get(o.id) ?? 0 })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/orgs/:orgId/members', requireAdmin, async (req, res, next) => {
    try {
      const orgId = req.params.orgId;
      if (!isUuid(orgId)) throw new NotFoundError('Firm not found');
      await deps.auditRepo.adminEvent({ actorId: req.userId!, action: 'directory.members.read', scope: { org_id: orgId.toLowerCase() } });
      const org = await deps.orgsRepo.getOrg(orgId.toLowerCase());
      if (!org) throw new NotFoundError('Firm not found');
      const members = await deps.orgsRepo.listMembers(org.id);
      res.status(200).json({ members: members.map(toMemberPayload) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Used by the ROLE-05 route-coverage test to enumerate every admin route. */
export const ADMIN_ROUTE_PATHS = ['/_ping', '/orgs', '/orgs/:orgId/members'] as const;

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { OrgRole, OrgsRepo } from '../repositories/orgsRepo';
import { isUuid } from '../lib/paths';
import { InsufficientRoleError, NotAMemberError, OrgRequiredError } from '../lib/errors';

export const ORG_HEADER = 'x-org-id';

/**
 * Firm membership gate (crmex.md §15.4 layer 2). The X-Org-Id header (or the
 * :orgId path param on org-management routes) is only a SELECTOR: the
 * caller's membership is looked up in org_members for (org_id, JWT user_id)
 * on every request — never cached — so a removed member loses access on
 * their very next request (§15.6). A platform admin gets nothing here by
 * virtue of app_metadata.role; only a membership row counts.
 *
 * Unknown firm and not-a-member return the identical 403 NOT_A_MEMBER, so
 * firm ids can't be probed. Must run after createAuthMiddleware.
 */
export function requireOrgMember(orgsRepo: OrgsRepo, source: 'header' | 'param'): RequestHandler {
  return async function orgMemberMiddleware(req: Request, _res: Response, next: NextFunction) {
    try {
      const raw = source === 'header' ? req.header(ORG_HEADER) : req.params.orgId;
      const selected = typeof raw === 'string' ? raw.trim() : '';
      if (!isUuid(selected)) throw new OrgRequiredError();
      const orgId = selected.toLowerCase();

      const membership = await orgsRepo.getMembership(orgId, req.userId!);
      if (!membership) throw new NotAMemberError();

      req.orgId = orgId;
      req.orgRole = membership.role;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Role gate for org-management routes. Must run after requireOrgMember. */
export function requireOrgRole(...roles: OrgRole[]): RequestHandler {
  return function orgRoleMiddleware(req: Request, _res: Response, next: NextFunction) {
    if (!req.orgRole || !roles.includes(req.orgRole)) return next(new InsufficientRoleError());
    next();
  };
}

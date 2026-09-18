import type { NextFunction, Request, Response } from 'express';

/**
 * Admin role gate (crmex.md §13.1, §13.8). Distinct from the normal user
 * auth middleware on purpose: a missing check on a user route can never
 * accidentally expose an admin capability, and this one has a single job
 * that's easy to audit (ROLE-05's route-coverage test asserts every
 * /admin/* route carries this exact function in its middleware stack).
 * Must run AFTER createAuthMiddleware (needs req.userRole already set).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin role required' } });
  }
  next();
}

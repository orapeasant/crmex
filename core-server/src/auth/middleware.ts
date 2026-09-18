import type { NextFunction, Request, Response } from 'express';
import type { SupabaseLike } from '../db/types';

/**
 * Verifies every request's Supabase access token via supabase.auth.getUser
 * (crmex.md §5). user_id is derived ONLY from the verified token and
 * attached to req.userId — it is never read from the request body, a query
 * parameter, or a header (crmex.md §4 / test-plan.md ISO-12). Role comes
 * from app_metadata.role only (crmex.md §13.1 / ROLE-02) — user_metadata is
 * never consulted, because it is self-editable by the session owner.
 */
export function createAuthMiddleware(supabase: SupabaseLike) {
  return async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    if (!header || !/^Bearer\s+.+/i.test(header)) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing bearer token' } });
    }
    const token = header.replace(/^Bearer\s+/i, '').trim();

    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      }
      req.userId = data.user.id;
      req.userRole = data.user.app_metadata?.role === 'admin' ? 'admin' : 'user';
      req.userEmail = data.user.email ?? null;
      req.userEmailVerified = Boolean(data.user.email && data.user.email_confirmed_at);
      const meta = data.user.user_metadata ?? {};
      const displayName = typeof meta.full_name === 'string' && meta.full_name ? meta.full_name : meta.name;
      req.userDisplayName = typeof displayName === 'string' && displayName ? displayName.slice(0, 200) : null;
      next();
    } catch {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Token verification failed' } });
    }
  };
}

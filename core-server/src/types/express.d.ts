// Augments Express's Request with the JWT-derived identity attached by
// src/auth/middleware.ts, and the DB-verified firm membership attached by
// src/auth/orgMiddleware.ts. These are the ONLY identity fields routes may
// use (crmex.md §4/§15.4: never a body/query param, never an unverified header).
import 'express';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: 'user' | 'admin';
      /** Email from the verified auth user; null if none. */
      userEmail?: string | null;
      /** True only when Supabase Auth reports the email as confirmed. */
      userEmailVerified?: boolean;
      /** Display only (user_metadata is user-writable) — never used for authorization. */
      userDisplayName?: string | null;
      /** Set only after org_members was checked for (orgId, userId) on THIS request. */
      orgId?: string;
      orgRole?: 'owner' | 'admin' | 'member';
    }
  }
}

export {};

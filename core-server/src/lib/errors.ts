// Typed error classes mapped to HTTP status codes by the route error handler
// (src/api/errorHandler.ts). Keeping these narrow means route handlers throw
// intent ("quota exceeded", "not found") rather than constructing responses
// inline everywhere.

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class QuotaExceededError extends AppError {
  constructor(message: string) {
    super(429, 'QUOTA_EXCEEDED', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, 'VALIDATION_ERROR', message);
  }
}

export class ProviderError extends AppError {
  constructor(message: string, code: string = 'PROVIDER_ERROR') {
    super(502, code, message);
  }
}

export class ProviderTimeoutError extends AppError {
  constructor(message = 'Provider request timed out') {
    super(504, 'PROVIDER_TIMEOUT', message);
  }
}

// --- Firm tenancy (crmex.md §15) -------------------------------------------

/** X-Org-Id (or :orgId) missing or not a UUID. */
export class OrgRequiredError extends AppError {
  constructor(message = 'A firm must be selected (X-Org-Id header with a firm id)') {
    super(400, 'ORG_REQUIRED', message);
  }
}

/**
 * Caller has no membership in the selected firm. Deliberately the same
 * response whether the firm exists or not, so ids can't be probed.
 */
export class NotAMemberError extends AppError {
  constructor() {
    super(403, 'NOT_A_MEMBER', 'You are not a member of this firm');
  }
}

/** Caller is a member, but their firm role doesn't permit this action. */
export class InsufficientRoleError extends AppError {
  constructor(message = 'Your role in this firm does not permit this action') {
    super(403, 'INSUFFICIENT_ROLE', message);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}

/** Transient: a compare-and-set on a shared counter kept losing races. Safe to retry. */
export class ContentionError extends AppError {
  constructor(message = 'The server is busy, please retry') {
    super(503, 'CONTENTION', message);
  }
}

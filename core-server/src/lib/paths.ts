// Storage object path construction and validation — crmex.md §3.3 / §4,
// test-plan.md ISO-15..19.
//
// The current API surface (POST /images/generate|refine|search/select) never
// accepts a client-supplied storage path — every path this server writes is
// built exclusively from the JWT-derived user_id and a server-computed
// content hash (see buildObjectPath). assertSafeReference below exists as a
// defense-in-depth guard for any future code path that might accept a
// client-supplied reference (e.g. a relative filename), so that a mistake
// elsewhere in the codebase cannot become a path-traversal bug. It is unit
// tested directly (ISO-15..18) even though nothing in the current contract
// calls it from a route handler.

// Real Supabase user ids are always UUIDs. This validator accepts any
// "safe token" shape rather than strictly requiring UUID syntax, so it
// remains usable with readable fixture ids (e.g. 'user-a') in tests without
// weakening the actual guarantee: no slash, no dot-segment, no whitespace —
// nothing that could act as a path separator or traversal component can
// pass this check, which is what ISO-19 actually cares about.
const SAFE_USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Builds the canonical storage object path for a firm member's image
 * (crmex.md §15.4). ISO-19: the result is exactly
 * `<org_id>/<user_id>/<sha256>.png` and the function accepts no
 * client-supplied path component — only a membership-verified org id, the
 * JWT-derived user id and a server-computed hash. The org id must be a UUID:
 * Storage's folder policy casts the first folder to uuid.
 */
export function buildObjectPath(orgId: string, userId: string, sha256Hex: string): string {
  if (!isUuid(orgId)) {
    throw new Error('INVALID_ORG_ID: expected a UUID');
  }
  if (typeof userId !== 'string' || !SAFE_USER_ID_RE.test(userId)) {
    throw new Error('INVALID_USER_ID: expected a safe user id (UUID in production)');
  }
  if (typeof sha256Hex !== 'string' || !SHA256_HEX_RE.test(sha256Hex)) {
    throw new Error('INVALID_HASH: expected 64 lowercase hex chars');
  }
  return `${orgId.toLowerCase()}/${userId}/${sha256Hex}.png`;
}

/**
 * True only for a path this server could have built for `orgId`: exactly
 * three segments, the first equal to the org id. Used before downloading or
 * signing a path read back from the database, so a corrupted or legacy row
 * can never yield another firm's object.
 */
export function isPathInOrg(path: unknown, orgId: string): boolean {
  return isCanonicalOrgPath(path, orgId);
}

/**
 * Pre-tenancy objects live at `<user_id>/<sha256>.png` and were not moved by
 * the multi-tenancy migration. Only the shape is checked here: ownership comes
 * from the image_sessions row, which the caller has already loaded scoped to
 * the verified org (the migration assigned every legacy row to one firm).
 */
export function isLegacyUserPath(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  const parts = path.split('/');
  return parts.length === 2 && SAFE_USER_ID_RE.test(parts[0]) && /^[0-9a-f]{64}\.png$/.test(parts[1]);
}

/**
 * Whether core-server may download/sign `path` for a session row already
 * loaded with `.eq('org_id', orgId)`: a canonical path under that firm, or a
 * legacy per-user path. A canonical path under ANY other firm is refused, so
 * a corrupted row can never yield another firm's current objects.
 */
export function isServableSessionPath(path: unknown, orgId: string): boolean {
  return isCanonicalOrgPath(path, orgId) || isLegacyUserPath(path);
}

function isCanonicalOrgPath(path: unknown, orgId: string): boolean {
  if (typeof path !== 'string' || !isUuid(orgId)) return false;
  const parts = path.split('/');
  return (
    parts.length === 3 &&
    parts[0] === orgId.toLowerCase() &&
    SAFE_USER_ID_RE.test(parts[1]) &&
    /^[0-9a-f]{64}\.png$/.test(parts[2])
  );
}

export class UnsafeReferenceError extends Error {
  constructor(reason: string) {
    super(`UNSAFE_REFERENCE: ${reason}`);
    this.name = 'UnsafeReferenceError';
  }
}

/**
 * Defense-in-depth validator for any client-supplied string that might be
 * used to derive a storage reference. Rejects:
 *  - empty / null / non-string values                       (ISO-18)
 *  - `..` path traversal segments, including URL-encoded and
 *    double-encoded forms (`%2e%2e%2f`, `%252e%252e%252f`)   (ISO-15, ISO-17)
 *  - absolute paths (POSIX `/...`, Windows `\...` or `C:\...`) (ISO-16)
 *  - embedded NUL bytes
 * Returns the decoded, validated string on success.
 */
export function assertSafeReference(ref: unknown): string {
  if (ref === null || ref === undefined) {
    throw new UnsafeReferenceError('reference is null/undefined');
  }
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new UnsafeReferenceError('reference is empty or not a string');
  }

  // Decode repeatedly to catch double/triple URL-encoding. Bounded loop so a
  // pathological input cannot spin forever.
  let decoded = ref;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break; // malformed escape sequence — fall through to the checks below
    }
    if (next === decoded) break;
    decoded = next;
  }

  if (decoded.includes('\0')) {
    throw new UnsafeReferenceError('embedded NUL byte');
  }
  if (decoded.includes('..')) {
    throw new UnsafeReferenceError('path traversal segment');
  }
  if (decoded.startsWith('/') || decoded.startsWith('\\')) {
    throw new UnsafeReferenceError('absolute path');
  }
  if (/^[a-zA-Z]:[\\/]/.test(decoded)) {
    throw new UnsafeReferenceError('absolute path (drive letter)');
  }

  return decoded;
}

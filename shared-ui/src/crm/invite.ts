// Invitation tokens arrive from untrusted places (a scanned QR code, a pasted
// string, a deep link). They are only a claim — core-server validates them —
// but parsing is strict so arbitrary text never reaches the accept request.
// core-server mints tokens as randomBytes(32).toString('base64url') (43 chars).

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * Accepts a bare token, `crmex://invite/<token>`, or an http(s) URL whose path
 * ends in `/invite/<token>` (the browser route). Returns null for anything else.
 */
export function parseInviteToken(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length === 0 || s.length > 512) return null;

  if (TOKEN_RE.test(s)) return s;

  const custom = /^crmex:\/\/invite\/([^/?#]+)\/?$/i.exec(s);
  if (custom) return TOKEN_RE.test(custom[1]) ? custom[1] : null;

  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    const m = /\/invite\/([^/]+)\/?$/.exec(url.pathname);
    return m && TOKEN_RE.test(m[1]) ? m[1] : null;
  }
  return null;
}

/** Friendly message for the accept errors core-server returns. */
export function describeInviteError(code: string | undefined, fallback: string): string {
  switch (code) {
    case 'INVITATION_INVALID':
      return 'This invitation is invalid, has already been used, or has expired. Ask for a new one.';
    case 'INVITATION_EMAIL_MISMATCH':
      return 'This invitation was sent to a different email address. Sign in with that account, or ask for a new invitation.';
    default:
      return fallback;
  }
}

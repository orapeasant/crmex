import type { RequestHandler } from 'express';

/**
 * Origins the app's WebViews load from: Capacitor Android (https://localhost,
 * its default androidScheme) and iOS/Electron-style capacitor://localhost.
 * Override with CORS_ALLOWED_ORIGINS (comma-separated) when deploying.
 */
export const DEFAULT_CORS_ORIGINS = ['https://localhost', 'capacitor://localhost'];

export function parseCorsOrigins(value: string | undefined): string[] {
  if (!value || value.trim() === '') return DEFAULT_CORS_ORIGINS;
  return value
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Allow-list CORS. Runs before auth so a browser's preflight (which never
 * carries the Authorization header) isn't rejected with 401. Auth is by bearer
 * token, not cookies, so credentials are not enabled.
 */
export function createCorsMiddleware(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Org-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(origin && allowed.has(origin) ? 204 : 403).end();
      return;
    }
    next();
  };
}

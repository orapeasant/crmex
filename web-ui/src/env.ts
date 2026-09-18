// Env-driven config (Vite inlines import.meta.env.VITE_* at build time — every value here ends up
// in the public browser bundle). Real values come from web-ui/.env; see web-ui/README.md.
export const CORE_SERVER_BASE_URL: string = import.meta.env.VITE_CORE_SERVER_URL ?? 'http://localhost:8080/api/v1';

export function getSupabaseEnv(): Record<string, string | undefined> {
  return {
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  };
}

/**
 * Returns an error message when the configured key is not safe to ship to a browser.
 * A service_role key bypasses RLS and Storage policies; in a bundle it would be a critical leak.
 * Legacy Supabase keys are JWTs with a `role` claim; the newer opaque keys are prefixed
 * `sb_publishable_` (browser-safe) or `sb_secret_` (server-only).
 */
export function checkBrowserSafeKey(key: string | undefined): string | null {
  if (!key) return null; // missing config is reported by the sign-in screen
  if (key.startsWith('sb_secret_')) return 'VITE_SUPABASE_ANON_KEY is a Supabase secret key.';
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))) as { role?: unknown };
    if (payload.role === 'service_role') return 'VITE_SUPABASE_ANON_KEY is a service_role key.';
    if (payload.role !== 'anon') return `VITE_SUPABASE_ANON_KEY has unexpected role "${String(payload.role)}"; expected "anon".`;
  } catch {
    return 'VITE_SUPABASE_ANON_KEY is not a readable Supabase key.';
  }
  return null;
}

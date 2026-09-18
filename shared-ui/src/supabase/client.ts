// Supabase client factory. Env-driven placeholder — there is no real
// Supabase project to point at during this build (per the project brief),
// so callers inject config and tests inject a mock SupabaseClient instead of
// hitting the network. @supabase/supabase-js has no platform-specific code
// paths, so this file is safe to live in shared-ui.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

/**
 * Reads config from environment variables when available (Vite-style
 * `import.meta.env` on the web bundle, or process.env under test/node).
 * Throws with a clear message rather than silently constructing a client
 * against an empty string, since that failure mode is confusing later.
 */
export function readSupabaseConfigFromEnv(env: Record<string, string | undefined>): SupabaseConfig {
  const url = env.VITE_SUPABASE_URL ?? env.SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Missing Supabase config: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see android/README.md).',
    );
  }
  return { url, anonKey };
}

export interface SupabaseClientOptions {
  /**
   * Browser shells sign in with the OAuth redirect flow (§15.10): the client
   * must pick the PKCE `?code=` up from the URL on return. Android uses native
   * Google Sign-In, not the redirect flow (crmex.md §5), so this defaults off.
   */
  oauthRedirect?: boolean;
}

export function createSupabaseClient(config: SupabaseConfig, options: SupabaseClientOptions = {}): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: options.oauthRedirect ?? false,
      ...(options.oauthRedirect ? { flowType: 'pkce' as const } : {}),
    },
  });
}

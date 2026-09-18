// Env-driven config (Vite exposes import.meta.env.VITE_* at build time).
// Real values are supplied at build time via android/.env — see android/README.md.
export const CORE_SERVER_BASE_URL: string = import.meta.env.VITE_CORE_SERVER_URL ?? 'http://10.0.2.2:8080/api/v1';

export function getSupabaseEnv(): Record<string, string | undefined> {
  return {
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  };
}

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { createApp } from './app';
import { createDraftLlmProvider, createImageGenProvider, createImageSearchProvider, createLlmProvider } from './providers/factory';
import type { SupabaseLike } from './db/types';
import { parseCorsOrigins } from './lib/cors';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}. See core-server/.env.example.`);
  }
  return value;
}

function main() {
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  // core-server holds the service role key, which bypasses RLS entirely
  // (crmex.md §4) — every repository in src/repositories/* is responsible
  // for its own user_id scoping. Cast to our narrow SupabaseLike interface
  // (src/db/types.ts) rather than depending on the full supabase-js surface.
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  }) as unknown as SupabaseLike;

  const llmProvider = createLlmProvider(process.env);
  const draftLlmProvider = createDraftLlmProvider(process.env);
  const imageGenProvider = createImageGenProvider(process.env);
  const imageSearchProvider = createImageSearchProvider(process.env);

  const app = createApp({
    supabase,
    llmProvider,
    draftLlmProvider,
    imageGenProvider,
    imageSearchProvider,
    imageProviderTimeoutMs: process.env.IMAGE_PROVIDER_TIMEOUT_MS ? Number(process.env.IMAGE_PROVIDER_TIMEOUT_MS) : undefined,
    signedUrlTtlSeconds: process.env.SIGNED_URL_TTL_SECONDS ? Number(process.env.SIGNED_URL_TTL_SECONDS) : undefined,
    corsAllowedOrigins: parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS),
  });

  const port = process.env.PORT ? Number(process.env.PORT) : 8080;
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`core-server listening on :${port}`);
  });
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error((err as Error).message);
  process.exit(1);
}

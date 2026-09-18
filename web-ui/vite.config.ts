import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** Fail fast before a server-only Supabase key can be inlined into the public bundle (the app also checks at startup). */
function assertBrowserSafeKey(key: string | undefined): void {
  if (!key) return;
  const fail = () => {
    throw new Error('VITE_SUPABASE_ANON_KEY is a Supabase service_role/secret key. Use the anon (public) key in web-ui/.env.');
  };
  if (key.startsWith('sb_secret_')) fail();
  const payload = key.split('.')[1];
  if (!payload) return;
  try {
    if ((JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { role?: unknown }).role === 'service_role') fail();
  } catch (err) {
    if (err instanceof SyntaxError) return; // not a JWT; the runtime check reports it
    throw err;
  }
}

export default defineConfig(({ mode }) => {
  // Skipped when the runtime guard itself is being exercised (CRMEX_SKIP_KEY_CHECK=1, dev only).
  if (!(mode === 'development' && process.env.CRMEX_SKIP_KEY_CHECK === '1')) {
    assertBrowserSafeKey(loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_ANON_KEY);
  }
  return {
    plugins: [react(), tailwindcss()],
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    resolve: {
      // shared-ui is consumed as TS source through a file: link and has its own node_modules;
      // make sure the app and shared-ui share one React and one Supabase client library.
      dedupe: ['react', 'react-dom', '@supabase/supabase-js', 'libphonenumber-js', 'qrcode'],
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    // core-server's CORS allows http://localhost:5173 and Supabase's redirect URL is registered for it.
    server: { port: 5173, strictPort: true },
    preview: { port: 5173, strictPort: true },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // Long-lived vendor chunks, so an app release doesn't re-download libraries.
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (/[\/](react|react-dom|scheduler|react-router)[\/]/.test(id)) return 'vendor-react';
            if (id.includes('@supabase')) return 'vendor-supabase';
            if (id.includes('libphonenumber-js')) return 'vendor-phone';
            if (/radix-ui|@radix-ui|cmdk|sonner|@floating-ui/.test(id)) return 'vendor-ui';
            return undefined;
          },
        },
      },
    },
  };
});

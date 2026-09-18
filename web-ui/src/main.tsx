import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createSupabaseClient, readSupabaseConfigFromEnv } from 'shared-ui';
import './index.css';
import { createBrowserPlatform } from './browserPlatform';
import { CORE_SERVER_BASE_URL, checkBrowserSafeKey, getSupabaseEnv } from './env';
import { PortalRoot } from './portal/PortalRoot';
import { applyTheme } from './portal/lib/theme';

applyTheme();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');
const root = createRoot(rootEl);

const env = getSupabaseEnv();
const keyProblem = checkBrowserSafeKey(env.VITE_SUPABASE_ANON_KEY);

if (keyProblem) {
  // Refuse to start: no Supabase client is created with this key.
  console.error(`[crmex] Refusing to start: ${keyProblem}`);
  root.render(
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <div role="alert" className="flex w-full max-w-lg flex-col gap-3 rounded-xl border border-red-200 bg-card p-8 shadow-sm">
        <h1 className="text-xl font-semibold">Unsafe configuration</h1>
        <p className="text-sm text-red-800">
          {keyProblem} Browser builds must use the Supabase <strong>anon</strong> (public) key. A service role key bypasses row-level security and must never be shipped to a
          browser — rotate it if this build was shared, then set the anon key in <code>web-ui/.env</code> and restart.
        </p>
      </div>
    </div>,
  );
} else if (import.meta.env.DEV && isPreviewRequested()) {
  // Dev-only preview harness with an in-memory fake data layer. `import.meta.env.DEV` is statically
  // false in production builds, so this branch and the harness module are removed from the bundle.
  void import('./dev/preview').then((m) => m.renderPreview(root));
} else {
  const platform = createBrowserPlatform(__APP_VERSION__);

  let supabase = null;
  try {
    supabase = createSupabaseClient(readSupabaseConfigFromEnv(env), { oauthRedirect: true });
  } catch (err) {
    console.warn('[crmex] Supabase not configured yet:', err);
  }

  root.render(
    <StrictMode>
      <PortalRoot platform={platform} supabase={supabase} coreServerUrl={CORE_SERVER_BASE_URL} />
    </StrictMode>,
  );
}

function isPreviewRequested(): boolean {
  try {
    const p = new URLSearchParams(window.location.search).get('preview');
    if (p === '0') sessionStorage.removeItem('crmex:devPreview');
    else if (p !== null) sessionStorage.setItem('crmex:devPreview', '1');
    return sessionStorage.getItem('crmex:devPreview') === '1';
  } catch {
    return false;
  }
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CrmexApp, createSupabaseClient, readSupabaseConfigFromEnv } from 'shared-ui';
import 'shared-ui/src/app/styles.css';
import { CORE_SERVER_BASE_URL, getSupabaseEnv } from './env.js';
import { createCapacitorPlatform } from './native/CapacitorPlatform.js';

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

const platform = createCapacitorPlatform(__APP_VERSION__);

let supabase = null;
try {
  supabase = createSupabaseClient(readSupabaseConfigFromEnv(getSupabaseEnv()));
} catch (err) {
  console.warn('[crmex] Supabase not configured yet:', err);
}

createRoot(root).render(
  <StrictMode>
    <CrmexApp platform={platform} supabase={supabase} coreServerUrl={CORE_SERVER_BASE_URL} />
  </StrictMode>,
);

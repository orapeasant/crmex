// Headless session + provider stack shared by every shell. CrmexApp (the phone
// UI) and the desktop web portal both build on these, so auth restore, sign-in,
// sign-out purge, firm state and send capability behave identically; only the
// screens differ.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { HttpApiClient } from '../api/httpApiClient.js';
import { AppContextProvider, FirmProvider, type AppContextValue } from './context.js';
import { usePendingInvite, type PendingInvite } from './firm/invites.js';
import { MessagingProvider } from './messages/MessagingProvider.js';
import type { PlatformServices } from './platform.js';
import { profileFromUser } from './ui/Avatar.js';
import { describeError } from './ui/util.js';

export interface CrmexSessionOptions {
  platform: PlatformServices;
  /** null when Supabase isn't configured. */
  supabase: SupabaseClient | null;
  /** core-server base URL including /api/v1. */
  coreServerUrl: string;
}

export interface CrmexSession {
  sessionLoaded: boolean;
  session: Session | null;
  api: HttpApiClient;
  /** Active firm id for X-Org-Id, written synchronously by FirmProvider. */
  orgIdRef: MutableRefObject<string | null>;
  /** Non-null once signed in (and Supabase is configured). */
  app: AppContextValue | null;
  signIn: () => Promise<void>;
  signingIn: boolean;
  authError: string | null;
  invite: PendingInvite;
}

export function useCrmexSession({ platform, supabase, coreServerUrl }: CrmexSessionOptions): CrmexSession {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const orgIdRef = useRef<string | null>(null);
  const invite = usePendingInvite(platform);

  const api = useMemo(
    () =>
      new HttpApiClient({
        baseUrl: coreServerUrl,
        getAccessToken: async () => (supabase ? ((await supabase.auth.getSession()).data.session?.access_token ?? null) : null),
        getOrgId: () => orgIdRef.current,
      }),
    [supabase, coreServerUrl],
  );

  // AUTH-08: restore a prior session on relaunch without re-authenticating.
  useEffect(() => {
    if (!supabase) {
      setSessionLoaded(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionLoaded(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  const signIn = useCallback(async () => {
    setAuthError(null);
    setSigningIn(true);
    try {
      if (!supabase) throw new Error('Supabase not configured — set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
      await platform.signIn(supabase);
    } catch (err) {
      setAuthError(describeError(err));
    } finally {
      setSigningIn(false);
    }
  }, [supabase, platform]);

  const userId = session?.user.id;
  const signOut = useCallback(async () => {
    if (!supabase) return;
    orgIdRef.current = null;
    await supabase.auth.signOut();
    // ISO-13/AUTH-07: purge device-local state for the signed-out user before another account can sign in.
    if (userId) await platform.purgeUserData(userId).catch(() => {});
  }, [supabase, platform, userId]);

  const openUrl = useCallback(
    (url: string) => {
      if (platform.openUrl) platform.openUrl(url);
      else if (/^https?:/i.test(url)) window.open(url, '_blank', 'noopener');
      else window.location.href = url;
    },
    [platform],
  );

  const app = useMemo<AppContextValue | null>(
    () => (session && supabase ? { platform, supabase, api, user: session.user, profile: profileFromUser(session.user), signOut, openUrl } : null),
    [session, supabase, platform, api, signOut, openUrl],
  );

  return { sessionLoaded, session, api, orgIdRef, app, signIn, signingIn, authError, invite };
}

/**
 * App, firm and messaging context for a signed-in user. Keyed by user so no
 * firm state survives an account switch.
 */
export function CrmexProviders({ app, orgIdRef, children }: { app: AppContextValue; orgIdRef: MutableRefObject<string | null>; children: ReactNode }) {
  return (
    <AppContextProvider value={app}>
      <FirmProvider key={app.user.id} api={app.api} platform={app.platform} userId={app.user.id} orgIdRef={orgIdRef}>
        <MessagingProvider platform={app.platform} supabase={app.supabase} userId={app.user.id}>
          {children}
        </MessagingProvider>
      </FirmProvider>
    </AppContextProvider>
  );
}

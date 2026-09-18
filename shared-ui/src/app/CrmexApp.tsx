// The whole CRMEX app, shared by every shell (Android WebView, browser).
// Platform differences arrive only through `platform` (see platform.ts).
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useApp, useFirm } from './context.js';
import { AcceptInviteSheet, type PendingInvite } from './firm/invites.js';
import { Onboarding } from './firm/Onboarding.js';
import type { PlatformServices } from './platform.js';
import { CrmexProviders, useCrmexSession } from './session.js';
import { AppShell } from './shell/AppShell.js';
import { dispatchBack } from './ui/util.js';

export interface CrmexAppProps {
  platform: PlatformServices;
  /** null when Supabase isn't configured; the sign-in screen then shows the configuration error. */
  supabase: SupabaseClient | null;
  /** core-server base URL including /api/v1. */
  coreServerUrl: string;
}

export function CrmexApp({ platform, supabase, coreServerUrl }: CrmexAppProps) {
  const { sessionLoaded, app: appValue, orgIdRef, signIn: handleSignIn, signingIn, authError, invite } = useCrmexSession({ platform, supabase, coreServerUrl });

  // Hardware back: screens register handlers; unhandled presses leave the app.
  useEffect(() => {
    const bb = platform.backButton;
    if (!bb) return;
    return bb.subscribe(() => {
      if (!dispatchBack()) bb.exit();
    });
  }, [platform]);

  if (!sessionLoaded) {
    return (
      <div className="signin" style={{ alignItems: 'center' }}>
        <span className="spinner" style={{ color: 'var(--primary)' }} />
      </div>
    );
  }

  if (!appValue || !supabase) {
    return (
      <div className="signin">
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <div className="signin__logo">L</div>
          <div>
            <h1 className="section-title" style={{ fontSize: 26 }}>
              Leagentex
            </h1>
            <p className="section-subtitle">Clients, matters, deadlines and WhatsApp messaging for your firm.</p>
          </div>
        </div>
        <div className="stack">
          {invite.token && <div className="alert alert--info">Sign in to accept your firm invitation.</div>}
          <button className="btn btn--block google-btn" onClick={handleSignIn} disabled={signingIn}>
            {signingIn ? <span className="spinner" /> : <GoogleMark />}
            Continue with Google
          </button>
          {authError && <div className="alert alert--error">{authError}</div>}
        </div>
      </div>
    );
  }

  return (
    <CrmexProviders app={appValue} orgIdRef={orgIdRef}>
      <FirmGate invite={invite} />
    </CrmexProviders>
  );
}

function FirmGate({ invite }: { invite: PendingInvite }) {
  const firm = useFirm();

  if (firm.status === 'loading') {
    return (
      <div className="signin" style={{ alignItems: 'center' }}>
        <span className="spinner" style={{ color: 'var(--primary)' }} />
        <p className="muted">Loading your firms…</p>
      </div>
    );
  }

  if (firm.status === 'error') {
    return <FirmLoadError />;
  }

  return (
    <>
      {firm.activeOrg ? <AppShell /> : <Onboarding invite={invite} />}
      <AcceptInviteSheet invite={invite} />
    </>
  );
}

function FirmLoadError() {
  const firm = useFirm();
  const app = useApp();
  const [retrying, setRetrying] = useState(false);
  return (
    <div className="signin">
      <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
        <div className="signin__logo">L</div>
        <div>
          <h1 className="section-title">Couldn't load your firms</h1>
          <p className="section-subtitle">{firm.error}</p>
        </div>
      </div>
      <div className="stack">
        <button
          className="btn btn--primary btn--block"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            await firm.refresh();
            setRetrying(false);
          }}
        >
          {retrying ? <span className="spinner" /> : 'Try again'}
        </button>
        <button className="btn btn--ghost btn--block" onClick={() => void app.signOut()}>
          Sign out ({app.profile.email})
        </button>
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

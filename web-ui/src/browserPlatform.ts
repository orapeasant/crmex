// Browser implementation of shared-ui's PlatformServices (crmex.md §11, §15.10).
// Deliberately absent capabilities: contacts, scanQrCode, messaging — the
// browser never holds a WhatsApp session, so Send queues a send_job for the
// user's phone and the WhatsApp-linking UI hides.
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveDefaultRegion, toCountryCode, type CountryCode, type PlatformServices } from 'shared-ui';

const PREF_PREFIX = 'crmex:';
/** An invite token captured before sign-in, carried across the OAuth redirect (same tab only). */
const PENDING_INVITE_KEY = 'crmex:pendingInvite';
const INVITE_PATH_RE = /^\/invite\/[^/]+\/?$/;

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function localKeys(): string[] {
  return safe(() => {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREF_PREFIX)) keys.push(k);
    }
    return keys;
  }, []);
}

function isInviteLocation(): boolean {
  return INVITE_PATH_RE.test(window.location.pathname);
}

/** Replace an /invite/<token> URL with the app root so the token doesn't linger in the address bar or history. */
function cleanInviteUrl(): void {
  if (!isInviteLocation()) return;
  safe(() => window.history.replaceState(window.history.state, '', '/' + window.location.search + window.location.hash), undefined);
}

function localeRegion(): CountryCode | null {
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const region = safe(() => new Intl.Locale(tag).maximize().region, undefined) ?? /[-_]([A-Za-z]{2})\b/.exec(tag)?.[1];
    const code = toCountryCode(region);
    if (code) return code;
  }
  return null;
}

export interface BrowserPlatformOptions {
  /**
   * Map the browser Back button onto the phone UI's in-app back handlers. The desktop portal uses
   * real URL routing, so browser history already is its navigation and this stays off.
   */
  historyBackButton?: boolean;
}

export function createBrowserPlatform(appVersion: string, options: BrowserPlatformOptions = {}): PlatformServices {
  // Resolved once per page load (StrictMode runs effects twice).
  let initialUrl: string | null = null;
  if (isInviteLocation()) {
    initialUrl = window.location.href;
  } else {
    // Back from the OAuth redirect with an invite that was opened before sign-in.
    const pending = safe(() => sessionStorage.getItem(PENDING_INVITE_KEY), null);
    if (pending) {
      initialUrl = `${window.location.origin}/invite/${encodeURIComponent(pending)}`;
      safe(() => sessionStorage.removeItem(PENDING_INVITE_KEY), undefined);
    }
  }
  /** Token to carry across a sign-in redirect; dropped once used so a later sign-in in this tab doesn't resurrect it. */
  let carryInvite: string | null = initialUrl ? (/\/invite\/([^/?#]+)/.exec(new URL(initialUrl).pathname)?.[1] ?? null) : null;

  const backButton = createHistoryBackButton();

  return {
    name: 'web',
    appVersion,

    preferences: {
      async get(key) {
        return safe(() => localStorage.getItem(PREF_PREFIX + key), null);
      },
      async set(key, value) {
        safe(() => localStorage.setItem(PREF_PREFIX + key, value), undefined);
      },
      async remove(key) {
        safe(() => localStorage.removeItem(PREF_PREFIX + key), undefined);
      },
    },

    async signIn(supabase: SupabaseClient) {
      if (carryInvite) {
        safe(() => sessionStorage.setItem(PENDING_INVITE_KEY, decodeURIComponent(carryInvite!)), undefined);
        carryInvite = null;
      }
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      });
      if (error) {
        safe(() => sessionStorage.removeItem(PENDING_INVITE_KEY), undefined);
        throw error;
      }
      // On success the page navigates away to Google.
    },

    async purgeUserData(userId) {
      for (const k of localKeys()) if (k.includes(userId)) safe(() => localStorage.removeItem(k), undefined);
      safe(() => sessionStorage.removeItem(PENDING_INVITE_KEY), undefined);
      // Unsent message drafts of the desktop portal (crmex:draft:<userId>:<orgId>).
      safe(() => {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const k = sessionStorage.key(i);
          if (k?.startsWith(PREF_PREFIX) && k.includes(userId)) sessionStorage.removeItem(k);
        }
      }, undefined);
    },

    async purgeFirmData(userId, orgId) {
      safe(() => sessionStorage.removeItem(`${PREF_PREFIX}draft:${userId}:${orgId}`), undefined);
      for (const k of localKeys()) {
        const matchesKey = k.includes(userId) && k.includes(orgId);
        const pointsAtFirm = k.includes(userId) && safe(() => localStorage.getItem(k), null) === orgId;
        if (matchesKey || pointsAtFirm) safe(() => localStorage.removeItem(k), undefined);
      }
    },

    async resolveRegion(override) {
      return resolveDefaultRegion({ userOverride: override, simRegion: null, localeRegion: localeRegion() });
    },

    links: {
      async getInitialUrl() {
        return initialUrl;
      },
      subscribe() {
        // A browser delivers new invite links as a fresh page load, handled by getInitialUrl.
        return () => {};
      },
      consumed() {
        cleanInviteUrl();
        backButton.urlCleaned();
      },
    },

    ...(options.historyBackButton ? { backButton } : {}),

    onResume(cb) {
      const handler = () => {
        if (document.visibilityState === 'visible') cb();
      };
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },

    async share({ title, text, url }) {
      if (typeof navigator.share === 'function') {
        try {
          await navigator.share({ title, text, url });
          return;
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return; // user dismissed the sheet
        }
      }
      const content = [text, url].filter(Boolean).join('\n');
      await navigator.clipboard.writeText(content);
    },

    openUrl(url) {
      if (/^https?:/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
      else window.location.href = url; // tel:, mailto:
    },
  };
}

/**
 * Maps the browser Back button onto the app's back handlers (sheets, screen
 * stacks, tabs). A guard history entry sits on top of the app's entry; Back
 * pops it, the app handles the press and we re-arm the guard. When nothing
 * handled it, `exit` steps back past the app's entry for real.
 */
function createHistoryBackButton(): NonNullable<PlatformServices['backButton']> & { urlCleaned(): void } {
  const GUARD = { crmexGuard: true };
  let exiting = false;
  let onBackRef: (() => void) | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const isGuard = () => Boolean((window.history.state as { crmexGuard?: boolean } | null)?.crmexGuard);

  const armGuard = () => {
    if (!onBackRef || isGuard()) return;
    // Never copy a URL carrying a credential into a second history entry: wait until the
    // app consumed an /invite/<token>, and until Supabase exchanged and stripped an OAuth ?code=.
    if (isInviteLocation()) return;
    if (new URLSearchParams(window.location.search).has('code')) {
      if (!retry) retry = setTimeout(() => ((retry = null), armGuard()), 250);
      return;
    }
    safe(() => window.history.pushState(GUARD, '', window.location.href), undefined);
  };

  const handler = () => {
    if (exiting || isGuard()) return; // our own exit, or Forward onto the guard
    // Popped from the guard onto the app's entry: this is a Back press.
    onBackRef?.();
    if (!exiting) armGuard();
  };

  return {
    subscribe(onBack) {
      onBackRef = onBack;
      window.addEventListener('popstate', handler);
      armGuard();
      return () => {
        onBackRef = null;
        window.removeEventListener('popstate', handler);
      };
    },
    exit() {
      exiting = true;
      window.history.back();
      // Nothing to go back to (e.g. a fresh tab): we are still here, so re-arm.
      setTimeout(() => {
        exiting = false;
        armGuard();
      }, 500);
    },
    urlCleaned() {
      armGuard();
    },
  };
}

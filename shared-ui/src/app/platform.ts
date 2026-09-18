// The seam between the shared app and a platform shell (crmex.md §11, §15.10).
// shared-ui never imports Capacitor or any browser-only API beyond the DOM;
// everything platform-specific is injected through PlatformServices.
// Optional members are capabilities: when one is absent the UI hides the
// feature (e.g. no `contacts` -> no "Import from phone contacts").
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContactListResult, CountryCode, LocalStore, NativeBridge } from '../types.js';

/** Small persistent key-value store (Capacitor Preferences on Android, localStorage in a browser). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type WhatsAppState = 'connecting' | 'qr' | 'ready' | 'logged-out';

export interface WhatsAppStatus {
  state: WhatsAppState;
  /** Pairing QR payload while state === 'qr'. */
  qr: string | null;
}

/**
 * Holding a WhatsApp session and sending from it (Android: Baileys in the
 * embedded Node process). When a platform provides this, messages are sent
 * directly from the device ("direct" mode) and this device also runs send
 * jobs queued from the user's browser. Without it, sending queues a send_job
 * for the user's phone ("queue" mode).
 */
export interface DirectMessaging {
  /** Durable local outbox (crmex.md §3.2). */
  storage: LocalStore;
  bridge: Pick<NativeBridge, 'sendBatch' | 'onSendResult' | 'onBatchDone'>;
  /** Subscribe to connection state; implementations should deliver the current state soon after subscribing. */
  subscribeWhatsApp(cb: (status: WhatsAppStatus) => void): () => void;
  /** Log out the linked account (if any) and start a new QR pairing. */
  relinkWhatsApp(): Promise<void>;
  /** sock.onWhatsApp() per jid (SEND-04). */
  checkRegistered(jids: string[]): Promise<Record<string, boolean>>;
}

export interface PlatformServices {
  /** e.g. 'android' | 'web' — informational only. */
  name: string;
  appVersion: string;
  preferences: KeyValueStore;

  /**
   * Start Google sign-in. Android exchanges a native ID token via
   * supabase.auth.signInWithIdToken; a browser calls signInWithOAuth, which
   * redirects and resolves only if the redirect fails to start.
   */
  signIn(supabase: SupabaseClient): Promise<void>;

  /** Purge device-local state of a signed-out user (outbox rows, image cache files) — ISO-13. */
  purgeUserData(userId: string): Promise<void>;
  /** Purge this user's device-local state for a firm they are no longer a member of (§15.6). */
  purgeFirmData?(userId: string, orgId: string): Promise<void>;

  /**
   * Default region for phone numbers typed or imported without a country
   * code. `override` is the user's explicit choice from Settings, if any;
   * implementations fall back to SIM / locale (PHN-07/08).
   */
  resolveRegion(override: CountryCode | null): Promise<CountryCode>;

  /** Read the device address book. Absent in a browser. */
  contacts?: {
    listContacts(region: CountryCode): Promise<ContactListResult>;
  };

  /** Scan a QR code with the camera. Resolves null when the user cancels. Absent in a browser. */
  scanQrCode?(): Promise<string | null>;

  /**
   * Invitation links: Android `crmex://invite/<token>` (appUrlOpen and the
   * cold-start launch URL); a browser's `/invite/<token>` route.
   */
  links?: {
    getInitialUrl(): Promise<string | null>;
    subscribe(cb: (url: string) => void): () => void;
    /** Called once the app has taken the token, e.g. to clean the browser URL. */
    consumed?(): void;
  };

  /** Hardware back button (Android). `exit` runs when no screen handled the press. */
  backButton?: {
    subscribe(onBack: () => void): () => void;
    exit(): void;
  };

  /** App returned to the foreground (Capacitor App 'resume'); browsers can omit it (visibilitychange is used too). */
  onResume?(cb: () => void): () => void;

  /** Native share sheet. When absent, the app uses navigator.share or copies to the clipboard. */
  share?(data: { title?: string; text?: string; url?: string }): Promise<void>;

  /** Open tel:/mailto:/https: links. When absent, the app assigns window.location / window.open. */
  openUrl?(url: string): void;

  messaging?: DirectMessaging;
}

// Android implementation of shared-ui's PlatformServices (crmex.md §11).
// Everything Capacitor-specific the shared app needs lives behind this object.
import { App as CapApp } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { BarcodeFormat, BarcodeScanner, GoogleBarcodeScannerModuleInstallState } from '@capacitor-mlkit/barcode-scanning';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CountryCode, PlatformServices, WhatsAppState } from 'shared-ui';
import { CapacitorNativeBridge, purgeUserCacheFiles } from './CapacitorNativeBridge.js';
import { fetchLocalContacts, resolveRegion } from './contactsAdapter.js';
import { checkRegisteredOnNode, onNodeEvent, relinkWhatsApp, requestWhatsAppState } from './nodeBridge.js';

const nativeBridge = new CapacitorNativeBridge();

/** Make sure Google's code scanner module is installed (it is downloaded on demand by Play services). */
async function ensureScannerModule(): Promise<void> {
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
  if (available) return;
  await new Promise<void>((resolve, reject) => {
    let handle: { remove: () => Promise<void> } | null = null;
    const timeout = setTimeout(() => {
      void handle?.remove();
      reject(new Error('Downloading the QR scanner took too long. Check your connection and try again.'));
    }, 120_000);
    BarcodeScanner.addListener('googleBarcodeScannerModuleInstallProgress', (event) => {
      if (event.state === GoogleBarcodeScannerModuleInstallState.COMPLETED) {
        clearTimeout(timeout);
        void handle?.remove();
        resolve();
      } else if (event.state === GoogleBarcodeScannerModuleInstallState.FAILED || event.state === GoogleBarcodeScannerModuleInstallState.CANCELED) {
        clearTimeout(timeout);
        void handle?.remove();
        reject(new Error("Couldn't install the QR scanner from Google Play services."));
      }
    })
      .then((h) => {
        handle = h;
        return BarcodeScanner.installGoogleBarcodeScannerModule();
      })
      .catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
  });
}

export function createCapacitorPlatform(appVersion: string): PlatformServices {
  return {
    name: 'android',
    appVersion,

    preferences: {
      async get(key) {
        return (await Preferences.get({ key })).value;
      },
      async set(key, value) {
        await Preferences.set({ key, value });
      },
      async remove(key) {
        await Preferences.remove({ key });
      },
    },

    async signIn(supabase: SupabaseClient) {
      const { idToken } = await nativeBridge.signInWithGoogle();
      const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
      if (error) throw error;
    },

    async purgeUserData(userId) {
      await nativeBridge.storage.purgeUser(userId);
      await purgeUserCacheFiles(userId);
    },

    async purgeFirmData(userId, orgId) {
      await nativeBridge.storage.purgeOrg(userId, orgId);
    },

    resolveRegion: (override: CountryCode | null) => resolveRegion(override),

    contacts: {
      listContacts: (region) => fetchLocalContacts(region),
    },

    async scanQrCode() {
      await ensureScannerModule();
      try {
        const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
        return barcodes[0]?.rawValue ?? null;
      } catch (err) {
        // Backing out of the scanner rejects with 'scan canceled.' or, from Google's scanner UI,
        // 'Failed to scan code.' (observed on the emulator); both mean the user cancelled.
        if (/cancel|failed to scan code/i.test(String((err as { message?: unknown })?.message ?? err))) return null;
        throw err;
      }
    },

    links: {
      async getInitialUrl() {
        return (await CapApp.getLaunchUrl())?.url ?? null;
      },
      subscribe(cb) {
        const handle = CapApp.addListener('appUrlOpen', (e) => cb(e.url));
        return () => void handle.then((h) => h.remove());
      },
    },

    backButton: {
      subscribe(onBack) {
        const handle = CapApp.addListener('backButton', () => onBack());
        return () => void handle.then((h) => h.remove());
      },
      exit() {
        CapApp.minimizeApp().catch(() => {});
      },
    },

    onResume(cb) {
      const handle = CapApp.addListener('resume', () => cb());
      return () => void handle.then((h) => h.remove());
    },

    async share({ title, text, url }) {
      await Share.share({ title, text, url, dialogTitle: title });
    },

    openUrl(url) {
      // Capacitor's WebView hands non-app URLs (tel:, mailto:, https://wa.me/…) to Android as a VIEW intent.
      window.location.href = url;
    },

    messaging: {
      storage: nativeBridge.storage,
      bridge: nativeBridge,
      subscribeWhatsApp(cb) {
        const offs = [
          onNodeEvent('wa:qr', (p) => cb({ state: 'qr', qr: p.qr })),
          onNodeEvent('wa:ready', () => cb({ state: 'ready', qr: null })),
          onNodeEvent('wa:logged-out', () => cb({ state: 'logged-out', qr: null })),
          onNodeEvent('wa:reconnecting', () => cb({ state: 'connecting', qr: null })),
          onNodeEvent('wa:state', (p) => cb({ state: p.state as WhatsAppState, qr: p.qr })),
        ];
        // Events may have fired before this subscriber existed (e.g. after a WebView reload).
        requestWhatsAppState().catch(() => {});
        return () => offs.forEach((off) => off());
      },
      relinkWhatsApp: () => relinkWhatsApp(),
      checkRegistered: (jids) => checkRegisteredOnNode(jids),
    },
  };
}

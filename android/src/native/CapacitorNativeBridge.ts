// The Android implementation of shared-ui's NativeBridge interface
// (crmex.md §11). Every platform-specific call in the app funnels through
// here; shared-ui components never import Capacitor directly.
// @codetrix-studio/capacitor-google-auth's peer dependency is pinned to
// Capacitor ^6, incompatible with the Capacitor 8 project here (required by
// capacitor-nodejs — see capacitor.config.ts). @southdevs/capacitor-google-auth
// is an actively maintained fork with the same `GoogleAuth.signIn()` /
// `authentication.idToken` API, confirmed against its README at
// implementation time.
import { GoogleAuth } from '@southdevs/capacitor-google-auth';
import { Filesystem, Directory } from '@capacitor/filesystem';
import type {
  NativeBridge,
  ContactListResult,
  CountryCode,
  OutboxBatch,
  SendResultEvent,
} from 'shared-ui';
import { toCountryCode } from 'shared-ui';
import { fetchLocalContacts, resolveRegion } from './contactsAdapter.js';
import { SqliteLocalStore } from './sqliteStore.js';
import { sendBatchToNode, onNodeEvent } from './nodeBridge.js';
import { BackgroundEngine, MediaSave } from './customPlugins.js';
import { SimRegion } from './simRegionPlugin.js';

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return arrayBufferToBase64(buf);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export class CapacitorNativeBridge implements NativeBridge {
  readonly storage = new SqliteLocalStore();

  private userRegionOverride: CountryCode | null = null;

  setRegionOverride(region: CountryCode | null): void {
    this.userRegionOverride = region;
  }

  async listContacts(_defaultRegionHint: CountryCode): Promise<ContactListResult> {
    const region = await resolveRegion(this.userRegionOverride);
    return fetchLocalContacts(region);
  }

  async saveImageToLibrary(bytes: Blob | ArrayBuffer, filename: string): Promise<void> {
    const base64 = bytes instanceof Blob ? await blobToBase64(bytes) : arrayBufferToBase64(bytes);
    await MediaSave.saveImage({ base64Data: base64, filename });
  }

  async signInWithGoogle(): Promise<{ idToken: string }> {
    await GoogleAuth.initialize();
    const result = await GoogleAuth.signIn({ scopes: ['profile', 'email'] });
    const idToken = result.authentication?.idToken;
    if (!idToken) throw new Error('GOOGLE_SIGN_IN_NO_ID_TOKEN');
    return { idToken };
  }

  async sendBatch(batch: OutboxBatch): Promise<void> {
    // crmex.md §10.1: the foreground service starts right before the batch
    // is handed to Node (AND-01) and stops when SEND-11's wa:batch-done
    // fires — see wireBatchLifecycle() below, called once at app startup.
    await BackgroundEngine.start();
    await sendBatchToNode(batch);
  }

  onSendResult(cb: (evt: SendResultEvent) => void): () => void {
    return onNodeEvent('wa:result', cb);
  }

  onBatchDone(cb: (evt: { batchId: string }) => void): () => void {
    return onNodeEvent('wa:batch-done', async (evt) => {
      await BackgroundEngine.stop(); // SEND-11/AND-02: stop when the queue drains
      cb(evt);
    });
  }

  onWhatsAppState(cb: (evt: { type: 'qr' | 'ready' | 'logged-out' | 'close'; payload?: unknown }) => void): () => void {
    const offQr = onNodeEvent('wa:qr', (p) => cb({ type: 'qr', payload: p }));
    const offReady = onNodeEvent('wa:ready', () => cb({ type: 'ready' }));
    const offLoggedOut = onNodeEvent('wa:logged-out', () => cb({ type: 'logged-out' }));
    const offReconnecting = onNodeEvent('wa:reconnecting', (p) => cb({ type: 'close', payload: p }));
    return () => {
      offQr();
      offReady();
      offLoggedOut();
      offReconnecting();
    };
  }

  async getSimRegion(): Promise<CountryCode | null> {
    const { region } = await SimRegion.getSimCountryIso();
    return toCountryCode(region);
  }
}

export async function purgeUserCacheFiles(userId: string): Promise<void> {
  // ISO-13: purge the signed-out user's cached image files. The SQLite index
  // rows are cleared by storage.purgeUser(); this removes the actual bytes
  // from Directory.Cache. Best-effort — Directory.Cache may already have
  // been reclaimed by the OS (CSH-05), which is not an error here.
  try {
    await Filesystem.rmdir({ path: `images/${userId}`, directory: Directory.Cache, recursive: true });
  } catch {
    /* directory may not exist — nothing to purge */
  }
}

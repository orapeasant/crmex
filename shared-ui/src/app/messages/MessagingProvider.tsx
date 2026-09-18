// Send capability for the whole app. "direct" when the platform holds a
// WhatsApp session (Android): one DirectSender per user plus the runner for
// send_jobs queued from the user's browser. "queue" otherwise (browser):
// sending inserts a send_job for the user's phone (crmex.md §15.10).
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DirectSender } from '../../send/directSender.js';
import { SendJobRunner } from '../../send/jobRunner.js';
import type { MediaResolver } from '../../send/sendFlow.js';
import { mirrorMessageResult, refreshSignedUrl } from '../../supabase/repo.js';
import type { SendJobRow } from '../../crm/types.js';
import type { PlatformServices, WhatsAppStatus } from '../platform.js';
import { useFirm } from '../context.js';
import { blobToBase64 } from '../ui/util.js';

export interface MessagingContextValue {
  mode: 'direct' | 'queue';
  /** null in queue mode (this device has no WhatsApp session). */
  whatsApp: WhatsAppStatus | null;
  relink: () => Promise<void>;
  sender: DirectSender | null;
  checkRegistered: ((jids: string[]) => Promise<Record<string, boolean>>) | null;
  /** A batch is currently being sent from this device. */
  busy: boolean;
  /** The browser-queued job this phone is running right now, if any. */
  jobActivity: SendJobRow | null;
}

const MessagingContext = createContext<MessagingContextValue | null>(null);

export function useMessaging(): MessagingContextValue {
  const v = useContext(MessagingContext);
  if (!v) throw new Error('useMessaging outside MessagingProvider');
  return v;
}

export function MessagingProvider({ platform, supabase, userId, children }: { platform: PlatformServices; supabase: SupabaseClient; userId: string; children: ReactNode }) {
  const messaging = platform.messaging;
  const { orgs } = useFirm();
  const orgIdsRef = useRef<string[]>([]);
  orgIdsRef.current = orgs.map((o) => o.id);

  const [whatsApp, setWhatsApp] = useState<WhatsAppStatus | null>(messaging ? { state: 'connecting', qr: null } : null);
  const [busy, setBusy] = useState(false);
  const [jobActivity, setJobActivity] = useState<SendJobRow | null>(null);

  useEffect(() => (messaging ? messaging.subscribeWhatsApp(setWhatsApp) : undefined), [messaging]);

  const mediaResolver = useMemo<MediaResolver>(
    () => ({
      async resolve(mediaPath) {
        if (!mediaPath) return undefined;
        const url = await refreshSignedUrl(supabase, mediaPath);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Couldn't download the image (HTTP ${res.status})`);
        return blobToBase64(await res.blob());
      },
    }),
    [supabase],
  );

  const sender = useMemo(
    () =>
      messaging
        ? new DirectSender({ userId, storage: messaging.storage, nativeBridge: messaging.bridge, mirror: (r) => mirrorMessageResult(supabase, r), mediaResolver })
        : null,
    [messaging, userId, supabase, mediaResolver],
  );

  useEffect(() => {
    if (!sender) return;
    const stop = sender.start();
    const offBusy = sender.onBusyChange(setBusy);
    return () => {
      offBusy();
      stop();
    };
  }, [sender]);

  // Run send_jobs the user queued from a browser, while WhatsApp is linked.
  const waReady = whatsApp?.state === 'ready';
  useEffect(() => {
    if (!sender || !messaging || !waReady) return;
    const runner = new SendJobRunner({
      supabase,
      userId,
      checkRegistered: (jids) => messaging.checkRegistered(jids),
      sendBatch: async (orgId, batchId, queue) => {
        await sender.send(orgId, batchId, queue);
        await sender.waitForDone(batchId);
      },
      getOrgIds: () => orgIdsRef.current,
      isBusy: () => sender.busy,
      onActivity: setJobActivity,
    });
    const stop = runner.start();
    const offBusy = sender.onBusyChange((b) => !b && void runner.poll());
    const onVisible = () => document.visibilityState === 'visible' && void runner.poll();
    document.addEventListener('visibilitychange', onVisible);
    const offResume = platform.onResume?.(() => void runner.poll());
    return () => {
      stop();
      offBusy();
      offResume?.();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sender, messaging, waReady, supabase, userId, platform]);

  const value = useMemo<MessagingContextValue>(
    () => ({
      mode: messaging ? 'direct' : 'queue',
      whatsApp,
      relink: async () => {
        if (!messaging) return;
        setWhatsApp({ state: 'connecting', qr: null });
        await messaging.relinkWhatsApp();
      },
      sender,
      checkRegistered: messaging ? (jids) => messaging.checkRegistered(jids) : null,
      busy,
      jobActivity,
    }),
    [messaging, whatsApp, sender, busy, jobActivity],
  );

  return <MessagingContext.Provider value={value}>{children}</MessagingContext.Provider>;
}

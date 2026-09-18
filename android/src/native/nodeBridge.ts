// Thin typed wrapper around the capacitor-nodejs plugin's IPC surface
// (NodeJS.whenReady/send/addListener — confirmed against the
// hampoelz/Capacitor-NodeJS README at implementation time). Everything this
// file sends/receives matches the event names main.js emits/listens for
// 1:1 — see android/nodejs-assets/nodejs-project/main.js.
import { NodeJS } from 'capacitor-nodejs';
import type { OutboxBatch, SendResultEvent } from 'shared-ui';

export interface WaQrEvent {
  qr: string;
}
export interface WaReconnectingEvent {
  delayMs: number;
  attempt: number;
}
export type WaEventMap = {
  'wa:qr': WaQrEvent;
  'wa:ready': Record<string, never>;
  'wa:logged-out': Record<string, never>;
  'wa:reconnecting': WaReconnectingEvent;
  'wa:waiting-for-connection': { batchId: string };
  'wa:result': SendResultEvent;
  'wa:batch-done': { batchId: string };
  'wa:fatal': { message: string };
  'wa:registered-result': { requestId: string; results?: Record<string, boolean>; error?: string };
  'wa:state': { state: 'connecting' | 'qr' | 'ready' | 'logged-out'; qr: string | null };
};

let readyPromise: Promise<void> | null = null;

export function whenNodeReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = NodeJS.whenReady();
  }
  return readyPromise;
}

export function onNodeEvent<K extends keyof WaEventMap>(
  eventName: K,
  cb: (payload: WaEventMap[K]) => void,
): () => void {
  const handle = NodeJS.addListener(eventName, (event: { args: unknown[] }) => {
    cb(event.args[0] as WaEventMap[K]);
  });
  return () => {
    handle.then((h) => h.remove()).catch(() => {});
  };
}

export async function sendBatchToNode(batch: OutboxBatch): Promise<void> {
  await whenNodeReady();
  await NodeJS.send({ eventName: 'wa:send-batch', args: [batch] });
}

/** Asks Node to re-emit its current connection state as a `wa:state` event. */
export async function requestWhatsAppState(): Promise<void> {
  await whenNodeReady();
  await NodeJS.send({ eventName: 'wa:get-state', args: [] });
}

/** Logs out of the linked WhatsApp account (if any), deletes its credentials and starts a new QR pairing. */
export async function relinkWhatsApp(): Promise<void> {
  await whenNodeReady();
  await NodeJS.send({ eventName: 'wa:relink', args: [] });
}

export async function checkRegisteredOnNode(jids: string[]): Promise<Record<string, boolean>> {
  await whenNodeReady();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const remove = onNodeEvent('wa:registered-result', (payload) => {
      if (payload.requestId !== requestId) return;
      remove();
      if (payload.error) reject(new Error(payload.error));
      else resolve(payload.results ?? {});
    });
    NodeJS.send({ eventName: 'wa:check-registered', args: [{ requestId, jids }] }).catch((err) => {
      remove();
      reject(err);
    });
    // No listening port exists to reach this over the network (AND-09) —
    // this is a pure IPC round-trip over the capacitor-nodejs bridge.
  });
}

// Ties queueBuilder -> OutboxManager -> NativeBridge together in the order
// crmex.md §9.2 requires: write PENDING (then CLAIMED) to durable storage
// BEFORE the batch is handed to Node over IPC, and wire Node's result/done
// events back into the outbox + mirror pipeline. This is the orchestration
// PLAN.md step 7 ("wire the end-to-end flow") needs; the pieces themselves
// (queueBuilder, OutboxManager, NativeBridge) were already built and tested
// separately, but nothing previously called them in the right order — see
// android/README.md "What's left".
import type { BuiltQueue } from './queueBuilder.js';
import { assertNonEmptyBatch } from './queueBuilder.js';
import { OutboxManager } from './outboxManager.js';
import type { NativeBridge, OutboxBatch } from '../types.js';

export interface MediaResolver {
  /** Resolve a queued item's media (if any) to base64 bytes for the IPC
   * handoff. Not persisted in the outbox row — crmex.md §3.2 stores only
   * `media_path`, never raw bytes. */
  resolve(mediaPath: string | null | undefined): Promise<string | undefined>;
}

export interface SendFlowDeps {
  nativeBridge: Pick<NativeBridge, 'sendBatch' | 'onSendResult' | 'onBatchDone'>;
  outboxManager: OutboxManager;
  mediaResolver?: MediaResolver;
  now?: () => number;
}

/**
 * Durably enqueues `queue` and hands it to the Node process. Throws
 * EMPTY_BATCH (SEND-12) before anything is written if the queue is empty.
 * Returns the handed-off batch (outbox row ids per jid) immediately; delivery
 * results arrive asynchronously through the result/done listeners wired by
 * `wireSendResultHandling`.
 */
export async function confirmAndSend(deps: SendFlowDeps, userId: string, orgId: string, batchId: string, queue: BuiltQueue): Promise<OutboxBatch> {
  assertNonEmptyBatch(queue); // SEND-12: rejected before any outbox row exists
  const now = (deps.now ?? Date.now)();

  const itemsWithMedia = await Promise.all(
    queue.items.map(async (item) => ({
      jid: item.jid,
      clientId: item.clientId ?? null,
      displayName: item.displayName,
      body: item.body,
      mediaPath: item.mediaPath,
      mediaBytesBase64: deps.mediaResolver ? await deps.mediaResolver.resolve(item.mediaPath) : undefined,
    })),
  );

  // §9.2: outbox rows exist (PENDING -> CLAIMED) before the IPC call below.
  const batch = await deps.outboxManager.prepareBatch(userId, orgId, batchId, itemsWithMedia, now);
  await deps.nativeBridge.sendBatch(batch);
  return batch;
}

/**
 * Wires Node's `wa:result` / `wa:batch-done` events into the outbox +
 * Supabase-mirror pipeline. Call once at app startup (not per-batch) — it's
 * idempotent-safe to call again since each call only adds listeners for
 * events tied to whichever userId/batchId is current at the time.
 */
export function wireSendResultHandling(
  nativeBridge: Pick<NativeBridge, 'onSendResult' | 'onBatchDone'>,
  outboxManager: OutboxManager,
  getContext: () => { userId: string; batchId: string } | null,
): () => void {
  const offResult = nativeBridge.onSendResult((evt) => {
    const ctx = getContext();
    if (!ctx) return;
    outboxManager.handleResult(ctx.userId, ctx.batchId, evt).catch((err) => {
      // A failure here means the mirror write failed AND the local settle
      // failed — logged rather than thrown since this runs inside an event
      // callback with no caller to propagate to. retryUnmirrored() on next
      // launch/reconnect is the recovery path (SEND-13).
      console.error('[sendFlow] handleResult failed', err);
    });
  });

  const offDone = nativeBridge.onBatchDone((evt) => {
    const ctx = getContext();
    if (!ctx || ctx.batchId !== evt.batchId) return;
    outboxManager.retryUnmirrored(ctx.userId, ctx.batchId).catch((err) => {
      console.error('[sendFlow] retryUnmirrored failed', err);
    });
  });

  return () => {
    offResult();
    offDone();
  };
}

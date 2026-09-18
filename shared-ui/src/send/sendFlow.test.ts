import { describe, it, expect, vi } from 'vitest';
import { confirmAndSend, wireSendResultHandling } from './sendFlow.js';
import { OutboxManager } from './outboxManager.js';
import { InMemoryLocalStore } from '../testing/inMemoryStore.js';
import type { BuiltQueue } from './queueBuilder.js';
import type { NativeBridge, OutboxBatch, SendResultEvent } from '../types.js';

function fakeNativeBridge() {
  let resultCb: ((evt: SendResultEvent) => void) | null = null;
  let doneCb: ((evt: { batchId: string }) => void) | null = null;
  const sentBatches: OutboxBatch[] = [];
  return {
    bridge: {
      sendBatch: vi.fn(async (batch: OutboxBatch) => {
        sentBatches.push(batch);
      }),
      onSendResult: (cb: (evt: SendResultEvent) => void) => {
        resultCb = cb;
        return () => (resultCb = null);
      },
      onBatchDone: (cb: (evt: { batchId: string }) => void) => {
        doneCb = cb;
        return () => (doneCb = null);
      },
    } satisfies Pick<NativeBridge, 'sendBatch' | 'onSendResult' | 'onBatchDone'>,
    sentBatches,
    emitResult: (evt: SendResultEvent) => resultCb?.(evt),
    emitDone: (evt: { batchId: string }) => doneCb?.(evt),
  };
}

describe('confirmAndSend (§9.2 ordering)', () => {
  it('writes the outbox durably (PENDING->CLAIMED) BEFORE calling nativeBridge.sendBatch', async () => {
    const store = new InMemoryLocalStore();
    const mirror = vi.fn(async () => {});
    const outboxManager = new OutboxManager(store, mirror);
    const { bridge, sentBatches } = fakeNativeBridge();

    bridge.sendBatch.mockImplementationOnce(async (batch) => {
      // At the moment Node receives the batch, the row must already be
      // durable — this is the exact ordering crmex.md §9.2 requires.
      const claimed = await store.listClaimedUnsettled('u1');
      expect(claimed).toHaveLength(batch.items.length);
      sentBatches.push(batch);
    });

    const queue: BuiltQueue = {
      items: [{ jid: 'a@s.whatsapp.net', displayName: 'Alice', body: 'hi' }],
      skipped: [],
    };

    await confirmAndSend({ nativeBridge: bridge, outboxManager }, 'u1', 'org-a', 'batch1', queue);

    expect(bridge.sendBatch).toHaveBeenCalledTimes(1);
    expect(sentBatches[0].items[0].jid).toBe('a@s.whatsapp.net');
  });

  it('SEND-12: an empty queue is rejected before any outbox row is written or Node is contacted', async () => {
    const store = new InMemoryLocalStore();
    const outboxManager = new OutboxManager(store, vi.fn());
    const { bridge } = fakeNativeBridge();

    await expect(
      confirmAndSend({ nativeBridge: bridge, outboxManager }, 'u1', 'org-a', 'batch1', { items: [], skipped: [] }),
    ).rejects.toThrow('EMPTY_BATCH');

    expect(bridge.sendBatch).not.toHaveBeenCalled();
    expect(await store.listPendingOutbox('u1')).toHaveLength(0);
  });

  it('resolves media via the injected MediaResolver without persisting raw bytes in the outbox row', async () => {
    const store = new InMemoryLocalStore();
    const outboxManager = new OutboxManager(store, vi.fn(async () => {}));
    const { bridge } = fakeNativeBridge();
    const resolve = vi.fn(async (path: string | null | undefined) => (path ? 'base64bytes' : undefined));

    const queue: BuiltQueue = {
      items: [{ jid: 'a@s.whatsapp.net', displayName: 'Alice', mediaPath: 'u1/hash.png' }],
      skipped: [],
    };

    await confirmAndSend(
      { nativeBridge: bridge, outboxManager, mediaResolver: { resolve } },
      'u1',
      'org-a',
      'batch1',
      queue,
    );

    expect(resolve).toHaveBeenCalledWith('u1/hash.png');
    const sentBatch = bridge.sendBatch.mock.calls[0][0] as OutboxBatch;
    expect(sentBatch.items[0].mediaBytesBase64).toBe('base64bytes');

    // The durable row itself never carries the bytes, only the path.
    const rows = await store.listClaimedUnsettled('u1');
    expect(rows[0].mediaPath).toBe('u1/hash.png');
    expect((rows[0] as unknown as { mediaBytesBase64?: string }).mediaBytesBase64).toBeUndefined();
  });
});

describe('wireSendResultHandling', () => {
  it('routes wa:result into OutboxManager.handleResult and wa:batch-done into retryUnmirrored', async () => {
    const store = new InMemoryLocalStore();
    const mirror = vi.fn(async (): Promise<void> => {
      throw new Error('offline');
    });
    const outboxManager = new OutboxManager(store, mirror);
    const { bridge, emitResult, emitDone } = fakeNativeBridge();

    const rows = await store.insertOutboxBatch('u1', 'org-a', 'batch1', [{ jid: 'a@s.whatsapp.net' }]);
    await store.claimOutboxRow(rows[0].id, 1000);

    wireSendResultHandling(bridge, outboxManager, () => ({ userId: 'u1', batchId: 'batch1' }));

    emitResult({ id: rows[0].id, status: 'SENT' });
    // handleResult is async — flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.listSettledUnmirrored('u1')).toHaveLength(1); // mirror failed, row retained (SEND-13)

    mirror.mockImplementation(async () => {});
    emitDone({ batchId: 'batch1' });
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.listSettledUnmirrored('u1')).toHaveLength(0); // retried and cleared on batch-done
  });
});

import { describe, it, expect, vi } from 'vitest';
import { OutboxManager, type MirrorResult } from './outboxManager.js';
import { InMemoryLocalStore } from '../testing/inMemoryStore.js';

function makeManager(mirror = vi.fn(async (_r: MirrorResult) => {})) {
  const store = new InMemoryLocalStore();
  const manager = new OutboxManager(store, mirror);
  return { store, manager, mirror };
}

describe('OutboxManager (§9.2 durability)', () => {
  it('SEND-05: every row is written PENDING-then-CLAIMED before the batch is handed off', async () => {
    const { store, manager } = makeManager();
    const batch = await manager.prepareBatch('u1', 'org-a', 'batch1', [{ jid: 'a@s.whatsapp.net' }, { jid: 'b@s.whatsapp.net' }], 1000);
    expect(batch.items).toHaveLength(2);
    const claimed = await store.listClaimedUnsettled('u1');
    expect(claimed).toHaveLength(2);
    expect(claimed.every((r) => r.claimedAt === 1000)).toBe(true);
    const pending = await store.listPendingOutbox('u1');
    expect(pending).toHaveLength(0); // already moved to CLAIMED
  });

  it('SEND-06: rows never claimed remain PENDING and are resumable', async () => {
    const store = new InMemoryLocalStore();
    // Simulate a kill before prepareBatch even reaches the claim step: insert directly.
    await store.insertOutboxBatch('u1', 'org-a', 'batch1', [{ jid: 'a@s.whatsapp.net' }]);
    const pending = await store.listPendingOutbox('u1');
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('PENDING');
  });

  it('SEND-07: a row CLAIMED but never settled is surfaced, not resent', async () => {
    const { store, manager } = makeManager();
    await manager.prepareBatch('u1', 'org-a', 'batch1', [{ jid: 'a@s.whatsapp.net' }], 1000);
    // Simulate app kill: no handleResult ever called.
    const resume = await manager.resumeState('u1');
    expect(resume.claimedUnsettled).toHaveLength(1);
    expect(resume.pending).toHaveLength(0);
  });

  it('settling a result removes the row once mirrored successfully', async () => {
    const { store, manager, mirror } = makeManager();
    const batch = await manager.prepareBatch('u1', 'org-a', 'batch1', [{ jid: 'a@s.whatsapp.net', body: 'hi' }], 1000);
    await manager.handleResult('u1', 'batch1', { id: batch.items[0].id, status: 'SENT' }, { displayName: 'Alice' });
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(mirror.mock.calls[0][0]).toMatchObject({ orgId: 'org-a', jid: 'a@s.whatsapp.net', status: 'SENT', displayName: 'Alice' });
    const remaining = await store.listSettledUnmirrored('u1');
    expect(remaining).toHaveLength(0);
  });

  it('SEND-13: a mirror failure (Supabase unreachable) keeps the row with its final status instead of losing it', async () => {
    const mirror = vi.fn(async (): Promise<void> => {
      throw new Error('network down');
    });
    const { store, manager } = makeManager(mirror);
    const batch = await manager.prepareBatch('u1', 'org-a', 'batch1', [{ jid: 'a@s.whatsapp.net' }], 1000);
    await manager.handleResult('u1', 'batch1', { id: batch.items[0].id, status: 'SENT' });

    const unmirrored = await store.listSettledUnmirrored('u1');
    expect(unmirrored).toHaveLength(1);
    expect(unmirrored[0].status).toBe('SENT');

    // Reconnect: mirror succeeds this time.
    mirror.mockImplementation(async () => {});
    await manager.retryUnmirrored('u1', 'batch1');
    expect(await store.listSettledUnmirrored('u1')).toHaveLength(0);
    // The send is never repeated — retryUnmirrored only re-runs the mirror write.
    expect(mirror).toHaveBeenCalledTimes(2); // first failed attempt + retry
  });

  it('SEND-12/prepareBatch: an empty batch throws before any row is written', async () => {
    const { store, manager } = makeManager();
    await expect(manager.prepareBatch('u1', 'org-a', 'batch1', [], 1000)).rejects.toThrow('EMPTY_BATCH');
    expect(await store.listPendingOutbox('u1')).toHaveLength(0);
  });

  it('ISO-14: outbox queries are scoped per user_id', async () => {
    const { store, manager } = makeManager();
    await manager.prepareBatch('userA', 'org-a', 'batchA', [{ jid: 'a@s.whatsapp.net' }], 1000);
    await manager.prepareBatch('userB', 'org-a', 'batchB', [{ jid: 'b@s.whatsapp.net' }], 1000);
    expect(await store.listClaimedUnsettled('userA')).toHaveLength(1);
    expect(await store.listClaimedUnsettled('userB')).toHaveLength(1);
    expect((await store.listClaimedUnsettled('userA'))[0].jid).toBe('a@s.whatsapp.net');
  });
});

describe('OutboxManager mirror attribution', () => {
  it('retryUnmirrored writes each row under its own batch id, not the batch passed in', async () => {
    const mirror = vi.fn(async (_r: MirrorResult): Promise<void> => {
      throw new Error('offline');
    });
    const { manager } = makeManager(mirror);
    const first = await manager.prepareBatch('u1', 'org-a', 'batch-old', [{ jid: 'a@s.whatsapp.net' }], 1000);
    await manager.handleResult('u1', 'batch-old', { id: first.items[0].id, status: 'SENT' });
    const second = await manager.prepareBatch('u1', 'org-a', 'batch-new', [{ jid: 'b@s.whatsapp.net' }], 2000);
    await manager.handleResult('u1', 'batch-new', { id: second.items[0].id, status: 'FAILED' });

    mirror.mockClear();
    mirror.mockImplementation(async () => {});
    await manager.retryUnmirrored('u1', 'batch-new');
    const byJid = Object.fromEntries(mirror.mock.calls.map(([r]) => [r.jid, r.batchId]));
    expect(byJid).toEqual({ 'a@s.whatsapp.net': 'batch-old', 'b@s.whatsapp.net': 'batch-new' });
  });

  it('carries client id and display name from the outbox row into the mirror', async () => {
    const { manager, mirror } = makeManager();
    const batch = await manager.prepareBatch('u1', 'org-a', 'b1', [{ jid: 'a@s.whatsapp.net', clientId: 'client-1', displayName: 'Alice' }], 1000);
    await manager.handleResult('u1', 'b1', { id: batch.items[0].id, status: 'SENT' });
    expect(mirror.mock.calls[0][0]).toMatchObject({ clientId: 'client-1', displayName: 'Alice', batchId: 'b1', orgId: 'org-a' });
  });
});

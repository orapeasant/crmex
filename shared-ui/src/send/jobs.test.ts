import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createFakeSupabaseClient, FakeSupabaseDb } from '../testing/fakeSupabase.js';
import { InMemoryLocalStore } from '../testing/inMemoryStore.js';
import { cancelSendJob, claimSendJob, listSendJobs, queueSendJob } from '../supabase/sendJobs.js';
import { runSendJob, SendJobRunner } from './jobRunner.js';
import { DirectSender, SenderBusyError } from './directSender.js';
import type { SendJobRow } from '../crm/types.js';
import type { NativeBridge, OutboxBatch, SendResultEvent } from '../types.js';
import type { BuiltQueue } from './queueBuilder.js';

function setup() {
  const db = new FakeSupabaseDb();
  const c = createFakeSupabaseClient(db) as unknown as SupabaseClient;
  db.table('clients').push(
    { id: 'alice', org_id: 'org-a', display_name: 'Alice', phone_e164: '+6591234567', suppressed_at: null, status: 'active' },
    { id: 'bob', org_id: 'org-a', display_name: 'Bob', phone_e164: '+6598765432', suppressed_at: null, status: 'active' },
    { id: 'opted-out', org_id: 'org-a', display_name: 'Olive', phone_e164: '+6591110000', suppressed_at: '2026-01-01T00:00:00Z', status: 'active' },
    { id: 'nophone', org_id: 'org-a', display_name: 'Nemo', phone_e164: null, suppressed_at: null, status: 'active' },
    { id: 'other-firm', org_id: 'org-b', display_name: 'Mallory', phone_e164: '+6592220000', suppressed_at: null, status: 'active' },
  );
  return { db, c };
}

describe('queueSendJob (browser queue mode)', () => {
  it('rebuilds recipients from the firm clients, excluding suppressed, phoneless and other-firm clients', async () => {
    const { db, c } = setup();
    const { job, excluded } = await queueSendJob(c, {
      orgId: 'org-a',
      userId: 'u1',
      body: ' Hello ',
      clientIds: ['alice', 'opted-out', 'nophone', 'other-firm', 'alice'],
    });
    expect(job).toMatchObject({ org_id: 'org-a', created_by: 'u1', status: 'queued', body: 'Hello', media_path: null });
    expect(job.recipients).toEqual([{ client_id: 'alice', jid: '6591234567@s.whatsapp.net', display_name: 'Alice' }]);
    expect([...excluded].sort((a, b) => a.clientId.localeCompare(b.clientId))).toEqual([
      { clientId: 'nophone', reason: 'no_phone' },
      { clientId: 'opted-out', reason: 'suppressed' },
      { clientId: 'other-firm', reason: 'not_found' },
    ]);
    const clientQuery = db.queries.find((q) => q.table === 'clients')!;
    expect(clientQuery.filters).toContainEqual({ col: 'org_id', op: 'eq', val: 'org-a' });
  });

  it('refuses an empty or fully excluded batch', async () => {
    const { c } = setup();
    await expect(queueSendJob(c, { orgId: 'org-a', userId: 'u1', body: 'x', clientIds: [] })).rejects.toThrow('EMPTY_BATCH');
    await expect(queueSendJob(c, { orgId: 'org-a', userId: 'u1', body: 'x', clientIds: ['opted-out'] })).rejects.toThrow('NO_SENDABLE_RECIPIENTS');
    await expect(queueSendJob(c, { orgId: 'org-a', userId: 'u1', body: ' ', clientIds: ['alice'] })).rejects.toThrow('EMPTY_MESSAGE');
  });

  it('cancels only a still-queued job of the caller', async () => {
    const { c } = setup();
    const { job } = await queueSendJob(c, { orgId: 'org-a', userId: 'u1', body: 'x', clientIds: ['alice'] });
    await expect(cancelSendJob(c, 'org-a', 'u2', job.id)).rejects.toThrow(/no longer be cancelled/);
    await claimSendJob(c, 'u1', job);
    await expect(cancelSendJob(c, 'org-a', 'u1', job.id)).rejects.toThrow(/no longer be cancelled/);
    const { job: job2 } = await queueSendJob(c, { orgId: 'org-a', userId: 'u1', body: 'y', clientIds: ['bob'] });
    expect((await cancelSendJob(c, 'org-a', 'u1', job2.id)).status).toBe('cancelled');
    expect((await listSendJobs(c, 'org-a', { statuses: ['cancelled'] })).map((j) => j.id)).toEqual([job2.id]);
  });
});

describe('claimSendJob', () => {
  it('is atomic: a second claim (another device) gets nothing, and another user can never claim', async () => {
    const { c } = setup();
    const { job } = await queueSendJob(c, { orgId: 'org-a', userId: 'u1', body: 'x', clientIds: ['alice'] });
    expect(await claimSendJob(c, 'u2', job)).toBeNull();
    expect((await claimSendJob(c, 'u1', job))?.status).toBe('claimed');
    expect(await claimSendJob(c, 'u1', job)).toBeNull();
  });

  it('CAM-02/CAM-03: refuses to claim before scheduled_at or past expires_at', async () => {
    const { db, c } = setup();
    const { job: future } = await queueSendJob(c, { orgId: 'org-a', userId: 'u1', body: 'x', clientIds: ['alice'], scheduledAt: '2999-01-01T00:00:00Z' });
    expect(await claimSendJob(c, 'u1', future)).toBeNull();

    const { job: expired } = await queueSendJob(c, { orgId: 'org-a', userId: 'u1', body: 'y', clientIds: ['bob'] });
    db.table('send_jobs').find((r) => r.id === expired.id)!.expires_at = '2000-01-01T00:00:00Z';
    expect(await claimSendJob(c, 'u1', expired)).toBeNull();
  });
});

describe('runSendJob (phone side)', () => {
  async function queued(c: SupabaseClient, clientIds: string[], userId = 'u1') {
    return (await queueSendJob(c, { orgId: 'org-a', userId, body: 'Hello', mediaPath: 'org-a/u1/img.png', clientIds })).job;
  }

  it('re-checks suppression and registration at claim time, sends with the job id as batch id, then marks done', async () => {
    const { db, c } = setup();
    const job = await queued(c, ['alice', 'bob']);
    // Bob opts out after the browser queued the job.
    db.table('clients').find((r) => r.id === 'bob')!.suppressed_at = '2026-09-13T00:00:00Z';
    const sendBatch = vi.fn(async (_org: string, _batch: string, _q: BuiltQueue) => {});
    const outcome = await runSendJob({ supabase: c, userId: 'u1', checkRegistered: async (jids) => Object.fromEntries(jids.map((j) => [j, true])), sendBatch }, job);

    expect(outcome).toBe('done');
    const [orgId, batchId, queue] = sendBatch.mock.calls[0];
    expect(orgId).toBe('org-a');
    expect(batchId).toBe(job.id);
    expect(queue.items).toEqual([{ jid: '6591234567@s.whatsapp.net', displayName: 'Alice', clientId: 'alice', body: 'Hello', mediaPath: 'org-a/u1/img.png' }]);
    expect(queue.skipped.map((s) => s.reason)).toEqual(['SUPPRESSED']);
    const skippedHistory = db.table('message_history');
    expect(skippedHistory).toHaveLength(1);
    expect(skippedHistory[0]).toMatchObject({ org_id: 'org-a', batch_id: job.id, client_id: 'bob', status: 'SKIPPED', error_reason: 'SUPPRESSED' });
    expect(db.table('send_jobs')[0].status).toBe('done');
  });

  it('honours an opt-out at claim time even when the client changed their phone number since queueing', async () => {
    const { db, c } = setup();
    const job = await queued(c, ['alice', 'bob']);
    // Bob opts out AND his number is corrected afterwards. The recipient jid was frozen at
    // queue time, so a suppression set derived only from current phone numbers would miss him.
    const bob = db.table('clients').find((r) => r.id === 'bob')!;
    bob.suppressed_at = '2026-09-13T00:00:00Z';
    bob.phone_e164 = '+6590000001';
    const sendBatch = vi.fn(async (_org: string, _batch: string, _q: BuiltQueue) => {});
    await runSendJob({ supabase: c, userId: 'u1', checkRegistered: async (jids) => Object.fromEntries(jids.map((j) => [j, true])), sendBatch }, job);

    const [, , queue] = sendBatch.mock.calls[0];
    expect(queue.items.map((i) => i.clientId)).toEqual(['alice']);
    expect(queue.skipped).toEqual([{ jid: '6598765432@s.whatsapp.net', displayName: 'Bob', reason: 'SUPPRESSED' }]);
  });

  it('CAM-08: re-checks status at claim time and reports an inactive recipient under its own reason', async () => {
    const { db, c } = setup();
    const job = await queued(c, ['alice', 'bob']);
    // Bob goes inactive after the browser queued the job.
    db.table('clients').find((r) => r.id === 'bob')!.status = 'inactive';
    const sendBatch = vi.fn(async (_org: string, _batch: string, _q: BuiltQueue) => {});
    const outcome = await runSendJob({ supabase: c, userId: 'u1', checkRegistered: async (jids) => Object.fromEntries(jids.map((j) => [j, true])), sendBatch }, job);

    expect(outcome).toBe('done');
    const [, , queue] = sendBatch.mock.calls[0];
    expect(queue.skipped).toEqual([{ jid: '6598765432@s.whatsapp.net', displayName: 'Bob', reason: 'INACTIVE' }]);
    const skippedHistory = db.table('message_history');
    expect(skippedHistory).toContainEqual(expect.objectContaining({ client_id: 'bob', status: 'SKIPPED', error_reason: 'INACTIVE' }));
  });

  it('reports an already-expired job without claiming it', async () => {
    const { db, c } = setup();
    const job = await queued(c, ['alice']);
    db.table('send_jobs').find((r) => r.id === job.id)!.expires_at = '2000-01-01T00:00:00Z';
    const stale = db.table('send_jobs').find((r) => r.id === job.id) as unknown as SendJobRow;
    const sendBatch = vi.fn();
    expect(await runSendJob({ supabase: c, userId: 'u1', checkRegistered: async () => ({}), sendBatch }, stale)).toBe('expired');
    expect(sendBatch).not.toHaveBeenCalled();
    expect(db.table('send_jobs').find((r) => r.id === job.id)!.status).toBe('queued');
  });

  it('never runs a job created by another user', async () => {
    const { c } = setup();
    const job = await queued(c, ['alice'], 'u2');
    const sendBatch = vi.fn();
    expect(await runSendJob({ supabase: c, userId: 'u1', checkRegistered: async () => ({}), sendBatch }, job)).toBe('not-claimed');
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('marks the job failed when nobody can receive it or sending throws', async () => {
    const { db, c } = setup();
    const job = await queued(c, ['alice']);
    const sendBatch = vi.fn();
    expect(await runSendJob({ supabase: c, userId: 'u1', checkRegistered: async () => ({ '6591234567@s.whatsapp.net': false }), sendBatch }, job)).toBe('failed');
    expect(sendBatch).not.toHaveBeenCalled();
    expect(db.table('send_jobs')[0]).toMatchObject({ status: 'failed' });

    const job2 = await queued(c, ['bob']);
    const failing = vi.fn(async () => {
      throw new Error('WhatsApp offline');
    });
    expect(await runSendJob({ supabase: c, userId: 'u1', checkRegistered: async () => ({ '6598765432@s.whatsapp.net': true }), sendBatch: failing }, job2)).toBe('failed');
    expect(db.table('send_jobs').find((j) => j.id === job2.id)).toMatchObject({ status: 'failed', error: 'WhatsApp offline' });
  });

  it('fails closed if the suppression list cannot be read', async () => {
    const { db, c } = setup();
    const job = await queued(c, ['alice']);
    db.failWith('clients', { message: 'network down' }, 'select');
    const sendBatch = vi.fn();
    expect(await runSendJob({ supabase: c, userId: 'u1', checkRegistered: async () => ({}), sendBatch }, job)).toBe('failed');
    expect(sendBatch).not.toHaveBeenCalled();
  });
});

describe('SendJobRunner', () => {
  it('runs queued jobs of the member firms only, sequentially, and reacts to realtime inserts', async () => {
    const { db, c } = setup();
    const ran: string[] = [];
    const runner = new SendJobRunner({
      supabase: c,
      userId: 'u1',
      checkRegistered: async (jids) => Object.fromEntries(jids.map((j) => [j, true])),
      sendBatch: async (_o, batchId) => {
        ran.push(batchId);
      },
      getOrgIds: () => ['org-a'],
      isBusy: () => false,
      pollIntervalMs: 1_000_000,
    });
    const first = (await queueSendJob(c, { orgId: 'org-a', userId: 'u1', body: 'x', clientIds: ['alice'] })).job;
    db.table('send_jobs').push({ ...first, id: 'foreign-firm-job', org_id: 'org-z' });
    const stop = runner.start();
    await runner.poll();
    expect(ran).toEqual([first.id]);

    const second = (await queueSendJob(c, { orgId: 'org-a', userId: 'u1', body: 'y', clientIds: ['bob'] })).job;
    const channel = db.channels[0];
    expect(channel.handlers[0].filter).toMatchObject({ table: 'send_jobs', filter: 'created_by=eq.u1' });
    channel.emit('INSERT', second as unknown as Record<string, unknown>);
    await new Promise((r) => setTimeout(r, 10));
    await runner.poll();
    expect(ran).toEqual([first.id, second.id]);
    expect(db.table('send_jobs').find((j) => j.id === 'foreign-firm-job')!.status).toBe('queued');
    stop();
    expect(channel.removed).toBe(true);
  });

  it('waits while the phone is busy with another batch', async () => {
    const { c } = setup();
    let busy = true;
    const sendBatch = vi.fn(async () => {});
    const runner = new SendJobRunner({ supabase: c, userId: 'u1', checkRegistered: async () => ({ '6591234567@s.whatsapp.net': true }), sendBatch, getOrgIds: () => ['org-a'], isBusy: () => busy, pollIntervalMs: 1_000_000 });
    await queueSendJob(c, { orgId: 'org-a', userId: 'u1', body: 'x', clientIds: ['alice'] });
    runner.start();
    await runner.poll();
    expect(sendBatch).not.toHaveBeenCalled();
    busy = false;
    await runner.poll();
    expect(sendBatch).toHaveBeenCalledTimes(1);
    runner.stop();
  });
});

describe('DirectSender', () => {
  function bridge() {
    const resultCbs: ((e: SendResultEvent) => void)[] = [];
    const doneCbs: ((e: { batchId: string }) => void)[] = [];
    const sent: OutboxBatch[] = [];
    const b: Pick<NativeBridge, 'sendBatch' | 'onSendResult' | 'onBatchDone'> = {
      sendBatch: async (batch) => {
        sent.push(batch);
      },
      onSendResult: (cb) => {
        resultCbs.push(cb);
        return () => resultCbs.splice(resultCbs.indexOf(cb), 1);
      },
      onBatchDone: (cb) => {
        doneCbs.push(cb);
        return () => doneCbs.splice(doneCbs.indexOf(cb), 1);
      },
    };
    return { b, sent, result: (e: SendResultEvent) => resultCbs.forEach((cb) => cb(e)), done: (batchId: string) => doneCbs.forEach((cb) => cb({ batchId })) };
  }

  const queue: BuiltQueue = { items: [{ jid: 'a@s.whatsapp.net', displayName: 'Alice', clientId: 'alice', body: 'hi' }], skipped: [] };

  it('serializes batches, reports results by index and mirrors with client id', async () => {
    const { b, sent, result, done } = bridge();
    const mirror = vi.fn(async () => {});
    const sender = new DirectSender({ userId: 'u1', storage: new InMemoryLocalStore(), nativeBridge: b, mirror });
    sender.start();
    const events: string[] = [];
    await sender.send('org-a', 'batch-1', queue, (e) => events.push(e.type === 'result' ? `result:${e.index}:${e.result.status}` : e.type));
    expect(sender.busy).toBe(true);
    await expect(sender.send('org-a', 'batch-2', queue)).rejects.toBeInstanceOf(SenderBusyError);

    result({ id: sent[0].items[0].id, status: 'SENT' });
    const waiting = sender.waitForDone('batch-1');
    done('batch-1');
    await waiting;
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(['started', 'result:0:SENT', 'done']);
    expect(sender.busy).toBe(false);
    expect(mirror).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-a', batchId: 'batch-1', clientId: 'alice', status: 'SENT', displayName: 'Alice' }));
    await expect(sender.send('org-a', 'batch-2', queue)).resolves.toBeTruthy();
  });
});

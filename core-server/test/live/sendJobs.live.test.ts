import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveEnv, livePhone, setupLiveFixture, type LiveFixture } from './harness';

/**
 * docs/spec/test-plan.md §18.5 (TEN-23..TEN-25) — send_jobs, the queue a
 * browser writes and the user's own phone drains (crmex.md §15.10).
 *
 * The whole lifecycle lives in the send_jobs_guard trigger, so it binds every
 * writer including the service role. RLS adds the second half: any firm
 * member reads the firm's jobs, but only the creator — whose phone holds the
 * WhatsApp pairing — may change one.
 */
const live = liveEnv();
const describeLive = live ? describe : describe.skip;

describeLive('TEN (live): send_jobs lifecycle', () => {
  let f: LiveFixture;
  let clientA: string;
  let clientB: string;

  const recipients = [{ jid: '15550100@s.whatsapp.net' }];

  /** A fresh queued job created by A1, for cases that consume a job. */
  const queueJob = async (extra: Record<string, unknown> = {}) => {
    const { data, error } = await f.A1.db
      .from('send_jobs')
      .insert({ org_id: f.orgA, recipients, body: 'hello', ...extra })
      .select('*')
      .single();
    if (error) throw new Error(`queueJob: ${error.message}`);
    return data!;
  };

  beforeAll(async () => {
    f = await setupLiveFixture();

    const { data: ca, error: caErr } = await f.A1.db
      .from('clients')
      .insert({ org_id: f.orgA, display_name: 'Job client', phone_e164: livePhone(f.runId, 1) })
      .select('id')
      .single();
    if (caErr) throw new Error(`seed clientA: ${caErr.message}`);
    clientA = ca!.id;

    const { data: cb, error: cbErr } = await f.B1.db
      .from('clients')
      .insert({ org_id: f.orgB, display_name: 'Other firm client', phone_e164: livePhone(f.runId, 2) })
      .select('id')
      .single();
    if (cbErr) throw new Error(`seed clientB: ${cbErr.message}`);
    clientB = cb!.id;
  }, 120_000);

  afterAll(async () => {
    if (f) await f.teardown();
  }, 60_000);

  it('TEN-23: an insert defaults to queued, the caller, and a generated recipient_count', async () => {
    const job = await queueJob({
      recipients: [{ jid: '15550101@s.whatsapp.net', client_id: clientA }, { jid: '15550102@s.whatsapp.net' }],
    });
    expect(job.status).toBe('queued');
    expect(job.created_by).toBe(f.A1.id);
    expect(job.recipient_count).toBe(2);
    expect(job.claimed_at).toBeNull();
    expect(job.finished_at).toBeNull();
  });

  it("TEN-23: A2 sees the firm's jobs; B1 sees none", async () => {
    const job = await queueJob();

    const { data: seenByA2 } = await f.A2.db.from('send_jobs').select('id').eq('id', job.id);
    expect(seenByA2).toHaveLength(1);

    const { data: seenByB1 } = await f.B1.db.from('send_jobs').select('id').eq('id', job.id);
    expect(seenByB1).toEqual([]);
  });

  it('TEN-23: every malformed or cross-firm insert is rejected', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['a status other than queued', { org_id: f.orgA, recipients, body: 'x', status: 'claimed' }],
      ['created_by set to someone else', { org_id: f.orgA, recipients, body: 'x', created_by: f.A2.id }],
      ['another firm', { org_id: f.orgB, recipients, body: 'x' }],
      ["a client_id from another firm", { org_id: f.orgA, body: 'x', recipients: [{ jid: 'j@s.whatsapp.net', client_id: clientB }] }],
      ['empty recipients', { org_id: f.orgA, recipients: [], body: 'x' }],
      ['non-array recipients', { org_id: f.orgA, recipients: { jid: 'j@s.whatsapp.net' }, body: 'x' }],
      ['a recipient without a jid', { org_id: f.orgA, recipients: [{ name: 'no jid' }], body: 'x' }],
      ['a blank jid', { org_id: f.orgA, recipients: [{ jid: '   ' }], body: 'x' }],
      ['neither body nor media_path', { org_id: f.orgA, recipients }],
      ['a blank body and no media', { org_id: f.orgA, recipients, body: '   ' }],
    ];

    for (const [label, row] of cases) {
      const { error } = await f.A1.db.from('send_jobs').insert(row);
      expect(error, `insert with ${label} was accepted`).not.toBeNull();
    }
  });

  it('TEN-24: only the creator claims; the claim is atomic and single-winner', async () => {
    const job = await queueJob();

    // Another member of the firm, and another firm, change nothing.
    const { data: byA2, error: a2Err } = await f.A2.db
      .from('send_jobs')
      .update({ status: 'claimed' })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id');
    expect(a2Err === null ? byA2 : []).toEqual([]);

    const { data: byB1, error: b1Err } = await f.B1.db
      .from('send_jobs')
      .update({ status: 'cancelled' })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id');
    expect(b1Err === null ? byB1 : []).toEqual([]);

    // The creator's phone claims it: exactly one row, claimed_at set by the DB.
    const { data: first, error: firstErr } = await f.A1.db
      .from('send_jobs')
      .update({ status: 'claimed' })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('*');
    expect(firstErr).toBeNull();
    expect(first).toHaveLength(1);
    expect(first![0].claimed_at, 'claimed_at must be stamped by the database').not.toBeNull();

    // A second device running the same statement gets nothing.
    const { data: second, error: secondErr } = await f.A1.db
      .from('send_jobs')
      .update({ status: 'claimed' })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('*');
    expect(secondErr).toBeNull();
    expect(second, 'a second claim must win nothing').toEqual([]);

    // A re-claim that forgot the status filter must fail loudly, not "succeed".
    const { error: reclaimErr } = await f.A1.db
      .from('send_jobs')
      .update({ status: 'claimed' })
      .eq('id', job.id)
      .select('id');
    expect(reclaimErr, 'an unfiltered re-claim must raise').not.toBeNull();

    // While claimed, updating only `error` is allowed.
    const { data: errOnly, error: errOnlyErr } = await f.A1.db
      .from('send_jobs')
      .update({ error: 'recipient 3 failed' })
      .eq('id', job.id)
      .select('id, status, error');
    expect(errOnlyErr).toBeNull();
    expect(errOnly).toHaveLength(1);
    expect(errOnly![0].status).toBe('claimed');
  });

  it('TEN-25: illegal transitions and content edits are rejected; claimed -> done is stamped by the DB', async () => {
    const job = await queueJob();
    await f.A1.db.from('send_jobs').update({ status: 'claimed' }).eq('id', job.id).eq('status', 'queued').select('id');

    const { error: backToQueued } = await f.A1.db
      .from('send_jobs')
      .update({ status: 'queued' })
      .eq('id', job.id)
      .select('id');
    expect(backToQueued, 'claimed -> queued must be rejected').not.toBeNull();

    const { error: cancelClaimed } = await f.A1.db
      .from('send_jobs')
      .update({ status: 'cancelled' })
      .eq('id', job.id)
      .select('id');
    expect(cancelClaimed, 'claimed -> cancelled must be rejected').not.toBeNull();

    for (const [label, patch] of [
      ['recipients', { recipients: [{ jid: 'swapped@s.whatsapp.net' }] }],
      ['body', { body: 'rewritten after queueing' }],
      ['media_path', { media_path: 'somewhere/else.png' }],
      ['org_id', { org_id: f.orgB }],
    ] as const) {
      const { error } = await f.A1.db.from('send_jobs').update(patch).eq('id', job.id).select('id');
      expect(error, `${label} was editable after insert`).not.toBeNull();
    }

    // A legal finish. The client's finished_at is ignored in favour of now().
    const clientSupplied = '2000-01-01T00:00:00.000Z';
    const { data: done, error: doneErr } = await f.A1.db
      .from('send_jobs')
      .update({ status: 'done', finished_at: clientSupplied })
      .eq('id', job.id)
      .eq('status', 'claimed')
      .select('status, finished_at');
    expect(doneErr).toBeNull();
    expect(done![0].status).toBe('done');
    expect(done![0].finished_at).not.toBe(clientSupplied);
    expect(new Date(done![0].finished_at).getUTCFullYear()).toBeGreaterThan(2000);

    // done is terminal, for the service role as well.
    const { error: revive } = await f.A1.db.from('send_jobs').update({ status: 'queued' }).eq('id', job.id).select('id');
    expect(revive).not.toBeNull();
    const { error: svcRevive } = await f.admin
      .from('send_jobs')
      .update({ status: 'queued' })
      .eq('id', job.id)
      .select('id');
    expect(svcRevive, 'the service role must not be able to revive a finished job').not.toBeNull();
  });

  it('TEN-25: queued -> cancelled is legal and stamps finished_at; jobs cannot be deleted', async () => {
    const job = await queueJob();

    const { data: cancelled, error } = await f.A1.db
      .from('send_jobs')
      .update({ status: 'cancelled' })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('status, finished_at');
    expect(error).toBeNull();
    expect(cancelled![0].status).toBe('cancelled');
    expect(cancelled![0].finished_at).not.toBeNull();

    const { data: deleted, error: delErr } = await f.A1.db.from('send_jobs').delete().eq('id', job.id).select('id');
    expect(delErr === null ? deleted : []).toEqual([]);
  });
});

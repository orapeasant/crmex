import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createFakeSupabaseClient, FakeSupabaseDb } from '../testing/fakeSupabase.js';
import { mirrorMessageResult, isSuppressed, addSuppression, listImageSessions, refreshSignedUrl } from './repo.js';

function client() {
  const db = new FakeSupabaseDb();
  const c = createFakeSupabaseClient(db) as unknown as SupabaseClient;
  return { db, c };
}

describe('mirrorMessageResult (§9.2 mirror step)', () => {
  it('writes a message_history row with the expected shape', async () => {
    const { db, c } = client();
    await mirrorMessageResult(c, {
      orgId: 'org-a',
      jid: '201001234567@s.whatsapp.net',
      displayName: 'Alice',
      body: 'hello',
      status: 'SENT',
      batchId: 'batch-1',
    });
    const rows = db.table('message_history');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: 'org-a', jid: '201001234567@s.whatsapp.net', status: 'SENT', batch_id: 'batch-1' });
  });
});

describe('suppression list (SAF-03)', () => {
  it('a jid is not suppressed until explicitly added, then stays suppressed', async () => {
    const { c } = client();
    const jid = '201001234567@s.whatsapp.net';
    expect(await isSuppressed(c, 'org-a', jid)).toBe(false);
    await addSuppression(c, 'org-a', jid);
    expect(await isSuppressed(c, 'org-a', jid)).toBe(true);
  });

  it('is scoped to the firm: a suppression in one firm does not suppress in another', async () => {
    const { c } = client();
    const jid = '201001234567@s.whatsapp.net';
    await addSuppression(c, 'org-a', jid);
    expect(await isSuppressed(c, 'org-b', jid)).toBe(false);
    await addSuppression(c, 'org-b', jid);
    expect(await isSuppressed(c, 'org-a', jid)).toBe(true);
    expect(await isSuppressed(c, 'org-b', jid)).toBe(true);
  });
});

describe('listImageSessions', () => {
  it('returns rows ordered by updated_at descending', async () => {
    const { db, c } = client();
    db.table('image_sessions').push(
      { id: 1, org_id: 'org-a', updated_at: '2026-01-01T00:00:00Z', source: 'generated' },
      { id: 2, org_id: 'org-a', updated_at: '2026-02-01T00:00:00Z', source: 'searched' },
      { id: 3, org_id: 'org-b', updated_at: '2026-03-01T00:00:00Z', source: 'generated' },
    );
    const rows = await listImageSessions(c, 'org-a');
    expect(rows.map((r) => r.id)).toEqual([2, 1]);
  });
});

describe('refreshSignedUrl (ISO-11 shape)', () => {
  it('returns a signed URL for a known object and errors for an unknown one', async () => {
    const { db, c } = client();
    db.storageObjects.set('user-images/u1/abc.png', Buffer.from('x'));
    const url = await refreshSignedUrl(c, 'u1/abc.png', 60);
    expect(url).toContain('u1/abc.png');
    await expect(refreshSignedUrl(c, 'u1/missing.png')).rejects.toThrow();
  });
});

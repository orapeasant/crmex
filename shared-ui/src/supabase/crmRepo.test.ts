import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createFakeSupabaseClient, FakeSupabaseDb } from '../testing/fakeSupabase.js';
import {
  CrmPermissionError,
  deleteClient,
  getClientById,
  importClients,
  insertClient,
  insertMatter,
  insertTask,
  linkClientToMatter,
  listClients,
  listMatterClients,
  listMatters,
  listMessageHistory,
  listOrgMemberRows,
  listTasks,
  setClientSuppressed,
  setTaskDone,
  unlinkClientFromMatter,
  updateClient,
  updateTask,
} from './crmRepo.js';
import { mirrorMessageResult } from './repo.js';

const FIRM_TABLES = new Set(['clients', 'matters', 'matter_clients', 'tasks', 'org_members', 'message_history']);

function setup() {
  const db = new FakeSupabaseDb();
  db.uniques.set('clients', [['org_id', 'phone_e164']]);
  db.uniques.set('matters', [['org_id', 'matter_number']]);
  const c = createFakeSupabaseClient(db) as unknown as SupabaseClient;
  return { db, c };
}

/** Every read/update/delete on a firm table filtered by org_id; every insert set it. */
function expectFirmScoped(db: FakeSupabaseDb) {
  for (const q of db.queries) {
    if (!FIRM_TABLES.has(q.table)) continue;
    if (q.op === 'insert' || q.op === 'upsert') {
      for (const row of q.payload as Record<string, unknown>[]) expect(row.org_id, `${q.table} insert without org_id`).toBeTruthy();
    } else {
      expect(
        q.filters.some((f) => f.col === 'org_id' && f.op === 'eq'),
        `${q.op} on ${q.table} without org_id filter`,
      ).toBe(true);
    }
  }
}

describe('crmRepo firm isolation', () => {
  it('lists only the active firm even when rows of another firm are visible', async () => {
    const { db, c } = setup();
    await insertClient(c, 'org-a', { display_name: 'Alice' });
    await insertClient(c, 'org-b', { display_name: 'Bob' });
    expect((await listClients(c, 'org-a')).map((r) => r.display_name)).toEqual(['Alice']);
    expect((await listClients(c, 'org-b')).map((r) => r.display_name)).toEqual(['Bob']);
    expectFirmScoped(db);
  });

  it('cannot read, update or delete a row of another firm by id', async () => {
    const { db, c } = setup();
    const bob = await insertClient(c, 'org-b', { display_name: 'Bob' });
    expect(await getClientById(c, 'org-a', bob.id)).toBeNull();
    await expect(updateClient(c, 'org-a', bob.id, { display_name: 'Hacked' })).rejects.toBeInstanceOf(CrmPermissionError);
    await expect(deleteClient(c, 'org-a', bob.id)).rejects.toBeInstanceOf(CrmPermissionError);
    expect((await getClientById(c, 'org-b', bob.id))?.display_name).toBe('Bob');
    expectFirmScoped(db);
  });

  it('never lets caller-supplied fields change org_id, id or created_by', async () => {
    const { db, c } = setup();
    const row = await insertClient(c, 'org-a', { display_name: 'Alice', org_id: 'org-b', id: 'forced', created_by: 'someone' } as never);
    expect(row.org_id).toBe('org-a');
    expect(row.id).not.toBe('forced');
    expect(row.created_by).toBeUndefined(); // left to the column default auth.uid()
    const updated = await updateClient(c, 'org-a', row.id, { display_name: 'Alice T', org_id: 'org-b' } as never);
    expect(updated.org_id).toBe('org-a');
    expectFirmScoped(db);
  });

  it('requires an explicit firm', async () => {
    const { c } = setup();
    await expect(listClients(c, '')).rejects.toThrow(/ORG_REQUIRED/);
  });

  it('treats an RLS-refused delete (0 rows) as a permission error', async () => {
    const { db, c } = setup();
    const row = await insertClient(c, 'org-a', { display_name: 'Alice' });
    // Simulate RLS for a plain member: the delete matches nothing.
    db.tables.set('clients', []);
    await expect(deleteClient(c, 'org-a', row.id)).rejects.toBeInstanceOf(CrmPermissionError);
  });
});

describe('clients', () => {
  it('cleans input: trims, empty strings become null', async () => {
    const { c } = setup();
    const row = await insertClient(c, 'org-a', { display_name: '  Alice ', email: ' ', notes: '', phone_e164: '+6591234567', tags: ['vip'] });
    expect(row).toMatchObject({ display_name: 'Alice', email: null, notes: null, phone_e164: '+6591234567', tags: ['vip'], source: 'manual', org_id: 'org-a' });
  });

  it('sets and clears suppression', async () => {
    const { c } = setup();
    const row = await insertClient(c, 'org-a', { display_name: 'Alice' });
    const now = new Date('2026-09-13T00:00:00Z');
    expect((await setClientSuppressed(c, 'org-a', row.id, true, now)).suppressed_at).toBe(now.toISOString());
    expect((await setClientSuppressed(c, 'org-a', row.id, false)).suppressed_at).toBeNull();
  });

  it('imports phone contacts as phone_import, skipping phones the firm already has', async () => {
    const { db, c } = setup();
    await insertClient(c, 'org-a', { display_name: 'Alice', phone_e164: '+6591234567' });
    // Same phone in another firm must not block the import in this firm.
    await insertClient(c, 'org-b', { display_name: 'Other firm Bob', phone_e164: '+6598765432' });
    const res = await importClients(c, 'org-a', [
      { id: '1', displayName: 'Alice', e164: '+6591234567', jid: '6591234567@s.whatsapp.net' },
      { id: '2', displayName: 'Bob', e164: '+6598765432', jid: '6598765432@s.whatsapp.net' },
    ]);
    expect(res.inserted.map((r) => [r.display_name, r.source, r.org_id])).toEqual([['Bob', 'phone_import', 'org-a']]);
    expect(res.alreadyClients).toHaveLength(1);
    expect((await listClients(c, 'org-a')).length).toBe(2);
    expectFirmScoped(db);
  });
});

describe('matters, links and tasks', () => {
  it('links clients to matters within the firm and unlinks them', async () => {
    const { db, c } = setup();
    const m = await insertMatter(c, 'org-a', { matter_number: '2026-001', title: 'Estate of X' });
    const cl = await insertClient(c, 'org-a', { display_name: 'Alice' });
    await linkClientToMatter(c, 'org-a', m.id, cl.id, 'client');
    expect(await listMatterClients(c, 'org-a', { matterId: m.id })).toHaveLength(1);
    expect(await listMatterClients(c, 'org-a', { clientId: cl.id })).toHaveLength(1);
    expect(await listMatterClients(c, 'org-b', { matterId: m.id })).toHaveLength(0);
    await unlinkClientFromMatter(c, 'org-a', m.id, cl.id);
    expect(await listMatterClients(c, 'org-a', { matterId: m.id })).toHaveLength(0);
    expect((await listMatters(c, 'org-a')).map((r) => r.title)).toEqual(['Estate of X']);
    expectFirmScoped(db);
  });

  it('surfaces a duplicate matter number as the database error', async () => {
    const { c } = setup();
    await insertMatter(c, 'org-a', { matter_number: '2026-001', title: 'A' });
    await expect(insertMatter(c, 'org-a', { matter_number: '2026-001', title: 'B' })).rejects.toMatchObject({ code: '23505' });
    await expect(insertMatter(c, 'org-b', { matter_number: '2026-001', title: 'B' })).resolves.toBeTruthy();
  });

  it('creates, filters, completes and reopens tasks', async () => {
    const { db, c } = setup();
    const t = await insertTask(c, 'org-a', { title: ' File brief ', kind: 'deadline', matter_id: 'm1', assignee_id: '' });
    expect(t).toMatchObject({ title: 'File brief', status: 'open', assignee_id: null, org_id: 'org-a' });
    await insertTask(c, 'org-a', { title: 'Other' });
    expect(await listTasks(c, 'org-a', { matterId: 'm1' })).toHaveLength(1);
    const done = await setTaskDone(c, 'org-a', t.id, true, new Date('2026-09-13T00:00:00Z'));
    expect(done).toMatchObject({ status: 'done', completed_at: '2026-09-13T00:00:00.000Z' });
    expect((await setTaskDone(c, 'org-a', t.id, false)).completed_at).toBeNull();
    expect((await updateTask(c, 'org-a', t.id, { due_at: '2026-10-01T00:00:00Z' })).due_at).toBe('2026-10-01T00:00:00Z');
    expectFirmScoped(db);
  });

  it('reads members and message history of the active firm only', async () => {
    const { db, c } = setup();
    db.table('org_members').push(
      { org_id: 'org-a', user_id: 'u1', role: 'owner', email: 'a@x', display_name: 'A' },
      { org_id: 'org-b', user_id: 'u9', role: 'owner', email: 'b@x', display_name: 'B' },
    );
    expect((await listOrgMemberRows(c, 'org-a')).map((m) => m.user_id)).toEqual(['u1']);

    await mirrorMessageResult(c, { orgId: 'org-a', jid: 'j', clientId: 'client-1', status: 'SENT', batchId: 'b1' });
    await mirrorMessageResult(c, { orgId: 'org-b', jid: 'j', clientId: 'client-1', status: 'SENT', batchId: 'b2' });
    db.table('message_history').forEach((r, i) => (r.created_at = `2026-09-0${i + 1}T00:00:00Z`));
    const rows = await listMessageHistory(c, 'org-a', { clientId: 'client-1' });
    expect(rows.map((r) => r.batch_id)).toEqual(['b1']);
    expect(rows[0].client_id).toBe('client-1');
    expectFirmScoped(db);
  });
});

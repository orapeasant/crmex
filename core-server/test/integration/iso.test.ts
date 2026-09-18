import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createFakeSupabaseClient, FakeDb, fetchViaSignedUrl, makeFakeToken } from '../fakes/fakeSupabaseClient';
import { buildTestApp, firmAuth, ORG_A, ORG_B, seedFirm } from '../helpers/buildTestApp';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const PATH_A = `${ORG_A}/A1/${HASH_A}.png`;
const PATH_B = `${ORG_B}/B1/${HASH_B}.png`;

/**
 * ISO-01..11 (firm axis, crmex.md §15.4 layers 1 and 3): "direct from client
 * via supabase-js + RLS" cases — core-server is not involved. They run
 * against test/fakes/fakeSupabaseClient.ts, which enforces the policies
 * declared in supabase/migrations/20260913000000_multi_tenancy.sql
 * (is_org_member / has_org_role and the firm folder policy on Storage)
 * rather than always succeeding, so they stay fast and need no credentials.
 *
 * A fake can only prove that the policies were modelled correctly, never that
 * the database enforces them. test/live/ runs the same ground against a real
 * Supabase project (`pnpm test:live`); keep the two in step when either the
 * migrations or the fake change.
 *
 * Firm A has A1 (owner) and A2 (member); Firm B has B1.
 *
 * ISO-12 / ISO-20 are server-side controls, tested against core-server routes.
 * The route-by-route firm isolation suite lives in tenancy.test.ts.
 */
describe('ISO: firm isolation at the RLS / Storage layer', () => {
  let db: FakeDb;
  const client = (userId: string) => createFakeSupabaseClient({ db, mode: 'user', userId });

  beforeEach(() => {
    db = new FakeDb();
    seedFirm(db, ORG_A, [
      { userId: 'A1', role: 'owner' },
      { userId: 'A2', role: 'member' },
    ]);
    seedFirm(db, ORG_B, [{ userId: 'B1', role: 'owner' }]);
    db.seed('message_history', { org_id: ORG_A, user_id: 'A1', jid: 'a@s.whatsapp.net', body: 'hi', batch_id: 'b1', status: 'SENT' });
    db.seed('message_history', { org_id: ORG_B, user_id: 'B1', jid: 'b@s.whatsapp.net', body: 'hey', batch_id: 'b2', status: 'SENT' });
    db.seed('image_sessions', { org_id: ORG_A, user_id: 'A1', prompt_history: [], current_path: PATH_A, source: 'generated' });
    db.seed('image_sessions', { org_id: ORG_B, user_id: 'B1', prompt_history: [], current_path: PATH_B, source: 'generated' });
    db.seed('contact_meta', { org_id: ORG_A, user_id: 'A1', jid: 'a@s.whatsapp.net', tags: ['vip'] });
    db.seed('contact_meta', { org_id: ORG_B, user_id: 'B1', jid: 'b@s.whatsapp.net', tags: ['vip'] });
    db.seed('org_invitations', { org_id: ORG_A, email: null, role: 'member', token_hash: 'h1', expires_at: '2099-01-01T00:00:00.000Z' });
    db.seedObject(PATH_A, Buffer.from('A-image-bytes'));
    db.seedObject(PATH_B, Buffer.from('B-image-bytes'));
  });

  it('ISO-01: firm members share message_history; B1 sees only Firm B rows', async () => {
    const a2 = await client('A2').from('message_history').select('*');
    expect(a2.data!.map((r) => r.org_id)).toEqual([ORG_A]); // A2 sees A1's row
    const b1 = await client('B1').from('message_history').select('*');
    expect(b1.data!.map((r) => r.org_id)).toEqual([ORG_B]);
  });

  it('ISO-02: image_sessions are shared within a firm and invisible across firms', async () => {
    expect((await client('A2').from('image_sessions').select('*')).data!.map((r) => r.org_id)).toEqual([ORG_A]);
    expect((await client('B1').from('image_sessions').select('*').eq('org_id', ORG_A)).data).toEqual([]);
  });

  it('ISO-03: contact_meta is shared within a firm and invisible across firms', async () => {
    expect((await client('A2').from('contact_meta').select('*')).data).toHaveLength(1);
    expect((await client('B1').from('contact_meta').select('*')).data!.map((r) => r.org_id)).toEqual([ORG_B]);
  });

  it('ISO-04: B1 inserting a row into Firm A is rejected by the with-check clause, even attributed to itself', async () => {
    const { data, error } = await client('B1')
      .from('message_history')
      .insert({ org_id: ORG_A, user_id: 'B1', jid: 'x', body: 'x', batch_id: 'x', status: 'SENT' });
    expect(error).not.toBeNull();
    expect(data).toBeNull();
    // ...and a member cannot attribute a row to someone else either.
    const forged = await client('A2')
      .from('message_history')
      .insert({ org_id: ORG_A, user_id: 'A1', jid: 'x', body: 'x', batch_id: 'x', status: 'SENT' });
    expect(forged.error).not.toBeNull();
  });

  it('ISO-05: B1 updating a Firm A row by id affects zero rows; image_sessions has no client write path at all', async () => {
    const aContact = db.tables.contact_meta.find((r) => r.org_id === ORG_A)!;
    const cross = await client('B1').from('contact_meta').update({ tags: ['pwned'] }).eq('id', aContact.id);
    expect(cross.data).toEqual([]);
    expect(db.tables.contact_meta.find((r) => r.id === aContact.id)!.tags).toEqual(['vip']);

    const aSession = db.tables.image_sessions.find((r) => r.org_id === ORG_A)!;
    const own = await client('A1').from('image_sessions').update({ current_path: 'x' }).eq('id', aSession.id);
    expect(own.data).toEqual([]);
    expect(db.tables.image_sessions.find((r) => r.id === aSession.id)!.current_path).toBe(PATH_A);
  });

  it('ISO-06: deleting another firm\'s rows by id affects zero rows', async () => {
    const aRow = db.tables.message_history.find((r) => r.org_id === ORG_A)!;
    const { data, error } = await client('B1').from('message_history').delete().eq('id', aRow.id);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(db.tables.message_history.find((r) => r.id === aRow.id)).toBeDefined();
  });

  it('ISO-06b: a client cannot grant itself a membership, a role, or read another firm\'s tenancy rows', async () => {
    const join = await client('B1').from('org_members').insert({ org_id: ORG_A, user_id: 'B1', role: 'owner' });
    expect(join.error).not.toBeNull();
    const promote = await client('A2').from('org_members').update({ role: 'owner' }).eq('org_id', ORG_A).eq('user_id', 'A2');
    expect(promote.data).toEqual([]);
    expect(db.tables.org_members.find((m) => m.user_id === 'A2')!.role).toBe('member');

    expect((await client('B1').from('organizations').select('*')).data!.map((o) => o.id)).toEqual([ORG_B]);
    expect((await client('B1').from('org_members').select('*').eq('org_id', ORG_A)).data).toEqual([]);
    // Invitations are owner/admin only, even within the firm.
    expect((await client('A2').from('org_invitations').select('*')).data).toEqual([]);
    expect((await client('A1').from('org_invitations').select('*')).data).toHaveLength(1);
    expect((await client('A1').from('org_usage_daily').select('*')).data).toEqual([]);
  });

  it('ISO-07: an unauthenticated (anon) GET of a known object path is denied — the bucket is private, not public', async () => {
    const anon = createFakeSupabaseClient({ db, mode: 'anon' });
    const { data, error } = await anon.storage.from('user-images').download(PATH_A);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it('ISO-08: B1 requesting a signed URL for an object under Firm A is denied; no URL issued', async () => {
    const { data, error } = await client('B1').storage.from('user-images').createSignedUrl(PATH_A, 60);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it('ISO-09: B1 downloading Firm A\'s object is denied; A2 (same firm, different uploader) may read it', async () => {
    expect((await client('B1').storage.from('user-images').download(PATH_A)).error).not.toBeNull();
    expect((await client('A2').storage.from('user-images').download(PATH_A)).error).toBeNull();
  });

  it('ISO-10: client uploads are denied everywhere, including into the caller\'s own firm (writes are server-side only)', async () => {
    const cross = await client('B1').storage.from('user-images').upload(`${ORG_A}/B1/${HASH_B}.png`, Buffer.from('evil'));
    const own = await client('A1').storage.from('user-images').upload(`${ORG_A}/A1/${HASH_B}.png`, Buffer.from('x'));
    expect(cross.error).not.toBeNull();
    expect(own.error).not.toBeNull();
    expect(db.storage.has(`${ORG_A}/B1/${HASH_B}.png`)).toBe(false);
  });

  it('ISO-10b: a legacy per-user or non-uuid first folder is readable by no one', async () => {
    db.seedObject(`A1/${HASH_A}.png`, Buffer.from('legacy'));
    expect((await client('A1').storage.from('user-images').download(`A1/${HASH_A}.png`)).error).not.toBeNull();
  });

  it('ISO-11: a valid signed URL for a firm object fetches successfully, and fails after TTL expiry', async () => {
    const { data, error } = await client('A2').storage.from('user-images').createSignedUrl(PATH_A, 60);
    expect(error).toBeNull();

    expect('bytes' in fetchViaSignedUrl(db, data!.signedUrl, db.now() + 30_000)).toBe(true);
    expect('error' in fetchViaSignedUrl(db, data!.signedUrl, db.now() + 61_000)).toBe(true);
  });

  it('ISO-11b: removal ends RLS access on the very next query (no cached membership)', async () => {
    expect((await client('A2').from('message_history').select('*')).data).toHaveLength(1);
    db.tables.org_members = db.tables.org_members.filter((m) => m.user_id !== 'A2');
    expect((await client('A2').from('message_history').select('*')).data).toEqual([]);
    expect((await client('A2').storage.from('user-images').download(PATH_A)).error).not.toBeNull();
  });

  it('ISO-12: org_id / user_id in a request body are ignored; the operation is scoped to the verified firm and caller', async () => {
    const { app } = buildTestApp({ db });

    const res = await request(app)
      .post('/api/v1/images/generate')
      .set(firmAuth('B1', ORG_B))
      .send({ prompt: 'a cat', user_id: 'A1', org_id: ORG_A, orgId: ORG_A } as any);

    expect(res.status).toBe(200);
    expect(res.body.path.startsWith(`${ORG_B}/B1/`)).toBe(true);
    const createdRow = db.tables.image_sessions.find((r) => r.id === res.body.sessionId)!;
    expect(createdRow.org_id).toBe(ORG_B);
    expect(createdRow.user_id).toBe('B1');
  });

  it('ISO-20: two firms submitting the identical prompt each get a distinct object under their own firm folder', async () => {
    const { app } = buildTestApp({ db });

    const resA = await request(app).post('/api/v1/images/generate').set(firmAuth('A1', ORG_A)).send({ prompt: 'a red bicycle' });
    const resB = await request(app).post('/api/v1/images/generate').set(firmAuth('B1', ORG_B)).send({ prompt: 'a red bicycle' });

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.path).not.toBe(resB.body.path);
    expect(resA.body.path.startsWith(`${ORG_A}/`)).toBe(true);
    expect(resB.body.path.startsWith(`${ORG_B}/`)).toBe(true);

    expect((await client('A1').storage.from('user-images').download(resB.body.path)).error).not.toBeNull();
    expect((await client('B1').storage.from('user-images').download(resA.body.path)).error).not.toBeNull();
  });

  it('ISO-12b: a token for one user plus another firm\'s X-Org-Id is refused before any work', async () => {
    const { app, imageGenProvider } = buildTestApp({ db });
    const res = await request(app)
      .post('/api/v1/images/generate')
      .set({ Authorization: `Bearer ${makeFakeToken({ sub: 'B1' })}`, 'X-Org-Id': ORG_A })
      .send({ prompt: 'x' });
    expect(res.status).toBe(403);
    expect(imageGenProvider.generateCalls).toHaveLength(0);
  });
});

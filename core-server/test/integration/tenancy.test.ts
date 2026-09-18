import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import { buildTestApp, firmAuth, ORG_A, ORG_B, seedFirm, type TestAppBundle } from '../helpers/buildTestApp';
import { makeFakeToken } from '../fakes/fakeSupabaseClient';
import { createFakeLlmProvider } from '../../src/providers/llm/fake';
import { createOrgService } from '../../src/agent/orgService';

/**
 * Firm-axis isolation suite (crmex.md §15.9) against core-server routes —
 * layer 2 of §15.4. Firm A: A1 (owner), A2 (member). Firm B: B1 (owner).
 * RLS / Storage-policy cases for the same fixture live in iso.test.ts.
 */

const UNKNOWN_ORG = 'cccccccc-0000-4000-8000-00000000000c';
const DAY_MS = 86_400_000;

const bearer = (sub: string, extra: Parameters<typeof makeFakeToken>[0] | object = {}) => ({
  Authorization: `Bearer ${makeFakeToken({ sub, ...extra })}`,
});

let t: TestAppBundle;
const api = () => request(t.app);

beforeEach(() => {
  t = buildTestApp({ llmProvider: createFakeLlmProvider({ chatResponse: () => '["c1"]' }) });
  seedFirm(t.db, ORG_A, [
    { userId: 'A1', role: 'owner' },
    { userId: 'A2', role: 'member' },
  ]);
  seedFirm(t.db, ORG_B, [{ userId: 'B1', role: 'owner' }]);
});

async function generateAs(sub: string, orgId: string) {
  const res = await api().post('/api/v1/images/generate').set(firmAuth(sub, orgId)).send({ prompt: 'a courthouse' });
  expect(res.status).toBe(200);
  return res.body as { sessionId: number; path: string; signedUrl: string };
}

/** Every firm-scoped route, as [method, path, body]. */
function firmRoutes(sessionId: number | string) {
  return [
    ['post', '/api/v1/messages/draft', { prompt: 'hello' }],
    ['post', '/api/v1/contacts/match', { query: 'clients', index: [{ id: 'c1', displayName: 'Client' }] }],
    ['post', '/api/v1/images/generate', { prompt: 'x' }],
    ['post', `/api/v1/images/${sessionId}/refine`, { instruction: 'y' }],
    ['post', '/api/v1/images/search', { query: 'x' }],
    ['post', '/api/v1/images/search/select', { sourceUrl: 'https://example.com/a.jpg', query: 'x' }],
  ] as const;
}

describe('firm selection (X-Org-Id)', () => {
  it('missing or malformed X-Org-Id is 400 ORG_REQUIRED on every firm-scoped route', async () => {
    for (const [, path, body] of firmRoutes(1)) {
      const missing = await api().post(path).set(bearer('A1')).send(body);
      expect(missing.status, path).toBe(400);
      expect(missing.body.error.code).toBe('ORG_REQUIRED');

      const malformed = await api().post(path).set({ ...bearer('A1'), 'X-Org-Id': `${ORG_A}' or 1=1` }).send(body);
      expect(malformed.status, path).toBe(400);
      expect(malformed.body.error.code).toBe('ORG_REQUIRED');
    }
  });

  it('B1 with a forged X-Org-Id gets 403 NOT_A_MEMBER on every firm-scoped route, with no side effects', async () => {
    const { sessionId } = await generateAs('A1', ORG_A);
    const sessionsBefore = t.db.tables.image_sessions.length;
    const llmCallsBefore = t.llmProvider.calls.length;

    for (const [, path, body] of firmRoutes(sessionId)) {
      const res = await api().post(path).set(firmAuth('B1', ORG_A)).send(body);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('NOT_A_MEMBER');
    }
    expect(t.db.tables.image_sessions).toHaveLength(sessionsBefore);
    expect(t.llmProvider.calls).toHaveLength(llmCallsBefore);
    expect(t.imageGenProvider.generateCalls).toHaveLength(1);
    expect(t.imageSearchProvider).toBeDefined();
  });

  it('an unknown firm id and a firm the caller is not in produce identical responses (no existence leak)', async () => {
    const real = await api().post('/api/v1/messages/draft').set(firmAuth('B1', ORG_A)).send({ prompt: 'x' });
    const unknown = await api().post('/api/v1/messages/draft').set(firmAuth('B1', UNKNOWN_ORG)).send({ prompt: 'x' });
    expect(unknown.status).toBe(real.status);
    expect(unknown.body).toEqual(real.body);

    const realMembers = await api().get(`/api/v1/orgs/${ORG_A}/members`).set(bearer('B1'));
    const unknownMembers = await api().get(`/api/v1/orgs/${UNKNOWN_ORG}/members`).set(bearer('B1'));
    expect(realMembers.status).toBe(403);
    expect(unknownMembers.body).toEqual(realMembers.body);
  });

  it('accepts an upper-case firm id but scopes everything to the canonical lower-case id', async () => {
    const res = await api().post('/api/v1/images/generate').set(firmAuth('A1', ORG_A.toUpperCase())).send({ prompt: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.path.startsWith(`${ORG_A}/A1/`)).toBe(true);
  });
});

describe('sharing within a firm, isolation across firms', () => {
  it('A1 and A2 share firm image sessions: A2 can refine A1\'s session, under A2\'s own folder', async () => {
    const gen = await generateAs('A1', ORG_A);

    const refine = await api().post(`/api/v1/images/${gen.sessionId}/refine`).set(firmAuth('A2', ORG_A)).send({ instruction: 'add a flag' });

    expect(refine.status).toBe(200);
    expect(refine.body.path.startsWith(`${ORG_A}/A2/`)).toBe(true);
    expect(refine.body.promptHistory).toHaveLength(2);
  });

  it('B1 cannot reach a Firm A session through Firm B either: 404, and nothing is signed', async () => {
    const gen = await generateAs('A1', ORG_A);
    const signedBefore = t.db.signedUrls.size;

    const res = await api().post(`/api/v1/images/${gen.sessionId}/refine`).set(firmAuth('B1', ORG_B)).send({ instruction: 'y' });

    expect(res.status).toBe(404);
    expect(t.db.signedUrls.size).toBe(signedBefore);
    expect(t.imageGenProvider.editCalls).toHaveLength(0);
  });

  it('storage paths and signed URLs never cross firms', async () => {
    const a = await generateAs('A1', ORG_A);
    const b = await generateAs('B1', ORG_B);

    expect(a.path.split('/')[0]).toBe(ORG_A);
    expect(b.path.split('/')[0]).toBe(ORG_B);
    expect(a.signedUrl).toContain(`/${ORG_A}/`);
    expect(a.signedUrl).not.toContain(ORG_B);
    expect(b.signedUrl).not.toContain(ORG_A);
    for (const { path } of t.db.signedUrls.values()) {
      expect([a.path, b.path]).toContain(path);
    }
  });

  it('a session row whose current_path is outside its firm is never downloaded or signed', async () => {
    const gen = await generateAs('A1', ORG_A);
    const row = t.db.tables.image_sessions.find((r) => r.id === gen.sessionId)!;
    const foreign = await generateAs('B1', ORG_B);
    row.current_path = foreign.path; // simulated corruption / bad migration

    const res = await api().post(`/api/v1/images/${gen.sessionId}/refine`).set(firmAuth('A1', ORG_A)).send({ instruction: 'y' });

    expect(res.status).toBe(404);
    expect(t.imageGenProvider.editCalls).toHaveLength(0);
  });

  it('a pre-tenancy session (legacy <user_id>/<sha>.png, creator deleted) is still refinable by its firm, and only its firm', async () => {
    const legacyPath = `legacy-user/${'c'.repeat(64)}.png`;
    t.db.seedObject(legacyPath, Buffer.from('legacy-bytes'));
    const row = t.db.seed('image_sessions', {
      org_id: ORG_A,
      user_id: null,
      prompt_history: [{ role: 'user', prompt: 'old', timestamp: '2025-01-01T00:00:00.000Z' }],
      current_path: legacyPath,
      source: 'generated',
    });

    const other = await api().post(`/api/v1/images/${row.id}/refine`).set(firmAuth('B1', ORG_B)).send({ instruction: 'y' });
    expect(other.status).toBe(404);

    const res = await api().post(`/api/v1/images/${row.id}/refine`).set(firmAuth('A2', ORG_A)).send({ instruction: 'brighter' });
    expect(res.status).toBe(200);
    expect(res.body.path.startsWith(`${ORG_A}/A2/`)).toBe(true);
  });

  it('image quota is per firm and exact under concurrency', async () => {
    t.db.seed('app_settings', { key: 'quota.default_daily_images', value: 2 });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => api().post('/api/v1/images/generate').set(firmAuth(i % 2 ? 'A1' : 'A2', ORG_A)).send({ prompt: `p${i}` })),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    expect(t.imageGenProvider.generateCalls).toHaveLength(2);
    expect((await api().post('/api/v1/images/generate').set(firmAuth('B1', ORG_B)).send({ prompt: 'b' })).status).toBe(200);
  });

  it('a failed generation gives its quota reservation back', async () => {
    t.db.seed('app_settings', { key: 'quota.default_daily_images', value: 1 });
    const original = t.imageGenProvider.generate;
    t.imageGenProvider.generate = async () => {
      throw new Error('vendor 500');
    };
    expect((await api().post('/api/v1/images/generate').set(firmAuth('A1', ORG_A)).send({ prompt: 'x' })).status).toBe(502);
    t.imageGenProvider.generate = original;
    expect((await api().post('/api/v1/images/generate').set(firmAuth('A1', ORG_A)).send({ prompt: 'x' })).status).toBe(200);
  });
});

describe('firm creation and listing', () => {
  it('POST /orgs creates the firm with the caller as owner; GET /orgs lists only the caller\'s memberships', async () => {
    const created = await api()
      .post('/api/v1/orgs')
      .set(bearer('N1', { fullName: 'Nora Newfirm' }))
      .send({ name: '  Newfirm LLP  ', role: 'member', plan: 'enterprise' });

    expect(created.status).toBe(201);
    expect(created.body.org).toMatchObject({ name: 'Newfirm LLP', plan: 'free', role: 'owner' });
    expect(Object.keys(created.body.org).sort()).toEqual(['createdAt', 'id', 'name', 'plan', 'role']);
    const membership = t.db.tables.org_members.find((m) => m.org_id === created.body.org.id)!;
    expect(membership).toMatchObject({ user_id: 'N1', role: 'owner', email: 'n1@example.test', display_name: 'Nora Newfirm' });

    const mine = await api().get('/api/v1/orgs').set(bearer('A2'));
    expect(mine.status).toBe(200);
    expect(mine.body.orgs).toEqual([expect.objectContaining({ id: ORG_A, role: 'member' })]);
  });

  it('rejects an empty or over-long firm name', async () => {
    expect((await api().post('/api/v1/orgs').set(bearer('N1')).send({ name: '   ' })).status).toBe(400);
    expect((await api().post('/api/v1/orgs').set(bearer('N1')).send({ name: 'x'.repeat(121) })).status).toBe(400);
    expect(t.db.tables.organizations).toHaveLength(2);
  });

  it('never leaves an ownerless firm when the owner membership insert fails', async () => {
    const deleted: string[] = [];
    const service = createOrgService({
      orgsRepo: {
        createOrg: async () => ({ id: UNKNOWN_ORG, name: 'x', plan: 'free', created_by: 'N1', created_at: '' }),
        addMember: async () => {
          throw new Error('insert failed');
        },
        deleteOrg: async (id: string) => {
          deleted.push(id);
        },
      } as any,
      invitationsRepo: {} as any,
      auditRepo: { orgEvent: vi.fn() } as any,
      now: Date.now,
    });

    await expect(service.createOrg({ userId: 'N1', email: null, emailVerified: false, displayName: null }, 'x')).rejects.toThrow();
    expect(deleted).toEqual([UNKNOWN_ORG]);
  });
});

describe('membership management and role rules', () => {
  it('any member can list members; the payload carries only name, email, role and join date', async () => {
    const res = await api().get(`/api/v1/orgs/${ORG_A}/members`).set(bearer('A2'));
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: any) => m.userId).sort()).toEqual(['A1', 'A2']);
    expect(Object.keys(res.body.members[0]).sort()).toEqual(['displayName', 'email', 'joinedAt', 'role', 'userId']);
  });

  it('A2 loses access immediately after removal, on firm data and org routes alike', async () => {
    expect((await api().post('/api/v1/messages/draft').set(firmAuth('A2', ORG_A)).send({ prompt: 'x' })).status).toBe(200);

    const removal = await api().delete(`/api/v1/orgs/${ORG_A}/members/A2`).set(bearer('A1'));
    expect(removal.status).toBe(204);

    const draft = await api().post('/api/v1/messages/draft').set(firmAuth('A2', ORG_A)).send({ prompt: 'x' });
    expect(draft.status).toBe(403);
    expect(draft.body.error.code).toBe('NOT_A_MEMBER');
    expect((await api().get(`/api/v1/orgs/${ORG_A}/members`).set(bearer('A2'))).status).toBe(403);
    expect((await api().get('/api/v1/orgs').set(bearer('A2'))).body.orgs).toEqual([]);
    expect(t.db.tables.org_audit_log).toContainEqual(
      expect.objectContaining({ org_id: ORG_A, actor_id: 'A1', action: 'member.remove', entity_id: 'A2' }),
    );
  });

  it('a member cannot invite, remove others, change roles or list invitations', async () => {
    seedFirm(t.db, ORG_A, [{ userId: 'A3', role: 'member' }]);
    const invite = await api().post(`/api/v1/orgs/${ORG_A}/invitations`).set(bearer('A2')).send({ role: 'member' });
    expect(invite.status).toBe(403);
    expect(invite.body.error.code).toBe('INSUFFICIENT_ROLE');
    expect((await api().delete(`/api/v1/orgs/${ORG_A}/members/A3`).set(bearer('A2'))).status).toBe(403);
    expect((await api().patch(`/api/v1/orgs/${ORG_A}/members/A2`).set(bearer('A2')).send({ role: 'owner' })).status).toBe(403);
    expect((await api().get(`/api/v1/orgs/${ORG_A}/invitations`).set(bearer('A2'))).status).toBe(403);
    expect(t.db.tables.org_invitations).toHaveLength(0);
    expect(t.db.tables.org_members.filter((m) => m.org_id === ORG_A)).toHaveLength(3);
  });

  it('an admin can invite and remove members, but cannot invite admins, remove an owner or another admin, or change roles', async () => {
    seedFirm(t.db, ORG_A, [
      { userId: 'AD', role: 'admin' },
      { userId: 'AD2', role: 'admin' },
    ]);

    expect((await api().post(`/api/v1/orgs/${ORG_A}/invitations`).set(bearer('AD')).send({ role: 'member' })).status).toBe(201);
    const adminInvite = await api().post(`/api/v1/orgs/${ORG_A}/invitations`).set(bearer('AD')).send({ role: 'admin' });
    expect(adminInvite.status).toBe(403);
    expect(adminInvite.body.error.code).toBe('INSUFFICIENT_ROLE');

    const removeOwner = await api().delete(`/api/v1/orgs/${ORG_A}/members/A1`).set(bearer('AD'));
    expect(removeOwner.status).toBe(403);
    expect((await api().delete(`/api/v1/orgs/${ORG_A}/members/AD2`).set(bearer('AD'))).status).toBe(403);
    expect((await api().patch(`/api/v1/orgs/${ORG_A}/members/A2`).set(bearer('AD')).send({ role: 'admin' })).status).toBe(403);

    expect((await api().delete(`/api/v1/orgs/${ORG_A}/members/A2`).set(bearer('AD'))).status).toBe(204);
    expect(t.db.isMember(ORG_A, 'A1')).toBe(true);
  });

  it('the owner can change roles; the response is the updated member', async () => {
    const res = await api().patch(`/api/v1/orgs/${ORG_A}/members/A2`).set(bearer('A1')).send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.member).toMatchObject({ userId: 'A2', role: 'admin' });
    expect(t.db.tables.org_audit_log).toContainEqual(expect.objectContaining({ action: 'member.role', entity_id: 'A2' }));
    expect((await api().patch(`/api/v1/orgs/${ORG_A}/members/A2`).set(bearer('A1')).send({ role: 'superuser' })).status).toBe(400);
    expect((await api().patch(`/api/v1/orgs/${ORG_A}/members/B1`).set(bearer('A1')).send({ role: 'member' })).status).toBe(404);
  });

  it('the last owner can be neither removed, nor leave, nor be demoted (409 LAST_OWNER)', async () => {
    const leave = await api().delete(`/api/v1/orgs/${ORG_A}/members/A1`).set(bearer('A1'));
    expect(leave.status).toBe(409);
    expect(leave.body.error.code).toBe('LAST_OWNER');
    const demote = await api().patch(`/api/v1/orgs/${ORG_A}/members/A1`).set(bearer('A1')).send({ role: 'member' });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('LAST_OWNER');
    expect(t.db.tables.org_members.find((m) => m.org_id === ORG_A && m.user_id === 'A1')!.role).toBe('owner');
  });

  it('with two owners, one may demote or remove the other; a member may leave by themselves', async () => {
    seedFirm(t.db, ORG_A, [{ userId: 'A0', role: 'owner' }]);
    expect((await api().patch(`/api/v1/orgs/${ORG_A}/members/A0`).set(bearer('A1')).send({ role: 'member' })).status).toBe(200);
    expect((await api().delete(`/api/v1/orgs/${ORG_A}/members/A2`).set(bearer('A2'))).status).toBe(204);
    expect(t.db.isMember(ORG_A, 'A2')).toBe(false);
  });

  it('two owners removing each other at once never leave the firm ownerless', async () => {
    seedFirm(t.db, ORG_A, [{ userId: 'A0', role: 'owner' }]);

    await Promise.all([
      api().delete(`/api/v1/orgs/${ORG_A}/members/A0`).set(bearer('A1')),
      api().delete(`/api/v1/orgs/${ORG_A}/members/A1`).set(bearer('A0')),
    ]);

    expect(t.db.tables.org_members.filter((m) => m.org_id === ORG_A && m.role === 'owner').length).toBeGreaterThanOrEqual(1);
  });
});

describe('invitations', () => {
  async function invite(body: object, by = 'A1') {
    const res = await api().post(`/api/v1/orgs/${ORG_A}/invitations`).set(bearer(by)).send(body);
    expect(res.status).toBe(201);
    return res.body as { invitation: any; token: string; inviteUrl: string };
  }

  it('creates a 7-day invitation, returns the token once, and stores only its sha256', async () => {
    const created = await invite({ email: 'New.Hire@Example.test', role: 'member' });

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(created.inviteUrl).toBe(`crmex://invite/${created.token}`);
    expect(created.invitation).toMatchObject({ email: 'new.hire@example.test', role: 'member' });
    expect(Object.keys(created.invitation).sort()).toEqual(['createdAt', 'email', 'expiresAt', 'id', 'role']);
    expect(new Date(created.invitation.expiresAt).getTime() - new Date(created.invitation.createdAt).getTime()).toBe(7 * DAY_MS);

    const row = t.db.tables.org_invitations[0];
    expect(row.token_hash).toBe(createHash('sha256').update(created.token).digest('hex'));
    expect(JSON.stringify(t.db.tables)).not.toContain(created.token);

    const listed = await api().get(`/api/v1/orgs/${ORG_A}/invitations`).set(bearer('A1'));
    expect(listed.body.invitations).toEqual([created.invitation]);
    expect(JSON.stringify(listed.body)).not.toContain(created.token);
    expect(t.db.tables.org_audit_log).toContainEqual(expect.objectContaining({ action: 'invitation.create', entity_id: row.id }));
  });

  it('accepting creates the membership with the invited role; the token is single-use', async () => {
    const { token } = await invite({ role: 'admin' });

    const accept = await api().post('/api/v1/invitations/accept').set(bearer('N1')).send({ token });
    expect(accept.status).toBe(200);
    expect(accept.body.org).toMatchObject({ id: ORG_A, role: 'admin' });
    expect(t.db.tables.org_members.find((m) => m.user_id === 'N1')).toMatchObject({ org_id: ORG_A, role: 'admin' });

    const reuse = await api().post('/api/v1/invitations/accept').set(bearer('N2')).send({ token });
    expect(reuse.status).toBe(404);
    expect(reuse.body.error.code).toBe('INVITATION_INVALID');
    expect(t.db.isMember(ORG_A, 'N2')).toBe(false);
    expect((await api().get(`/api/v1/orgs/${ORG_A}/invitations`).set(bearer('A1'))).body.invitations).toEqual([]);
  });

  it('expired, revoked and unknown tokens all fail with the same 404 INVITATION_INVALID', async () => {
    const expired = await invite({ role: 'member' });
    const revoked = await invite({ role: 'member' });
    expect((await api().delete(`/api/v1/orgs/${ORG_A}/invitations/${revoked.invitation.id}`).set(bearer('A1'))).status).toBe(204);
    expect((await api().delete(`/api/v1/orgs/${ORG_A}/invitations/${revoked.invitation.id}`).set(bearer('A1'))).status).toBe(404);

    t.clock.now += 7 * DAY_MS + 1;

    const responses = await Promise.all(
      [expired.token, revoked.token, 'not-a-real-token'].map((token) => api().post('/api/v1/invitations/accept').set(bearer('N1')).send({ token })),
    );
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(responses[0].body);
    }
    expect(t.db.isMember(ORG_A, 'N1')).toBe(false);
  });

  it('another firm cannot revoke or list this firm\'s invitations', async () => {
    const created = await invite({ role: 'member' });
    expect((await api().delete(`/api/v1/orgs/${ORG_B}/invitations/${created.invitation.id}`).set(bearer('B1'))).status).toBe(404);
    expect((await api().delete(`/api/v1/orgs/${ORG_A}/invitations/${created.invitation.id}`).set(bearer('B1'))).status).toBe(403);
    expect((await api().get(`/api/v1/orgs/${ORG_B}/invitations`).set(bearer('B1'))).body.invitations).toEqual([]);
    expect(t.db.tables.org_invitations[0].revoked_at).toBeNull();
  });

  it('an email-bound invitation only accepts for that verified email, case-insensitively; the body email is ignored', async () => {
    const { token } = await invite({ email: 'partner@lawfirm.test', role: 'member' });

    const wrong = await api().post('/api/v1/invitations/accept').set(bearer('N1')).send({ token, email: 'partner@lawfirm.test' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');

    const unverified = await api()
      .post('/api/v1/invitations/accept')
      .set(bearer('N2', { email: 'partner@lawfirm.test', emailVerified: false }))
      .send({ token });
    expect(unverified.status).toBe(403);
    expect(unverified.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');

    const right = await api().post('/api/v1/invitations/accept').set(bearer('N3', { email: 'Partner@LawFirm.test' })).send({ token });
    expect(right.status).toBe(200);
    expect(t.db.isMember(ORG_A, 'N1')).toBe(false);
    expect(t.db.isMember(ORG_A, 'N3')).toBe(true);
  });

  it('an existing member accepting gets their current membership, no role change, and the invitation is not consumed', async () => {
    const { token } = await invite({ role: 'admin' });

    const res = await api().post('/api/v1/invitations/accept').set(bearer('A2')).send({ token });

    expect(res.status).toBe(200);
    expect(res.body.org).toMatchObject({ id: ORG_A, role: 'member' });
    expect(t.db.tables.org_invitations[0].accepted_at).toBeNull();
    expect((await api().post('/api/v1/invitations/accept').set(bearer('N1')).send({ token })).status).toBe(200);
  });

  it('concurrent accepts of the same token by different users yield exactly one membership', async () => {
    const { token } = await invite({ role: 'member' });
    const users = ['N1', 'N2', 'N3', 'N4', 'N5'];

    const results = await Promise.all(users.map((u) => api().post('/api/v1/invitations/accept').set(bearer(u)).send({ token })));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(4);
    expect(t.db.tables.org_members.filter((m) => users.includes(m.user_id))).toHaveLength(1);
    expect(t.db.tables.org_audit_log.filter((e) => e.action === 'invitation.accept')).toHaveLength(1);
  });
});

describe('platform operator (tenant directory only)', () => {
  const operator = () => bearer('OP', { appRole: 'admin' });

  it('lists firms with seat counts and a firm\'s members, auditing every read', async () => {
    const orgs = await api().get('/api/v1/admin/orgs').set(operator());
    expect(orgs.status).toBe(200);
    expect(orgs.body.orgs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: ORG_A, memberCount: 2 }), expect.objectContaining({ id: ORG_B, memberCount: 1 })]),
    );
    expect(Object.keys(orgs.body.orgs[0]).sort()).toEqual(['createdAt', 'id', 'memberCount', 'name', 'plan']);

    const members = await api().get(`/api/v1/admin/orgs/${ORG_A}/members`).set(operator());
    expect(members.status).toBe(200);
    expect(members.body.members.map((m: any) => m.userId).sort()).toEqual(['A1', 'A2']);

    expect(t.db.tables.admin_audit_log).toEqual([
      expect.objectContaining({ actor_id: 'OP', action: 'directory.orgs.read' }),
      expect.objectContaining({ actor_id: 'OP', action: 'directory.members.read', after: { org_id: ORG_A } }),
    ]);
  });

  it('the directory routes never read a firm data table', async () => {
    await generateAs('A1', ORG_A);
    t.db.callLog.length = 0;

    await api().get('/api/v1/admin/orgs').set(operator());
    await api().get(`/api/v1/admin/orgs/${ORG_A}/members`).set(operator());

    const tables = new Set(t.db.callLog.map((c) => c.table));
    for (const forbidden of ['image_sessions', 'message_history', 'contact_meta', 'org_usage_daily', 'usage_daily', 'org_invitations']) {
      expect(tables.has(forbidden), forbidden).toBe(false);
    }
  });

  it('gets 403 on firm data and firm management routes without a membership', async () => {
    const { sessionId } = await generateAs('A1', ORG_A);
    for (const [, path, body] of firmRoutes(sessionId)) {
      const res = await api().post(path).set({ ...operator(), 'X-Org-Id': ORG_A }).send(body);
      expect(res.status, path).toBe(403);
    }
    expect((await api().get(`/api/v1/orgs/${ORG_A}/members`).set(operator())).status).toBe(403);
    expect((await api().get(`/api/v1/orgs/${ORG_A}/invitations`).set(operator())).status).toBe(403);
    expect((await api().delete(`/api/v1/orgs/${ORG_A}/members/A2`).set(operator())).status).toBe(403);
  });

  it('non-operators get 403 on the directory, even firm owners', async () => {
    const res = await api().get('/api/v1/admin/orgs').set(bearer('A1', { userRole: 'admin' }));
    expect(res.status).toBe(403);
    expect((await api().get(`/api/v1/admin/orgs/${ORG_A}/members`).set(bearer('A1'))).status).toBe(403);
    expect(t.db.tables.admin_audit_log).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp as rawBuildTestApp, firmAuth, ORG_A, ORG_B, seedFirm } from '../helpers/buildTestApp';
import { makeFakeToken } from '../fakes/fakeSupabaseClient';

// Every test user belongs to a firm (crmex.md §15): u1 / A / user-a in Firm A, u2 / B in Firm B.
function buildTestApp(opts?: Parameters<typeof rawBuildTestApp>[0]) {
  const bundle = rawBuildTestApp(opts);
  seedFirm(bundle.db, ORG_A, [{ userId: 'u1', role: 'owner' }, { userId: 'A' }, { userId: 'user-a' }]);
  seedFirm(bundle.db, ORG_B, [{ userId: 'u2', role: 'owner' }, { userId: 'B' }]);
  return bundle;
}


describe('roles and admin access control', () => {
  it('ROLE-01: a normal user calling /api/v1/admin/* gets 403', async () => {
    const { app } = buildTestApp();
    const token = makeFakeToken({ sub: 'user-a', appRole: 'user' });
    const res = await request(app).get('/api/v1/admin/_ping').set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('ROLE-02: a user_metadata.role=admin claim grants nothing — only app_metadata.role is honored', async () => {
    const { app } = buildTestApp();
    const token = makeFakeToken({ sub: 'user-a', appRole: 'user', userRole: 'admin' });
    const res = await request(app).get('/api/v1/admin/_ping').set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A);
    expect(res.status).toBe(403);
  });

  it('ROLE-03: an admin account calling an admin route is permitted', async () => {
    const { app } = buildTestApp();
    const token = makeFakeToken({ sub: 'admin-1', appRole: 'admin' });
    const res = await request(app).get('/api/v1/admin/_ping').set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, role: 'admin' });
  });

  it('ROLE-04: a platform admin JWT grants no firm data access — firm routes need a membership (§15.1)', async () => {
    const { app, db } = buildTestApp();
    const adminToken = makeFakeToken({ sub: 'admin-1', appRole: 'admin' });
    const userToken = makeFakeToken({ sub: 'user-a', appRole: 'user' });

    // A firm member creates a session.
    const genRes = await request(app).post('/api/v1/images/generate').set(firmAuth('user-a', ORG_A, userToken)).send({ prompt: 'a cat' });
    expect(genRes.status).toBe(200);

    // The admin, not a member of Firm A, is refused on every firm route with the same 403 as anyone else.
    const adminGen = await request(app).post('/api/v1/images/generate').set(firmAuth('admin-1', ORG_A, adminToken)).send({ prompt: 'a dog' });
    expect(adminGen.status).toBe(403);
    expect(adminGen.body.error.code).toBe('NOT_A_MEMBER');
    const refineRes = await request(app)
      .post(`/api/v1/images/${genRes.body.sessionId}/refine`)
      .set(firmAuth('admin-1', ORG_A, adminToken))
      .send({ instruction: 'make it blue' });
    expect(refineRes.status).toBe(403);

    // With a membership of their own firm, the admin's work is scoped to that firm like anyone's.
    seedFirm(db, ORG_B, [{ userId: 'admin-1' }]);
    const ownFirm = await request(app).post('/api/v1/images/generate').set(firmAuth('admin-1', ORG_B, adminToken)).send({ prompt: 'a dog' });
    expect(ownFirm.status).toBe(200);
    expect(ownFirm.body.path.startsWith(`${ORG_B}/admin-1/`)).toBe(true);
    const crossRefine = await request(app)
      .post(`/api/v1/images/${genRes.body.sessionId}/refine`)
      .set(firmAuth('admin-1', ORG_B, adminToken))
      .send({ instruction: 'make it blue' });
    expect(crossRefine.status).toBe(404);
  });
});

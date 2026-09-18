import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp as rawBuildTestApp, firmAuth, ORG_A, ORG_B, seedFirm } from '../helpers/buildTestApp';
import { makeExpiredToken, makeFakeToken, makeWrongProjectToken, MALFORMED_TOKEN } from '../fakes/fakeSupabaseClient';

// Every test user belongs to a firm (crmex.md §15): u1 / A / user-a in Firm A, u2 / B in Firm B.
function buildTestApp(opts?: Parameters<typeof rawBuildTestApp>[0]) {
  const bundle = rawBuildTestApp(opts);
  seedFirm(bundle.db, ORG_A, [{ userId: 'u1', role: 'owner' }, { userId: 'A' }, { userId: 'user-a' }]);
  seedFirm(bundle.db, ORG_B, [{ userId: 'u2', role: 'owner' }, { userId: 'B' }]);
  return bundle;
}


/**
 * Auth middleware equivalents (test-plan.md AUTH-02..05, run here against
 * core-server routes rather than a Supabase client directly, per the
 * "Testing requirements" section of the build brief). GET /health is
 * exempt from auth per the API contract and is checked separately.
 */
describe('auth middleware', () => {
  it('GET /api/v1/health requires no auth', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('AUTH-02: request with no Authorization header is rejected with 401 and no side effects', async () => {
    const { app, db } = buildTestApp();
    const res = await request(app).post('/api/v1/images/generate').send({ prompt: 'a cat' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(db.tables.image_sessions).toHaveLength(0);
  });

  it('AUTH-03: request with a malformed JWT is rejected with 401', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/v1/images/generate')
      .set('Authorization', `Bearer ${MALFORMED_TOKEN}`).set('X-Org-Id', ORG_A)
      .send({ prompt: 'a cat' });
    expect(res.status).toBe(401);
  });

  it('AUTH-04: request with an expired JWT is rejected with 401', async () => {
    const { app } = buildTestApp();
    const token = makeExpiredToken('user-a');
    const res = await request(app).post('/api/v1/images/generate').set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A).send({ prompt: 'x' });
    expect(res.status).toBe(401);
  });

  it('AUTH-05: request with a JWT signed for a different project is rejected with 401', async () => {
    const { app } = buildTestApp();
    const token = makeWrongProjectToken('user-a');
    const res = await request(app).post('/api/v1/images/generate').set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A).send({ prompt: 'x' });
    expect(res.status).toBe(401);
  });

  it('a well-formed, current, correctly-scoped token is accepted', async () => {
    const { app } = buildTestApp();
    const token = makeFakeToken({ sub: 'user-a' });
    const res = await request(app).post('/api/v1/images/generate').set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A).send({ prompt: 'a cat' });
    expect(res.status).toBe(200);
  });
});

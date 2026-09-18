import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import { createApp } from '../../src/app';
import type { SupabaseLike } from '../../src/db/types';
import { createFakeLlmProvider } from '../../src/providers/llm/fake';
import { createFakeImageGenProvider } from '../../src/providers/image-gen/fake';
import { createFakeImageSearchProvider } from '../../src/providers/image-search/fake';
import { liveEnv, setupLiveFixture, type LiveFixture } from './harness';

/**
 * docs/spec/test-plan.md §18.6 (TEN-30..TEN-33) and §1 (AUTH-02/03/05) with
 * the real thing on both ends of core-server: real Supabase JWTs going in,
 * the real database answering the membership lookup.
 *
 * test/integration/tenancy.test.ts covers the same routes against the fake
 * client, which proves the middleware's logic. What only a live run can prove
 * is that the JWT actually verifies against this project and that
 * `X-Org-Id` is resolved from real `org_members` rows. The AI providers stay
 * fake — nothing here should reach a paid vendor.
 */
const live = liveEnv();
const describeLive = live ? describe : describe.skip;

describeLive('TEN (live): core-server firm gate', () => {
  let f: LiveFixture;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    f = await setupLiveFixture();

    const supabase = createClient(live!.url, live!.serviceKey, {
      auth: { persistSession: false },
    }) as unknown as SupabaseLike;

    app = createApp({
      supabase,
      llmProvider: createFakeLlmProvider(),
      imageGenProvider: createFakeImageGenProvider(),
      imageSearchProvider: createFakeImageSearchProvider(),
      providerTimeoutMs: 5_000,
    });
  }, 120_000);

  afterAll(async () => {
    if (f) await f.teardown();
  }, 60_000);

  /** A well-formed request body, so a 400 can only come from the firm gate. */
  const match = (token: string, orgId?: string) => {
    const req = request(app)
      .post('/api/v1/contacts/match')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'everyone', index: [{ id: 'c1', displayName: 'Ada' }] });
    return orgId === undefined ? req : req.set('X-Org-Id', orgId);
  };

  const codeOf = (res: { body?: Record<string, unknown> }) =>
    (res.body?.error as { code?: string } | undefined)?.code ?? (res.body as { code?: string } | undefined)?.code;

  it('TEN-30: B1 calling a firm route with X-Org-Id: Firm A is 403 — the header is a selector, not an authority', async () => {
    const res = await match(f.B1.accessToken, f.orgA);
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('NOT_A_MEMBER');
  });

  it('TEN-30: the same call with the caller’s own firm is admitted', async () => {
    const res = await match(f.B1.accessToken, f.orgB);
    expect(res.status).toBe(200);
  });

  it('TEN-31: a missing, malformed or unknown X-Org-Id never reaches the data', async () => {
    const missing = await match(f.A1.accessToken);
    expect(missing.status).toBe(400);
    expect(codeOf(missing), 'a missing header must fail the firm gate, not body validation').toBe('ORG_REQUIRED');

    const malformed = await match(f.A1.accessToken, 'not-a-uuid');
    expect(malformed.status).toBe(400);
    expect(codeOf(malformed)).toBe('ORG_REQUIRED');

    // An unknown firm is indistinguishable from one the caller isn't in, so
    // firm ids cannot be probed.
    const unknown = await match(f.A1.accessToken, '00000000-0000-4000-8000-0000000f0f0f');
    expect(unknown.status).toBe(403);
    expect(codeOf(unknown)).toBe('NOT_A_MEMBER');
  });

  it('TEN-32: a member cannot create an invitation or change a membership', async () => {
    const invite = await request(app)
      .post(`/api/v1/orgs/${f.orgA}/invitations`)
      .set('Authorization', `Bearer ${f.A2.accessToken}`)
      .send({ role: 'member' });
    expect(invite.status).toBe(403);

    const promote = await request(app)
      .patch(`/api/v1/orgs/${f.orgA}/members/${f.A2.id}`)
      .set('Authorization', `Bearer ${f.A2.accessToken}`)
      .send({ role: 'owner' });
    expect(promote.status).toBe(403);

    // The owner may do both.
    const ownerInvite = await request(app)
      .post(`/api/v1/orgs/${f.orgA}/invitations`)
      .set('Authorization', `Bearer ${f.A1.accessToken}`)
      .send({ role: 'member' });
    expect(ownerInvite.status).toBeLessThan(300);
  });

  it('TEN-33: the last owner of a firm cannot be removed', async () => {
    const res = await request(app)
      .delete(`/api/v1/orgs/${f.orgA}/members/${f.A1.id}`)
      .set('Authorization', `Bearer ${f.A1.accessToken}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('TEN-30: /orgs lists only the caller’s own firms', async () => {
    const res = await request(app).get('/api/v1/orgs').set('Authorization', `Bearer ${f.B1.accessToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body.orgs ?? res.body ?? []).map((o: { id: string }) => o.id);
    expect(ids).toContain(f.orgB);
    expect(ids, "Firm A must not appear in B1's firm list").not.toContain(f.orgA);
  });

  it('AUTH-02/03/05: no token, a malformed token and a foreign-project token are all 401', async () => {
    const none = await request(app)
      .post('/api/v1/contacts/match')
      .set('X-Org-Id', f.orgA)
      .send({ query: 'everyone', contacts: [] });
    expect(none.status).toBe(401);

    const malformed = await match('not.a.jwt', f.orgA);
    expect(malformed.status).toBe(401);

    // Structurally valid, signed by a key this project does not trust.
    const foreign =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImV4cCI6NDEwMjQ0NDgwMH0.' +
      'Zm9yZ2VkLXNpZ25hdHVyZS1ub3QtZnJvbS10aGlzLXByb2plY3Q';
    const foreignRes = await match(foreign, f.orgA);
    expect(foreignRes.status).toBe(401);
  });
});

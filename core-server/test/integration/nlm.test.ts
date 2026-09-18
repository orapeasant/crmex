import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp as rawBuildTestApp, firmAuth, ORG_A, ORG_B, seedFirm } from '../helpers/buildTestApp';
import { createFakeLlmProvider } from '../../src/providers/llm/fake';
import { makeFakeToken } from '../fakes/fakeSupabaseClient';

// Every test user belongs to a firm (crmex.md §15): u1 / A / user-a in Firm A, u2 / B in Firm B.
function buildTestApp(opts?: Parameters<typeof rawBuildTestApp>[0]) {
  const bundle = rawBuildTestApp(opts);
  seedFirm(bundle.db, ORG_A, [{ userId: 'u1', role: 'owner' }, { userId: 'A' }, { userId: 'user-a' }]);
  seedFirm(bundle.db, ORG_B, [{ userId: 'u2', role: 'owner' }, { userId: 'B' }]);
  return bundle;
}


const INDEX = [
  { id: 'c1', displayName: 'Alice (customer)', tags: ['customer'] },
  { id: 'c2', displayName: 'Bob (friend)', tags: ['friend'] },
];

describe('POST /api/v1/contacts/match', () => {
  it('NLM-01: a query returns a ranked subset for confirmation', async () => {
    const llmProvider = createFakeLlmProvider({ chatResponse: () => '["c1"]' });
    const { app } = buildTestApp({ llmProvider });
    const token = makeFakeToken({ sub: 'u1' });

    const res = await request(app)
      .post('/api/v1/contacts/match')
      .set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A)
      .send({ query: 'my customers', index: INDEX });

    expect(res.status).toBe(200);
    expect(res.body.matchedIds).toEqual(['c1']);
  });

  it('NLM-02: a query matching nothing returns an empty result, not a fallback to everyone', async () => {
    const llmProvider = createFakeLlmProvider({ chatResponse: () => '[]' });
    const { app } = buildTestApp({ llmProvider });
    const token = makeFakeToken({ sub: 'u1' });

    const res = await request(app)
      .post('/api/v1/contacts/match')
      .set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A)
      .send({ query: 'people who bought a spaceship', index: INDEX });

    expect(res.status).toBe(200);
    expect(res.body.matchedIds).toEqual([]);
  });

  it('NLM-03: a command-phrased query never queues anything — only a selection is returned', async () => {
    const llmProvider = createFakeLlmProvider({ chatResponse: () => '["c1","c2"]' });
    const { app, db } = buildTestApp({ llmProvider });
    const token = makeFakeToken({ sub: 'u1' });

    const res = await request(app)
      .post('/api/v1/contacts/match')
      .set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A)
      .send({ query: 'message all my customers now', index: INDEX });

    expect(res.status).toBe(200);
    expect(res.body.matchedIds).toEqual(['c1', 'c2']);
    // No send/queue side effect exists anywhere this route can reach.
    expect(db.tables.message_history).toHaveLength(0);
  });

  it('NLM-06: an LLM provider error is surfaced cleanly (502), not a crash', async () => {
    const llmProvider = createFakeLlmProvider({ failWith: new Error('upstream exploded') });
    const { app } = buildTestApp({ llmProvider });
    const token = makeFakeToken({ sub: 'u1' });

    const res = await request(app)
      .post('/api/v1/contacts/match')
      .set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A)
      .send({ query: 'my customers', index: INDEX });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('LLM_ERROR');
  });

  it('NLM-06: an LLM provider timeout is surfaced with a distinguishable error', async () => {
    const llmProvider = createFakeLlmProvider();
    llmProvider.chat = () => new Promise(() => {}); // never resolves
    const { app } = buildTestApp({ llmProvider, providerTimeoutMs: 50 });
    const token = makeFakeToken({ sub: 'u1' });

    const res = await request(app)
      .post('/api/v1/contacts/match')
      .set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A)
      .send({ query: 'my customers', index: INDEX });

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('PROVIDER_TIMEOUT');
  });
});

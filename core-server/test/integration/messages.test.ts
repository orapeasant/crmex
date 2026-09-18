import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp as rawBuildTestApp, firmAuth, ORG_A, ORG_B, seedFirm } from '../helpers/buildTestApp';
import { createFakeLlmProvider } from '../../src/providers/llm/fake';
import { makeFakeToken } from '../fakes/fakeSupabaseClient';
import { createFakeImageGenProvider } from '../../src/providers/image-gen/fake';
import { draftMessage } from '../../src/agent/messageDrafter';
import { DEFAULT_SETTINGS } from '../../src/repositories/defaultSettings';

// Every test user belongs to a firm (crmex.md §15): u1 / A / user-a in Firm A, u2 / B in Firm B.
function buildTestApp(opts?: Parameters<typeof rawBuildTestApp>[0]) {
  const bundle = rawBuildTestApp(opts);
  seedFirm(bundle.db, ORG_A, [{ userId: 'u1', role: 'owner' }, { userId: 'A' }, { userId: 'user-a' }]);
  seedFirm(bundle.db, ORG_B, [{ userId: 'u2', role: 'owner' }, { userId: 'B' }]);
  return bundle;
}

function orgOf(sub: string): string {
  return sub === 'u2' || sub === 'B' ? ORG_B : ORG_A;
}

function authFor(sub: string) {
  return firmAuth(sub, orgOf(sub));
}

describe('POST /api/v1/messages/draft', () => {
  it('returns the drafted text, sending only the prompt to the LLM', async () => {
    const llmProvider = createFakeLlmProvider({ chatResponse: () => '  "Hi! Our store reopens Monday."  ' });
    const { app } = buildTestApp({ llmProvider });
    const token = makeFakeToken({ sub: 'u1' });

    const res = await request(app)
      .post('/api/v1/messages/draft')
      .set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A)
      .send({ prompt: 'tell customers we reopen monday' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'Hi! Our store reopens Monday.' });
    const messages = llmProvider.calls[0];
    expect(messages.filter((m) => m.role === 'user')).toEqual([{ role: 'user', content: 'tell customers we reopen monday' }]);
  });

  it('requires authentication', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/v1/messages/draft').send({ prompt: 'hello' });
    expect(res.status).toBe(401);
  });

  it('rejects an empty prompt without calling the LLM', async () => {
    const llmProvider = createFakeLlmProvider();
    const { app } = buildTestApp({ llmProvider });
    const token = makeFakeToken({ sub: 'u1' });

    const res = await request(app).post('/api/v1/messages/draft').set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A).send({ prompt: '   ' });

    expect(res.status).toBe(400);
    expect(llmProvider.calls).toHaveLength(0);
  });

  it('maps a provider failure to an error response', async () => {
    const llmProvider = createFakeLlmProvider({ failWith: new Error('upstream down') });
    const { app } = buildTestApp({ llmProvider });
    const token = makeFakeToken({ sub: 'u1' });

    const res = await request(app).post('/api/v1/messages/draft').set('Authorization', `Bearer ${token}`).set('X-Org-Id', ORG_A).send({ prompt: 'hello' });

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('does not leak the vendor error body to the client', async () => {
    const llmProvider = createFakeLlmProvider({ failWith: new Error('400 {"error":"credit balance too low","request_id":"req_x"}') });
    const { app } = buildTestApp({ llmProvider });
    const res = await request(app).post('/api/v1/messages/draft').set(authFor('u1')).send({ prompt: 'hello' });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('LLM_ERROR');
    expect(res.body.error.message).not.toContain('credit');
  });

  it('surfaces a provider timeout as 504 PROVIDER_TIMEOUT', async () => {
    const llmProvider = createFakeLlmProvider();
    llmProvider.chat = () => new Promise(() => {});
    const { app } = buildTestApp({ llmProvider, providerTimeoutMs: 50 });
    const res = await request(app).post('/api/v1/messages/draft').set(authFor('u1')).send({ prompt: 'hello' });

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('PROVIDER_TIMEOUT');
  });
});

describe('message draft quota', () => {
  const draft = (app: Parameters<typeof request>[0], sub: string) =>
    request(app).post('/api/v1/messages/draft').set(authFor(sub)).send({ prompt: 'hi' });

  it('rejects drafts past quota.default_daily_drafts with 429 BEFORE calling the LLM', async () => {
    const llmProvider = createFakeLlmProvider({ chatResponse: () => 'ok' });
    const { app, db } = buildTestApp({ llmProvider });
    db.seed('app_settings', { key: 'quota.default_daily_drafts', value: 2 });

    expect((await draft(app, 'u1')).status).toBe(200);
    expect((await draft(app, 'u1')).status).toBe(200);
    const third = await draft(app, 'u1');

    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(llmProvider.calls).toHaveLength(2);
  });

  it('counts per firm (Firm A exhausting the quota does not affect Firm B)', async () => {
    const { app, db } = buildTestApp({ llmProvider: createFakeLlmProvider({ chatResponse: () => 'ok' }) });
    db.seed('app_settings', { key: 'quota.default_daily_drafts', value: 1 });

    expect((await draft(app, 'A')).status).toBe(200);
    expect((await draft(app, 'A')).status).toBe(429);
    expect((await draft(app, 'B')).status).toBe(200);
  });

  it('resets at the next UTC day', async () => {
    const { app, db, clock } = buildTestApp({ llmProvider: createFakeLlmProvider({ chatResponse: () => 'ok' }) });
    db.seed('app_settings', { key: 'quota.default_daily_drafts', value: 1 });

    expect((await draft(app, 'u1')).status).toBe(200);
    expect((await draft(app, 'u1')).status).toBe(429);
    clock.now += 24 * 60 * 60 * 1000;
    expect((await draft(app, 'u1')).status).toBe(200);
  });

  it('is enforced for concurrent requests from one user', async () => {
    const llmProvider = createFakeLlmProvider({ chatResponse: () => 'ok' });
    const { app, db } = buildTestApp({ llmProvider });
    db.seed('app_settings', { key: 'quota.default_daily_drafts', value: 2 });

    const results = await Promise.all([draft(app, 'u1'), draft(app, 'u1'), draft(app, 'u1'), draft(app, 'u1')]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 429)).toHaveLength(2);
    expect(llmProvider.calls).toHaveLength(2);
  });

  it('is independent of the image generation quota', async () => {
    const { app, db } = buildTestApp({
      llmProvider: createFakeLlmProvider({ chatResponse: () => 'ok' }),
      imageGenProvider: createFakeImageGenProvider(),
    });
    db.seed('app_settings', { key: 'quota.default_daily_images', value: 0 });

    expect((await draft(app, 'u1')).status).toBe(200);
  });

  it('has a finite, positive seeded default (never unlimited by accident)', () => {
    expect(Number.isFinite(DEFAULT_SETTINGS['quota.default_daily_drafts'])).toBe(true);
    expect(DEFAULT_SETTINGS['quota.default_daily_drafts']).toBeGreaterThan(0);
  });
});

describe('agent/messageDrafter', () => {
  const llmReturning = (text: string) => createFakeLlmProvider({ chatResponse: () => text });

  it('strips one wrapping pair of quotes', async () => {
    await expect(draftMessage(llmReturning('“Hello there”'), 'x')).resolves.toEqual({ text: 'Hello there' });
  });

  it('keeps quotes that are part of the message', async () => {
    const text = '"Open" on Monday, "closed" on Tuesday';
    await expect(draftMessage(llmReturning(text), 'x')).resolves.toEqual({ text });
  });

  it('rejects an empty model response', async () => {
    await expect(draftMessage(llmReturning('   '), 'x')).rejects.toThrow(/empty draft/);
  });
});

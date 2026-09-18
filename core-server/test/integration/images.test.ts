import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp as rawBuildTestApp, firmAuth, ORG_A, ORG_B, seedFirm } from '../helpers/buildTestApp';
import { createFakeImageGenProvider } from '../../src/providers/image-gen/fake';
import { createFakeImageSearchProvider } from '../../src/providers/image-search/fake';
import { makeFakeToken } from '../fakes/fakeSupabaseClient';

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

describe('image generation, refinement and search', () => {
  it('IMG-01: generate stores an object under the caller\'s prefix and creates an image_sessions row', async () => {
    const { app, db } = buildTestApp();
    const res = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'a mountain at sunset' });

    expect(res.status).toBe(200);
    expect(res.body.path.startsWith(`${ORG_A}/u1/`)).toBe(true);
    expect(res.body.signedUrl).toContain(res.body.path);
    expect(res.body.promptHistory).toHaveLength(1);
    expect(db.tables.image_sessions).toHaveLength(1);
    expect(db.storage.has(res.body.path)).toBe(true);
  });

  it('IMG-02 / IMG-03: refine advances current_path and retains the prior object for step-back', async () => {
    const { app, db } = buildTestApp();
    const gen = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'a cat' });
    const originalPath = gen.body.path as string;

    const refine = await request(app)
      .post(`/api/v1/images/${gen.body.sessionId}/refine`)
      .set(authFor('u1'))
      .send({ instruction: 'make it wear a hat' });

    expect(refine.status).toBe(200);
    expect(refine.body.path).not.toBe(originalPath);
    expect(refine.body.promptHistory).toHaveLength(2);

    const row = db.tables.image_sessions.find((r) => r.id === gen.body.sessionId)!;
    expect(row.current_path).toBe(refine.body.path);

    // IMG-03: the prior object is still present/fetchable, not deleted on refine.
    expect(db.storage.has(originalPath)).toBe(true);
  });

  it('IMG-05: image search returns selectable thumbnails', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/v1/images/search').set(authFor('u1')).send({ query: 'sunset', limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toHaveProperty('thumbUrl');
    expect(res.body.results[0]).toHaveProperty('sourceUrl');
  });

  it('IMG-06: selecting a searched image stores it under the caller\'s prefix with source=searched', async () => {
    const fetchImageBytes = async () => Buffer.from('downloaded-bytes-from-the-web');
    const { app, db } = buildTestApp({ fetchImageBytes });

    const res = await request(app)
      .post('/api/v1/images/search/select')
      .set(authFor('u1'))
      .send({ sourceUrl: 'https://example.com/photo.jpg', query: 'sunset' });

    expect(res.status).toBe(200);
    expect(res.body.path.startsWith(`${ORG_A}/u1/`)).toBe(true);
    const row = db.tables.image_sessions.find((r) => r.id === res.body.sessionId)!;
    expect(row.source).toBe('searched');
  });

  it('IMG-07: a generation provider error is surfaced with no partial session row and no orphaned object', async () => {
    const imageGenProvider = createFakeImageGenProvider({ failWith: new Error('vendor 500') });
    const { app, db } = buildTestApp({ imageGenProvider });

    const res = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'x' });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PROVIDER_ERROR');
    expect(db.tables.image_sessions).toHaveLength(0);
    expect(db.storage.size).toBe(0);
  });

  it('IMG-08: a generation provider timeout is surfaced with a distinguishable error, same no-orphan guarantee', async () => {
    const imageGenProvider = createFakeImageGenProvider();
    imageGenProvider.generate = () => new Promise(() => {});
    const { app, db } = buildTestApp({ imageGenProvider, providerTimeoutMs: 50 });

    const res = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'x' });

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('PROVIDER_TIMEOUT');
    expect(res.body.error.code).not.toBe('PROVIDER_ERROR'); // distinguishable from a plain error
    expect(db.tables.image_sessions).toHaveLength(0);
    expect(db.storage.size).toBe(0);
  });

  it('IMG-07/08 also apply to search/select: a download failure leaves no session row and no object', async () => {
    const fetchImageBytes = async () => {
      throw new Error('404 from origin');
    };
    const { app, db } = buildTestApp({ fetchImageBytes });

    const res = await request(app)
      .post('/api/v1/images/search/select')
      .set(authFor('u1'))
      .send({ sourceUrl: 'https://example.com/missing.jpg', query: 'sunset' });

    expect(res.status).toBe(502);
    expect(db.tables.image_sessions).toHaveLength(0);
    expect(db.storage.size).toBe(0);
  });

  it('IMG-09: prompt history accumulates in order across multiple refinements', async () => {
    const { app } = buildTestApp();
    const gen = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'a bicycle' });

    const r1 = await request(app).post(`/api/v1/images/${gen.body.sessionId}/refine`).set(authFor('u1')).send({ instruction: 'make it red' });
    const r2 = await request(app).post(`/api/v1/images/${gen.body.sessionId}/refine`).set(authFor('u1')).send({ instruction: 'add a basket' });

    expect(r2.body.promptHistory.map((h: any) => h.prompt)).toEqual(['a bicycle', 'make it red', 'add a basket']);
    // ordering is strictly chronological
    const timestamps = r2.body.promptHistory.map((h: any) => new Date(h.timestamp).getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('IMG-10: two concurrent refinements on one session are serialized; current_path never points at a missing object', async () => {
    const { app, db } = buildTestApp();
    const gen = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'a bicycle' });

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/v1/images/${gen.body.sessionId}/refine`).set(authFor('u1')).send({ instruction: 'make it red' }),
      request(app).post(`/api/v1/images/${gen.body.sessionId}/refine`).set(authFor('u1')).send({ instruction: 'add a basket' }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.path).not.toBe(r2.body.path); // two distinct edits actually happened, not a lost update

    const row = db.tables.image_sessions.find((r) => r.id === gen.body.sessionId)!;
    // current_path always points at something that actually exists in storage.
    expect(db.storage.has(row.current_path)).toBe(true);
    // final prompt history has exactly 3 entries (base + two refinements), not
    // 2 (which would indicate one refinement clobbered the other's history write).
    expect(row.prompt_history).toHaveLength(3);
  });

  it('refine on a session in another firm is a 404, not a leak of its existence', async () => {
    const { app } = buildTestApp();
    const gen = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'x' });
    const res = await request(app).post(`/api/v1/images/${gen.body.sessionId}/refine`).set(authFor('u2')).send({ instruction: 'y' });
    expect(res.status).toBe(404);
  });

  it('IMG-04: refine passes the session prompt history to edit(), so a fallback generate keeps the original request', async () => {
    const imageGenProvider = createFakeImageGenProvider({ noEditEndpoint: true });
    const { app } = buildTestApp({ imageGenProvider });
    const gen = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'a red bicycle' });

    const res = await request(app).post(`/api/v1/images/${gen.body.sessionId}/refine`).set(authFor('u1')).send({ instruction: 'make it blue' });

    expect(res.status).toBe(200);
    expect(imageGenProvider.generateCalls.at(-1)).toBe('a red bicycle. Refinement: make it blue');
  });
});

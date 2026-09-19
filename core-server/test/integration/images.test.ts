import { crc32 } from 'zlib';
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp as rawBuildTestApp, firmAuth, ORG_A, ORG_B, seedFirm } from '../helpers/buildTestApp';
import { createFakeImageGenProvider } from '../../src/providers/image-gen/fake';
import { createFakeImageSearchProvider } from '../../src/providers/image-search/fake';
import { makeFakeToken } from '../fakes/fakeSupabaseClient';

// --- Minimal PNG fixtures for CAM-15 (upload) tests -------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function ihdrChunk(width = 1, height = 1): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return pngChunk('IHDR', data);
}

/** A structurally valid, minimal PNG — no ancillary chunks. */
function validPng(): Buffer {
  return Buffer.concat([PNG_MAGIC, ihdrChunk(), pngChunk('IDAT', Buffer.from([1, 2, 3])), pngChunk('IEND', Buffer.alloc(0))]);
}

/** A PNG carrying an eXIf chunk with a GPS-looking payload (CAM-15). */
function pngWithGpsExif(): Buffer {
  const gps = Buffer.from('Exif\0\0GPS 37.7749 N, 122.4194 W', 'utf8');
  return Buffer.concat([
    PNG_MAGIC,
    ihdrChunk(),
    pngChunk('eXIf', gps),
    pngChunk('IDAT', Buffer.from([1, 2, 3])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

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

describe('CAM-15: POST /api/v1/images/upload (paste or attach, crmex.md §18.4)', () => {
  it('stores a pasted PNG under <org>/<user>/<sha256(sanitized)>.png, creates an image_sessions row, and returns a signed URL', async () => {
    const { app, db } = buildTestApp();
    const png = validPng();

    const res = await request(app)
      .post('/api/v1/images/upload')
      .set(authFor('u1'))
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(200);
    expect(res.body.path).toBe(`${ORG_A}/u1/${sha256Hex(png)}.png`);
    expect(res.body.signedUrl).toContain(res.body.path);
    expect(db.storage.has(res.body.path)).toBe(true);
    const row = db.tables.image_sessions.find((r) => r.id === res.body.sessionId)!;
    expect(row.source).toBe('uploaded');
    expect(row.current_path).toBe(res.body.path);
  });

  it('strips an eXIf chunk carrying GPS text before storing, and the stored path reflects the stripped bytes', async () => {
    const { app, db } = buildTestApp();
    const dirty = pngWithGpsExif();

    const res = await request(app).post('/api/v1/images/upload').set(authFor('u1')).set('Content-Type', 'image/png').send(dirty);

    expect(res.status).toBe(200);
    // The path hashes the SANITIZED bytes, not the uploaded ones, so it must
    // differ from a hash of the dirty input and match the clean fixture's hash.
    expect(res.body.path).not.toBe(`${ORG_A}/u1/${sha256Hex(dirty)}.png`);
    expect(res.body.path).toBe(`${ORG_A}/u1/${sha256Hex(validPng())}.png`);

    const storedRaw = (db.storage.get(res.body.path) as { bytes: Buffer } | undefined)?.bytes;
    expect(storedRaw).toBeDefined();
    expect(storedRaw!.toString('latin1')).not.toContain('GPS');
    expect(storedRaw!.includes(Buffer.from('eXIf'))).toBe(false);
  });

  it('rejects a non-PNG body (e.g. a JPEG)', async () => {
    const { app, db } = buildTestApp();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

    const res = await request(app).post('/api/v1/images/upload').set(authFor('u1')).set('Content-Type', 'image/jpeg').send(jpeg);

    expect(res.status).toBe(400);
    expect(db.tables.image_sessions).toHaveLength(0);
    expect(db.storage.size).toBe(0);
  });

  it('rejects an oversized body', async () => {
    const { app, db } = buildTestApp();
    db.seed('app_settings', { key: 'quota.max_upload_bytes', value: 100 });
    const big = Buffer.concat([validPng(), Buffer.alloc(200, 0)]);

    const res = await request(app).post('/api/v1/images/upload').set(authFor('u1')).set('Content-Type', 'image/png').send(big);

    expect(res.status).toBe(413);
    expect(db.tables.image_sessions).toHaveLength(0);
    expect(db.storage.size).toBe(0);
  });

  it('ignores a client-supplied path/filename in the body or query — the path is always built from the JWT', async () => {
    const { app, db } = buildTestApp();
    const png = validPng();

    const res = await request(app)
      .post('/api/v1/images/upload?path=../evil/hacked.png&filename=hacked.png')
      .set(authFor('u1'))
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(200);
    expect(res.body.path).toBe(`${ORG_A}/u1/${sha256Hex(png)}.png`);
    expect(res.body.path).not.toContain('evil');
    expect(res.body.path).not.toContain('hacked');
    expect(db.storage.has(res.body.path)).toBe(true);
  });

  it('quota exceeded (storage ceiling) rejects the upload', async () => {
    const { app, db } = buildTestApp();
    db.seed('app_settings', { key: 'quota.default_storage_bytes', value: 1 });
    db.seed('org_usage_daily', { org_id: ORG_A, day: '2026-01-01', storage_bytes: 100, images_generated: 0, messages_drafted: 0, messages_sent: 0 });

    const res = await request(app).post('/api/v1/images/upload').set(authFor('u1')).set('Content-Type', 'image/png').send(validPng());

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(db.storage.size).toBe(0);
  });

  it('a member of another firm cannot upload into this firm\'s path (forged X-Org-Id is 403, not routed to Firm A\'s prefix)', async () => {
    const { app, db } = buildTestApp();

    // u2 is only a member of ORG_B; forging X-Org-Id: ORG_A must not succeed.
    const res = await request(app)
      .post('/api/v1/images/upload')
      .set({ Authorization: `Bearer ${makeFakeToken({ sub: 'u2' })}`, 'X-Org-Id': ORG_A, 'Content-Type': 'image/png' })
      .send(validPng());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_A_MEMBER');
    expect(db.storage.size).toBe(0);
    expect(db.tables.image_sessions).toHaveLength(0);
  });
});

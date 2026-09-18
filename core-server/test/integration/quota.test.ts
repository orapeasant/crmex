import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp as rawBuildTestApp, firmAuth, ORG_A, ORG_B, seedFirm } from '../helpers/buildTestApp';
import { createFakeImageGenProvider } from '../../src/providers/image-gen/fake';
import { makeFakeToken } from '../fakes/fakeSupabaseClient';
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

describe('quotas', () => {
  it('QTA-01: generation within quota is permitted and increments the firm\'s org_usage_daily.images_generated', async () => {
    const { app, db } = buildTestApp();
    const res = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'x' });
    expect(res.status).toBe(200);
    const usage = db.tables.org_usage_daily.find((r) => r.org_id === ORG_A);
    expect(usage?.images_generated).toBe(1);
  });

  it('QTA-02: generation at the daily quota is rejected with a meaningful 429', async () => {
    const { app, db } = buildTestApp();
    db.seed('app_settings', { key: 'quota.default_daily_images', value: 2 });

    await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'a' });
    await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'b' });
    const third = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'c' });

    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(typeof third.body.error.message).toBe('string');
    expect(third.body.error.message.length).toBeGreaterThan(0);
  });

  it('QTA-03: quota resets the next UTC day', async () => {
    const { app, db, clock } = buildTestApp();
    db.seed('app_settings', { key: 'quota.default_daily_images', value: 1 });

    const first = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'a' });
    expect(first.status).toBe(200);
    const blocked = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'b' });
    expect(blocked.status).toBe(429);

    clock.now += 24 * 60 * 60 * 1000; // advance one day

    const nextDay = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'c' });
    expect(nextDay.status).toBe(200);
  });

  it('QTA-04: storage quota exceeded rejects generation BEFORE the provider is called', async () => {
    const imageGenProvider = createFakeImageGenProvider();
    const { app, db } = buildTestApp({ imageGenProvider });
    db.seed('app_settings', { key: 'quota.default_storage_bytes', value: 10 });
    db.seed('org_usage_daily', { org_id: ORG_A, day: '2026-01-01', images_generated: 0, storage_bytes: 999 });

    const res = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'x' });

    expect(res.status).toBe(429);
    expect(imageGenProvider.generateCalls).toHaveLength(0); // no cost incurred
  });

  it.skip('QTA-05: batch exceeding max_batch_recipients is rejected before any outbox row is written', () => {
    // Not testable from core-server: per the architecture decision in the
    // build brief, WhatsApp send batches and the `outbox` table are entirely
    // client-side (WebView-owned SQLite, crmex.md §9.2) — core-server has no
    // batch/send endpoint at all (sending happens via the embedded Node
    // process's IPC bridge, which core-server never talks to). This
    // scenario belongs to the Android client's own test suite, which would
    // assert `limits.max_batch_recipients` (read from app_settings, the
    // same table this repo seeds) is enforced before the client writes to
    // its local `outbox`.
  });

  it('QTA-06: quota is enforced server-side regardless of any client-side check having been skipped', async () => {
    const { app, db } = buildTestApp();
    // Simulate "a client that never calls its own UI quota check" by directly
    // seeding usage at the limit and calling the route straight away.
    db.seed('app_settings', { key: 'quota.default_daily_images', value: 1 });
    db.seed('org_usage_daily', { org_id: ORG_A, day: '2026-01-01', images_generated: 1, storage_bytes: 0 });

    const res = await request(app).post('/api/v1/images/generate').set(authFor('u1')).send({ prompt: 'x' });
    expect(res.status).toBe(429);
  });

  it('QTA-07: Firm A\'s usage does not consume Firm B\'s quota — counters are strictly per-firm', async () => {
    const { app, db } = buildTestApp();
    db.seed('app_settings', { key: 'quota.default_daily_images', value: 1 });

    const aRes = await request(app).post('/api/v1/images/generate').set(authFor('A')).send({ prompt: 'x' });
    expect(aRes.status).toBe(200);
    const aBlocked = await request(app).post('/api/v1/images/generate').set(authFor('A')).send({ prompt: 'y' });
    expect(aBlocked.status).toBe(429);

    // B is unaffected by A having exhausted their quota.
    const bRes = await request(app).post('/api/v1/images/generate').set(authFor('B')).send({ prompt: 'z' });
    expect(bRes.status).toBe(200);

    const usageA = db.tables.org_usage_daily.find((r) => r.org_id === ORG_A);
    const usageB = db.tables.org_usage_daily.find((r) => r.org_id === ORG_B);
    expect(usageA?.images_generated).toBe(1);
    expect(usageB?.images_generated).toBe(1);
  });

  it('QTA-08: an empty settings table (fresh deploy) still applies seeded defaults — never unlimited by accident', async () => {
    const { db } = buildTestApp();
    expect(db.tables.app_settings).toHaveLength(0); // nothing seeded

    const { createSettingsRepo } = await import('../../src/repositories/settingsRepo');
    const { createFakeSupabaseClient } = await import('../fakes/fakeSupabaseClient');
    const service = createFakeSupabaseClient({ db, mode: 'service' });
    const settingsRepo = createSettingsRepo(service);

    await expect(settingsRepo.get('quota.default_daily_images')).resolves.toBe(DEFAULT_SETTINGS['quota.default_daily_images']);
    await expect(settingsRepo.get('quota.default_storage_bytes')).resolves.toBe(DEFAULT_SETTINGS['quota.default_storage_bytes']);
    expect(DEFAULT_SETTINGS['quota.default_daily_images']).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_SETTINGS['quota.default_daily_images'])).toBe(true);
  });
});

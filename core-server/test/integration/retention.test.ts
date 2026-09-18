import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDb, createFakeSupabaseClient } from '../fakes/fakeSupabaseClient';
import { createImageSessionsRepo } from '../../src/repositories/imageSessionsRepo';
import { createMessageHistoryRepo } from '../../src/repositories/messageHistoryRepo';
import { createStorageRepo } from '../../src/repositories/storageRepo';
import { createSettingsRepo } from '../../src/repositories/settingsRepo';
import { runRetention } from '../../src/jobs/retention';

const DAY_MS = 86_400_000;
const ORG_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ORG_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

function buildDeps(db: FakeDb, now: { value: number }) {
  const service = createFakeSupabaseClient({ db, mode: 'service' });
  return {
    imageSessionsRepo: createImageSessionsRepo(service),
    messageHistoryRepo: createMessageHistoryRepo(service),
    storageRepo: createStorageRepo(service),
    settingsRepo: createSettingsRepo(service),
    now: () => now.value,
  };
}

describe('retention job', () => {
  let db: FakeDb;
  let now: { value: number };

  beforeEach(() => {
    db = new FakeDb();
    now = { value: Date.UTC(2026, 0, 30) };
    db.setClock(() => now.value);
    db.seed('app_settings', { key: 'retention.unsent_image_ttl_days', value: 7 });
    db.seed('app_settings', { key: 'retention.sent_image_ttl_days', value: 30 });
  });

  it('RET-01: an unsent session image past the unsent TTL has its object and session row deleted', async () => {
    db.seed('image_sessions', {
      org_id: ORG_A, user_id: 'A',
      prompt_history: [],
      current_path: 'A/old-unsent.png',
      source: 'generated',
      updated_at: new Date(now.value - 10 * DAY_MS).toISOString(),
    });
    db.seedObject('A/old-unsent.png', Buffer.from('bytes'));

    const result = await runRetention(buildDeps(db, now));

    expect(result.sessionsDeleted).toBe(1);
    expect(result.objectsDeleted).toBe(1);
    expect(db.storage.has('A/old-unsent.png')).toBe(false);
    expect(db.tables.image_sessions).toHaveLength(0);
  });

  it('RET-02: an unsent image within TTL is retained', async () => {
    db.seed('image_sessions', {
      org_id: ORG_A, user_id: 'A',
      prompt_history: [],
      current_path: 'A/recent.png',
      source: 'generated',
      updated_at: new Date(now.value - 2 * DAY_MS).toISOString(),
    });
    db.seedObject('A/recent.png', Buffer.from('bytes'));

    const result = await runRetention(buildDeps(db, now));

    expect(result.sessionsDeleted).toBe(0);
    expect(db.storage.has('A/recent.png')).toBe(true);
    expect(db.tables.image_sessions).toHaveLength(1);
  });

  it('RET-03: a sent image past the sent TTL has its object deleted', async () => {
    db.seed('image_sessions', {
      org_id: ORG_A, user_id: 'A',
      prompt_history: [],
      current_path: 'A/sent-old.png',
      source: 'generated',
      updated_at: new Date(now.value - 1 * DAY_MS).toISOString(), // recently updated, but SENT long ago
    });
    db.seed('message_history', {
      org_id: ORG_A, user_id: 'A',
      jid: 'x@s.whatsapp.net',
      body: null,
      media_path: 'A/sent-old.png',
      batch_id: 'b1',
      status: 'SENT',
      created_at: new Date(now.value - 40 * DAY_MS).toISOString(),
    });
    db.seedObject('A/sent-old.png', Buffer.from('bytes'));

    const result = await runRetention(buildDeps(db, now));

    expect(result.objectsDeleted).toBe(1);
    expect(db.storage.has('A/sent-old.png')).toBe(false);
  });

  it('RET-04: sent_image_ttl_days = 0 keeps sent images indefinitely', async () => {
    db.tables.app_settings = db.tables.app_settings.filter((r) => r.key !== 'retention.sent_image_ttl_days');
    db.seed('app_settings', { key: 'retention.sent_image_ttl_days', value: 0 });

    db.seed('image_sessions', { org_id: ORG_A, user_id: 'A', prompt_history: [], current_path: 'A/sent-forever.png', source: 'generated' });
    db.seed('message_history', {
      org_id: ORG_A, user_id: 'A',
      jid: 'x@s.whatsapp.net',
      media_path: 'A/sent-forever.png',
      batch_id: 'b1',
      status: 'SENT',
      created_at: new Date(now.value - 1000 * DAY_MS).toISOString(),
    });
    db.seedObject('A/sent-forever.png', Buffer.from('bytes'));

    const result = await runRetention(buildDeps(db, now));

    expect(result.objectsDeleted).toBe(0);
    expect(db.storage.has('A/sent-forever.png')).toBe(true);
  });

  it('RET-05: deleting an object referenced by message_history never deletes the message_history row', async () => {
    db.seed('image_sessions', {
      org_id: ORG_A, user_id: 'A',
      prompt_history: [],
      current_path: 'A/sent-old.png',
      source: 'generated',
      updated_at: new Date(now.value - 1 * DAY_MS).toISOString(),
    });
    const msg = db.seed('message_history', {
      org_id: ORG_A, user_id: 'A',
      jid: 'x@s.whatsapp.net',
      media_path: 'A/sent-old.png',
      media_sha256: 'deadbeef',
      batch_id: 'b1',
      status: 'SENT',
      created_at: new Date(now.value - 40 * DAY_MS).toISOString(),
    });
    db.seedObject('A/sent-old.png', Buffer.from('bytes'));

    await runRetention(buildDeps(db, now));

    expect(db.storage.has('A/sent-old.png')).toBe(false); // the file is gone
    const survivingRow = db.tables.message_history.find((r) => r.id === msg.id);
    expect(survivingRow).toBeDefined(); // the record outlives the file
    expect(survivingRow!.media_sha256).toBe('deadbeef');
  });

  it('RET-06: dry run returns counts and byte totals only, and deletes nothing', async () => {
    db.seed('image_sessions', {
      org_id: ORG_A, user_id: 'A',
      prompt_history: [],
      current_path: 'A/old-unsent.png',
      source: 'generated',
      updated_at: new Date(now.value - 10 * DAY_MS).toISOString(),
    });
    db.seedObject('A/old-unsent.png', Buffer.from('twelve-bytes'));

    const result = await runRetention(buildDeps(db, now), { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.objectsDeleted).toBe(1); // "would delete" count
    expect(result.bytesDeleted).toBe(Buffer.from('twelve-bytes').length);
    expect(result.sessionsDeleted).toBe(0); // dry run performs no deletion
    // No object paths or per-user breakdown anywhere in the result shape.
    expect(JSON.stringify(result)).not.toContain('old-unsent.png');
    expect(Object.keys(result).sort()).toEqual(
      ['bytesDeleted', 'dryRun', 'errors', 'objectsDeleted', 'sessionsDeleted', 'sessionsEvaluated'].sort(),
    );

    // Nothing was actually touched.
    expect(db.storage.has('A/old-unsent.png')).toBe(true);
    expect(db.tables.image_sessions).toHaveLength(1);
  });

  it('RET-07: a run interrupted partway (one session errors) does not corrupt state, and a re-run finishes the job', async () => {
    db.seed('image_sessions', {
      org_id: ORG_A, user_id: 'A',
      prompt_history: [],
      current_path: 'A/one.png',
      source: 'generated',
      updated_at: new Date(now.value - 10 * DAY_MS).toISOString(),
    });
    db.seed('image_sessions', {
      org_id: ORG_A, user_id: 'A',
      prompt_history: [],
      current_path: 'A/two.png',
      source: 'generated',
      updated_at: new Date(now.value - 10 * DAY_MS).toISOString(),
    });
    db.seedObject('A/one.png', Buffer.from('bytes'));
    db.seedObject('A/two.png', Buffer.from('bytes'));

    const deps = buildDeps(db, now);
    const originalDelete = deps.imageSessionsRepo.deleteInOrg.bind(deps.imageSessionsRepo);
    let failOnce = true;
    deps.imageSessionsRepo.deleteInOrg = async (orgId, id) => {
      const row = db.tables.image_sessions.find((r) => r.id === id);
      if (failOnce && row?.current_path === 'A/two.png') {
        failOnce = false;
        throw new Error('simulated interruption');
      }
      return originalDelete(orgId, id);
    };

    const firstRun = await runRetention(deps);
    expect(firstRun.sessionsDeleted).toBe(1); // "one.png" succeeded
    expect(firstRun.errors).toHaveLength(1); // "two.png" recorded as an error, not silently lost
    expect(db.tables.image_sessions).toHaveLength(1); // two.png's row still exists (not half-deleted)

    const secondRun = await runRetention(deps);
    expect(secondRun.sessionsDeleted).toBe(1); // two.png finishes on the re-run
    expect(secondRun.errors).toHaveLength(0);
    expect(db.tables.image_sessions).toHaveLength(0);

    const thirdRun = await runRetention(deps);
    expect(thirdRun.sessionsEvaluated).toBe(0); // nothing left to do — re-running is safe
  });

  it('RET-08: retention across two users evaluates each independently with no cross-deletion', async () => {
    db.seed('image_sessions', {
      org_id: ORG_A, user_id: 'A',
      prompt_history: [],
      current_path: 'A/old.png',
      source: 'generated',
      updated_at: new Date(now.value - 10 * DAY_MS).toISOString(),
    });
    db.seed('image_sessions', {
      org_id: ORG_B, user_id: 'B',
      prompt_history: [],
      current_path: 'B/recent.png',
      source: 'generated',
      updated_at: new Date(now.value - 1 * DAY_MS).toISOString(),
    });
    db.seedObject('A/old.png', Buffer.from('bytes'));
    db.seedObject('B/recent.png', Buffer.from('bytes'));

    const result = await runRetention(buildDeps(db, now));

    expect(result.sessionsDeleted).toBe(1);
    expect(db.storage.has('A/old.png')).toBe(false);
    expect(db.storage.has('B/recent.png')).toBe(true); // B's object untouched by A's deletion
    expect(db.tables.image_sessions.find((r) => r.user_id === 'B')).toBeDefined();
  });
});

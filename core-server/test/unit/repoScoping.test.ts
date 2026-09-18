import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeSupabaseClient, FakeDb } from '../fakes/fakeSupabaseClient';
import { createImageSessionsRepo } from '../../src/repositories/imageSessionsRepo';
import { createOrgUsageRepo } from '../../src/repositories/orgUsageRepo';
import { createSettingsRepo } from '../../src/repositories/settingsRepo';
import { createOrgsRepo } from '../../src/repositories/orgsRepo';
import { createInvitationsRepo } from '../../src/repositories/invitationsRepo';

const ORG_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ORG_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/**
 * core-server talks to Postgres with the service role key, which bypasses
 * RLS entirely (crmex.md §4, §15.4). That means the repository layer's own
 * `.eq('org_id', ...)` filters are the ONLY thing standing between a bug
 * and a cross-firm read. These tests inspect the fake DB's call log (which
 * is populated regardless of RLS mode) to prove every repo method that
 * touches a firm table actually includes that filter — independent of the
 * RLS emulation tested in test/integration/iso.test.ts.
 */
describe('repository scoping (service-role call inspection)', () => {
  let db: FakeDb;
  const service = () => createFakeSupabaseClient({ db, mode: 'service' });
  const calls = (table: string, op: string) => db.callLog.filter((c) => c.table === table && c.op === op);

  beforeEach(() => {
    db = new FakeDb();
  });

  it('imageSessionsRepo.getInOrg always filters by org_id (not just id)', async () => {
    db.seed('image_sessions', { org_id: ORG_A, user_id: 'A', prompt_history: [], current_path: 'x', source: 'generated' });

    expect(await createImageSessionsRepo(service()).getInOrg(ORG_B, 1)).toBeNull();

    expect(calls('image_sessions', 'select')[0].filters).toContainEqual({ column: 'org_id', value: ORG_B });
  });

  it('imageSessionsRepo.updateInOrg always filters by org_id and cannot touch another firm\'s row', async () => {
    db.seed('image_sessions', { org_id: ORG_A, user_id: 'A', prompt_history: [], current_path: 'x', source: 'generated' });

    expect(await createImageSessionsRepo(service()).updateInOrg(ORG_B, 1, { current_path: 'y' })).toBeNull();

    expect(calls('image_sessions', 'update')[0].filters).toContainEqual({ column: 'org_id', value: ORG_B });
    expect(db.tables.image_sessions[0].current_path).toBe('x');
  });

  it('image_sessions.org_id is immutable even for the service role (guard_org_id trigger), and user_id may be null', async () => {
    db.seed('image_sessions', { org_id: ORG_A, user_id: null, prompt_history: [], current_path: 'x', source: 'generated' });

    const moved = await service().from('image_sessions').update({ org_id: ORG_B }).eq('id', 1);
    expect(moved.error?.code).toBe('42501');
    expect(db.tables.image_sessions[0].org_id).toBe(ORG_A);

    // A session whose creator's account was deleted still works for its firm.
    expect(await createImageSessionsRepo(service()).updateInOrg(ORG_A, 1, { current_path: 'y' })).toMatchObject({ user_id: null, current_path: 'y' });
  });

  it('imageSessionsRepo.deleteInOrg always filters by org_id', async () => {
    await createImageSessionsRepo(service()).deleteInOrg(ORG_B, 42);
    expect(calls('image_sessions', 'delete')[0].filters).toContainEqual({ column: 'org_id', value: ORG_B });
  });

  it('imageSessionsRepo.create records both the firm and the creating user', async () => {
    const row = await createImageSessionsRepo(service()).create(ORG_A, 'A', { promptHistory: [], currentPath: 'x', source: 'generated' });
    expect(row.org_id).toBe(ORG_A);
    expect(row.user_id).toBe('A');
  });

  it('orgUsageRepo reads and writes are keyed by org_id and the current day', async () => {
    const repo = createOrgUsageRepo(service(), () => Date.UTC(2026, 0, 15));

    await repo.getToday(ORG_B);
    await repo.reserve(ORG_B, 'messages_drafted', 5);

    for (const c of [...calls('org_usage_daily', 'select'), ...calls('org_usage_daily', 'update')]) {
      expect(c.filters).toContainEqual({ column: 'org_id', value: ORG_B });
      expect(c.filters).toContainEqual({ column: 'day', value: '2026-01-15' });
    }
    expect(calls('org_usage_daily', 'update')).toHaveLength(1);
  });

  it('orgUsageRepo.reserve is a compare-and-set: concurrent reservations never exceed the limit', async () => {
    const repo = createOrgUsageRepo(service(), () => Date.UTC(2026, 0, 15));

    const results = await Promise.all(Array.from({ length: 6 }, () => repo.reserve(ORG_A, 'images_generated', 3)));

    expect(results.filter(Boolean)).toHaveLength(3);
    expect(db.tables.org_usage_daily).toHaveLength(1);
    expect(db.tables.org_usage_daily[0].images_generated).toBe(3);
  });

  it('orgsRepo.getMembership filters by both org_id and user_id', async () => {
    await createOrgsRepo(service()).getMembership(ORG_A, 'B');
    const [call] = calls('org_members', 'select');
    expect(call.filters).toContainEqual({ column: 'org_id', value: ORG_A });
    expect(call.filters).toContainEqual({ column: 'user_id', value: 'B' });
  });

  it('invitationsRepo.listPending and revoke are scoped by org_id', async () => {
    const repo = createInvitationsRepo(service());
    await repo.listPending(ORG_A, '2026-01-01T00:00:00.000Z');
    await repo.revoke(ORG_A, 'some-id', '2026-01-01T00:00:00.000Z');
    expect(calls('org_invitations', 'select')[0].filters).toContainEqual({ column: 'org_id', value: ORG_A });
    expect(calls('org_invitations', 'update')[0].filters).toContainEqual({ column: 'org_id', value: ORG_A });
  });

  it('settingsRepo.get is global (no org/user filter) but filters by key', async () => {
    await createSettingsRepo(service()).get('quota.default_daily_images');
    expect(calls('app_settings', 'select')[0].filters).toEqual([{ column: 'key', value: 'quota.default_daily_images' }]);
  });

  it('a repo bug that forgot the org_id filter would leak: the service role really does bypass RLS', async () => {
    // Meta-test: proves the fake does NOT protect against a missing filter
    // (matching real Supabase) — the repo-level filter is genuinely load-bearing.
    db.seed('image_sessions', { org_id: ORG_A, user_id: 'A', prompt_history: [], current_path: 'x', source: 'generated' });
    const { data } = await service().from('image_sessions').select('*');
    expect(data).toHaveLength(1);
  });
});

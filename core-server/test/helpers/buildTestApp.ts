import { createApp } from '../../src/app';
import type { CreateAppOptions } from '../../src/app';
import { createFakeSupabaseClient, FakeDb, makeFakeToken } from '../fakes/fakeSupabaseClient';
import { createFakeLlmProvider } from '../../src/providers/llm/fake';
import { createFakeImageGenProvider } from '../../src/providers/image-gen/fake';
import { createFakeImageSearchProvider } from '../../src/providers/image-search/fake';
import type { LlmProvider, ImageGenProvider, ImageSearchProvider } from '../../src/providers/types';

export interface TestAppBundle {
  app: ReturnType<typeof createApp>;
  db: FakeDb;
  llmProvider: ReturnType<typeof createFakeLlmProvider>;
  imageGenProvider: ReturnType<typeof createFakeImageGenProvider>;
  imageSearchProvider: ReturnType<typeof createFakeImageSearchProvider>;
  clock: { now: number };
}

export interface BuildTestAppOptions {
  db?: FakeDb;
  llmProvider?: LlmProvider;
  imageGenProvider?: ImageGenProvider;
  imageSearchProvider?: ImageSearchProvider;
  fetchImageBytes?: (url: string) => Promise<Buffer>;
  providerTimeoutMs?: number;
  signedUrlTtlSeconds?: number;
}

/**
 * Builds a real Express app (src/app.ts#createApp) wired to the strict fake
 * Supabase client and fake providers, plus a shared mutable clock so tests
 * can move time forward (quota resets, retention TTLs, signed-URL expiry)
 * without real sleeps.
 */
export function buildTestApp(opts: BuildTestAppOptions = {}): TestAppBundle {
  const db = opts.db ?? new FakeDb();
  const clock = { now: Date.UTC(2026, 0, 1, 12, 0, 0) };
  db.setClock(() => clock.now);

  const supabase = createFakeSupabaseClient({ db, mode: 'service' });

  const llmProvider = (opts.llmProvider as ReturnType<typeof createFakeLlmProvider>) ?? createFakeLlmProvider();
  const imageGenProvider =
    (opts.imageGenProvider as ReturnType<typeof createFakeImageGenProvider>) ?? createFakeImageGenProvider();
  const imageSearchProvider =
    (opts.imageSearchProvider as ReturnType<typeof createFakeImageSearchProvider>) ?? createFakeImageSearchProvider();

  const appOptions: CreateAppOptions = {
    supabase,
    llmProvider,
    imageGenProvider,
    imageSearchProvider,
    fetchImageBytes: opts.fetchImageBytes,
    providerTimeoutMs: opts.providerTimeoutMs ?? 2000,
    signedUrlTtlSeconds: opts.signedUrlTtlSeconds ?? 300,
    now: () => clock.now,
  };

  const app = createApp(appOptions);

  return { app, db, llmProvider, imageGenProvider, imageSearchProvider, clock };
}

export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// Firm tenancy fixtures (crmex.md §15)
// ---------------------------------------------------------------------------

export const ORG_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const ORG_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** Seeds a firm with members directly (as the service role would). */
export function seedFirm(
  db: FakeDb,
  orgId: string,
  members: Array<{ userId: string; role?: 'owner' | 'admin' | 'member' }>,
  name = `Firm ${orgId.slice(0, 4)}`,
): void {
  if (!db.tables.organizations.some((o) => o.id === orgId)) db.seed('organizations', { id: orgId, name });
  for (const m of members) {
    if (db.isMember(orgId, m.userId)) continue;
    db.seed('org_members', {
      org_id: orgId,
      user_id: m.userId,
      role: m.role ?? 'member',
      email: `${m.userId.toLowerCase()}@example.test`,
      display_name: m.userId,
    });
  }
}

/** Authorization + X-Org-Id for a firm-scoped request. */
export function firmAuth(sub: string, orgId: string = ORG_A, token?: string): { Authorization: string; 'X-Org-Id': string } {
  return { Authorization: `Bearer ${token ?? makeFakeToken({ sub })}`, 'X-Org-Id': orgId };
}

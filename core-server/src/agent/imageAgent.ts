import type { ImageGenProvider, ImageSearchProvider, ImageResult, PromptHistoryEntry } from '../providers/types';
import type { ImageSessionsRepo } from '../repositories/imageSessionsRepo';
import type { OrgUsageRepo } from '../repositories/orgUsageRepo';
import type { SettingsRepo } from '../repositories/settingsRepo';
import type { StorageRepo } from '../repositories/storageRepo';
import { reserveImageGeneration } from '../quota/quota';
import { buildObjectPath, isPathInOrg, isServableSessionPath } from '../lib/paths';
import { sha256Hex } from '../lib/hash';
import { withTimeout, TimeoutError } from '../lib/withTimeout';
import { createSessionLock } from '../lib/sessionLock';
import { NotFoundError, ProviderError, ProviderTimeoutError, QuotaExceededError } from '../lib/errors';
import { DEFAULT_SETTINGS } from '../repositories/defaultSettings';

export interface ImageAgentDeps {
  imageGenProvider: ImageGenProvider;
  imageSearchProvider: ImageSearchProvider;
  storageRepo: StorageRepo;
  imageSessionsRepo: ImageSessionsRepo;
  orgUsageRepo: OrgUsageRepo;
  settingsRepo: SettingsRepo;
  fetchImageBytes: (url: string) => Promise<Buffer>;
  providerTimeoutMs: number;
  now: () => number;
  lock: ReturnType<typeof createSessionLock>;
}

/** The membership-verified firm and the JWT-derived caller. Never from a request body. */
export interface FirmScope {
  orgId: string;
  userId: string;
}

export interface ImageResultPayload {
  sessionId: number | string;
  path: string;
  signedUrl: string;
  promptHistory: PromptHistoryEntry[];
}

async function runProviderCall<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  try {
    return await withTimeout(promise, timeoutMs, `${label} timed out`);
  } catch (err) {
    if (err instanceof TimeoutError) throw new ProviderTimeoutError(err.message);
    const message = err instanceof Error ? err.message : String(err);
    throw new ProviderError(`${label} failed: ${message}`);
  }
}

/**
 * Runs a quota-reserved provider call. A provider ERROR gives the
 * reservation back (nothing was produced). A TIMEOUT keeps it: the vendor
 * may still finish and bill, so a firm can't loop timeouts past its quota.
 */
async function withReservation<T>(deps: ImageAgentDeps, orgId: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ProviderError) await deps.orgUsageRepo.release(orgId, 'images_generated').catch(() => {});
    throw err;
  }
}

/** Defense in depth: only sign/serve paths under the verified firm. */
function assertPathInOrg(path: string, orgId: string): void {
  if (!isPathInOrg(path, orgId)) throw new NotFoundError('Image not found');
}

/** POST /api/v1/images/generate (IMG-01, IMG-07, IMG-08, QTA-01/02/04). */
export async function generateImage(deps: ImageAgentDeps, scope: FirmScope, prompt: string): Promise<ImageResultPayload> {
  await reserveImageGeneration({ orgUsageRepo: deps.orgUsageRepo, settingsRepo: deps.settingsRepo, orgId: scope.orgId });

  // Provider call happens before any DB/storage write: on failure there is
  // no partial session row and no orphaned object (IMG-07/08).
  const generated = await withReservation(deps, scope.orgId, () =>
    runProviderCall(deps.imageGenProvider.generate(prompt), deps.providerTimeoutMs, 'Image generation'),
  );

  const sha256 = sha256Hex(generated.bytes);
  const path = buildObjectPath(scope.orgId, scope.userId, sha256);
  await deps.storageRepo.upload(path, generated.bytes, generated.mimeType);

  const promptHistory: PromptHistoryEntry[] = [
    { role: 'user', prompt, timestamp: new Date(deps.now()).toISOString() },
  ];

  let sessionId: number | string;
  try {
    const row = await deps.imageSessionsRepo.create(scope.orgId, scope.userId, { promptHistory, currentPath: path, source: 'generated' });
    sessionId = row.id;
  } catch (err) {
    // Compensate: don't leave an orphaned object if the DB write failed.
    await deps.storageRepo.remove([path]).catch(() => {});
    throw err;
  }

  await deps.orgUsageRepo.addStorageBytes(scope.orgId, generated.bytes.length);
  const signedUrl = await deps.storageRepo.createSignedUrl(path);

  return { sessionId, path, signedUrl, promptHistory };
}

/**
 * POST /api/v1/images/:sessionId/refine (IMG-02, IMG-03, IMG-04 via the
 * provider, IMG-09, IMG-10). Any member of the firm may refine a firm
 * session (§15.5); a session in another firm is indistinguishable from a
 * missing one (404). The new object goes under the refining member's folder.
 */
export async function refineImage(
  deps: ImageAgentDeps,
  scope: FirmScope,
  sessionId: string,
  instruction: string,
): Promise<Omit<ImageResultPayload, 'sessionId'>> {
  return deps.lock(`${scope.orgId}:${sessionId}`, async () => {
    const session = await deps.imageSessionsRepo.getInOrg(scope.orgId, sessionId);
    if (!session) {
      // Never leak existence of another firm's session: 404, not 403/other.
      throw new NotFoundError('Image session not found');
    }
    // Legacy <user_id>/<sha>.png objects (pre-tenancy, never moved) stay usable
    // for sessions in this firm; another firm's canonical path never is.
    if (!session.current_path || !isServableSessionPath(session.current_path, scope.orgId)) {
      throw new NotFoundError('Image session has no current image');
    }

    await reserveImageGeneration({ orgUsageRepo: deps.orgUsageRepo, settingsRepo: deps.settingsRepo, orgId: scope.orgId });

    const edited = await withReservation(deps, scope.orgId, async () => {
      const baseBytes = await deps.storageRepo.download(session.current_path!);
      return runProviderCall(
        deps.imageGenProvider.edit(baseBytes, instruction, session.prompt_history),
        deps.providerTimeoutMs,
        'Image refinement',
      );
    });

    const sha256 = sha256Hex(edited.bytes);
    const newPath = buildObjectPath(scope.orgId, scope.userId, sha256);
    await deps.storageRepo.upload(newPath, edited.bytes, edited.mimeType);

    const promptHistory: PromptHistoryEntry[] = [
      ...session.prompt_history,
      { role: 'user', prompt: instruction, timestamp: new Date(deps.now()).toISOString() },
    ];

    let updated;
    try {
      updated = await deps.imageSessionsRepo.updateInOrg(scope.orgId, sessionId, {
        current_path: newPath,
        prompt_history: promptHistory,
        updated_at: new Date(deps.now()).toISOString(),
      });
    } catch (err) {
      await deps.storageRepo.remove([newPath]).catch(() => {});
      throw err;
    }
    if (!updated) {
      // Session vanished between getInOrg and update (shouldn't happen given
      // the per-session lock, but fail safe rather than return a phantom path).
      await deps.storageRepo.remove([newPath]).catch(() => {});
      throw new NotFoundError('Image session not found');
    }

    await deps.orgUsageRepo.addStorageBytes(scope.orgId, edited.bytes.length);
    assertPathInOrg(newPath, scope.orgId);
    const signedUrl = await deps.storageRepo.createSignedUrl(newPath);

    return { path: newPath, signedUrl, promptHistory };
  });
}

/** POST /api/v1/images/search (IMG-05, IMG-07, IMG-08). */
export async function searchImages(deps: ImageAgentDeps, query: string, limit?: number): Promise<ImageResult[]> {
  return runProviderCall(deps.imageSearchProvider.search(query, limit), deps.providerTimeoutMs, 'Image search');
}

/**
 * POST /api/v1/images/search/select (IMG-06). Never trusts a client-supplied
 * path — downloads bytes server-side and derives the path from their hash.
 * No generation cost, so only the firm's storage ceiling applies.
 */
export async function selectSearchedImage(
  deps: ImageAgentDeps,
  scope: FirmScope,
  sourceUrl: string,
  query: string,
): Promise<ImageResultPayload> {
  const [storageLimitRaw, usage] = await Promise.all([
    deps.settingsRepo.get('quota.default_storage_bytes'),
    deps.orgUsageRepo.getToday(scope.orgId),
  ]);
  const storageLimit = Number.isFinite(Number(storageLimitRaw)) ? Number(storageLimitRaw) : DEFAULT_SETTINGS['quota.default_storage_bytes'];
  if (usage.storage_bytes >= storageLimit) {
    throw new QuotaExceededError(`Storage quota reached (${storageLimit} bytes).`);
  }

  const bytes = await runProviderCall(deps.fetchImageBytes(sourceUrl), deps.providerTimeoutMs, 'Image download');

  const sha256 = sha256Hex(bytes);
  const path = buildObjectPath(scope.orgId, scope.userId, sha256);
  await deps.storageRepo.upload(path, bytes);

  const promptHistory: PromptHistoryEntry[] = [
    { role: 'user', prompt: query, timestamp: new Date(deps.now()).toISOString() },
  ];

  let sessionId: number | string;
  try {
    const row = await deps.imageSessionsRepo.create(scope.orgId, scope.userId, { promptHistory, currentPath: path, source: 'searched' });
    sessionId = row.id;
  } catch (err) {
    await deps.storageRepo.remove([path]).catch(() => {});
    throw err;
  }

  await deps.orgUsageRepo.addStorageBytes(scope.orgId, bytes.length);
  const signedUrl = await deps.storageRepo.createSignedUrl(path);
  return { sessionId, path, signedUrl, promptHistory };
}

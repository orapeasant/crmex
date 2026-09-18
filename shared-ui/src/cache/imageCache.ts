// Device image cache logic (crmex.md §3.3, §4). Pure decision logic —
// callers wire it to @capacitor/filesystem + LocalStore.
import type { ImageCacheRow, LocalStore } from '../types.js';

export interface CacheBudget {
  maxBytes: number;
}

export const DEFAULT_CACHE_BUDGET: CacheBudget = { maxBytes: 200 * 1024 * 1024 }; // 200MB

/**
 * Decide which rows to evict to bring total size at/under budget, evicting by
 * `last_used_at` ascending (oldest first) and never evicting the currently
 * in-use path(s) (CSH-03).
 */
export function planEviction(rows: ImageCacheRow[], budget: CacheBudget, inUsePaths: ReadonlySet<string>): ImageCacheRow[] {
  const total = rows.reduce((sum, r) => sum + r.bytes, 0);
  if (total <= budget.maxBytes) return [];

  const evictable = rows
    .filter((r) => !inUsePaths.has(r.mediaPath))
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

  const toEvict: ImageCacheRow[] = [];
  let remaining = total;
  for (const row of evictable) {
    if (remaining <= budget.maxBytes) break;
    toEvict.push(row);
    remaining -= row.bytes;
  }
  return toEvict;
}

/**
 * Construct the on-device cache file path. Partitioned per user_id, matching
 * the Storage object layout so eviction/purge logic can reason about both
 * uniformly (crmex.md §3.3).
 */
export function localCachePath(userId: string, mediaPath: string): string {
  assertSafeMediaPath(mediaPath);
  // mediaPath is already `<user_id>/<sha256>.png` as returned by core-server;
  // re-deriving the filename avoids trusting the full path from the network
  // response for filesystem writes.
  const filename = mediaPath.split('/').pop();
  if (!filename) throw new Error('INVALID_MEDIA_PATH');
  return `images/${userId}/${filename}`;
}

/**
 * Validates a storage object path / media path fragment before it is used to
 * construct any local filesystem path or is passed back to the server. This
 * is the client-side mirror of crmex.md §4's path-handling rule (ISO-15..19):
 * reject traversal, absolute paths, and encoded traversal sequences.
 * Client-side rejection here is defense in depth — the authoritative check
 * is server-side path construction from the JWT-derived user_id, which this
 * client never controls.
 */
export function assertSafeMediaPath(path: string | null | undefined): asserts path is string {
  if (!path) {
    throw new Error('EMPTY_MEDIA_PATH'); // ISO-18
  }
  let decoded = path;
  try {
    decoded = decodeURIComponent(path); // ISO-17: catch %2e%2e%2f etc.
  } catch {
    throw new Error('UNDECODABLE_MEDIA_PATH');
  }
  if (decoded.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(decoded)) {
    throw new Error('ABSOLUTE_PATH_REJECTED'); // ISO-16
  }
  const segments = decoded.split(/[\\/]/);
  if (segments.some((seg) => seg === '..' || seg === '.')) {
    throw new Error('PATH_TRAVERSAL_REJECTED'); // ISO-15, ISO-17
  }
}

/** Server-side-shaped helper kept here for the unit tests in ISO-19 — the
 * real construction happens in core-server, but the shape is a contract both
 * sides must agree on, so it is asserted here too. */
export function expectedObjectPath(userId: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new Error('INVALID_SHA256');
  }
  return `${userId}/${sha256}.png`;
}

export async function purgeUserCache(store: LocalStore, userId: string, deleteLocalFile: (path: string) => Promise<void>): Promise<void> {
  const rows = await store.listCacheByUser(userId);
  for (const row of rows) {
    await deleteLocalFile(row.localFile).catch(() => {
      /* best-effort: the OS may have already reclaimed Directory.Cache (CSH-05) */
    });
  }
  await store.purgeUser(userId);
}

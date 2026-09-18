import type { SupabaseLike } from '../db/types';

const BUCKET = 'user-images';

/**
 * Thin wrapper over Supabase Storage for the `user-images` bucket
 * (crmex.md §3.3). Every path passed in here must already have been built
 * by src/lib/paths.ts#buildObjectPath from the JWT-derived user_id — this
 * repo does not itself re-derive or validate ownership of the path, that is
 * the caller's job (src/agent/imageAgent.ts).
 */
export function createStorageRepo(db: SupabaseLike, signedUrlTtlSeconds = 300) {
  return {
    async upload(path: string, bytes: Buffer, contentType = 'image/png'): Promise<void> {
      const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true });
      if (error) throw new Error(`storageRepo.upload failed: ${error.message}`);
    },

    async download(path: string): Promise<Buffer> {
      const { data, error } = await db.storage.from(BUCKET).download(path);
      if (error || !data) throw new Error(`storageRepo.download failed: ${error?.message ?? 'no data returned'}`);
      if (Buffer.isBuffer(data)) return data;
      const arrayBuffer = await (data as Blob).arrayBuffer();
      return Buffer.from(arrayBuffer);
    },

    async remove(paths: string[]): Promise<void> {
      if (paths.length === 0) return;
      const { error } = await db.storage.from(BUCKET).remove(paths);
      if (error) throw new Error(`storageRepo.remove failed: ${error.message}`);
    },

    async createSignedUrl(path: string): Promise<string> {
      const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, signedUrlTtlSeconds);
      if (error || !data) throw new Error(`storageRepo.createSignedUrl failed: ${error?.message ?? 'no data returned'}`);
      return data.signedUrl;
    },

    /**
     * Best-effort object size lookup for the retention dry-run's byte totals
     * (RET-06). Returns 0 rather than throwing if the object is already gone
     * or metadata is unavailable — retention accounting is advisory, not a
     * billing system.
     */
    async getObjectSize(path: string): Promise<number> {
      const lastSlash = path.lastIndexOf('/');
      const dir = lastSlash === -1 ? '' : path.slice(0, lastSlash);
      const filename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
      const { data, error } = await db.storage.from(BUCKET).list(dir, { search: filename });
      if (error || !data) return 0;
      const match = data.find((f) => f.name === filename);
      return match?.metadata?.size ?? 0;
    },
  };
}

export type StorageRepo = ReturnType<typeof createStorageRepo>;

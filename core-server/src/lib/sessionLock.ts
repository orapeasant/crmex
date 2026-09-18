/**
 * Per-key in-process serialization for concurrent refine calls on the same
 * image session (IMG-10). A second call for the same key waits for the
 * first to settle (success or failure) before it starts, so `current_path`
 * is never left pointing at a not-yet-uploaded object and refinements never
 * interleave their writes.
 *
 * This is process-local. A multi-instance deployment of core-server would
 * need a DB-level lock (e.g. `select ... for update` on the image_sessions
 * row) for the same guarantee across instances — documented as a known
 * limitation in core-server/README.md since crmex.md's schema (§3.1) has no
 * version/lock column to build one on without a schema change.
 */
export function createSessionLock() {
  const queue = new Map<string, Promise<unknown>>();

  return function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = queue.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    // Keep the chain alive regardless of outcome, but never let a rejection
    // here become an unhandled rejection warning.
    queue.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  };
}

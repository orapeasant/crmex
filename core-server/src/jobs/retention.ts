import type { ImageSessionsRepo } from '../repositories/imageSessionsRepo';
import type { MessageHistoryRepo } from '../repositories/messageHistoryRepo';
import type { StorageRepo } from '../repositories/storageRepo';
import type { SettingsRepo } from '../repositories/settingsRepo';

/**
 * Scheduled retention job (crmex.md §13.6). A testable core (`runRetention`)
 * plus a thin CLI entrypoint (jobs/retentionCli.ts) — not a portal button,
 * though the portal (when built) can trigger a run or a dry-run preview
 * against this same function.
 *
 * Model: image_sessions has one `current_path` at a time. A session's
 * current image is "sent" if some message_history row's media_path equals
 * it — its age is then measured from the earliest such message's
 * created_at. Otherwise it's "unsent" and its age is measured from the
 * session's updated_at. This matches §13.6 exactly: deleting an object
 * referenced by message_history never deletes the message_history row
 * (RET-05) — only image_sessions rows and Storage objects are ever removed
 * here.
 */

export interface RetentionDeps {
  imageSessionsRepo: ImageSessionsRepo;
  messageHistoryRepo: MessageHistoryRepo;
  storageRepo: StorageRepo;
  settingsRepo: SettingsRepo;
  now: () => number;
}

export interface RetentionOptions {
  /** RET-06: when true, computes what WOULD be deleted without deleting anything. */
  dryRun?: boolean;
}

export interface RetentionResult {
  dryRun: boolean;
  sessionsEvaluated: number;
  sessionsDeleted: number;
  objectsDeleted: number;
  bytesDeleted: number;
  errors: Array<{ sessionId: string | number; message: string }>;
}

function daysBetween(nowMs: number, iso: string): number {
  return (nowMs - new Date(iso).getTime()) / 86_400_000;
}

export async function runRetention(deps: RetentionDeps, opts: RetentionOptions = {}): Promise<RetentionResult> {
  const dryRun = opts.dryRun ?? false;

  const [unsentTtlDays, sentTtlDays, sessions, messages] = await Promise.all([
    deps.settingsRepo.get('retention.unsent_image_ttl_days'),
    deps.settingsRepo.get('retention.sent_image_ttl_days'),
    deps.imageSessionsRepo.listAll(),
    deps.messageHistoryRepo.listAll(),
  ]);

  // path -> earliest message_history.created_at referencing it (that message defines "sent since").
  const sentAt = new Map<string, string>();
  for (const m of messages) {
    if (!m.media_path) continue;
    const existing = sentAt.get(m.media_path);
    if (!existing || new Date(m.created_at).getTime() < new Date(existing).getTime()) {
      sentAt.set(m.media_path, m.created_at);
    }
  }

  const nowMs = deps.now();
  const result: RetentionResult = {
    dryRun,
    sessionsEvaluated: 0,
    sessionsDeleted: 0,
    objectsDeleted: 0,
    bytesDeleted: 0,
    errors: [],
  };

  for (const session of sessions) {
    if (!session.current_path) continue;
    result.sessionsEvaluated += 1;

    const referencedSince = sentAt.get(session.current_path);
    const isSent = referencedSince !== undefined;

    if (isSent && sentTtlDays === 0) continue; // RET-04: 0 = keep indefinitely

    const ttlDays = isSent ? sentTtlDays : unsentTtlDays;
    const ageDays = isSent ? daysBetween(nowMs, referencedSince!) : daysBetween(nowMs, session.updated_at);

    if (ageDays <= ttlDays) continue; // RET-02: within TTL, keep

    try {
      const bytes = await deps.storageRepo.getObjectSize(session.current_path).catch(() => 0);
      if (!dryRun) {
        // Idempotent w.r.t. re-runs (RET-07): removing an already-removed
        // object is not treated as a fatal error for this session.
        await deps.storageRepo.remove([session.current_path]).catch(() => {});
        await deps.imageSessionsRepo.deleteInOrg(session.org_id, session.id);
        result.sessionsDeleted += 1;
      }
      result.objectsDeleted += 1;
      result.bytesDeleted += bytes;
    } catch (err) {
      // One session's failure must not abort the run — RET-07/RET-08.
      result.errors.push({ sessionId: session.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

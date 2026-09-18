// WebView-side durability manager (crmex.md §9.2). Owns the outbox state
// machine: write PENDING before handoff, mark CLAIMED at handoff, persist
// each result, mirror to Supabase, then clear the settled row. If mirroring
// fails the row is kept (final status, unmirrored) rather than lost
// (SEND-13). A row still CLAIMED at startup is surfaced to the user rather
// than silently resent (SEND-07) — that decision is structural here: this
// module exposes it as data (`resumeState().claimedUnsettled`), the UI layer
// is responsible for the actual prompt.
import type { LocalStore, OutboxRow, OutboxBatch, OutboxBatchItem, SendResultEvent } from '../types.js';

export interface QueueItemInput {
  jid: string;
  clientId?: string | null;
  displayName?: string | null;
  body?: string;
  mediaPath?: string | null;
  mediaBytesBase64?: string; // only needed at handoff time, not persisted
}

export interface MirrorResult {
  /** Firm recorded on the outbox row when the batch was prepared. */
  orgId: string;
  jid: string;
  /** CRM client the message went to (message_history.client_id), if it was sent to a client record. */
  clientId?: string | null;
  displayName?: string;
  body?: string;
  mediaPath?: string | null;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  errorReason?: string;
  batchId: string;
}

export type MirrorFn = (result: MirrorResult) => Promise<void>;

export interface ResumeState {
  /** Never left the device — hand these to Node again on next batch/launch. */
  pending: OutboxRow[];
  /** Handed to Node, no result ever came back. Ask the user; do not resend. */
  claimedUnsettled: OutboxRow[];
  /** Result known, but the Supabase mirror write failed. Retry the mirror only. */
  settledUnmirrored: OutboxRow[];
}

export class OutboxManager {
  constructor(
    private readonly storage: LocalStore,
    private readonly mirror: MirrorFn,
  ) {}

  /**
   * Writes every recipient as PENDING, then immediately marks them CLAIMED
   * (crmex.md §9.2: "marking a row CLAIMED with claimed_at before handing it
   * over"). Returns the IPC-ready batch. The caller (native bridge glue) is
   * responsible for actually invoking `NativeBridge.sendBatch(batch)`.
   */
  async prepareBatch(userId: string, orgId: string, batchId: string, items: QueueItemInput[], now: number): Promise<OutboxBatch> {
    if (items.length === 0) {
      throw new Error('EMPTY_BATCH');
    }
    const rows = await this.storage.insertOutboxBatch(
      userId,
      orgId,
      batchId,
      items.map((i) => ({ jid: i.jid, clientId: i.clientId ?? null, displayName: i.displayName ?? null, body: i.body, mediaPath: i.mediaPath ?? null })),
    );
    for (const row of rows) {
      await this.storage.claimOutboxRow(row.id, now);
    }
    const batchItems: OutboxBatchItem[] = rows.map((row, idx) => ({
      id: row.id,
      jid: row.jid,
      body: row.body,
      mediaBytesBase64: items[idx]?.mediaBytesBase64,
    }));
    return { batchId, items: batchItems };
  }

  /**
   * Handle one `wa:result` event from the Node process: persist the final
   * status, mirror to Supabase, and only delete the row once the mirror
   * succeeds. A mirror failure (SEND-13) leaves the row in place with its
   * final status so it can be retried without resending.
   */
  async handleResult(userId: string, _batchId: string, evt: SendResultEvent, extra?: { displayName?: string; body?: string; mediaPath?: string | null }): Promise<void> {
    await this.storage.settleOutboxRow(evt.id, evt.status);
    await this.retryMirror(userId, evt, extra);
  }

  private async retryMirror(
    userId: string,
    evt: Pick<SendResultEvent, 'id' | 'status' | 'error'>,
    extra?: { displayName?: string; body?: string; mediaPath?: string | null },
  ): Promise<void> {
    // Look up the row so we still have jid/body even if `extra` wasn't passed
    // (e.g. a retry pass on app launch, long after the original call site).
    const rows = await this.storage.listSettledUnmirrored(userId);
    const row = rows.find((r) => r.id === evt.id);
    // Without the row there is no firm to attribute the result to; writing it
    // under a guessed firm would put history in the wrong tenant.
    // Rows written before firms existed have an empty orgId and are left unmirrored for the same reason.
    if (!row || !row.orgId) return;
    try {
      await this.mirror({
        orgId: row.orgId,
        jid: row.jid,
        clientId: row.clientId ?? null,
        displayName: extra?.displayName ?? row.displayName ?? undefined,
        body: extra?.body ?? row.body,
        mediaPath: extra?.mediaPath ?? row.mediaPath ?? null,
        status: evt.status as 'SENT' | 'FAILED' | 'SKIPPED',
        errorReason: evt.error,
        // Always the row's own batch: a retry pass can run long after later
        // batches, and the caller's "current" batch would mislabel history.
        batchId: row.batchId,
      });
      await this.storage.deleteOutboxRow(evt.id);
    } catch {
      // Supabase unreachable — leave the row in place (final status, still
      // present). retryUnmirrored() will pick it up again later.
    }
  }

  /**
   * Call on reconnect / app resume to flush anything left by a prior SEND-13.
   * Retries every unmirrored row of the user, each under its own batch id
   * (the optional argument is accepted for older callers and ignored).
   */
  async retryUnmirrored(userId: string, _batchId?: string): Promise<void> {
    const rows = await this.storage.listSettledUnmirrored(userId);
    for (const row of rows) {
      await this.retryMirror(userId, { id: row.id, status: row.status as 'SENT' | 'FAILED' | 'SKIPPED' });
    }
  }

  /** Call on app launch, before starting any new batch. */
  async resumeState(userId: string): Promise<ResumeState> {
    const [pending, claimedUnsettled, settledUnmirrored] = await Promise.all([
      this.storage.listPendingOutbox(userId),
      this.storage.listClaimedUnsettled(userId),
      this.storage.listSettledUnmirrored(userId),
    ]);
    return { pending, claimedUnsettled, settledUnmirrored };
  }
}

// Pure queue-construction logic. This is the single choke point that decides
// what is allowed to become an outbox row — enforcement lives HERE, not just
// in UI filtering, per PHN-10 and SAF-02 ("nothing in needsReview can ever be
// queued, not just hidden in UI"; "excluded at queue construction").
import type { NormalizedContact } from '../types.js';

export interface QueueCandidate {
  contact: NormalizedContact;
  /** Result of sock.onWhatsApp(jid) — must be checked before queueing (SEND-04). */
  registeredOnWhatsApp: boolean | 'unknown';
  /** CRM client record this recipient came from; carried through to message_history.client_id. */
  clientId?: string | null;
}

export interface BuildQueueOptions {
  candidates: QueueCandidate[];
  /** JIDs the user has explicitly reviewed and approved this send for. Only
   * candidates whose jid is in this set are eligible — this is how the UI's
   * "confirm selection" step and the needsReview exclusion are enforced
   * structurally rather than by convention. */
  confirmedJids: Set<string>;
  /** Recipients who opted out — never queued again, across sessions (SAF-03). */
  suppressedJids: ReadonlySet<string>;
  body?: string;
  mediaPath?: string | null;
}

export interface SkippedEntry {
  jid: string;
  displayName: string;
  reason: 'NOT_CONFIRMED' | 'SUPPRESSED' | 'NOT_ON_WHATSAPP' | 'DUPLICATE';
}

export interface BuiltQueue {
  items: { jid: string; displayName: string; clientId?: string | null; body?: string; mediaPath?: string | null }[];
  skipped: SkippedEntry[];
}

/**
 * Build the set of outbox rows for a batch. Guarantees:
 *  - Every jid appears at most once, even if selected under two contact
 *    names (CON-07, SEND-09) — first occurrence wins.
 *  - A jid not in `confirmedJids` is never included, closing the path from
 *    an NL match straight to a send (NLM-03) and from needsReview to a send
 *    (PHN-10, since needsReview contacts never produce a NormalizedContact
 *    and therefore can never appear in `candidates` at all).
 *  - A suppressed jid is never included regardless of confirmation (SAF-02).
 *  - A candidate whose WhatsApp registration is confirmed-false is excluded
 *    (SEND-04). `'unknown'` is treated as not-yet-checked and is also
 *    excluded — callers must resolve `onWhatsApp()` before calling this.
 */
export function buildQueue(opts: BuildQueueOptions): BuiltQueue {
  const { candidates, confirmedJids, suppressedJids, body, mediaPath } = opts;
  const seen = new Set<string>();
  const items: BuiltQueue['items'] = [];
  const skipped: SkippedEntry[] = [];

  for (const c of candidates) {
    const jid = c.contact.jid;
    const displayName = c.contact.displayName;

    if (seen.has(jid)) {
      skipped.push({ jid, displayName, reason: 'DUPLICATE' });
      continue;
    }
    if (suppressedJids.has(jid)) {
      skipped.push({ jid, displayName, reason: 'SUPPRESSED' });
      continue;
    }
    if (!confirmedJids.has(jid)) {
      skipped.push({ jid, displayName, reason: 'NOT_CONFIRMED' });
      continue;
    }
    if (c.registeredOnWhatsApp !== true) {
      skipped.push({ jid, displayName, reason: 'NOT_ON_WHATSAPP' });
      continue;
    }

    seen.add(jid);
    items.push({ jid, displayName, ...(c.clientId ? { clientId: c.clientId } : {}), body, mediaPath });
  }

  return { items, skipped };
}

/** SEND-12: an empty batch must be rejected before any service starts. */
export function assertNonEmptyBatch(queue: BuiltQueue): void {
  if (queue.items.length === 0) {
    throw new Error('EMPTY_BATCH');
  }
}

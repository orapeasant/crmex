import { describe, it, expect } from 'vitest';
import { buildQueue, assertNonEmptyBatch, type QueueCandidate } from './queueBuilder.js';
import type { NormalizedContact } from '../types.js';

function contact(id: string, displayName: string, e164: string, jid: string): NormalizedContact {
  return { id, displayName, e164, jid };
}

describe('buildQueue', () => {
  it('SEND-09/CON-07: the same jid selected under two contact names is queued once', () => {
    const a = contact('a', 'Alice Work', '+201001234567', '201001234567@s.whatsapp.net');
    const b = contact('b', 'Alice Personal', '+201001234567', '201001234567@s.whatsapp.net');
    const candidates: QueueCandidate[] = [
      { contact: a, registeredOnWhatsApp: true },
      { contact: b, registeredOnWhatsApp: true },
    ];
    const jid = a.jid;
    const result = buildQueue({
      candidates,
      confirmedJids: new Set([jid]),
      suppressedJids: new Set(),
    });
    expect(result.items).toHaveLength(1);
    expect(result.skipped.some((s) => s.reason === 'DUPLICATE')).toBe(true);
  });

  it('PHN-10: a contact never confirmed (e.g. came from needsReview and was never resolved) cannot be queued', () => {
    const c = contact('c', 'Carol', '+201001234567', '201001234567@s.whatsapp.net');
    const result = buildQueue({
      candidates: [{ contact: c, registeredOnWhatsApp: true }],
      confirmedJids: new Set(), // never confirmed
      suppressedJids: new Set(),
    });
    expect(result.items).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('NOT_CONFIRMED');
  });

  it('SAF-02: a suppressed recipient is excluded at queue construction even if confirmed', () => {
    const c = contact('c', 'Carol', '+201001234567', '201001234567@s.whatsapp.net');
    const result = buildQueue({
      candidates: [{ contact: c, registeredOnWhatsApp: true }],
      confirmedJids: new Set([c.jid]),
      suppressedJids: new Set([c.jid]),
    });
    expect(result.items).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('SUPPRESSED');
  });

  it('SEND-04: a candidate not registered on WhatsApp is excluded, not queued', () => {
    const c = contact('c', 'Carol', '+201001234567', '201001234567@s.whatsapp.net');
    const result = buildQueue({
      candidates: [{ contact: c, registeredOnWhatsApp: false }],
      confirmedJids: new Set([c.jid]),
      suppressedJids: new Set(),
    });
    expect(result.items).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('NOT_ON_WHATSAPP');
  });

  it('an unresolved ("unknown") registration check is treated as not-queueable', () => {
    const c = contact('c', 'Carol', '+201001234567', '201001234567@s.whatsapp.net');
    const result = buildQueue({
      candidates: [{ contact: c, registeredOnWhatsApp: 'unknown' }],
      confirmedJids: new Set([c.jid]),
      suppressedJids: new Set(),
    });
    expect(result.items).toHaveLength(0);
  });

  it('SEND-12: an empty batch is rejected before any service starts', () => {
    const result = buildQueue({ candidates: [], confirmedJids: new Set(), suppressedJids: new Set() });
    expect(() => assertNonEmptyBatch(result)).toThrow('EMPTY_BATCH');
  });

  it('a valid, confirmed, registered, non-suppressed candidate is queued', () => {
    const c = contact('c', 'Carol', '+201001234567', '201001234567@s.whatsapp.net');
    const result = buildQueue({
      candidates: [{ contact: c, registeredOnWhatsApp: true }],
      confirmedJids: new Set([c.jid]),
      suppressedJids: new Set(),
      body: 'hello',
    });
    expect(() => assertNonEmptyBatch(result)).not.toThrow();
    expect(result.items).toEqual([{ jid: c.jid, displayName: 'Carol', body: 'hello', mediaPath: undefined }]);
  });
});

describe('buildQueue client attribution', () => {
  it('carries the CRM client id of a queued candidate', () => {
    const c = contact('c', 'Carol', '+201001234567', '201001234567@s.whatsapp.net');
    const result = buildQueue({
      candidates: [{ contact: c, registeredOnWhatsApp: true, clientId: 'client-9' }],
      confirmedJids: new Set([c.jid]),
      suppressedJids: new Set(),
    });
    expect(result.items[0].clientId).toBe('client-9');
  });
});

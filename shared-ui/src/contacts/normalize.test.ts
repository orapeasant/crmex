import { describe, it, expect } from 'vitest';
import { normalizeContacts, normalizeOne, jidFromE164, reEvaluateNeedsReview, type RawContact } from './normalize.js';

describe('normalizeOne (PHN-01..07)', () => {
  it('PHN-01: already-international number normalizes region-independently', () => {
    expect(normalizeOne('+20 100 123 4567', 'US')).toBe('+201001234567');
  });

  it('PHN-02: local number with matching SIM region', () => {
    expect(normalizeOne('0100 123 4567', 'EG')).toBe('+201001234567');
  });

  it('PHN-03: same local number under a different region produces a different E.164', () => {
    const eg = normalizeOne('0100 123 4567', 'EG');
    const us = normalizeOne('0100 123 4567', 'US');
    expect(eg).not.toBe(us);
  });

  it('PHN-04: spaces, dashes, parentheses are normalized correctly', () => {
    expect(normalizeOne('(020) 7946-0958', 'GB')).toBe('+442079460958');
  });

  it('PHN-05: unparseable strings return null', () => {
    expect(normalizeOne('call me', 'US')).toBeNull();
    expect(normalizeOne('12', 'US')).toBeNull();
  });

  it('PHN-06: valid-looking but invalid number for the region returns null, not a wrong E.164', () => {
    // Too short to be a real US number even though it's numeric-looking.
    expect(normalizeOne('555123', 'US')).toBeNull();
  });

  it('PHN-07: JID derivation strips exactly one leading +, no double-strip', () => {
    expect(jidFromE164('+201001234567')).toBe('201001234567@s.whatsapp.net');
  });

  it('jidFromE164 rejects a non-+-prefixed input', () => {
    expect(() => jidFromE164('201001234567')).toThrow();
  });
});

describe('normalizeContacts (CON-04..07)', () => {
  const raw: RawContact[] = [
    { contactId: 'c1', displayName: 'Alice', phones: ['+201001234567'] },
    { contactId: 'c2', displayName: 'Bob', phones: ['0100 999 8888', '0111 222 3333', '0122 333 4444'] },
    { contactId: 'c3', displayName: '', phones: ['+201001234567'] }, // no display name
    { contactId: 'c4', displayName: 'NoPhones', phones: [] },
    { contactId: 'c5', displayName: 'Bad', phones: ['call me'] },
  ];

  it('CON-04: a contact with no phone numbers is excluded from both buckets', () => {
    const { usable, needsReview } = normalizeContacts(raw, 'EG');
    const anyC4 = [...usable, ...needsReview].some((c) => c.id.startsWith('c4') || ('id' in c && c.id === 'c4'));
    expect(anyC4).toBe(false);
  });

  it('CON-05: all of a contact\'s numbers are offered, not just the first', () => {
    const { usable } = normalizeContacts(raw, 'EG');
    const bobNumbers = usable.filter((c) => c.displayName === 'Bob');
    expect(bobNumbers).toHaveLength(3);
  });

  it('CON-06: a contact with no display name falls back to "Unknown Contact"', () => {
    const { usable } = normalizeContacts(raw, 'EG');
    const c3 = usable.find((c) => c.e164 === '+201001234567' && c.id.startsWith('c3'));
    expect(c3?.displayName).toBe('Unknown Contact');
  });

  it('CON-07: the same number under two contacts is surfaced once per contact (dedup happens at queue time, not here)', () => {
    const { usable } = normalizeContacts(raw, 'EG');
    const dupNumber = usable.filter((c) => c.e164 === '+201001234567');
    expect(dupNumber).toHaveLength(2); // c1 and c3 — both surfaced; queueBuilder dedups by jid later
  });

  it('PHN-05 (bucket integration): unparseable numbers land in needsReview, never usable', () => {
    const { usable, needsReview } = normalizeContacts(raw, 'EG');
    expect(needsReview.some((c) => c.displayName === 'Bad')).toBe(true);
    expect(usable.some((c) => c.displayName === 'Bad')).toBe(false);
  });
});

describe('reEvaluateNeedsReview (PHN-09)', () => {
  it('previously needsReview numbers re-evaluate under a new region', () => {
    const needsReview = [{ id: 'c9', displayName: 'Local', raw: '0100 123 4567' }];
    // Under 'US' this is invalid and stays in review.
    const underUs = reEvaluateNeedsReview(needsReview, 'US');
    expect(underUs.usable).toHaveLength(0);
    expect(underUs.needsReview).toHaveLength(1);

    // Under 'EG' it becomes valid.
    const underEg = reEvaluateNeedsReview(needsReview, 'EG');
    expect(underEg.usable).toHaveLength(1);
    expect(underEg.usable[0].e164).toBe('+201001234567');
    expect(underEg.needsReview).toHaveLength(0);
  });
});

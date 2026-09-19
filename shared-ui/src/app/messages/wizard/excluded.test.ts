import { describe, it, expect } from 'vitest';
import { summarizeExcluded } from './excluded.js';

describe('summarizeExcluded (§18.3.1, CAM-16 — reasons reported separately, never merged)', () => {
  it('produces one phrase per reason present, in a fixed order', () => {
    const excluded = [
      { clientId: 'a', reason: 'inactive' as const },
      { clientId: 'b', reason: 'suppressed' as const },
      { clientId: 'c', reason: 'suppressed' as const },
      { clientId: 'd', reason: 'suppressed' as const },
      { clientId: 'e', reason: 'inactive' as const },
    ];
    expect(summarizeExcluded(excluded)).toEqual(['3 opted out', '2 inactive']);
  });

  it('an empty list produces no phrases', () => {
    expect(summarizeExcluded([])).toEqual([]);
  });

  it('covers every reason the data layer can report', () => {
    const excluded = [
      { clientId: 'a', reason: 'suppressed' as const },
      { clientId: 'b', reason: 'inactive' as const },
      { clientId: 'c', reason: 'no_phone' as const },
      { clientId: 'd', reason: 'duplicate' as const },
      { clientId: 'e', reason: 'not_found' as const },
    ];
    expect(summarizeExcluded(excluded)).toEqual(['1 opted out', '1 inactive', '1 no phone number', '1 a duplicate number', '1 no longer in the firm']);
  });
});

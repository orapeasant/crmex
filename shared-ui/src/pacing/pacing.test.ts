import { describe, it, expect } from 'vitest';
import { randomInterval, intervalsForBatch, DEFAULT_PACING_WINDOW } from './pacing.js';

describe('pacing (PAC-01..03)', () => {
  it('PAC-01: interval always falls within the configured min/max window', () => {
    for (let i = 0; i < 500; i++) {
      const v = randomInterval(DEFAULT_PACING_WINDOW);
      expect(v).toBeGreaterThanOrEqual(DEFAULT_PACING_WINDOW.minIntervalMs);
      expect(v).toBeLessThanOrEqual(DEFAULT_PACING_WINDOW.maxIntervalMs);
    }
  });

  it('PAC-02: intervals across a batch vary rather than being constant', () => {
    // Deterministic but varied RNG sequence.
    let seed = 1;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const intervals = intervalsForBatch(20, DEFAULT_PACING_WINDOW, rng);
    const distinct = new Set(intervals);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('PAC-03 (pure math half): a batch of N sends produces exactly N-1 gaps (sends are sequential, one gap between each pair)', () => {
    expect(intervalsForBatch(5, DEFAULT_PACING_WINDOW)).toHaveLength(4);
    expect(intervalsForBatch(1, DEFAULT_PACING_WINDOW)).toHaveLength(0);
    expect(intervalsForBatch(0, DEFAULT_PACING_WINDOW)).toHaveLength(0);
  });

  it('PAC-04: a changed pacing window is respected by the next computation', () => {
    const narrow = { minIntervalMs: 100, maxIntervalMs: 100 };
    for (let i = 0; i < 20; i++) {
      expect(randomInterval(narrow)).toBe(100);
    }
  });

  it('rejects an invalid window (max < min)', () => {
    expect(() => randomInterval({ minIntervalMs: 10, maxIntervalMs: 5 })).toThrow();
  });
});

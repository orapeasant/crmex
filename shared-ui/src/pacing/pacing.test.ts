import { describe, it, expect } from 'vitest';
import { randomInterval, intervalsForBatch, DEFAULT_PACING_WINDOW, campaignWindow, windowForJob, estimatedDurationMs } from './pacing.js';
import { isJobDue, isJobExpired, type SendJobRow } from '../crm/types.js';

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

describe('campaignWindow (CAM-05, CAM-06)', () => {
  it('CAM-05: interval_ms 30000 + jitter_pct 25 keeps every gap within [22500, 37500], N recipients producing N-1 gaps', () => {
    const window = campaignWindow(30_000, 25);
    expect(window).toEqual({ minIntervalMs: 22_500, maxIntervalMs: 37_500 });
    const gaps = intervalsForBatch(10, window);
    expect(gaps).toHaveLength(9);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(22_500);
      expect(gap).toBeLessThanOrEqual(37_500);
    }
  });

  it('CAM-06: jitter_pct 0 produces fixed gaps', () => {
    const window = campaignWindow(30_000, 0);
    expect(window).toEqual({ minIntervalMs: 30_000, maxIntervalMs: 30_000 });
    for (const gap of intervalsForBatch(5, window)) {
      expect(gap).toBe(30_000);
    }
  });

  it('CAM-06: a null interval_ms falls back to the firm pacing.* window', () => {
    expect(windowForJob({ interval_ms: null, jitter_pct: 25 })).toEqual(DEFAULT_PACING_WINDOW);
  });

  it('windowForJob uses campaignWindow when interval_ms is set', () => {
    expect(windowForJob({ interval_ms: 10_000, jitter_pct: 10 })).toEqual(campaignWindow(10_000, 10));
  });

  it('rejects jitter_pct above 50', () => {
    expect(() => campaignWindow(30_000, 51)).toThrow();
  });

  it('rejects a negative jitter_pct', () => {
    expect(() => campaignWindow(30_000, -1)).toThrow();
  });

  it('rejects a non-positive interval_ms', () => {
    expect(() => campaignWindow(0)).toThrow();
    expect(() => campaignWindow(-1000)).toThrow();
  });
});

describe('estimatedDurationMs', () => {
  it('412 recipients at 30s (±25%) is the arithmetic mean gap times N-1, ~3h25m', () => {
    const window = campaignWindow(30_000, 25);
    const meanGapMs = (window.minIntervalMs + window.maxIntervalMs) / 2;
    const expected = Math.round(411 * meanGapMs);
    const actual = estimatedDurationMs(412, window);
    expect(actual).toBe(expected);
    // Sanity-check against the spec's own figure (§18.4): ~3h25m, i.e. between 3h20m and 3h30m.
    expect(actual).toBeGreaterThan(3 * 3_600_000 + 20 * 60_000);
    expect(actual).toBeLessThan(3 * 3_600_000 + 30 * 60_000);
  });

  it('a single recipient produces zero gaps and zero duration', () => {
    expect(estimatedDurationMs(1, DEFAULT_PACING_WINDOW)).toBe(0);
    expect(estimatedDurationMs(0, DEFAULT_PACING_WINDOW)).toBe(0);
  });
});

function jobRow(over: Partial<SendJobRow>): SendJobRow {
  return {
    id: 'job-1',
    org_id: 'org-a',
    created_by: 'u1',
    status: 'queued',
    body: 'hi',
    media_path: null,
    recipients: [],
    claimed_at: null,
    finished_at: null,
    error: null,
    scheduled_at: null,
    interval_ms: null,
    jitter_pct: 25,
    expires_at: null,
    created_at: '2026-09-18T00:00:00Z',
    updated_at: '2026-09-18T00:00:00Z',
    ...over,
  };
}

describe('isJobDue / isJobExpired (§18.3.2)', () => {
  const now = new Date('2026-09-18T12:00:00Z');

  it('not yet due: scheduled_at in the future', () => {
    const job = jobRow({ scheduled_at: '2026-09-18T13:00:00Z' });
    expect(isJobDue(job, now)).toBe(false);
    expect(isJobExpired(job, now)).toBe(false);
  });

  it('due: scheduled_at in the past, not expired', () => {
    const job = jobRow({ scheduled_at: '2026-09-18T11:00:00Z', expires_at: '2026-09-18T18:00:00Z' });
    expect(isJobDue(job, now)).toBe(true);
    expect(isJobExpired(job, now)).toBe(false);
  });

  it('due: null scheduled_at means immediately', () => {
    const job = jobRow({ scheduled_at: null });
    expect(isJobDue(job, now)).toBe(true);
  });

  it('expired: expires_at in the past and still queued', () => {
    const job = jobRow({ scheduled_at: '2026-09-18T09:00:00Z', expires_at: '2026-09-18T11:00:00Z' });
    expect(isJobExpired(job, now)).toBe(true);
    expect(isJobDue(job, now)).toBe(false);
  });

  it('already-claimed: a claimed job is neither due nor (by this definition) expired', () => {
    const job = jobRow({ status: 'claimed', expires_at: '2026-09-18T11:00:00Z' });
    expect(isJobDue(job, now)).toBe(false);
    expect(isJobExpired(job, now)).toBe(false);
  });

  it('null scheduled_at and null expires_at: due forever, never expires', () => {
    const job = jobRow({ scheduled_at: null, expires_at: null });
    expect(isJobDue(job, now)).toBe(true);
    expect(isJobExpired(job, now)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { campaignWindow } from '../../../pacing/pacing.js';
import {
  defaultCampaignPlan,
  expiresAtIso,
  finishDate,
  formatJobSchedule,
  formatScheduleSummary,
  isCampaignJob,
  isValidIntervalMs,
  scheduledAtIso,
  startDate,
  type CampaignPlan,
} from './schedule.js';

describe('defaultCampaignPlan (§18.2 C1, C5)', () => {
  it('defaults to send now, 30s interval, 25% jitter, 6h late window', () => {
    const plan = defaultCampaignPlan();
    expect(plan.timing).toEqual({ mode: 'now' });
    expect(plan.intervalMs).toBe(30_000);
    expect(plan.jitterPct).toBe(25);
    expect(plan.expiresInMs).toBe(6 * 3_600_000);
  });
});

describe('scheduledAtIso / startDate / expiresAtIso', () => {
  it('"now" means a null scheduled_at — the pre-§18 default (§18.3.2)', () => {
    const plan = defaultCampaignPlan();
    expect(scheduledAtIso(plan)).toBeNull();
  });

  it('a scheduled plan carries its own ISO timestamp', () => {
    const at = new Date(2026, 8, 19, 9, 0, 0).toISOString();
    const plan: CampaignPlan = { ...defaultCampaignPlan(), timing: { mode: 'scheduled', at } };
    expect(scheduledAtIso(plan)).toBe(at);
    expect(startDate(plan).toISOString()).toBe(at);
  });

  it('expires_at is the start time plus the late window', () => {
    const at = new Date(2026, 8, 19, 9, 0, 0);
    const plan: CampaignPlan = { ...defaultCampaignPlan(), timing: { mode: 'scheduled', at: at.toISOString() }, expiresInMs: 3 * 3_600_000 };
    expect(expiresAtIso(plan)).toBe(new Date(at.getTime() + 3 * 3_600_000).toISOString());
  });

  it('"now" measures the late window from the instant passed in', () => {
    const now = new Date(2026, 8, 19, 9, 0, 0);
    const plan = defaultCampaignPlan();
    expect(expiresAtIso(plan, now)).toBe(new Date(now.getTime() + plan.expiresInMs).toISOString());
  });
});

describe('isValidIntervalMs', () => {
  it('accepts a positive value up to the 1h ceiling', () => {
    expect(isValidIntervalMs(10_000)).toBe(true);
    expect(isValidIntervalMs(3_600_000)).toBe(true);
  });

  it('rejects zero, negative, non-finite, or above the 1h ceiling', () => {
    expect(isValidIntervalMs(0)).toBe(false);
    expect(isValidIntervalMs(-1)).toBe(false);
    expect(isValidIntervalMs(NaN)).toBe(false);
    expect(isValidIntervalMs(3_600_001)).toBe(false);
  });
});

describe('formatScheduleSummary (§18.4 step 5 — the exact worked example)', () => {
  it('412 recipients · every 30 s (±25 %) · starts <day> 19 Sep 09:00 · finishes ≈ 12:26', () => {
    const start = new Date(2026, 8, 19, 9, 0, 0); // 19 Sep 2026, 09:00 local
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][start.getDay()];
    const plan: CampaignPlan = { timing: { mode: 'scheduled', at: start.toISOString() }, intervalMs: 30_000, jitterPct: 25, expiresInMs: 6 * 3_600_000 };
    const summary = formatScheduleSummary(plan, 412);
    expect(summary).toBe(`412 recipients · every 30 s (±25 %) · starts ${weekday} 19 Sep 09:00 · finishes ≈ 12:26`);
  });

  it('a single recipient produces no gaps: finishes at the start time', () => {
    const start = new Date(2026, 8, 19, 9, 0, 0);
    const plan: CampaignPlan = { timing: { mode: 'scheduled', at: start.toISOString() }, intervalMs: 30_000, jitterPct: 25, expiresInMs: 6 * 3_600_000 };
    expect(formatScheduleSummary(plan, 1)).toContain('finishes ≈ 09:00');
  });

  it('"send now" shows "starts now" rather than a specific clock time', () => {
    const plan = defaultCampaignPlan();
    const now = new Date(2026, 8, 19, 9, 0, 0);
    expect(formatScheduleSummary(plan, 5, now)).toContain('starts now');
  });

  it('singular "recipient" for a count of 1', () => {
    const plan = defaultCampaignPlan();
    expect(formatScheduleSummary(plan, 1, new Date())).toMatch(/^1 recipient ·/);
  });
});

describe('finishDate agrees with the pacing module’s own estimatedDurationMs', () => {
  it('matches the mean-gap arithmetic exactly', () => {
    const start = new Date(2026, 8, 19, 9, 0, 0);
    const plan: CampaignPlan = { timing: { mode: 'scheduled', at: start.toISOString() }, intervalMs: 30_000, jitterPct: 25, expiresInMs: 6 * 3_600_000 };
    const window = campaignWindow(30_000, 25);
    const meanGapMs = (window.minIntervalMs + window.maxIntervalMs) / 2;
    const expected = new Date(start.getTime() + Math.round(199 * meanGapMs));
    expect(finishDate(plan, 200).getTime()).toBe(expected.getTime());
  });
});

describe('isCampaignJob / formatJobSchedule', () => {
  it('a plain immediate send (all three columns null) is not a campaign', () => {
    const job = { scheduled_at: null, interval_ms: null, jitter_pct: 25, expires_at: null };
    expect(isCampaignJob(job)).toBe(false);
    expect(formatJobSchedule(job)).toBeNull();
  });

  it('a job with a schedule and pace describes both', () => {
    const at = new Date(2026, 8, 19, 9, 0, 0).toISOString();
    const expires = new Date(2026, 8, 19, 15, 0, 0).toISOString();
    const job = { scheduled_at: at, interval_ms: 30_000, jitter_pct: 25, expires_at: expires };
    expect(isCampaignJob(job)).toBe(true);
    const line = formatJobSchedule(job)!;
    expect(line).toContain('starts');
    expect(line).toContain('every 30 s (±25 %)');
    expect(line).toContain('expires');
  });

  it('a job queued to run "as soon as claimed" (scheduled_at null, pace set) says so', () => {
    const job = { scheduled_at: null, interval_ms: 60_000, jitter_pct: 10, expires_at: null };
    expect(formatJobSchedule(job)).toBe('starts as soon as claimed · every 60 s (±10 %)');
  });
});

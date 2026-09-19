// Pure pacing math (crmex.md §9.4). This is the canonical, unit-tested
// implementation. The embedded Node payload (android/nodejs-assets/nodejs-project/main.js)
// carries a plain-JS copy of `randomInterval` because that payload is an
// isolated package with no dependency on shared-ui (it must not pull in
// anything beyond Baileys — crmex.md §10.4). Keep the two in sync; a change
// here should be mirrored there.

export interface PacingWindow {
  minIntervalMs: number;
  maxIntervalMs: number;
}

export const DEFAULT_PACING_WINDOW: PacingWindow = {
  minIntervalMs: 7_000,
  maxIntervalMs: 18_000,
};

/** Inclusive-ish random interval in [min, max]. Injectable RNG for tests. */
export function randomInterval(window: PacingWindow, rng: () => number = Math.random): number {
  const { minIntervalMs, maxIntervalMs } = window;
  if (maxIntervalMs < minIntervalMs) {
    throw new Error('PacingWindow: maxIntervalMs must be >= minIntervalMs');
  }
  const span = maxIntervalMs - minIntervalMs;
  return Math.floor(minIntervalMs + rng() * (span + 1));
}

/** Generate the sequence of intervals for a batch of N sends (N-1 gaps). */
export function intervalsForBatch(n: number, window: PacingWindow, rng: () => number = Math.random): number[] {
  const count = Math.max(0, n - 1);
  return Array.from({ length: count }, () => randomInterval(window, rng));
}

/**
 * Campaign pacing (crmex.md §18.3.2). A campaign carries one base interval and
 * a jitter percentage rather than a min/max pair, because that is what a user
 * can reason about ("every 30 seconds"). It collapses onto the same
 * PacingWindow the Node payload already takes, so nothing downstream changes.
 *
 * Jitter is not decoration: perfectly regular gaps are what a bulk sender looks
 * like, and the run is going to a shared service (§9.4).
 */
export const CAMPAIGN_INTERVAL_PRESETS_MS = [10_000, 30_000, 60_000] as const;
export const DEFAULT_CAMPAIGN_INTERVAL_MS = 30_000;
export const DEFAULT_JITTER_PCT = 25;
export const MAX_CAMPAIGN_INTERVAL_MS = 3_600_000;

export function campaignWindow(intervalMs: number, jitterPct: number = DEFAULT_JITTER_PCT): PacingWindow {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('campaignWindow: intervalMs must be positive');
  }
  if (jitterPct < 0 || jitterPct > 50) {
    throw new Error('campaignWindow: jitterPct must be between 0 and 50');
  }
  const spread = Math.round(intervalMs * (jitterPct / 100));
  return { minIntervalMs: intervalMs - spread, maxIntervalMs: intervalMs + spread };
}

/**
 * The window a job actually runs at: its own pacing, or the firm default for a
 * job queued before §18 (interval_ms null).
 */
export function windowForJob(job: { interval_ms: number | null; jitter_pct: number }): PacingWindow {
  if (job.interval_ms === null) return DEFAULT_PACING_WINDOW;
  return campaignWindow(job.interval_ms, job.jitter_pct);
}

/**
 * Wall-clock estimate for N recipients, shown before confirming. 412 recipients
 * at 30s is 3h26m, and users do not compute that themselves (§18.4 step 5).
 */
export function estimatedDurationMs(recipientCount: number, window: PacingWindow): number {
  const gaps = Math.max(0, recipientCount - 1);
  return Math.round(gaps * ((window.minIntervalMs + window.maxIntervalMs) / 2));
}

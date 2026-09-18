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

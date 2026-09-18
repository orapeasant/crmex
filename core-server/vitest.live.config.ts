import { defineConfig } from 'vitest/config';

/**
 * The live suite (test/live) runs against a real Supabase project, so it is
 * kept out of the default `vitest run`: it needs credentials, it is slow, and
 * it writes to a shared database. Run it with `pnpm test:live`.
 *
 * Single-threaded on purpose — the cases share one fixture of firms and
 * accounts, and a few of them (TEN-20) temporarily change a membership.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/live/**/*.live.test.ts'],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});

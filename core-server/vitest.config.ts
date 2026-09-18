import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // test/live needs a real Supabase project; see vitest.live.config.ts.
    exclude: ['test/live/**'],
    globals: false,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});

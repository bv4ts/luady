import { defineConfig } from 'vitest/config';

// Deploy-script tests only: they need Docker but not the fake-fleet keys, images or the built hub.
export default defineConfig({
  test: {
    include: ['deploy/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
    reporters: ['default'],
  },
});

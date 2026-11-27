import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scenarios/**/*.test.ts', 'deploy/**/*.test.ts'],
    globalSetup: ['./harness/global-setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 300_000,
    reporters: ['default'],
  },
});

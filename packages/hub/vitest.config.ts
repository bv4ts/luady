import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@luady/shared/pure': fileURLToPath(new URL('../shared/src/pure/index.ts', import.meta.url)),
      '@luady/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Tests that start a shell or a real server need more than the default five seconds on a busy machine.
    testTimeout: 15_000,
    environment: 'node',
    // forks (not threads) so TZ below really applies, whatever zone the machine itself runs in.
    pool: 'forks',
    env: { TZ: 'UTC' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 70 },
    },
  },
});

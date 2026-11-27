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
    // On a busy machine or a small CI runner the default five seconds is too tight.
    testTimeout: 15_000,
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 70 },
    },
  },
});

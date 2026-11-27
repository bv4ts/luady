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
    environment: 'node',
    testTimeout: 10_000,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src'],
      exclude: ['src/examples/echo-main.ts'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 70 },
    },
  },
});

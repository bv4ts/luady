import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@luady/office', replacement: here('../office/src/index.ts') },
      { find: '@luady/shared/pure', replacement: here('../shared/src/pure/index.ts') },
      { find: '@luady/shared', replacement: here('../shared/src/index.ts') },
    ],
    dedupe: ['react', 'react-dom', 'zod'],
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['test/dist/**', 'node_modules/**'],
    setupFiles: ['test/setup.ts'],
    // Whole-page tests on a busy machine or a small CI runner: the default five seconds is too tight.
    testTimeout: 15_000,
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/stubs/**'],
      reporter: ['text', 'html'],
      thresholds: {
        'src/api/**': { lines: 80 },
        'src/state/**': { lines: 80 },
      },
    },
  },
});

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@luady/office', replacement: here('../office/src/index.ts') },
      // The longer id first: Vite's prefix match would turn the pure entry into a path below the main index file.
      { find: '@luady/shared/pure', replacement: here('../shared/src/pure/index.ts') },
      { find: '@luady/shared', replacement: here('../shared/src/index.ts') },
      // @luady/shared re-exports promptHash (hub only), which imports node:crypto.
      { find: 'node:crypto', replacement: here('./src/stubs/node-crypto.ts') },
    ],
    dedupe: ['react', 'react-dom', 'zod'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // CSP: no data: URIs for fonts/scripts, everything is a same-origin file.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7410',
      '/ws': { target: 'ws://127.0.0.1:7410', ws: true },
    },
  },
});

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Development demos (`npm run demo -w @luady/web`): the office scene (/), the whole office page against a pretend hub
 * (/office.html, add ?old=1 for an older hub) and the library and Jira pop-ups on fixtures (/drawers.html). Not part
 * of the site build.
 * `vite build --config vite.demo.config.ts` + `vite preview --config vite.demo.config.ts` serves it under the
 * site's Content-Security-Policy, to check PixiJS in a production bundle.
 */
const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

export default defineConfig({
  root: here('./demo'),
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@luady/office', replacement: here('../office/src/index.ts') },
      // The longer id first: Vite's prefix match would turn the pure entry into a path below the main index file.
      { find: '@luady/shared/pure', replacement: here('../shared/src/pure/index.ts') },
      { find: '@luady/shared', replacement: here('../shared/src/index.ts') },
      { find: 'node:crypto', replacement: here('./src/stubs/node-crypto.ts') },
    ],
    dedupe: ['react', 'react-dom', 'zod'],
  },
  server: { port: 5174, fs: { allow: [here('../..')] } },
  preview: { port: 5175, headers: { 'Content-Security-Policy': CSP } },
  build: {
    outDir: here('./demo/dist'), emptyOutDir: true, assetsInlineLimit: 0, modulePreload: { polyfill: false }, chunkSizeWarningLimit: 900,
    // Three pages: the scene alone, the whole office page against a pretend hub, and the library and Jira fixtures.
    rollupOptions: { input: { index: here('./demo/index.html'), office: here('./demo/office.html'), drawers: here('./demo/drawers.html') } },
  },
});

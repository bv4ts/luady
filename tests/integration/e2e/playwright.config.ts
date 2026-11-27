import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  // Each spec file runs in its own worker, so the worker-scoped hub fixture isolates per-spec state (a spec that
  // signs in and sets the PIN must not leak into another spec's first-visit flow).
  fullyParallel: false,
  // One worker on a CI runner (few cores, no graphics card: two canvases at once starve each other); two elsewhere.
  workers: process.env.CI ? 1 : 2,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  outputDir: '../.e2e-results',
  // LUADY_E2E_CHANNEL=chrome|msedge runs an installed browser when the Playwright download is blocked.
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', ignoreHTTPSErrors: true, channel: process.env.LUADY_E2E_CHANNEL || undefined },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

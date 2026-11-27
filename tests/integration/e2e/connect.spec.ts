import { test, expect } from '@playwright/test';
import { freePort, startTestHub, type TestHub } from '../harness/hub.js';
import { WEB_DIST } from '../harness/paths.js';
import { runEnvFromProcess } from '../harness/run-env.js';
import { addVirtualAuthenticator, claimOwner, OWNER_PIN, routeHttpsToHub } from './owner.js';

/**
 * Connecting Google from the website: with the PIN the hub makes a one-time link bound to this
 * sign-in; the browser goes to the provider and comes back to the hub's callback, which serves connect-return.html;
 * its script posts the code to `finish` with the cookie, the page key and the CSRF token. The provider's page and its
 * token endpoint are fakes: nothing leaves this machine.
 */

const CODE = 'fake-google-code-1';
const ACCOUNT = 'owner@example.invalid';

interface FakeGoogle { readonly exchanged: string[]; readonly refused: string[]; restore(): void }

/** The token endpoint and every other Google API, answered in this process (the in-process hub calls `fetch`). */
function fakeGoogleApis(): FakeGoogle {
  const real = globalThis.fetch;
  const exchanged: string[] = [];
  const refused: string[] = [];
  const idToken = ['e30', Buffer.from(JSON.stringify({ email: ACCOUNT })).toString('base64url'), 'sig'].join('.');
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (form.get('grant_type') === 'authorization_code') exchanged.push(form.get('code') ?? '');
      return Response.json({ refresh_token: 'fake-refresh', id_token: idToken, access_token: 'fake-access', expires_in: 3600 });
    }
    if (/^https:\/\/[a-z0-9.-]*google(apis)?\.com\//.test(url)) {
      refused.push(new URL(url).host);
      return Response.json({});
    }
    return real(input, init);
  }) as typeof fetch;
  return { exchanged, refused, restore: () => void (globalThis.fetch = real) };
}

/** The provider's consent page: "Allow" sends the browser back to the hub with a code and the hub's own state. */
function consentPage(authorizeUrl: string): string {
  const url = new URL(authorizeUrl);
  const back = new URL(url.searchParams.get('redirect_uri') ?? 'about:blank');
  back.searchParams.set('code', CODE);
  back.searchParams.set('state', url.searchParams.get('state') ?? '');
  return `<!doctype html><title>Fake Google</title><h1>Fake Google</h1><p>${url.searchParams.get('scope') ?? ''}</p><a href="${back.href}">Allow</a>`;
}

test('connect Google from Settings: PIN, the provider page, then back through connect-return.html', async ({ page }) => {
  const port = await freePort();
  const google = fakeGoogleApis();
  const hub: TestHub = await startTestHub({ env: runEnvFromProcess(), listenPort: port, webDir: WEB_DIST, google: true, setup: 'new' });
  const baseURL = `https://localhost:${port}`;
  try {
    await routeHttpsToHub(page, port);
    const authorize: string[] = [];
    await page.route('https://accounts.google.com/**', async (route) => {
      authorize.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: consentPage(route.request().url()) });
    });
    await addVirtualAuthenticator(page);
    await claimOwner(page, baseURL, hub.app.services.setupCodes.issue('owner_setup'));

    await test.step('Settings: Connect Google (personal) asks for the PIN, then opens the provider', async () => {
      await page.goto(`${baseURL}/settings`);
      const row = page.getByTestId('connect-services').locator('.channel-connect').filter({ hasText: 'Google (personal)' });
      await row.getByRole('button', { name: 'Connect' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('PIN').fill(OWNER_PIN);
      await dialog.getByLabel('PIN').press('Enter');
      await expect(page.getByRole('heading', { name: 'Fake Google' })).toBeVisible();
      const asked = new URL(authorize[0] ?? 'about:blank');
      expect(asked.searchParams.get('redirect_uri')).toBe(`${baseURL}/api/google/callback`);
      expect(asked.searchParams.get('state')).toMatch(/\S{16,}/);
    });

    await test.step('the provider sends the browser back; the return page finishes the connect', async () => {
      await page.getByRole('link', { name: 'Allow' }).click();
      await expect(page.getByRole('heading', { name: 'Connecting your account' })).toBeVisible();
      await expect(page.locator('#status')).toContainText('✅');
      // The code left the address bar at once (it is single use).
      expect(new URL(page.url()).search).toBe('');
      expect(google.exchanged).toEqual([CODE]);
      const accounts = hub.db.prepare('SELECT email, label FROM google_accounts').all();
      expect(accounts).toEqual([{ email: ACCOUNT, label: 'personal' }]);
    });

    await test.step('the same link cannot be used twice', async () => {
      await page.goBack();
      await page.goto(`${baseURL}/api/google/callback?code=${CODE}&state=${new URL(authorize[0] ?? 'about:blank').searchParams.get('state') ?? ''}`);
      await expect(page.locator('body')).toContainText(/expired or was already used|did not connect/);
      expect(google.exchanged).toEqual([CODE]);
    });
  } finally {
    google.restore();
    await hub.stop();
  }
});

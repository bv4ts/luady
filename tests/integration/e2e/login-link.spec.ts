import { test, expect } from '@playwright/test';
import { startHubMachine } from '../harness/hub-machine.js';
import { runEnvFromProcess } from '../harness/run-env.js';
import { finishWizard, OWNER_PIN } from './owner.js';

/**
 * The login link: `luady login` writes a one-time token straight into the database and prints
 * `<origin>/setup/login#<token>`. On an unclaimed hub it prints the setup code beside it; the link page signs this
 * machine's browser in at once (no PIN yet), the passkey is skipped (a link session on this computer may), the PIN is
 * set with the code, and the wizard leads to the office. A used link never works again. Once a PIN is set, a new link
 * asks for it. Behind a proxy (any forwarding header) the link is refused.
 */

const LINK_RE = /(http:\/\/localhost:\d+\/setup\/login#([A-Za-z0-9_-]+))/;
const CODE_RE = /Setup code: ([A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4})/;

test.describe.configure({ timeout: 300_000 });

test('luady login, skip the passkey, the PIN, the office; a used link is dead; a new link asks for the PIN; refused behind a proxy', async ({ page }) => {
  const machine = await startHubMachine(runEnvFromProcess());
  try {
    await machine.start();

    await test.step('unclaimed: the link and the setup code; the link signs in, skip the passkey, set the PIN, open the office', async () => {
      const printed = (await machine.cli(['login'])).stdout;
      const link = LINK_RE.exec(printed)?.[1] ?? '';
      const code = CODE_RE.exec(printed)?.[1] ?? '';
      expect(link.startsWith(machine.url)).toBe(true);
      expect(code).not.toBe('');
      await page.goto(link);
      await expect(page.getByTestId('setup-claim-linked')).toBeVisible();
      // The fragment was read, used once, and cleared from the address bar.
      expect(new URL(page.url()).hash).toBe('');
      await page.getByTestId('setup-skip-passkey').click();
      const pin = page.getByTestId('setup-pin');
      await expect(pin).toBeVisible();
      await pin.getByTestId('setup-code-input').fill(code);
      await pin.getByTestId('pin-new-input').fill(OWNER_PIN);
      await pin.getByTestId('pin-confirm-input').fill(OWNER_PIN);
      await pin.getByTestId('pin-save-button').click();
      await finishWizard(page);
      // The same link again, in a signed-out browser: a PIN is set now, so the page asks for it, then says the link is spent.
      await page.context().clearCookies();
      await page.evaluate(() => localStorage.clear());
      await page.goto(link);
      await page.getByTestId('login-link-pin').fill(OWNER_PIN);
      await page.getByTestId('login-link-button').click();
      await expect(page.getByTestId('login-link-page')).toContainText(/used|expired|no longer|not valid/i);
      await expect(page.getByTestId('agency-page')).toHaveCount(0);
    });

    await test.step('claimed: a new link asks for the PIN, then opens the office', async () => {
      const printed = (await machine.cli(['login'])).stdout;
      expect(printed).not.toMatch(CODE_RE);
      await page.context().clearCookies();
      // A link that differs only in its fragment would be a same-page navigation: load the page afresh.
      await page.goto('about:blank');
      await page.goto(LINK_RE.exec(printed)?.[1] ?? '');
      await page.getByTestId('login-link-pin').fill(OWNER_PIN);
      await page.getByTestId('login-link-button').click();
      await expect(page.getByTestId('agency-page').or(page.getByTestId('nav-inbox')).first()).toBeVisible();
    });

    await test.step('behind a proxy: a forwarding header refuses the link (from this machine, the right Host)', async () => {
      const token = LINK_RE.exec((await machine.cli(['login'])).stdout)?.[2] ?? '';
      const answer = await machine.execOk(
        `node -e "fetch('${machine.url}/api/setup/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },`
        + ` body: JSON.stringify({ token: '${token}', pin: '${OWNER_PIN}' }) }).then((r) => process.stdout.write(String(r.status)))"`,
      );
      expect(answer).toBe('403');
    });
  } finally {
    await machine.down();
  }
});

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { finishWizard } from './owner.js';

const PIN = '246813';
// cedar sits in the south-west room; the map order is [nw, ne, hq, sw, se], so cedar's room key is '4'. Try it first.
const ROOM_KEYS = ['4', '1', '2', '5', '3'];
const EDIT_PERM = '/perm Edit {"file_path":"/home/dev/projects/e2e/a.txt","old_string":"a","new_string":"b"}';

/**
 * Opens the e2e agent's panel on the office. The 3-D characters cannot be clicked by pixel in headless Chromium, so
 * this uses the name plates (HTML overlays): focus the agent's room with a number key, then click its plate.
 */
async function openAgentPanel(page: Page): Promise<void> {
  await expect(page.getByTestId('agency-page')).toBeVisible();
  // Wait until the scene is drawing and positioning plates: Luady's plate shows at any focus, so it proves the office
  // rendered (if WebGL were unavailable the office would have redirected to the classic inbox and this would fail).
  await expect(page.locator('[data-plate="manager"]')).toBeVisible({ timeout: 30_000 });
  const plate = page.locator('[data-plate="agent"]').first();
  for (const key of ROOM_KEYS) {
    if (await plate.isVisible().catch(() => false)) break;
    await page.keyboard.press(key);
    await plate.waitFor({ state: 'visible', timeout: 4_000 }).catch(() => undefined);
  }
  await expect(plate, 'the e2e agent should have a name plate once its room is focused').toBeVisible();
  await plate.click();
  await expect(page.getByTestId('current-step')).toBeVisible();
}

async function typeInSendBox(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('session-send-input');
  await expect(input).toBeEnabled({ timeout: 20_000 });
  await input.fill(text);
  await page.getByTestId('session-send-button').click();
}

test('agency office: steps, pause and resume, an edit preview, and the updates pill', async ({ page, e2e }) => {
  const { hub } = e2e;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });

  await test.step('sign in: setup code, passkey, PIN (as owner-journey does)', async () => {
    await page.goto(e2e.baseURL);
    await page.getByTestId('setup-code-input').fill(hub.app.services.setupCodes.issue('owner_setup'));
    await page.getByTestId('setup-passkey-button').click();
    await expect(page.getByTestId('pin-new-input')).toBeVisible();
    await page.getByTestId('pin-new-input').fill(PIN);
    await page.getByTestId('pin-confirm-input').fill(PIN);
    await page.getByTestId('pin-save-button').click();
    await finishWizard(page);
  });

  await test.step('open the office and the agent view', async () => {
    await page.goto(e2e.baseURL);
    await openAgentPanel(page);
    await expect(page.getByTestId('updates-pill')).toContainText('Updates: here');
  });

  await test.step('a run shows a step in progress', async () => {
    await typeInSendBox(page, '/steps 8');
    await expect(page.getByTestId('current-step')).toContainText(/echo step-/, { timeout: 20_000 });
  });

  await test.step('pause stops the run and disables the send box', async () => {
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByTestId('current-step')).toContainText('Paused', { timeout: 15_000 });
    await expect(page.getByTestId('session-send-input')).toBeDisabled();
  });

  await test.step('resume lets it work again', async () => {
    await page.getByRole('button', { name: 'Resume' }).click();
    // The kit types the recovery line into the pane; wait until that turn is recorded before sending anything else,
    // so there is only ever one writer on the tmux pane.
    await expect(page.getByText(/lifted the pause/i).first()).toBeVisible({ timeout: 25_000 });
    await typeInSendBox(page, '/steps 4');
    await expect(page.getByTestId('current-step')).toContainText(/echo step-/, { timeout: 20_000 });
    await expect(page.getByTestId('current-step')).toContainText('Idle', { timeout: 20_000 });
  });

  await test.step('an edit permission shows a diff and can be allowed', async () => {
    await typeInSendBox(page, EDIT_PERM);
    const preview = page.getByTestId('approval-preview');
    await expect(preview).toBeVisible({ timeout: 20_000 });
    await expect(preview.locator('del')).toHaveText('a');
    await expect(preview.locator('ins')).toHaveText('b');
    await page.getByTestId('approval-allow').click();
    await expect(preview).toHaveCount(0, { timeout: 20_000 });
  });
});

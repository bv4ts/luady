import { test, expect } from '@playwright/test';
import { SELF_HOST_ID } from '@luady/shared';
import { startHubMachine, type HubMachine } from '../harness/hub-machine.js';
import { runEnvFromProcess } from '../harness/run-env.js';
import { waitFor } from '../harness/wait.js';
import { addVirtualAuthenticator, claimOwner } from './owner.js';

/**
 * The manager end to end on a real Linux hub machine started with `luady start`: off on a new
 * install; switched on from Settings, its bootstrap runs for real (folders, brain, rendered settings, token, its own kit
 * under managerHome with alias `hq`, folder trust) and it starts under its own HOME and tmux server; a message from the
 * website gets an answer. Its Claude Code is the fake one at the default claudePath, which echoes every message.
 */

const MANAGER_HOME = '/home/owner/.local/share/luady/data/manager-home';
const MESSAGE = 'Hello from the e2e test';

interface ManagerStatus { switch: string; state: string; bootstrap: { state: string; kit: { path: string; version: string | null; alias: string | null } } }
const managerOf = async (machine: HubMachine): Promise<ManagerStatus> => (await machine.status()).manager as ManagerStatus;

test.describe.configure({ timeout: 900_000 });

test('the manager: off on a new install; switched on it sets itself up, runs, and answers the website', async ({ page }) => {
  const machine = await startHubMachine(runEnvFromProcess());
  try {
    await test.step('a new install: luady start prints a setup code; the manager is off', async () => {
      await machine.start();
      expect(await machine.log()).toContain(`Luady is running: open ${machine.url} in your browser.`);
      expect(await managerOf(machine)).toMatchObject({ switch: 'off', state: 'off', bootstrap: { state: 'idle' } });
    });

    await test.step('claim with the code and a passkey, then the PIN', async () => {
      await addVirtualAuthenticator(page);
      await claimOwner(page, machine.url, await machine.setupCode());
    });

    await test.step('switch the manager on in Settings: its bootstrap runs, then it is on', async () => {
      await page.goto(`${machine.url}/settings`);
      const manager = page.getByTestId('manager-switch');
      await expect(manager).toHaveAttribute('data-state', 'off');
      await expect(manager.getByRole('switch')).not.toBeChecked();
      // The switch follows the hub: it turns on once the hub has the setting (a click, not an instant change).
      await manager.getByRole('switch').click();
      await expect(manager.getByRole('switch')).toBeChecked();
      await expect(manager).toHaveAttribute('data-state', 'on', { timeout: 300_000 });
      await expect(manager.getByRole('button', { name: 'Sign the manager in to Claude' })).toBeVisible();
    });

    await test.step('the status route: running within seconds, with the self host\'s own kit under managerHome and alias hq', async () => {
      // Its first session start reaches the hub at once (the supervisor's own one-minute fallback is never needed).
      const status = await waitFor(async () => {
        const now = await managerOf(machine);
        return now.state === 'running' ? now : undefined;
      }, { timeoutMs: 15_000, intervalMs: 500, what: 'the manager running' });
      expect(status.switch).toBe('on');
      expect(status.bootstrap.state).toBe('done');
      expect(status.bootstrap.kit).toMatchObject({ path: `${MANAGER_HOME}/.luady/bin/luady-ctl`, alias: SELF_HOST_ID, version: expect.any(String) });
      // That luady-ctl answers with the manager's HOME and its own tmux folder.
      const version = JSON.parse(await machine.execOk(
        `HOME=${MANAGER_HOME} TMUX_TMPDIR=${MANAGER_HOME}/tmux ${MANAGER_HOME}/.luady/bin/luady-ctl version`,
      )) as { kit?: string };
      expect(version.kit).toBe(status.bootstrap.kit.version);
      // It runs on its own tmux server, never the user's default one.
      await machine.execOk(`TMUX_TMPDIR=${MANAGER_HOME}/tmux tmux has-session -t manager`);
      expect((await machine.exec('tmux has-session -t manager 2>/dev/null')).code).not.toBe(0);
    });

    await test.step('a message from the website gets an answer', async () => {
      await page.goto(machine.url);
      const chat = page.getByRole('region', { name: /^Chat with/ });
      await chat.getByRole('textbox').fill(MESSAGE);
      await chat.getByRole('button', { name: /^Send to/ }).click();
      const show = chat.getByRole('button', { name: 'Show the conversation' });
      if (await show.isVisible().catch(() => false)) await show.click();
      await expect(page.getByText(new RegExp(`Echo \\(\\d+ chars\\): .*${MESSAGE}`)).first()).toBeVisible({ timeout: 120_000 });
    });
  } finally {
    await machine.down();
  }
});

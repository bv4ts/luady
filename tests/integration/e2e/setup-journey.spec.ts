import { test, expect, type Page } from '@playwright/test';
import { startHubMachine, type HubMachine } from '../harness/hub-machine.js';
import { runEnvFromProcess } from '../harness/run-env.js';
import { waitFor } from '../harness/wait.js';
import { addVirtualAuthenticator, answerPin, OWNER_PIN, pageApi } from './owner.js';

/**
 * The first run, end to end: a fresh data folder and `luady start`
 * on a Linux hub machine; claim with the printed code and a passkey; the PIN; "Add this computer", letting the page
 * create the projects folder; "Add a server" on a second container (`bare-server`, user dev): paste the key line there,
 * compare the host key with `ssh-keygen -lf` run on it, check, install the kit, name the room; extras with the manager
 * left unticked; open the office. Then stop the hub, start it, and sign in again with the passkey: both rooms are back.
 */

const SERVER = 'bare-server';
const SERVER_ID = 'birch';

/** A shell line on the bare server as its user `dev` (the owner typing in their own terminal there). */
const onServer = (machine: HubMachine, script: string): Promise<string> => machine.onServer(SERVER, script);

async function roomsOnMap(page: Page): Promise<string[]> {
  return page.locator('[data-testid="room-plaque"]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-room') ?? ''));
}

test.describe.configure({ timeout: 900_000 });

test('first run: luady start, claim, PIN, this computer, a server, the office; restart and sign in again', async ({ page }) => {
  const machine = await startHubMachine(runEnvFromProcess(), { servers: [SERVER] });
  try {
    await test.step('a fresh data folder: luady start prints the code', async () => {
      await machine.start();
      const log = await machine.log();
      expect(log).toContain('Luady is running: open');
      expect(log).toMatch(/Setup code: [A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}/);
    });

    await test.step('claim with the code and a passkey, then the PIN', async () => {
      await addVirtualAuthenticator(page);
      await page.goto(machine.url);
      // A signed-out visitor of an unclaimed hub gets the claim page at any address.
      await expect(page.getByTestId('setup-claim')).toBeVisible();
      await page.getByTestId('setup-code-input').fill(await machine.setupCode());
      await page.getByTestId('setup-passkey-button').click();
      await expect(page.getByTestId('setup-pin')).toBeVisible();
      await page.getByTestId('pin-new-input').fill(OWNER_PIN);
      await page.getByTestId('pin-confirm-input').fill(OWNER_PIN);
      await page.getByTestId('pin-save-button').click();
      await expect(page.getByTestId('setup-rooms')).toBeVisible();
    });

    await test.step('Add this computer: the page creates ~/projects', async () => {
      expect((await machine.exec('test -d "$HOME/projects"')).code).not.toBe(0);
      await page.getByTestId('setup-add-computer').click();
      const form = page.getByTestId('setup-computer-panel').getByTestId('local-host-form');
      await expect(form.getByLabel('Projects folder')).toHaveValue('~/projects');
      await expect(form.getByLabel(/Create it if missing/)).toBeChecked();
      await form.getByRole('button', { name: 'Save and go on' }).click();
      await answerPin(page);
      await waitFor(async () => ((await machine.exec('test -d "$HOME/projects"')).code === 0 ? true : undefined), { what: 'the projects folder' });
      await form.getByRole('button', { name: 'Check now' }).click();
      await form.getByRole('button', { name: /^Go on/ }).first().click();
      await form.getByRole('button', { name: 'Install the kit' }).click();
      await form.getByRole('button', { name: 'Go on', exact: true }).click({ timeout: 180_000 });
      await form.getByTestId('room-editor').getByLabel('Name', { exact: true }).fill('Private Projects');
      await form.getByRole('button', { name: 'Add the room' }).click();
      await expect(page.getByTestId('setup-rooms')).toContainText('This computer is added.');
    });

    await test.step('Add a server: paste the line, compare the host key, check, install the kit, name the room', async () => {
      await page.getByTestId('setup-add-server').click();
      const flow = page.getByTestId('setup-server-panel').getByTestId('add-server-flow');
      const details = flow.getByTestId('host-step-details');
      await details.getByLabel('Address').fill(SERVER);
      await details.getByLabel('Name').fill(SERVER_ID);
      await details.getByLabel('User').fill('dev');
      await flow.getByRole('button', { name: 'Save and go on' }).click();
      await answerPin(page);
      // The owner pastes the page's one line into a terminal on the server.
      const paste = (await flow.getByTestId('host-paste-line').textContent())?.trim() ?? '';
      expect(paste).toContain('luady-fleet');
      await onServer(machine, paste);
      await flow.getByRole('button', { name: 'I have pasted it' }).click();
      await flow.getByRole('button', { name: 'Test the connection' }).click();
      const shown = (await flow.getByTestId('host-fingerprint').textContent())?.trim() ?? '';
      await expect(flow.getByTestId('host-compare')).toHaveText('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
      const real = (await onServer(machine, 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')).split(/\s+/)[1];
      expect(shown).toBe(real);
      await flow.getByLabel('It matches').check();
      await flow.getByRole('button', { name: 'Trust this server' }).click();
      await flow.getByRole('button', { name: 'Check now' }).click();
      await expect(flow.getByTestId('host-check-result')).toBeVisible({ timeout: 60_000 });
      await flow.getByRole('button', { name: 'Go on', exact: true }).click();
      await flow.getByRole('button', { name: 'Install the kit' }).click();
      await flow.getByRole('button', { name: 'Go on', exact: true }).click({ timeout: 180_000 });
      await flow.getByTestId('room-editor').getByLabel('Name', { exact: true }).fill('Orchard');
      await flow.getByRole('button', { name: 'Add the room' }).click();
      await onServer(machine, 'test -x ~/.luady/bin/luady-ctl && grep -q luady_hook ~/.claude/settings.json');
      await expect(page.getByTestId('setup-rooms')).toContainText(`${SERVER_ID} is added.`);
    });

    await test.step('the rooms, then connect: both machines have their kit', async () => {
      await page.getByTestId('setup-rooms').getByTestId('rooms-step').getByRole('button', { name: 'Next' }).click();
      const connect = page.getByTestId('setup-connect');
      await expect(connect).toBeVisible();
      await expect(connect.getByTestId('setup-bypass-warning')).toBeVisible();
      await connect.getByTestId('setup-next').click();
    });

    await test.step('extras with the manager left unticked; open the office', async () => {
      const extras = page.getByTestId('setup-extras');
      await expect(extras).toBeVisible();
      const manager = extras.getByTestId('manager-switch');
      await expect(manager.getByRole('switch')).not.toBeChecked();
      await extras.getByTestId('setup-next').click();
      await expect(page.getByTestId('setup-open')).toBeVisible();
      await page.getByTestId('setup-finish').click();
      await expect(page.getByTestId('agency-page')).toBeVisible();
      // Both rooms are on the map (beside HQ's own plaque).
      const rooms = ((await pageApi(page, 'GET', '/api/rooms')).body as { items: Array<{ id: string }> }).items.map((room) => room.id);
      expect(rooms).toHaveLength(2);
      await expect.poll(async () => {
        const onMap = await roomsOnMap(page);
        return rooms.every((id) => onMap.includes(id));
      }).toBe(true);
    });

    await test.step('a session in the server room shows its creature', async () => {
      await onServer(machine, "mkdir -p /home/dev/projects/first && tmux new-session -d -s cc-first -c /home/dev/projects/first -- /home/dev/.local/bin/claude --permission-mode bypassPermissions");
      // A new folder: Claude Code asks whether to trust it first ("No, exit" preselected); the owner picks "Yes, proceed".
      await waitFor(async () => ((await onServer(machine, 'tmux capture-pane -p -t cc-first')).includes('Do you trust the files') ? true : undefined), { what: 'the trust dialog' });
      await onServer(machine, 'tmux send-keys -t cc-first Up && tmux send-keys -t cc-first Enter');
      try {
        // The room's chip counts it; with the room in focus its creature has its name plate.
        const chip = page.getByRole('button', { name: /^Orchard, 1 session/ });
        await expect(chip).toBeVisible({ timeout: 60_000 });
        await chip.click();
        await expect(page.locator('[data-plate="agent"]').first()).toBeVisible();
      } catch (err) {
        // What each side saw, for the report: the hub's log, the server's spool and fake claude's log, the hub's sessions.
        const sessions = await pageApi(page, 'GET', '/api/sessions');
        const spool = await onServer(machine, 'ls -la ~/.luady/spool 2>&1; tail -n 5 ~/.luady/spool/*.jsonl 2>&1; tail -n 5 ~/.fake-claude/log.jsonl 2>&1; cat ~/.claude/settings.json 2>&1 | head -c 1500');
        await test.info().attach('diagnostics', {
          contentType: 'text/plain',
          body: `hub log:\n${(await machine.log()).split('\n').slice(-60).join('\n')}\n\nserver:\n${spool}\n\nsessions: ${JSON.stringify(sessions.body).slice(0, 2000)}`,
        });
        throw err;
      }
    });

    await test.step('stop the hub, start it: both rooms come back; sign in again with the passkey', async () => {
      const before = (await pageApi(page, 'GET', '/api/rooms')).body as { items: Array<{ id: string }> };
      await machine.stop();
      await machine.start();
      // A session survives a restart; sign this browser out so the passkey sign-in is what is tested.
      await page.context().clearCookies();
      await page.evaluate(() => localStorage.clear());
      await page.goto(machine.url);
      await page.getByTestId('login-passkey-button').click();
      await expect(page.getByTestId('agency-page')).toBeVisible();
      const after = (await pageApi(page, 'GET', '/api/rooms')).body as { items: Array<{ id: string }> };
      expect(after.items.map((r) => r.id)).toEqual(before.items.map((r) => r.id));
      expect(after.items).toHaveLength(2);
    });
  } finally {
    await machine.down();
  }
});

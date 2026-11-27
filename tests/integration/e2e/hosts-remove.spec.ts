import { test, expect, type Page } from '@playwright/test';
import { HOST_GRANT_HEADER } from '@luady/shared';
import { startHubMachine, type HubMachine } from '../harness/hub-machine.js';
import { runEnvFromProcess } from '../harness/run-env.js';
import { addVirtualAuthenticator, answerPin, claimOwner, OWNER_PIN, pageApi } from './owner.js';

/**
 * Removing a server on a Linux hub machine with a real
 * SSH server beside it. The server is added through the hosts API (as the add-server flow does: draft with the PIN,
 * the key line pasted there, scan, pin, check, kit), gets a room and a session, and is then removed from Settings with
 * the defaults: the kit uninstalled, the key line removed, the room kept. Afterwards its authorized_keys has no
 * fleet-key line, its Claude settings have no kit hook, its row is a tombstone (gone from the list, its id never taken
 * again), its history is kept, and the kept room reads `hostState: 'removed'`.
 */

const SERVER = 'bare-server';
const ID = 'ash';
const BLOB_RE = /ssh-ed25519 (\S+) luady-fleet/;
const HUB_DB = '/home/owner/.local/share/luady/data/hub.db';

async function api<T>(page: Page, method: string, path: string, body?: unknown, grant?: string): Promise<T> {
  const answer = await pageApi(page, method, path, body, grant === undefined ? {} : { [HOST_GRANT_HEADER]: grant });
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body as T;
}

/** One value from the hub's database, read inside the hub machine (read-only). */
async function sql(machine: HubMachine, query: string, arg: string): Promise<string> {
  return machine.execOk(`node -e "const db = require('better-sqlite3')('${HUB_DB}', { readonly: true });`
    + ` process.stdout.write(String(Object.values(db.prepare(\\"${query}\\").get('${arg}') ?? { none: 'none' })[0]))"`);
}

/** The add-server flow through its API; returns the fleet key's blob as it went into authorized_keys. */
async function addServer(page: Page, machine: HubMachine): Promise<string> {
  const { grant } = await api<{ grant: string }>(page, 'POST', '/api/hosts', { id: ID, host: SERVER, user: 'dev', port: 22, pin: OWNER_PIN });
  const { line } = await api<{ line: string }>(page, 'GET', '/api/hosts/key');
  await machine.onServer(SERVER, `umask 077 && mkdir -p ~/.ssh && printf '\\n%s\\n' ${JSON.stringify(line)} >> ~/.ssh/authorized_keys`);
  const { fingerprint } = await api<{ fingerprint: string }>(page, 'POST', `/api/hosts/${ID}/scan`, {}, grant);
  expect(fingerprint).toBe((await machine.onServer(SERVER, 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')).split(/\s+/)[1]);
  await api(page, 'POST', `/api/hosts/${ID}/pin`, { fingerprint }, grant);
  expect(await api(page, 'POST', `/api/hosts/${ID}/check`, {}, grant)).toMatchObject({ auth: 'ok' });
  await api(page, 'POST', `/api/hosts/${ID}/kit`, { mode: 'install' }, grant);
  await expect.poll(async () => (await api<{ state: string }>(page, 'GET', `/api/hosts/${ID}/job`)).state, { timeout: 180_000 }).toBe('done');
  await api(page, 'POST', '/api/rooms', { name: 'Harbor', kind: 'server', host: ID });
  return BLOB_RE.exec(line)?.[1] ?? '';
}

test.describe.configure({ timeout: 900_000 });

test('remove a server: the kit is uninstalled, the key line is gone, history is kept, the room is kept dark', async ({ page }) => {
  const machine = await startHubMachine(runEnvFromProcess(), { servers: [SERVER] });
  try {
    await machine.start();
    await addVirtualAuthenticator(page);
    await claimOwner(page, machine.url, await machine.setupCode());
    const blob = await addServer(page, machine);
    expect(blob).not.toBe('');
    await machine.onServer(SERVER, `grep -qF ${JSON.stringify(blob)} ~/.ssh/authorized_keys && grep -q '/.luady/hooks/' ~/.claude/settings.json`);

    await test.step('a session there leaves history behind', async () => {
      await machine.onServer(SERVER, 'mkdir -p ~/projects/harbor && tmux new-session -d -s cc-history -c ~/projects/harbor -- ~/.local/bin/claude --permission-mode bypassPermissions');
      await expect.poll(async () => (await api<{ sessions: Array<{ host: string }> }>(page, 'GET', '/api/overview')).sessions.some((s) => s.host === ID),
        { timeout: 90_000 }).toBe(true);
    });

    await test.step('Settings → Servers → Remove, with the defaults: kit and key removed, the room kept', async () => {
      await page.goto(`${machine.url}/settings`);
      await page.getByTestId(`host-row-${ID}`).getByRole('button', { name: 'Remove', exact: true }).click();
      const dialog = page.getByTestId('host-remove-dialog');
      await expect(dialog.getByLabel(/Remove the kit from/)).toBeChecked();
      await expect(dialog.getByLabel(/Remove the hub's key line from/)).toBeChecked();
      await expect(dialog.getByLabel(/Keep them/)).toBeChecked();
      await page.getByRole('button', { name: `Remove ${ID}` }).click();
      await answerPin(page);
      const result = page.getByTestId('host-remove-result');
      await expect(result).toBeVisible({ timeout: 120_000 });
      await expect(result).toContainText('Kit: ');
      await expect(result).toContainText('Rooms: kept');
    });

    await test.step('on the server: no fleet-key line, no kit hook in its Claude settings', async () => {
      expect(await machine.onServer(SERVER, 'cat ~/.ssh/authorized_keys')).not.toContain(blob);
      expect(await machine.onServer(SERVER, 'cat ~/.claude/settings.json')).not.toContain('/.luady/hooks/');
    });

    await test.step('on the hub: a tombstone, history kept, the room kept dark, the id never taken again', async () => {
      const listed = await api<Array<{ id: string }>>(page, 'GET', '/api/hosts');
      expect(listed.map((h) => h.id)).not.toContain(ID);
      expect(await sql(machine, 'SELECT state FROM servers WHERE name = ?', ID)).toBe('removed');
      expect(Number(await sql(machine, 'SELECT COUNT(*) AS n FROM sessions WHERE host = ?', ID))).toBeGreaterThan(0);
      const rooms = await api<{ items: Array<{ host: string | null; hostState: string }> }>(page, 'GET', '/api/rooms');
      expect(rooms.items.find((r) => r.host === ID)?.hostState).toBe('removed');
      const again = await pageApi(page, 'POST', '/api/hosts', { id: ID, host: SERVER, user: 'dev', port: 22, pin: OWNER_PIN });
      expect(again.status).toBe(409);
    });
  } finally {
    await machine.down();
  }
});

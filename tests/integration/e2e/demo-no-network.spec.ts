import childProcess from 'node:child_process';
import dns from 'node:dns';
import { createRequire } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { freePort } from '../harness/hub.js';
import { REPO_ROOT } from '../harness/paths.js';
import { answerPin, pageApi } from './owner.js';

const PREVIEW_PIN = '123456';

/**
 * Demo mode fakes everything: the preview — the demo's engine — runs the real hub and website in
 * this process, and while it starts, signs a browser in and runs the office, and while the owner adds a server and this
 * computer, nothing opens a socket to anywhere, resolves a name, or starts a process. Spies on the ways out record
 * every call; the browser's own connections come from the browser's process, not this one.
 */

interface PreviewHandle {
  readonly url: string;
  readonly ready: Promise<void>;
  loginUrl(): string;
  stop(): Promise<void>;
}
interface PreviewModule { startPreview(opts: { port?: number; env?: NodeJS.ProcessEnv; logLevel?: string }): Promise<PreviewHandle> }

const hubRequire = createRequire(join(REPO_ROOT, 'packages', 'hub', 'package.json'));
const ssh2 = hubRequire('ssh2') as { Client: { prototype: { connect: (...args: unknown[]) => unknown } } };

interface Calls { readonly connect: string[]; readonly ssh: number; readonly spawn: string[]; readonly lookup: string[] }

/** Wraps each way out so it records the call (and still behaves, so a failure shows as a count, not a crash). */
function spyOnTheOutside(): { calls: Calls; restore(): void } {
  const calls: Calls = { connect: [], ssh: 0, spawn: [], lookup: [] };
  const socketConnect = net.Socket.prototype.connect;
  const sshConnect = ssh2.Client.prototype.connect;
  const spawn = childProcess.spawn;
  const lookup = dns.lookup;
  net.Socket.prototype.connect = function connect(this: net.Socket, ...args: unknown[]) {
    calls.connect.push(JSON.stringify(args[0] ?? null).slice(0, 200));
    return (socketConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof socketConnect;
  ssh2.Client.prototype.connect = function connect(this: unknown, ...args: unknown[]) {
    (calls as { ssh: number }).ssh += 1;
    return sshConnect.apply(this, args);
  };
  childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
    calls.spawn.push(String(args[0]));
    return spawn(...args);
  }) as typeof spawn;
  dns.lookup = ((...args: Parameters<typeof lookup>) => {
    calls.lookup.push(String(args[0]));
    return (lookup as (...a: unknown[]) => void)(...args);
  }) as typeof lookup;
  return {
    calls,
    restore() {
      net.Socket.prototype.connect = socketConnect;
      ssh2.Client.prototype.connect = sshConnect;
      childProcess.spawn = spawn;
      dns.lookup = lookup;
    },
  };
}

async function startPreview(): Promise<PreviewHandle> {
  const mod = (await import(pathToFileURL(join(REPO_ROOT, 'preview', 'main.ts')).href)) as PreviewModule;
  return mod.startPreview({ port: await freePort(), env: {}, logLevel: 'silent' });
}

async function openOffice(page: Page, preview: PreviewHandle): Promise<void> {
  await page.goto(preview.loginUrl());
  await expect(page.getByTestId('agency-page')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-plate="manager"]')).toBeVisible({ timeout: 30_000 });
}

/** A scenario run from the page (the browser's connection, not this process's). */
async function drive(page: Page, scenario: string, args: readonly string[]): Promise<void> {
  const status = await page.evaluate(async (body) => (await fetch('/__preview/run', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).status, { scenario, args });
  expect(status, scenario).toBe(200);
}

const expectNothingLeft = (calls: Calls): void => {
  expect(calls.connect, 'net.Socket.prototype.connect').toEqual([]);
  expect(calls.ssh, 'ssh2.Client.prototype.connect').toBe(0);
  expect(calls.spawn, 'child_process.spawn').toEqual([]);
  // Listening on an address or on `localhost` passes it through dns.lookup without asking a resolver; any other name
  // would be the network.
  expect(calls.lookup.filter((name) => name !== 'localhost' && net.isIP(name) === 0), 'dns.lookup').toEqual([]);
};

test('the demo starts, signs in and runs the office without a socket, a name lookup or a process', async ({ page }) => {
  // The browser is already up (the page fixture launched it); from here on every way out of this process is watched.
  const spies = spyOnTheOutside();
  let preview: PreviewHandle | null = null;
  try {
    preview = await startPreview();
    await preview.ready;
    await openOffice(page, preview);
    await drive(page, 'work', ['cedar/meadow-vat']);
    await drive(page, 'ask', ['cedar/meadow-vat']);
    await expect(page.getByTestId('agency-page')).toBeVisible();
    const rooms = await pageApi(page, 'GET', '/api/rooms');
    expect((rooms.body as { items: unknown[] }).items).toHaveLength(4);
    expectNothingLeft(spies.calls);
  } finally {
    await preview?.stop();
    spies.restore();
  }
});

/** The preview, signed in, on Settings, with every way out of this process watched from before it starts. */
async function onSettings(page: Page, run: (preview: PreviewHandle) => Promise<void>): Promise<void> {
  const spies = spyOnTheOutside();
  let preview: PreviewHandle | null = null;
  try {
    preview = await startPreview();
    await preview.ready;
    await openOffice(page, preview);
    await page.goto(`${preview.url}/settings`);
    await run(preview);
    expectNothingLeft(spies.calls);
  } finally {
    await preview?.stop();
    spies.restore();
  }
}

test('the add-server flow in the demo touches no socket and starts no process', async ({ page }) => {
  await onSettings(page, async () => {
    const hosts = page.getByTestId('hosts-section');
    await hosts.getByRole('button', { name: 'Add a server' }).click();
    const flow = page.getByTestId('add-server-flow');
    const details = flow.getByTestId('host-step-details');
    await details.getByLabel('Address').fill('elm.example.invalid');
    await expect(details.getByLabel('Name')).toHaveValue('elm');
    await details.getByLabel('User').fill('dev');
    await flow.getByRole('button', { name: 'Save and go on' }).click();
    await answerPin(page, PREVIEW_PIN);
    await expect(flow.getByTestId('host-paste-line')).toContainText('luady-fleet');
    await flow.getByRole('button', { name: 'I have pasted it' }).click();
    await flow.getByRole('button', { name: 'Test the connection' }).click();
    await expect(flow.getByTestId('host-fingerprint')).toHaveText(/^SHA256:[A-Za-z0-9+/]{43}$/);
    await expect(flow.getByTestId('host-compare')).toHaveText('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
    await flow.getByLabel('It matches').check();
    await flow.getByRole('button', { name: 'Trust this server' }).click();
    await flow.getByRole('button', { name: 'Check now' }).click();
    await expect(flow.getByTestId('host-check-result')).toBeVisible();
    await flow.getByRole('button', { name: 'Go on', exact: true }).click();
    await flow.getByRole('button', { name: 'Install the kit' }).click();
    await flow.getByRole('button', { name: 'Go on', exact: true }).click();
    await flow.getByTestId('room-editor').getByLabel('Name', { exact: true }).fill('Elm Street');
    await flow.getByRole('button', { name: 'Add the room' }).click();
    await expect(flow).toHaveCount(0);
    await expect(page.getByTestId('host-row-elm')).toBeVisible();
    const listed = (await pageApi(page, 'GET', '/api/hosts')).body as Array<{ id: string; state: string; link: string | null; kitAlias: string | null }>;
    expect(listed.find((h) => h.id === 'elm')).toMatchObject({ state: 'pinned', link: 'online', kitAlias: 'elm' });
    const rooms = (await pageApi(page, 'GET', '/api/rooms')).body as { items: Array<{ name: string; host: string | null }> };
    expect(rooms.items.find((r) => r.host === 'elm')?.name).toBe('Elm Street');
  });
});

test('this computer\'s kit in the demo touches no socket and starts no process', async ({ page }) => {
  await onSettings(page, async () => {
    const hosts = page.getByTestId('hosts-section');
    await hosts.getByRole('button', { name: 'Add this computer' }).click();
    const local = page.getByTestId('local-host-form');
    await expect(local.getByLabel('Projects folder')).toHaveValue('~/projects');
    await expect(local.getByLabel(/Create it if missing/)).toBeChecked();
    await local.getByRole('button', { name: 'Save and go on' }).click();
    await answerPin(page, PREVIEW_PIN);
    await local.getByRole('button', { name: 'Check now' }).click();
    await local.getByRole('button', { name: 'Go on', exact: true }).click();
    await local.getByRole('button', { name: 'Install the kit' }).click();
    await local.getByRole('button', { name: 'Go on', exact: true }).click();
    await local.getByTestId('room-editor').getByLabel('Name', { exact: true }).fill('Home desk');
    await local.getByRole('button', { name: 'Add the room' }).click();
    await expect(local).toHaveCount(0);
    await expect(page.getByTestId('host-row-computer')).toBeVisible();
    const listed = (await pageApi(page, 'GET', '/api/hosts')).body as Array<{ id: string; state: string; kitAlias: string | null }>;
    expect(listed.find((h) => h.id === 'computer')).toMatchObject({ state: 'pinned', kitAlias: 'computer' });
  });
});

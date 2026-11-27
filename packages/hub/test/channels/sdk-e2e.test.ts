import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEchoAddon, type EchoAddon } from '../../../addon-sdk/src/examples/echo.js';
import type { App } from '../../src/app.js';
import { helpText } from '../../src/notify/format.js';
import { WIRING_TOKEN, startWiring, switchManagerOn, wiringConfig, type WiringRun } from '../wire/wiring-harness.js';

/**
 * End-to-end check: the SDK's echo example connects to a hub started here, registers, receives a message
 * and sends one, and offers its tool to the manager; a second add-on with a wrong token is refused.
 */
const OWNER = '447700900001';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
/** Real sockets on a busy machine: give each round trip room. */
const WAIT = { timeout: 10_000, interval: 50 };

let running: App | null = null;
const addons: EchoAddon[] = [];

afterEach(async () => {
  for (const addon of addons.splice(0)) await addon.stop();
  await running?.stop();
  running = null;
});

async function hubWithEcho() {
  const config = wiringConfig({
    addons: [{ id: 'echo', kind: 'channel', name: 'Echo (terminal)', owner: OWNER, primary: true }, { id: 'spare', kind: 'tools', name: 'Spare' }],
  });
  const run = await startWiring({}, config, false);
  running = run.app;
  // The harness stubs listen (it would bind a Unix socket); this test talks over TCP like the SDK's stand-in.
  vi.mocked(run.app.internal.listen).mockRestore();
  await run.app.internal.listen({ host: '127.0.0.1', port: 0 });
  const { port } = run.app.internal.server.address() as AddressInfo;
  const token = (id: string): string => readFileSync(join(config.dataDir, 'addons', `${id}.token`), 'utf8').trim();
  const echo = (id: string, value: string): EchoAddon => {
    const addon = createEchoAddon({ id, token: value, url: `ws://127.0.0.1:${port}`, log: silent, initialBackoffMs: 50, maxBackoffMs: 100 });
    addons.push(addon);
    return addon;
  };
  return { run, token, echo };
}

/** What the website's channel list says about one add-on (`absent` while it is not connected). */
async function stateOf(run: WiringRun, id: string): Promise<string | undefined> {
  const res = await run.app.web.inject({
    method: 'GET', url: '/api/channels',
    headers: { 'cf-access-jwt-assertion': 'test-jwt', cookie: run.cookie, host: new URL(run.config.publicOrigin).host, 'x-hub-key': run.pageKey },
  });
  return res.json<Array<{ id: string; state: string }>>().find((channel) => channel.id === id)?.state;
}

describe('the echo add-on against a running hub', { timeout: 30_000 }, () => {
  it('registers, is up, hears the owner and answers through the hub, and offers its tool', async () => {
    const { run, token, echo } = await hubWithEcho();
    const addon = echo('echo', token('echo'));
    addon.start();
    await vi.waitFor(async () => expect(await stateOf(run, 'echo')).toBe('up'), WAIT);
    // The add-on sends its status without waiting for the welcome, so the hub can be "up" while the welcome is in flight.
    await vi.waitFor(() => expect(addon.client.welcome()).toMatchObject({ protocol: 1, owner: OWNER, manager: { name: 'Luady' } }), WAIT);
    const channels = await run.app.web.inject({
      method: 'GET', url: '/api/channels',
      headers: { 'cf-access-jwt-assertion': 'test-jwt', cookie: run.cookie, host: new URL(run.config.publicOrigin).host, 'x-hub-key': run.pageKey },
    });
    expect(channels.json()).toEqual([
      expect.objectContaining({ id: 'echo', state: 'up', primary: true, panel: expect.objectContaining({ title: 'Echo' }) }),
      expect.objectContaining({ id: 'spare', state: 'absent', primary: false }),
    ]);
    expect(JSON.stringify(channels.json())).not.toContain(token('echo'));

    // The owner types /help in the terminal; the hub answers on the same chat, quoting it.
    const msgId = addon.say('/help');
    await vi.waitFor(() => expect(addon.outbox().some((item) => item.kind === 'send')).toBe(true), WAIT);
    expect(addon.outbox().find((item) => item.kind === 'send')).toMatchObject({ text: helpText(), replyTo: msgId });

    // The hub sends on its own (the manager tells the owner something); the add-on receives it and acknowledges.
    await switchManagerOn(run.app);
    const auth = { authorization: `Bearer ${WIRING_TOKEN}` };
    const told = await run.app.internal.inject({ method: 'POST', url: '/internal/tools/notify_user', headers: auth, payload: { text: 'A message from the hub' } });
    expect(told.json()).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(addon.outbox().some((item) => item.kind === 'send' && (item.text ?? '').includes('A message from the hub'))).toBe(true), WAIT);

    // The manager's tool list now holds the add-on's tool, and a call reaches it (both answer only while it is on).
    const list = await run.app.internal.inject({ method: 'GET', url: '/internal/tools', headers: auth });
    expect(list.json<{ addon: Array<{ name: string; addon: string }> }>().addon.map((t) => [t.name, t.addon])).toEqual([['echo_back', 'echo']]);
    const call = await run.app.internal.inject({ method: 'POST', url: '/internal/tools/echo_back', headers: auth, payload: { text: 'ping' } });
    expect(call.json()).toEqual({ ok: true, text: 'ping' });
    const bad = await run.app.internal.inject({ method: 'POST', url: '/internal/tools/echo_back', headers: auth, payload: { text: 5 } });
    expect(bad.json()).toEqual({ ok: false, error: 'echo_back needs { text } of at most 1000 characters' });
  });

  it('a second add-on with a wrong token is refused, and the first one is not disturbed', async () => {
    const { run, token, echo } = await hubWithEcho();
    const good = echo('echo', token('echo'));
    good.start();
    await vi.waitFor(async () => expect(await stateOf(run, 'echo')).toBe('up'), WAIT);
    const intruder = echo('echo', token('spare'));
    intruder.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(intruder.client.isConnected()).toBe(false);
    expect(intruder.client.welcome()).toBeNull();
    expect(good.client.isConnected()).toBe(true);
    expect(await stateOf(run, 'echo')).toBe('up');
  });
});

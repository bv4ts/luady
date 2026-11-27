import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { TOOL_NAMES, type ToolName } from '@luady/shared';
import { createAddonTools } from '../../src/channels/addon-tools.js';
import { loadAddons } from '../../src/channels/addons-file.js';
import { createChannelHost } from '../../src/channels/host.js';
import { createBus } from '../../src/core/bus.js';
import type { ToolContext, ToolHandler } from '../../src/core/contracts.js';
import { createInternalServer } from '../../src/internal/server.js';
import { classicHostLookups, createFakeClock, silentLogger } from '../helpers/fakes.js';

const HUB_TOKEN = 'a'.repeat(64);

let app: FastifyInstance | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app?.close();
  app = null;
});

async function setup() {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'luady-addon-auth-')), 'data');
  const log = silentLogger();
  const addons = loadAddons({
    config: { dataDir, addons: [{ id: 'test-channel', kind: 'channel', name: 'Test chat', owner: '447700900001' }, { id: 'helper-tools', kind: 'tools', name: 'Tools' }] },
    log,
  });
  const host = createChannelHost({ addons, bus: createBus(() => undefined), clock: createFakeClock(), log });
  const tools = createAddonTools({ host, addons, log, brainDir: join(dataDir, 'no-brain') });
  const handlers = Object.fromEntries(TOOL_NAMES.map((name) => [name, vi.fn(async () => `ran ${name}`)])) as Record<ToolName, ToolHandler>;
  const toolContext = { fleet: classicHostLookups(), addons: { tools, isAddonToken: addons.isAddonToken } } as unknown as ToolContext;
  const config = { hubSocketToken: HUB_TOKEN } as Parameters<typeof createInternalServer>[0]['config'];
  // The manager is on: an add-on's token is still refused on the manager's routes.
  app = await createInternalServer({ config, log, handlers, toolContext, routes: [host.route()], managerReady: () => true });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const token = (id: string): string => readFileSync(join(dataDir, 'addons', `${id}.token`), 'utf8').trim();
  return { app, host, handlers, port, token };
}

/** Opens the add-on route; resolves with the socket, or rejects with the refused HTTP status. */
function open(port: number, id: string, token: string | null): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/internal/addon/${id}`, token === null ? {} : { headers: { authorization: `Bearer ${token}` } });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
    socket.once('error', reject);
  });
}

describe('the add-on route: its own token, nothing else', () => {
  it('accepts a declared add-on with its own token', async () => {
    const t = await setup();
    const socket = await open(t.port, 'test-channel', t.token('test-channel'));
    socket.send(JSON.stringify({ t: 'hello', protocol: 1, kind: 'channel', version: '1', capabilities: {
      text: true, files: false, edit: false, pin: false, revoke: false, typing: false, played: false, profile: false,
      replyQuote: false, voiceNotes: false, maxText: 1000, maxFileBytes: 0,
    } }));
    await vi.waitFor(() => expect(t.host.info('test-channel')?.state).toBe('starting'));
  });

  it('401 for a wrong token, no token, the hub token, or another add-on\'s token', async () => {
    const t = await setup();
    await expect(open(t.port, 'test-channel', 'f'.repeat(64))).rejects.toThrow('401');
    await expect(open(t.port, 'test-channel', null)).rejects.toThrow('401');
    await expect(open(t.port, 'test-channel', HUB_TOKEN)).rejects.toThrow('401');
    await expect(open(t.port, 'test-channel', t.token('helper-tools'))).rejects.toThrow('401');
    expect(t.host.info('test-channel')?.state).toBe('absent');
  });

  it('404 for an id that is not declared, and for a reserved name, whatever the token', async () => {
    const t = await setup();
    await expect(open(t.port, 'someone-else', t.token('test-channel'))).rejects.toThrow('404');
    for (const reserved of ['chat', 'manager', 'hub', 'web']) {
      await expect(open(t.port, reserved, t.token('test-channel'))).rejects.toThrow('404');
    }
    await expect(open(t.port, '..%2Ftools', t.token('test-channel'))).rejects.toThrow('404');
  });

  it('an add-on token gets 403 on /internal/tools and every other internal route; no tool runs', async () => {
    const t = await setup();
    const auth = { authorization: `Bearer ${t.token('test-channel')}` };
    const list = await t.app.inject({ method: 'GET', url: '/internal/tools', headers: auth });
    const call = await t.app.inject({ method: 'POST', url: '/internal/tools/fleet_status', headers: auth, payload: {} });
    const health = await t.app.inject({ method: 'GET', url: '/internal/health', headers: auth });
    expect([list.statusCode, call.statusCode, health.statusCode]).toEqual([403, 403, 403]);
    expect(t.handlers.fleet_status).not.toHaveBeenCalled();
    const stranger = await t.app.inject({ method: 'GET', url: '/internal/tools', headers: { authorization: `Bearer ${'9'.repeat(64)}` } });
    expect(stranger.statusCode).toBe(401);
  });

  it('the add-on prefix never opens another route without the hub token', async () => {
    const t = await setup();
    for (const url of ['/internal/addon/../tools/fleet_status', '/internal/addon/x/../../tools/fleet_status', '/internal/addon%2F..%2Ftools/fleet_status']) {
      const res = await t.app.inject({ method: 'POST', url, payload: {} });
      expect([401, 404], url).toContain(res.statusCode);
    }
    const list = await t.app.inject({ method: 'GET', url: '/internal/addon/../tools' });
    expect([401, 404]).toContain(list.statusCode);
    expect(t.handlers.fleet_status).not.toHaveBeenCalled();
  });

  it('the hub token lists the built-in tools (without video_download) and the add-on tools, never a token', async () => {
    const t = await setup();
    const res = await t.app.inject({ method: 'GET', url: '/internal/tools', headers: { authorization: `Bearer ${HUB_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ builtin: string[]; addon: unknown[] }>();
    expect(body.builtin).toContain('fleet_status');
    expect(body.builtin).not.toContain('video_download');
    expect(body.addon).toEqual([]);
    expect(res.body).not.toContain(t.token('test-channel'));
  });
});

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES, type ToolName } from '@luady/shared';
import type { HubConfig, ToolContext, ToolHandler } from '../../src/core/contracts.js';
import { NotFoundError } from '../../src/core/errors.js';
import { bearerMatches } from '../../src/internal/auth.js';
import { createInternalServer } from '../../src/internal/server.js';
import { classicHostLookups, silentLogger } from '../../test/helpers/fakes.js';
import { loadedDefaults } from '../helpers/loaded-config.js';

const TOKEN = 'a'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };

const config: HubConfig = {
  ...loadedDefaults('/home/luady/data'),
  servers: [], fleetKeyPath: '/home/luady/.ssh/id_ed25519_fleet', dataDir: '/home/luady/data', brainDir: '/home/luady/brain',
  runDir: '/home/luady/run', webDir: '/home/luady/app/current/packages/web/dist', webPort: 7410,
  publicOrigin: 'https://luady.example.com', rpId: 'luady.example.com', ownerPhone: '447700900001',
  ownerEmail: 'owner@example.com', cfTeamDomain: 'team.cloudflareaccess.com', cfAccessAud: 'aud',
  sessionSecret: 'b'.repeat(64), hubSocketToken: TOKEN, claudePath: '/home/luady/.local/bin/claude',
  localCtlPath: '/home/luady/.luady/bin/luady-ctl', remoteCtlPath: '~/.luady/bin/luady-ctl',
};

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(over: Partial<Record<ToolName, ToolHandler>> = {}, onOwnerTold?: () => void, managerReady: () => boolean = () => true) {
  const base = Object.fromEntries(
    TOOL_NAMES.map((name) => [name, vi.fn(async (): Promise<string> => `ran ${name}`)]),
  ) as Record<ToolName, ToolHandler>;
  const handlers: Record<ToolName, ToolHandler> = { ...base, ...over };
  // The fleet answers the run-time host check of tool arguments.
  const toolContext = { marker: 'tool-context', fleet: classicHostLookups() } as unknown as ToolContext;
  const server = await createInternalServer({
    config, log: silentLogger(), handlers, toolContext, onOwnerTold, managerReady,
  });
  app = server;
  return { server, handlers, toolContext };
}

describe('bearerMatches', () => {
  it('accepts only the exact bearer token', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${'b'.repeat(64)}`, TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches('Bearer ', '')).toBe(false);
  });
});

describe('createInternalServer', () => {
  it('rejects requests without the bearer token', async () => {
    const t = await build();
    const health = await t.server.inject({ method: 'GET', url: '/internal/health' });
    const wrong = await t.server.inject({ method: 'GET', url: '/internal/health', headers: { authorization: `Bearer ${'c'.repeat(64)}` } });
    const tool = await t.server.inject({ method: 'POST', url: '/internal/tools/fleet_status', payload: {} });
    expect([health.statusCode, wrong.statusCode, tool.statusCode]).toEqual([401, 401, 401]);
    expect(health.json()).toEqual({ ok: false, error: 'unauthorized' });
    expect(t.handlers.fleet_status).not.toHaveBeenCalled();
  });

  it('answers /internal/health', async () => {
    const t = await build();
    const res = await t.server.inject({ method: 'GET', url: '/internal/health', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('returns 404 for an unknown tool', async () => {
    const t = await build();
    const res = await t.server.inject({ method: 'POST', url: '/internal/tools/rm_rf', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ ok: false, error: 'Unknown tool: rm_rf' });
  });

  it('returns 400 when the input fails the tool schema', async () => {
    const t = await build();
    const res = await t.server.inject({
      method: 'POST', url: '/internal/tools/session_send', headers: AUTH, payload: { session: 'cedar:x', extra: 1 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error.length).toBeGreaterThan(0);
    expect(t.handlers.session_send).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed JSON body', async () => {
    const t = await build();
    const res = await t.server.inject({
      method: 'POST', url: '/internal/tools/fleet_status', headers: { ...AUTH, 'content-type': 'application/json' }, payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ ok: boolean }>().ok).toBe(false);
  });

  it('calls the handler with the parsed input (defaults applied) and the tool context', async () => {
    const t = await build();
    const res = await t.server.inject({
      method: 'POST', url: '/internal/tools/session_read', headers: AUTH, payload: { session: 'meadow-hr' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, text: 'ran session_read' });
    expect(t.handlers.session_read).toHaveBeenCalledWith({ session: 'meadow-hr', last_n: 20 }, t.toolContext);
  });

  it('reports only successful owner-messaging tools as having told the owner', async () => {
    const told = vi.fn();
    const t = await build({ mission_done: async () => { throw new NotFoundError('No mission'); } }, told);
    const call = (name: string, payload: object) => t.server.inject({ method: 'POST', url: `/internal/tools/${name}`, headers: AUTH, payload });
    await call('session_read', { session: 'meadow-hr' });
    await call('mission_done', { session: 'meadow-hr', summary: 'Done.' });
    // Files are not the message: the summary written after them must still reach the owner.
    await call('send_file', { server: 'birch', path: '/tmp/x.png' });
    expect(told).not.toHaveBeenCalled();
    await call('notify_user', { text: 'birch is idle' });
    expect(told).toHaveBeenCalledTimes(1);
  });

  it('turns a HubError into ok:false with HTTP 200', async () => {
    const t = await build({ session_read: async () => { throw new NotFoundError('No session matches "nope"'); } });
    const res = await t.server.inject({
      method: 'POST', url: '/internal/tools/session_read', headers: AUTH, payload: { session: 'nope' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: 'No session matches "nope"' });
  });

  it('hides unexpected handler errors behind a 500', async () => {
    const t = await build({ fleet_status: async () => { throw new Error('sqlite at /home/luady/data/hub.db is locked'); } });
    const res = await t.server.inject({ method: 'POST', url: '/internal/tools/fleet_status', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ ok: false, error: 'Internal error' });
  });
});

describe('the manager switch on the tool routes', () => {
  it('refuses every tool call and the tool list with 409 manager_off while the manager is not ready', async () => {
    const t = await build({}, undefined, () => false);
    const call = await t.server.inject({ method: 'POST', url: '/internal/tools/fleet_status', headers: AUTH, payload: {} });
    expect(call.statusCode).toBe(409);
    expect(call.json()).toEqual({ ok: false, error: 'The manager is off. Switch it on in Settings first.', code: 'manager_off' });
    expect(t.handlers.fleet_status).not.toHaveBeenCalled();
    // Refused before the name or the arguments are looked at: an off manager learns nothing about either.
    const unknown = await t.server.inject({ method: 'POST', url: '/internal/tools/rm_rf', headers: AUTH, payload: {} });
    const invalid = await t.server.inject({ method: 'POST', url: '/internal/tools/session_send', headers: AUTH, payload: { extra: 1 } });
    expect([unknown.statusCode, invalid.statusCode]).toEqual([409, 409]);
    const list = await t.server.inject({ method: 'GET', url: '/internal/tools', headers: AUTH });
    expect(list.statusCode).toBe(409);
    expect(list.json()).toMatchObject({ ok: false, code: 'manager_off' });
  });

  it('follows the switch at call time: refused while off, answered once on', async () => {
    let ready = false;
    const t = await build({}, undefined, () => ready);
    const call = () => t.server.inject({ method: 'POST', url: '/internal/tools/fleet_status', headers: AUTH, payload: {} });
    expect((await call()).statusCode).toBe(409);
    ready = true;
    const on = await call();
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ ok: true, text: 'ran fleet_status' });
    ready = false;
    expect((await call()).statusCode).toBe(409);
    expect(t.handlers.fleet_status).toHaveBeenCalledTimes(1);
  });

  it('still answers the health check while the manager is off, and still asks for the hub token first', async () => {
    const t = await build({}, undefined, () => false);
    const health = await t.server.inject({ method: 'GET', url: '/internal/health', headers: AUTH });
    expect(health.statusCode).toBe(200);
    const noToken = await t.server.inject({ method: 'POST', url: '/internal/tools/fleet_status', payload: {} });
    expect(noToken.statusCode).toBe(401);
  });
});

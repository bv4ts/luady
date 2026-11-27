import { describe, expect, it } from 'vitest';
import type { ChannelInfoDTO, HostDTO, RoomsDTO, SetupStateDTO } from '@luady/shared';
import type { SetupService } from '../../../src/core/contracts.js';
import { OPTIONAL_ROUTE_MODULES } from '../../../src/web/routes/index.js';
import { call, harnessFactory } from '../helpers.js';

const harness = harnessFactory();

const ROOMS: RoomsDTO = { items: [], grid: { slotCount: 0, K: 1, R: 1, capacity: 4 } };
const STATE: SetupStateDTO = { step: 'done', claimed: true, authMode: 'local', remote: false, skipped: [] };
const HOSTS: HostDTO[] = [];
const CHANNELS: ChannelInfoDTO[] = [];
/** The setup service has one interface: the state, the steps and the login link's sessions. */
const SETUP: SetupService = {
  state: () => STATE, advance: () => STATE, finish: () => STATE, notify: () => undefined, keepLinkSession: () => undefined, isLinkSession: () => false,
};

describe('optional route modules', () => {
  it('covers exactly the optional services', () => {
    expect(OPTIONAL_ROUTE_MODULES.map((module) => module.service)).toEqual(['rooms', 'hosts', 'channels', 'setup', 'connect']);
  });

  it('a hub without the optional services answers 404 there, not a crash', async () => {
    const h = await harness();
    const session = h.login();
    for (const url of ['/api/rooms', '/api/hosts', '/api/channels', '/api/setup/state']) {
      const res = await call(h, 'GET', url, undefined, { session });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('registers each module once its service is present', async () => {
    const h = await harness({
      rooms: { list: () => ROOMS }, hosts: { list: () => HOSTS }, channels: { list: () => CHANNELS }, setup: SETUP,
      connect: { googleStatusText: () => null },
    });
    const session = h.login();
    expect((await call(h, 'GET', '/api/rooms', undefined, { session })).json()).toEqual(ROOMS);
    expect((await call(h, 'GET', '/api/hosts', undefined, { session })).json()).toEqual(HOSTS);
    expect((await call(h, 'GET', '/api/channels', undefined, { session })).json()).toEqual(CHANNELS);
    expect((await call(h, 'GET', '/api/setup/state', undefined, { session })).json()).toEqual(STATE);
  });

  it('the overview carries the rooms and channels when their services are present', async () => {
    const room = {
      id: 'orchard', name: 'Orchard', short: 'Orchard', kind: 'server', host: 'birch', match: [], colour: '#d6336c', accent: '#e88fae',
      species: 'bun', position: 0, size: 'm', hostState: 'ok', createdAt: 'x', updatedAt: 'x',
    } as const;
    const h = await harness({ rooms: { list: () => ({ ...ROOMS, items: [room] }) }, channels: { list: () => CHANNELS } });
    const overview = (await call(h, 'GET', '/api/overview', undefined, { session: h.login() })).json() as { rooms: unknown[]; channels: unknown[] };
    expect(overview.rooms).toEqual([room]);
    expect(overview.channels).toEqual([]);
  });
});

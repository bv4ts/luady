import { describe, expect, it } from 'vitest';
import { roomLookup } from '../../../../src/features/rooms/room-lookup.js';
import { giveTargets, giveToast, targetName } from '../../../../src/features/agency/give/targets.js';
import { server, session } from '../../../fixtures.js';
import { classicRoomDtos, roomDto } from '../../../room-fixtures.js';

const ROOMS = classicRoomDtos();

describe('the Give to… targets', () => {
  it('lists Let Luady decide, then each office with a new session and its live sessions', () => {
    const targets = giveTargets(
      ROOMS,
      [server({ name: 'cedar' }), server({ name: 'birch' }), server({ name: 'ash', status: 'offline' })],
      [
        session({ id: 'birch:web:0.0', host: 'birch', displayName: 'web', project: 'orchard-web', state: 'working' }),
        session({ id: 'birch:api:0.0', host: 'birch', displayName: 'api', project: 'api', state: 'waiting_question' }),
        session({ id: 'birch:old:0.0', host: 'birch', displayName: 'old', state: 'ended' }),
        session({ id: 'hq:x', host: 'hq', displayName: 'brain' }),
      ],
    );
    expect(targets.auto).toMatchObject({ title: 'Let Luady decide', to: { kind: 'auto' } });
    // By design: the offices follow the rooms' slot order, not a fixed list of four.
    expect(targets.rooms.map((room) => room.name)).toEqual(['Orchard', 'Harbor', 'Meadow']);
    const birch = targets.rooms[0];
    expect(birch?.newSession).toMatchObject({ title: 'A new session in Orchard', to: { kind: 'server', server: 'birch' }, disabled: false });
    expect(birch?.sessions.map((s) => [s.title, s.detail])).toEqual([['api', 'waiting for you'], ['web', 'working · orchard-web']]);
    expect(birch?.sessions[1]?.to).toEqual({ kind: 'session', id: 'birch:web:0.0' });
    expect(targets.rooms[1]?.newSession).toMatchObject({ disabled: true, detail: 'This server is offline.' });
  });

  it('without a server list it still offers every office', () => {
    expect(giveTargets(ROOMS, [], []).rooms.map((room) => room.server)).toEqual(['birch', 'ash', 'cedar', 'local']);
  });

  it('offers any number of offices, a host without a room by its id, and never the manager\'s own host', () => {
    const rooms = [...ROOMS, roomDto({ id: 'mars', name: 'Mars', host: 'red-box', position: 9 })];
    const targets = giveTargets(rooms, [server({ name: 'red-box' }), server({ name: 'zeta' }), server({ name: 'hq' })], []);
    expect(targets.rooms.map((room) => room.name)).toEqual(['Mars', 'zeta']);
    expect(targets.rooms[0]?.palette).toEqual({ base: '#3d7bff', accent: '#93b5ff' });
  });

  it('names a target and words the toast', () => {
    const list = [session({ id: 'birch:web:0.0', displayName: 'web' })];
    const lookup = roomLookup(ROOMS);
    expect(targetName({ kind: 'auto' }, list, lookup)).toBeNull();
    expect(targetName({ kind: 'server', server: 'ash' }, list, lookup)).toBe('Harbor');
    expect(targetName({ kind: 'session', id: 'birch:web:0.0' }, list, lookup)).toBe('web');
    expect(targetName({ kind: 'session', id: 'gone' }, list, lookup)).toBe('that session');
    expect(giveToast('3 cards', 'sent', 'Orchard')).toBe('Luady is on it: 3 cards to Orchard.');
    expect(giveToast('3 cards', 'sent')).toBe('Luady is on it: 3 cards.');
    expect(giveToast('"Fix it"', 'queued')).toBe('Waiting for Luady: "Fix it". He gets it when he is back.');
  });
});

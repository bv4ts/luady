import type { WsServerMessage } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { initialState, reducer, type AppAction, type AppState } from '../../src/state/reducer.js';
import { channels, hostChoices, hosts, roomOfSession, rooms, roomsByPosition } from '../../src/state/rooms.js';
import { luadyStatus, overview, server, session } from '../fixtures.js';
import { ROOM_AT, channelDto, classicRoomDtos, hostDto, roomDto } from '../room-fixtures.js';

const ws = (message: WsServerMessage): AppAction => ({ type: 'ws.message', message });
const run = (state: AppState, ...actions: AppAction[]): AppState => actions.reduce(reducer, state);

describe('rooms, hosts, channels and setup state, the manager switched off', () => {
  it('starts with no rooms, no hosts list, no channels and no setup state', () => {
    expect(initialState).toMatchObject({ rooms: [], hosts: null, channels: [], setup: null, jiraRoom: null });
  });

  it('takes rooms and channels from the overview', () => {
    const state = run(initialState, { type: 'overview.loaded', overview: overview({ rooms: classicRoomDtos(), channels: [channelDto()] }) });
    expect(rooms(state).map((room) => room.id)).toEqual(['birch', 'ash', 'cedar', 'local']);
    expect(channels(state).map((channel) => channel.id)).toEqual(['chatapp']);
  });

  it('rooms.changed replaces the whole list', () => {
    const state = run(initialState,
      { type: 'overview.loaded', overview: overview({ rooms: classicRoomDtos() }) },
      ws({ type: 'rooms.changed', rooms: [roomDto({ id: 'mars', position: 7 })], at: ROOM_AT }));
    expect(rooms(state).map((room) => room.id)).toEqual(['mars']);
  });

  it('rooms.loaded (the answer to a write) replaces the list too', () => {
    const state = run(initialState, { type: 'rooms.loaded', rooms: [roomDto({ id: 'venus', name: 'Venus' })] });
    expect(rooms(state)[0]?.name).toBe('Venus');
  });

  it('hosts.changed replaces the hosts list', () => {
    const state = run(initialState, ws({ type: 'hosts.changed', hosts: [hostDto(), hostDto({ id: 'computer', kind: 'local' })], at: ROOM_AT }));
    expect(hosts(state)?.map((host) => host.id)).toEqual(['mars', 'computer']);
  });

  it('channel.status updates its channel and adds a new one', () => {
    const state = run(initialState,
      { type: 'overview.loaded', overview: overview({ channels: [channelDto()] }) },
      ws({ type: 'channel.status', channel: channelDto({ state: 'down' }) }),
      ws({ type: 'channel.status', channel: channelDto({ id: 'pager', name: 'Pager', primary: false }) }));
    expect(channels(state).map((channel) => [channel.id, channel.state])).toEqual([['chatapp', 'down'], ['pager', 'up']]);
  });

  it('setup.changed keeps the setup state', () => {
    const setup = { step: 'rooms' as const, claimed: true, authMode: 'local' as const, remote: false, skipped: [] };
    const state = run(initialState, ws({ type: 'setup.changed', state: setup }));
    expect(state.setup).toEqual(setup);
  });

  it('jira.changed keeps its room and moves the Jira version', () => {
    const state = run(initialState, ws({ type: 'jira.changed', room: 'mars', at: ROOM_AT }));
    expect(state.jiraRoom).toBe('mars');
    expect(state.jiraVersion).toBe(1);
  });

  it('host.job and host.log leave the state as it is', () => {
    const state = run(initialState,
      ws({ type: 'host.job', host: 'mars', job: 'j1', state: 'running' }),
      ws({ type: 'host.log', host: 'mars', job: 'j1', line: 'ok', at: ROOM_AT }));
    expect(state).toBe(initialState);
  });

  it('keeps the manager switched off as off (not down)', () => {
    const state = run(initialState, ws({ type: 'manager.status', status: luadyStatus({ state: 'off' }) }));
    expect(state.luady?.state).toBe('off');
  });
});

describe('rooms and hosts selectors', () => {
  it('roomsByPosition sorts once per list', () => {
    const state = { rooms: [roomDto({ id: 'b', position: 5 }), roomDto({ id: 'a', position: 1 })] };
    const sorted = roomsByPosition(state);
    expect(sorted.map((room) => room.id)).toEqual(['a', 'b']);
    expect(roomsByPosition(state)).toBe(sorted);
  });

  it('roomOfSession places a session through the room index; the manager\'s own sessions are never placed', () => {
    const state = { rooms: classicRoomDtos() };
    expect(roomOfSession(state, session({ host: 'ash', project: 'harbor-web', cwd: null }))).toEqual({ room: 'ash', guest: false });
    expect(roomOfSession(state, session({ host: 'ash', project: 'orchard-api', cwd: null }))).toEqual({ room: 'ash', guest: true });
    expect(roomOfSession(state, session({ host: 'mars', project: 'x', cwd: null }))).toBeNull();
  });

  it('hostChoices: the overview servers until a hosts list arrives, then only pinned hosts', () => {
    const servers = [server({ name: 'mars' }), server({ name: 'computer', kind: 'local', projectsRoot: '/home/me/projects' })];
    expect(hostChoices({ servers, hosts: null })).toEqual([
      { id: 'mars', local: false, projectsRoot: null, homeDir: null },
      { id: 'computer', local: true, projectsRoot: '/home/me/projects', homeDir: null },
    ]);
    const list = [hostDto(), hostDto({ id: 'venus', state: 'draft' }), hostDto({ id: 'computer', kind: 'local', projectsRoot: '/p' })];
    expect(hostChoices({ servers, hosts: list }).map((choice) => choice.id)).toEqual(['mars', 'computer']);
  });
});

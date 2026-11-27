import type { ChannelInfoDTO, HostDTO, RoomDTO } from '@luady/shared';

export const ROOM_AT = '2026-11-21T08:00:00.000Z';

/** A room row as the hub sends it. */
export function roomDto(over: Partial<RoomDTO> = {}): RoomDTO {
  return {
    id: 'mars', name: 'Mars', short: 'Mars', kind: 'server', host: 'mars', match: [], colour: '#3d7bff', accent: '#93b5ff',
    species: 'bun', position: 0, size: 'm', hostState: 'ok', createdAt: ROOM_AT, updatedAt: ROOM_AT,
    ...over,
  };
}

/**
 * The classic four as rooms: Orchard on birch (slot 0), Harbor on ash (1), Meadow on cedar (2) and
 * Private Projects on local (3), in the classic colours.
 */
export function classicRoomDtos(): RoomDTO[] {
  return [
    roomDto({ id: 'birch', name: 'Orchard', short: 'Orchard', host: 'birch', colour: '#d6336c', accent: '#74b816', species: 'bun', position: 0,
      match: [{ by: 'name', glob: 'orchard*' }, { by: 'name', glob: 'dev_orchard*' }] }),
    roomDto({ id: 'ash', name: 'Harbor', short: 'Harbor', host: 'ash', colour: '#f76707', accent: '#37b24d', species: 'bot', position: 1,
      match: [{ by: 'name', glob: 'harbor*' }] }),
    roomDto({ id: 'cedar', name: 'Meadow', short: 'Meadow', host: 'cedar', colour: '#12b886', accent: '#c3fae8', species: 'shield', position: 2,
      match: [{ by: 'name', glob: 'meadow*' }] }),
    roomDto({ id: 'local', name: 'Private Projects', short: 'Private', host: 'local', colour: '#7c5cff', accent: '#ffd84d', species: 'ghost', position: 3 }),
  ];
}

/** `n` server rooms `site-1` … `site-n` on hosts of the same names, at positions 0 … n-1. */
export function manyRooms(n: number): RoomDTO[] {
  return Array.from({ length: n }, (_, i) => roomDto({
    id: `site-${i + 1}`, name: `Site ${i + 1}`, short: `Site ${i + 1}`, host: `site-${i + 1}`, position: i,
  }));
}

export function hostDto(over: Partial<HostDTO> = {}): HostDTO {
  return {
    id: 'mars', kind: 'ssh', host: 'mars.example.invalid', user: 'dev', port: 22, source: 'web', state: 'pinned', fingerprint: null,
    link: 'online', lastError: null, kitVersion: '1.0.0', kitAlias: 'mars', claudeVersion: null, claudeSignedIn: null,
    projectsRoot: '/srv/work', homeDir: '/home/dev', terminal: true, fromAddr: null, createdAt: ROOM_AT, updatedAt: ROOM_AT,
    ...over,
  };
}

export function channelDto(over: Partial<ChannelInfoDTO> = {}): ChannelInfoDTO {
  return {
    id: 'chatapp', kind: 'channel', name: 'Chat app', state: 'up', detail: null, since: ROOM_AT, primary: true,
    capabilities: null, panel: null,
    ...over,
  };
}

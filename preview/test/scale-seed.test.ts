import { describe, expect, it } from 'vitest';
import { isNewRoomId, RoomImportSchema, type RoomDTO, type RoomImport } from '@luady/shared';
import { buildRoomIndex, roomOf } from '@luady/shared/pure';
import { PREVIEW_ROOMS } from '../rooms-seed.ts';
import { previewConfig } from '../config.ts';
import {
  demoRooms, demoSeed, MAX_DEMO_ROOMS, MAX_SCALE_SESSIONS, MAX_SESSIONS_PER_ROOM, MIXED_SERVERS, scaleSessions,
} from '../scale-seed.ts';

const classicIds = PREVIEW_ROOMS.map((room) => room.id);

/** A room as the hub lists it after the import, for the website's own matcher. */
const asDto = (room: RoomImport): RoomDTO => ({
  id: room.id, name: room.name, short: room.short ?? room.name, kind: room.kind, host: room.host ?? null, match: room.match ?? [],
  colour: room.colour ?? '#000000', accent: room.accent ?? '#000000', species: room.species ?? 'bun', position: room.position,
  size: 'm', hostState: 'ok', createdAt: '', updatedAt: '',
});

describe('the demo rooms (--rooms)', () => {
  it('0 is an empty office, 1 to 3 the first classic rooms, 4 the classic four', () => {
    expect(demoRooms(0)).toEqual([]);
    expect(demoRooms(1).map((room) => room.id)).toEqual(['birch']);
    expect(demoRooms(3).map((room) => room.id)).toEqual(classicIds.slice(0, 3));
    expect(demoRooms(4)).toEqual([...PREVIEW_ROOMS]);
    expect(demoRooms('classic')).toEqual([...PREVIEW_ROOMS]);
  });

  it('n ≥ 4 is the classic four plus site-05 … site-n, each at its own position, all valid imports', () => {
    const rooms = demoRooms(24);
    expect(rooms.map((room) => room.id)).toEqual([...classicIds, ...Array.from({ length: 20 }, (_, i) => `site-${String(i + 5).padStart(2, '0')}`)]);
    expect(rooms.map((room) => room.position)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    for (const room of rooms) {
      expect(RoomImportSchema.safeParse(room).success, room.id).toBe(true);
      expect(isNewRoomId(room.id), room.id).toBe(true);
    }
  });

  it('300 rooms have 300 unique ids and positions', () => {
    const rooms = demoRooms(300);
    expect(rooms).toHaveLength(300);
    expect(new Set(rooms.map((room) => room.id)).size).toBe(300);
    expect(new Set(rooms.map((room) => room.position)).size).toBe(300);
    expect(rooms.at(-1)?.id).toBe('site-300');
  });

  it('mixed is 12 rooms on 6 hosts: the four servers plus two more', () => {
    const rooms = demoRooms('mixed');
    expect(rooms).toHaveLength(12);
    expect(new Set(rooms.map((room) => room.host))).toEqual(new Set(['birch', 'ash', 'cedar', 'local', ...MIXED_SERVERS]));
    expect(new Set(rooms.map((room) => room.position)).size).toBe(12);
    for (const room of rooms) expect(RoomImportSchema.safeParse(room).success, room.id).toBe(true);
    expect(demoSeed('mixed').servers).toEqual(MIXED_SERVERS);
  });

  it('refuses a count out of range', () => {
    expect(() => demoRooms(-1)).toThrow(RangeError);
    expect(() => demoRooms(MAX_DEMO_ROOMS + 1)).toThrow(RangeError);
    expect(() => demoRooms(2.5)).toThrow(RangeError);
  });
});

describe('the scale seed', () => {
  it('is the same on every run', () => {
    expect(scaleSessions(demoRooms(100))).toEqual(scaleSessions(demoRooms(100)));
    expect(demoSeed(24)).toEqual(demoSeed(24));
  });

  it('puts 0 to 3 sessions in each room, where the website\'s matcher seats them (never as a guest)', () => {
    for (const mode of [100, 'mixed'] as const) {
      const rooms = demoRooms(mode);
      const index = buildRoomIndex(rooms.map(asDto));
      const sessions = scaleSessions(rooms);
      const perRoom = new Map<string, number>();
      for (const session of sessions) {
        const seat = roomOf({ host: session.host, project: session.name, cwd: `/home/dev/projects/${session.name}` }, index);
        expect(seat?.guest, `${session.host}/${session.name}`).toBe(false);
        perRoom.set(seat?.room ?? '', (perRoom.get(seat?.room ?? '') ?? 0) + 1);
      }
      for (const count of perRoom.values()) expect(count).toBeLessThanOrEqual(MAX_SESSIONS_PER_ROOM);
      expect(new Set(sessions.map((s) => `${s.host}/${s.name}`)).size).toBe(sessions.length);
      // Some rooms are empty and some full: the counts are spread, not all the same.
      expect(new Set(rooms.map((room) => perRoom.get(room.id) ?? 0)).size).toBeGreaterThan(2);
    }
  });

  it('is capped at 1,500 sessions however many rooms', () => {
    const sessions = scaleSessions(demoRooms(MAX_DEMO_ROOMS));
    expect(sessions.length).toBeLessThanOrEqual(MAX_SCALE_SESSIONS);
    expect(scaleSessions(demoRooms(0))).toEqual([]);
  });

  it('the classic mode keeps the preview\'s own seed', () => {
    expect(demoSeed('classic').sessions).toBeNull();
    expect(demoSeed(4).sessions).not.toBeNull();
  });

  it('every server of every mode is under .invalid', () => {
    for (const mode of [0, 5, 'mixed', 'classic'] as const) {
      const seed = demoSeed(mode);
      const config = previewConfig({ dir: '/tmp/x', port: 7420, webDir: '/tmp/x/web', rooms: seed.rooms, extraServers: seed.servers });
      for (const server of config.servers) expect(server.host, server.name).toMatch(/\.invalid$/);
      expect(config.rooms).toEqual(seed.rooms);
    }
  });
});

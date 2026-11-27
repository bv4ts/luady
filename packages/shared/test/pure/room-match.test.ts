import { describe, expect, it } from 'vitest';
import type { RoomDTO } from '../../src/rooms.js';
import { buildRoomIndex, globMatch, roomOf } from '../../src/pure/room-match.js';

const AT = '2026-11-21T08:00:00.000Z';

function room(over: Partial<RoomDTO> & Pick<RoomDTO, 'id' | 'position'>): RoomDTO {
  return {
    name: over.id, short: over.id.slice(0, 12), kind: 'server', host: over.id, match: [], colour: '#d6336c', accent: '#ebb2c6',
    species: 'bun', size: 'm', hostState: 'ok', createdAt: AT, updatedAt: AT, ...over,
  };
}

const session = (host: string, project: string | null, cwd: string | null = null) => ({ host, project, cwd });

describe('globMatch', () => {
  it('name globs match the whole project name with * and ?', () => {
    expect(globMatch('bakery*', 'bakery-api', 'name')).toBe(true);
    expect(globMatch('bakery*', 'my-bakery', 'name')).toBe(false);
    expect(globMatch('api-?', 'api-1', 'name')).toBe(true);
    expect(globMatch('api-?', 'api-12', 'name')).toBe(false);
  });

  it('path globs: * never crosses /, and a trailing /** matches the folder and everything below it', () => {
    expect(globMatch('/srv/*/web', '/srv/shop/web', 'path')).toBe(true);
    expect(globMatch('/srv/*/web', '/srv/a/b/web', 'path')).toBe(false);
    expect(globMatch('/srv/shop/**', '/srv/shop', 'path')).toBe(true);
    expect(globMatch('/srv/shop/**', '/srv/shop/api/src', 'path')).toBe(true);
    expect(globMatch('/srv/shop/**', '/srv/shopping', 'path')).toBe(false);
  });

  it('has no backtracking blow-up on a hostile glob', () => {
    expect(globMatch('*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000), 'name')).toBe(false);
  });
});

describe('roomOf', () => {
  const rooms: RoomDTO[] = [
    room({ id: 'birch', position: 0, host: 'birch', match: [{ by: 'name', glob: 'orchard*' }] }),
    room({ id: 'ash', position: 1, host: 'ash' }),
    room({ id: 'shop-api', position: 2, kind: 'project', host: 'birch', match: [{ by: 'path', glob: '/home/dev/projects/shop-api/**' }] }),
    room({ id: 'shop-web', position: 3, kind: 'project', host: 'birch', match: [{ by: 'name', glob: 'shop*' }] }),
    room({ id: 'docs', position: 4, kind: 'project', host: null, match: [{ by: 'name', glob: 'docs-*' }] }),
    room({ id: 'labs', position: 5, kind: 'project', host: 'mars', match: [{ by: 'name', glob: 'lab-*' }] }),
  ];
  const ix = buildRoomIndex(rooms);

  it('1. the most specific project room wins: a path match beats a name match', () => {
    expect(roomOf(session('birch', 'shop-api', '/home/dev/projects/shop-api'), ix)).toEqual({ room: 'shop-api', guest: false });
    expect(roomOf(session('birch', 'shop-web', '/home/dev/projects/shop-web'), ix)).toEqual({ room: 'shop-web', guest: false });
  });

  it('1. a project room with no host takes sessions from every host', () => {
    expect(roomOf(session('ash', 'docs-site'), ix)).toEqual({ room: 'docs', guest: false });
  });

  it('2. otherwise the home room; a guest when the home has matches and none fits', () => {
    expect(roomOf(session('birch', 'orchard-hr'), ix)).toEqual({ room: 'birch', guest: false });
    expect(roomOf(session('birch', 'meadow'), ix)).toEqual({ room: 'birch', guest: true });
    expect(roomOf(session('ash', 'anything'), ix)).toEqual({ room: 'ash', guest: false });
  });

  it('2. a guest of its home only when a match could be compared: no project and no cwd is never a guest', () => {
    expect(roomOf(session('birch', null, null), ix)).toEqual({ room: 'birch', guest: false });
    // The home matches by name only: a session with a cwd but no project cannot be compared, so it is no guest.
    expect(roomOf(session('birch', null, '/srv/meadow'), ix)).toEqual({ room: 'birch', guest: false });
    const byPath = buildRoomIndex([room({ id: 'cedar', position: 0, match: [{ by: 'path', glob: '/srv/meadow/**' }] })]);
    expect(roomOf(session('cedar', 'other', null), byPath)).toEqual({ room: 'cedar', guest: false });
    expect(roomOf(session('cedar', 'other', '/srv/other'), byPath)).toEqual({ room: 'cedar', guest: true });
    expect(roomOf(session('cedar', null, '/srv/meadow/app'), byPath)).toEqual({ room: 'cedar', guest: false });
  });

  it('3. otherwise a guest in the host\'s lowest-position room; 4. otherwise not on the map', () => {
    expect(roomOf(session('mars', 'other'), ix)).toEqual({ room: 'labs', guest: true });
    expect(roomOf(session('cedar', 'meadow'), ix)).toBeNull();
  });

  it('the longer literal prefix wins between two name matches, then the lower position', () => {
    const two = buildRoomIndex([
      room({ id: 'a', position: 0, kind: 'project', host: 'x1', match: [{ by: 'name', glob: 'sh*' }] }),
      room({ id: 'b', position: 1, kind: 'project', host: 'x1', match: [{ by: 'name', glob: 'shop*' }] }),
      room({ id: 'c', position: 2, kind: 'project', host: 'x1', match: [{ by: 'name', glob: 'shop*' }] }),
    ]);
    expect(roomOf(session('x1', 'shop-1'), two)?.room).toBe('b');
  });

  it('scale: 300 rooms × 1,000 sessions compare only the rooms on each host (counted, not timed)', () => {
    const many: RoomDTO[] = Array.from({ length: 300 }, (_, i) => room({
      id: `site-${String(i).padStart(3, '0')}`, position: i, kind: i % 3 === 0 ? 'server' : 'project', host: `host-${i % 100}`,
      match: [{ by: 'name', glob: `p${i}-*` }, { by: 'path', glob: `/srv/p${i}/**` }],
    }));
    const big = buildRoomIndex(many);
    const perHost = new Map<string, number>();
    for (const r of many) {
      if (r.host !== null) perHost.set(r.host, (perHost.get(r.host) ?? 0) + r.match.length);
    }
    let bound = 0;
    for (let s = 0; s < 1000; s += 1) {
      const host = `host-${s % 100}`;
      bound += perHost.get(host) ?? 0;
      roomOf(session(host, `p${s % 300}-x`, `/srv/p${s % 300}/a`), big);
    }
    expect(big.stats.globCalls).toBeLessThanOrEqual(bound);
    expect(big.stats.globCalls).toBeGreaterThan(0);
  });
});

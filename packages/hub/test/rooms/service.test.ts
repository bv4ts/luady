import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROOM_PALETTE, LOCAL_HOST_ID, RoomWriteDTOSchema, RoomsDTOSchema, defaultAccent, type RoomDTO } from '@luady/shared';
import { NotFoundError, ValidationError } from '../../src/core/errors.js';
import { RoomConflictError, RoomInvalidError } from '../../src/rooms/index.js';
import { project, projectRoom, rig, serverRoom } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};

const positions = (items: readonly RoomDTO[]): number[] => items.map((room) => room.position);

describe('rooms: create, read, update, delete', () => {
  it('creates a server room with its defaults: slug id, short name, the first palette colour, its accent, bun', () => {
    const { rooms } = rig();
    const written = rooms.create(serverRoom('birch', 'Orchard'));
    expect(RoomWriteDTOSchema.parse(written)).toEqual(written);
    expect(written.room).toMatchObject({
      id: 'orchard', name: 'Orchard', short: 'Orchard', kind: 'server', host: 'birch', match: [], colour: DEFAULT_ROOM_PALETTE[0].hex,
      accent: defaultAccent(DEFAULT_ROOM_PALETTE[0].hex), species: 'bun', position: 0, size: 'm', hostState: 'ok',
    });
    expect(written.adjusted).toEqual({ colour: false, accent: false });
    const listed = rooms.list();
    expect(RoomsDTOSchema.parse(listed)).toEqual(listed);
    expect(listed.items.map((room) => room.id)).toEqual(['orchard']);
    expect(rooms.get('orchard')?.name).toBe('Orchard');
    expect(rooms.get('nowhere')).toBeNull();
  });

  it('gives the next room the next palette colour and species, and the lowest free slot', () => {
    const { rooms } = rig();
    rooms.create(serverRoom('birch', 'Orchard'));
    const second = rooms.create(serverRoom('ash', 'Harbor')).room;
    expect(second).toMatchObject({ colour: DEFAULT_ROOM_PALETTE[1].hex, species: 'bot', position: 1 });
  });

  it('updates a room, moving updatedAt, and clamps a colour that is too dark', () => {
    const { rooms } = rig();
    const created = rooms.create(serverRoom('birch', 'Orchard')).room;
    const updated = rooms.update('orchard', { name: 'Orchard Hall', colour: '#050505', expectUpdatedAt: created.updatedAt });
    expect(updated.room.name).toBe('Orchard Hall');
    expect(updated.room.short).toBe('Orchard Hall');
    expect(updated.adjusted.colour).toBe(true);
    expect(updated.room.colour).not.toBe('#050505');
    expect(Date.parse(updated.room.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
  });

  it('removes a room; an unknown id is 404', async () => {
    const { rooms } = rig();
    rooms.create(serverRoom('birch', 'Orchard'));
    await rooms.remove('orchard', { links: 'delete', jira: 'disconnect' }, async () => undefined);
    expect(rooms.list().items).toEqual([]);
    await expect(rooms.remove('orchard', { links: 'delete', jira: 'disconnect' }, async () => undefined)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('rooms: slugs and names', () => {
  it('derives ASCII ids, suffixes a taken one, and keeps clear of reserved words and the lot prefix', () => {
    const { rooms } = rig();
    expect(rooms.create(projectRoom('Shop Web', 'shop*')).room.id).toBe('shop-web');
    expect(rooms.create(projectRoom('Shop-Web', 'shopw*')).room.id).toBe('shop-web-2');
    expect(rooms.create(projectRoom('Café Ünïon', 'cafe*')).room.id).toBe('cafe-union');
    expect(rooms.create(projectRoom('2026 plans', 'plans*')).room.id).toBe('room-2026-plans');
    expect(rooms.create(projectRoom('Lot 7', 'lot7*')).room.id).toBe('room-lot-7');
    expect(rooms.create(projectRoom('New', 'new*')).room.id).toBe('room-new');
    expect(rooms.create(projectRoom('A very long project room name to go on', 'long*')).room.id).toBe('a-very-long-project-room-name-to');
  });

  it('cuts the short name to the first word, and takes an explicit short name and id', () => {
    const { rooms } = rig();
    expect(rooms.create(projectRoom('Customer Portal Rewrite', 'portal*')).room.short).toBe('Customer');
    expect(rooms.create(projectRoom('Billing', 'bill*', { short: 'Bills', id: 'money' })).room).toMatchObject({ short: 'Bills', id: 'money' });
  });

  it('refuses a name another room has, after Unicode case folding, and the headquarters\' names (409 name_taken)', () => {
    const { rooms } = rig();
    rooms.create(projectRoom('Ärzte', 'arzt*'));
    expect(codeOf(() => rooms.create(projectRoom('ärzte', 'x*')))).toBe('name_taken');
    expect(codeOf(() => rooms.create(projectRoom('  ÄRZTE ', 'x*')))).toBe('name_taken');
    expect(codeOf(() => rooms.create(projectRoom('Luady HQ', 'x*')))).toBe('name_taken');
    expect(codeOf(() => rooms.create(projectRoom('hq', 'x*')))).toBe('name_taken');
  });

  it('refuses a control character in a name, and an id that exists (409 room_exists)', () => {
    const { rooms } = rig();
    expect(() => rooms.create(projectRoom('Bad\u0007name', 'x*'))).toThrow(ValidationError);
    rooms.create(projectRoom('Billing', 'bill*', { id: 'money' }));
    expect(codeOf(() => rooms.create(projectRoom('Other', 'other*', { id: 'money' })))).toBe('room_exists');
  });
});

describe('rooms: the host rules', () => {
  it('a server room needs a pinned SSH host; a local room this computer; a project room either or none; never the self host', () => {
    const { rooms } = rig();
    expect(() => rooms.create(serverRoom('mars', 'Mars'))).toThrow(ValidationError);
    expect(() => rooms.create(serverRoom(LOCAL_HOST_ID, 'Desk'))).toThrow(ValidationError);
    expect(() => rooms.create({ name: 'Wrong', kind: 'local', host: 'birch' })).toThrow(ValidationError);
    expect(rooms.create({ name: 'Desk', kind: 'local' }).room.host).toBe(LOCAL_HOST_ID);
    expect(rooms.create(projectRoom('Docs', 'docs-*')).room.host).toBeNull();
    expect(rooms.create(projectRoom('Labs', 'lab-*', { host: 'cedar' })).room.host).toBe('cedar');
    expect(() => rooms.create(projectRoom('Moon', 'moon*', { host: 'mars' }))).toThrow(ValidationError);
    expect(() => rooms.create(projectRoom('Brain', 'brain*', { host: 'hq' }))).toThrow(ValidationError);
    expect(() => rooms.create(serverRoom('hq', 'Brain'))).toThrow(ValidationError);
  });

  it('one home room per host (409 home_room_exists); any number of project rooms', () => {
    const { rooms } = rig();
    rooms.create(serverRoom('birch', 'Orchard'));
    expect(codeOf(() => rooms.create(serverRoom('birch', 'Orchard Two')))).toBe('home_room_exists');
    rooms.create(projectRoom('Shop', 'shop*', { host: 'birch' }));
    rooms.create(projectRoom('Shop Two', 'shop2*', { host: 'birch' }));
    expect(rooms.roomsOfHost('birch').map((room) => room.id)).toEqual(['orchard', 'shop', 'shop-two']);
  });

  it('a project room needs a match; matches are name globs or path globs inside the host\'s projects folder', () => {
    const { rooms } = rig();
    expect(() => rooms.create({ name: 'Empty', kind: 'project', host: null, match: [] })).toThrow(ValidationError);
    expect(() => rooms.create(projectRoom('Bad', 'a b'))).toThrow(ValidationError);
    expect(() => rooms.create({ name: 'Out', kind: 'project', host: 'birch', match: [{ by: 'path', glob: '/etc/**' }] })).toThrow(ValidationError);
    expect(() => rooms.create({ name: 'Up', kind: 'project', host: 'birch', match: [{ by: 'path', glob: '/srv/projects/../etc/*' }] })).toThrow(ValidationError);
    expect(rooms.create({ name: 'Api', kind: 'project', host: 'birch', match: [{ by: 'path', glob: '/srv/projects/api/**' }] }).room.match)
      .toEqual([{ by: 'path', glob: '/srv/projects/api/**' }]);
  });
});

describe('rooms: positions and the grid', () => {
  async function sparse() {
    const r = rig();
    for (const name of ['A1', 'B2', 'C3', 'D4', 'E5']) r.rooms.create(projectRoom(name, `${name.toLowerCase()}*`));
    await r.rooms.remove('a1', { links: 'delete', jira: 'disconnect' }, async () => undefined);
    return r.rooms;
  }

  it('sparse positions: five rooms with slot 0 deleted give positions 1-4, slotCount 5, K=2; a move or create at 0 or 5 is accepted', async () => {
    const listed = (await sparse()).list();
    expect(positions(listed.items)).toEqual([1, 2, 3, 4]);
    expect(listed.grid).toEqual({ slotCount: 5, K: 2, R: 1, capacity: 8 });
    expect((await sparse()).move('e5', 0).items.find((room) => room.id === 'e5')?.position).toBe(0);
    expect((await sparse()).move('e5', 5).items.find((room) => room.id === 'e5')?.position).toBe(5);
    expect((await sparse()).create(projectRoom('F6', 'f6*', { position: 0 })).room.position).toBe(0);
    expect((await sparse()).create(projectRoom('F6', 'f6*', { position: 5 })).room.position).toBe(5);
    expect((await sparse()).create(projectRoom('F6', 'f6*')).room.position).toBe(0);
  });

  it('a create with an explicit position: free and inside the grid, or the lowest free slot; else refused', () => {
    const { rooms } = rig();
    expect(rooms.create(projectRoom('A1', 'a1*', { position: 3 })).room.position).toBe(3);
    expect(codeOf(() => rooms.create(projectRoom('B2', 'b2*', { position: 3 })))).toBe('position_taken');
    expect(codeOf(() => rooms.create(projectRoom('B2', 'b2*', { position: 9 })))).toBe('position_outside_grid');
    expect(rooms.create(projectRoom('B2', 'b2*')).room.position).toBe(0);
    expect(() => rooms.create(projectRoom('C3', 'c3*', { position: 100_000 }))).toThrow(ValidationError);
  });

  it('a move into the occupied slot swaps the two rooms, with no UNIQUE violation', () => {
    const { rooms } = rig();
    for (const name of ['A1', 'B2', 'C3']) rooms.create(projectRoom(name, `${name.toLowerCase()}*`));
    const swapped = rooms.move('a1', 2);
    expect(swapped.items.map((room) => [room.id, room.position])).toEqual([['c3', 0], ['b2', 1], ['a1', 2]]);
    expect(codeOf(() => rooms.move('a1', 50))).toBe('position_outside_grid');
    expect(() => rooms.move('a1', 100_000)).toThrow(ValidationError);
    expect(() => rooms.move('zz', 1)).toThrow(NotFoundError);
  });

  it('order takes a permutation of every id and writes 0..n-1 (two passes); anything else is 400 not_a_permutation', () => {
    const { rooms } = rig();
    for (const name of ['A1', 'B2', 'C3']) rooms.create(projectRoom(name, `${name.toLowerCase()}*`));
    expect(positions(rooms.move('c3', 3).items)).toEqual([0, 1, 3]);
    const ordered = rooms.order(['c3', 'a1', 'b2']);
    expect(ordered.items.map((room) => [room.id, room.position])).toEqual([['c3', 0], ['a1', 1], ['b2', 2]]);
    expect(codeOf(() => rooms.order(['c3', 'a1']))).toBe('not_a_permutation');
    expect(codeOf(() => rooms.order(['c3', 'a1', 'a1']))).toBe('not_a_permutation');
    expect(codeOf(() => rooms.order(['c3', 'a1', 'zz']))).toBe('not_a_permutation');
  });

  it('300 creates give the grid K=9, R=9, with no count limit', () => {
    const { rooms } = rig();
    for (let i = 0; i < 300; i += 1) rooms.create(projectRoom(`Site ${i}`, `site${i}-*`));
    const { items, grid } = rooms.list();
    expect(items).toHaveLength(300);
    expect(grid).toEqual({ slotCount: 300, K: 9, R: 9, capacity: 324 });
  });
});

describe('rooms: stale writes (409 room_conflict)', () => {
  it('refuses an update whose expectUpdatedAt is not the room\'s updatedAt any more', () => {
    const { rooms } = rig();
    const created = rooms.create(serverRoom('birch', 'Orchard')).room;
    rooms.update('orchard', { species: 'cat', expectUpdatedAt: created.updatedAt });
    expect(codeOf(() => rooms.update('orchard', { species: 'ghost', expectUpdatedAt: created.updatedAt }))).toBe('room_conflict');
    expect(() => rooms.update('nowhere', { species: 'ghost', expectUpdatedAt: created.updatedAt })).toThrow(NotFoundError);
  });

  it('checks the host again only when the kind, host or matches change', () => {
    const { rooms } = rig();
    const created = rooms.create(serverRoom('birch', 'Orchard')).room;
    expect(() => rooms.update('orchard', { host: 'mars', expectUpdatedAt: created.updatedAt })).toThrow(ValidationError);
    expect(() => rooms.update('orchard', { kind: 'project', expectUpdatedAt: created.updatedAt })).toThrow(ValidationError);
    const moved = rooms.update('orchard', { kind: 'project', match: [{ by: 'name', glob: 'orchard*' }], expectUpdatedAt: created.updatedAt });
    expect(moved.room).toMatchObject({ kind: 'project', host: 'birch' });
  });
});

describe('rooms: warnings, never refusals', () => {
  it('warns when a colour is close to a reserved one or to another room, and when matches overlap a known project', () => {
    const { rooms } = rig({ projects: () => [project({ name: 'shop-web' })] });
    const first = rooms.create(projectRoom('Shop', 'shop*', { host: 'birch' }));
    expect(first.warnings).toEqual([]);
    const second = rooms.create(projectRoom('Web', 'shop-w*', { host: 'birch', colour: first.room.colour }));
    expect(second.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'near-room', room: 'shop' }),
      expect.objectContaining({ kind: 'overlap', room: 'shop' }),
    ]));
    const teal = rooms.create(projectRoom('Teal', 'teal*', { colour: '#3cc3b0' }));
    expect(teal.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'near-reserved', room: null })]));
  });
});

describe('rooms: the preview', () => {
  it('says which live sessions and projects a room would hold, and which rooms\' matches also fit them', () => {
    const live = [
      { id: 'birch:cc-shop-web:0.0', host: 'birch', project: 'shop-web', cwd: '/srv/projects/shop-web' },
      { id: 'birch:cc-api:0.0', host: 'birch', project: 'api', cwd: '/srv/projects/api' },
      { id: 'ash:cc-shop-app:0.0', host: 'ash', project: 'shop-app', cwd: '/srv/projects/shop-app', state: 'ended' as const },
    ];
    const { rooms } = rig({
      sessions: () => live.map((s) => ({ ...sessionBase(), ...s })),
      projects: () => [project({ name: 'shop-web', path: '/srv/projects/shop-web' }), project({ name: 'api', path: '/srv/projects/api' })],
    });
    rooms.create(projectRoom('All shops', 'shop*'));
    const preview = rooms.preview({ kind: 'project', host: 'birch', match: [{ by: 'name', glob: 'shop-*' }] });
    expect(preview).toEqual({
      sessions: ['birch:cc-shop-web:0.0'], projects: ['birch/shop-web'], overlaps: [{ room: 'all-shops', projects: ['birch/shop-web'] }],
    });
  });
});

describe('rooms.changed', () => {
  it('one write gives one event, with the full list', () => {
    const { rooms, events } = rig();
    rooms.create(serverRoom('birch', 'Orchard'));
    const changed = events.filter((event) => event.name === 'rooms.changed');
    expect(changed).toHaveLength(1);
    expect((changed[0]?.payload as { rooms: RoomDTO[] }).rooms.map((room) => room.id)).toEqual(['orchard']);
  });

  it('a burst of writes is coalesced: one at once, then one at the end of the window with the latest list', () => {
    vi.useFakeTimers();
    const { rooms, events } = rig();
    rooms.create(projectRoom('A1', 'a1*'));
    rooms.create(projectRoom('B2', 'b2*'));
    rooms.create(projectRoom('C3', 'c3*'));
    expect(events.filter((event) => event.name === 'rooms.changed')).toHaveLength(1);
    vi.advanceTimersByTime(250);
    const changed = events.filter((event) => event.name === 'rooms.changed');
    expect(changed).toHaveLength(2);
    expect((changed[1]?.payload as { rooms: RoomDTO[] }).rooms).toHaveLength(3);
    rooms.stop();
  });

  it('a failed write sends nothing', () => {
    const { rooms, events } = rig();
    expect(() => rooms.create(serverRoom('mars', 'Mars'))).toThrow();
    expect(events).toEqual([]);
  });
});

describe('rooms: office names', () => {
  it('a room id reads as its name, a host as its home room\'s name, anything else as itself', () => {
    const { rooms } = rig();
    rooms.create(serverRoom('birch', 'Orchard'));
    rooms.create(projectRoom('Shop', 'shop*', { host: 'birch', id: 'shop' }));
    expect(rooms.officeName('orchard')).toBe('Orchard');
    expect(rooms.officeName('shop')).toBe('Shop');
    expect(rooms.officeName('birch')).toBe('Orchard');
    expect(rooms.officeName('cedar')).toBe('cedar');
  });
});

describe('rooms: errors carry their codes', () => {
  it('conflicts are 409-class refusals, invalid input 400-class', () => {
    expect(new RoomConflictError('jira_exists', 'x')).toMatchObject({ code: 'jira_exists' });
    expect(new RoomInvalidError('reserved_id', 'x')).toBeInstanceOf(ValidationError);
  });
});

function sessionBase() {
  return {
    target: 'cc-x:0.0', claudeSessionId: null, displayName: 'x', state: 'idle' as const, origin: 'owner' as const, registered: true,
    lastEventAt: null, turnStartedAt: null, pendingQid: null, unexpectedEnd: false,
  };
}

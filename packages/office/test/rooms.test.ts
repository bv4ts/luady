import { describe, expect, it } from 'vitest';
import { slotAt } from '@luady/shared/pure';
import { FIRST_RING } from '../src/grid.js';
import { buildOffice } from '../src/layout.js';
import { CORRIDORS, EAST_X, ENTRIES, HQ_DOORS, HQ_MID, HQ_RECT, HQ_W, HQ_X, hqRoom, lotRoom } from '../src/rooms.js';
import { CLASSIC_ROOMS } from './rooms-fixture.js';

const classic = buildOffice(CLASSIC_ROOMS).rooms;
const at = (id: string) => {
  const room = classic[id];
  if (room === undefined) throw new Error(`no room ${id}`);
  return room;
};

describe('room rectangles', () => {
  it('has the four corners and the 30-tile HQ', () => {
    expect(at('birch').rect).toEqual({ x: 1, y: 1, w: 26, h: 17 });
    expect(at('ash').rect).toEqual({ x: 57, y: 1, w: 26, h: 17 });
    expect(at('cedar').rect).toEqual({ x: 1, y: 24, w: 26, h: 17 });
    expect(at('local').rect).toEqual({ x: 57, y: 24, w: 26, h: 17 });
    expect(HQ_RECT).toEqual({ x: 27, y: 1, w: 30, h: 40 });
    expect(HQ_DOORS).toEqual([{ x: 27, y: 20, w: 1, h: 2 }, { x: 56, y: 20, w: 1, h: 2 }]);
    expect(CORRIDORS).toEqual([{ x: 1, y: 18, w: 26, h: 6 }, { x: 57, y: 18, w: 26, h: 6 }]);
    expect(ENTRIES).toEqual([{ x: 0, y: 20, w: 2, h: 2 }, { x: 82, y: 20, w: 2, h: 2 }]);
  });

  it('places the east side from the named constants', () => {
    expect([HQ_X, HQ_W, EAST_X, HQ_MID]).toEqual([27, 30, 57, 42]);
  });
});

describe('room definitions', () => {
  it('builds a server room with its corner data', () => {
    const ash = at('ash');
    expect(ash).toMatchObject({ id: 'ash', kind: 'server', host: 'ash', orientation: 'east-north', side: 'east' });
    expect(ash.slot).toMatchObject({ index: 1, side: 'east', col: 1, row: 0, half: 'north' });
    expect(ash.inside).toEqual({ tx: 62, ty: 14 });
    expect(ash.doorway).toEqual({ x: 61, y: 17, w: 2, h: 1 });
    expect(ash.rackTile).toEqual({ tx: 58, ty: 3 });
    expect(at('cedar')).toMatchObject({ side: 'west', inside: { tx: 21, ty: 27 }, doorway: { x: 21, y: 24, w: 2, h: 2 }, rackTile: { tx: 24, ty: 26 } });
    expect(at('local')).toMatchObject({ inside: { tx: 62, ty: 27 }, doorway: { x: 61, y: 24, w: 2, h: 2 }, rackTile: { tx: 58, ty: 26 } });
    expect(at('birch')).toMatchObject({ inside: { tx: 21, ty: 14 }, doorway: { x: 21, y: 17, w: 2, h: 1 }, rackTile: { tx: 24, ty: 3 } });
  });

  it('builds HQ and lots', () => {
    expect(hqRoom()).toMatchObject({ id: 'hq', kind: 'hq', host: null, slot: null, orientation: null, side: 'centre', species: 'manager', inside: { tx: 42, ty: 22 } });
    expect(lotRoom(slotAt(3), FIRST_RING)).toMatchObject({ id: 'lot-3', kind: 'lot', host: null, orientation: 'east-south', rect: at('local').rect });
  });

  it('returns frozen definitions', () => {
    expect(Object.isFrozen(at('birch'))).toBe(true);
    expect(Object.isFrozen(at('birch').rect)).toBe(true);
  });
});

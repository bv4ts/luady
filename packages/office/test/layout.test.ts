import { describe, expect, it } from 'vitest';
import { buildOffice, roomAtPx, roomRectPx } from '../src/layout.js';
import { CLASSIC_PALETTES, CLASSIC_ROOMS, classic, classicRooms } from './rooms-fixture.js';

describe('buildOffice with the classic four', () => {
  const map = buildOffice(CLASSIC_ROOMS);

  it('places each server in its corner', () => {
    expect(map.rooms.birch?.rect).toEqual({ x: 1, y: 1, w: 26, h: 17 });
    expect(map.rooms.ash?.orientation).toBe('east-north');
    expect(map.rooms.cedar?.palette).toEqual(CLASSIC_PALETTES.jade);
    expect(map.rooms.local?.species).toBe('ghost');
    expect(map.rooms.hq?.rect).toEqual({ x: 27, y: 1, w: 30, h: 40 });
  });

  it('lists rooms in reading order', () => {
    expect(map.order).toEqual(['birch', 'ash', 'hq', 'cedar', 'local']);
    expect(Object.keys(map.rooms).sort()).toEqual(['ash', 'birch', 'cedar', 'hq', 'local']);
  });

  it('is 1344 x 672 pixels', () => {
    expect(map.width).toBe(1344);
    expect(map.height).toBe(672);
  });

  it('carries the spots and zones of the wider building', () => {
    expect(map.spots).toEqual({
      luadyHome: { tx: 41, ty: 18 },
      luadySit: { x: 672, y: 306 },
      entries: [{ tx: 0, ty: 20 }, { tx: 83, ty: 21 }],
      taskWall: { tx: 33, ty: 3 },
      bench: { tx: 39, ty: 35 },
      benchVisit: { tx: 43, ty: 37 },
    });
    expect(map.zones).toEqual({
      all: { x: 16, y: 16, w: 1312, h: 640 },
      hq: { x: 432, y: 16, w: 480, h: 640 },
      workshop: { x: 432, y: 432, w: 480, h: 224 },
      hqRow: { x: 16, y: 16, w: 1312, h: 640 },
      avenue: null,
      indoor: [
        { x: 16, y: 16, w: 416, h: 272 }, { x: 912, y: 16, w: 416, h: 272 }, { x: 432, y: 16, w: 480, h: 640 },
        { x: 16, y: 384, w: 416, h: 272 }, { x: 912, y: 384, w: 416, h: 272 },
        { x: 16, y: 288, w: 416, h: 96 }, { x: 912, y: 288, w: 416, h: 96 },
      ],
    });
  });

  it('frames exactly the building with ZONES.all and the whole HQ room with ZONES.hq', () => {
    const rooms = Object.values(map.rooms).map(roomRectPx);
    const left = Math.min(...rooms.map((r) => r.x));
    const right = Math.max(...rooms.map((r) => r.x + r.w));
    const bottom = Math.max(...rooms.map((r) => r.y + r.h));
    expect(map.zones.all).toEqual({ x: left, y: 16, w: right - left, h: bottom - 16 });
    expect(map.zones.hq).toEqual(roomRectPx(map.rooms.hq!));
  });

  it('is frozen', () => {
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.isFrozen(map.rooms)).toBe(true);
    expect(Object.isFrozen(map.order)).toBe(true);
    expect(Object.isFrozen(map.spots)).toBe(true);
  });
});

describe('buildOffice with some rooms', () => {
  it('fills empty slots with lots', () => {
    const map = buildOffice(classicRooms(['birch']));
    expect(map.rooms['lot-1']?.kind).toBe('lot');
    expect(map.order).toEqual(['birch', 'lot-1', 'hq', 'lot-2', 'lot-3']);
  });

  it('has HQ and four lots with no rooms', () => {
    const map = buildOffice([]);
    expect(map.rooms.hq?.kind).toBe('hq');
    expect(map.order).toEqual(['lot-0', 'lot-1', 'hq', 'lot-2', 'lot-3']);
  });

  it('places a repeated room once', () => {
    const map = buildOffice([classic('birch'), classic('birch'), classic('ash'), classic('birch')]);
    expect(map.order).toEqual(['birch', 'ash', 'hq', 'lot-2', 'lot-3']);
  });

  it('does not change its input', () => {
    const input = [classic('local'), classic('birch')];
    buildOffice(input);
    expect(input).toEqual([classic('local'), classic('birch')]);
  });
});

describe('room geometry in pixels', () => {
  const map = buildOffice(CLASSIC_ROOMS);

  it('converts a room rectangle to pixels', () => {
    expect(roomRectPx(map.rooms.ash!)).toEqual({ x: 912, y: 16, w: 416, h: 272 });
  });

  it('finds the room under a pixel', () => {
    expect(roomAtPx(map, 5 * 16, 5 * 16)).toBe('birch');
    expect(roomAtPx(map, 35 * 16, 20 * 16)).toBe('hq');
    expect(roomAtPx(map, 55 * 16, 20 * 16)).toBe('hq');
    expect(roomAtPx(map, 64 * 16, 30 * 16)).toBe('local');
    expect(roomAtPx(map, 0, 0)).toBeNull();
    expect(roomAtPx(map, 10 * 16, 20 * 16)).toBeNull();
  });

  it('reports lots by their key', () => {
    expect(roomAtPx(buildOffice(classicRooms(['birch'])), 64 * 16, 5 * 16)).toBe('lot-1');
  });
});

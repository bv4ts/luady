import { describe, expect, it } from 'vitest';
import { classicRooms } from './rooms-fixture.js';
import { buildOffice, roomRectPx } from '../src/layout.js';
import { pixelAt } from '../src/raster.js';
import { daylightRaster, glowPoolRaster, panesOf } from '../src/sprites/panes.js';
import { mapLayerRaster } from '../src/sprites/map-layer.js';

const map = buildOffice(classicRooms(['cedar', 'birch', 'ash', 'local']));
const panes = panesOf(map);

describe('panesOf', () => {
  it('sets glass in the outer walls of every lived-in room: west, east and south', () => {
    expect(new Set(panes.map((p) => p.room))).toEqual(new Set(['birch', 'ash', 'cedar', 'local', 'hq']));
    expect(new Set(panes.map((p) => p.side))).toEqual(new Set(['west', 'east', 'south']));
    panes.forEach(({ glass, side }) => {
      if (side === 'west') expect(glass.x).toBeLessThan(32);
      if (side === 'east') expect(glass.x).toBeGreaterThanOrEqual(1312);
      if (side === 'south') expect(glass.y).toBeGreaterThanOrEqual(640);
    });
  });

  it('keeps every pane inside the wall of its own room, clear of the corridors and entries', () => {
    panes.forEach(({ glass, room }) => {
      const q = roomRectPx(map.rooms[room]!);
      expect(glass.x >= q.x && glass.y >= q.y && glass.x + glass.w <= q.x + q.w && glass.y + glass.h <= q.y + q.h).toBe(true);
    });
  });

  it('leaves lots dark', () => {
    const small = buildOffice(classicRooms(['birch']));
    expect(panesOf(small).every((p) => p.room === 'birch' || p.room === 'hq')).toBe(true);
    expect(panesOf(small).length).toBeGreaterThan(0);
  });

  it('shows the glass in the map picture', () => {
    const layer = mapLayerRaster(map);
    const g = panes[0]!.glass;
    expect(pixelAt(layer, g.x + 1, g.y + 5).slice(0, 3)).toEqual([0x1c, 0x28, 0x38]);
  });
});

describe('daylightRaster', () => {
  const light = daylightRaster(map);

  it('is map-sized and lights only floor inside the rooms, nearest the glass brightest', () => {
    expect([light.width, light.height]).toEqual([map.width, map.height]);
    let lit = 0;
    for (let y = 0; y < light.height; y += 2) {
      for (let x = 0; x < light.width; x += 2) {
        if (pixelAt(light, x, y)[3] === 0) continue;
        lit += 1;
        const room = Object.values(map.rooms).find((r) => {
          const q = roomRectPx(r);
          return x >= q.x + 16 && x < q.x + q.w - 16 && y >= q.y + 16 && y < q.y + q.h - 16;
        });
        expect(room?.kind === 'server' || room?.kind === 'hq').toBe(true);
      }
    }
    expect(lit).toBeGreaterThan(500);
    const west = panes.find((p) => p.side === 'west')!.glass;
    expect(pixelAt(light, west.x + west.w + 8, west.y + 4)).toEqual([255, 255, 255, 255]);
  });
});

describe('glowPoolRaster', () => {
  it('is a soft ellipse, white in the middle and dithered at the edge', () => {
    const pool = glowPoolRaster(10, 6);
    expect([pool.width, pool.height]).toEqual([21, 13]);
    expect(pixelAt(pool, 10, 6)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(pool, 0, 0)[3]).toBe(0);
    const edge = [pixelAt(pool, 1, 6), pixelAt(pool, 2, 6)].map((px) => px[3]);
    expect(edge).toContain(0);
  });
});

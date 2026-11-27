import { describe, expect, it } from 'vitest';
import type { RoomDTO } from '@luady/shared';
import {
  CHUNK_LAYERS, HQ_ID, ambienceAt, buildOffice, buildSnapshot, chunkKey, chunkLayers, chunkRaster, chunkRect, chunkWorldRect,
  critterRaster, downsample, monitorScreen, walkMask,
  type Ambience, type ChunkGrid, type ChunkLayer, type OfficeMap, type Palette, type PixelRect, type Raster, type RoomDef, type TilePoint,
  type WalkMask,
} from '../src/index.js';
import { NOW, luadyStatus, server, session } from './fixtures.js';
import { CLASSIC_ROOMS, classicRooms } from './rooms-fixture.js';

/**
 * A type-level check for the website scene: it uses the office's stage interface the way the scene does, through the
 * package's public barrel, so the interface is proved to compile and to fit. It is not the scene.
 */

type Lod = 1 | 2 | 4 | 8;

/** lodFor(scale): the level of detail (1, 2, 4 or 8) for a zoom scale. */
const lodFor = (scale: number): Lod => (scale >= 0.75 ? 1 : scale >= 0.45 ? 2 : scale >= 0.225 ? 4 : 8);

interface ChunkSprite { readonly key: string; readonly layer: ChunkLayer; readonly world: PixelRect; readonly lod: Lod; readonly texture: Raster }

/** What the scene's chunk bank does per frame: cull by chunkRect, key by chunkKey, place at chunkWorldRect, shrink by lod. */
const liveChunks = (map: OfficeMap, view: PixelRect, scale: number, jiraRooms: readonly string[]): readonly ChunkSprite[] => {
  const grid: ChunkGrid = map.chunks;
  const lod = lodFor(scale);
  const meets = (a: PixelRect, b: PixelRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const out: ChunkSprite[] = [];
  for (let j = 0; j < grid.rows; j += 1) {
    for (let i = 0; i < grid.cols; i += 1) {
      if (!meets(chunkRect(map, i, j), view)) continue;
      const layers: ReadonlySet<ChunkLayer> = chunkLayers(map, i, j);
      CHUNK_LAYERS.filter((layer) => layers.has(layer)).forEach((layer) => {
        const raster = chunkRaster(map, layer, i, j, { jiraRooms });
        out.push({
          key: `${chunkKey(map, layer, i, j, { jiraRooms })}@${lod}`, layer, world: chunkWorldRect(map, layer, i, j), lod,
          texture: lod === 1 ? raster : downsample(raster, lod),
        });
      });
    }
  }
  return out;
};

const MIB = 1024 * 1024;

describe('the website scene on the office stage interface', () => {
  const rooms: readonly RoomDTO[] = CLASSIC_ROOMS;
  const map: OfficeMap = buildOffice(rooms);
  const snap = buildSnapshot({
    servers: [server('birch'), server('ash'), server('cedar'), server('local')], rooms, sessions: [session('birch:a')],
    questions: [], luady: luadyStatus(), now: NOW, previousSeats: {}, jiraRooms: ['ash'],
  });

  it('keeps the whole classic office under the 17 MiB gate at lod 1, every chunk at most 512 px', () => {
    const live = liveChunks(map, { x: -320, y: -320, w: map.width + 640, h: map.height + 640 }, 1, ['ash']);
    const bytes = live.reduce((n, c) => n + c.world.w * c.world.h * 4, 0);
    expect(bytes).toBeLessThanOrEqual(17 * MIB);
    live.forEach((c) => {
      expect([c.texture.width, c.texture.height]).toEqual([c.world.w, c.world.h]);
      expect(Math.max(c.texture.width, c.texture.height)).toBeLessThanOrEqual(512);
    });
    expect(new Set(live.map((c) => c.key)).size).toBe(live.length);
  });

  it('shrinks chunks by the lod of the zoom', () => {
    const far = liveChunks(map, map.zones.all, 0.3, []);
    expect(far.every((c) => c.lod === 4 && c.texture.width === Math.ceil(c.world.w / 4))).toBe(true);
  });

  it('walks on the mask, enters by the street doors, and lights the day in the owner zone', () => {
    const mask: WalkMask = walkMask(snap.map, snap.slots, snap.props);
    const doors: readonly TilePoint[] = snap.map.spots.entries;
    doors.forEach((t) => expect(mask.open[t.ty * mask.width + t.tx]).toBe(1));
    const light: Ambience = ambienceAt(Date.UTC(2026, 10, 21, 8), 'Etc/GMT-4');
    expect(light).toEqual({ phase: 'day', light: 1 });
  });

  it('draws rooms, creatures and screens from palettes, with lots and zones from the map', () => {
    const def: RoomDef | undefined = snap.map.rooms.birch;
    const palette: Palette = def?.palette ?? { base: '#000000', accent: '#000000' };
    expect(critterRaster(def?.species ?? 'bun', palette, 'idle', 0).width).toBe(16);
    expect(monitorScreen('work', snap.actors['birch:a']?.look.palette ?? palette).width).toBe(14);
    expect(snap.rooms.birch?.host).toBe('birch');
    expect(snap.map.order[2]).toBe(HQ_ID);
    expect(snap.map.zones.indoor.length).toBeGreaterThan(0);
    expect(snap.map.zones.hqRow).toEqual({ x: 16, y: 16, w: 1312, h: 640 });
    expect(snap.map.grid).toEqual({ slotCount: 4, K: 1, R: 1, capacity: 4 });
    expect(buildOffice(classicRooms([])).order.filter((k) => buildOffice(classicRooms([])).rooms[k]?.kind === 'lot')).toHaveLength(4);
  });
});

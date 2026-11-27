import { buildOffice, chunkKey, chunkRect, chunkWorldRect, roomsMeeting, type OfficeMap, type Raster } from '@luady/office';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fake from './fake-pixi.js';
import { roomsOf } from './office-fixtures.js';

vi.mock('pixi.js', async () => (await import('./fake-pixi.js')).pixiModule);

const { RELEASE_MS, createChunkBank, paintChunk, pixiChunkGpu } = await import('../../../../src/features/agency/scene/chunk-bank.js');
const { createPaintQueue } = await import('../../../../src/features/agency/scene/paint-queue.js');
const { layersOf, liveChunks } = await import('../../../../src/features/agency/scene/live-set.js');

type FakeTexture = InstanceType<typeof fake.Texture>;
const NO_JIRA = { jiraRooms: [] as readonly string[] };

/** A GPU stand-in: it remembers every raster it was handed and every texture it destroyed. */
const fakeGpu = () => {
  const uploads: { raster: Raster; texture: FakeTexture }[] = [];
  return {
    uploads,
    upload: (raster: Raster, label: string) => {
      const texture = new fake.Texture({ label });
      uploads.push({ raster, texture });
      return texture as never;
    },
    destroy: (texture: unknown) => (texture as FakeTexture).destroy(true),
  };
};

const setup = (budget = Number.POSITIVE_INFINITY) => {
  let now = 0;
  const gpu = fakeGpu();
  const bank = createChunkBank({ gpu, queue: createPaintQueue(() => now), clock: () => now, budget });
  return { bank, gpu, tick: (ms: number) => { now += ms; }, now: () => now };
};

/** Every chunk of every layer of a map, at a lod. */
const everyChunk = (map: OfficeMap) => liveChunks(map, { x: -320, y: -320, w: map.width + 640, h: map.height + 640 }, 1, { x: 0, y: 0 })
  .flatMap(({ i, j }) => layersOf(map, i, j).map((layer) => ({ layer, i, j })));

/** Asks for every chunk, then paints until nothing is queued. */
const paintAll = (bank: ReturnType<typeof setup>['bank'], map: OfficeMap, lod: 1 | 2 | 4 | 8 = 1): Set<string> => {
  const keys = new Set<string>();
  everyChunk(map).forEach(({ layer, i, j }) => {
    bank.chunk(layer, map, i, j, lod, NO_JIRA);
    keys.add(bank.keyOf(layer, map, i, j, lod, NO_JIRA));
  });
  while (bank.queued() > 0) bank.paint(Number.POSITIVE_INFINITY);
  return keys;
};

beforeEach(() => fake.resetFakePixi());

describe('paintChunk', () => {
  it('paints a chunk with the office and shrinks it by the lod', () => {
    const map = buildOffice(roomsOf(4));
    const r = chunkWorldRect(map, 'map', 1, 1);
    expect([paintChunk(map, 'map', 1, 1, 1, NO_JIRA).width, paintChunk(map, 'map', 1, 1, 1, NO_JIRA).height]).toEqual([r.w, r.h]);
    expect(paintChunk(map, 'map', 1, 1, 4, NO_JIRA).width).toBe(Math.ceil(r.w / 4));
  });
});

describe('createChunkBank', () => {
  it('returns nothing for a layer that is empty there, and queues a missing chunk until it is painted', () => {
    const { bank, gpu } = setup();
    // With 24 rooms chunk (2, 1), world x 704-1216 and y 192-704, lies wholly inside the building: no garden there.
    const map = buildOffice(roomsOf(24));
    const inside = { i: 2, j: 1 };
    expect(layersOf(map, inside.i, inside.j)).not.toContain('exterior');
    expect(bank.chunk('exterior', map, inside.i, inside.j, 1, NO_JIRA)).toBeNull();
    expect(bank.queued()).toBe(0);
    expect(bank.chunk('map', map, 1, 1, 1, NO_JIRA)).toBeNull();
    expect(bank.queued()).toBe(1);
    bank.paint();
    const texture = bank.chunk('map', map, 1, 1, 1, NO_JIRA);
    expect(texture).toBe(gpu.uploads[0]?.texture);
    expect(bank.queued()).toBe(0);
  });

  it('keys textures by chunkKey and lod, and counts each one at its own size', () => {
    const { bank } = setup();
    const map = buildOffice(roomsOf(4));
    const keys = paintAll(bank, map, 1);
    const halves = paintAll(bank, map, 2);
    const one = bank.keyOf('map', map, 1, 1, 1, NO_JIRA);
    expect(one).toBe(`${chunkKey(map, 'map', 1, 1, NO_JIRA)}@1`);
    // Chunk (1, 1) is world y 192-704, cropped to the map's 672 rows: 512 × 480.
    expect(chunkWorldRect(map, 'map', 1, 1)).toMatchObject({ w: 512, h: 480 });
    expect(bank.peek(one)?.bytes).toBe(512 * 480 * 4);
    expect(bank.peek(bank.keyOf('map', map, 1, 1, 2, NO_JIRA))?.bytes).toBe(256 * 240 * 4);
    const sum = (set: ReadonlySet<string>, layer?: string): number =>
      [...set].reduce((n, k) => n + (layer === undefined || bank.peek(k)?.layer === layer ? (bank.peek(k)?.bytes ?? 0) : 0), 0);
    // Three whole-map textures hold 17,637,376 bytes: the map and the garden in full, daylight at most map-sized.
    expect(sum(keys, 'map')).toBe(1344 * 672 * 4);
    expect(sum(keys, 'exterior')).toBe(1984 * 1312 * 4);
    expect(sum(keys, 'daylight')).toBeLessThanOrEqual(1344 * 672 * 4);
    expect(sum(keys)).toBeLessThanOrEqual(17_637_376);
    expect(bank.stats()).toMatchObject({ textures: keys.size + halves.size, bytes: sum(keys) + sum(halves) });
  });

  it('holds no raster after the upload', () => {
    const { bank, gpu } = setup();
    const map = buildOffice(roomsOf(4));
    const keys = paintAll(bank, map);
    expect(gpu.uploads.length).toBe(keys.size);
    const held = [...keys].map((k) => bank.peek(k));
    held.forEach((entry) => {
      expect(Object.keys(entry ?? {}).sort()).toEqual(['bytes', 'i', 'j', 'layer', 'lod', 'texture']);
      expect(Object.values(entry ?? {}).some((v) => v instanceof Uint8ClampedArray || (typeof v === 'object' && v !== null && 'data' in v))).toBe(false);
    });
  });

  it('releases a texture 2 s after it left the kept set, not before', () => {
    const { bank, gpu, tick } = setup();
    const map = buildOffice(roomsOf(4));
    const keys = [...paintAll(bank, map)];
    const [stay, leave] = keys;
    const kept = new Set([stay ?? '']);
    bank.retain(kept, new Set(), { x: 0, y: 0 });
    tick(RELEASE_MS - 1);
    bank.retain(kept, new Set(), { x: 0, y: 0 });
    expect(bank.peek(leave ?? '')).toBeDefined();
    expect(bank.releasing()).toBe(keys.length - 1);
    tick(1);
    bank.retain(kept, new Set(), { x: 0, y: 0 });
    expect(bank.peek(leave ?? '')).toBeUndefined();
    expect(bank.peek(stay ?? '')).toBeDefined();
    expect(bank.releasing()).toBe(0);
    expect(gpu.uploads.filter((u) => u.texture.destroyed)).toHaveLength(keys.length - 1);
  });

  it('keeps the ring between the live area and twice its margin, and forgets it again once the view comes back', () => {
    const { bank, tick } = setup();
    const map = buildOffice(roomsOf(4));
    const [a, b] = [...paintAll(bank, map)];
    bank.retain(new Set([a ?? '']), new Set([b ?? '']), { x: 0, y: 0 });
    tick(RELEASE_MS * 3);
    bank.retain(new Set([a ?? '']), new Set([b ?? '']), { x: 0, y: 0 });
    expect(bank.peek(b ?? '')).toBeDefined();
  });

  it('evicts the farthest chunks first when over budget, never a live one', () => {
    const map = buildOffice(roomsOf(24));
    const { bank } = setup(6 * 512 * 512 * 4);
    const centre = { x: chunkRect(map, 0, 0).x + 256, y: chunkRect(map, 0, 0).y + 256 };
    const row = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ i, j: 0 }));
    row.forEach(({ i }) => bank.chunk('exterior', map, i, 0, 1, NO_JIRA));
    while (bank.queued() > 0) bank.paint(Number.POSITIVE_INFINITY);
    const key = (i: number): string => bank.keyOf('exterior', map, i, 0, 1, NO_JIRA);
    const live = new Set([key(7)]);
    bank.retain(live, new Set(row.map(({ i }) => key(i))), centre);
    const left = row.filter(({ i }) => bank.peek(key(i)) !== undefined).map(({ i }) => i);
    expect(left).toEqual([0, 1, 2, 3, 4, 7]);
    expect(bank.stats().bytes).toBeLessThanOrEqual(6 * 512 * 512 * 4);
  });

  it('repaints only the chunks that meet a room when its colour changes', () => {
    const { bank } = setup();
    const rooms = roomsOf(24);
    const before = buildOffice(rooms);
    const target = rooms[9]!;
    const after = buildOffice(rooms.map((r) => (r.id === target.id ? { ...r, colour: '#2b8a3e', accent: '#a5d6a7' } : r)));
    expect(after.layoutKey).toBe(before.layoutKey);
    paintAll(bank, before);
    const touched = everyChunk(after).filter(({ layer, i, j }) => bank.chunk(layer, after, i, j, 1, NO_JIRA) === null);
    const room = after.rooms[target.id]!;
    const meets = touched.every(({ i, j }) => roomsMeeting(after, chunkRect(after, i, j)).some((r) => r.id === room.id));
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every(({ layer }) => layer === 'map')).toBe(true);
    expect(meets).toBe(true);
    expect(bank.queued()).toBe(touched.length);
  });

  it('drops every chunk and its queued work on a lost context, and paints again', () => {
    const { bank, gpu } = setup();
    const map = buildOffice(roomsOf(4));
    const keys = paintAll(bank, map);
    const generation = bank.generation();
    bank.chunk('map', map, 0, 0, 2, NO_JIRA);
    bank.invalidate();
    expect(bank.generation()).toBe(generation + 1);
    expect(bank.stats()).toMatchObject({ textures: 0, bytes: 0, queued: 0 });
    expect(gpu.uploads.every((u) => u.texture.destroyed)).toBe(true);
    expect(paintAll(bank, map).size).toBe(keys.size);
    expect(bank.stats().textures).toBe(keys.size);
  });
});

describe('pixiChunkGpu', () => {
  it('uploads at once, then lets the raster go: the source keeps no copy', () => {
    const initSource = vi.fn();
    const gpu = pixiChunkGpu({ texture: { initSource } } as never);
    const raster = paintChunk(buildOffice(roomsOf(4)), 'map', 1, 1, 2, NO_JIRA);
    const texture = gpu.upload(raster, 'chunk') as unknown as FakeTexture;
    const source = texture.source as InstanceType<typeof fake.BufferImageSource>;
    expect(initSource).toHaveBeenCalledWith(source);
    expect(source.options).toMatchObject({ width: raster.width, height: raster.height, format: 'rgba8unorm', scaleMode: 'nearest' });
    expect(source.resource).toBeNull();
    gpu.destroy(texture as never);
    expect(source.destroyed).toBe(true);
  });
});

import {
  chunkKey, chunkRaster, chunkRect, downsample, type ChunkLayer, type ChunkOptions, type OfficeMap, type PixelPoint, type Raster,
} from '@luady/office';
import { BufferImageSource, Texture } from 'pixi.js';
import type { Lod } from './live-set.js';
import { layersOf } from './live-set.js';
import { createPaintQueue, type PaintQueue } from './paint-queue.js';

/**
 * The map-sized pictures as chunk textures of at most 512 px. A texture is held
 * under its chunkKey and lod and counted at its own size. Missing chunks are painted by the paint queue, nearest the
 * view centre first. Textures the view no longer keeps are released RELEASE_MS after they left it, and an LRU keeps
 * the total within the budget, the chunks farthest from the view going first. After upload no CPU copy is kept.
 */

/** A chunk texture is released this long after it left the kept set. */
export const RELEASE_MS = 2000;
/** What a paint is assumed to cost before any was measured, in ms (about 5 ms a map chunk). */
const FIRST_GUESS_MS = 6;

/** The paint of one chunk, pure (so it could run in a Web Worker): the office paints it, then it is shrunk for lod > 1. */
export function paintChunk(map: OfficeMap, layer: ChunkLayer, i: number, j: number, lod: Lod, options: ChunkOptions): Raster {
  const raster = chunkRaster(map, layer, i, j, options);
  return lod === 1 || raster.width === 0 || raster.height === 0 ? raster : downsample(raster, lod);
}

/** The GPU side: uploads a raster as a nearest-scaled texture that keeps no reference to it, and destroys one. */
export interface ChunkGpu {
  upload(raster: Raster, label: string): Texture;
  destroy(texture: Texture): void;
}

/** What the renderer is asked for: uploading a source now, instead of on its first draw. */
interface TextureUploader { readonly texture: { initSource(source: BufferImageSource): void } }

/**
 * The real GPU side: the raster is uploaded at once (the WebGL texture system's initSource), then the source lets go
 * of it, so the CPU copy can be collected. The source is not garbage-collected by PixiJS (its
 * autoGarbageCollect stays off); after a lost context the bank repaints every live chunk (see invalidate).
 */
export function pixiChunkGpu(renderer: TextureUploader): ChunkGpu {
  return {
    upload: (raster, label) => {
      const pixels = new Uint8Array(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength);
      const source = new BufferImageSource({
        resource: pixels, width: raster.width, height: raster.height, format: 'rgba8unorm', scaleMode: 'nearest', label,
      });
      const texture = new Texture({ source, label });
      renderer.texture.initSource(source);
      (source as unknown as { resource: unknown }).resource = null;
      return texture;
    },
    destroy: (texture) => texture.destroy(true),
  };
}

/** A held texture: what it shows and how much it costs. No raster. */
export interface ChunkEntry {
  readonly texture: Texture | null;
  readonly layer: ChunkLayer;
  readonly i: number;
  readonly j: number;
  readonly lod: Lod;
  readonly bytes: number;
}

export interface ChunkBankStats {
  readonly textures: number;
  readonly bytes: number;
  /** Chunks waiting to be painted. */
  readonly queued: number;
  /** Textures that left the kept set and wait for their release. */
  readonly releasing: number;
  /** The longest side of any texture held, in texels (at most 512). */
  readonly largestSide: number;
}

export interface ChunkBank {
  /**
   * The texture of a layer's chunk at a lod: null when the layer is empty there (chunkLayers), and null while it is
   * not painted yet, when it is queued with `priority` (smaller paints sooner).
   */
  chunk(layer: ChunkLayer, map: OfficeMap, i: number, j: number, lod: Lod, options: ChunkOptions, priority?: number): Texture | null;
  /** The key a chunk's texture is held under: its chunkKey and lod. */
  keyOf(layer: ChunkLayer, map: OfficeMap, i: number, j: number, lod: Lod, options: ChunkOptions): string;
  /**
   * The view's keys: `live` (shown or wanted now) and `ring` (wanted soon: within twice the margin). Every other
   * texture starts its RELEASE_MS countdown, queued work for keys not live is dropped, and the LRU evicts down to the
   * budget, farthest from `centre` first: textures outside both sets, then the ring; never a live one.
   */
  retain(live: ReadonlySet<string>, ring: ReadonlySet<string>, centre: PixelPoint): void;
  /** One slice of painting (about 8 ms a frame). Returns the chunks painted. */
  paint(budgetMs?: number): number;
  setBudget(bytes: number): void;
  /** A lost WebGL context: every texture and queued paint goes; the generation moves on so sprites let go of theirs. */
  invalidate(): void;
  generation(): number;
  /** Moves on whenever a texture is added or released: what is shown may have to change. */
  version(): number;
  queued(): number;
  releasing(): number;
  peek(key: string): ChunkEntry | undefined;
  stats(): ChunkBankStats;
  destroy(): void;
}

export interface ChunkBankOptions {
  readonly gpu: ChunkGpu;
  readonly queue?: PaintQueue;
  /** ms; performance.now by default. */
  readonly clock?: () => number;
  /** Bytes; no limit by default. */
  readonly budget?: number;
}

interface Held { entry: ChunkEntry; leftAt: number | null }

const jiraKeyOf = (options: ChunkOptions): string => (options.jiraRooms ?? []).join(',');

/** chunkKey per map, layer, chunk and Jira set, worked out once: the scene asks every frame. */
const KEYS = new WeakMap<OfficeMap, Map<string, string>>();
const keyFor = (map: OfficeMap, layer: ChunkLayer, i: number, j: number, options: ChunkOptions): string => {
  let known = KEYS.get(map);
  if (known === undefined) {
    known = new Map();
    KEYS.set(map, known);
  }
  const at = `${layer}|${i},${j}|${jiraKeyOf(options)}`;
  const cached = known.get(at);
  if (cached !== undefined) return cached;
  const made = chunkKey(map, layer, i, j, options);
  known.set(at, made);
  return made;
};

const centreOf = (map: OfficeMap, i: number, j: number): PixelPoint => {
  const r = chunkRect(map, i, j);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
};

export function createChunkBank(options: ChunkBankOptions): ChunkBank {
  const clock = options.clock ?? (() => performance.now());
  const queue = options.queue ?? createPaintQueue(clock);
  const { gpu } = options;
  const held = new Map<string, Held>();
  /** Where each held chunk's centre is, for the farthest-first eviction (same map grid for every layer). */
  const centres = new Map<string, PixelPoint>();
  /** Each held texture's longer side, for the stats. */
  const sides = new Map<string, number>();
  const costs = new Map<Lod, number>();
  let budget = options.budget ?? Number.POSITIVE_INFINITY;
  let bytes = 0;
  let generation = 0;
  let version = 0;

  const release = (key: string, h: Held): void => {
    if (h.entry.texture !== null) gpu.destroy(h.entry.texture);
    bytes -= h.entry.bytes;
    held.delete(key);
    centres.delete(key);
    sides.delete(key);
    version += 1;
  };

  const store = (key: string, entry: ChunkEntry, centre: PixelPoint, side: number): void => {
    const old = held.get(key);
    if (old !== undefined) release(key, old);
    held.set(key, { entry, leftAt: null });
    centres.set(key, centre);
    sides.set(key, side);
    bytes += entry.bytes;
    version += 1;
  };

  const learn = (lod: Lod, ms: number): void => {
    const was = costs.get(lod) ?? FIRST_GUESS_MS;
    costs.set(lod, was * 0.7 + Math.max(0, ms) * 0.3);
  };

  const enqueue = (key: string, map: OfficeMap, layer: ChunkLayer, i: number, j: number, lod: Lod, chunkOptions: ChunkOptions, priority: number): void => {
    const born = generation;
    queue.enqueue({
      key, priority, cost: costs.get(lod) ?? FIRST_GUESS_MS,
      run: () => {
        if (born !== generation) return;
        const start = clock();
        const raster = paintChunk(map, layer, i, j, lod, chunkOptions);
        const empty = raster.width === 0 || raster.height === 0;
        const texture = empty ? null : gpu.upload(raster, `chunk:${layer}:${i},${j}@${lod}`);
        learn(lod, clock() - start);
        const entry = Object.freeze({ texture, layer, i, j, lod, bytes: empty ? 0 : raster.width * raster.height * 4 });
        store(key, entry, centreOf(map, i, j), Math.max(raster.width, raster.height));
      },
    });
  };

  const distance = (key: string, centre: PixelPoint): number => {
    const c = centres.get(key);
    return c === undefined ? 0 : Math.hypot(c.x - centre.x, c.y - centre.y);
  };

  const evict = (live: ReadonlySet<string>, ring: ReadonlySet<string>, centre: PixelPoint): void => {
    if (bytes <= budget) return;
    const candidates = [...held.keys()].filter((key) => !live.has(key))
      .map((key) => ({ key, tier: ring.has(key) ? 1 : 0, far: distance(key, centre) }))
      .sort((a, b) => a.tier - b.tier || b.far - a.far);
    for (const { key } of candidates) {
      if (bytes <= budget) return;
      const h = held.get(key);
      if (h !== undefined) release(key, h);
    }
  };

  return {
    chunk: (layer, map, i, j, lod, chunkOptions, priority = 0) => {
      if (!layersOf(map, i, j).includes(layer)) return null;
      const key = `${keyFor(map, layer, i, j, chunkOptions)}@${lod}`;
      const h = held.get(key);
      if (h !== undefined) return h.entry.texture;
      enqueue(key, map, layer, i, j, lod, chunkOptions, priority);
      return null;
    },
    keyOf: (layer, map, i, j, lod, chunkOptions) => `${keyFor(map, layer, i, j, chunkOptions)}@${lod}`,
    retain: (live, ring, centre) => {
      const now = clock();
      queue.retain((key) => live.has(key));
      held.forEach((h, key) => {
        if (live.has(key) || ring.has(key)) {
          h.leftAt = null;
          return;
        }
        if (h.leftAt === null) h.leftAt = now;
        else if (now - h.leftAt >= RELEASE_MS) release(key, h);
      });
      evict(live, ring, centre);
    },
    paint: (budgetMs) => queue.slice(budgetMs),
    setBudget: (next) => { budget = Math.max(0, next); },
    invalidate: () => {
      generation += 1;
      queue.clear();
      [...held.entries()].forEach(([key, h]) => release(key, h));
    },
    generation: () => generation,
    version: () => version,
    queued: () => queue.size(),
    releasing: () => [...held.values()].filter((h) => h.leftAt !== null).length,
    peek: (key) => held.get(key)?.entry,
    stats: () => Object.freeze({
      textures: held.size, bytes, queued: queue.size(), releasing: [...held.values()].filter((h) => h.leftAt !== null).length,
      largestSide: Math.max(0, ...sides.values()),
    }),
    destroy: () => {
      generation += 1;
      queue.clear();
      [...held.entries()].forEach(([key, h]) => release(key, h));
    },
  };
}

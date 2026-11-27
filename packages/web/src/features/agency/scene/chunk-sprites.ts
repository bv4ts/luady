import { chunkWorldRect, type ChunkLayer, type ChunkOptions, type OfficeMap, type PixelPoint } from '@luady/office';
import { Container, Sprite, Texture } from 'pixi.js';
import type { ChunkBank } from './chunk-bank.js';
import { layersOf, type LiveView } from './live-set.js';

/**
 * One map-sized picture drawn as chunk sprites: a sprite per live chunk of the layer, placed at the
 * chunk's cropped rectangle (chunkWorldRect; chunkRect only culls) and scaled by its texture's lod. Until a chunk's
 * texture for the wanted lod is painted, the one it shows (another lod, or the same chunk before a room was
 * recoloured) stays; with none, the chunk shows nothing. Sprites of chunks that left the view are destroyed; their
 * textures stay in the bank until it releases them.
 */
export interface ChunkSprites {
  readonly root: Container;
  /** Brings the sprites in line with the view. Cheap to repeat: textures come from the bank, keys are memoised. */
  sync(map: OfficeMap, view: LiveView, options: ChunkOptions): void;
  /** Adds the keys this layer shows or wants now to `live`, and those of the kept ring to `ring`. */
  keep(live: Set<string>, ring: Set<string>): void;
  /** Live chunks not yet showing their wanted texture: work in flight. */
  behind(): number;
  /** Sprites drawn now. */
  count(): number;
  /** Drops every sprite (far from a lost context's textures). */
  clear(): void;
  destroy(): void;
}

interface Cell { readonly sprite: Sprite; shown: string | null; layoutKey: string; want: string }

/** `origin`: where the root container stands in the world (its sprites are placed relative to it). */
export function createChunkSprites(bank: ChunkBank, layer: ChunkLayer, label: string, origin: PixelPoint = { x: 0, y: 0 }): ChunkSprites {
  const root = new Container();
  Object.assign(root, { label, x: origin.x, y: origin.y });
  let cells = new Map<string, Cell>();
  let ring: readonly string[] = [];
  let generation = bank.generation();

  const drop = (cell: Cell): void => cell.sprite.destroy();

  const clear = (): void => {
    cells.forEach(drop);
    cells = new Map();
    ring = [];
  };

  return {
    root,
    sync: (map, view, options) => {
      if (bank.generation() !== generation) {
        generation = bank.generation();
        clear();
      }
      const next = new Map<string, Cell>();
      view.chunks.forEach(({ i, j, distance }) => {
        if (!layersOf(map, i, j).includes(layer)) return;
        const at = `${i},${j}`;
        const want = bank.keyOf(layer, map, i, j, view.lod, options);
        const cell = cells.get(at) ?? { sprite: Object.assign(new Sprite(Texture.EMPTY), { label: `${label}:${at}`, visible: false }), shown: null, layoutKey: '', want };
        cell.want = want;
        const texture = bank.chunk(layer, map, i, j, view.lod, options, distance);
        if (texture !== null) {
          const r = chunkWorldRect(map, layer, i, j);
          cell.sprite.texture = texture;
          cell.sprite.scale.set(view.lod);
          Object.assign(cell.sprite, { x: r.x - origin.x, y: r.y - origin.y, visible: true });
          cell.shown = want;
          cell.layoutKey = map.layoutKey;
        } else if (cell.shown !== null && cell.layoutKey !== map.layoutKey) {
          // The building changed shape: the old picture of this chunk shows the wrong rooms.
          cell.sprite.visible = false;
          cell.shown = null;
        }
        if (cell.sprite.parent !== root) root.addChild(cell.sprite);
        next.set(at, cell);
      });
      cells.forEach((cell, at) => { if (next.get(at) !== cell) drop(cell); });
      cells = next;
      ring = view.ring.flatMap(({ i, j }) => (layersOf(map, i, j).includes(layer) ? [bank.keyOf(layer, map, i, j, view.lod, options)] : []));
    },
    keep: (live, kept) => {
      cells.forEach((cell) => {
        live.add(cell.want);
        if (cell.shown !== null) live.add(cell.shown);
      });
      ring.forEach((key) => kept.add(key));
    },
    behind: () => [...cells.values()].filter((cell) => cell.shown !== cell.want).length,
    count: () => cells.size,
    clear,
    destroy: () => {
      clear();
      root.destroy({ children: true });
    },
  };
}

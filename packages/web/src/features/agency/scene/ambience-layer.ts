import { EXTERIOR_MARGIN, HQ_ID, lampFeet, panesOf, roomRectPx, type AgencySnapshot, type OfficeMap, type PaneDef } from '@luady/office';
import { Container, Sprite, Texture } from 'pixi.js';
import { DUSK_LOOK, lookAt, sameLook, type AmbienceLook, type LookOptions } from './ambience-look.js';
import type { ChunkBank } from './chunk-bank.js';
import { createChunkSprites } from './chunk-sprites.js';
import { mergeRects } from './indoor-rects.js';
import { contains, type LiveView } from './live-set.js';
import type { TextureBank } from './textures.js';
import type { WorldLayer } from './world-layer.js';

/** Day and night on the map: reads the clock once a minute and redraws only when the light changes. */
export interface AmbienceLayer {
  /** Takes the office's lamps, panes, indoor parts and HQ (redone only when the rooms change), and the view with a new map. */
  update(snapshot: AgencySnapshot, view?: LiveView): void;
  /** What the camera shows: daylight chunks, and the lamps and panes in reach (none in far mode). */
  setView(view: LiveView): void;
  /** Adds the daylight chunk keys shown or wanted (see ChunkSprites.keep). */
  keep(live: Set<string>, ring: Set<string>): void;
  /** Live daylight chunks not yet showing their wanted texture. */
  behind(): number;
  setOptions(options: LookOptions): void;
  /** Once per frame with a steady clock (ms): reads the time of day when a minute has passed or the options changed. */
  tick(nowMs: number): void;
  /** The look shown now (for tests and the screenshots). */
  look(): AmbienceLook;
}

/** How often the time of day is read. */
export const CLOCK_EVERY_MS = 60_000;
const GROUND_REACH = 4096;
const TINT = Object.freeze({ gardenDay: 0x24301a, indoorDay: 0x1c160a, sun: 0xffe2a0, lamp: 0xffc870, quiet: 0x05070d });
/** Pool sizes: under a lamp, and outside a pane in a side wall or in the south wall. */
const POOLS: Readonly<Record<'lamp' | 'side' | 'south', { readonly rx: number; readonly ry: number }>> = Object.freeze({
  lamp: { rx: 26, ry: 12 }, side: { rx: 10, ry: 18 }, south: { rx: 18, ry: 8 },
});

/**
 * The wall clock in owner time, in epoch ms. A test or the preview's screenshot script may fix it with a number in
 * `globalThis.__LUADY_CLOCK__`; nothing on the page sets it.
 */
export function readClock(): number {
  const hook = (globalThis as { __LUADY_CLOCK__?: unknown }).__LUADY_CLOCK__;
  return typeof hook === 'number' && Number.isFinite(hook) ? hook : Date.now();
}

const block = (tint: number, add: boolean, label: string): Sprite => {
  const s = new Sprite(Texture.WHITE);
  Object.assign(s, { tint, alpha: 0, visible: false, label });
  if (add) s.blendMode = 'add';
  return s;
};

/** A group whose children share its tint, alpha and blend mode (PixiJS 8 passes them down). */
const group = (tint: number, label: string): Container => {
  const c = new Container();
  Object.assign(c, { tint, alpha: 0, visible: false, label });
  c.blendMode = 'add';
  return c;
};

const pool = (texture: Texture, x: number, y: number, label: string): Sprite => {
  const s = new Sprite(texture);
  s.anchor.set(0.5, 0.5);
  Object.assign(s, { x, y, tint: TINT.lamp, alpha: 0, visible: false, label });
  s.blendMode = 'add';
  return s;
};

/** Where a pane spills its light outside, and which pool shape it uses. */
const spillOf = (pane: PaneDef): { readonly x: number; readonly y: number; readonly shape: 'side' | 'south' } => {
  const g = pane.glass;
  if (pane.side === 'west') return { x: g.x - 8, y: g.y + g.h / 2, shape: 'side' };
  if (pane.side === 'east') return { x: g.x + g.w + 8, y: g.y + g.h / 2, shape: 'side' };
  return { x: g.x + g.w / 2, y: g.y + g.h + 8, shape: 'south' };
};

const setAlpha = (nodes: readonly Container[], alpha: number): void =>
  nodes.forEach((s) => Object.assign(s, { alpha, visible: alpha > 0.001 }));

/** One lamp or pane of the office: where it is, and its sprites while it is in reach. */
interface Light { readonly at: { readonly x: number; readonly y: number }; readonly make: () => readonly Sprite[]; sprites: readonly Sprite[] | null }

export function createAmbienceLayer(world: WorldLayer, bank: TextureBank, chunks: ChunkBank): AmbienceLayer {
  const gardenDay = block(TINT.gardenDay, true, 'garden-day');
  const indoorDay = group(TINT.indoorDay, 'indoor-day');
  const sun = group(TINT.sun, 'sunlight');
  const daylight = createChunkSprites(chunks, 'daylight', 'daylight');
  sun.addChild(daylight.root);
  const quiet = block(TINT.quiet, false, 'quiet');
  const lamps = Object.assign(new Container(), { label: 'lamps' });
  const panes = Object.assign(new Container(), { label: 'panes' });
  world.light.garden.addChild(gardenDay, lamps);
  world.light.indoor.addChild(indoorDay, sun, panes);
  world.light.over.addChild(quiet);
  let lights: Light[] = [];
  let mapKey = '';
  let map: OfficeMap | null = null;
  let view: LiveView | null = null;
  let options: LookOptions = { enabled: true, quiet: false, reduced: false };
  let shown: AmbienceLook | null = null;
  let checkedAt = Number.NEGATIVE_INFINITY;

  const drawn = (kind: 'lamp' | 'spill' | 'glass'): Sprite[] =>
    lights.flatMap((l) => l.sprites ?? []).filter((s) => (kind === 'lamp' ? s.label === 'lamp-light' : kind === 'spill' ? s.label === 'pane-spill' : s.label === 'pane-glass'));

  /** Applies the look to the lamps and panes drawn now (new ones take it when they appear). */
  const lightUp = (look: AmbienceLook): void => {
    setAlpha(drawn('lamp'), look.lamps);
    setAlpha(drawn('spill'), look.spill);
    const glass = drawn('glass');
    setAlpha(glass, look.glass);
    glass.forEach((s) => { s.tint = look.glassTint; });
  };

  /** Lamps and panes in the chunk area get sprites; those that left it lose them; in far mode none are drawn. */
  const cull = (): void => {
    lights.forEach((l) => {
      const wanted = view === null || (!view.far && contains(view.area, l.at.x, l.at.y));
      if (wanted && l.sprites === null) l.sprites = l.make();
      else if (!wanted && l.sprites !== null) {
        l.sprites.forEach((s) => s.destroy());
        l.sprites = null;
      }
    });
    if (shown !== null) lightUp(shown);
  };

  const place = (next: OfficeMap): void => {
    lights.forEach((l) => l.sprites?.forEach((s) => s.destroy()));
    const lampLights: Light[] = lampFeet(next).map(([x, y]) => {
      const at = { x: x - EXTERIOR_MARGIN, y: y - EXTERIOR_MARGIN + 2 };
      return { at, sprites: null, make: () => [lamps.addChild(pool(bank.glowPool(POOLS.lamp.rx, POOLS.lamp.ry), at.x, at.y, 'lamp-light'))] };
    });
    const paneLights: Light[] = panesOf(next).map((p) => {
      const spill = spillOf(p);
      return {
        at: { x: p.glass.x, y: p.glass.y }, sprites: null,
        make: () => {
          const s = block(0xffffff, false, 'pane-glass');
          Object.assign(s, { x: p.glass.x, y: p.glass.y, width: p.glass.w, height: p.glass.h });
          return [lamps.addChild(pool(bank.glowPool(POOLS[spill.shape].rx, POOLS[spill.shape].ry), spill.x, spill.y, 'pane-spill')), panes.addChild(s)];
        },
      };
    });
    lights = [...lampLights, ...paneLights];
    Object.assign(gardenDay, { x: -GROUND_REACH, y: -GROUND_REACH, width: next.width + GROUND_REACH * 2, height: next.height + GROUND_REACH * 2 });
    indoorDay.removeChildren().forEach((c) => c.destroy());
    mergeRects(next.zones.indoor).forEach((r) => {
      const s = new Sprite(Texture.WHITE);
      Object.assign(s, { x: r.x, y: r.y, width: r.w, height: r.h, label: 'indoor-day-part' });
      indoorDay.addChild(s);
    });
    const hq = next.rooms[HQ_ID];
    if (hq !== undefined) {
      const q = roomRectPx(hq);
      Object.assign(quiet, { x: q.x, y: q.y, width: q.w, height: q.h });
    }
    cull();
  };

  const show = (look: AmbienceLook): void => {
    world.garden.tint = look.gardenTint;
    world.building.tint = look.buildingTint;
    setAlpha([gardenDay], look.gardenDay);
    setAlpha([indoorDay], look.indoorDay);
    setAlpha([sun], look.sun * 0.24);
    lightUp(look);
    setAlpha([quiet], look.quiet);
    shown = look;
  };

  const refresh = (nowMs: number): void => {
    checkedAt = nowMs;
    const next = lookAt(readClock(), options);
    if (shown === null || !sameLook(shown, next)) show(next);
  };

  return {
    update: (snapshot, nextView) => {
      map = snapshot.map;
      if (nextView !== undefined) view = nextView;
      const key = `${snapshot.map.layoutKey}#${snapshot.map.width}x${snapshot.map.height}`;
      if (key !== mapKey) {
        mapKey = key;
        place(snapshot.map);
        if (shown !== null) show(shown);
      }
      if (view !== null) daylight.sync(snapshot.map, view, {});
    },
    setView: (next) => {
      view = next;
      cull();
      if (map !== null) daylight.sync(map, next, {});
    },
    keep: (live, ring) => daylight.keep(live, ring),
    behind: () => daylight.behind(),
    setOptions: (next) => {
      if (next.enabled === options.enabled && next.quiet === options.quiet && next.reduced === options.reduced) return;
      options = next;
      checkedAt = Number.NEGATIVE_INFINITY;
    },
    tick: (nowMs) => {
      if (nowMs - checkedAt >= CLOCK_EVERY_MS || checkedAt === Number.NEGATIVE_INFINITY) refresh(nowMs);
    },
    look: () => shown ?? DUSK_LOOK,
  };
}

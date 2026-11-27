import type { AgencySnapshot } from '@luady/office';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeGpu, viewRect, wholeRect } from './chunk-kit.js';
import * as fake from './fake-pixi.js';
import { many, roomSnap, roomsOf, snap } from './office-fixtures.js';

vi.mock('pixi.js/unsafe-eval', () => ({}));
vi.mock('pixi.js', async () => (await import('./fake-pixi.js')).pixiModule);

const { CLOCK_EVERY_MS, createAmbienceLayer, readClock } = await import('../../../../src/features/agency/scene/ambience-layer.js');
const { createWorldLayer } = await import('../../../../src/features/agency/scene/world-layer.js');
const { createTextureBank } = await import('../../../../src/features/agency/scene/textures.js');
const { createChunkBank } = await import('../../../../src/features/agency/scene/chunk-bank.js');
const { liveView } = await import('../../../../src/features/agency/scene/live-set.js');
const { DUSK_LOOK } = await import('../../../../src/features/agency/scene/ambience-look.js');

type Node = InstanceType<typeof fake.Container>;
type SpriteNode = InstanceType<typeof fake.Sprite>;
/** Epoch ms of an owner wall-clock time (the test zone, UTC+4). */
const ownerClock = (h: number, m = 0): number => Date.UTC(2026, 10, 15, h - 4, m);
const hook = globalThis as { __LUADY_CLOCK__?: unknown };
const tintOf = (node: unknown): number => (node as { tint: number }).tint;

const setup = (office: AgencySnapshot = snap(many('birch', 2))) => {
  const chunks = createChunkBank({ gpu: fakeGpu() });
  const world = createWorldLayer(createTextureBank(), chunks);
  world.update(office);
  const ambience = createAmbienceLayer(world, createTextureBank(), chunks);
  ambience.update(office);
  const nodes = (label: string): Node[] => (world.root as unknown as Node).all().filter((n) => n.label === label);
  const show = (rect = wholeRect(office.map), scale = 1): void => {
    const view = liveView(office.map, rect, scale, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
    ambience.setView(view);
    while (chunks.queued() > 0) chunks.paint(Number.POSITIVE_INFINITY);
    ambience.setView(view);
  };
  return { world, ambience, office, nodes, show, chunks };
};

beforeEach(() => fake.resetFakePixi());
afterEach(() => { delete hook.__LUADY_CLOCK__; });

describe('readClock', () => {
  it('is the real clock unless a test fixes it with a number', () => {
    expect(Math.abs(readClock() - Date.now())).toBeLessThan(1000);
    hook.__LUADY_CLOCK__ = 12345;
    expect(readClock()).toBe(12345);
    hook.__LUADY_CLOCK__ = 'noon';
    expect(Math.abs(readClock() - Date.now())).toBeLessThan(1000);
  });
});

describe('createAmbienceLayer', () => {
  it('places a pool under every lamp and glass in every pane', () => {
    const { nodes } = setup();
    expect(nodes('lamp-light').length).toBeGreaterThanOrEqual(10);
    expect(nodes('pane-glass').length).toBe(nodes('pane-spill').length);
    expect(nodes('pane-glass').length).toBeGreaterThan(10);
  });

  it('lights the office by day: garden and floors lifted, sun through the panes, glass showing the sky', () => {
    hook.__LUADY_CLOCK__ = ownerClock(12);
    const { ambience, nodes, world } = setup();
    ambience.tick(0);
    expect(ambience.look().sun).toBe(1);
    expect(nodes('sunlight')[0]?.visible).toBe(true);
    expect(nodes('garden-day')[0]?.alpha).toBe(1);
    expect(nodes('lamp-light').every((n) => !n.visible)).toBe(true);
    expect(tintOf(world.garden)).toBe(0xffffff);
  });

  it('darkens the garden and lights lamps and panes at night', () => {
    hook.__LUADY_CLOCK__ = ownerClock(21);
    const { ambience, nodes, world } = setup();
    ambience.tick(0);
    expect(tintOf(world.garden)).not.toBe(0xffffff);
    expect(nodes('lamp-light').every((n) => n.visible && n.alpha > 0.4)).toBe(true);
    expect(nodes('pane-glass').every((n) => n.visible)).toBe(true);
    expect(nodes('sunlight')[0]?.visible).toBe(false);
  });

  it('reads the clock once a minute, not every frame', () => {
    hook.__LUADY_CLOCK__ = ownerClock(12);
    const { ambience } = setup();
    ambience.tick(1000);
    hook.__LUADY_CLOCK__ = ownerClock(21);
    ambience.tick(1000 + CLOCK_EVERY_MS - 1);
    expect(ambience.look().sun).toBe(1);
    ambience.tick(1000 + CLOCK_EVERY_MS);
    expect(ambience.look().sun).toBe(0);
    expect(ambience.look().lamps).toBeGreaterThan(0);
  });

  it('lets the sun in through daylight chunks under one tinted, additive group', () => {
    hook.__LUADY_CLOCK__ = ownerClock(12);
    const { ambience, nodes, show, office } = setup();
    show();
    ambience.tick(0);
    const sun = nodes('sunlight')[0] as unknown as SpriteNode & { blendMode: string };
    expect(sun).toMatchObject({ visible: true, tint: 0xffe2a0, blendMode: 'add' });
    expect(sun.alpha).toBeCloseTo(0.24, 6);
    const parts = (sun as unknown as Node).all().filter((n) => n.label.startsWith('daylight:'));
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.length).toBeLessThanOrEqual(office.map.chunks.cols * office.map.chunks.rows);
  });

  it('lifts the floors by day over the indoor parts only: one piece for one band, the courts left out with more', () => {
    hook.__LUADY_CLOCK__ = ownerClock(12);
    const classic = setup();
    classic.ambience.tick(0);
    const pieces = (n: Node[]): SpriteNode[] => (n[0]?.children ?? []) as SpriteNode[];
    const one = pieces(classic.nodes('indoor-day'));
    expect(one.map((s) => ({ x: s.x, y: s.y, w: s.width, h: s.height }))).toEqual([classic.office.map.zones.all]);
    expect(classic.nodes('indoor-day')[0]?.alpha).toBeCloseTo(0.35, 6);
    const big = setup(roomSnap(roomsOf(24)));
    const area = pieces(big.nodes('indoor-day')).reduce((n, s) => n + s.width * s.height, 0);
    // The union of the indoor parts, tile by tile (some of them share tiles, so their areas do not simply add up).
    const { width, height, zones } = big.office.map;
    const tiles = new Uint8Array((width / 16) * (height / 16));
    zones.indoor.forEach((r) => {
      for (let y = r.y / 16; y < (r.y + r.h) / 16; y += 1) for (let x = r.x / 16; x < (r.x + r.w) / 16; x += 1) tiles[y * (width / 16) + x] = 1;
    });
    const union = tiles.reduce((n, t) => n + t, 0) * 256;
    expect(area).toBe(union);
    pieces(big.nodes('indoor-day')).forEach((s, i, all) => all.slice(i + 1).forEach((o) => {
      const apart = s.x + s.width <= o.x || o.x + o.width <= s.x || s.y + s.height <= o.y || o.y + o.height <= s.y;
      expect(apart).toBe(true);
    }));
    const all = zones.all;
    expect(area).toBeLessThan(all.w * all.h);
    expect(pieces(big.nodes('indoor-day')).length).toBeLessThan(big.office.map.zones.indoor.length / 3);
  });

  it('draws the lamps and panes in reach only, and none in far mode', () => {
    const office = roomSnap(roomsOf(100));
    const { nodes, show } = setup(office);
    const every = nodes('lamp-light').length;
    const all = office.map.zones.all;
    show(viewRect({ x: all.x + 200, y: all.y + 200 }, 1, 1440, 900), 1);
    const near = nodes('lamp-light').length + nodes('pane-glass').length;
    expect(near).toBeLessThan(every);
    show(viewRect({ x: all.x + all.w / 2, y: all.y + all.h / 2 }, 0.2, 1440, 900), 0.2);
    expect(nodes('lamp-light').length + nodes('pane-glass').length + nodes('pane-spill').length).toBe(0);
  });

  it('shows the dusk look when switched off, lowers HQ in quiet hours, and re-reads at once when the options change', () => {
    hook.__LUADY_CLOCK__ = ownerClock(12);
    const { ambience, nodes } = setup();
    ambience.tick(0);
    ambience.setOptions({ enabled: false, quiet: false, reduced: false });
    ambience.tick(10);
    expect(ambience.look()).toBe(DUSK_LOOK);
    ambience.setOptions({ enabled: true, quiet: true, reduced: false });
    ambience.tick(20);
    expect(nodes('quiet')[0]?.visible).toBe(true);
    expect(ambience.look().sun).toBe(1);
  });
});

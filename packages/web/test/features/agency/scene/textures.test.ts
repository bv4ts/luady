import { chunkWorldRect, critterRaster, roomsMeeting, chunkRect, type AgencySnapshot } from '@luady/office';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { P, fakeGpu, viewRect, wholeRect } from './chunk-kit.js';
import * as fake from './fake-pixi.js';
import { CLASSIC, many, roomSnap, roomsOf, server, snap } from './office-fixtures.js';

vi.mock('pixi.js/unsafe-eval', () => ({}));
vi.mock('pixi.js', async () => (await import('./fake-pixi.js')).pixiModule);

const { createTextureBank } = await import('../../../../src/features/agency/scene/textures.js');
const { createWorldLayer } = await import('../../../../src/features/agency/scene/world-layer.js');
const { RELEASE_MS, createChunkBank } = await import('../../../../src/features/agency/scene/chunk-bank.js');
const { createPaintQueue } = await import('../../../../src/features/agency/scene/paint-queue.js');
const { liveView } = await import('../../../../src/features/agency/scene/live-set.js');

type Node = InstanceType<typeof fake.Container>;
type SpriteNode = InstanceType<typeof fake.Sprite>;
const labelled = (root: Node, prefix: string): Node[] => root.all().filter((n) => n.label.startsWith(prefix));
/** Every desk of every room in the snapshot. */
const deskCount = (s: AgencySnapshot): number => Object.values(s.slots).reduce((n, list) => n + list.length, 0);
const deskAt = (world: { sorted: unknown }, at: { x: number; y: number } | undefined): Node | undefined =>
  labelled(world.sorted as Node, 'desk:').find((d) => d.x === at?.x && d.y === at.y);
const screenOf = (desk: Node | undefined): unknown => (desk?.children[2] as SpriteNode | undefined)?.texture;
const sourceOf = (t: unknown): InstanceType<typeof fake.BufferImageSource> => (t as InstanceType<typeof fake.Texture>).source as InstanceType<typeof fake.BufferImageSource>;

/** A stand-in for the loaded character sheet with just these frame names (and no readable key cells). */
const fakeSheet = (names: readonly string[]) => {
  const frames = new Map(names.map((n) => [n, new fake.Texture({ label: n })]));
  return {
    frames,
    frame: (species: string, column: string, frame: string) => (frames.get(`${species}_${column}_${frame}`) ?? null) as never,
    cell: () => null,
    destroy: vi.fn(),
  };
};

/** A world layer on a chunk bank with a test GPU and clock; `show` points it at a view and paints everything. */
const worldSetup = () => {
  let now = 0;
  const gpu = fakeGpu();
  const chunks = createChunkBank({ gpu, queue: createPaintQueue(() => now), clock: () => now });
  const bank = createTextureBank();
  const world = createWorldLayer(bank, chunks);
  const show = (s: AgencySnapshot, rect = wholeRect(s.map), scale = 1): void => {
    world.setView(liveView(s.map, rect, scale, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }));
    while (chunks.queued() > 0) chunks.paint(Number.POSITIVE_INFINITY);
    world.setView(liveView(s.map, rect, scale, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }));
    const live = new Set<string>();
    const ring = new Set<string>();
    world.keep(live, ring);
    chunks.retain(live, ring, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
  };
  const uploads = (layer: string): number => gpu.uploads.filter((u) => u.label.startsWith(`chunk:${layer}:`)).length;
  return { world, bank, chunks, gpu, show, uploads, tick: (ms: number) => { now += ms; } };
};

beforeEach(() => {
  fake.resetFakePixi();
});

describe('createTextureBank', () => {
  it('makes one texture per raster and reuses it for the same key', () => {
    const bank = createTextureBank();
    const a = bank.critter('bun', P.rose, 'idle', 2);
    expect(bank.critter('bun', P.rose, 'idle', 2)).toBe(a);
    expect(bank.critter('bun', P.jade, 'idle', 2)).not.toBe(a);
    expect(bank.critter('bun', P.rose, 'step', 2)).not.toBe(a);
    expect(bank.critter('bun', P.rose, 'idle', 3)).not.toBe(a);
    expect(bank.bubble('book')).toBe(bank.bubble('book'));
    expect(bank.bubble('book')).not.toBe(bank.bubble('pencil'));
    expect(bank.furniture('desk')).toBe(bank.furniture('desk'));
    expect(bank.monitor('work', P.rose)).toBe(bank.monitor('work', P.rose));
    expect(bank.monitor('work', P.rose)).not.toBe(bank.monitor('work', P.amber));
  });

  it('keys small textures by colour, not by team: any palette gets its own, the same colours share one', () => {
    const bank = createTextureBank();
    const blue = { base: '#3d7bff', accent: '#9fbdff' };
    expect(bank.critter('cat', blue, 'idle', 0)).toBe(bank.critter('cat', { ...blue }, 'idle', 0));
    expect(bank.critter('cat', blue, 'idle', 0)).not.toBe(bank.critter('cat', { ...blue, accent: '#000000' }, 'idle', 0));
    expect(bank.monitor('work', blue)).toBe(bank.monitor('work', { base: blue.base, accent: '#000000' }));
    expect((bank.critter('cat', blue, 'idle', 0) as unknown as { label: string }).label).toBe('critter:cat:#3d7bff#9fbdff:idle:0');
    expect((bank.monitor('alert', blue) as unknown as { label: string }).label).toBe('monitor:alert:#3d7bff');
  });

  it('uploads the raster pixels as nearest-scaled RGBA without copying or touching them', () => {
    const bank = createTextureBank();
    const source = sourceOf(bank.critter('ghost', P.pv, 'blink', 0));
    const raster = critterRaster('ghost', P.pv, 'blink', 0);
    expect(source.options).toMatchObject({ width: raster.width, height: raster.height, format: 'rgba8unorm', scaleMode: 'nearest' });
    const pixels = source.options.resource as Uint8Array;
    expect(pixels).toBeInstanceOf(Uint8Array);
    expect(Array.from(pixels)).toEqual(Array.from(raster.data));
  });

  it('keeps one ground tile', () => {
    const bank = createTextureBank();
    expect(bank.ground()).toBe(bank.ground());
    expect(sourceOf(bank.ground()).options).toMatchObject({ width: 64, height: 64 });
  });

  it('takes characters from the generated sheet, ignoring look variants, and keeps rasters for what it lacks', () => {
    const sheet = fakeSheet(['bun_rose_idle', 'bun_rose_step', 'manager_hq_idle']);
    const bank = createTextureBank(sheet, { pages: () => null });
    expect(bank.critter('bun', P.rose, 'idle', 0)).toBe(sheet.frames.get('bun_rose_idle'));
    expect(bank.critter('bun', P.rose, 'idle', 4)).toBe(sheet.frames.get('bun_rose_idle'));
    expect(bank.critter('manager', P.hq, 'idle', 0)).toBe(sheet.frames.get('manager_hq_idle'));
    const drawn = bank.critter('bot', P.amber, 'idle', 0);
    expect(sourceOf(drawn)).toBeInstanceOf(fake.BufferImageSource);
    expect(bank.critterBox('bun', P.rose)).toEqual({ w: 24, h: 24, head: 0, tail: 4 });
    expect(bank.critterBox('manager', P.hq)).toEqual({ w: 24, h: 24, head: 1, tail: 0 });
    expect(bank.critterBox('bot', P.amber)).toEqual({ w: 16, h: 16, head: 0, tail: -1 });
  });

  it('recolours a colour the sheet lacks from its key column, and draws it when no page can be made', () => {
    const cell = new Uint8ClampedArray(24 * 24 * 4);
    const pages: { updates: number }[] = [];
    const sheet = { ...fakeSheet(['cat_rose_idle']), cell: () => cell };
    const page = () => {
      const made = { updates: 0 };
      pages.push(made);
      return {
        put: vi.fn(), texture: (x: number) => new fake.Texture({ label: `page@${x}` }) as never, update: () => { made.updates += 1; }, destroy: vi.fn(),
      };
    };
    const blue = { base: '#3d7bff', accent: '#9fbdff' };
    const bank = createTextureBank(sheet, { pages: page, clock: () => 0 });
    expect((bank.critter('cat', blue, 'blink', 0) as unknown as { label: string }).label).toBe('page@24');
    expect(bank.critterBox('cat', blue)).toEqual({ w: 24, h: 24, head: 1, tail: 3 });
    bank.frameEnd(0);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.updates).toBe(1);
    expect(bank.stats().bytes).toBeGreaterThanOrEqual(512 * 512 * 4);
    const noPages = createTextureBank(sheet, { pages: () => null });
    expect(sourceOf(noPages.critter('cat', blue, 'idle', 0))).toBeInstanceOf(fake.BufferImageSource);
    expect(noPages.critterBox('cat', blue)).toEqual({ w: 16, h: 16, head: 1, tail: 0 });
  });

  it('measures code-drawn characters when there is no sheet', () => {
    const bank = createTextureBank();
    expect(bank.critterBox('shield', P.jade)).toEqual({ w: 16, h: 16, head: 1, tail: 0 });
    expect(bank.critterBox('manager', P.hq)).toEqual({ w: 18, h: 20, head: 0, tail: -1 });
  });

  it('destroys the sheet with everything else', () => {
    const sheet = fakeSheet(['bun_rose_idle']);
    createTextureBank(sheet).destroy();
    expect(sheet.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys every texture it made', () => {
    const bank = createTextureBank();
    const textures = [bank.critter('bot', P.amber, 'idle', 0), bank.bubble('zzz'), bank.furniture('rack'), bank.ground()];
    bank.destroy();
    textures.forEach((t) => expect((t as unknown as InstanceType<typeof fake.Texture>).destroyed).toBe(true));
  });
});

describe('createWorldLayer: chunks', () => {
  it('draws the floor and the garden as chunk sprites at their cropped rectangles, covering the whole map and the whole garden', () => {
    const { world, show } = worldSetup();
    const office = snap(many('birch', 1));
    world.update(office);
    show(office);
    const area = (label: string): number => (labelled(world.root as unknown as Node, `${label}:`) as SpriteNode[])
      .filter((s) => s.visible).reduce((n, s) => {
        const [i, j] = s.label.slice(label.length + 1).split(',').map(Number);
        const r = chunkWorldRect(office.map, label as 'map', i ?? 0, j ?? 0);
        expect({ x: s.x, y: s.y, scale: s.scale.x }).toEqual({ x: label === 'exterior' ? r.x + 320 : r.x, y: label === 'exterior' ? r.y + 320 : r.y, scale: 1 });
        return n + r.w * r.h;
      }, 0);
    expect(area('map')).toBe(1344 * 672);
    expect(area('exterior')).toBe((1344 + 640) * (672 + 640));
  });

  it('keeps the floor chunks per set of placed servers, and releases the old ones 2 s after another set replaced them', () => {
    const { world, show, uploads, gpu, tick } = worldSetup();
    const all = snap(many('birch', 1));
    world.update(all);
    show(all);
    const first = uploads('map');
    expect(first).toBeGreaterThan(0);
    world.update(snap(many('birch', 1), { servers: [server('local'), server('ash'), server('birch'), server('cedar')] }));
    show(all);
    expect(uploads('map')).toBe(first);
    const fewer = snap(many('birch', 1), { servers: [server('cedar'), server('birch')] });
    world.update(fewer);
    show(fewer);
    expect(uploads('map')).toBeGreaterThan(first);
    const old = gpu.uploads.filter((u) => u.label.startsWith('chunk:map:')).slice(0, first);
    tick(RELEASE_MS);
    show(fewer);
    expect(old.some((u) => u.texture.destroyed)).toBe(true);
  });

  it('paints again only the floor chunks of a room that hangs a Jira board', () => {
    const { world, show, uploads } = worldSetup();
    const plain = snap(many('birch', 1));
    world.update(plain);
    show(plain);
    const first = uploads('map');
    const jira = snap(many('birch', 1), { jiraRooms: ['birch'] });
    world.update(jira);
    show(jira);
    const birch = jira.map.rooms.birch!;
    const meeting = [0, 1, 2, 3].flatMap((i) => [0, 1, 2].map((j) => ({ i, j })))
      .filter(({ i, j }) => roomsMeeting(jira.map, chunkRect(jira.map, i, j)).some((r) => r.id === birch.id));
    expect(uploads('map') - first).toBe(meeting.length);
  });

  it('keeps the garden chunks for any rooms of the same size, and the grass once', () => {
    const { world, show, uploads } = worldSetup();
    const four = snap(many('birch', 1));
    world.update(four);
    show(four);
    const garden = uploads('exterior');
    const two = snap(many('birch', 1), { servers: [server('birch'), server('cedar')] });
    world.update(two);
    show(two);
    expect(uploads('exterior')).toBe(garden);
    const outside = world.garden as unknown as Node;
    expect(outside.children.filter((c) => c.label === 'ground')).toHaveLength(1);
  });

  it('shows the previous lod of a chunk until its new one is painted', () => {
    const { world, chunks, show } = worldSetup();
    const office = snap(many('birch', 1));
    world.update(office);
    show(office, wholeRect(office.map), 1);
    const sprite = (labelled(world.root as unknown as Node, 'map:1,1')[0]) as SpriteNode;
    const before = sprite.texture;
    const rect = wholeRect(office.map);
    world.setView(liveView(office.map, rect, 0.5, { x: 672, y: 336 }));
    expect(chunks.queued()).toBeGreaterThan(0);
    expect(sprite.texture).toBe(before);
    expect(sprite.scale.x).toBe(1);
    expect(world.behind()).toBeGreaterThan(0);
    while (chunks.queued() > 0) chunks.paint(Number.POSITIVE_INFINITY);
    world.setView(liveView(office.map, rect, 0.5, { x: 672, y: 336 }));
    expect(sprite.texture).not.toBe(before);
    expect(sprite.scale.x).toBe(2);
    expect(world.behind()).toBe(0);
  });
});

describe('createWorldLayer', () => {
  it('draws every desk the snapshot lists, lighting the screens of the taken ones', () => {
    const { world, bank } = worldSetup();
    const three = snap(many('birch', 3));
    world.update(three);
    expect(labelled(world.sorted as unknown as Node, 'desk:')).toHaveLength(deskCount(three));
    const two = snap(many('birch', 2), { previous: three });
    world.update(two);
    expect(labelled(world.sorted as unknown as Node, 'desk:')).toHaveLength(deskCount(two));
    const actor = two.actors['birch:s00'];
    const desk = deskAt(world, actor?.desk);
    expect(desk?.zIndex).toBe((actor?.desk.y ?? 0) + 18);
    expect(desk?.children.map((c) => c.label)).toEqual(['desk', 'monitor', 'screen', 'fuel-track', 'fuel']);
    expect(screenOf(desk)).toBe(bank.monitor('work', P.rose));
    const freed = three.actors['birch:s02'];
    expect(screenOf(deskAt(world, freed?.desk))).toBe(bank.monitor('off', P.rose));
  });

  it('changes a monitor screen when the sitter changes state', () => {
    const { world, bank } = worldSetup();
    const working = snap(many('cedar', 1));
    world.update(working);
    const spot = working.actors['cedar:s00']?.desk;
    expect(screenOf(deskAt(world, spot))).toBe(bank.monitor('work', P.jade));
    world.update(snap(many('cedar', 1, { state: 'waiting_question' }), { previous: working }));
    expect(screenOf(deskAt(world, spot))).toBe(bank.monitor('alert', P.jade));
  });

  it('draws the props and desks it is given: the lounge goes when the third desk row is taken', () => {
    const { world } = worldSetup();
    const names = (): string[] => labelled(world.sorted as unknown as Node, 'prop:').map((n) => n.label);
    const desksIn = (room: string): number =>
      labelled(world.sorted as unknown as Node, 'desk:').filter((n) => n.label.startsWith(`desk:${room}@`)).length;
    const roomy = snap(many('cedar', 8));
    world.update(roomy);
    const lounge = roomy.props.filter((p) => p.room === 'cedar' && p.lounge).map((p) => `prop:${p.id}`);
    expect(lounge.length).toBeGreaterThan(0);
    expect(names()).toEqual(expect.arrayContaining(lounge));
    expect(names()).toHaveLength(roomy.props.length);
    expect(desksIn('cedar')).toBe(8);
    const full = snap(many('cedar', 9), { previous: roomy });
    world.update(full);
    lounge.forEach((name) => expect(names()).not.toContain(name));
    expect(names()).toHaveLength(full.props.length);
    expect(desksIn('cedar')).toBe(12);
    const tight = snap(many('cedar', 13), { previous: full });
    world.update(tight);
    expect(names()).toHaveLength(tight.props.length);
    expect(desksIn('cedar')).toBe(20);
    expect(labelled(world.sorted as unknown as Node, 'desk:')).toHaveLength(deskCount(tight));
  });

  it('outlines a hovered fixture with one light pixel, and a dragged-over one brightly; clears both', () => {
    const { world } = worldSetup();
    const snapshot = snap(many('birch', 1));
    world.update(snapshot);
    const outline = labelled(world.root as unknown as Node, 'fixture-outline')[0]!;
    const edges = () => outline.children as SpriteNode[];
    const board = snapshot.fixtures.find((f) => f.id === 'board-hq')!;
    world.setFixtureHover('board-hq');
    expect(edges().every((e) => e.visible && e.tint === 0xe9eef7)).toBe(true);
    const [top, , left] = edges();
    expect({ x: top!.x, y: top!.y, w: top!.width, h: top!.height }).toEqual({ x: board.box.x - 1, y: board.box.y - 1, w: board.box.w + 2, h: 1 });
    expect(left!.width).toBe(1);
    world.setDropHint({ kind: 'fixture', id: 'fuse-hq' });
    expect(edges().every((e) => e.visible && e.tint === 0xffd84d)).toBe(true);
    world.setDropHint(null);
    expect(edges()[0]!.tint).toBe(0xe9eef7);
    world.setFixtureHover(null);
    expect(edges().some((e) => e.visible)).toBe(false);
    const building = world.building as unknown as Node;
    expect(building.children.indexOf(outline)).toBeGreaterThan(building.children.indexOf(world.sorted as unknown as Node));
  });

  it('shows each seated agent context as a two-pixel bar under its screen: green, amber, red, none without a reading', () => {
    const { world } = worldSetup();
    const office = snap(many('birch', 4), { contextPct: { 'birch:s00': 30, 'birch:s01': 70, 'birch:s02': 92 } });
    world.update(office);
    const deskOf = (id: string): Node => {
      const d = office.actors[id]!.desk;
      return labelled(world.sorted as unknown as Node, 'desk:').find((n) => n.x === d.x && n.y === d.y)!;
    };
    const part = (desk: Node, label: string) => desk.children.find((c) => c.label === label) as SpriteNode;
    expect(part(deskOf('birch:s00'), 'fuel')).toMatchObject({ visible: true, tint: 0x54d38a, width: 4, height: 2 });
    expect(part(deskOf('birch:s01'), 'fuel')).toMatchObject({ visible: true, tint: 0xffb648, width: 10 });
    expect(part(deskOf('birch:s02'), 'fuel')).toMatchObject({ visible: true, tint: 0xe23a2e, width: 13 });
    expect(part(deskOf('birch:s03'), 'fuel').visible).toBe(false);
    expect(part(deskOf('birch:s03'), 'fuel-track').visible).toBe(false);
    const screen = part(deskOf('birch:s00'), 'screen');
    expect(part(deskOf('birch:s00'), 'fuel').y).toBeGreaterThanOrEqual(screen.y + 9);
    expect(part(deskOf('birch:s00'), 'fuel-track')).toMatchObject({ visible: true, width: 14, x: screen.x });
  });

  it('lays the grass under everything, then the garden, then the building', () => {
    const { world, show } = worldSetup();
    const snapshot = snap(many('birch', 1));
    world.update(snapshot);
    show(snapshot);
    const root = world.root as unknown as InstanceType<typeof fake.Container>;
    expect(root.children.map((c) => c.label)).toEqual(['garden', 'light:garden', 'building']);
    const outside = world.garden as unknown as InstanceType<typeof fake.Container>;
    expect(outside.children.map((c) => c.label)).toEqual(['ground', 'exterior']);
    const inside = world.building as unknown as InstanceType<typeof fake.Container>;
    expect(inside.children.map((c) => c.label)).toEqual(['map', 'light:indoor', 'frames', 'drop-glow', 'sorted', 'fixture-outline', 'light:over']);
    const [ground, garden] = outside.children as SpriteNode[];
    expect(ground).toBeInstanceOf(fake.TilingSprite);
    expect(ground!.x).toBeLessThan(-1000);
    expect(Math.abs(ground!.x % 64)).toBe(0);
    expect(ground!.width).toBeGreaterThan(snapshot.map.width + 2000);
    expect({ x: garden!.x, y: garden!.y }).toEqual({ x: -320, y: -320 });
    world.update(snap(many('birch', 2)));
    expect(outside.children.filter((c) => c.label === 'ground')).toHaveLength(1);
  });

  it('rebuilds the floor chunks only when the set of placed servers changes', () => {
    const { world, show, uploads } = worldSetup();
    const floorTextures = (): unknown[] => (labelled(world.root as unknown as Node, 'map:') as SpriteNode[]).map((s) => s.texture);
    const one = snap(many('birch', 1));
    world.update(one);
    show(one);
    const first = floorTextures();
    const painted = uploads('map');
    const two = snap(many('birch', 2));
    world.update(two);
    show(two);
    const three = snap([...many('birch', 2), ...many('ash', 1)]);
    world.update(three);
    show(three);
    expect(uploads('map')).toBe(painted);
    expect(floorTextures().every((t, i) => t === first[i])).toBe(true);
    const other = snap(many('birch', 1), { servers: [server('birch'), server('cedar')] });
    world.update(other);
    show(other);
    expect(uploads('map')).toBeGreaterThan(painted);
    expect(floorTextures().some((t, i) => t !== first[i])).toBe(true);
  });

  it('puts the racks on the floor with lights that follow the server', () => {
    const { world } = worldSetup();
    const busy = snap(many('birch', 1), { servers: [server('birch', { status: 'offline' }), server('cedar')] });
    world.update(busy);
    world.tick(1000);
    const rack = labelled(world.sorted as unknown as Node, 'prop:rack-birch')[0];
    const lights = (rack?.children ?? []).filter((c) => c.label === 'light') as SpriteNode[];
    expect(lights).toHaveLength(12);
    lights.forEach((l) => expect([0x1f3b2d, 0x27324a]).toContain(l.tint));
  });

  it('dims the rooms whose server is offline or connecting, and darkens their racks', () => {
    const { world } = worldSetup();
    const shades = (): string[] => labelled(world.shade as unknown as Node, 'shade:').filter((n) => n.visible).map((n) => n.label).sort();
    const servers = [server('birch', { status: 'offline' }), server('cedar', { status: 'connecting' }), server('ash'), server('local')];
    world.update(snap(many('birch', 1), { servers }));
    expect(shades()).toEqual(['shade:birch', 'shade:cedar']);
    const birch = labelled(world.shade as unknown as Node, 'shade:birch')[0] as SpriteNode;
    expect({ x: birch.x, y: birch.y, width: birch.width, height: birch.height }).toEqual({ x: 16, y: 16, width: 26 * 16, height: 17 * 16 });
    world.tick(1000);
    const lights = (room: string): number[] => ((labelled(world.sorted as unknown as Node, `prop:rack-${room}`)[0]?.children ?? [])
      .filter((c) => c.label === 'light') as SpriteNode[]).map((l) => Number(l.tint));
    lights('cedar').forEach((tint) => expect([0x1f3b2d, 0x27324a]).toContain(tint));
    expect(lights('ash').some((tint) => tint !== 0x1f3b2d && tint !== 0x27324a)).toBe(true);
    world.update(snap(many('birch', 1)));
    expect(shades()).toEqual([]);
  });

  it('draws the room frames in map order, a hot one included, so HQ keeps its corner over a focused room', () => {
    const { world } = worldSetup();
    const office = snap(many('birch', 1));
    world.update(office);
    world.setHot(new Set(['birch']));
    const frames = labelled(world.root as unknown as Node, 'frames')[0]!;
    expect(frames.sortableChildren).toBe(true);
    const z = (room: string): number[] => frames.children.filter((c) => c.label === `frame:${room}`).map((c) => c.zIndex);
    expect(z('birch')).toEqual([0, 0, 0, 0]);
    expect(z('hq')).toEqual([2, 2, 2, 2]);
    expect((frames.children.filter((c) => c.label === 'frame:birch')[0] as SpriteNode).height).toBe(3);
  });

  it('destroys what it made', () => {
    const { world } = worldSetup();
    world.update(snap(many('birch', 2)));
    world.destroy();
    expect((world.root as unknown as Node).destroyed).toBe(true);
  });
});

describe('createWorldLayer: many rooms', () => {
  const office = roomSnap(roomsOf(100), 2);

  it('makes desks, props, frames and shades only for the rooms in view, and drops them as the view moves on', () => {
    const { world, show } = worldSetup();
    world.update(office);
    const target = office.map.rooms['site-40']!;
    const centre = { x: (target.rect.x + target.rect.w / 2) * 16, y: (target.rect.y + target.rect.h / 2) * 16 };
    const rect = viewRect(centre, 1.5, 1440, 900);
    show(office, rect, 1.5);
    const view = liveView(office.map, rect, 1.5, centre);
    const roomsOfNodes = (prefix: string): Set<string> =>
      new Set(labelled(world.root as unknown as Node, prefix).map((n) => n.label.slice(prefix.length).split('@')[0] ?? ''));
    expect([...roomsOfNodes('desk:')].every((r) => view.rooms.has(r))).toBe(true);
    expect(roomsOfNodes('desk:').has('site-40')).toBe(true);
    expect([...roomsOfNodes('frame:')].every((r) => view.rooms.has(r))).toBe(true);
    expect(labelled(world.root as unknown as Node, 'desk:').length).toBeLessThan(deskCount(office) / 4);
    const far = office.map.rooms['site-99']!;
    const farCentre = { x: far.rect.x * 16, y: far.rect.y * 16 };
    show(office, viewRect(farCentre, 1.5, 1440, 900), 1.5);
    expect(roomsOfNodes('desk:').has('site-40')).toBe(false);
  });

  it('draws no per-room objects in far mode: only the floor, the garden and the light', () => {
    const { world, show } = worldSetup();
    world.update(office);
    const all = office.map.zones.all;
    const rect = viewRect({ x: all.x + all.w / 2, y: all.y + all.h / 2 }, 0.2, 1440, 900);
    show(office, rect, 0.2);
    expect(labelled(world.root as unknown as Node, 'desk:')).toHaveLength(0);
    expect(labelled(world.root as unknown as Node, 'prop:')).toHaveLength(0);
    expect(labelled(world.root as unknown as Node, 'frame:')).toHaveLength(0);
    expect((world.sorted as unknown as Node).visible).toBe(false);
    expect(labelled(world.root as unknown as Node, 'map:').length).toBeGreaterThan(0);
  });

  it('keeps a room with twelve seated agents within its 90 + 6 × 12 display objects', async () => {
    const { createActorLayer } = await import('../../../../src/features/agency/scene/actors.js');
    const { world, bank, show } = worldSetup();
    const full = roomSnap(CLASSIC.slice(0, 1), 12);
    const overlay = new fake.Container();
    const actors = createActorLayer(bank, world.sorted as never, overlay as never);
    world.update(full);
    actors.apply(full);
    const birch = full.map.rooms.birch!;
    const centre = { x: (birch.rect.x + birch.rect.w / 2) * 16, y: (birch.rect.y + birch.rect.h / 2) * 16 };
    const rect = viewRect(centre, 3, 390, 300);
    show(full, rect, 3);
    actors.setView(liveView(full.map, rect, 3, centre));
    actors.frame(0, 16);
    const inBirch = (n: Node): boolean => n.label.includes('birch');
    const roots = [...(world.sorted as unknown as Node).children, ...(world.root as unknown as Node).all().filter((n) => n.label.startsWith('frame:'))];
    const objects = roots.filter(inBirch).reduce((n, node) => n + 1 + node.all().length, 0) + overlay.all().length;
    expect(Object.keys(full.actors)).toHaveLength(12);
    expect(objects).toBeLessThanOrEqual(90 + 6 * 12);
  });
});

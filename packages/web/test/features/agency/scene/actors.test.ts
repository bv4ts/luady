import { beforeEach, describe, expect, it, vi } from 'vitest';
import { P, viewRect } from './chunk-kit.js';
import * as fake from './fake-pixi.js';
import { many, roomSnap, roomsOf, session, snap } from './office-fixtures.js';

vi.mock('pixi.js/unsafe-eval', () => ({}));
vi.mock('pixi.js', async () => (await import('./fake-pixi.js')).pixiModule);

const { createActorLayer } = await import('../../../../src/features/agency/scene/actors.js');
const { createTextureBank } = await import('../../../../src/features/agency/scene/textures.js');
const { hexToTint } = await import('../../../../src/features/agency/scene/rack-lights.js');
const { liveView } = await import('../../../../src/features/agency/scene/live-set.js');
const { lighten } = await import('@luady/office');

type Node = InstanceType<typeof fake.Container>;
type SpriteNode = InstanceType<typeof fake.Sprite>;

const setup = () => {
  const sorted = new fake.Container();
  const overlay = new fake.Container();
  const bank = createTextureBank();
  const layer = createActorLayer(bank, sorted as never, overlay as never);
  const actors = (): string[] => sorted.children.map((c) => c.label).sort();
  const bubbles = (): SpriteNode[] => overlay.children.filter((c) => c.label === 'bubble') as SpriteNode[];
  return { sorted, overlay, bank, layer, actors, bubbles };
};

beforeEach(() => {
  fake.resetFakePixi();
});

describe('createActorLayer', () => {
  it('draws one character per session plus Luady, seated at once on the first snapshot', () => {
    const { layer, actors, sorted } = setup();
    const first = snap(many('birch', 2), { luady: { state: 'busy', since: '2026-11-14T12:00:00.000Z', claudeSessionId: null, queued: 1 } });
    expect(layer.apply(first)).toBe(true);
    expect(layer.frame(1000, 16)).toBe(false);
    expect(actors()).toEqual(['actor:birch:s00', 'actor:birch:s01', 'actor:manager']);
    const a = sorted.children.find((c) => c.label === 'actor:birch:s00') as Node;
    expect({ x: a.x, y: a.y }).toEqual(first.actors['birch:s00']?.sit);
    expect(a.zIndex).toBe(first.actors['birch:s00']?.sit.y);
  });

  it('shows the state bubble, and no pixel dots on Luady while he is busy (the page types for him)', () => {
    const { layer, bank, bubbles } = setup();
    layer.apply(snap([session('cedar:a', { state: 'waiting_question' })], { luady: { state: 'busy', since: '2026-11-14T12:00:00.000Z', claudeSessionId: null, queued: 0 } }));
    layer.frame(0, 16);
    const textures = bubbles().filter((b) => b.visible).map((b) => b.texture);
    expect(textures).toEqual([bank.bubble('bang')]);
  });

  it('keeps zzz on Luady while he is down', () => {
    const { layer, bank, bubbles } = setup();
    layer.apply(snap([], { luady: null }));
    layer.frame(0, 16);
    expect(bubbles().filter((b) => b.visible).map((b) => b.texture)).toEqual([bank.bubble('zzz')]);
  });

  it('lays a pulsing ring in the team colour under a working character, Luady included while busy, and none under an idle one', () => {
    const { layer, sorted, overlay, bank } = setup();
    const ringOf = (id: string): SpriteNode | undefined =>
      (sorted.children.find((c) => c.label === `actor:${id}`)?.children ?? []).find((c) => c.label === 'ring') as SpriteNode | undefined;
    const busy = { state: 'busy', since: '2026-11-14T12:00:00.000Z', claudeSessionId: null, queued: 0 } as const;
    layer.apply(snap([session('ash:a'), session('ash:b', { state: 'idle' })], { luady: busy }));
    layer.frame(0, 16);
    const ring = ringOf('ash:a');
    expect(ring?.visible).toBe(true);
    expect(ring?.texture).toBe(bank.ring('back'));
    expect(ring?.tint).toBe(hexToTint(lighten(P.amber.base, 0.4)));
    const front = overlay.children.filter((c) => c.label === 'ring-front' && c.visible) as SpriteNode[];
    expect(front).toHaveLength(2);
    expect(front.map((f) => f.texture)).toEqual([bank.ring('front'), bank.ring('front')]);
    expect(front.map((f) => f.tint)).toContain(hexToTint(P.amber.base));
    const a = sorted.children.find((c) => c.label === 'actor:ash:a');
    expect(front.some((f) => f.x === a?.x && f.y === (a?.y ?? 0) + ring!.y)).toBe(true);
    expect(ringOf('ash:b')?.visible).toBe(false);
    expect(ringOf('manager')?.visible).toBe(true);
    const alphas = [0, 200, 400, 600, 800, 1000].map((t) => {
      layer.frame(t, 16);
      return ringOf('ash:a')?.alpha;
    });
    expect(new Set(alphas).size).toBeGreaterThan(1);
    const body = sorted.children.find((c) => c.label === 'actor:ash:a');
    expect(body?.children.indexOf(ring as never)).toBe(0);
  });

  it('keeps the ring still with reduced motion', () => {
    const { layer, sorted } = setup();
    layer.setReducedMotion(true);
    layer.apply(snap([session('ash:a')]));
    const ring = (): SpriteNode | undefined =>
      (sorted.children.find((c) => c.label === 'actor:ash:a')?.children ?? []).find((c) => c.label === 'ring') as SpriteNode | undefined;
    layer.frame(0, 16);
    const first = ring()?.alpha;
    layer.frame(700, 16);
    expect(ring()?.alpha).toBe(first);
  });

  it('sparkles once round a session Luady started as it walks in, not round one there at load or one the owner started', () => {
    const { layer, overlay } = setup();
    const sparkles = (): SpriteNode[] => overlay.children.filter((c) => c.label === 'sparkle' && c.visible) as SpriteNode[];
    const loaded = snap([session('birch:old', { origin: 'manager' })]);
    layer.apply(loaded);
    layer.frame(1000, 16);
    expect(sparkles()).toHaveLength(0);
    layer.apply(snap([session('birch:old', { origin: 'manager' }), session('birch:new', { origin: 'manager' }), session('birch:mine')], { previous: loaded }));
    layer.frame(1016, 16);
    expect(sparkles()).toHaveLength(1);
    layer.frame(1500, 16);
    expect(sparkles()).toHaveLength(1);
    layer.frame(2200, 16);
    expect(sparkles()).toHaveLength(0);
  });

  it('marks the selected character with brackets', () => {
    const { layer, overlay } = setup();
    layer.apply(snap([session('ash:a')]));
    layer.setSelected('ash:a');
    layer.frame(0, 16);
    const marks = overlay.children.filter((c) => c.label === 'marks' && c.visible);
    expect(marks).toHaveLength(1);
    expect((marks[0]?.children[0] as SpriteNode).tint).toBe(0xffffff);
  });

  it('walks a leaver out, then removes its sprites', () => {
    const { layer, actors, overlay } = setup();
    const two = snap(many('local', 2));
    layer.apply(two);
    layer.frame(0, 16);
    expect(layer.apply(snap(many('local', 1), { previous: two }))).toBe(true);
    expect(layer.frame(16, 16)).toBe(true);
    expect(actors()).toContain('actor:local:s01');
    for (let t = 0; t < 60_000; t += 16) layer.frame(t, 16);
    expect(actors()).toEqual(['actor:local:s00', 'actor:manager']);
    expect(overlay.children.filter((c) => c.label === 'bubble')).toHaveLength(2);
  });

  it('reports bodies for picking and name plates', () => {
    const { layer } = setup();
    const s = snap([session('birch:a')]);
    layer.apply(s);
    const a = s.actors['birch:a']!;
    expect(layer.bodies()).toContainEqual({ id: 'birch:a', x: a.sit.x, y: a.sit.y, w: 16, h: 16, top: a.sit.y - 15, base: a.desk.y + 18 });
    expect(layer.bodies().find((b) => b.id === 'manager')).toMatchObject({ w: 18, h: 20 });
  });

  it('draws the generated 24-pixel characters bottom-centred, with the bubble just above the head', () => {
    const sheet = { frame: (sp: string, column: string, f: string) => new fake.Texture({ label: `${sp}_${column}_${f}` }) as never, cell: () => null, destroy: vi.fn() };
    const sorted = new fake.Container();
    const overlay = new fake.Container();
    const layer = createActorLayer(createTextureBank(sheet), sorted as never, overlay as never);
    const s = snap([session('cedar:a', { state: 'waiting_question' })]);
    layer.apply(s);
    layer.frame(0, 16);
    const a = s.actors['cedar:a']!;
    const body = layer.bodies().find((b) => b.id === 'cedar:a');
    expect(body).toEqual({ id: 'cedar:a', x: a.sit.x, y: a.sit.y, w: 24, h: 23, top: a.sit.y - 22, base: a.desk.y + 18 });
    const critter = (sorted.children.find((c) => c.label === 'actor:cedar:a')?.children.find((c) => c.label === 'critter')) as SpriteNode;
    expect((critter.texture as InstanceType<typeof fake.Texture>).label).toMatch(/^shield_jade_/);
    expect(critter.anchor).toMatchObject({ x: 0.5, y: 1 });
    // The tail's tip rests on row 4 of the shield (its brow), two rows above the eyes: the bubble stays off the face.
    const bubble = overlay.children.find((c) => c.label === 'bubble' && c.visible) as SpriteNode;
    expect(bubble.y + 14).toBe(a.sit.y - 23 + 4);
    const luady = layer.bodies().find((b) => b.id === 'manager');
    const desk = s.props.find((p) => p.kind === 'luadydesk')!;
    expect(luady).toMatchObject({ w: 24, h: 23, base: desk.y + 34 });
  });

  it('keeps an arrival off the map until its turn at the door', () => {
    const { layer, actors } = setup();
    const one = snap(many('cedar', 1));
    layer.apply(one);
    layer.frame(0, 16);
    layer.apply(snap(many('cedar', 3), { previous: one }));
    layer.frame(16, 16);
    expect(actors()).toEqual(['actor:cedar:s00', 'actor:cedar:s01', 'actor:manager']);
    expect(layer.bodies().map((b) => b.id)).not.toContain('cedar:s02');
    layer.frame(216, 200);
    expect(actors()).toContain('actor:cedar:s02');
  });

  it('draws up to three helpers beside a seated agent and a sweat drop while its context is nearly full', () => {
    const { layer, sorted, overlay, bank } = setup();
    const helpersOf = (id: string): SpriteNode[] =>
      ((sorted.children.find((c) => c.label === `actor:${id}`)?.children ?? []) as SpriteNode[]).filter((c) => c.label === 'helper' && c.visible);
    const drops = (): SpriteNode[] => overlay.children.filter((c) => c.label === 'sweat' && c.visible) as SpriteNode[];
    const first = snap([session('birch:a'), session('birch:b')], { helpers: { 'birch:a': 5, 'birch:b': 1 }, contextPct: { 'birch:b': 93 } });
    layer.apply(first);
    layer.frame(0, 16);
    expect(helpersOf('birch:a')).toHaveLength(3);
    expect(helpersOf('birch:b')).toHaveLength(1);
    expect([bank.critter('mini', P.rose, 'idle', 0), bank.critter('mini', P.rose, 'step', 0)]).toContain(helpersOf('birch:a')[0]?.texture);
    const xs = helpersOf('birch:a').map((h) => h.x);
    expect(xs.some((x) => x < 0) && xs.some((x) => x > 0)).toBe(true);
    expect(drops()).toHaveLength(1);
    expect(drops()[0]?.texture).toBe(bank.drop());
    layer.apply(snap([session('birch:a'), session('birch:b')], { previous: first }));
    layer.frame(16, 16);
    expect(helpersOf('birch:a')).toHaveLength(0);
    expect(drops()).toHaveLength(0);
  });

  it('draws helpers busy: stepping, bobbing and swaying over time, still with reduced motion', () => {
    const { layer, sorted } = setup();
    const helperOf = (): SpriteNode | undefined =>
      ((sorted.children.find((c) => c.label === 'actor:birch:a')?.children ?? []) as SpriteNode[]).find((c) => c.label === 'helper' && c.visible);
    layer.apply(snap([session('birch:a')], { helpers: { 'birch:a': 1 } }));
    const seen = new Set<string>();
    for (let t = 0; t < 2000; t += 60) {
      layer.frame(t, 16);
      const h = helperOf();
      seen.add(`${h?.x},${h?.y},${String(h?.texture.label)}`);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
    layer.setReducedMotion(true);
    const still = new Set<string>();
    for (let t = 0; t < 2000; t += 60) {
      layer.frame(t, 16);
      const h = helperOf();
      still.add(`${h?.x},${h?.y},${String(h?.texture.label)}`);
    }
    expect(still.size).toBe(1);
  });

  it('draws a seated character with five display objects, the rest only while they show', () => {
    const { layer, sorted, overlay } = setup();
    layer.apply(snap([session('birch:a', { state: 'idle' })], { luady: null }));
    layer.frame(0, 16);
    const body = sorted.children.find((c) => c.label === 'actor:birch:a')!;
    const own = 1 + body.all().length + overlay.children.filter((c) => c.label === 'bubble' || c.label === 'ring-front').length / 2;
    expect(body.children.map((c) => c.label)).toEqual(['ring', 'critter']);
    expect(own).toBe(5);
  });

  it('gives sprites only to the characters of the view: its rooms, Luady when HQ is in reach, walkers in the chunk area', () => {
    const { layer, sorted } = setup();
    const office = roomSnap(roomsOf(24), 1);
    layer.apply(office);
    const target = office.map.rooms['site-12']!;
    const centre = { x: (target.rect.x + target.rect.w / 2) * 16, y: (target.rect.y + target.rect.h / 2) * 16 };
    const view = liveView(office.map, viewRect(centre, 2, 1440, 900), 2, centre);
    layer.setView(view);
    layer.frame(0, 16);
    const drawn = sorted.children.map((c) => c.label.slice('actor:'.length));
    expect(drawn).toContain('site-12:s00');
    drawn.forEach((id) => expect(view.rooms.has(office.actors[id]?.room ?? 'hq')).toBe(true));
    expect(drawn.length).toBeLessThan(Object.keys(office.actors).length);
    expect(layer.bodies().map((b) => b.id).sort()).toEqual([...drawn].sort());
  });

  it('gives sprites to nobody in far mode', () => {
    const { layer, sorted } = setup();
    const office = roomSnap(roomsOf(24), 1);
    layer.apply(office);
    const all = office.map.zones.all;
    const centre = { x: all.x + all.w / 2, y: all.y + all.h / 2 };
    layer.setView(liveView(office.map, viewRect(centre, 0.3, 1440, 900), 0.3, centre));
    layer.frame(0, 16);
    expect(sorted.children).toHaveLength(0);
    expect(layer.bodies()).toEqual([]);
  });

  it('removes everything on destroy', () => {
    const { layer, sorted, overlay } = setup();
    layer.apply(snap(many('birch', 3)));
    layer.frame(0, 16);
    layer.destroy();
    expect(sorted.children).toEqual([]);
    expect(overlay.children).toEqual([]);
  });
});

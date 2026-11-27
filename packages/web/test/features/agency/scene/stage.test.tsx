import { HQ_ID } from '@luady/office';
import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stageInsets } from '../../../../src/features/agency/panels/insets.js';
import { FAR_SCALE } from '../../../../src/features/agency/scene/live-set.js';
import type { AgencyStageProps, OverlayPoint, StageStats, StageView } from '../../../../src/features/agency/stage-types.js';
import * as fake from './fake-pixi.js';
import { Viewport } from './fake-viewport.js';
import { many, roomsOf, session, snap } from './office-fixtures.js';

vi.mock('pixi.js/unsafe-eval', () => ({}));
vi.mock('pixi.js/events', () => ({}));
vi.mock('pixi.js', async () => (await import('./fake-pixi.js')).pixiModule);
vi.mock('pixi-viewport', async () => await import('./fake-viewport.js'));
// jsdom loads no pictures: each test says which character sheet the scene gets.
const sheetLoader = vi.hoisted(() => ({ load: async (): Promise<unknown> => null }));
vi.mock('../../../../src/features/agency/scene/character-sheet.js', () => ({ loadCharacterSheet: () => sheetLoader.load() }));

const { default: AgencyStage } = await import('../../../../src/features/agency/scene/AgencyStage.js');

const NONE = { top: 0, right: 0, bottom: 0, left: 0 };
const first = snap(many('birch', 3));

const props = (over: Partial<AgencyStageProps> = {}): AgencyStageProps => ({
  snapshot: first, settleKey: 1, focus: { kind: 'all' }, selectedId: null, insets: NONE, reducedMotion: false,
  onEvent: vi.fn(), onFrame: vi.fn(), onFailed: vi.fn(), ...over,
});

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
};

const live = (): fake.Application[] => fake.Application.instances.filter((a) => a.destroy.mock.calls.length === 0);
const actorNodes = (app: fake.Application | undefined): string[] =>
  (app?.stage.all() ?? []).filter((n) => n.label.startsWith('actor:')).map((n) => n.label).sort();

beforeEach(() => {
  fake.resetFakePixi();
  Viewport.instances = [];
  sheetLoader.load = async () => null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgencyStage', () => {
  it('creates one live app under StrictMode and puts its canvas in the stage', async () => {
    const { getByTestId } = render(<StrictMode><AgencyStage {...props()} /></StrictMode>);
    await settle();
    expect(live()).toHaveLength(1);
    expect(getByTestId('agency-stage').querySelector('canvas')).toBe(live()[0]?.canvas);
  });

  it('pushes new props into the same app, keeping the last of a burst', async () => {
    const p = props();
    const { rerender } = render(<AgencyStage {...p} />);
    await settle();
    let previous = first;
    for (let i = 0; i < 10; i += 1) {
      const next = snap([...many('birch', 2), session(`birch:burst-${i % 3}`, { state: i % 2 === 0 ? 'idle' : 'working' })], { previous });
      rerender(<AgencyStage {...p} snapshot={next} focus={{ kind: 'room', room: 'birch' }} insets={{ ...NONE, right: i }} />);
      previous = next;
    }
    await settle();
    expect(fake.Application.instances).toHaveLength(1);
    act(() => fake.Ticker.shared.tick(16));
    expect(actorNodes(fake.Application.instances[0])).toEqual(expect.arrayContaining(['actor:birch:burst-0', 'actor:birch:s00', 'actor:birch:s01', 'actor:manager']));
    for (let t = 0; t < 40_000; t += 16) fake.Ticker.shared.tick(16);
    expect(actorNodes(fake.Application.instances[0])).toEqual(['actor:birch:burst-0', 'actor:birch:s00', 'actor:birch:s01', 'actor:manager']);
  });

  it('draws the generated characters when the sheet loads, and destroys it with the scene', async () => {
    const sheet = { frame: (sp: string, team: string, f: string) => new fake.Texture({ label: `${sp}_${team}_${f}` }), destroy: vi.fn() };
    sheetLoader.load = async () => sheet;
    const { unmount } = render(<AgencyStage {...props()} />);
    await settle();
    act(() => fake.Ticker.shared.tick(16));
    const luady = fake.Application.instances[0]?.stage.all().find((n) => n.label === 'actor:manager');
    expect(((luady?.children.find((c) => c.label === 'critter') as fake.Sprite).texture as fake.Texture).label).toMatch(/^manager_hq_/);
    unmount();
    await settle();
    expect(sheet.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the app on unmount, only after init resolved', async () => {
    fake.Application.autoResolve = false;
    const { unmount } = render(<AgencyStage {...props()} />);
    await settle();
    const app = fake.Application.instances[0];
    expect(app).toBeDefined();
    unmount();
    await settle();
    expect(app?.destroy).not.toHaveBeenCalled();
    app?.resolveInit();
    await settle();
    expect(app?.destroy).toHaveBeenCalledTimes(1);
    expect(fake.Ticker.shared.fns).toHaveLength(0);
  });

  it('tells the page once when WebGL cannot start', async () => {
    fake.Application.autoResolve = false;
    const onFailed = vi.fn();
    const { rerender } = render(<AgencyStage {...props({ onFailed })} />);
    await settle();
    fake.Application.instances[0]?.rejectInit(new Error('no context'));
    await settle();
    rerender(<AgencyStage {...props({ onFailed, snapshot: snap(many('cedar', 1)) })} />);
    await settle();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith('webgl-unavailable');
  });

  it('reports a head point per character, Luady included, when something moved', async () => {
    const onFrame = vi.fn<(points: readonly OverlayPoint[]) => void>();
    render(<AgencyStage {...props({ onFrame })} />);
    await settle();
    act(() => fake.Ticker.shared.tick(16));
    const points = (onFrame.mock.lastCall?.[0] ?? []).filter((p) => p.kind === 'actor');
    expect(points.map((p) => p.id).sort()).toEqual(['birch:s00', 'birch:s01', 'birch:s02', 'manager']);
    points.forEach((p) => {
      expect(p.kind).toBe('actor');
      expect(p.scale).toBeGreaterThan(0);
      expect(p.footY).toBeGreaterThan(p.y);
      expect(p.maxWidth).toBeGreaterThan(0);
    });
    onFrame.mockClear();
    act(() => fake.Ticker.shared.tick(16));
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('no walk-in on page load: the first snapshot from loaded data seats everyone, after an empty one', async () => {
    const onFrame = vi.fn<(points: readonly OverlayPoint[]) => void>();
    const p = props({ onFrame, snapshot: snap([]), settleKey: 0 });
    const { rerender } = render(<AgencyStage {...p} />);
    await settle();
    rerender(<AgencyStage {...p} snapshot={first} settleKey={1} />);
    await settle();
    act(() => fake.Ticker.shared.tick(16));
    expect((onFrame.mock.lastCall?.[0] ?? []).filter((pt) => pt.kind === 'actor').map((pt) => pt.id).sort()).toEqual(['birch:s00', 'birch:s01', 'birch:s02', 'manager']);
    onFrame.mockClear();
    act(() => fake.Ticker.shared.tick(16));
    expect(onFrame).not.toHaveBeenCalled();
    // A later snapshot with the same key is live: its newcomer walks in.
    rerender(<AgencyStage {...p} snapshot={snap(many('birch', 4), { previous: first })} settleKey={1} />);
    await settle();
    act(() => fake.Ticker.shared.tick(16));
    onFrame.mockClear();
    act(() => fake.Ticker.shared.tick(16));
    expect(onFrame).toHaveBeenCalled();
  });

  it('hands the page a stage handle once it runs, and null when it goes away', async () => {
    const onReady = vi.fn<NonNullable<AgencyStageProps['onReady']>>();
    const { unmount } = render(<AgencyStage {...props({ onReady })} />);
    await settle();
    const handle = onReady.mock.lastCall?.[0];
    expect(handle).not.toBeNull();
    expect(handle?.pick(-10_000, -10_000)).toBeNull();
    expect(() => handle?.setDropHint({ kind: 'room', room: 'birch' })).not.toThrow();
    unmount();
    await settle();
    expect(onReady).toHaveBeenLastCalledWith(null);
  });

  it('reports a point per fixture at its anchor and per room at its top-left inside corner, all with the zoom', async () => {
    const onFrame = vi.fn<(points: readonly OverlayPoint[]) => void>();
    render(<AgencyStage {...props({ onFrame })} />);
    await settle();
    act(() => fake.Ticker.shared.tick(16));
    const points = onFrame.mock.lastCall?.[0] ?? [];
    const vp = Viewport.instances.at(-1)!;
    const scale = vp.scale.x;
    expect(points.filter((p) => p.kind === 'fixture').map((p) => p.id)).toEqual(first.fixtures.map((f) => f.id));
    const board = first.fixtures.find((f) => f.id === 'board-hq')!;
    const boardPoint = points.find((p) => p.kind === 'fixture' && p.id === 'board-hq')!;
    expect({ x: boardPoint.x, y: boardPoint.y, footY: boardPoint.footY }).toEqual({ ...vp.toScreen(board.anchor.x, board.anchor.y), footY: vp.toScreen(board.anchor.x, board.anchor.y).y });
    expect(boardPoint.maxWidth).toBeCloseTo(board.box.w * scale);
    const rooms = points.filter((p) => p.kind === 'room');
    expect(rooms.map((p) => p.id)).toEqual(['birch', 'ash', 'hq', 'cedar', 'local']);
    const birch = rooms.find((p) => p.id === 'birch')!;
    expect({ x: birch.x, y: birch.y }).toEqual(vp.toScreen(32, 48));
    expect(birch.maxWidth).toBeCloseTo(24 * 16 * scale);
    points.forEach((p) => expect(p.scale).toBe(scale));
  });

  it('lets the page pick what is under a point: a character, a fixture, a room, or nothing', async () => {
    const onReady = vi.fn<NonNullable<AgencyStageProps['onReady']>>();
    render(<AgencyStage {...props({ onReady })} />);
    await settle();
    act(() => fake.Ticker.shared.tick(16));
    const handle = onReady.mock.lastCall?.[0];
    const vp = Viewport.instances.at(-1)!;
    const at = (x: number, y: number) => {
      const p = vp.toScreen(x, y);
      return handle?.pick(p.x, p.y);
    };
    const sit = first.actors['birch:s00']!.sit;
    expect(at(sit.x, sit.y - 8)).toEqual({ kind: 'actor', id: 'birch:s00' });
    const fuse = first.fixtures.find((f) => f.id === 'fuse-hq')!;
    expect(at(fuse.box.x + 5, fuse.box.y + 5)).toEqual({ kind: 'fixture', id: 'fuse-hq' });
    expect(at(64 * 16, 34 * 16)).toEqual({ kind: 'room', room: 'local' });
    expect(at(-200, -200)).toBeNull();
  });

  it('lights a drop target: a character with a bright frame, a room with an inner glow, and clears with null', async () => {
    const onReady = vi.fn<NonNullable<AgencyStageProps['onReady']>>();
    render(<AgencyStage {...props({ onReady })} />);
    await settle();
    const handle = onReady.mock.lastCall?.[0];
    const app = fake.Application.instances.at(-1)!;
    const nodes = () => app.stage.all();
    const glow = () => nodes().find((n) => n.label === 'drop-glow')!;
    const brightMarks = () => nodes().filter((n) => n.label === 'marks' && n.visible && (n.children[0] as fake.Sprite).tint === 0xffd84d);
    act(() => handle?.setDropHint({ kind: 'room', room: 'cedar' }));
    act(() => fake.Ticker.shared.tick(16));
    expect(glow().children.every((c) => c.visible)).toBe(true);
    expect(brightMarks()).toHaveLength(0);
    act(() => handle?.setDropHint({ kind: 'actor', id: 'birch:s01' }));
    act(() => fake.Ticker.shared.tick(16));
    expect(glow().children.some((c) => c.visible)).toBe(false);
    expect(brightMarks()).toHaveLength(1);
    act(() => handle?.setDropHint(null));
    act(() => fake.Ticker.shared.tick(16));
    expect(brightMarks()).toHaveLength(0);
    expect(glow().children.some((c) => c.visible)).toBe(false);
  });

  it('hides head points in dimmed rooms', async () => {
    const onFrame = vi.fn<(points: readonly OverlayPoint[]) => void>();
    const both = snap([...many('birch', 1), ...many('cedar', 1)]);
    render(<AgencyStage {...props({ onFrame, snapshot: both, focus: { kind: 'room', room: 'cedar' } })} />);
    await settle();
    act(() => fake.Ticker.shared.tick(16));
    const points = onFrame.mock.lastCall?.[0] ?? [];
    expect(points.find((p) => p.id === 'birch:s00')?.visible).toBe(false);
    expect(points.find((p) => p.id === 'manager')?.visible).toBe(false);
  });

  it('tells the page what the camera shows once it settles, and once per frame while it moves', async () => {
    const onView = vi.fn<(view: StageView) => void>();
    const p = props({ onView });
    const { rerender } = render(<AgencyStage {...p} />);
    await settle();
    act(() => fake.Ticker.shared.tick(16));
    const first = onView.mock.lastCall?.[0];
    const vp = Viewport.instances.at(-1)!;
    expect(first).toMatchObject({ scale: vp.scale.x, far: false });
    expect(first?.rect.w).toBeCloseTo(800 / vp.scale.x, 6);
    onView.mockClear();
    act(() => fake.Ticker.shared.tick(16));
    expect(onView).not.toHaveBeenCalled();
    rerender(<AgencyStage {...p} focus={{ kind: 'room', room: 'cedar' }} />);
    await settle();
    act(() => fake.Ticker.shared.tick(16));
    expect(onView).toHaveBeenCalledTimes(1);
    expect(onView.mock.lastCall?.[0].scale).toBeGreaterThan(first?.scale ?? 0);
  });

  it('reports the stats hook in dev builds: the classic four within 17 MiB of chunks once nothing is pending', async () => {
    const { unmount } = render(<AgencyStage {...props()} />);
    await settle();
    let stats: StageStats | undefined;
    for (let i = 0; i < 400; i += 1) {
      act(() => fake.Ticker.shared.tick(16));
      stats = window.__luadyStageStats?.();
      if (stats !== undefined && stats.pending === 0 && stats.textures > 0) break;
    }
    expect(stats).toMatchObject({ pending: 0, far: false, liveRooms: 4 });
    expect(stats?.textureMiB).toBeGreaterThan(0);
    expect(stats?.textureMiB).toBeLessThanOrEqual(17);
    expect(stats?.largestSide).toBeLessThanOrEqual(512);
    expect(stats?.displayObjects).toBeGreaterThan(100);
    expect(stats?.chunksLive).toBeGreaterThan(0);
    unmount();
    await settle();
    expect(window.__luadyStageStats).toBeUndefined();
  });

  it('ends a room focus in detailed mode on a 390×844 phone with the room sheet open (the HQ chip)', async () => {
    const p = props();
    const { rerender } = render(<AgencyStage {...p} />);
    await settle();
    const app = fake.Application.instances[0];
    act(() => app?.renderer.resize(390, 844));
    rerender(<AgencyStage {...p} focus={{ kind: 'room', room: HQ_ID }} insets={stageInsets({ width: 390, height: 844 }, true)} />);
    await settle();
    for (let i = 0; i < 4; i += 1) act(() => fake.Ticker.shared.tick(16));
    expect(Viewport.instances.at(-1)?.scale.x).toBeGreaterThanOrEqual(FAR_SCALE);
    expect(window.__luadyStageStats?.().far).toBe(false);
  });

  it('shows the rooms it is given, empty, while the snapshot is of other rooms', async () => {
    const onFrame = vi.fn<(points: readonly OverlayPoint[]) => void>();
    render(<AgencyStage {...props({ onFrame, rooms: roomsOf(5) })} />);
    await settle();
    act(() => fake.Ticker.shared.tick(16));
    const points = onFrame.mock.lastCall?.[0] ?? [];
    expect(points.filter((p) => p.kind === 'room').map((p) => p.id)).toContain('site-05');
    expect(points.filter((p) => p.kind === 'actor').map((p) => p.id)).toEqual(['manager']);
  });

  it('draws the rooms prop and the snapshot together once the snapshot is built from the same rooms', async () => {
    const onFrame = vi.fn<(points: readonly OverlayPoint[]) => void>();
    const { roomSnap } = await import('./office-fixtures.js');
    const rooms = roomsOf(5);
    render(<AgencyStage {...props({ onFrame, rooms, snapshot: roomSnap(rooms, 1) })} />);
    await settle();
    act(() => fake.Ticker.shared.tick(16));
    const actors = (onFrame.mock.lastCall?.[0] ?? []).filter((p) => p.kind === 'actor').map((p) => p.id).sort();
    expect(actors).toEqual(['ash:s00', 'birch:s00', 'cedar:s00', 'local:s00', 'manager', 'site-05:s00']);
  });

  it('never builds the objects of every room of a big office, not even for its first frame', async () => {
    const { roomSnap } = await import('./office-fixtures.js');
    const big = roomSnap(roomsOf(100), 1);
    const deskTotal = Object.values(big.slots).reduce((n, list) => n + list.length, 0);
    const counts = (app: fake.Application | undefined) => {
      const all = app?.stage.all() ?? [];
      return { desks: all.filter((n) => n.label.startsWith('desk:')).length, actors: all.filter((n) => n.label.startsWith('actor:')).length };
    };
    render(<AgencyStage {...props({ snapshot: big })} />);
    await settle();
    const app = fake.Application.instances[0];
    const before = counts(app);
    act(() => fake.Ticker.shared.tick(16));
    const after = counts(app);
    [before, after].forEach((c) => {
      expect(c.desks).toBeLessThan(deskTotal / 2);
      expect(c.actors).toBeLessThan(Object.keys(big.actors).length / 2);
    });
    expect(window.__luadyStageStats?.().displayObjects).toBeLessThanOrEqual(13_160);
  });

  it('draws a harness office of any size from the address in dev builds', async () => {
    window.history.replaceState(null, '', '/?stage-rooms=24&stage-sessions=1');
    try {
      const onFrame = vi.fn<(points: readonly OverlayPoint[]) => void>();
      render(<AgencyStage {...props({ onFrame })} />);
      await settle();
      act(() => fake.Ticker.shared.tick(16));
      const rooms = (onFrame.mock.lastCall?.[0] ?? []).filter((p) => p.kind === 'room').map((p) => p.id);
      expect(rooms).toContain('site-24');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('stops drawing while the tab is hidden', async () => {
    render(<AgencyStage {...props()} />);
    await settle();
    const app = fake.Application.instances[0];
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(app?.stop).toHaveBeenCalled();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(app?.start).toHaveBeenCalled();
  });
});

import type { AgencySnapshot } from '@luady/office';
import type { RoomDTO } from '@luady/shared';
import { Container, type Ticker } from 'pixi.js';
import type {
  OverlayPoint, StageAmbience, StageEvent, StageFocus, StageHandle, StageInsets, StageStats, StageTarget, StageView,
} from '../stage-types.js';
import { createActorLayer, type ActorLayer } from './actors.js';
import { createAmbienceLayer, type AmbienceLayer } from './ambience-layer.js';
import { createStageApp, type StageApp } from './app.js';
import { createCamera, type Camera } from './camera.js';
import { createChunkBank, pixiChunkGpu, type ChunkBank } from './chunk-bank.js';
import { loadCharacterSheet, type CharacterSheet } from './character-sheet.js';
import { createDensity } from './density.js';
import { attachInput } from './input.js';
import { chunkBudget, liveView, type LiveView } from './live-set.js';
import { overlayPoints, type ScreenView } from './overlay-points.js';
import { SLICE_MS } from './paint-queue.js';
import { pickAt, targetOf, type Pick } from './picking.js';
import { roomsSnapshot } from './stage-rooms.js';
import { countNodes, installStats } from './stage-stats.js';
import { createTextureBank, type TextureBank } from './textures.js';
import { createWorldLayer, type WorldLayer } from './world-layer.js';

export interface SceneState {
  readonly snapshot: AgencySnapshot;
  /** A new value: the snapshot set with it comes from a fresh overview load and seats its newcomers at once. */
  readonly settleKey: number;
  readonly focus: StageFocus;
  readonly selectedId: string | null;
  readonly insets: StageInsets;
  readonly reducedMotion: boolean;
  /** Day and night: absent means on, not quiet. */
  readonly ambience?: StageAmbience;
  /** The office's rooms when the page has them (see AgencyStageProps.rooms). */
  readonly rooms?: readonly RoomDTO[];
}

export interface SceneCallbacks {
  onEvent(event: StageEvent): void;
  onFrame(points: readonly OverlayPoint[]): void;
  onFailed(reason: string): void;
  /** Once per animation frame while the view moves, and once when it settles. */
  onView?(view: StageView): void;
}

/** The office scene, driven imperatively. React pushes props in with `set`; nothing re-renders per frame. */
export interface Scene {
  set(state: SceneState): void;
  /** Pause drawing (hidden tab, stage off screen) or resume it. */
  setRunning(on: boolean): void;
  destroy(): Promise<void>;
  /** For the page (drag and drop): what is under a point, and lighting up a drop target. */
  readonly handle: StageHandle;
  /** What the stats hook reports (also installed as window.__luadyStageStats in dev and demo builds). */
  stats(): StageStats;
}

/** The reason given when the scene broke after it started. */
export const SCENE_FAILED = 'scene-failed';
/** Longest step of the walk clock, so a resumed tab does not teleport walkers. */
const MAX_STEP_MS = 100;
const NOTHING: Pick = Object.freeze({ actor: null, fixture: null, room: null });
const MIB = 1024 * 1024;

interface Parts {
  readonly bank: TextureBank; readonly chunks: ChunkBank; readonly world: WorldLayer; readonly actors: ActorLayer; readonly camera: Camera;
  readonly ambience: AmbienceLayer;
}

/** Builds the layers: map and furniture, characters, their bubbles and marks, then the dimming on top. */
const assemble = (stage: StageApp, sheet: CharacterSheet | null, onSettle: () => void): Parts => {
  const bank = createTextureBank(sheet);
  const chunks = createChunkBank({ gpu: pixiChunkGpu(stage.app.renderer as unknown as Parameters<typeof pixiChunkGpu>[0]) });
  const world = createWorldLayer(bank, chunks);
  const overlay = new Container();
  overlay.label = 'overlay';
  const density = createDensity(stage.app);
  const camera = createCamera(stage.app, {
    onSettle: (scale) => {
      density.apply(scale);
      onSettle();
    },
  });
  camera.viewport.addChild(world.root, overlay, world.shade, camera.dim);
  stage.app.stage.addChild(camera.viewport);
  const actors = createActorLayer(bank, world.sorted, overlay);
  const ambience = createAmbienceLayer(world, bank, chunks);
  return { bank, chunks, world, actors, camera, ambience };
};

/** Where things are on screen now: characters, fixtures and rooms, in stage CSS pixels. */
const framePoints = ({ actors, camera }: Parts, snapshot: AgencySnapshot, live: LiveView | null): readonly OverlayPoint[] => {
  const { viewport } = camera;
  const view: ScreenView = {
    toScreen: (x, y) => viewport.toScreen(x, y),
    width: viewport.screenWidth, height: viewport.screenHeight, scale: viewport.scale.x, bright: camera.bright(),
  };
  return overlayPoints(snapshot, actors.bodies(), view, live);
};

/** Lights up a drop target: characters in the actor layer, rooms and fixtures in the world layer. */
const showDropHint = ({ actors, world }: Parts, target: StageTarget | null): void => {
  actors.setDropHint(target?.kind === 'actor' ? target.id : null);
  world.setDropHint(target === null || target.kind === 'actor' ? null : target);
};

const run = (stage: StageApp, callbacks: SceneCallbacks, sheet: CharacterSheet | null): Scene => {
  const { app } = stage;
  let settled = false;
  const parts = assemble(stage, sheet, () => { settled = true; });
  const { bank, chunks, world, actors, camera, ambience } = parts;
  let state: SceneState | null = null;
  /** The snapshot drawn: the page's, or an empty office of its `rooms` (stage-rooms.ts). */
  let shown: AgencySnapshot | null = null;
  let live: LiveView | null = null;
  let hoverRoom: string | null = null;
  let dirty = true;
  let viewDirty = true;
  let chunkVersion = -1;
  let failed = false;

  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    console.error('[agency] the office scene stopped', error);
    app.stop();
    callbacks.onFailed(SCENE_FAILED);
  };

  const refreshHot = (): void => world.setHot(new Set([camera.room(), hoverRoom].filter((r): r is string => r !== null)));

  /** What the camera shows of a map now; tells the page. */
  const viewOf = (of: AgencySnapshot): LiveView => {
    const v = camera.view();
    const made = liveView(of.map, v.rect, v.scale, v.centre);
    callbacks.onView?.({ rect: v.rect, scale: v.scale, far: made.far });
    return made;
  };

  /** Works out what the camera shows and hands it to every layer. */
  const updateView = (): void => {
    if (shown === null) return;
    live = viewOf(shown);
    world.setView(live);
    ambience.setView(live);
    actors.setView(live);
  };

  /** Shows the chunks painted since, and tells the bank what the view keeps. */
  const keepChunks = (): void => {
    if (live === null) return;
    if (chunks.version() !== chunkVersion) {
      world.setView(live);
      ambience.setView(live);
      chunkVersion = chunks.version();
    }
    const keepLive = new Set<string>();
    const keepRing = new Set<string>();
    world.keep(keepLive, keepRing);
    ambience.keep(keepLive, keepRing);
    chunks.retain(keepLive, keepRing, live.centre);
  };

  const tick = (ticker: Ticker): void => {
    if (failed || state === null || shown === null) return;
    try {
      const now = performance.now();
      const walked = actors.frame(now, Math.min(ticker.deltaMS, MAX_STEP_MS));
      world.tick(state.reducedMotion ? 0 : now);
      ambience.tick(now);
      const moved = camera.frame();
      if (moved || viewDirty || settled) {
        viewDirty = false;
        settled = false;
        updateView();
      }
      chunks.paint(SLICE_MS);
      keepChunks();
      bank.frameEnd(now);
      if (!walked && !moved && !dirty) return;
      dirty = false;
      callbacks.onFrame(framePoints(parts, shown, live));
    } catch (error) {
      fail(error);
    }
  };

  const onResize = (width: number, height: number): void => {
    camera.resize(width, height);
    chunks.setBudget(chunkBudget(width, height));
    dirty = true;
    viewDirty = true;
  };

  /** A lost WebGL context came back: the chunk textures kept no pixels, so every live chunk is painted again. */
  const onRestored = (): void => {
    chunks.invalidate();
    viewDirty = true;
    dirty = true;
  };

  const pickPoint = (x: number, y: number): Pick => {
    if (shown === null) return NOTHING;
    const w = camera.viewport.toWorld(x, y);
    return pickAt(shown, actors.bodies(), w.x, w.y, camera.viewport.scale.x);
  };
  const handle: StageHandle = Object.freeze({
    pick: (x: number, y: number) => targetOf(pickPoint(x, y)),
    setDropHint: (target: StageTarget | null) => {
      if (failed) return;
      showDropHint(parts, target);
      dirty = true;
    },
  });

  const detachInput = attachInput({
    canvas: app.canvas,
    onGesture: (start) => {
      camera.viewport.on('drag-start', start).on('pinch-start', start);
      return () => { camera.viewport.off('drag-start', start).off('pinch-start', start); };
    },
    pick: (p) => pickPoint(p.x, p.y),
    emit: (event) => callbacks.onEvent(event),
    hover: (actor, fixture, room) => {
      actors.setHover(actor);
      world.setFixtureHover(fixture);
      hoverRoom = room;
      refreshHot();
    },
    setCursor: (cursor) => { camera.viewport.cursor = cursor; },
  });

  const apply = (next: SceneState): void => {
    if (next.reducedMotion !== state?.reducedMotion) {
      actors.setReducedMotion(next.reducedMotion);
      camera.setReducedMotion(next.reducedMotion);
    }
    ambience.setOptions({ enabled: next.ambience?.enabled ?? true, quiet: next.ambience?.quiet ?? false, reduced: next.reducedMotion });
    const snapshot = roomsSnapshot(next.snapshot, next.rooms);
    if (snapshot !== shown) {
      // A new map: aim first and give every layer the view of it with the snapshot, so none builds every room's objects.
      if (shown?.map !== snapshot.map) {
        camera.update(snapshot, next.focus, next.insets);
        live = viewOf(snapshot);
        actors.setView(live);
      }
      world.update(snapshot, live ?? undefined);
      ambience.update(snapshot, live ?? undefined);
      actors.apply(snapshot, next.settleKey !== state?.settleKey);
      shown = snapshot;
    }
    camera.update(snapshot, next.focus, next.insets);
    actors.setSelected(next.selectedId);
    state = next;
    refreshHot();
    dirty = true;
  };

  const stats = (): StageStats => {
    const c = chunks.stats();
    const o = bank.stats();
    return Object.freeze({
      textures: c.textures + o.textures,
      textureMiB: c.bytes / MIB,
      otherMiB: o.bytes / MIB,
      displayObjects: countNodes(app.stage),
      chunksLive: live?.chunks.length ?? 0,
      liveRooms: live?.live.length ?? 0,
      pending: c.queued + c.releasing + world.behind() + ambience.behind(),
      far: live?.far ?? false,
      largestSide: c.largestSide,
    });
  };
  const uninstallStats = installStats(stats);

  app.renderer.on('resize', onResize);
  app.canvas.addEventListener('webglcontextrestored', onRestored);
  camera.resize(app.screen.width, app.screen.height);
  chunks.setBudget(chunkBudget(app.screen.width, app.screen.height));
  app.ticker.add(tick);

  return {
    handle,
    stats,
    set: (next) => {
      if (failed) return;
      try {
        apply(next);
      } catch (error) {
        fail(error);
      }
    },
    setRunning: (on) => {
      if (on && !failed) app.start();
      else app.stop();
    },
    destroy: async () => {
      uninstallStats();
      app.ticker.remove(tick);
      app.renderer.off('resize', onResize);
      app.canvas.removeEventListener('webglcontextrestored', onRestored);
      detachInput();
      camera.destroy();
      actors.destroy();
      world.destroy();
      chunks.destroy();
      await stage.destroy();
      bank.destroy();
    },
  };
};

/**
 * Starts PixiJS in `host` and builds the office on it. The character sheet loads while PixiJS starts; without it the
 * office opens with the code-drawn characters. Rejects with 'webgl-unavailable' or 'scene-failed'.
 */
export async function createScene(host: HTMLElement, callbacks: SceneCallbacks): Promise<Scene> {
  const loading = loadCharacterSheet();
  let stage: StageApp;
  try {
    stage = await createStageApp(host);
  } catch (error) {
    void loading.then((sheet) => sheet?.destroy());
    throw error;
  }
  const sheet = await loading;
  try {
    return run(stage, callbacks, sheet);
  } catch (error) {
    console.error('[agency] could not build the office scene', error);
    await stage.destroy();
    throw new Error(SCENE_FAILED, { cause: error });
  }
}

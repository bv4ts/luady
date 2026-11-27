import {
  EXTERIOR_MARGIN, MUTE_PALETTE, lighten, roomRectPx, type AgencySnapshot, type ChunkOptions, type MonitorGlow, type Palette, type PropDef,
  type RoomDef,
} from '@luady/office';
import { Container, Sprite, Texture, TilingSprite } from 'pixi.js';
import type { ChunkBank } from './chunk-bank.js';
import { createChunkSprites } from './chunk-sprites.js';
import { FUEL_H, FUEL_TINT, FUEL_W, fuelBar } from './fuel.js';
import { createHighlights } from './highlights.js';
import { contains, type LiveView } from './live-set.js';
import { hexToTint, rackLights } from './rack-lights.js';
import type { TextureBank } from './textures.js';

/**
 * The world, bottom to top: the repeating grass over everything the camera can show, the garden (chunk sprites), the
 * building's floor and walls (chunk sprites), room frames, then furniture, desks and actors in `sorted` so depth works.
 * Per-room objects exist only for the view's rooms; in far mode there are none, and only the floor,
 * the garden and the daylight draw.
 */
export interface WorldLayer {
  readonly root: Container;
  /** The grass and the garden: the ambience tints it. */
  readonly garden: Container;
  /** The building, its furniture and its characters: the ambience tints it. */
  readonly building: Container;
  /** Empty layers the ambience fills: over the garden, over the floor (under the furniture), over everything indoors. */
  readonly light: { readonly garden: Container; readonly indoor: Container; readonly over: Container };
  /** Furniture, desks and characters, drawn in order of where they touch the floor. */
  readonly sorted: Container;
  /** Shades over rooms whose server is offline or connecting; add it above the characters and their bubbles. */
  readonly shade: Container;
  /** Takes a snapshot, and with it the view of its map when that changed (one sync for both). */
  update(snapshot: AgencySnapshot, view?: LiveView): void;
  /** What the camera shows now: draws its chunks, makes the objects of its rooms, and switches far mode. */
  setView(view: LiveView): void;
  /** Adds the chunk keys the garden and floor show or want (see ChunkSprites.keep). */
  keep(live: Set<string>, ring: Set<string>): void;
  /** Live chunks not yet showing their wanted texture. */
  behind(): number;
  /** Animates what moves by itself (rack lights). Pass 0 for a still picture. */
  tick(nowMs: number): void;
  /** Rooms drawn with a thicker, lighter frame (the focused and the hovered one). */
  setHot(rooms: ReadonlySet<string>): void;
  /** The fixture under the pointer (its id) gets a one-pixel light outline; null clears it. */
  setFixtureHover(id: string | null): void;
  /** While something is dragged: a room glows inside its edge, a fixture gets a bright outline; null clears both. */
  setDropHint(target: WorldDropHint | null): void;
  destroy(): void;
}

/** What the world layer lights up for a drop (characters are lit by the actor layer). */
export type WorldDropHint = { readonly kind: 'room'; readonly room: string } | { readonly kind: 'fixture'; readonly id: string };

/** The hover outline, and the brighter drop-target outline. */
export const OUTLINE_TINT = { hover: 0xe9eef7, drop: 0xffd84d } as const;

interface PropNode { readonly def: PropDef; readonly node: Container; readonly lights: readonly Sprite[] }
interface DeskNode { readonly node: Container; readonly screen: Sprite; readonly track: Sprite; readonly fuel: Sprite }

/** Desk sprite offsets: the monitor sits on the back of the desk, its screen at (1, 1). */
const MONITOR_AT = { x: 30, y: -9 } as const;
const DESK_DEPTH = 18;
/** The fuel bar lies on the monitor's bottom bezel row and the top of its stand, under the screen (rows 10–11). */
const FUEL_Y = 10;
/** Rack light offsets. */
const LIGHT_X = [19, 23] as const;

const rect = (x: number, y: number, w: number, h: number, tint: number, label: string): Sprite => {
  const s = new Sprite(Texture.WHITE);
  Object.assign(s, { x, y, width: w, height: h, tint, label });
  return s;
};

const sprite = (texture: Texture, x: number, y: number, label: string): Sprite => {
  const s = new Sprite(texture);
  Object.assign(s, { x, y, label });
  return s;
};

/** The four sides of a room's frame, in its own colour. */
const frameOf = (room: RoomDef, hot: boolean): readonly Sprite[] => {
  const q = roomRectPx(room);
  const base = room.palette.base;
  const tint = hexToTint(hot ? lighten(base, 0.28) : base);
  const wd = hot ? 3 : 2;
  const label = `frame:${room.id}`;
  return [
    rect(q.x - wd, q.y - wd, q.w + wd * 2, wd, tint, label),
    rect(q.x - wd, q.y + q.h, q.w + wd * 2, wd, tint, label),
    rect(q.x - wd, q.y, wd, q.h, tint, label),
    rect(q.x + q.w, q.y, wd, q.h, tint, label),
  ];
};

const makeProp = (def: PropDef, bank: TextureBank): PropNode => {
  const node = new Container();
  Object.assign(node, { x: def.x, y: def.y, zIndex: def.sortY, label: `prop:${def.id}` });
  node.addChild(sprite(bank.furniture(def.kind), 0, 0, def.kind));
  const lights = def.kind === 'rack'
    ? Array.from({ length: 12 }, (_, i) => rect(LIGHT_X[i % 2] ?? 0, 6 + Math.floor(i / 2) * 7, 2, 1, 0x1f3b2d, 'light'))
    : [];
  lights.forEach((l) => node.addChild(l));
  return { def, node, lights };
};

/** How far the grass reaches past the map on every side: beyond anything the camera can show at its widest. */
const GROUND_REACH = 4096;

/** The repeating grass, laid from a whole number of tiles before the map's origin so its pattern stays put. */
const groundSprite = (texture: Texture, width: number, height: number): TilingSprite => {
  const ground = new TilingSprite({ texture, width: width + GROUND_REACH * 2, height: height + GROUND_REACH * 2 });
  Object.assign(ground, { x: -GROUND_REACH, y: -GROUND_REACH, label: 'ground' });
  return ground;
};

/** The rooms that hang a Jira board, from the snapshot's fixtures. */
const jiraRooms = (snapshot: AgencySnapshot): readonly string[] => snapshot.fixtures.filter((f) => f.kind === 'jira').map((f) => f.room);

/** A room whose server link is down is drawn this much darker. */
const DOWN_TINT = 0x05070d;
const DOWN_ALPHA = 0.55;

/** True while the room's server is offline or still connecting (HQ and empty slots have no link). */
const linkDown = (snapshot: AgencySnapshot, key: string): boolean => {
  const status = snapshot.rooms[key]?.status ?? null;
  return status === 'offline' || status === 'connecting';
};

const sameProp = (a: PropDef, b: PropDef): boolean => a.kind === b.kind && a.x === b.x && a.y === b.y && a.sortY === b.sortY && a.room === b.room;

/** One desk of the snapshot: where it stands and what its monitor shows (its sitter's glow, or off when free). */
interface DeskSpot {
  readonly key: string; readonly x: number; readonly y: number; readonly glow: MonitorGlow; readonly palette: Palette;
  /** The sitter's context reading, for the fuel bar; null for a free desk or no reading. */
  readonly contextPct: number | null;
}

/** The sitters of a snapshot by desk, worked out once per snapshot. */
const SITTERS = new WeakMap<AgencySnapshot, ReadonlyMap<string, AgencySnapshot['actors'][string]>>();
const sittersOf = (snapshot: AgencySnapshot): ReadonlyMap<string, AgencySnapshot['actors'][string]> => {
  const known = SITTERS.get(snapshot);
  if (known !== undefined) return known;
  const made = new Map(Object.values(snapshot.actors).map((a) => [`${a.room}@${a.desk.x},${a.desk.y}`, a]));
  SITTERS.set(snapshot, made);
  return made;
};

/** The desks of these rooms (snapshot.slots: the desks that exist now), each matched with the actor sitting at it. */
const deskSpots = (snapshot: AgencySnapshot, rooms: ReadonlySet<string>): readonly DeskSpot[] => {
  const sitters = sittersOf(snapshot);
  return [...rooms].flatMap((room) => {
    const slots = snapshot.slots[room] ?? [];
    const palette = snapshot.map.rooms[room]?.palette ?? MUTE_PALETTE;
    return slots.map((slot) => {
      const key = `${room}@${slot.desk.x},${slot.desk.y}`;
      const sitter = sitters.get(key);
      return {
        key, x: slot.desk.x, y: slot.desk.y, glow: sitter?.visual.monitor ?? 'off', palette: sitter?.look.palette ?? palette,
        contextPct: sitter?.contextPct ?? null,
      };
    });
  });
};

const makeDesk = (spot: DeskSpot, bank: TextureBank): DeskNode => {
  const node = new Container();
  Object.assign(node, { x: spot.x, y: spot.y, zIndex: spot.y + DESK_DEPTH, label: `desk:${spot.key}` });
  const screen = sprite(bank.monitor(spot.glow, spot.palette), MONITOR_AT.x + 1, MONITOR_AT.y + 1, 'screen');
  const track = rect(MONITOR_AT.x + 1, MONITOR_AT.y + FUEL_Y, FUEL_W, FUEL_H, FUEL_TINT.track, 'fuel-track');
  const fuel = rect(MONITOR_AT.x + 1, MONITOR_AT.y + FUEL_Y, 1, FUEL_H, FUEL_TINT.green, 'fuel');
  node.addChild(sprite(bank.furniture('desk'), 0, 0, 'desk'), sprite(bank.furniture('monitor'), MONITOR_AT.x, MONITOR_AT.y, 'monitor'), screen, track, fuel);
  return { node, screen, track, fuel };
};

/** The fuel bar under the screen: its track and fill for the sitter's context, hidden with no reading. */
const showFuel = (desk: DeskNode, pct: number | null): void => {
  const bar = fuelBar(pct);
  desk.track.visible = bar !== null;
  desk.fuel.visible = bar !== null;
  if (bar !== null) Object.assign(desk.fuel, { width: bar.width, tint: bar.tint });
};

/** The props of a view: those of its rooms, and street furniture inside its reach. */
const propsIn = (snapshot: AgencySnapshot, view: LiveView): readonly PropDef[] =>
  view.far ? [] : snapshot.props.filter((p) => (p.room === null ? contains(view.reach, p.x, p.y) : view.rooms.has(p.room)));

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

export function createWorldLayer(bank: TextureBank, chunks: ChunkBank): WorldLayer {
  const root = new Container();
  root.label = 'world';
  let ground: TilingSprite | null = null;
  const exterior = createChunkSprites(chunks, 'exterior', 'exterior', { x: -EXTERIOR_MARGIN, y: -EXTERIOR_MARGIN });
  const floor = createChunkSprites(chunks, 'map', 'map');
  const frames = new Container();
  // Frames overlap where rooms meet: drawn in map order (zIndex), whichever was made last, as the classic office drew them.
  Object.assign(frames, { label: 'frames', sortableChildren: true });
  const sorted = new Container();
  Object.assign(sorted, { label: 'sorted', sortableChildren: true });
  const highlights = createHighlights();
  const layer = (label: string): Container => Object.assign(new Container(), { label });
  const garden = layer('garden');
  const building = layer('building');
  const light = { garden: layer('light:garden'), indoor: layer('light:indoor'), over: layer('light:over') };
  garden.addChild(exterior.root);
  building.addChild(floor.root, light.indoor, frames, highlights.glow, sorted, highlights.outline, light.over);
  root.addChild(garden, light.garden, building);
  const shade = new Container();
  shade.label = 'shade';
  let hoverFixture: string | null = null;
  let dropHint: WorldDropHint | null = null;

  /** Lays the grass once, and again only when the map changes size. */
  const layGround = (next: AgencySnapshot): void => {
    const { width, height } = next.map;
    if (ground !== null && ground.width === width + GROUND_REACH * 2 && ground.height === height + GROUND_REACH * 2) return;
    ground?.destroy();
    ground = groundSprite(bank.ground(), width, height);
    garden.addChildAt(ground, 0);
  };

  let props = new Map<string, PropNode>();
  let desks = new Map<string, DeskNode>();
  const frameNodes = new Map<string, { readonly hot: boolean; readonly sprites: readonly Sprite[]; readonly def: RoomDef }>();
  const shades = new Map<string, Sprite>();
  let snapshot: AgencySnapshot | null = null;
  let view: LiveView | null = null;
  let options: ChunkOptions = { jiraRooms: [] };
  let hot: ReadonlySet<string> = new Set();
  let shownRooms: ReadonlySet<string> = new Set();

  /** A frame for each of the view's rooms, redrawn when it turns hot or cold or its room changes. */
  const syncFrames = (rooms: ReadonlySet<string>): void => {
    frameNodes.forEach((f, key) => {
      const def = snapshot?.map.rooms[key];
      if (rooms.has(key) && def === f.def && hot.has(key) === f.hot) return;
      f.sprites.forEach((s) => s.destroy());
      frameNodes.delete(key);
    });
    const map = snapshot?.map;
    if (map === undefined) return;
    map.order.forEach((key, index) => {
      const def = map.rooms[key];
      if (def === undefined || !rooms.has(key) || frameNodes.has(key)) return;
      const sprites = frameOf(def, hot.has(key));
      sprites.forEach((s) => {
        s.zIndex = index;
        frames.addChild(s);
      });
      frameNodes.set(key, { hot: hot.has(key), sprites, def });
    });
  };

  /** One shade per room of the view whose link is down, over its floor and walls. */
  const syncShades = (rooms: ReadonlySet<string>): void => {
    const s = snapshot;
    const down = new Set(s === null ? [] : [...rooms].filter((key) => linkDown(s, key)));
    shades.forEach((node, key) => {
      if (down.has(key)) return;
      node.destroy();
      shades.delete(key);
    });
    down.forEach((key) => {
      const room = s?.map.rooms[key];
      if (room === undefined || shades.has(key)) return;
      const q = roomRectPx(room);
      const node = rect(q.x, q.y, q.w, q.h, DOWN_TINT, `shade:${key}`);
      node.alpha = DOWN_ALPHA;
      shade.addChild(node);
      shades.set(key, node);
    });
  };

  const syncProps = (next: readonly PropDef[]): void => {
    const kept = new Map<string, PropNode>();
    next.forEach((def) => {
      const old = props.get(def.id);
      if (old !== undefined && sameProp(old.def, def)) kept.set(def.id, old);
      else kept.set(def.id, makeProp(def, bank));
    });
    props.forEach((p, id) => { if (kept.get(id) !== p) p.node.destroy({ children: true }); });
    kept.forEach((p) => { if (p.node.parent !== sorted) sorted.addChild(p.node); });
    props = kept;
  };

  /** Draws every desk of the view's rooms (snapshot.slots, the same desks walking avoids); free desks keep a dark screen. */
  const syncDesks = (spots: readonly DeskSpot[]): void => {
    const kept = new Map<string, DeskNode>();
    spots.forEach((spot) => {
      const desk = desks.get(spot.key) ?? kept.get(spot.key) ?? makeDesk(spot, bank);
      desk.screen.texture = bank.monitor(spot.glow, spot.palette);
      showFuel(desk, spot.contextPct);
      kept.set(spot.key, desk);
    });
    desks.forEach((d, key) => { if (!kept.has(key)) d.node.destroy({ children: true }); });
    kept.forEach((d) => { if (d.node.parent !== sorted) sorted.addChild(d.node); });
    desks = kept;
  };

  /** Redraws the outline and the glow for the current hover, drop hint and snapshot (only for the view's rooms). */
  const drawHighlights = (): void => {
    const fixtures = snapshot?.fixtures ?? [];
    const dropId = dropHint?.kind === 'fixture' ? dropHint.id : null;
    const dropFixture = dropId === null ? undefined : fixtures.find((f) => f.id === dropId);
    const hovered = hoverFixture === null ? undefined : fixtures.find((f) => f.id === hoverFixture);
    const outlined = dropFixture ?? hovered;
    highlights.outlineBox(outlined?.box ?? null, dropFixture === undefined ? OUTLINE_TINT.hover : OUTLINE_TINT.drop);
    const room = dropHint?.kind === 'room' && snapshot !== null ? snapshot.map.rooms[dropHint.room] : undefined;
    highlights.glowRoom(room === undefined ? null : roomRectPx(room), room === undefined ? 0 : hexToTint(lighten(room.palette.base, 0.45)));
  };

  /** Far mode draws no per-room objects: furniture, frames, shades and highlights are hidden. */
  const showFar = (far: boolean): void => {
    [sorted, frames, highlights.glow, highlights.outline, shade].forEach((c) => { c.visible = !far; });
  };

  /** The objects of the view's rooms. Before the first view: every room (a whole-office first frame). */
  const syncRooms = (): void => {
    if (snapshot === null) return;
    const rooms = view?.rooms ?? new Set(snapshot.map.order);
    syncProps(view === null ? snapshot.props : propsIn(snapshot, view));
    syncDesks(deskSpots(snapshot, rooms));
    syncFrames(rooms);
    syncShades(rooms);
    shownRooms = rooms;
  };

  const syncChunks = (): void => {
    if (snapshot === null || view === null) return;
    exterior.sync(snapshot.map, view, options);
    floor.sync(snapshot.map, view, options);
  };

  return {
    root,
    garden,
    building,
    light,
    sorted,
    shade,
    update: (next, nextView) => {
      const jira = jiraRooms(next);
      if (jira.join('|') !== (options.jiraRooms ?? []).join('|')) options = { jiraRooms: jira };
      snapshot = next;
      if (nextView !== undefined) {
        view = nextView;
        showFar(nextView.far);
      }
      layGround(next);
      syncRooms();
      syncChunks();
      drawHighlights();
    },
    setView: (next) => {
      const roomsChanged = view === null || !sameSet(next.rooms, view.rooms) || next.far !== view.far
        || next.reach.x !== view.reach.x || next.reach.y !== view.reach.y || next.reach.w !== view.reach.w || next.reach.h !== view.reach.h;
      view = next;
      showFar(next.far);
      if (roomsChanged) syncRooms();
      syncChunks();
    },
    keep: (live, ring) => {
      exterior.keep(live, ring);
      floor.keep(live, ring);
    },
    behind: () => exterior.behind() + floor.behind(),
    tick: (nowMs) => {
      if (snapshot === null || view?.far === true) return;
      const rooms = snapshot.rooms;
      props.forEach((p) => {
        if (p.lights.length === 0 || p.def.room === null) return;
        const room = rooms[p.def.room];
        // The room's own link decides: a rack whose server is not online stays dark, whatever its last numbers said.
        const rack = room?.status === 'online' ? room.rack : null;
        const rows = rackLights(rack, hexToTint((room?.def.palette ?? MUTE_PALETTE).base), nowMs, p.def.x);
        p.lights.forEach((l, i) => {
          const row = rows[Math.floor(i / 2)];
          if (row !== undefined) l.tint = i % 2 === 0 ? row.activity : row.team;
        });
      });
    },
    setHot: (rooms) => {
      const same = sameSet(rooms, hot);
      hot = new Set(rooms);
      if (!same) syncFrames(shownRooms);
    },
    setFixtureHover: (id) => {
      if (id === hoverFixture) return;
      hoverFixture = id;
      drawHighlights();
    },
    setDropHint: (target) => {
      dropHint = target;
      drawHighlights();
    },
    destroy: () => {
      props.forEach((p) => p.node.destroy({ children: true }));
      desks.forEach((d) => d.node.destroy({ children: true }));
      props = new Map();
      desks = new Map();
      frameNodes.clear();
      shades.clear();
      snapshot = null;
      exterior.destroy();
      floor.destroy();
      shade.destroy({ children: true });
      root.destroy({ children: true });
    },
  };
}

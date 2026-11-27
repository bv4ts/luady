import { darken, mix } from '../colors.js';
import { WALL_BOARD_H, decorOf, hqRugs } from '../decor.js';
import type { FixtureOptions } from '../fixtures.js';
import { geometryOf, type Street } from '../grid.js';
import { roomsMeeting, type OfficeMap } from '../layout.js';
import { paint, paintWindow, type Painter, type Raster } from '../raster.js';
import { isEmptySlot, isFurnished, type RoomDef } from '../rooms.js';
import { HQ_PALETTE, MUTE_PALETTE } from '../teams.js';
import { TILE as T, type Palette, type PixelRect, type TileRect } from '../types.js';
import { roomPanes } from './panes.js';

const FLOOR = '#2a3040';
const FLOOR2 = '#2e3546';
const HALL = '#232936';
const HALL2 = '#272e3c';
const CAP = '#151a27';
const FACE = '#39435a';
const FACE_HI = '#4b5874';
const VACANT_FLOOR = '#141925';
const INK = '#10141d';
/** Pane glass in the outer walls, as it looks at dusk (the scene lights it by day and night). */
const GLASS = '#1c2838';
const GLASS_HI = '#2f405a';

const pxOf = (r: TileRect): PixelRect => ({ x: r.x * T, y: r.y * T, w: r.w * T, h: r.h * T });
const meets = (a: PixelRect, b: PixelRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A two-tone tile checker over `r`; with `cull`, only the tiles that meet it (the others would paint nothing there). */
const checker = (p: Painter, r: TileRect, a: string, b: string, cull?: PixelRect): void => {
  const x0 = cull === undefined ? r.x : Math.max(r.x, Math.floor(cull.x / T));
  const x1 = cull === undefined ? r.x + r.w : Math.min(r.x + r.w, Math.ceil((cull.x + cull.w) / T));
  const y0 = cull === undefined ? r.y : Math.max(r.y, Math.floor(cull.y / T));
  const y1 = cull === undefined ? r.y + r.h : Math.min(r.y + r.h, Math.ceil((cull.y + cull.h) / T));
  for (let ty = y0; ty < y1; ty += 1) for (let tx = x0; tx < x1; tx += 1) p.rect(tx * T, ty * T, T, T, (tx + ty) % 2 === 0 ? a : b);
};

/** A street (or the avenue) and the cap of its outer wall. Outside the building the picture stays transparent. */
const drawStreet = (p: Painter, s: Street, cull?: PixelRect): void => {
  checker(p, s.rect, HALL, HALL2, cull);
  if (s.wall !== null) p.rect(s.wall.x * T, s.wall.y * T, s.wall.w * T, s.wall.h * T, CAP);
};

/** Floor, back wall with its colour stripe, and the side and front walls of one room. Empty slots get a dark floor. */
const drawShell = (p: Painter, room: RoomDef): void => {
  const { base } = room.palette;
  const { x: rx, y: ry, w: rw, h: rh } = room.rect;
  const [x, y, w, h] = [rx * T, ry * T, rw * T, rh * T];
  if (isEmptySlot(room)) p.rect(x, y, w, h, VACANT_FLOOR);
  else checker(p, room.rect, mix(FLOOR, base, 0.12), mix(FLOOR2, base, 0.18));
  p.rect(x, y, w, T * 2, FACE);
  p.rect(x, y, w, 6, CAP);
  p.rect(x, y + 6, w, 1, FACE_HI);
  p.rect(x, y + T * 2 - 5, w, 2, base);
  p.rect(x, y + T * 2 - 1, w, 1, darken(FACE, 0.5));
  p.rect(x, y, T, h, CAP);
  p.rect(x + w - T, y, T, h, CAP);
  p.rect(x, y + h - T, w, T, CAP);
  p.rect(x + T - 1, y + T * 2, 1, h - T * 3, FACE_HI);
  p.rect(x + w - T, y + T * 2, 1, h - T * 3, FACE_HI);
  p.rect(x + T, y + h - T, w - T * 2, 1, FACE_HI);
};

const drawDoorway = (p: Painter, r: TileRect, palette: Palette): void => {
  const { base } = palette;
  checker(p, r, HALL, HALL2);
  p.rect(r.x * T + 3, r.y * T + 3, r.w * T - 6, r.h * T - 6, darken(base, 0.3));
  p.rect(r.x * T + 5, r.y * T + 5, r.w * T - 10, r.h * T - 10, darken(base, 0.12));
};

const drawRug = (p: Painter, r: TileRect, colour: string): void => {
  p.rect(r.x * T, r.y * T, r.w * T, r.h * T, mix(FLOOR, colour, 0.5));
  p.rect(r.x * T + 3, r.y * T + 3, r.w * T - 6, r.h * T - 6, mix(FLOOR, colour, 0.34));
};

const drawKanban = (p: Painter, x: number, y: number, w: number): void => {
  const heads = ['#ffb648', '#5aa2ff', '#54d38a'];
  p.rect(x, y, w, WALL_BOARD_H, INK);
  p.rect(x + 1, y + 1, w - 2, WALL_BOARD_H - 2, '#e9eef7');
  p.rect(x + 1, y + 1, w - 2, 3, '#2f6fe0');
  heads.forEach((head, c) => {
    const cx = x + 4 + c * 19;
    p.rect(cx, y + 6, 15, 3, head);
    if (c < 2) p.rect(cx, y + 11, 15, 3, '#b9c3d6');
  });
};

const drawTeamBoard = (p: Painter, x: number, y: number, w: number, colour: string): void => {
  p.rect(x, y, w, WALL_BOARD_H, INK);
  p.rect(x + 1, y + 1, w - 2, WALL_BOARD_H - 2, '#e9eef7');
  p.rect(x + 5, y + 5, 20, 1, '#5aa2ff');
  p.rect(x + 5, y + 8, 30, 1, '#5b6577');
  p.rect(x + 5, y + 11, 14, 1, '#e23a2e');
  p.rect(x + w - 16, y + 5, 9, 8, colour);
};

/**
 * Door, rug and wall board of a furnished room. Empty slots have none of them; a room with a Jira board (a sprite of
 * its own) leaves its wall bare where the painted board would hang.
 */
const drawRoomExtras = (p: Painter, room: RoomDef, jira: boolean): void => {
  const decor = isFurnished(room) ? decorOf(room) : null;
  if (decor === null) return;
  const colour = room.palette.base;
  drawDoorway(p, room.doorway, room.palette);
  if (decor.rug !== null) drawRug(p, decor.rug, colour);
  if (jira) return;
  const b = decor.board;
  if (b.kind === 'kanban') drawKanban(p, b.x, b.y, b.w);
  else drawTeamBoard(p, b.x, b.y, b.w, colour);
};

const roomsOf = (map: OfficeMap): readonly RoomDef[] => map.order.flatMap((key) => map.rooms[key] ?? []);

/**
 * Paints the floor, walls, doors, rugs and painted wall boards of the building in map pixels:
 * streets and the avenue, every room's shell, the rooms' doors, rugs and boards, HQ's doors, the street doors, HQ's
 * rugs, then the glass of the panes. Everything outside the building, and the courts, stay transparent: the exterior
 * picture and the ground show through. With `cull`, only what meets it is drawn (the rooms through a slot lookup);
 * the pixels inside `cull` are the same either way.
 */
export function drawMap(p: Painter, map: OfficeMap, options?: FixtureOptions, cull?: PixelRect): void {
  const g = geometryOf(map);
  const rooms = cull === undefined ? roomsOf(map) : roomsMeeting(map, cull);
  const near = (r: TileRect): boolean => cull === undefined || meets(pxOf(r), cull);
  const jira = new Set(options?.jiraRooms ?? []);
  g.streets.filter((s) => near(s.rect)).forEach((s) => drawStreet(p, s, cull));
  rooms.forEach((room) => drawShell(p, room));
  rooms.forEach((room) => drawRoomExtras(p, room, jira.has(room.id)));
  g.hqDoors.filter(near).forEach((door) => drawDoorway(p, door, HQ_PALETTE));
  g.entries.filter(near).forEach((entry) => drawDoorway(p, entry, MUTE_PALETTE));
  const rugs = hqRugs(g);
  if (near(rugs.desk)) drawRug(p, rugs.desk, HQ_PALETTE.base);
  rugs.corners.filter(([r]) => near(r)).forEach(([r, colour]) => drawRug(p, r, colour));
  rooms.forEach((room) => roomPanes(map, room).forEach(({ glass: gl }) => {
    p.rect(gl.x, gl.y, gl.w, gl.h, GLASS);
    p.rect(gl.x, gl.y, gl.w > gl.h ? gl.w : 1, gl.w > gl.h ? 1 : gl.h, GLASS_HI);
  }));
}

/** The map layer, map-sized (1344 x 672 for the classic four): drawMap over the whole map. The oracle of the map chunks. */
export function mapLayerRaster(map: OfficeMap, options?: FixtureOptions): Raster {
  return paint(map.width, map.height, (p) => drawMap(p, map, options));
}

/** The map layer over a frame of the map, in map pixels (a chunk, cropped): never larger than the frame. */
export function mapLayerWindow(map: OfficeMap, win: PixelRect, options?: FixtureOptions): Raster {
  return paintWindow(win, (p) => drawMap(p, map, options, win));
}

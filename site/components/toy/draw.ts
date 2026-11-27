/**
 * Draws the office toy the way the product draws its office: the world, the rooms' frames in map order, lamplight,
 * then furniture, desks and creatures sorted by where they touch the floor, the working rings, and the bubbles.
 */
import { bubble, critter, desk, ring, roomInside, screen, sprite, type Frame, type Kit, type Point } from '../pixel/kit';
import { BUILD_DESKS_MS, BUILD_TILES_MS, LAMP_STEP_MS, type Actor, type Build, type Toy } from './sim';
import { FRAME_ORDER, HQ_COLOUR, LOT_COLOUR, OFFICE, WORLD } from './world';

const TILE = 16;
const DARK = 'rgba(4, 7, 22, 0.6)';

interface Tile { x: number; y: number; at: number }
const tilesOf = new WeakMap<Build, Tile[]>();

/** The order a room's floor goes down in: outward from its door, in whole tiles. */
function buildTiles(b: Build): Tile[] {
  const cached = tilesOf.get(b);
  if (cached !== undefined) return cached;
  const { rect, doorway } = b.info;
  const door = { x: doorway.x + doorway.w / 2 - rect.x, y: doorway.y + doorway.h / 2 - rect.y };
  const tiles: Tile[] = [];
  let far = 1;
  for (let y = 0; y < rect.h; y += TILE) {
    for (let x = 0; x < rect.w; x += TILE) {
      const d = Math.hypot(x + TILE / 2 - door.x, y + TILE / 2 - door.y);
      far = Math.max(far, d);
      tiles.push({ x, y, at: d });
    }
  }
  for (const t of tiles) t.at = (t.at / far) * (BUILD_TILES_MS - 160) + ((t.x * 7 + t.y * 13) % 5) * 24;
  tilesOf.set(b, tiles);
  return tiles;
}

const lampOrder = [...OFFICE.lamps].sort((a, b) => a[0] - b[0]);

function frameRect(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, colour: string): void {
  ctx.fillStyle = colour;
  ctx.fillRect(r.x - 2, r.y - 2, r.w + 4, 2);
  ctx.fillRect(r.x - 2, r.y + r.h, r.w + 4, 2);
  ctx.fillRect(r.x - 2, r.y, 2, r.h);
  ctx.fillRect(r.x + r.w, r.y, 2, r.h);
}

/** How many of the lamps are lit now (they come on one after another, and go off together quickly). */
export function lampsLit(toy: Toy): number {
  const t = toy.now - toy.lights.at;
  const n = lampOrder.length;
  if (toy.lights.on) return Math.min(n, Math.floor(t / LAMP_STEP_MS) + 1);
  return Math.max(0, n - Math.floor(t / 25) - 1);
}

interface Item { z: number; k: number; draw: () => void }

export function drawToy(ctx: CanvasRenderingContext2D, kit: Kit, toy: Toy, scale: number, width: number, height: number): void {
  const now = toy.now;
  const motion = !toy.reduced;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#101b17';
  ctx.fillRect(0, 0, width, height);
  const cx = Math.round(toy.camera.x * scale) / scale;
  const cy = Math.round(toy.camera.y * scale) / scale;
  ctx.setTransform(scale, 0, 0, scale, -cx * scale, -cy * scale);
  const view = { x: cx, y: cy, w: width / scale, h: height / scale };

  // 1. the world: the part of it in view
  if (kit.world !== null) {
    const sx = Math.max(0, Math.floor(view.x - WORLD.x));
    const sy = Math.max(0, Math.floor(view.y - WORLD.y));
    const sw = Math.min(WORLD.w - sx, Math.ceil(view.w) + 2);
    const sh = Math.min(WORLD.h - sy, Math.ceil(view.h) + 2);
    if (sw > 0 && sh > 0) ctx.drawImage(kit.world, sx, sy, sw, sh, WORLD.x + sx, WORLD.y + sy, sw, sh);
  }

  // 2. rooms going up on the lots, tile by tile
  for (const b of toy.builds) {
    const t = now - b.startedAt;
    const { rect } = b.info;
    if (t >= BUILD_TILES_MS) {
      roomInside(ctx, kit, b.info.shell, rect.x, rect.y);
      continue;
    }
    for (const tile of buildTiles(b)) {
      if (t < tile.at) continue;
      roomInside(ctx, kit, b.info.shell, rect.x, rect.y, { x: tile.x, y: tile.y, w: Math.min(TILE, rect.w - tile.x), h: Math.min(TILE, rect.h - tile.y) });
      if (t - tile.at < 90) {
        ctx.fillStyle = 'rgba(255, 244, 220, 0.55)';
        ctx.fillRect(rect.x + tile.x, rect.y + tile.y, TILE, TILE);
      }
    }
  }

  // 3. every room's frame, in the office's order (a finished room takes its colour)
  for (const id of FRAME_ORDER) {
    const b = toy.builds.find((x) => x.info.lot === id && now - x.startedAt >= BUILD_TILES_MS);
    const room = OFFICE.rooms[id];
    if (room === undefined) continue;
    const colour = b !== undefined ? b.info.palette.base : room.lot ? LOT_COLOUR : id === 'hq' ? HQ_COLOUR : room.palette.base;
    frameRect(ctx, b !== undefined ? b.info.rect : room.rect, colour);
  }

  // 4. lamplight
  const lit = lampsLit(toy);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.55;
  for (let i = 0; i < lit; i += 1) sprite(ctx, kit, 'pools/lamp', lampOrder[i][0] - 26, lampOrder[i][1] - 12);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // 5. furniture, desks and creatures, back to front
  const items: Item[] = [];
  const add = (z: number, draw: () => void) => items.push({ z, k: items.length, draw });
  for (const p of OFFICE.props) add(p.sortY, () => sprite(ctx, kit, `furniture/${p.kind}`, p.x, p.y));
  const seated = new Map<string, Actor>();
  for (const a of toy.actors.values()) seated.set(`${a.desk.x},${a.desk.y}`, a);
  const glowOf = (at: Point) => {
    const a = seated.get(`${at.x},${at.y}`);
    if (a === undefined || a.bornAt > now) return 'off';
    return a.state === 'working' ? 'work' : a.state === 'waiting' ? 'alert' : 'off';
  };
  const colourOf = (room: string) => toy.rooms.find((r) => r.id === room)?.palette.base ?? '#3cc3b0';
  for (const d of OFFICE.desks) add(d.desk.y + 18, () => desk(ctx, kit, d.desk, glowOf(d.desk), colourOf(d.room)));
  for (const b of toy.builds) {
    const t = now - b.startedAt - BUILD_TILES_MS;
    if (t < 0) continue;
    const rows = [...new Set(b.info.desks.map((d) => d.desk.y))].sort((p, q) => p - q);
    const step = BUILD_DESKS_MS / Math.max(1, rows.length);
    for (const p of b.info.props) if (t >= BUILD_DESKS_MS * 0.5) add(p.sortY, () => sprite(ctx, kit, `furniture/${p.kind}`, p.x, p.y));
    for (const d of b.info.desks) {
      const appear = rows.indexOf(d.desk.y) * step;
      if (t < appear) continue;
      const lift = motion && t - appear < 90 ? -2 : 0;
      add(d.desk.y + 18, () => desk(ctx, kit, { x: d.desk.x, y: d.desk.y + lift }, glowOf(d.desk), b.info.palette.base));
    }
  }
  for (const a of toy.actors.values()) {
    if (a.bornAt > now) continue;
    add(a.y, () => drawActor(ctx, kit, toy, a));
  }
  const l = toy.luady;
  add(l.y, () => {
    const walking = toy.isWalking();
    const step = walking && motion && Math.floor(l.walkT / 140) % 2 === 1;
    const frame: Frame = step ? 'step' : 'idle';
    critter(ctx, kit, OFFICE.luady.colour, 'manager', frame, Math.round(l.x), Math.round(l.y) - (step ? 1 : 0));
  });
  items.sort((p, q) => p.z - q.z || p.k - q.k).forEach((item) => item.draw());

  // 6. the front half of the working rings, then the bubbles on top of everything
  for (const a of toy.actors.values()) {
    if (a.bornAt <= now && a.state === 'working') ring(ctx, kit, 'front', a.colour, a.x, a.y);
  }
  for (const a of toy.actors.values()) {
    if (a.bornAt > now) continue;
    const icon = a.mark?.icon ?? a.bubble;
    if (icon === null) continue;
    const popping = motion && now - a.bubbleAt < 150;
    const hop = motion && a.state === 'waiting' && Math.floor(now / 320) % 2 === 0 ? -1 : 0;
    const look = toy.focus === a.id ? -2 : 0;
    bubble(ctx, kit, icon, a.species, a.x, a.y, (popping ? 2 : 0) + hop + look);
  }
  const mark = toy.luadyMark();
  if (mark !== null) bubble(ctx, kit, mark, 'manager', Math.round(l.x), Math.round(l.y));

  // 7. confetti
  for (const p of toy.particles) {
    ctx.fillStyle = p.colour;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
  }

  // 8. with the lamps off the office is darker, and the screens glow through it
  const dark = 1 - lit / lampOrder.length;
  if (dark > 0.01) {
    ctx.globalAlpha = dark;
    ctx.fillStyle = DARK;
    ctx.fillRect(view.x - 1, view.y - 1, view.w + 2, view.h + 2);
    ctx.globalAlpha = 1;
    for (const d of OFFICE.desks) {
      const glow = glowOf(d.desk);
      if (glow !== 'off') screen(ctx, kit, d.desk, glow, colourOf(d.room));
    }
  }
}

function drawActor(ctx: CanvasRenderingContext2D, kit: Kit, toy: Toy, a: Actor): void {
  const now = toy.now;
  const motion = !toy.reduced;
  const born = now - a.bornAt;
  const appearing = motion && a.bornAt > 0 && born < 120;
  if (a.state === 'working') ring(ctx, kit, 'back', a.colour, a.x, a.y);
  let frame: Frame = 'idle';
  let lift = 0;
  if (a.state === 'asleep') frame = 'blink';
  else if (motion && now < a.blinkUntil) frame = 'blink';
  if (toy.focus === a.id) {
    frame = 'idle';
    lift = -2;
  } else if (motion && a.state === 'working' && Math.sin(now / 95 + a.phase) > 0.55) lift = -1;
  else if (motion && a.state === 'waiting' && Math.floor(now / 320) % 2 === 0) lift = -1;
  if (appearing) lift -= 3;
  critter(ctx, kit, a.colour, a.species, frame, a.x, a.y + lift);
}


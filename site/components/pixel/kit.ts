/**
 * The product's pixel art, as the site draws it: one atlas of small sprites (creatures, desks, furniture, bubbles),
 * the office world and the room insides, all listed in public/pixel/manifest.json (see scripts/export-pixel-art.md).
 * Drawing is always at whole-number scales with smoothing off, so every art pixel stays a crisp square.
 */
import manifestJson from '../../public/pixel/manifest.json';
import { asset } from '../site/base';

export interface Box { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }
export interface Palette { base: string; accent: string }
export interface RoomInfo {
  id: string; name: string; kind: string; rect: Box; doorway: Box; palette: Palette; species: string; side: string; lot: boolean;
}
export interface DeskInfo { room: string; desk: Point; sit: Point }
export interface PropInfo { kind: string; x: number; y: number; sortY: number; room?: string | null }
export interface ActorInfo {
  id: string; room: string; seat: number; x: number; y: number; species: string; colour: string;
  state: string; bubble: string | null; label: string;
}
export interface BuildInfo {
  lot: string; id: string; name: string; rect: Box; palette: Palette; species: string; shell: string;
  desks: { desk: Point; sit: Point }[]; props: PropInfo[]; doorway: Box; side: string;
}
export interface Manifest {
  cell: number;
  species: string[];
  tail: Record<string, number>;
  colours: Record<string, string>;
  world: { file: string } & Box;
  still: { file: string } & Box;
  sprites: { file: string; frames: Record<string, Box> };
  rooms: { file: string; frames: Record<string, Box> };
  office: {
    width: number; height: number; hq: Box; luadySit: Point;
    rooms: Record<string, RoomInfo>;
    props: PropInfo[]; desks: DeskInfo[]; actors: ActorInfo[];
    luady: { x: number; y: number; species: string; colour: string };
    lamps: [number, number][];
    builds: BuildInfo[];
  };
}

export const MANIFEST = manifestJson as unknown as Manifest;
export const CELL = MANIFEST.cell;
export type Frame = 'idle' | 'blink' | 'step';
const FRAME_COL: Record<Frame, number> = { idle: 0, blink: 1, step: 2 };

/** The colour name of a room colour (`#d6336c` is `rose`), for the creature sheet and the monitor screen. */
const NAME_OF = new Map(Object.entries(MANIFEST.colours).map(([name, hex]) => [hex.toLowerCase(), name]));
export function colourName(hex: string): string {
  return NAME_OF.get(hex.toLowerCase()) ?? 'teal';
}

export interface Kit {
  sprites: HTMLImageElement;
  rooms: HTMLImageElement;
  world: HTMLImageElement | null;
  tinted: Map<string, HTMLCanvasElement>;
}

function loadImage(path: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`pixel: could not load ${path}`));
    img.src = asset(`pixel/${path}`);
  });
}

let small: Promise<Kit> | null = null;
let full: Promise<Kit> | null = null;

/** The atlas and room insides (small: about 40 KB), shared by every scene on the page; loaded once. */
export function loadKit(): Promise<Kit> {
  small ??= Promise.all([loadImage(MANIFEST.sprites.file), loadImage(MANIFEST.rooms.file)])
    .then(([sprites, rooms]) => ({ sprites, rooms, world: null, tinted: new Map() }));
  return small;
}

/** The kit with the office world as well (for the office toy). */
export function loadWorldKit(): Promise<Kit> {
  full ??= Promise.all([loadKit(), loadImage(MANIFEST.world.file)]).then(([kit, world]) => ({ ...kit, world }));
  return full;
}

/** Draws atlas sprite `name` with its top-left at art position (x, y). */
export function sprite(ctx: CanvasRenderingContext2D, kit: Kit, name: string, x: number, y: number): void {
  const f = MANIFEST.sprites.frames[name];
  if (f === undefined) return;
  ctx.drawImage(kit.sprites, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), f.w, f.h);
}

/** Draws a creature with its feet at (x, y): the bottom centre of its 24 x 24 cell. */
export function critter(ctx: CanvasRenderingContext2D, kit: Kit, colour: string, species: string, frame: Frame, x: number, y: number): void {
  const sheet = MANIFEST.sprites.frames[`critters-${colourName(colour)}`];
  const row = MANIFEST.species.indexOf(species);
  if (sheet === undefined || row === -1) return;
  ctx.drawImage(kit.sprites, sheet.x + FRAME_COL[frame] * CELL, sheet.y + row * CELL, CELL, CELL,
    Math.round(x - CELL / 2), Math.round(y + 1 - CELL), CELL, CELL);
}

/** Draws a bubble icon over a creature whose feet are at (x, y), where the office page puts it. */
export function bubble(ctx: CanvasRenderingContext2D, kit: Kit, icon: string, species: string, x: number, y: number, lift = 0): void {
  const tail = MANIFEST.tail[species] ?? 0;
  sprite(ctx, kit, `bubbles/${icon}`, x + 3, y - 23 + tail - 14 + lift);
}

/** Draws a desk with its monitor and screen; `glow` is 'work' (in the room's colour), 'off', 'alert' or 'error'. */
export function desk(ctx: CanvasRenderingContext2D, kit: Kit, at: Point, glow: string, colour: string): void {
  sprite(ctx, kit, 'furniture/desk', at.x, at.y);
  sprite(ctx, kit, 'furniture/monitor', at.x + 30, at.y - 9);
  screen(ctx, kit, at, glow, colour);
}

export function screen(ctx: CanvasRenderingContext2D, kit: Kit, at: Point, glow: string, colour: string): void {
  sprite(ctx, kit, glow === 'work' ? `screens/work-${colourName(colour)}` : `screens/${glow}`, at.x + 31, at.y - 8);
}

/** The white working ring, tinted to a colour once and kept. */
function tintedRing(kit: Kit, part: 'back' | 'front', colour: string): HTMLCanvasElement | null {
  const key = `${part}|${colour}`;
  const cached = kit.tinted.get(key);
  if (cached !== undefined) return cached;
  const f = MANIFEST.sprites.frames[`marks/ring-${part}`];
  if (f === undefined) return null;
  const canvas = document.createElement('canvas');
  canvas.width = f.w;
  canvas.height = f.h;
  const c = canvas.getContext('2d');
  if (c === null) return null;
  c.drawImage(kit.sprites, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
  c.globalCompositeOperation = 'multiply';
  c.fillStyle = colour;
  c.fillRect(0, 0, f.w, f.h);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(kit.sprites, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
  kit.tinted.set(key, canvas);
  return canvas;
}

/** The ring under a working creature: the back half lighter, the front half in the room's colour, as the office does. */
export function ring(ctx: CanvasRenderingContext2D, kit: Kit, part: 'back' | 'front', colour: string, x: number, y: number): void {
  const tint = part === 'back' ? lighten(colour, 0.4) : colour;
  const img = tintedRing(kit, part, tint);
  if (img === null) return;
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * 0.7;
  ctx.drawImage(img, Math.round(x - 14), Math.round(y - 4 - 5));
  ctx.globalAlpha = alpha;
}

/** Draws a room's inside (from rooms.png) with its top-left at (x, y); `clip` limits it to part of the room. */
export function roomInside(ctx: CanvasRenderingContext2D, kit: Kit, name: string, x: number, y: number, clip?: Box): void {
  const f = MANIFEST.rooms.frames[name];
  if (f === undefined) return;
  const c = clip ?? { x: 0, y: 0, w: f.w, h: f.h };
  ctx.drawImage(kit.rooms, f.x + c.x, f.y + c.y, c.w, c.h, x + c.x, y + c.y, c.w, c.h);
}

export function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * amount));
  return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Sets a canvas up for crisp pixel art: size in device pixels, smoothing off. Returns its 2D context. */
export function pixelContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (ctx !== null) ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** The whole-number device-pixel scale for art meant to be `cssScale` CSS pixels per art pixel on this screen. */
export function deviceScale(cssScale: number): number {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.max(1, Math.round(cssScale * dpr));
}

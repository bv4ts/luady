import type { PropKind } from '../props.js';
import { paint, type Painter, type Raster } from '../raster.js';
import type { Palette } from '../types.js';
import type { MonitorGlow } from '../visuals.js';
import { drawBoard, drawFuse, drawJira, drawLibrary, drawNotes } from './fixture-art.js';
import { drawCooler, drawMeeting, drawReadingBench } from './hq-art.js';
import { drawClock, drawLinks, drawSchedule, drawTv, drawWins } from './wave2-art.js';

export type FurnitureKind = PropKind | 'desk' | 'monitor' | 'envelope' | 'folder' | 'card';

interface Art { readonly w: number; readonly h: number; readonly draw: (p: Painter) => void }

const art = (w: number, h: number, draw: (p: Painter) => void): Art => Object.freeze({ w, h, draw });

/** [y, tag colour, line width] of the release lines on the versions screen. */
const VERSION_LINES: ReadonlyArray<readonly [number, string, number]> = Object.freeze([
  [4, '#54d38a', 40], [9, '#5aa2ff', 34], [14, '#ffb648', 44],
] as const);

/** The size and pixel art of each furniture kind; the board, library, notes, fuse box and Jira fixtures are drawn in fixture-art.ts. */
const ART: Readonly<Record<FurnitureKind, Art>> = Object.freeze({
  desk: art(48, 18, (p) => {
    p.rect(0, 0, 48, 10, '#c9b79a'); p.rect(0, 0, 48, 1, '#e6d9c1'); p.rect(7, 4, 15, 3, '#3a4152'); p.rect(8, 5, 13, 1, '#8894ad');
    p.rect(0, 10, 48, 8, '#8c7558'); p.rect(0, 10, 48, 1, '#6b573f'); p.rect(3, 12, 12, 4, '#7a654b'); p.rect(8, 13, 2, 1, '#dccbab');
    p.rect(0, 17, 48, 1, '#4a3c2c');
  }),
  monitor: art(16, 14, (p) => {
    p.rect(0, 0, 16, 11, '#161b27'); p.rect(1, 1, 14, 9, '#0b101c'); p.rect(6, 11, 4, 2, '#2c3446'); p.rect(4, 13, 8, 1, '#2c3446');
  }),
  rack: art(30, 46, (p) => {
    p.rect(0, 0, 30, 46, '#0e121b'); p.rect(1, 1, 28, 44, '#222a3b'); p.rect(1, 1, 28, 2, '#3a4664');
    for (let i = 0; i < 6; i += 1) {
      p.rect(3, 5 + i * 7, 24, 5, '#141a28'); p.rect(4, 6 + i * 7, 11, 1, '#303a52'); p.rect(4, 8 + i * 7, 7, 1, '#303a52');
    }
  }),
  plant: art(14, 20, (p) => {
    p.rect(6, 4, 2, 9, '#1e7a49'); p.rect(2, 5, 4, 3, '#2fa866'); p.rect(8, 2, 4, 3, '#2fa866'); p.rect(1, 9, 4, 2, '#39bd75');
    p.rect(9, 7, 4, 3, '#39bd75'); p.rect(5, 0, 3, 3, '#2fa866'); p.rect(2, 12, 10, 2, '#d17f4c'); p.rect(3, 14, 8, 5, '#b8683a');
    p.rect(4, 19, 6, 1, '#7d4526');
  }),
  luadydesk: art(64, 34, (p) => {
    p.rect(0, 0, 64, 19, '#d6c6a8'); p.rect(0, 0, 64, 1, '#efe3cd'); p.rect(0, 19, 64, 15, '#917a5c'); p.rect(0, 19, 64, 1, '#6b573f');
    p.rect(0, 33, 64, 1, '#4a3c2c'); p.rect(6, 23, 22, 7, '#7d6850'); p.rect(36, 23, 22, 7, '#7d6850'); p.rect(46, 5, 9, 12, '#10141d');
    p.rect(47, 6, 7, 10, '#25d366'); p.rect(49, 8, 3, 3, '#eafff1'); p.rect(8, 7, 12, 8, '#f6f1e6'); p.rect(10, 9, 8, 1, '#9aa3b5');
    p.rect(10, 11, 6, 1, '#9aa3b5'); p.rect(24, 9, 8, 5, '#ffd84d'); p.rect(27, 7, 2, 2, '#b88600');
  }),
  workbench: art(80, 22, (p) => {
    p.rect(0, 0, 80, 9, '#a8875c'); p.rect(0, 0, 80, 1, '#c9a877'); p.rect(0, 9, 80, 13, '#6f5637'); p.rect(4, 11, 4, 11, '#4a3823');
    p.rect(72, 11, 4, 11, '#4a3823'); p.rect(10, 2, 10, 3, '#8894ad'); p.rect(18, 1, 4, 5, '#5b6577'); p.rect(34, 2, 6, 6, '#3cc3b0');
    p.rect(36, 4, 2, 2, '#0e121b'); p.rect(52, 3, 14, 2, '#e9eef7'); p.rect(52, 6, 9, 1, '#9aa3b5');
  }),
  robot: art(22, 28, (p) => {
    p.rect(10, 0, 2, 4, '#5b6577'); p.rect(3, 4, 16, 12, '#10141d'); p.rect(4, 5, 14, 10, '#aeb9cc'); p.rect(6, 8, 3, 3, '#10141d');
    p.rect(13, 8, 3, 3, '#10141d'); p.rect(2, 16, 18, 10, '#10141d'); p.rect(3, 17, 16, 8, '#7f8ba3'); p.rect(8, 19, 6, 4, '#10141d');
    p.rect(4, 26, 5, 2, '#10141d'); p.rect(13, 26, 5, 2, '#10141d');
  }),
  versions: art(80, 26, (p) => {
    p.rect(0, 0, 80, 22, '#10141d'); p.rect(1, 1, 78, 20, '#2a3347'); p.rect(6, 22, 4, 4, '#10141d'); p.rect(70, 22, 4, 4, '#10141d');
    p.rect(1, 1, 78, 1, '#3a4664');
    VERSION_LINES.forEach(([y, tag, w], i) => {
      p.rect(5, y, 6, 2, tag); p.rect(14, y, w, 1, i === 0 ? '#c9d3e6' : '#7d8aa3'); p.rect(14, y + 2, Math.round(w * 0.6), 1, '#4b5874');
    });
    p.rect(64, 4, 10, 6, '#1d2433'); p.rect(66, 6, 2, 2, '#54d38a'); p.rect(70, 6, 2, 2, '#54d38a');
  }),
  board: art(144, 30, drawBoard),
  library: art(132, 32, drawLibrary),
  notes: art(60, 34, drawNotes),
  fuse: art(20, 26, drawFuse),
  jira: art(62, 18, drawJira),
  clock: art(12, 12, drawClock),
  schedule: art(26, 24, drawSchedule),
  tv: art(56, 28, drawTv),
  wins: art(80, 26, drawWins),
  links: art(24, 18, drawLinks),
  meeting: art(96, 64, drawMeeting),
  cooler: art(14, 28, drawCooler),
  readbench: art(88, 16, drawReadingBench),
  sofa: art(60, 20, (p) => {
    p.rect(0, 0, 60, 20, '#10141d'); p.rect(1, 1, 58, 8, '#4d5a8a'); p.rect(1, 9, 58, 9, '#5f6ea6'); p.rect(1, 9, 8, 10, '#4d5a8a');
    p.rect(51, 9, 8, 10, '#4d5a8a'); p.rect(29, 10, 1, 8, '#4d5a8a');
  }),
  coffee: art(14, 22, (p) => {
    p.rect(0, 0, 14, 22, '#10141d'); p.rect(1, 1, 12, 20, '#8a93a5'); p.rect(3, 3, 8, 5, '#10141d'); p.rect(4, 4, 2, 2, '#ff6b5e');
    p.rect(4, 12, 6, 6, '#10141d'); p.rect(5, 14, 4, 4, '#f6f1e6');
  }),
  table: art(64, 34, (p) => {
    p.rect(2, 0, 60, 22, '#10141d'); p.rect(3, 1, 58, 20, '#b9a27c'); p.rect(3, 1, 58, 1, '#d8c5a2'); p.rect(6, 22, 5, 12, '#5d4a31');
    p.rect(53, 22, 5, 12, '#5d4a31'); p.rect(22, 7, 9, 6, '#f6f1e6'); p.rect(36, 9, 7, 5, '#ffd84d');
  }),
  envelope: art(11, 8, (p) => {
    p.rect(0, 0, 11, 8, '#10141d'); p.rect(1, 1, 9, 6, '#ffd84d');
    [[1, 1], [2, 2], [3, 3], [4, 4], [5, 4], [6, 4], [7, 3], [8, 2], [9, 1]].forEach(([x, y]) => p.put(x ?? 0, y ?? 0, '#b88600'));
  }),
  folder: art(10, 8, (p) => {
    p.rect(0, 0, 5, 2, '#10141d'); p.rect(0, 1, 10, 7, '#10141d'); p.rect(1, 1, 3, 1, '#ffc93d'); p.rect(1, 2, 8, 5, '#ffc93d');
    p.rect(1, 2, 8, 1, '#ffe08a');
  }),
  card: art(8, 9, (p) => {
    p.rect(0, 0, 8, 9, '#10141d'); p.rect(1, 1, 6, 7, '#f6f1e6'); p.rect(1, 1, 6, 2, '#d6336c'); p.rect(2, 4, 4, 1, '#9aa3b5');
    p.rect(2, 6, 3, 1, '#9aa3b5');
  }),
});

export const FURNITURE_KINDS: readonly FurnitureKind[] = Object.freeze(Object.keys(ART) as FurnitureKind[]);

export const FURNITURE_SIZE: Readonly<Record<FurnitureKind, { readonly w: number; readonly h: number }>> = Object.freeze(
  Object.fromEntries(FURNITURE_KINDS.map((k) => [k, Object.freeze({ w: ART[k].w, h: ART[k].h })])) as Record<FurnitureKind, { w: number; h: number }>,
);

/** One piece of furniture as a raster, transparent where the art leaves gaps. */
export function furnitureRaster(kind: FurnitureKind): Raster {
  const a = ART[kind];
  return paint(a.w, a.h, a.draw);
}

const SCREEN_W = 14;
const SCREEN_H = 9;

const SCREENS: Readonly<Record<MonitorGlow, (p: Painter, team: string) => void>> = Object.freeze({
  off: (p) => p.rect(0, 0, SCREEN_W, SCREEN_H, '#0b101c'),
  work: (p, team) => {
    p.rect(0, 0, SCREEN_W, SCREEN_H, '#0b101c');
    p.rect(2, 2, 9, 1, team); p.rect(2, 4, 6, 1, team); p.rect(2, 6, 8, 1, team);
  },
  alert: (p) => {
    p.rect(0, 0, SCREEN_W, SCREEN_H, '#e23a2e');
    p.rect(6, 1, 2, 5, '#ffffff'); p.rect(6, 7, 2, 1, '#ffffff');
  },
  error: (p) => {
    p.rect(0, 0, SCREEN_W, SCREEN_H, '#3a0d0d');
    for (let i = 0; i < 7; i += 1) {
      p.put(4 + i, 1 + i, '#e23a2e');
      p.put(10 - i, 1 + i, '#e23a2e');
    }
  },
});

/** What a desk monitor shows, in the sitter's room palette: lay it over the 'monitor' sprite at (1, 1). */
export function monitorScreen(glow: MonitorGlow, palette: Palette): Raster {
  const draw = Object.hasOwn(SCREENS, glow) ? SCREENS[glow] : SCREENS.off;
  const colour = palette.base;
  return paint(SCREEN_W, SCREEN_H, (p) => draw(p, colour));
}

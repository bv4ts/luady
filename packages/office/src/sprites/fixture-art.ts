import type { Painter } from '../raster.js';

/** The furniture of the board, library, notes, fuse box and Jira fixtures. Each draws at exactly its FIXTURE_SIZE. */

const INK = '#10141d';
const SPINES = ['#d6336c', '#ffd84d', '#3cc3b0', '#f76707', '#e9eef7', '#7c5cff', '#12b886', '#5aa2ff', '#c9a877', '#e23a2e'];
const spine = (i: number): string => SPINES[i % SPINES.length] ?? '#e9eef7';

/** A small deterministic number for picking pattern variations (no random calls at draw time). */
const vary = (i: number, n: number): number => ((i * 7919 + 13) % 104729) % n;

// ── Board: a wooden frame round a cork surface with four lanes of coloured notes ─────────────────────────────────

const NOTE_COLOURS = ['#ffd84d', '#f6f1e6', '#9ad7f0', '#f7a8c4', '#c3fae8', '#ffc58a'];
/** Notes per lane: to do, running, needs you, done. */
const LANE_NOTES = [4, 3, 2, 3] as const;

export function drawBoard(p: Painter): void {
  p.rect(0, 0, 144, 30, '#2a1d12');
  p.rect(1, 1, 142, 28, '#7a5434');
  p.rect(1, 1, 142, 1, '#a07448');
  p.rect(1, 28, 142, 1, '#5a3d24');
  p.rect(4, 4, 136, 22, '#b4875a');
  p.rect(4, 4, 136, 1, '#8f6a45');
  for (let i = 0; i < 60; i += 1) p.put(5 + vary(i, 134), 5 + vary(i + 31, 20), '#a77b50');
  LANE_NOTES.forEach((count, lane) => {
    const x0 = 6 + lane * 34;
    p.rect(x0 + 6, 6, 20, 3, '#e9dcc0');
    p.rect(x0 + 6, 8, 20, 1, '#c8b48e');
    if (lane > 0) p.rect(x0 - 3, 6, 1, 19, '#9c7449');
    Array.from({ length: count }, (_, n) => n).forEach((n) => {
      const nx = x0 + 1 + (n % 3) * 10 + (n >= 3 ? 5 : 0);
      const ny = 11 + Math.floor(n / 3) * 7 + (vary(lane * 5 + n, 2));
      const colour = NOTE_COLOURS[(lane * 3 + n) % NOTE_COLOURS.length] ?? '#f6f1e6';
      p.rect(nx + 1, ny + 1, 8, 6, '#6f4f30');
      p.rect(nx, ny, 8, 6, colour);
      p.rect(nx + 1, ny + 2, 5, 1, '#7d8aa3');
      p.rect(nx + 1, ny + 4, 3, 1, '#9aa3b5');
      p.put(nx + 4, ny, '#e23a2e');
    });
  });
}

// ── Library: a wall of book shelves in three bays ─────────────────────────────────────────────────────────────

const BAYS = [[3, 42], [46, 42], [89, 40]] as const;
const SHELVES = [3, 18] as const;

const books = (p: Painter, x0: number, w: number, y0: number, seed: number): void => {
  let x = x0;
  let i = seed;
  while (x < x0 + w - 2) {
    const bw = 2 + vary(i, 3);
    const gap = vary(i + 3, 9) === 0;
    if (!gap) {
      const bh = 9 + vary(i + 1, 4);
      const top = y0 + 12 - bh;
      p.rect(x, top, bw, bh, spine(i));
      p.rect(x, top + 2, bw, 1, '#2a1d12');
    }
    x += bw + (gap ? 3 : 0);
    i += 1;
  }
};

export function drawLibrary(p: Painter): void {
  p.rect(0, 0, 132, 32, '#1a130d');
  p.rect(1, 1, 130, 30, '#4a3626');
  p.rect(1, 1, 130, 1, '#6b4f36');
  BAYS.forEach(([bx, bw], b) => {
    SHELVES.forEach((sy, s) => {
      p.rect(bx, sy, bw, 12, '#21180f');
      books(p, bx + 1, bw - 1, sy, b * 17 + s * 5);
      p.rect(bx, sy + 12, bw, 2, '#5e4430');
    });
  });
  p.rect(64, 6, 5, 5, '#3cc3b0');
  p.rect(65, 5, 3, 1, '#3cc3b0');
  p.rect(66, 11, 1, 3, '#7a5434');
  p.rect(110, 21, 7, 4, '#f6f1e6');
  p.rect(110, 25, 7, 1, '#9aa3b5');
}

// ── Notes desk: stacked notebooks and the note taker, a small teal helper ─────────────────────────────────────

export function drawNotes(p: Painter): void {
  p.rect(0, 10, 46, 12, '#10141d');
  p.rect(1, 11, 44, 10, '#c9b79a');
  p.rect(1, 11, 44, 1, '#e6d9c1');
  p.rect(0, 21, 46, 9, '#8c7558');
  p.rect(0, 21, 46, 1, '#6b573f');
  p.rect(3, 23, 12, 5, '#7a654b');
  p.rect(8, 25, 2, 1, '#dccbab');
  p.rect(2, 30, 4, 4, '#4a3c2c');
  p.rect(40, 30, 4, 4, '#4a3c2c');
  [['#d6336c', 0], ['#3cc3b0', 1], ['#ffd84d', 0], ['#7c5cff', 2]].forEach(([colour, shift], i) => {
    const y = 15 - i * 3;
    p.rect(4 + Number(shift), y, 13, 3, INK);
    p.rect(5 + Number(shift), y, 11, 2, String(colour));
    p.rect(5 + Number(shift), y + 2, 11, 1, '#f6f1e6');
  });
  p.rect(22, 13, 18, 7, '#f6f1e6');
  p.rect(30, 13, 1, 7, '#b9c3d6');
  [[24, 15, 5], [24, 17, 4], [32, 15, 6], [32, 17, 4]].forEach(([x, y, w]) => p.rect(x ?? 0, y ?? 0, w ?? 0, 1, '#7d8aa3'));
  p.rect(38, 11, 1, 6, '#c77a00');
  drawNoteTaker(p, 47, 14);
}

/** 12 × 20: the teal note taker holding a pencil, standing beside the desk. */
const drawNoteTaker = (p: Painter, x: number, y: number): void => {
  p.rect(x + 2, y, 8, 1, INK);
  p.rect(x + 1, y + 1, 10, 11, INK);
  p.rect(x + 2, y + 1, 8, 10, '#3cc3b0');
  p.rect(x + 2, y + 1, 8, 2, '#8ee5d8');
  p.rect(x + 3, y + 4, 2, 2, '#ffffff');
  p.rect(x + 7, y + 4, 2, 2, '#ffffff');
  p.put(x + 4, y + 5, INK);
  p.put(x + 8, y + 5, INK);
  p.rect(x + 2, y + 12, 8, 6, INK);
  p.rect(x + 3, y + 12, 6, 5, '#2a9d8f');
  p.rect(x + 4, y + 13, 4, 3, '#f6f1e6');
  p.rect(x + 2, y + 18, 3, 2, INK);
  p.rect(x + 7, y + 18, 3, 2, INK);
  p.rect(x, y + 11, 1, 4, '#ffd84d');
  p.put(x, y + 15, INK);
};

// ── Fuse box: a metal box with two small meters ───────────────────────────────────────────────────────────────

export function drawFuse(p: Painter): void {
  p.rect(9, 0, 2, 3, '#3a4152');
  p.rect(0, 3, 20, 23, INK);
  p.rect(1, 4, 18, 21, '#5b6577');
  p.rect(1, 4, 18, 1, '#8894ad');
  p.rect(2, 6, 16, 18, '#7f8ba3');
  [[3, '#54d38a', 3], [11, '#ffb648', 1]].forEach(([mx, colour, needle]) => {
    const x = Number(mx);
    p.rect(x, 7, 6, 6, INK);
    p.rect(x + 1, 8, 4, 4, '#e9eef7');
    p.rect(x + Number(needle), 9, 1, 3, String(colour));
    p.rect(x + 1, 11, 4, 1, String(colour));
  });
  p.rect(8, 16, 4, 1, '#ffd84d');
  p.rect(9, 15, 2, 1, '#ffd84d');
  p.rect(7, 17, 3, 1, '#ffd84d');
  p.rect(10, 17, 2, 1, '#ffd84d');
  p.rect(3, 20, 14, 2, '#5b6577');
  p.rect(5, 20, 2, 2, '#e23a2e');
  p.rect(13, 20, 2, 2, '#54d38a');
}

// ── Jira board: a blue board with three columns of tickets ────────────────────────────────────────────────────

export function drawJira(p: Painter): void {
  p.rect(0, 0, 62, 18, INK);
  p.rect(1, 1, 60, 16, '#deebff');
  p.rect(1, 1, 60, 3, '#0052cc');
  p.rect(3, 2, 3, 1, '#ffffff');
  p.rect(4, 1, 1, 3, '#4c9aff');
  [0, 1, 2].forEach((c) => {
    const x = 3 + c * 20;
    p.rect(x, 5, 17, 11, '#c1d6f7');
    const cards = 3 - c;
    Array.from({ length: cards }, (_, n) => n).forEach((n) => {
      p.rect(x + 1, 6 + n * 3, 15, 2, n === 0 ? '#2684ff' : '#ffffff');
      p.rect(x + 2, 6 + n * 3, 1, 2, c === 2 ? '#36b37e' : '#0052cc');
    });
  });
}

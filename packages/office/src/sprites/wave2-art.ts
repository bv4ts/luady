import type { Painter } from '../raster.js';

/** The furniture of the clock, schedule, TV, wins board and links shelf. Each draws at exactly its FIXTURE_SIZE. */

const INK = '#10141d';
const OFFICE = ['#d6336c', '#f76707', '#12b886', '#7c5cff', '#3cc3b0'] as const;
const office = (i: number): string => OFFICE[i % OFFICE.length] ?? '#3cc3b0';

/** 12 × 12: a round wall clock, its hands at ten past ten. */
export function drawClock(p: Painter): void {
  p.rect(3, 0, 6, 1, INK); p.rect(1, 1, 10, 1, INK); p.rect(0, 3, 1, 6, INK); p.rect(11, 3, 1, 6, INK);
  p.rect(1, 10, 10, 1, INK); p.rect(3, 11, 6, 1, INK); p.put(1, 2, INK); p.put(10, 2, INK); p.put(1, 9, INK); p.put(10, 9, INK);
  p.rect(2, 2, 8, 8, '#f6f1e6'); p.rect(1, 3, 10, 6, '#f6f1e6'); p.rect(3, 1, 6, 1, '#d6c6a8');
  [[6, 2], [9, 6], [6, 9], [2, 6]].forEach(([x, y]) => p.put(x ?? 0, y ?? 0, '#7d8aa3'));
  p.rect(6, 4, 1, 2, INK); p.put(5, 4, INK); p.rect(7, 5, 2, 1, INK); p.put(6, 6, '#e23a2e');
}

/** 26 × 24: a wall calendar with a red header, two rings and a month of days, three of them marked. */
export function drawSchedule(p: Painter): void {
  p.rect(0, 2, 26, 22, INK);
  p.rect(1, 3, 24, 20, '#f6f1e6');
  p.rect(1, 3, 24, 5, '#e23a2e');
  p.rect(5, 0, 2, 5, '#5b6577'); p.rect(19, 0, 2, 5, '#5b6577');
  p.rect(9, 5, 8, 1, '#ffd0c8');
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      const x = 3 + col * 4;
      const y = 10 + row * 3;
      const marked = (row === 1 && col === 2) || (row === 2 && col === 4) || (row === 3 && col === 1);
      p.rect(x, y, 3, 2, marked ? office(row + col) : '#c9d3e6');
    }
  }
}

/** 56 × 28: the fleet wall, a wall TV with tiny bar charts per server and a status row. */
export function drawTv(p: Painter): void {
  p.rect(0, 0, 56, 26, INK);
  p.rect(2, 2, 52, 22, '#0f1e33');
  p.rect(2, 2, 52, 1, '#1d3150');
  [0, 1, 2, 3].forEach((s) => {
    const x0 = 4 + s * 13;
    const bars = [3, 5, 4, 7, 6, 8].map((h, i) => Math.max(2, (h + s * 2 + i) % 9));
    bars.forEach((h, i) => p.rect(x0 + i * 2, 17 - h, 1, h, s === 3 && i > 3 ? '#ffb648' : '#54d38a'));
    p.rect(x0, 18, 11, 1, office(s));
    p.rect(x0, 20, 3, 2, s === 2 ? '#e23a2e' : '#54d38a');
    p.rect(x0 + 4, 20, 7, 1, '#7d8aa3');
  });
  p.rect(24, 26, 8, 2, '#2c3446');
}

/** 80 × 26: the wins wall, a free-standing board of small photos in the office colours. */
export function drawWins(p: Painter): void {
  p.rect(0, 0, 80, 22, INK);
  p.rect(1, 1, 78, 20, '#3a2f4a');
  p.rect(1, 1, 78, 1, '#5a4a6e');
  for (let i = 0; i < 8; i += 1) {
    const x = 4 + i * 9;
    const y = 4 + (i % 3 === 0 ? 0 : 2);
    p.rect(x, y, 8, 9, '#f6f1e6');
    p.rect(x + 1, y + 1, 6, 5, office(i));
    p.rect(x + 2, y + 3, 2, 2, '#ffd84d');
    p.rect(x + 1, y + 7, 5, 1, '#9aa3b5');
    p.put(x + 3, y, '#e23a2e');
  }
  p.rect(4, 17, 30, 1, '#c9d3e6');
  p.rect(40, 17, 20, 1, '#9aa3b5');
  p.rect(6, 22, 4, 4, INK);
  p.rect(70, 22, 4, 4, INK);
}

/** 24 × 18: a small cork pin board with three link cards and their pins. */
export function drawLinks(p: Painter): void {
  p.rect(0, 0, 24, 18, '#2a1d12');
  p.rect(1, 1, 22, 16, '#7a5434');
  p.rect(2, 2, 20, 14, '#b4875a');
  [[3, 4, 0], [9, 3, 2], [15, 5, 4]].forEach(([x, y, c]) => {
    const cx = x ?? 0;
    const cy = y ?? 0;
    p.rect(cx, cy, 6, 8, '#f6f1e6');
    p.rect(cx, cy, 6, 2, office(c ?? 0));
    p.rect(cx + 1, cy + 4, 4, 1, '#2f6fe0');
    p.rect(cx + 1, cy + 6, 3, 1, '#9aa3b5');
    p.put(cx + 3, cy - 1, '#e23a2e');
  });
}

import type { Painter } from '../raster.js';

/** HQ's manager-office furniture (no fixtures: nothing here opens anything). */

const INK = '#10141d';

/** A chair seen from the front (`back` true: from behind, its back towards us). */
const chair = (p: Painter, x: number, y: number, back: boolean): void => {
  p.rect(x, y, 12, 12, INK);
  if (back) {
    p.rect(x + 1, y + 1, 10, 8, '#3a4664');
    p.rect(x + 1, y + 1, 10, 1, '#4d5a8a');
    p.rect(x + 1, y + 9, 10, 2, '#2c3446');
  } else {
    p.rect(x + 1, y + 1, 10, 4, '#2c3446');
    p.rect(x + 1, y + 5, 10, 6, '#3a4664');
    p.rect(x + 1, y + 5, 10, 1, '#4d5a8a');
  }
};

/** 96 × 64: a meeting table with six chairs round it, papers, a laptop and two mugs. */
export function drawMeeting(p: Painter): void {
  [14, 42, 70].forEach((x) => chair(p, x, 2, false));
  p.rect(9, 46, 80, 4, '#0d1018');
  p.rect(8, 12, 80, 34, INK);
  p.rect(9, 13, 78, 24, '#b9a27c');
  p.rect(9, 13, 78, 1, '#d8c5a2');
  p.rect(9, 37, 78, 8, '#8c7558');
  p.rect(9, 37, 78, 1, '#6b573f');
  p.rect(14, 45, 4, 6, '#5d4a31');
  p.rect(78, 45, 4, 6, '#5d4a31');
  p.rect(18, 18, 12, 9, '#f6f1e6');
  p.rect(20, 20, 8, 1, '#9aa3b5');
  p.rect(20, 22, 6, 1, '#9aa3b5');
  p.rect(42, 17, 16, 11, '#1d2433');
  p.rect(43, 18, 14, 8, '#2f6fe0');
  p.rect(44, 19, 8, 1, '#9ad7f0');
  p.rect(42, 28, 16, 2, '#5b6577');
  p.rect(66, 20, 12, 8, '#f6f1e6');
  p.rect(68, 22, 7, 1, '#9aa3b5');
  p.rect(34, 27, 4, 4, '#e9eef7');
  p.put(35, 28, '#7a5434');
  p.rect(62, 30, 4, 4, '#ffd84d');
  chair(p, 0, 22, false);
  chair(p, 84, 22, false);
  [14, 42, 70].forEach((x) => chair(p, x, 50, true));
}

/** 14 × 28: a water cooler with its blue bottle. */
export function drawCooler(p: Painter): void {
  p.rect(2, 0, 10, 11, INK);
  p.rect(3, 1, 8, 9, '#5aa2ff');
  p.rect(4, 2, 2, 6, '#9ad7f0');
  p.rect(5, 0, 4, 1, '#2f6fe0');
  p.rect(0, 10, 14, 18, INK);
  p.rect(1, 11, 12, 16, '#e9eef7');
  p.rect(1, 11, 12, 1, '#ffffff');
  p.rect(3, 14, 2, 2, '#e23a2e');
  p.rect(9, 14, 2, 2, '#2f6fe0');
  p.rect(3, 18, 8, 3, '#9aa3b5');
  p.rect(1, 24, 12, 3, '#b9c3d6');
}

/** 88 × 16: a low reading bench with a long cushion and two books left on it. */
export function drawReadingBench(p: Painter): void {
  p.rect(1, 14, 86, 2, '#0d1018');
  p.rect(0, 2, 88, 10, INK);
  p.rect(1, 3, 86, 4, '#5f6ea6');
  p.rect(1, 3, 86, 1, '#7d8ac0');
  p.rect(1, 7, 86, 4, '#6b5440');
  p.rect(1, 7, 86, 1, '#86694c');
  p.rect(3, 11, 3, 4, INK);
  p.rect(82, 11, 3, 4, INK);
  p.rect(43, 11, 2, 4, INK);
  p.rect(14, 0, 12, 4, INK);
  p.rect(15, 0, 10, 3, '#d6336c');
  p.rect(60, 1, 10, 3, INK);
  p.rect(61, 1, 8, 2, '#ffd84d');
}

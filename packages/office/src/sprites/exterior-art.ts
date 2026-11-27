import type { Painter } from '../raster.js';
import { hash2 } from './ground.js';

/** The pieces of the garden around the building, drawn at dusk. Every helper draws around a given point. */

export const STONE = Object.freeze({
  a: '#272c37', b: '#2b313c', joint: '#1e222a', kerb: '#363c49', kerbDark: '#161a21', shadow: '#15181f',
  path: '#30353f', path2: '#333944', pathEdge: '#232831',
});

const LEAF = Object.freeze({ out: '#0c1813', deep: '#14291f', mid: '#1b3629', lit: '#23443a', top: '#2c5246' });
const TRUNK = '#3a2e28';
const GROUND_SHADOW = '#0f1613';
const INK = '#10141d';

/** A filled disc of radius r round (cx, cy), row by row. */
export function disc(p: Painter, cx: number, cy: number, r: number, colour: string): void {
  for (let dy = -r; dy <= r; dy += 1) {
    const half = Math.floor(Math.sqrt(r * r - dy * dy));
    p.rect(cx - half, cy + dy, half * 2 + 1, 1, colour);
  }
}

/** A filled ellipse with half-axes rx, ry round (cx, cy). */
export function ellipse(p: Painter, cx: number, cy: number, rx: number, ry: number, colour: string): void {
  for (let dy = -ry; dy <= ry; dy += 1) {
    const half = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry))));
    p.rect(cx - half, cy + dy, half * 2 + 1, 1, colour);
  }
}

/** A tree whose trunk stands at (x, y): a ground shadow, the trunk, and a round crown lit from the top left. */
export function tree(p: Painter, x: number, y: number, r: number): void {
  ellipse(p, x + 3, y, r, Math.max(3, Math.round(r / 3)), GROUND_SHADOW);
  p.rect(x - 2, y - 8, 4, 9, TRUNK);
  p.rect(x - 2, y - 8, 1, 9, '#2a211d');
  const cy = y - 8 - r + 3;
  disc(p, x, cy, r + 1, LEAF.out);
  disc(p, x, cy, r, LEAF.deep);
  disc(p, x - 1, cy - 1, r - 2, LEAF.mid);
  disc(p, x - Math.round(r / 3), cy - Math.round(r / 3), Math.max(2, Math.round(r / 2)), LEAF.lit);
  for (let i = 0; i < r; i += 1) {
    const dx = (hash2(x + i, y, 7) % (r * 2)) - r;
    const dy = (hash2(x, y + i, 7) % (r * 2)) - r;
    if (dx * dx + dy * dy < (r - 2) * (r - 2)) p.put(x + dx, cy + dy, dx + dy < 0 ? LEAF.top : LEAF.deep);
  }
}

/** A round bush on the ground at (x, y), with a few flowers when `flowers` is a colour. */
export function bush(p: Painter, x: number, y: number, r: number, flowers: string | null): void {
  ellipse(p, x + 2, y + 1, r, Math.max(2, Math.round(r / 2)), GROUND_SHADOW);
  disc(p, x, y - r + 2, r, LEAF.out);
  disc(p, x, y - r + 2, r - 1, LEAF.mid);
  disc(p, x - 1, y - r + 1, Math.max(1, r - 3), LEAF.lit);
  if (flowers === null) return;
  [[-2, -r + 1], [2, -r + 3], [0, -r - 1], [-3, -r + 4]].forEach(([dx, dy]) => p.put(x + (dx ?? 0), y + (dy ?? 0), flowers));
}

/** A lamp post whose foot is at (x, y), with its warm light (the pool on the ground is lamp-light.ts). */
export function lamp(p: Painter, x: number, y: number): void {
  p.rect(x - 2, y - 1, 5, 2, INK);
  p.rect(x, y - 18, 1, 18, '#2c3446');
  p.rect(x - 1, y - 21, 3, 3, INK);
  p.rect(x - 2, y - 23, 5, 2, '#1d2433');
  p.rect(x - 1, y - 20, 3, 1, '#ffd98a');
  p.put(x, y - 21, '#fff2c8');
}

/** A flower bed w × h with its top-left at (x, y): a stone edge, dark soil and rows of muted flowers. */
export function flowerBed(p: Painter, x: number, y: number, w: number, h: number, seed: number): void {
  const colours = ['#b97a92', '#c9b46a', '#8a7ac8', '#d9d4c4', '#c98a6a'];
  p.rect(x, y, w, h, STONE.kerb);
  p.rect(x + 1, y + 1, w - 2, h - 2, '#241d19');
  for (let fy = y + 2; fy < y + h - 2; fy += 3) {
    for (let fx = x + 2 + ((fy - y) % 2); fx < x + w - 2; fx += 3) {
      const h2 = hash2(fx, fy, seed);
      p.put(fx, fy, LEAF.mid);
      if (h2 % 3 !== 0) p.put(fx, fy - 1, colours[h2 % colours.length] ?? colours[0] ?? '#b97a92');
    }
  }
}

/** A wooden bench seen from the front, its feet on y. */
export function bench(p: Painter, x: number, y: number): void {
  p.rect(x + 1, y - 1, 28, 2, GROUND_SHADOW);
  p.rect(x, y - 12, 28, 4, '#5a4632');
  p.rect(x, y - 12, 28, 1, '#7a6046');
  p.rect(x, y - 7, 28, 3, '#6b5440');
  p.rect(x, y - 7, 28, 1, '#86694c');
  p.rect(x + 2, y - 4, 2, 4, INK);
  p.rect(x + 24, y - 4, 2, 4, INK);
}

/** A bike rack with two parked bikes, its feet on y. */
export function bikeRack(p: Painter, x: number, y: number): void {
  p.rect(x, y - 1, 34, 2, GROUND_SHADOW);
  [0, 8, 16, 24].forEach((dx) => {
    p.rect(x + dx + 2, y - 9, 1, 9, '#7f8ba3');
    p.rect(x + dx + 6, y - 9, 1, 9, '#7f8ba3');
    p.rect(x + dx + 2, y - 10, 5, 1, '#9aa7bd');
  });
  [[4, '#d6336c'], [20, '#3cc3b0']].forEach(([dx, colour]) => {
    const bx = x + Number(dx);
    p.rect(bx, y - 7, 2, 7, INK);
    p.rect(bx + 6, y - 7, 2, 7, INK);
    p.rect(bx + 1, y - 6, 6, 1, String(colour));
    p.rect(bx + 3, y - 9, 1, 3, String(colour));
    p.rect(bx + 2, y - 10, 3, 1, INK);
  });
}

/** A small pond centred at (cx, cy): a ring of stones, dark water with a lighter ripple, two lily pads. */
export function pond(p: Painter, cx: number, cy: number, rx: number, ry: number): void {
  ellipse(p, cx, cy, rx + 3, ry + 3, STONE.kerb);
  ellipse(p, cx, cy + 1, rx + 1, ry + 1, STONE.kerbDark);
  ellipse(p, cx, cy, rx, ry, '#142a35');
  ellipse(p, cx - 2, cy - 1, rx - 4, ry - 3, '#183442');
  p.rect(cx - Math.round(rx / 2), cy - Math.round(ry / 3), Math.round(rx / 3), 1, '#2f5a6e');
  p.rect(cx + 4, cy + Math.round(ry / 3), Math.round(rx / 4), 1, '#285064');
  [[-Math.round(rx / 3), 2], [Math.round(rx / 2), -3]].forEach(([dx, dy]) => {
    ellipse(p, cx + (dx ?? 0), cy + (dy ?? 0), 4, 2, '#24503a');
    p.put(cx + (dx ?? 0) + 1, cy + (dy ?? 0) - 1, '#c98aa4');
  });
}

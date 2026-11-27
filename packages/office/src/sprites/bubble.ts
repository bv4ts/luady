import { paint, type Raster } from '../raster.js';
import type { BubbleIcon } from '../visuals.js';
import { ICONS } from './icons.js';

export const BUBBLE_SIZE = Object.freeze({ w: 13, h: 15 });

const OUTLINE = '#10141d';
const ALARM = '#e23a2e';
const PAPER = '#ffffff';

/** Icons that need the owner sit on a red bubble and are drawn white. */
const isAlarm = (name: BubbleIcon): boolean => name === 'bang' || name === 'key';

/** A speech bubble with a status icon. Unknown names draw the thinking dots. */
export function bubbleRaster(name: BubbleIcon): Raster {
  const art = Object.hasOwn(ICONS, name) ? ICONS[name] : ICONS.dots;
  const alarm = isAlarm(name);
  const ink = alarm ? PAPER : art.color;
  return paint(BUBBLE_SIZE.w, BUBBLE_SIZE.h, (p) => {
    p.rect(1, 0, 11, 13, OUTLINE);
    p.rect(0, 1, 13, 11, OUTLINE);
    p.rect(1, 1, 11, 11, alarm ? ALARM : PAPER);
    p.rect(5, 12, 3, 2, OUTLINE);
    p.rect(6, 14, 1, 1, OUTLINE);
    art.rows.forEach((row, y) => {
      Array.from(row).forEach((ch, x) => {
        if (ch === 'x') p.put(3 + x, 2 + y, ink);
      });
    });
  });
}

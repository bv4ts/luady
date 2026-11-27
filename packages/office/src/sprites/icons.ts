import { paint, type Raster } from '../raster.js';
import type { BubbleIcon } from '../visuals.js';

/** A 7 x 7 status icon: 'x' marks a pixel in `color`. */
export interface IconArt { readonly color: string; readonly rows: readonly string[] }

const icon = (color: string, rows: readonly string[]): IconArt => Object.freeze({ color, rows: Object.freeze([...rows]) });

/** The status icons of the speech bubbles; team stands for helpers, list for planning and gear for other tools. */
export const ICONS: Readonly<Record<BubbleIcon, IconArt>> = Object.freeze({
  dots: icon('#5b6577', ['.......', '.......', '.......', 'x..x..x', '.......', '.......', '.......']),
  check: icon('#1c9b55', ['.......', '......x', '.....xx', 'x...xx.', 'xx.xx..', '.xxx...', '..x....']),
  bang: icon('#ffffff', ['..xxx..', '..xxx..', '..xxx..', '..xxx..', '.......', '..xxx..', '..xxx..']),
  cross: icon('#d8352a', ['x.....x', '.x...x.', '..x.x..', '...x...', '..x.x..', '.x...x.', 'x.....x']),
  zzz: icon('#7d8aa3', ['xxxx...', '..x....', '.x.....', 'xxxx...', '....xxx', '.....x.', '....xxx']),
  pencil: icon('#c77a00', ['.....xx', '....xxx', '...xxx.', '..xxx..', '.xxx...', 'xxx....', 'xx.....']),
  book: icon('#2f6fe0', ['.......', 'xxx.xxx', 'x.xxx.x', 'x..x..x', 'x..x..x', 'xxxxxxx', '.......']),
  term: icon('#1c9b55', ['.......', 'x......', '.x.....', '..x....', '.x.....', 'x..xxxx', '.......']),
  search: icon('#7c5cff', ['.xxx...', 'x...x..', 'x...x..', 'x...x..', '.xxx...', '....xx.', '.....xx']),
  pause: icon('#5b6577', ['.......', '.xx.xx.', '.xx.xx.', '.xx.xx.', '.xx.xx.', '.xx.xx.', '.......']),
  mail: icon('#b88600', ['.......', 'xxxxxxx', 'xx...xx', 'x.x.x.x', 'x..x..x', 'xxxxxxx', '.......']),
  key: icon('#b88600', ['..xxx..', '.x...x.', '..xxx..', '...x...', '...xx..', '...x...', '...xx..']),
  globe: icon('#2f6fe0', ['..xxx..', '.x.x.x.', 'x..x..x', 'xxxxxxx', 'x..x..x', '.x.x.x.', '..xxx..']),
  skill: icon('#7c5cff', ['...x...', '...x...', '..xxx..', 'xxxxxxx', '..xxx..', '...x...', '...x...']),
  ask: icon('#c77a00', ['.xxxx..', 'x....x.', '.....x.', '...xx..', '...x...', '.......', '...x...']),
  team: icon('#2a9d8f', ['.x...x.', 'xxx.xxx', '.x...x.', '.......', 'xxx.xxx', 'xxx.xxx', '.......']),
  list: icon('#2f6fe0', ['.......', 'x.xxxxx', '.......', 'x.xxxx.', '.......', 'x.xxxxx', '.......']),
  gear: icon('#5b6577', ['...x...', '.xxxxx.', '.xx.xx.', 'xx...xx', '.xx.xx.', '.xxxxx.', '...x...']),
});

const DROP_ROWS = ['..o..', '..o..', '.obo.', '.obo.', 'obbho', 'obbbo', '.ooo.'] as const;
const DROP_COLOURS: Readonly<Record<string, string>> = Object.freeze({ o: '#1f4fa8', b: '#5aa2ff', h: '#d6ecff' });

/** A 5 × 7 sweat drop for an agent whose context is nearly full. */
export function dropRaster(): Raster {
  return paint(5, 7, (p) => {
    DROP_ROWS.forEach((row, y) => {
      Array.from(row).forEach((ch, x) => {
        const colour = DROP_COLOURS[ch];
        if (colour !== undefined) p.put(x, y, colour);
      });
    });
  });
}

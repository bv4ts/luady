/**
 * The Luady mark: the pixel-art building on a rounded navy tile.
 *
 * The rows are the logo's own pixel masters (48, 32, 24 and 16 cells), one character per cell; '.' is empty.
 * They match the logo files (.github/assets/logo-*.png, site/public, public/icon*.svg): change them together,
 * never one without the others. The mark draws one master at a whole-number scale with at least 10 % navy
 * around it, so the pixels stay crisp: 26 and 28 px use the 16 master, 32 and 36 the 24, 40 to 56 the 32,
 * 60 to 79 the 48 (bigger sizes enlarge them by whole numbers).
 */
const NAVY = '#0c1328';
const TILE_RADIUS = 0.21875;
const ROOM = 0.8;
const DETAIL = 0.8;

const PALETTE: Readonly<Partial<Record<string, string>>> = {
  K: '#0c1328',
  w: '#403c7e',
  c: '#f4ead2',
  y: '#ffd84d',
  r: '#d6336c',
  t: '#3cc3b0',
  e: '#2fbf71',
  v: '#7c5cff',
  d: '#1b1731',
  W: '#ffffff',
};

const MASTERS = new Map<number, readonly string[]>([
  [48, [
    '.......................KK.......................',
    '......................KyyK......................',
    '......................KyyK......................',
    '......................KwwK......................',
    '.....................KwwwwK.....................',
    '..KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK..',
    '.KccccccccccccccccccccccccccccccccccccccccccccK.',
    '.KccccccccccccccccccccccccccccccccccccccccccccK.',
    '.KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK.',
    '..KwwwwwwwwwwwwwwwKyyyyyyyyyyKwwwwwwwwwwwwwwwK..',
    '..KwwwwwwwwwwwwwwwKyyyyyyyyyyKwwwwwwwwwwwwwwwK..',
    '..KwwwwwwwwwwwwwwwKyyyyyyyyyyKwwwwwwwwwwwwwwwK..',
    '..KwwwwwwwwwwwwwwwKyyyyyyyyyyKwwwwwwwwwwwwwwwK..',
    '..KwwwwwwwwwwwwwwwKyyyyyyyyyyKwwwwwwwwwwwwwwwK..',
    '..KwwwwwwwwwwwwwwwKyyyyyyyyyyKwwwwwwwwwwwwwwwK..',
    '..KwwwwwwwwwwwwwwwKyyyyyyyyyyKwwwwwwwwwwwwwwwK..',
    '..KwwwwwwwwwwwwwwwKyyyyyyyyyyKwwwwwwwwwwwwwwwK..',
    '..KwwwwwwwwwwwwwwwKyyyyyyyyyyKwwwwwwwwwwwwwwwK..',
    '..KwwwwwwwwwwwwwwwKyyyyyyyyyyKwwwwwwwwwwwwwwwK..',
    '.KwwwwwwwwwwwwwwwwKKKKKKKKKKKKwwwwwwwwwwwwwwwwK.',
    '.KwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwK.',
    '.KwwKKKKKKKKKKKKwwKKKKKKKKKKKKwwKKKKKKKKKKKKwwK.',
    '..KwKrrrrrrrrrrKwwKttttttttttKwwKeeeeeeeeeeKwK..',
    '..KwKrrrrrrrrrrKwwKtKKKttKKKtKwwKeeeeeeeeeeKwK..',
    '..KwKrrrrrrrrrrKwwKKWWWKKWWWKKwwKeeeeeeeeeeKwK..',
    '..KwKrrrrrrrrrrKwwKKWKWKKWKWKKwwKeeeeeeeeeeKwK..',
    '..KwKrrrrrrrrrrKwwKKWWWKKWWWKKwwKeeeeeeeeeeKwK..',
    '..KwKrrrrrrrrrrKwwKtKKKttKKKtKwwKeeeeeeeeeeKwK..',
    '..KwKrrrrrrrrrrKwwKttttttttttKwwKeeeeeeeeeeKwK..',
    '..KwKrrrrrrrrrrKwwKtttKttKtttKwwKeeeeeeeeeeKwK..',
    '..KwKrrrrrrrrrrKwwKttttKKttttKwwKeeeeeeeeeeKwK..',
    '..KwKrrrrrrrrrrKwwKttttttttttKwwKeeeeeeeeeeKwK..',
    '.KwwKKKKKKKKKKKKwwKKKKKKKKKKKKwwKKKKKKKKKKKKwwK.',
    '.KwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwK.',
    '.KwwKKKKKKKKKKKKwwwwwwwwwwwwwwwwKKKKKKKKKKKKwwK.',
    '..KwKccccccccccKwwwwwwwwwwwwwwwwKvvvvvvvvvvKwK..',
    '..KwKccccccccccKwwwwKKKKKKKKwwwwKvvvvvvvvvvKwK..',
    '..KwKccccccccccKwwwwKddddddKwwwwKvvvvvvvvvvKwK..',
    '..KwKccccccccccKwwwwKddddddKwwwwKvvvvvvvvvvKwK..',
    '..KwKccccccccccKwwwwKddddddKwwwwKvvvvvvvvvvKwK..',
    '..KwKccccccccccKwwwwKddddddKwwwwKvvvvvvvvvvKwK..',
    '..KwKccccccccccKwwwwKddddddKwwwwKvvvvvvvvvvKwK..',
    '..KwKccccccccccKwwwwKddddcdKwwwwKvvvvvvvvvvKwK..',
    '..KwKccccccccccKwwwwKddddddKwwwwKvvvvvvvvvvKwK..',
    '..KwKccccccccccKwwwwKddddddKwwwwKvvvvvvvvvvKwK..',
    '.KwwKKKKKKKKKKKKwwwwKddddddKwwwwKKKKKKKKKKKKwwK.',
    '.KwwwwwwwwwwwwwwwwwwKddddddKwwwwwwwwwwwwwwwwwwK.',
    '.KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK.',
  ]],
  [32, [
    '...............KK...............',
    '..............KyyK..............',
    '..............KyyK..............',
    '..............KwwK..............',
    '.KKKKKKKKKKKKKKKKKKKKKKKKKKKKKK.',
    'KccccccccccccccccccccccccccccccK',
    'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
    '.KwwwwwwwwwwKyyyyyyKwwwwwwwwwwK.',
    '.KwwwwwwwwwwKyyyyyyKwwwwwwwwwwK.',
    '.KwwwwwwwwwwKyyyyyyKwwwwwwwwwwK.',
    '.KwwwwwwwwwwKyyyyyyKwwwwwwwwwwK.',
    '.KwwwwwwwwwwKyyyyyyKwwwwwwwwwwK.',
    '.KwwwwwwwwwwKyyyyyyKwwwwwwwwwwK.',
    'KwwwwwwwwwwwKKKKKKKKwwwwwwwwwwwK',
    'KwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwK',
    'KwwKKKKKKKKwKKKKKKKKwKKKKKKKKwwK',
    '.KwKrrrrrrKwKttttttKwKeeeeeeKwK.',
    '.KwKrrrrrrKwKKWKKWKKwKeeeeeeKwK.',
    '.KwKrrrrrrKwKttttttKwKeeeeeeKwK.',
    '.KwKrrrrrrKwKtKttKtKwKeeeeeeKwK.',
    '.KwKrrrrrrKwKttKKttKwKeeeeeeKwK.',
    '.KwKrrrrrrKwKttttttKwKeeeeeeKwK.',
    'KwwKKKKKKKKwKKKKKKKKwKKKKKKKKwwK',
    'KwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwK',
    'KwwKKKKKKKKwwwwwwwwwwKKKKKKKKwwK',
    '.KwKccccccKwwKKKKKKwwKvvvvvvKwK.',
    '.KwKccccccKwwKddddKwwKvvvvvvKwK.',
    '.KwKccccccKwwKddddKwwKvvvvvvKwK.',
    '.KwKccccccKwwKddcdKwwKvvvvvvKwK.',
    '.KwKccccccKwwKddddKwwKvvvvvvKwK.',
    '.KwKccccccKwwKddddKwwKvvvvvvKwK.',
    'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
  ]],
  [24, [
    '...........KK...........',
    '..........KyyK..........',
    '..........KyyK..........',
    '.KKKKKKKKKKKKKKKKKKKKKK.',
    'KccccccccccccccccccccccK',
    'KKKKKKKKKKKKKKKKKKKKKKKK',
    'KwwwwwwwwwwwwwwwwwwwwwwK',
    'KwKKKKKKwKKKKKKwKKKKKKwK',
    'KwKrrrrKwKttttKwKeeeeKwK',
    'KwKrrrrKwKWttWKwKeeeeKwK',
    'KwKrrrrKwKttttKwKeeeeKwK',
    'KwKrrrrKwKtKKtKwKeeeeKwK',
    'KwKrrrrKwKttttKwKeeeeKwK',
    'KwKKKKKKwKKKKKKwKKKKKKwK',
    'KwwwwwwwwwwwwwwwwwwwwwwK',
    'KwKKKKKKwwwwwwwwKKKKKKwK',
    'KwKccccKwwKKKKwwKvvvvKwK',
    'KwKccccKwwKddKwwKvvvvKwK',
    'KwKccccKwwKddKwwKvvvvKwK',
    'KwKccccKwwKddKwwKvvvvKwK',
    'KwKccccKwwKddKwwKvvvvKwK',
    'KwKKKKKKwwKddKwwKKKKKKwK',
    'KwwwwwwwwwKddKwwwwwwwwwK',
    'KKKKKKKKKKKKKKKKKKKKKKKK',
  ]],
  [16, [
    '.......KK.......',
    '......KyyK......',
    '.KKKKKKKKKKKKKK.',
    'KccccccccccccccK',
    'KKKKKKKKKKKKKKKK',
    'KrrKwKWttWKwKeeK',
    'KrrKwKttttKwKeeK',
    'KrrKwKtKKtKwKeeK',
    'KrrKwKttttKwKeeK',
    'KKKKwKKKKKKwKKKK',
    'KwwwwwwwwwwwwwwK',
    'KKKKwwKKKKwwKKKK',
    'KccKwwKddKwwKvvK',
    'KccKwwKddKwwKvvK',
    'KccKwwKddKwwKvvK',
    'KKKKKKKKKKKKKKKK',
  ]],
]);

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fill: string;
}

/** Runs of equal cells, merged downwards while the run below is the same. */
function boxesOf(rows: readonly string[]): readonly Box[] {
  const done: Box[] = [];
  let open = new Map<string, Box>();
  rows.forEach((row, y) => {
    const next = new Map<string, Box>();
    let x = 0;
    while (x < row.length) {
      const fill = PALETTE[row.charAt(x)];
      let end = x + 1;
      while (end < row.length && PALETTE[row.charAt(end)] === fill) end += 1;
      if (fill !== undefined) {
        const id = `${x}:${end - x}:${fill}`;
        const above = open.get(id);
        next.set(id, above ? { ...above, h: above.h + 1 } : { x, y, w: end - x, h: 1, fill });
        open.delete(id);
      }
      x = end;
    }
    done.push(...open.values());
    open = next;
  });
  done.push(...open.values());
  return done;
}

const BOXES = new Map<number, readonly Box[]>(
  [...MASTERS].map(([n, rows]): [number, readonly Box[]] => [n, boxesOf(rows)]),
);

/**
 * A master and whole-number scale that leave at least 10 % of the tile on every side: the most detailed master whose
 * art is at least 80 % as large as the largest that fits (the 16 master when nothing fits).
 */
function pick(size: number): { n: number; scale: number } {
  const room = Math.floor(size * ROOM);
  const fits = [...MASTERS.keys()]
    .map((n) => ({ n, scale: Math.floor(room / n) }))
    .filter((f) => f.scale >= 1);
  const largest = Math.max(0, ...fits.map((f) => f.n * f.scale));
  return fits.find((f) => f.n * f.scale >= largest * DETAIL) ?? { n: 16, scale: 1 };
}

export function BrandMark({ size = 32 }: { size?: number }) {
  const { n, scale } = pick(size);
  const offset = Math.floor((size - n * scale) / 2);
  const boxes = BOXES.get(n) ?? [];
  return (
    <svg className="brand-mark" viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true" focusable="false">
      <rect width={size} height={size} rx={size * TILE_RADIUS} fill={NAVY} />
      <g transform={`translate(${offset} ${offset}) scale(${scale})`} shapeRendering="crispEdges">
        {boxes.map((b) => (
          <rect key={`${b.x}:${b.y}`} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.fill} />
        ))}
      </g>
    </svg>
  );
}

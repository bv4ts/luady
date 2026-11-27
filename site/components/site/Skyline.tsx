/**
 * A row of buildings at night along the bottom of the page, in whole pixel steps (one unit is one art pixel). Their
 * windows are one repeating pattern; a few are lit, and some switch on and off now and then (CSS only, and only when
 * motion is allowed). Decorative.
 */
const WIDTH = 360;
const HEIGHT = 64;

/** A small fixed pseudo-random sequence, so the skyline is the same on every build. */
function sequence(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

interface Building { x: number; y: number; w: number; h: number; back: boolean }
interface Light { x: number; y: number; blink: boolean }

function buildSkyline(): { buildings: Building[]; lights: Light[] } {
  const next = sequence(7);
  const buildings: Building[] = [];
  const lights: Light[] = [];
  let x = -2;
  while (x < WIDTH) {
    const w = 14 + Math.floor(next() * 22);
    const h = 14 + Math.floor(next() * 27);
    buildings.push({ x, y: HEIGHT - h, w, h, back: next() < 0.35 });
    // Windows sit on the pattern's 5-unit grid inside the building's walls; light a few of them.
    const grid = (v: number) => Math.ceil(v / 5) * 5;
    for (let wy = grid(HEIGHT - h + 4); wy < HEIGHT - 6; wy += 5) {
      for (let wx = grid(x + 3); wx < x + w - 5; wx += 5) {
        const r = next();
        if (r < 0.09) lights.push({ x: wx, y: wy, blink: false });
        else if (r < 0.15) lights.push({ x: wx, y: wy, blink: true });
      }
    }
    x += w + (next() < 0.3 ? 2 : 0);
  }
  return { buildings, lights };
}

const SKYLINE = buildSkyline();

export function Skyline() {
  return (
    <svg className="skyline" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMidYMax slice" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="skyline-windows" width="5" height="5" patternUnits="userSpaceOnUse">
          <rect className="w" width="2" height="2" />
        </pattern>
      </defs>
      {SKYLINE.buildings.map((b, i) => (
        <g key={i}>
          <rect className={b.back ? 'b2' : 'b'} x={b.x} y={b.y} width={b.w} height={b.h} />
          <rect fill="url(#skyline-windows)" x={b.x + 3} y={b.y + 4} width={Math.max(0, b.w - 6)} height={Math.max(0, b.h - 8)} />
        </g>
      ))}
      {SKYLINE.lights.map((l, i) => <rect key={i} className={l.blink ? 'w blink' : 'w on'} x={l.x} y={l.y} width="2" height="2" />)}
    </svg>
  );
}

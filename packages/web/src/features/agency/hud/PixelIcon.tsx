import { memo } from 'react';

/** Small pixel icons for the office HUD, drawn on a 10 × 10 grid ('x' = a lit pixel) in the current text colour. */
const ART = {
  board: [
    'xxxxxxxxxx',
    'x........x',
    'x.xx..xx.x',
    'x.xx..xx.x',
    'x........x',
    'x.xxx.xx.x',
    'x.xxx.xx.x',
    'x........x',
    'xxxxxxxxxx',
    '.x......x.',
  ],
  notes: [
    '.xxxxxxx..',
    '.x.....xx.',
    '.x.xxx..x.',
    '.x......x.',
    '.x.xxxx.x.',
    '.x......x.',
    '.x.xxx..x.',
    '.x......x.',
    '.xxxxxxxx.',
    '..........',
  ],
  library: [
    '..........',
    'xx.xxx....',
    'xx.xxx..xx',
    'xx.x.x..xx',
    'xx.xxx.xx.',
    'xx.x.x.xx.',
    'xx.xxx.xx.',
    'xx.xxx.xx.',
    'xxxxxxxxxx',
    '..........',
  ],
  jira: [
    '....xx....',
    '...xxxx...',
    '..xx..xx..',
    '.xx.xx.xx.',
    'xx.xxxx.xx',
    'xx.xxxx.xx',
    '.xx.xx.xx.',
    '..xx..xx..',
    '...xxxx...',
    '....xx....',
  ],
  chat: [
    '.xxxxxxxx.',
    'x........x',
    'x........x',
    'x.xx.xx..x',
    'x........x',
    'x........x',
    '.xxxxxxxx.',
    '..xx......',
    '..x.......',
    '..........',
  ],
  pulse: [
    '..........',
    '....x.....',
    '....x.....',
    '...x.x....',
    'xxxx.x..xx',
    '......x.x.',
    '......x.x.',
    '.......x..',
    '..........',
    '..........',
  ],
  envelope: [
    '..........',
    'xxxxxxxxxx',
    'xx......xx',
    'x.x....x.x',
    'x..x..x..x',
    'x...xx...x',
    'x........x',
    'xxxxxxxxxx',
    '..........',
    '..........',
  ],
  quote: [
    '..........',
    '.xxx.xxx..',
    '.xxx.xxx..',
    '.xxx.xxx..',
    '...x...x..',
    '..x...x...',
    '..........',
    '..........',
    '..........',
    '..........',
  ],
  plus: [
    '..........',
    '....xx....',
    '....xx....',
    '....xx....',
    '.xxxxxxxx.',
    '.xxxxxxxx.',
    '....xx....',
    '....xx....',
    '....xx....',
    '..........',
  ],
  speaker: [
    '..........',
    '....x...x.',
    '...xx....x',
    'xxxxx..x.x',
    'xxxxx...xx',
    'xxxxx...xx',
    'xxxxx..x.x',
    '...xx....x',
    '....x...x.',
    '..........',
  ],
  speakerOff: [
    '..........',
    '....x.....',
    '...xx.....',
    'xxxxx.x..x',
    'xxxxx..xx.',
    'xxxxx..xx.',
    'xxxxx.x..x',
    '...xx.....',
    '....x.....',
    '..........',
  ],
} as const satisfies Record<string, readonly string[]>;

export type PixelIconName = keyof typeof ART;

function pixelPath(rows: readonly string[]): string {
  return rows.flatMap((row, y) => Array.from(row).flatMap((ch, x) => (ch === 'x' ? [`M${x} ${y}h1v1h-1z`] : []))).join('');
}

const PATHS: Readonly<Record<PixelIconName, string>> = Object.fromEntries(
  Object.entries(ART).map(([name, rows]) => [name, pixelPath(rows)]),
) as Record<PixelIconName, string>;

/** Decorative: the button or text beside it carries the meaning. */
export const PixelIcon = memo(function PixelIcon({ name, size = 20, className }: { name: PixelIconName; size?: number; className?: string }) {
  return (
    <svg className={className === undefined ? 'pixel-icon' : `pixel-icon ${className}`} viewBox="0 0 10 10" width={size} height={size}
      aria-hidden="true" focusable="false" shapeRendering="crispEdges">
      <path d={PATHS[name]} fill="currentColor" />
    </svg>
  );
});

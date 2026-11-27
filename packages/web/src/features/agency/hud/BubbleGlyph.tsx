import { ICONS, type BubbleIcon } from '@luady/office';
import { memo } from 'react';

const ALARM: ReadonlySet<BubbleIcon> = new Set(['bang', 'key']);

/** The pixels of a 7 × 7 icon as one SVG path of 1 × 1 squares. */
function pixelPath(rows: readonly string[]): string {
  return rows.flatMap((row, y) => Array.from(row).flatMap((ch, x) => (ch === 'x' ? [`M${x + 1} ${y + 1}h1v1h-1z`] : []))).join('');
}

/**
 * The map's status icon in HTML: the same 7 × 7 pixels on a small paper bubble (red for the ones that need the owner),
 * so a step in a panel reads like the bubble over the character. Decorative: the text next to it says the same.
 */
export const BubbleGlyph = memo(function BubbleGlyph({ icon }: { icon: BubbleIcon }) {
  const art = Object.hasOwn(ICONS, icon) ? ICONS[icon] : ICONS.dots;
  const alarm = ALARM.has(icon);
  return (
    <svg className={alarm ? 'bubble-glyph bubble-glyph--alarm' : 'bubble-glyph'} viewBox="0 0 9 9" width="18" height="18"
      aria-hidden="true" focusable="false" shapeRendering="crispEdges">
      <rect className="bubble-glyph__paper" x="0" y="0" width="9" height="9" rx="1" />
      <path d={pixelPath(art.rows)} fill={alarm ? '#ffffff' : art.color} />
    </svg>
  );
});

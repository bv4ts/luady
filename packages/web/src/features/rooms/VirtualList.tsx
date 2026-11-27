import { useState, type ReactNode, type UIEvent } from 'react';

/** Rows drawn above and below the visible window, so a quick scroll shows no gap. */
const OVERSCAN = 6;

/** The rows to draw for a scroll position: a window of fixed-height rows, never the whole list. */
export function windowOf(count: number, scrollTop: number, viewport: number, rowHeight: number): { readonly from: number; readonly to: number } {
  const from = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const to = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);
  return { from, to };
}

/**
 * A list that draws every row while it is short and only the visible window once it has more than `threshold` rows
 * (rows then have a fixed height). Used by the rooms list and the Rooms menu, which hold any number of rooms.
 */
export function VirtualList<T>({ items, rowHeight, height, threshold, render, className, label, role = 'list', onScrollTo, id }: {
  items: readonly T[]; rowHeight: number; height: number; threshold: number; render: (item: T, index: number) => ReactNode;
  className?: string; label: string; role?: 'list' | 'listbox'; id?: string;
  /** Called with a scroll handler's element so a parent can scroll a row into view (keyboard moves). */
  onScrollTo?: (scroll: (index: number) => void) => void;
}) {
  const [top, setTop] = useState(0);
  const virtual = items.length > threshold;
  const onScroll = (event: UIEvent<HTMLElement>) => setTop(event.currentTarget.scrollTop);
  if (!virtual) {
    return (
      <ul id={id} className={className} role={role} aria-label={label}>
        {items.map((item, i) => render(item, i))}
      </ul>
    );
  }
  const { from, to } = windowOf(items.length, top, height, rowHeight);
  return (
    <ul id={id} className={`${className ?? ''} vlist`} role={role} aria-label={label} style={{ height, overflowY: 'auto' }} onScroll={onScroll}
      ref={(node) => {
        if (node !== null) onScrollTo?.((index) => { node.scrollTop = Math.max(0, index * rowHeight - height / 2); });
      }}>
      <li aria-hidden="true" className="vlist__pad" style={{ height: from * rowHeight }} />
      {items.slice(from, to).map((item, i) => render(item, from + i))}
      <li aria-hidden="true" className="vlist__pad" style={{ height: (items.length - to) * rowHeight }} />
    </ul>
  );
}

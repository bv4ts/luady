import { useEffect, type RefObject } from 'react';
import type { NoticeAcks } from './useNoticeAcks.js';

/**
 * Feeds the acknowledgement tracker while this view of a notice is on screen. With IntersectionObserver a view counts
 * only while at least half of it is inside the viewport (a row scrolled out of a list is not on screen); without it,
 * while it is mounted. `active` false (settled, or a question) feeds nothing.
 */
export function useSeen(acks: NoticeAcks, id: string, active: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = ref.current;
    if (!active || node === null) return undefined;
    if (typeof IntersectionObserver !== 'function') {
      acks.shown(id);
      return () => acks.hidden(id);
    }
    let showing = false;
    const observer = new IntersectionObserver(([entry]) => {
      const next = entry !== undefined && entry.isIntersecting && entry.intersectionRatio >= 0.5;
      if (next === showing) return;
      showing = next;
      if (next) acks.shown(id);
      else acks.hidden(id);
    }, { threshold: [0, 0.5, 1] });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (showing) acks.hidden(id);
    };
  }, [acks, id, active, ref]);
}

import type { SessionActivityDTO } from '@luady/shared';
import { sameMapView } from './store.js';

export interface MapCoalescerDeps {
  intervalMs: number;
  /** The session's map view right now. */
  viewOf: (sessionId: string) => SessionActivityDTO;
  /** False once the session has no record and no pause: its last sent view is forgotten after it went out. */
  keep: (sessionId: string) => boolean;
  emit: (items: SessionActivityDTO[]) => void;
}

export interface MapCoalescer {
  /** Something about the session changed; its view goes out at once or at the end of the current second. */
  mark(sessionId: string): void;
  stop(): void;
}

/**
 * At most one message per interval. The first change after a quiet interval goes out at once; changes within the
 * interval are held and go out together when it is over. Only views that differ from the last one sent are due.
 */
export function createMapCoalescer(deps: MapCoalescerDeps): MapCoalescer {
  const dirty = new Set<string>();
  const lastSent = new Map<string, SessionActivityDTO>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): boolean {
    const due = [...dirty].flatMap((sessionId) => {
      const view = deps.viewOf(sessionId);
      const last = lastSent.get(sessionId);
      if (deps.keep(sessionId)) lastSent.set(sessionId, view);
      else lastSent.delete(sessionId);
      return last !== undefined && sameMapView(last, view) ? [] : [view];
    });
    dirty.clear();
    if (due.length > 0) deps.emit(due);
    return due.length > 0;
  }

  function openWindow(): void {
    timer = setTimeout(() => {
      timer = null;
      if (flush()) openWindow();
    }, deps.intervalMs);
  }

  return {
    mark(sessionId) {
      dirty.add(sessionId);
      if (timer !== null) return;
      if (flush()) openWindow();
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      dirty.clear();
      lastSent.clear();
    },
  };
}

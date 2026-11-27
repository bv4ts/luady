import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { openNotices } from '../../../state/selectors.js';
import { useStore } from '../../../state/store.js';
import { createAckTracker } from './ack-tracker.js';

/** How often the tracker is asked what is due while a notice is on screen. */
export const ACK_POLL_MS = 500;

export interface NoticeAcks {
  /** A view of this notice is on screen (toast, list row, chat line). Several views may show the same notice. */
  shown(id: string): void;
  hidden(id: string): void;
  /** The owner clicked it: acknowledged at once. */
  clicked(id: string): void;
}

const hasAttention = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

/** Re-sends, after a reconnect, the acknowledgements the hub has not settled yet (a frame sent while closed is lost). */
function useResendAfterReconnect(sent: RefObject<ReadonlySet<string>>, send: (ids: readonly string[]) => void): void {
  const { state } = useStore();
  const { epoch } = state.connection;
  const notices = useRef(state.notices);
  useEffect(() => {
    notices.current = state.notices;
  }, [state.notices]);
  useEffect(() => {
    if (epoch <= 1) return;
    const open = new Set(openNotices(notices.current).map((n) => n.id));
    const again = [...sent.current].filter((id) => open.has(id));
    if (again.length > 0) send(again);
  }, [epoch, sent, send]);
}

/**
 * Acknowledges a notice only when the owner really saw it: 3 seconds on screen in a visible, focused tab, or a click.
 * Questions and permissions are never passed here (they settle when answered).
 */
export function useNoticeAcks(): NoticeAcks {
  const { live } = useStore();
  const [tracker] = useState(createAckTracker);
  const counts = useRef<ReadonlyMap<string, number>>(new Map());
  const sent = useRef<ReadonlySet<string>>(new Set());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const send = useCallback((ids: readonly string[]) => {
    sent.current = new Set([...sent.current, ...ids]);
    live.ackNotices(ids);
  }, [live]);

  const stop = useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const poll = useCallback(() => {
    const due = tracker.due(Date.now());
    if (due.length > 0) send(due);
    if (!tracker.watching()) stop();
  }, [tracker, send, stop]);

  const start = useCallback(() => {
    if (timer.current === null) timer.current = setInterval(poll, ACK_POLL_MS);
  }, [poll]);

  useEffect(() => {
    const update = (): void => tracker.attention(hasAttention(), Date.now());
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      stop();
    };
  }, [tracker, stop]);

  useResendAfterReconnect(sent, send);

  return useMemo<NoticeAcks>(() => ({
    shown: (id) => {
      const count = counts.current.get(id) ?? 0;
      counts.current = new Map([...counts.current, [id, count + 1]]);
      tracker.attention(hasAttention(), Date.now());
      tracker.shown(id, Date.now());
      start();
    },
    hidden: (id) => {
      const left = (counts.current.get(id) ?? 1) - 1;
      counts.current = left > 0 ? new Map([...counts.current, [id, left]]) : new Map([...counts.current].filter(([key]) => key !== id));
      if (left <= 0) tracker.hidden(id);
    },
    clicked: (id) => {
      tracker.done(id);
      if (!sent.current.has(id)) send([id]);
    },
  }), [tracker, start, send]);
}

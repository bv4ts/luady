import type { NoticeDTO } from '@luady/shared';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { Markdown } from '../../../markdown/Markdown.js';
import { useStore } from '../../../state/store.js';
import { Icon } from '../../../ui/Icon.js';
import { noticeBody, noticeIcon } from '../model/notice-text.js';
import type { NoticeAcks } from '../model/useNoticeAcks.js';
import { useSeen } from '../model/useSeen.js';
import { isRedNotice, nextExpiry, toastList } from '../model/toast-list.js';

export { NOTICE_TOASTS_MAX } from '../model/toast-list.js';
/** A notice this much older than the page (or clock skew) was there before: it is listed, not toasted. */
const LOAD_SLACK_MS = 10_000;

/** Where a notice leads: the agent of a session (or of a question), the chat for a Luady reply; null otherwise. */
export function noticeTarget(notice: NoticeDTO, sessions: readonly { id: string; pendingQid: string | null }[]): string | null {
  if (notice.ref?.kind === 'session') return notice.ref.id;
  if (notice.ref?.kind === 'question') return sessions.find((s) => s.pendingQid === notice.ref?.id)?.id ?? null;
  return null;
}

function NoticeToast({ notice, acks, onOpen, onClose }: {
  notice: NoticeDTO; acks: NoticeAcks; onOpen: (notice: NoticeDTO) => void; onClose: (notice: NoticeDTO) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  // Only an open, ordinary notice is acknowledged by being seen; a red one settles when it is answered.
  useSeen(acks, notice.id, notice.settledAt === null && !isRedNotice(notice), ref);
  const open = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('a, button') !== null) return;
    onOpen(notice);
  };
  return (
    <article ref={ref} className={`notice-toast notice-toast--${notice.kind}`} data-testid="notice-toast" data-notice={notice.id}
      aria-label={`Notice: ${notice.kind}`} onClick={open}>
      <Icon name={noticeIcon(notice.kind)} className="notice-toast__icon" />
      <Markdown source={noticeBody(notice.text)} className="notice-toast__text" />
      <span className="notice-toast__actions">
        <button type="button" className="notice-toast__open" onClick={() => onOpen(notice)}>Show</button>
        <button type="button" className="notice-toast__close" aria-label="Dismiss notice" onClick={() => onClose(notice)}>
          <Icon name="x" />
        </button>
      </span>
    </article>
  );
}

/** Remembers when each toast first showed, and re-renders when a lingering one has had its 6 seconds. */
function useShownAt(
  toasts: readonly NoticeDTO[], shownAt: ReadonlyMap<string, number>, setShownAt: (next: ReadonlyMap<string, number>) => void,
): void {
  const [, setTick] = useState(0);
  const ids = toasts.map((n) => n.id).join(' ');
  useEffect(() => {
    const fresh = toasts.filter((n) => !shownAt.has(n.id));
    if (fresh.length > 0) setShownAt(new Map([...shownAt, ...fresh.map((n): [string, number] => [n.id, Date.now()])]));
    // `ids` stands for `toasts`, which is a new array on every render.
  }, [ids, shownAt, setShownAt]);
  const expiry = nextExpiry(toasts, shownAt);
  useEffect(() => {
    if (expiry === null) return undefined;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, expiry - Date.now()));
    return () => clearTimeout(timer);
  }, [expiry]);
}

/**
 * Notices that came while this page was open, newest on top, at most three, never chat replies. An ordinary one
 * stays at least 6 seconds (it is acknowledged after 3 on screen); a red question or permission stays until it is
 * dismissed or answered.
 */
export function NoticeToasts({ acks, onSelect }: { acks: NoticeAcks; onSelect: (sessionId: string) => void }) {
  const { state } = useStore();
  const navigate = useNavigate();
  const [since] = useState(() => Date.now() - LOAD_SLACK_MS);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [shownAt, setShownAt] = useState<ReadonlyMap<string, number>>(() => new Map());
  const toasts = toastList({ notices: state.notices, since, closed, shownAt, now: Date.now() });
  useShownAt(toasts, shownAt, setShownAt);

  const ackable = (notice: NoticeDTO): boolean => notice.settledAt === null && !isRedNotice(notice);
  const onOpen = (notice: NoticeDTO) => {
    if (ackable(notice)) acks.clicked(notice.id);
    if (notice.ref?.kind === 'manager') {
      void navigate('/manager');
      return;
    }
    const target = noticeTarget(notice, state.sessions);
    if (target !== null) onSelect(target);
  };
  const onClose = (notice: NoticeDTO) => {
    if (ackable(notice)) acks.clicked(notice.id);
    setClosed((prev) => new Set([...prev, notice.id]));
  };

  return (
    toasts.length === 0 ? null : (
      <div className="notice-toasts" aria-live="polite">
        {toasts.map((notice) => <NoticeToast key={notice.id} notice={notice} acks={acks} onOpen={onOpen} onClose={onClose} />)}
      </div>
    )
  );
}

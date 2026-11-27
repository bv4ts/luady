import type { ChatMessageDTO } from '@luady/shared';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { channelLabel } from '../../../lib/channels.js';
import { isNoUpdate } from '../../luady/no-update.js';
import { Markdown } from '../../../markdown/Markdown.js';
import type { LuadyThread } from '../../../state/reducer.js';
import { chatNoticeIds } from '../../../state/selectors.js';
import { useStore } from '../../../state/store.js';
import type { NoticeAcks } from '../model/useNoticeAcks.js';
import { useSeen } from '../model/useSeen.js';
import { formatClock } from './Clock.js';
import { managerName } from '@luady/shared';

/** "3:20 PM" in owner time; nothing for a time that does not read. */
const timeOf = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? formatClock(ms) : '';
};

const ABOUT_WORDS: Readonly<Record<string, string>> = { note: 'Note', todo: 'Card', jira: 'Ticket' };

export const isMine = (message: Pick<ChatMessageDTO, 'role'>): boolean => message.role === 'owner' || message.role === 'user';
export const fromLuady = (message: Pick<ChatMessageDTO, 'role'>): boolean => message.role === 'manager' || message.role === 'assistant';
/** Luady's NO_UPDATE to a background turn: kept by the hub, never shown as an answer. */
export const isSilent = (message: Pick<ChatMessageDTO, 'role' | 'text'>): boolean => fromLuady(message) && isNoUpdate(message.text);

/** One message, whole: the owner's words as written, Luady's as Markdown; what it is about, where it came from, when. */
function DockMessage({ message, noticeId, acks }: { message: ChatMessageDTO; noticeId: string | null; acks: NoticeAcks }) {
  const ref = useRef<HTMLLIElement>(null);
  // A Luady message that is an open notice counts as seen while it is on screen here.
  useSeen(acks, noticeId ?? '', noticeId !== null, ref);
  const mine = isMine(message);
  const who = mine ? 'mine' : message.role === 'system' ? 'system' : 'manager';
  return (
    <li ref={ref} className={`dock-msg dock-msg--${who}`}>
      {message.about === undefined ? null : (
        <span className="agency-tag dock-msg__about" dir="auto">{ABOUT_WORDS[message.about.kind] ?? 'About'}: {message.about.label}</span>
      )}
      {mine ? <p className="dock-msg__text" dir="auto">{message.text}</p> : <Markdown source={message.text} className="dock-msg__text" />}
      <span className="dock-msg__meta">
        {mine ? 'You' : message.role === 'system' ? 'Note' : managerName()}
        {message.channel !== null && message.channel !== 'web' ? ` on ${channelLabel(message.channel)}` : ''}
        {', '}
        <time dateTime={message.ts}>{timeOf(message.ts)}</time>
      </span>
    </li>
  );
}

/** The whole conversation with Luady, newest at the bottom, scrolled there when something new comes. */
export function ChatLog({ thread, loading, error, acks, loadingOlder, onOlder }: {
  thread: LuadyThread; loading: boolean; error: string | null; acks: NoticeAcks; loadingOlder: boolean; onOlder: () => void;
}) {
  const { state } = useStore();
  const notices = useMemo(() => chatNoticeIds(state.notices), [state.notices]);
  const ref = useRef<HTMLOListElement>(null);
  const shown = useMemo(() => thread.items.filter((message) => !isSilent(message)), [thread.items]);
  const count = shown.length + thread.pending.length;
  useLayoutEffect(() => {
    const node = ref.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [count]);

  return (
    <ol ref={ref} className="agency-dock__log agency-scroll" role="log" aria-label={`Messages with ${managerName()}`} tabIndex={0}>
      {thread.nextCursor === null ? null : (
        <li className="agency-dock__older">
          <button type="button" className="agency-dock__older-btn" disabled={loadingOlder} onClick={onOlder}>
            {loadingOlder ? 'Loading…' : 'Earlier messages'}
          </button>
        </li>
      )}
      {loading && count === 0 ? <li className="agency-dock__state" role="status">Loading messages…</li> : null}
      {error === null ? null : <li className="agency-dock__state agency-dock__state--error">Messages could not load: {error}</li>}
      {!loading && error === null && count === 0 ? (
        <li className="agency-empty">
          <p className="agency-empty__title">Say hi to {managerName()}</p>
          <p className="agency-empty__body">Ask how a session is going, start a mission, or paste a stand-up summary for him to read.</p>
        </li>
      ) : null}
      {shown.map((message) => (
        <DockMessage key={message.id} message={message} acks={acks} noticeId={isMine(message) ? null : notices.get(message.id) ?? null} />
      ))}
      {thread.pending.map((pending) => (
        <li key={pending.localId} className="dock-msg dock-msg--mine dock-msg--pending">
          <p className="dock-msg__text" dir="auto">{pending.text}</p>
          <span className="dock-msg__meta">{pending.status === 'sending' ? 'Sending…' : 'Sent'}</span>
        </li>
      ))}
    </ol>
  );
}

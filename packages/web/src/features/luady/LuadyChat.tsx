import type { ChatMessageDTO } from '@luady/shared';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { channelLabel } from '../../lib/channels.js';
import { looksLikePin } from '../../lib/digits.js';
import { ownerTime } from '../../lib/format.js';
import { Markdown } from '../../markdown/Markdown.js';
import type { PendingLuadyMessage } from '../../state/reducer.js';
import { chatNoticeIds } from '../../state/selectors.js';
import { useStore } from '../../state/store.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Spinner } from '../../ui/Spinner.js';
import { useNoticeAcks, type NoticeAcks } from '../agency/model/useNoticeAcks.js';
import { useSeen } from '../agency/model/useSeen.js';
import { useManagerOff } from './ManagerOff.js';
import { heldText, useLuadyThread } from './useLuadyThread.js';
import { managerName } from '@luady/shared';

/** A Luady message that is an open notice counts as seen while it is on screen here, like on the office's chat line. */
function ChatBubble({ message, noticeId, acks }: { message: ChatMessageDTO; noticeId: string | null; acks: NoticeAcks }) {
  const ref = useRef<HTMLDivElement>(null);
  useSeen(acks, noticeId ?? '', noticeId !== null, ref);
  const mine = message.role === 'owner' || message.role === 'user';
  const className = mine ? 'chat-msg chat-msg--mine' : message.role === 'system' ? 'chat-msg chat-msg--system' : 'chat-msg';
  return (
    <div ref={ref} className={className}>
      {mine ? <p className="chat-msg__text" dir="auto">{message.text}</p> : <Markdown source={message.text} />}
      <div className="chat-msg__meta">
        {message.channel ? <span className="chip">{channelLabel(message.channel)}</span> : null}
        <time dateTime={message.ts}>{ownerTime(message.ts) ?? ''}</time>
      </div>
    </div>
  );
}

function PendingBubble({ pending }: { pending: PendingLuadyMessage }) {
  return (
    <div className="chat-msg chat-msg--mine chat-msg--pending">
      <p className="chat-msg__text" dir="auto">{pending.text}</p>
      <div className="chat-msg__meta"><span>{pending.status === 'sending' ? 'Sending…' : 'Sent'}</span></div>
    </div>
  );
}

type ThreadView = ReturnType<typeof useLuadyThread>;

/** Open notices that are Luady chat messages, by message id. */
function useChatNotices(): ReadonlyMap<string, string> {
  const { state } = useStore();
  return useMemo(() => chatNoticeIds(state.notices), [state.notices]);
}

function ChatLog({ view }: { view: ThreadView }) {
  const { thread, loading, loadingOlder, error, loadOlder } = view;
  const logRef = useRef<HTMLDivElement>(null);
  const count = thread.items.length + thread.pending.length;
  const acks = useNoticeAcks();
  const chatNotices = useChatNotices();

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  return (
    <div className="chat__log" ref={logRef} role="log" aria-label="Messages" tabIndex={0}>
      {thread.nextCursor ? <Button variant="ghost" size="sm" busy={loadingOlder} onClick={() => void loadOlder()}>Load earlier messages</Button> : null}
      {loading ? <Spinner size="lg" label="Loading messages" /> : null}
      {error ? <Banner tone="error">{error}</Banner> : null}
      {!loading && count === 0 ? (
        <EmptyState icon="manager" title={`Say hi to ${managerName()}`}
          body={`Ask about your sessions, start a mission or have ${managerName()} check a server. Messages from your chat channel show up here too.`} />
      ) : null}
      {thread.items.map((message) => (
        <ChatBubble key={message.id} message={message} acks={acks}
          noticeId={message.role === 'owner' || message.role === 'user' ? null : chatNotices.get(message.id) ?? null} />
      ))}
      {thread.pending.map((pending) => <PendingBubble key={pending.localId} pending={pending} />)}
    </div>
  );
}

export function LuadyChat() {
  const view = useLuadyThread();
  const { send } = view;
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const inputId = useId();
  // Switched off: the hub refuses messages (409 manager_off); the page says so above, the composer waits.
  const off = useManagerOff();

  async function submit() {
    const value = text.trim();
    if (value === '' || off) return;
    // A PIN must never reach Luady's context.
    if (looksLikePin(value)) {
      setNotice(`That looks like a PIN. PINs go only into PIN prompts and are never sent to ${managerName()}.`);
      return;
    }
    setNotice(null);
    setText('');
    if (!(await send(value))) setText(value);
  }

  return (
    <section className="chat" aria-label={`Conversation with ${managerName()}`}>
      <ChatLog view={view} />
      {view.held ? <Banner tone="info">{heldText()}</Banner> : null}
      {notice ? <p className="form-error" role="alert">{notice}</p> : null}
      <form className="chat__composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="visually-hidden" htmlFor={inputId}>Message to {managerName()}</label>
        <textarea id={inputId} className="textarea chat__input" rows={1} maxLength={20000} dir="auto" value={text} disabled={off}
          placeholder={off ? `${managerName()} is off` : `Message ${managerName()}… (Ctrl+Enter to send)`} onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }} />
        <Button type="submit" variant="primary" className="btn--icon" aria-label={`Send to ${managerName()}`} icon="send" disabled={off || text.trim() === ''} />
      </form>
    </section>
  );
}

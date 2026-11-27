import { useCallback, useEffect, useId, useState, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../../api/context.js';
import { userMessage } from '../../../api/errors.js';
import { looksLikePin } from '../../../lib/digits.js';
import { useStore } from '../../../state/store.js';
import { Icon } from '../../../ui/Icon.js';
import { ManagerOffHint, useManagerOff } from '../../luady/ManagerOff.js';
import { heldText, useLuadyThread } from '../../luady/useLuadyThread.js';
import type { NoticeAcks } from '../model/useNoticeAcks.js';
import { useMediaQuery } from '../model/useViewport.js';
import { plainLine } from '../model/words.js';
import { ChatLog, fromLuady, isSilent } from './ChatLog.js';
import { PixelIcon } from './PixelIcon.js';
import './chat-dock.css';
import { managerName } from '@luady/shared';

const NO_ACKS: NoticeAcks = { shown: () => undefined, hidden: () => undefined, clicked: () => undefined };
const pinWords = (): string => `That looks like a PIN. PINs go only into PIN prompts and are never sent to ${managerName()}.`;
const CARD_TITLE_MAX = 300;

/** Presses in the dock end here: the map behind it must not take them. */
const keepInside = (event: SyntheticEvent) => event.stopPropagation();

/** A board card from what the owner typed: the first line is the title, the whole text the details when it is longer. */
export function cardFromText(text: string): { title: string; details?: string; source: 'web' } {
  const title = plainLine(text, CARD_TITLE_MAX);
  return text.trim() === title ? { title, source: 'web' } : { title, details: text.trim(), source: 'web' };
}

/**
 * Answers from Luady that came after the conversation was last open (by message id, so the hub's and this device's
 * clocks never need to agree). What was there at the first load counts as read.
 */
function useUnread(open: boolean, thread: ReturnType<typeof useLuadyThread>['thread']): boolean {
  const [read, setRead] = useState<ReadonlySet<string> | null>(null);
  const { items, loaded } = thread;
  useEffect(() => {
    if (!loaded || (!open && read !== null)) return;
    const ids = items.filter(fromLuady).map((message) => message.id);
    if (read === null || ids.some((id) => !read.has(id))) setRead(new Set(ids));
  }, [open, loaded, items, read]);
  return !open && read !== null && items.some((message) => fromLuady(message) && !isSilent(message) && !read.has(message.id));
}

function SendMenu({ onSend, onBoard, onClose }: { onSend: () => void; onBoard: () => void; onClose: () => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
  };
  return (
    <div className="agency-dock__menu" role="menu" aria-label="Send as" onKeyDown={onKeyDown}>
      <button type="button" role="menuitem" className="agency-dock__menu-item" onClick={onSend}>
        <Icon name="send" />Send to {managerName()}
      </button>
      <button type="button" role="menuitem" className="agency-dock__menu-item" onClick={onBoard}>
        <PixelIcon name="board" size={16} />Add to board
      </button>
    </div>
  );
}

export interface ChatDockProps {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly acks?: NoticeAcks;
  /** The owner's message is on its way (the envelope and the pop above Luady). */
  readonly onSent?: () => void;
  /** The hub kept it because Luady is signed out. */
  readonly onHeld?: () => void;
  /** The send failed (the text is back in the input). */
  readonly onFailed?: () => void;
}

/**
 * The chat with Luady at the bottom of the office. Closed: the input with a chat button (a dot for unread
 * answers). Open: the whole conversation with full messages above it, a sheet on a phone. "/" still focuses the input.
 */
export function ChatDock({ inputRef, acks = NO_ACKS, onSent, onHeld, onFailed }: ChatDockProps) {
  const view = useLuadyThread();
  const { thread, error, send, held, loading, loadingOlder, loadOlder } = view;
  const api = useApi();
  const { toast } = useStore();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const inputId = useId();
  const unread = useUnread(open, thread);
  const phone = useMediaQuery('(max-width: 759px)');
  // Switched off: the input says so instead of sending into the hub's refusal; the history still opens.
  const off = useManagerOff();
  const placeholder = off ? `${managerName()} is off` : phone ? `Tell ${managerName()} something` : `Tell ${managerName()} something (press / to type)`;

  useEffect(() => {
    if (held) onHeld?.();
  }, [held, onHeld]);

  /** The typed words when they may go out; null (with the reason shown) when not. */
  const takeText = (): string | null => {
    const value = text.trim();
    if (value === '' || off) return null;
    // A PIN must never reach Luady's context, nor the board.
    if (looksLikePin(value)) {
      setNotice(pinWords());
      return null;
    }
    setNotice(null);
    setMenu(false);
    return value;
  };

  async function submit() {
    const value = takeText();
    if (value === null) return;
    setText('');
    onSent?.();
    if (await send(value)) return;
    setText(value);
    onFailed?.();
  }

  async function addToBoard() {
    const value = takeText();
    if (value === null) return;
    setText('');
    try {
      const card = await api.createCard(cardFromText(value));
      toast('success', `Added to the board as #${card.id}.`);
    } catch (err) {
      setText(value);
      toast('error', userMessage(err));
    }
  }

  const close = useCallback(() => setOpen(false), []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    close();
  };

  return (
    <section className={open ? 'agency-dock agency-dock--open' : 'agency-dock'} aria-label={`Chat with ${managerName()}`} data-testid="chat-dock"
      onKeyDown={onKeyDown} onPointerDown={keepInside} onPointerUp={keepInside} onWheel={keepInside} onContextMenu={keepInside}
      onTouchStart={keepInside} onTouchEnd={keepInside}>
      {open ? (
        <div className="agency-dock__panel" role="region" aria-label={`Conversation with ${managerName()}`}>
          <header className="agency-dock__head">
            <span className="agency-dock__title">{managerName()}</span>
            <Link className="agency-dock__full" to="/manager">Full chat page</Link>
            <button type="button" className="agency-dock__close" aria-label="Hide the conversation" onClick={close}><Icon name="x" /></button>
          </header>
          <ChatLog thread={thread} loading={loading} error={error} acks={acks} loadingOlder={loadingOlder} onOlder={() => void loadOlder()} />
          {held ? <p className="agency-dock__held" role="status">{heldText()}</p> : null}
        </div>
      ) : null}
      {notice === null ? null : <p className="agency-dock__notice" role="alert">{notice}</p>}
      {off ? <ManagerOffHint className="agency-dock__off" /> : null}
      <form className="agency-dock__bar" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <button type="button" className="agency-dock__toggle" aria-expanded={open} data-unread={unread}
          aria-label={open ? 'Hide the conversation' : unread ? `Show the conversation, new answers from ${managerName()}` : 'Show the conversation'}
          title={open ? 'Hide the conversation' : 'Show the conversation'} onClick={() => setOpen((prev) => !prev)}>
          <PixelIcon name="chat" size={18} />
          {unread ? <span className="agency-dock__unread" aria-hidden="true" /> : null}
        </button>
        <label className="visually-hidden" htmlFor={inputId}>Message to {managerName()}</label>
        <input ref={inputRef} id={inputId} className="agency-dock__input" type="text" maxLength={20000} dir="auto" data-chat-input
          autoComplete="off" enterKeyHint="send" placeholder={placeholder} value={text} disabled={off}
          onChange={(event) => setText(event.target.value)} />
        <span className="agency-dock__send-group">
          <button type="submit" className="agency-dock__send" aria-label={`Send to ${managerName()}`} disabled={off || text.trim() === ''}>
            <Icon name="send" />
          </button>
          <button type="button" className="agency-dock__more" aria-label="More ways to send" aria-haspopup="menu" aria-expanded={menu}
            disabled={off} onClick={() => setMenu((prev) => !prev)}>
            <Icon name="chevron" />
          </button>
          {menu ? <SendMenu onSend={() => void submit()} onBoard={() => void addToBoard()} onClose={() => setMenu(false)} /> : null}
        </span>
      </form>
    </section>
  );
}

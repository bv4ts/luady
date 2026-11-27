import type { SessionDTO } from '@luady/shared';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { useApi } from '../../../api/context.js';
import { userMessage } from '../../../api/errors.js';
import { useStore } from '../../../state/store.js';
import { Button } from '../../../ui/Button.js';
import { Icon } from '../../../ui/Icon.js';
import type { ActorMenuAt } from '../model/ui-state.js';

const EDGE = 8;
const NOTE_MAX = 20_000;

/** Presses, wheel and touches on the box end here: the map behind it must not react. */
const keepInside = (event: SyntheticEvent) => event.stopPropagation();

/** Why a note cannot be sent now, in one line; null when it can. */
export function noteBlocked(session: SessionDTO, paused: boolean): string | null {
  if (session.state === 'ended') return 'This agent has ended.';
  if (paused) return 'Paused. Resume it to send a note.';
  if (session.pendingQid !== null || session.state === 'waiting_question' || session.state === 'waiting_permission') {
    return 'It is waiting for your answer first.';
  }
  return null;
}

/** Keeps the box inside the window, at the point where the menu was. */
function usePlacement(at: ActorMenuAt) {
  const ref = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.left = `${Math.max(EDGE, Math.min(at.x, window.innerWidth - node.offsetWidth - EDGE))}px`;
    node.style.top = `${Math.max(EDGE, Math.min(at.y, window.innerHeight - node.offsetHeight - EDGE))}px`;
    inputRef.current?.focus();
  }, [at.x, at.y]);
  return { ref, inputRef };
}

/** "Send a note": a short message typed into the agent's session, from the character's menu. */
export function NotePopover({ at, session, onClose }: { at: ActorMenuAt; session: SessionDTO; onClose: () => void }) {
  const api = useApi();
  const { state, toast } = useStore();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ref, inputRef } = usePlacement(at);
  const inputId = useId();
  const hintId = useId();
  const blocked = noteBlocked(session, state.activity[session.id]?.paused === true);

  async function send() {
    if (blocked !== null || busy || text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await api.sendToSession(session.id, { text });
      toast('success', `Note sent to ${session.displayName}.`);
      onClose();
    } catch (err) {
      setError(userMessage(err));
      setBusy(false);
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <section ref={ref} className="agency-note" role="dialog" aria-modal="false" aria-label={`Note to ${session.displayName}`}
      onKeyDown={onKeyDown} onPointerDown={keepInside} onPointerUp={keepInside} onWheel={keepInside}
      onContextMenu={keepInside} onTouchStart={keepInside} onTouchEnd={keepInside}>
      <header className="agency-note__head">
        <label htmlFor={inputId} className="agency-note__title" dir="auto">{`Note to ${session.displayName}`}</label>
        <button type="button" className="agency-note__close" aria-label="Close note" onClick={onClose}><Icon name="x" /></button>
      </header>
      <textarea ref={inputRef} id={inputId} className="agency-note__input" rows={3} maxLength={NOTE_MAX} dir="auto"
        data-testid="note-input" value={text} disabled={blocked !== null || busy} aria-describedby={blocked === null ? undefined : hintId}
        placeholder="Type a note (Ctrl+Enter to send)" onChange={(event) => setText(event.target.value)} />
      {blocked === null ? null : <p id={hintId} className="agency-note__hint">{blocked}</p>}
      {error === null ? null : <p className="agency-note__error" role="alert">{error}</p>}
      <div className="agency-note__actions">
        <Button size="sm" variant="primary" icon="send" busy={busy} data-testid="note-send"
          disabled={blocked !== null || text.trim() === ''} onClick={() => void send()}>Send</Button>
      </div>
    </section>
  );
}

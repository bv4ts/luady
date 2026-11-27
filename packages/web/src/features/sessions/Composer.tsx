import type { SessionDTO } from '@luady/shared';
import { useId, useState } from 'react';
import { useApi } from '../../api/context.js';
import { isApiError, userMessage } from '../../api/errors.js';
import { useStore } from '../../state/store.js';
import { Button } from '../../ui/Button.js';

/** Shown in the message box while the owner has paused the agent (the hub refuses a send then). */
export const PAUSED_HINT = 'Paused. Resume it to send a message.';

export function Composer({ session, disabledReason: given }: { session: SessionDTO; disabledReason: string | null }) {
  const api = useApi();
  const { state, toast } = useStore();
  const paused = state.activity[session.id]?.paused === true;
  const disabledReason = given ?? (paused && session.state !== 'ended' ? PAUSED_HINT : null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const inputId = useId();

  async function send() {
    if (text.trim() === '' || disabledReason !== null) return;
    setBusy(true);
    try {
      await api.sendToSession(session.id, { text });
      setText('');
    } catch (err) {
      toast('error', isApiError(err, 'question_pending')
        ? 'Answer the pending question first; the session is waiting for it.'
        : userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <label className="visually-hidden" htmlFor={inputId}>Message to {session.displayName}</label>
      <textarea id={inputId} className="textarea composer__input" rows={1} maxLength={20000} dir="auto" value={text}
        data-testid="session-send-input"
        placeholder={disabledReason ?? `Message ${session.displayName}… (Ctrl+Enter to send)`}
        disabled={disabledReason !== null || busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }} />
      <Button type="submit" variant="primary" className="btn--icon" aria-label="Send" icon="send" busy={busy}
        disabled={disabledReason !== null || text.trim() === ''} data-testid="session-send-button" />
    </form>
  );
}

import type { AboutRef } from '@luady/shared';
import { useId, useState, type FormEvent } from 'react';
import { useApi } from '../../../../api/context.js';
import { userMessage } from '../../../../api/errors.js';
import { useStore } from '../../../../state/store.js';
import { managerName } from '@luady/shared';

export const HELD_WORDS = `${managerName()} is signed out. He gets it when he is back.`;

/**
 * A short message to Luady with a card or a note attached (`about`): he receives the item as data in front of
 * the owner's own words. The reply shows in the chat and above Luady.
 */
export function AskLuady({ about, label, placeholder, initial = '', send = 'Send', onSent }: {
  about: AboutRef; label: string; placeholder: string; initial?: string; send?: string; onSent?: () => void;
}) {
  const api = useApi();
  const { toast } = useStore();
  const id = useId();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const words = text.trim();
    if (words === '') {
      setError(`Write a few words for ${managerName()} first.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.sendToLuady({ text: words, about });
      setText('');
      toast(result.held === true ? 'info' : 'success', result.held === true ? HELD_WORDS : `Sent to ${managerName()}. His answer shows in the chat.`);
      onSent?.();
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ask-luady" onSubmit={(event) => void submit(event)}>
      <label htmlFor={id} className="ask-luady__label">{label}</label>
      <div className="ask-luady__row">
        <textarea id={id} className="ask-luady__input" rows={2} dir="auto" value={text} placeholder={placeholder} maxLength={4000}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void submit(event);
          }} />
        <button type="submit" className="paper-btn paper-btn--ink" disabled={busy}>{busy ? 'Sending…' : send}</button>
      </div>
      {error === null ? null : <p className="ask-luady__error" role="alert">{error}</p>}
    </form>
  );
}

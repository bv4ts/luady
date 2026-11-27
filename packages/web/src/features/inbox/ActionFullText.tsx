import { FULL_TEXT_ACTION_KINDS, type ActionDTO } from '@luady/shared';
import { useState } from 'react';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';

type FullText = { readonly state: 'closed' } | { readonly state: 'loading' } | { readonly state: 'open'; readonly text: string }
  | { readonly state: 'error'; readonly message: string };

/**
 * A confirmation's summary shows only the first lines of what a session would get (or a file would hold): this opens the
 * whole text, with every hidden character marked by the hub. The summary's SHA-256 is of the text as stored, before
 * that marking and before carriage returns become line breaks: it matches this text only when it holds neither.
 */
export function ActionFullText({ action }: { action: ActionDTO }) {
  const api = useApi();
  const [view, setView] = useState<FullText>({ state: 'closed' });
  if (!FULL_TEXT_ACTION_KINDS.includes(action.kind)) return null;

  async function open() {
    setView({ state: 'loading' });
    try {
      const { text } = await api.actionText(action.id);
      setView({ state: 'open', text: text ?? '' });
    } catch (err) {
      setView({ state: 'error', message: userMessage(err) });
    }
  }

  if (view.state === 'open') {
    return (
      <div className="stack">
        <pre className="qcard__fulltext" dir="auto" data-testid="action-full-text">{view.text}</pre>
        <Button variant="ghost" onClick={() => setView({ state: 'closed' })}>Hide the full text</Button>
      </div>
    );
  }
  return (
    <div className="stack">
      {view.state === 'error' ? <Banner tone="error">{view.message}</Banner> : null}
      <Button variant="ghost" busy={view.state === 'loading'} onClick={() => void open()} data-testid="action-full-text-button">
        Show the full text
      </Button>
    </div>
  );
}

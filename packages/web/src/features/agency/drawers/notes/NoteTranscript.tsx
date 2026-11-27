import { useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { userMessage } from '../../../../api/errors.js';

interface Parts {
  readonly text: string;
  readonly next: number | null;
}

/** "Show transcript" for a meeting: read live from Wispr Flow in parts, one more part per press. */
export function NoteTranscript({ noteId }: { noteId: string }) {
  const api = useApi();
  const [parts, setParts] = useState<Parts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (start: number) => {
    setBusy(true);
    setError(null);
    try {
      const part = await api.noteTranscript(noteId, start);
      setParts((prev) => ({ text: `${prev?.text ?? ''}${part.text}`, next: part.nextStart }));
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (parts === null) {
    return (
      <div className="note-sheet__transcript">
        <button type="button" className="paper-btn" disabled={busy} onClick={() => void load(0)}>{busy ? 'Loading…' : 'Show transcript'}</button>
        {error === null ? null : <p className="paper-card__error" role="alert">{error}</p>}
      </div>
    );
  }
  return (
    <section className="note-sheet__transcript" aria-label="Transcript">
      <h4>Transcript</h4>
      {parts.text.trim() === '' ? <p className="card-sheet__quiet">Wispr Flow has no transcript for this meeting.</p> : (
        <pre className="note-sheet__transcript-text" dir="auto">{parts.text}</pre>
      )}
      {error === null ? null : <p className="paper-card__error" role="alert">{error}</p>}
      {parts.next === null ? null : (
        <button type="button" className="paper-btn paper-btn--small" disabled={busy} onClick={() => void load(parts.next ?? 0)}>
          {busy ? 'Loading…' : 'Show more'}
        </button>
      )}
    </section>
  );
}

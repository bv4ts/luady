import { LIMITS, type NoteDTO, managerName } from '@luady/shared';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { userMessage } from '../../../../api/errors.js';
import { useStore } from '../../../../state/store.js';
import { newNoteBody } from './note-text.js';

/**
 * A new note (paste or type; title and project optional) with Save and Send to Luady, or a typed note edited
 * (Save only). Calls `onSaved` with the note the hub answered.
 */
export function NoteEditor({ note, onSaved, onCancel }: { note?: NoteDTO; onSaved: (note: NoteDTO) => void; onCancel: () => void }) {
  const api = useApi();
  const { toast } = useStore();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState(note?.title ?? '');
  const [project, setProject] = useState(note?.project ?? '');
  const [body, setBody] = useState(note?.summary ?? '');
  const [busy, setBusy] = useState<'save' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  const save = async (discuss: boolean) => {
    const request = newNoteBody({ title, project, body }, discuss);
    if (typeof request === 'string') {
      setError(request);
      return;
    }
    setBusy(discuss ? 'send' : 'save');
    setError(null);
    try {
      const saved = note === undefined
        ? await api.createNote(request)
        : await api.updateNote(note.id, { body: request.body, title: request.title ?? '', project: request.project ?? null });
      toast('success', discuss ? `Saved and sent to ${managerName()}. His answer shows here and in the chat.` : 'Note saved.');
      onSaved(saved);
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className="note-sheet note-editor" aria-label={note === undefined ? 'New note' : 'Edit note'}
      onSubmit={(event) => { event.preventDefault(); void save(false); }}>
      <span className="paper-card__pin card-sheet__pin" aria-hidden="true" />
      <div className="note-editor__meta">
        <label className="paper-field">
          <span>Title (optional)</span>
          <input className="paper-input" dir="auto" maxLength={LIMITS.noteTitleMax} value={title} placeholder="Stand-up, Monday"
            onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="paper-field">
          <span>Project (optional)</span>
          <input className="paper-input" dir="auto" maxLength={LIMITS.noteProjectMax} value={project} placeholder="orchard-web"
            onChange={(event) => setProject(event.target.value)} />
        </label>
      </div>
      <label className="paper-field note-editor__body">
        <span>Note</span>
        <textarea ref={bodyRef} className="paper-input note-editor__text" dir="auto" maxLength={LIMITS.noteBodyMax} value={body}
          placeholder={`Paste a stand-up summary or type what happened. ${managerName()} can read it and put the to-dos on the board.`}
          onChange={(event) => setBody(event.target.value)} />
      </label>
      {error === null ? null : <p className="paper-card__error" role="alert">{error}</p>}
      <div className="paper-card__buttons">
        <button type="button" className="paper-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="paper-btn" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        {note === undefined ? (
          <button type="button" className="paper-btn paper-btn--ink" disabled={busy !== null} onClick={() => void save(true)}>
            {busy === 'send' ? 'Sending…' : `Send to ${managerName()}`}
          </button>
        ) : null}
      </div>
    </form>
  );
}

import { LIMITS, type LibraryProjectDTO } from '@luady/shared';
import { useId, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { userMessage } from '../../../../api/errors.js';
import { useStore } from '../../../../state/store.js';
import { suggestName, validateNewSession, type NewSessionErrors } from '../../../sessions/new-session.js';
import { LIBRARY_NOT_READY, libraryError } from './library-error.js';

/** "New session here": a name (the folder's by default) and an optional first prompt; the folder is the project's. */
export function NewSessionForm({ project, onDone }: { project: LibraryProjectDTO; onDone: () => void }) {
  const api = useApi();
  const { toast } = useStore();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [errors, setErrors] = useState<NewSessionErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  async function submit() {
    const checked = validateNewSession({ server: project.server, cwd: project.path, name, prompt });
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setFailure(null);
    setBusy(true);
    try {
      const action = await api.createSession(checked.body);
      if (action.status === 'failed') {
        setFailure(action.error ?? 'The session did not start.');
        return;
      }
      toast('success', `Starting ${checked.body.name ?? suggestName(checked.body.cwd)} in ${project.name}.`);
      onDone();
    } catch (err) {
      setFailure(userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="lib-form" aria-label="New session here" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="lib-form__label" htmlFor={`${id}-name`}>Name</label>
      <input id={`${id}-name`} className="lib-input" value={name} placeholder={suggestName(project.path)} maxLength={64}
        autoComplete="off" spellCheck={false} aria-invalid={errors.name === undefined ? undefined : true} onChange={(event) => setName(event.target.value)} />
      {errors.name === undefined ? null : <p className="lib-form__error" role="alert">{errors.name}</p>}
      <label className="lib-form__label" htmlFor={`${id}-prompt`}>First prompt <span className="lib-form__opt">(optional)</span></label>
      <textarea id={`${id}-prompt`} className="lib-input lib-input--area" rows={3} dir="auto" value={prompt}
        placeholder="What should it start on?" onChange={(event) => setPrompt(event.target.value)} />
      {errors.prompt === undefined && errors.cwd === undefined ? null : <p className="lib-form__error" role="alert">{errors.prompt ?? errors.cwd}</p>}
      {failure === null ? null : <p className="lib-form__error" role="alert">{failure}</p>}
      <div className="lib-form__row">
        <button type="submit" className="lib-btn lib-btn--brass" disabled={busy}>{busy ? 'Starting…' : 'Start session'}</button>
        <button type="button" className="lib-btn lib-btn--quiet" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

/** "Add a card": a card on the board for this project and its office. */
export function AddCardForm({ project, onDone }: { project: LibraryProjectDTO; onDone: () => void }) {
  const api = useApi();
  const { toast } = useStore();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  async function submit() {
    const text = title.trim();
    if (text === '') {
      setError('Write what needs doing.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const card = await api.createCard({ title: text, project: project.name, server: project.server });
      toast('success', `Added #${String(card.id)} to the board.`);
      onDone();
    } catch (err) {
      setError(libraryError(err) === LIBRARY_NOT_READY ? 'The board needs the next hub update.' : userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="lib-form" aria-label="Add a card" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="lib-form__label" htmlFor={`${id}-title`}>What needs doing</label>
      <input id={`${id}-title`} className="lib-input" dir="auto" value={title} maxLength={LIMITS.boardTitleMax}
        aria-invalid={error === null ? undefined : true} onChange={(event) => setTitle(event.target.value)} />
      {error === null ? null : <p className="lib-form__error" role="alert">{error}</p>}
      <div className="lib-form__row">
        <button type="submit" className="lib-btn lib-btn--brass" disabled={busy}>{busy ? 'Adding…' : 'Add to board'}</button>
        <button type="button" className="lib-btn lib-btn--quiet" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

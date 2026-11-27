import { LIMITS, type LinkDTO } from '@luady/shared';
import { useId, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { userMessage } from '../../../../api/errors.js';
import { useStore } from '../../../../state/store.js';
import { checkUrl, labelError, moveLink } from './links-model.js';

/** Adds a link to an office's shelf: a short name and an https:// address. */
export function LinkForm({ server, onAdded }: { server: string; onAdded: () => void }) {
  const api = useApi();
  const id = useId();
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    const checked = checkUrl(url);
    const problem = labelError(label) ?? ('error' in checked ? checked.error : null);
    if (problem !== null || !('url' in checked)) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api.createLink({ server, label: label.trim(), url: checked.url });
      setLabel('');
      setUrl('');
      onAdded();
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="pin-form" aria-label="Add a link" noValidate onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <label className="pin-form__field" htmlFor={`${id}-label`}>Name</label>
      <input id={`${id}-label`} className="paper-input" dir="auto" maxLength={LIMITS.linkLabelMax} placeholder="Staging" value={label}
        onChange={(event) => setLabel(event.target.value)} />
      <label className="pin-form__field" htmlFor={`${id}-url`}>Address</label>
      <input id={`${id}-url`} className="paper-input" type="url" inputMode="url" spellCheck={false} placeholder="https://staging.example.com"
        maxLength={LIMITS.linkUrlMax} value={url} onChange={(event) => setUrl(event.target.value)} />
      {error === null ? null : <p className="pin-form__error" role="alert">{error}</p>}
      <button type="submit" className="paper-btn paper-btn--ink" disabled={busy}>{busy ? 'Pinning…' : 'Pin it'}</button>
    </form>
  );
}

/** One link in edit mode: rename, change the address, move up or down, remove after a confirm. */
export function LinkCardEditor({ link, shelf, first, last, onChanged }: {
  link: LinkDTO; shelf: readonly LinkDTO[]; first: boolean; last: boolean; onChanged: () => void;
}) {
  const api = useApi();
  const { toast } = useStore();
  const [label, setLabel] = useState(link.label);
  const [url, setUrl] = useState(link.url);
  const [error, setError] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const changed = label.trim() !== link.label || url.trim() !== link.url;

  async function run(op: () => Promise<unknown>) {
    setBusy(true);
    try {
      await op();
      setError(null);
      onChanged();
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const save = () => {
    const checked = checkUrl(url);
    const problem = labelError(label) ?? ('error' in checked ? checked.error : null);
    if (problem !== null || !('url' in checked)) {
      setError(problem);
      return;
    }
    void run(() => api.updateLink(link.id, {
      ...(label.trim() === link.label ? {} : { label: label.trim() }),
      ...(checked.url === link.url ? {} : { url: checked.url }),
    }));
  };
  const move = (direction: -1 | 1) => void run(async () => {
    for (const change of moveLink(shelf, link.id, direction)) await api.updateLink(change.id, { position: change.position });
  });
  const remove = () => void run(async () => {
    await api.deleteLink(link.id);
    toast('success', `Removed ${link.label}.`);
  });

  return (
    <div className="pin-card pin-card--edit" role="group" aria-label={`Edit ${link.label}`}>
      <span className="pin-card__pin" aria-hidden="true" />
      <input className="paper-input paper-input--small" aria-label="Name" dir="auto" maxLength={LIMITS.linkLabelMax} value={label} onChange={(event) => setLabel(event.target.value)} />
      <input className="paper-input paper-input--small" aria-label="Address" type="url" spellCheck={false} maxLength={LIMITS.linkUrlMax} value={url} onChange={(event) => setUrl(event.target.value)} />
      {error === null ? null : <p className="pin-form__error" role="alert">{error}</p>}
      <div className="pin-card__tools">
        <button type="button" className="paper-btn paper-btn--small" aria-label={`Move ${link.label} up`} disabled={busy || first} onClick={() => move(-1)}>↑</button>
        <button type="button" className="paper-btn paper-btn--small" aria-label={`Move ${link.label} down`} disabled={busy || last} onClick={() => move(1)}>↓</button>
        {changed ? <button type="button" className="paper-btn paper-btn--small paper-btn--ink" disabled={busy} onClick={save}>Save</button> : null}
        {sure ? (
          <>
            <button type="button" className="paper-btn paper-btn--small" onClick={() => setSure(false)}>Keep</button>
            <button type="button" className="paper-btn paper-btn--small paper-btn--danger" disabled={busy} onClick={remove}>Remove</button>
          </>
        ) : <button type="button" className="paper-btn paper-btn--small paper-btn--danger-quiet" aria-label={`Remove ${link.label}`} onClick={() => setSure(true)}>Remove…</button>}
      </div>
    </div>
  );
}

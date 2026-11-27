import type { JiraSiteDTO } from '@luady/shared';
import { useId, useRef, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { mustPin, usePin } from '../../../../pin/PinProvider.js';
import { useStore } from '../../../../state/store.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { ATLASSIAN_TOKEN_PAGE, checkConnect, jiraErrorText, type ConnectErrors } from './jira-model.js';
import { managerName } from '@luady/shared';

export interface ConnectFormProps {
  readonly server: string;
  /** The office's current connection when the owner signs in again (its site and e-mail fill the form). */
  readonly again: JiraSiteDTO | null;
  readonly onConnected: (site: JiraSiteDTO) => void;
  readonly onCancel?: () => void;
}

/**
 * Connects an office to Jira: site, e-mail and API token, then the PIN. The token field is a password
 * field that React does not hold: its value is read once on submit, sent only in the request body, and the field
 * is emptied when the request ends, whatever the answer.
 */
export function ConnectForm({ server, again, onConnected, onCancel }: ConnectFormProps) {
  const api = useApi();
  const { runPinned } = usePin();
  const { toast } = useStore();
  const [site, setSite] = useState(again?.baseUrl ?? '');
  const [email, setEmail] = useState(again?.email ?? '');
  const [errors, setErrors] = useState<ConnectErrors>({});
  const [failure, setFailure] = useState<string | null>(again?.lastError ?? null);
  const [busy, setBusy] = useState(false);
  const tokenRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const name = useRooms().roomName(server);

  const clearToken = () => {
    if (tokenRef.current !== null) tokenRef.current.value = '';
  };

  async function submit() {
    const checked = checkConnect({ site, email, token: tokenRef.current?.value ?? '' });
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setFailure(null);
    setSite(checked.baseUrl);
    setBusy(true);
    try {
      const connected = await runPinned(
        (pin) => api.connectJira(server, { baseUrl: checked.baseUrl, email: checked.email, token: checked.token, pin: mustPin(pin) }),
        { require: true, title: `Connect Jira to ${name}`, detail: checked.baseUrl },
      );
      if (connected === null) return;
      toast('success', `Jira is connected to ${name}.`);
      onConnected(connected);
    } catch (err) {
      setFailure(jiraErrorText(err));
    } finally {
      clearToken();
      setBusy(false);
    }
  }

  return (
    <form className="jira-connect" aria-label={`Connect Jira to ${name}`} noValidate autoComplete="off"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="jira-connect__intro">
        <h3 className="jira-connect__title">{again === null ? `Connect ${name} to Jira` : `Sign in to Jira again for ${name}`}</h3>
        <p>
          See the tickets assigned to you, move them, comment, and hand them to a session without opening Jira. {managerName()} only reads
          tickets; he writes to Jira only when you ask him to.
        </p>
      </div>
      <label className="jira-form__label" htmlFor={`${id}-site`}>Jira address</label>
      <input id={`${id}-site`} className="jira-input" type="url" inputMode="url" placeholder="https://name.atlassian.net" value={site}
        spellCheck={false} autoCapitalize="off" aria-invalid={errors.site === undefined ? undefined : true}
        aria-describedby={errors.site === undefined ? undefined : `${id}-site-error`} onChange={(event) => setSite(event.target.value)} />
      {errors.site === undefined ? null : <p id={`${id}-site-error`} className="jira-form__error" role="alert">{errors.site}</p>}

      <label className="jira-form__label" htmlFor={`${id}-email`}>E-mail you sign in with</label>
      <input id={`${id}-email`} className="jira-input" type="email" inputMode="email" value={email} spellCheck={false} autoCapitalize="off"
        aria-invalid={errors.email === undefined ? undefined : true} onChange={(event) => setEmail(event.target.value)} />
      {errors.email === undefined ? null : <p className="jira-form__error" role="alert">{errors.email}</p>}

      <label className="jira-form__label" htmlFor={`${id}-token`}>API token</label>
      <input ref={tokenRef} id={`${id}-token`} className="jira-input" type="password" autoComplete="new-password" spellCheck={false}
        autoCapitalize="off" maxLength={600} aria-invalid={errors.token === undefined ? undefined : true} data-testid="jira-token" />
      {errors.token === undefined ? null : <p className="jira-form__error" role="alert">{errors.token}</p>}
      <p className="jira-form__hint">
        Make one on <a href={ATLASSIAN_TOKEN_PAGE} target="_blank" rel="noopener noreferrer">Atlassian's API token page</a>, then paste it here.
        It is checked with Jira, stored sealed on the hub and never shown again. Your PIN is asked next.
      </p>
      {failure === null ? null : <p className="jira-form__failure" role="alert">{failure}</p>}
      <div className="jira-form__row">
        <button type="submit" className="jira-btn jira-btn--primary" disabled={busy}>{busy ? 'Checking with Jira…' : 'Connect'}</button>
        {onCancel === undefined ? null : <button type="button" className="jira-btn jira-btn--quiet" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

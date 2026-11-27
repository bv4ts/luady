import type { AccountDTO, CodexLoginDTO } from '@luady/shared';
import { useState } from 'react';
import { useApi } from '../../../api/context.js';
import { userMessage } from '../../../api/errors.js';
import { Button } from '../../../ui/Button.js';
import { linkLabel } from './LoginFlow.js';
import { SignOutButton } from './SignOutButton.js';
import { managerName } from '@luady/shared';

const STATE_WORDS = { true: 'Connected', false: 'Not connected', null: 'Not checked yet' } as const;

/** The ChatGPT sign-in on Luady's server (it makes pictures): connect with a device code, or disconnect. */
export function CodexCard({ account }: { account: AccountDTO }) {
  const api = useApi();
  const [device, setDevice] = useState<CodexLoginDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loggedIn = account.hosts[0]?.loggedIn ?? null;

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      setDevice(await api.codexLogin());
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="acct acct--codex" aria-label="ChatGPT (pictures)">
      <header className="acct__head">
        <h3 className="acct__title">ChatGPT (pictures)</h3>
        <span className="acct__state">{STATE_WORDS[String(loggedIn) as keyof typeof STATE_WORDS]}</span>
      </header>
      {/* The hub's own line, such as a sign-in made before a release that moved it, which must be made again. */}
      {account.note === undefined ? null : <p className="acct__note" data-testid="codex-note">{account.note}</p>}
      <div className="acct-host__actions">
        {loggedIn === true ? null : <Button size="sm" variant="primary" icon="key" busy={busy} onClick={() => void connect()}>Connect</Button>}
        {loggedIn === false ? null : (
          <SignOutButton label="Disconnect" call={(pin) => api.logoutAccount('codex', { pin })}
            words={{
              title: 'Disconnect ChatGPT?', body: `${managerName()} cannot make pictures until you connect it again.`, pinTitle: 'Disconnect ChatGPT',
              done: 'Disconnected ChatGPT.',
            }} />
        )}
      </div>
      {device === null ? null : (
        <div className="acct-login">
          <a className="acct-login__link mono" href={device.url} target="_blank" rel="noopener noreferrer">{linkLabel(device.url)}</a>
          <p>Enter this code on that page</p>
          <p className="acct-login__code mono">{device.code}</p>
        </div>
      )}
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    </article>
  );
}

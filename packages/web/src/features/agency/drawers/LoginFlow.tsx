import type { HostId, LoginStartDTO } from '@luady/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../../api/context.js';
import { isApiError, userMessage } from '../../../api/errors.js';
import { usePin } from '../../../pin/PinProvider.js';
import { Button } from '../../../ui/Button.js';
import { hostName, whenText } from './account-text.js';
import { managerName } from '@luady/shared';

type Stage =
  | { readonly kind: 'starting' }
  | { readonly kind: 'ready'; readonly start: LoginStartDTO; readonly message: string | null }
  | { readonly kind: 'done'; readonly text: string }
  | { readonly kind: 'failed'; readonly message: string };

/** The link without its query (the query carries the sign-in state; it stays in the href only). */
export function linkLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** What the flow says when the owner closed the PIN prompt of a sign-in start. */
export const NOT_STARTED = 'Sign-in not started.';

function codeError(err: unknown): string {
  return isApiError(err, 'invalid_request') ? 'That code looks too short. Copy the whole code and try again.' : userMessage(err);
}

/**
 * A Claude sign-in from the website: the hub hands out a link, the owner signs in there and pastes the code back.
 * The code lives only in this field's state until it is sent; the field is emptied after every attempt.
 */
export function LoginFlow({ host, name = hostName(host) }: {
  host: HostId;
  /** The host as the owner knows it (never the manager's own id); the manager's name or the id by default. */
  name?: string;
}) {
  const api = useApi();
  const { runPinned } = usePin();
  const nameRef = useRef(name);
  const [stage, setStage] = useState<Stage>({ kind: 'starting' });
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const inputId = useId();

  useEffect(() => {
    let live = true;
    // Sent without a PIN first; a host that is signed in may need one (428 pin_required), then the PIN prompt opens.
    const start = (pin: string | undefined) => (pin === undefined ? api.loginAccount(host) : api.loginAccount(host, { pin }));
    // The name read once: a room renamed meanwhile must not restart the sign-in.
    runPinned(start, { require: false, title: `Sign in ${nameRef.current} again`, detail: 'A new sign-in can move this server to another account.' }).then(
      (started) => {
        if (live) setStage(started === null ? { kind: 'failed', message: NOT_STARTED } : { kind: 'ready', start: started, message: null });
      },
      (err: unknown) => { if (live) setStage({ kind: 'failed', message: userMessage(err) }); },
    );
    return () => { live = false; };
  }, [api, host, runPinned]);

  async function send(start: LoginStartDTO) {
    const value = code.trim();
    setCode('');
    if (value === '') return;
    setSending(true);
    try {
      const result = await api.submitLoginCode(host, { code: value });
      if (!result.ok) setStage({ kind: 'ready', start, message: result.message });
      else {
        const until = result.expiresAt === null ? 'Signed in.' : `Signed in until ${whenText(result.expiresAt, new Date())}.`;
        setStage({ kind: 'done', text: result.brainRestarted ? `${until} ${managerName()} is restarting.` : until });
      }
    } catch (err) {
      setStage({ kind: 'ready', start, message: codeError(err) });
    } finally {
      setSending(false);
    }
  }

  if (stage.kind === 'starting') return <p className="acct-login__note" role="status">Asking {name} for a sign-in link…</p>;
  if (stage.kind === 'failed') return <p className="acct-login__note form-error" role="alert">{stage.message}</p>;
  if (stage.kind === 'done') return <p className="acct-login__note acct-login__note--ok" role="status">{stage.text}</p>;
  const { start } = stage;
  return (
    <form className="acct-login" onSubmit={(event) => { event.preventDefault(); void send(start); }}>
      <ol className="acct-login__steps">
        <li>
          <span>Open the link and sign in</span>
          <a className="acct-login__link mono" href={start.url} target="_blank" rel="noopener noreferrer">{linkLabel(start.url)}</a>
        </li>
        <li>
          <label htmlFor={inputId}>Paste the code it shows</label>
          <span className="acct-login__row">
            <input id={inputId} className="input acct-login__input" type="text" autoComplete="off" autoCapitalize="off" spellCheck={false}
              maxLength={1100} data-testid="account-code-input" value={code} disabled={sending} onChange={(event) => setCode(event.target.value)} />
            <Button type="submit" size="sm" variant="primary" busy={sending} disabled={code.trim() === ''} data-testid="account-code-submit">Send code</Button>
          </span>
        </li>
      </ol>
      {stage.message === null ? null : <p className="form-error" role="alert">{stage.message}</p>}
    </form>
  );
}

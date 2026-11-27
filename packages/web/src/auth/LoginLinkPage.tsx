import { PIN_RE } from '@luady/shared';
import { useEffect, useRef, useState } from 'react';
import { isApiError } from '../api/errors.js';
import type { SetupApi } from '../api/setup.js';
import { pinDigits } from '../lib/digits.js';
import { ownerTime } from '../lib/format.js';
import { Banner } from '../ui/Banner.js';
import { BrandMark } from '../ui/BrandMark.js';
import { Button } from '../ui/Button.js';
import { TextField } from '../ui/Field.js';
import { dropLinkToken } from './link-token.js';
import { signInMessage } from './messages.js';
import { keepPageKey } from './page-key.js';
import './auth.css';

const RUN_AGAIN = 'In the terminal where Luady runs, type npm run luady -- login for a new link; each link lasts 5 minutes.';

/** What a refused sign-in says, with what to do next; `dead` when the link can never work again, `askPin` when the hub wants the PIN. */
export function linkErrorText(err: unknown): { text: string; dead: boolean; askPin: boolean } {
  if (isApiError(err) && err.status === 401) return { text: `This login link has expired or was already used. ${RUN_AGAIN}`, dead: true, askPin: false };
  // The page did not know a PIN is set; nothing was counted.
  if (isApiError(err, 'pin_required')) return { text: 'Enter your PIN to finish signing in.', dead: false, askPin: true };
  if (isApiError(err, 'pin_invalid')) {
    const left = err.details.remaining ?? 0;
    const text = left > 0 ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before PIN entry pauses.` : 'Wrong PIN. PIN entry is paused for a while: wait, then try again.';
    return { text, dead: false, askPin: true };
  }
  if (isApiError(err, 'pin_locked')) {
    const until = ownerTime(err.details.until ?? null);
    return { text: `Too many wrong PINs. Try again${until === null ? ' later' : ` after ${until}`}.`, dead: false, askPin: true };
  }
  // The hub's refusal says why (a remote install, a proxy, another machine) and what to use instead.
  if (isApiError(err, 'forbidden')) return { text: err.message, dead: true, askPin: false };
  return { text: signInMessage(err), dead: false, askPin: false };
}

export interface LoginLinkPageProps {
  readonly api: SetupApi;
  /** The token taken from the address bar, or null when the page was opened without one. */
  readonly token: string | null;
  /** True once a PIN is set (the hub then asks for it); null when the hub did not say. */
  readonly pinNeeded: boolean | null;
  readonly onSignedIn: () => Promise<void>;
  /** The link was used or can never work: whoever holds the token forgets it. */
  readonly onTokenSpent: () => void;
}

/**
 * `/setup/login#<token>`: the link `luady login` prints. The token has already left the address bar.
 * With no PIN to type it is used at once, so an opened link does not stay live; once a PIN is set the owner types
 * it first. The page key from the answer is kept; the token is forgotten as soon as it is used or found dead.
 */
export function LoginLinkPage({ api, token, pinNeeded, onSignedIn, onTokenSpent }: LoginLinkPageProps) {
  const [pin, setPin] = useState('');
  const [askPin, setAskPin] = useState(pinNeeded === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState(token === null);
  const started = useRef(false);

  async function signIn(withPin: string | null) {
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      keepPageKey(await api.login(withPin === null ? { token } : { token, pin: withPin }));
      dropLinkToken();
      onTokenSpent();
      await onSignedIn();
    } catch (err) {
      setBusy(false);
      const refused = linkErrorText(err);
      setError(refused.text);
      if (refused.askPin) setAskPin(true);
      if (refused.dead) {
        dropLinkToken();
        onTokenSpent();
        setDead(true);
      }
    }
  }

  // No PIN to type: use the link at once, exactly once (a page shown twice in development must not spend it twice).
  useEffect(() => {
    if (started.current || token === null || pinNeeded === true) return;
    started.current = true;
    void signIn(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function submit() {
    if (!PIN_RE.test(pin)) {
      setError('Enter your PIN: 6 to 12 digits.');
      return;
    }
    void signIn(pin);
  }

  return (
    <main className="auth-page">
      <div className="auth-card" data-testid="login-link-page">
        <BrandMark size={48} />
        <div className="stack">
          <h1 className="auth-title">Sign in with a login link</h1>
          <p className="text-muted">This signs in the browser on the computer where Luady runs.</p>
        </div>
        {token === null ? <Banner tone="info">This page opens from a login link. {RUN_AGAIN}</Banner> : null}
        {error !== null ? <Banner tone="error">{error}</Banner> : null}
        {!dead && askPin ? (
          <form className="stack" noValidate onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <TextField label="Your PIN" type="password" inputMode="numeric" autoComplete="one-time-code" maxLength={12} value={pin}
              data-testid="login-link-pin" autoFocus onChange={(event) => setPin(pinDigits(event.target.value))} />
            <Button type="submit" variant="primary" className="btn--block" icon="key" busy={busy}
              data-testid="login-link-button">Sign in on this computer</Button>
          </form>
        ) : null}
        {!dead && !askPin && busy ? <p className="text-muted" role="status">Signing in…</p> : null}
        <a className="btn btn--ghost btn--block" href="/">Go to the sign-in page</a>
      </div>
    </main>
  );
}

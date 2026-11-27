import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type { SetupStateDTO } from '@luady/shared';
import { useState } from 'react';
import { useApi } from '../api/context.js';
import { isApiError } from '../api/errors.js';
import { Banner } from '../ui/Banner.js';
import { BrandMark } from '../ui/BrandMark.js';
import { Button } from '../ui/Button.js';
import { TextField } from '../ui/Field.js';
import { defaultPasskeyLabel, loginWithPasskey, passkeyErrorMessage, registerPasskey } from './passkeys.js';
import './auth.css';

/** Where a new setup code comes from, said the same way everywhere. */
export const NEW_CODE_HOW = 'Run npm run luady -- setup-code in the terminal where Luady runs for a new one.';
export const CODE_REJECTED = `That setup code is invalid or expired. ${NEW_CODE_HOW}`;
export const CODE_HINT = 'Printed in the terminal where Luady runs. It works once, for 30 minutes.';
const CLAIMED_NO_PASSKEY = 'This install has no passkey yet. Sign in with a login link (below), then add a passkey in Settings, under Security.';
const NO_PASSKEY_YET = 'No passkey is registered yet. Enter a setup code to create one: run npm run luady -- setup-code in the terminal where Luady runs.';

function SignIn({ disabled, onSignedIn, onNoPasskey }: { disabled: boolean; onSignedIn: () => Promise<void>; onNoPasskey: () => void }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await loginWithPasskey(api);
      await onSignedIn();
    } catch (err) {
      setBusy(false);
      // 409 from login/options means no passkey is registered yet.
      if (isApiError(err) && err.status === 409) onNoPasskey();
      else setError(passkeyErrorMessage(err));
    }
  }

  return (
    <section className="stack" aria-label="Sign in">
      {error ? <Banner tone="error">{error}</Banner> : null}
      <Button variant="primary" className="btn--block" icon="key" busy={busy} disabled={disabled}
        data-testid="login-passkey-button" onClick={() => void signIn()}>Sign in with passkey</Button>
    </section>
  );
}

export interface PasskeyClaimFormProps {
  readonly disabled: boolean;
  /** Called with the code that made the passkey: the first PIN needs the same code, kept in memory only. */
  readonly onRegistered: (setupCode: string) => Promise<void>;
  readonly submitLabel: string;
  /** A code the page already holds (typed earlier); the field is not shown then. */
  readonly knownCode?: string | null;
}

/** The first passkey, made with the setup code from the terminal. */
export function PasskeyClaimForm({ disabled, onRegistered, submitLabel, knownCode = null }: PasskeyClaimFormProps) {
  const api = useApi();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function register() {
    const setupCode = (knownCode ?? code).trim();
    if (setupCode.length < 8 || setupCode.length > 64) {
      setError(`Enter the setup code from the terminal (8 to 64 characters). ${NEW_CODE_HOW}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await registerPasskey(api, { setupCode }, label.trim() || defaultPasskeyLabel());
      await onRegistered(setupCode);
    } catch (err) {
      setBusy(false);
      if (isApiError(err) && err.status === 401) setError(CODE_REJECTED);
      else if (isApiError(err) && err.status === 409) setError('A passkey already exists. Sign in with it instead.');
      else setError(passkeyErrorMessage(err));
    }
  }

  return (
    <form className="stack" noValidate onSubmit={(event) => { event.preventDefault(); void register(); }}>
      {knownCode === null ? (
        <TextField label="Setup code" hint={CODE_HINT} className="input--mono" value={code} autoComplete="one-time-code"
          autoCapitalize="characters" spellCheck={false} data-testid="setup-code-input" onChange={(event) => setCode(event.target.value)} />
      ) : null}
      <TextField label="Device name (optional)" placeholder={defaultPasskeyLabel()} value={label} maxLength={64}
        onChange={(event) => setLabel(event.target.value)} />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <Button type="submit" variant="primary" className="btn--block" icon="key" busy={busy} disabled={disabled}
        data-testid="setup-passkey-button">{submitLabel}</Button>
    </form>
  );
}

/** How to sign in without a passkey: `npm run luady -- login`; never offered on a remote install. */
export function LoginLinkHelp({ remote }: { remote: boolean }) {
  if (remote) {
    return (
      <p className="text-muted" data-testid="login-link-off">
        Login links are off because this hub can be reached from other machines. A passkey is required here.
      </p>
    );
  }
  return (
    <div className="stack" data-testid="login-link-help">
      <p>
        In the terminal where Luady runs, type <code>npm run luady -- login</code>. It prints a link that works once, for 5 minutes,
        on this computer only. Open it in this browser.
      </p>
    </div>
  );
}

function FirstRun({ disabled, highlight, onRegistered }: {
  disabled: boolean; highlight: boolean; onRegistered: (setupCode: string) => Promise<void>;
}) {
  return (
    <section className={highlight ? 'auth-section auth-section--highlight' : 'auth-section'} aria-labelledby="first-run-title">
      <h2 id="first-run-title" className="section-title">First passkey for this install?</h2>
      {highlight ? <Banner tone="info">{NO_PASSKEY_YET}</Banner> : null}
      <PasskeyClaimForm disabled={disabled} onRegistered={onRegistered} submitLabel="Set up with a passkey" />
    </section>
  );
}

export interface SignedOutPageProps {
  readonly onSignedIn: () => Promise<void>;
  readonly onRegistered: (setupCode: string) => Promise<void>;
  /** The setup state when the hub gave it: the login-link help is shown when the install is not remote, and the first-passkey form only after the hub says there is none. */
  readonly setup?: SetupStateDTO | null;
}

/** Sign-in for an install that has an owner (or whose setup state is unknown: then the first-passkey form is shown too). */
export function SignedOutPage({ onSignedIn, onRegistered, setup = null }: SignedOutPageProps) {
  const supported = browserSupportsWebAuthn();
  const [noPasskeyYet, setNoPasskeyYet] = useState(false);
  const linkWay = setup !== null && !setup.remote;
  return (
    <main className="auth-page">
      <div className="auth-card">
        <BrandMark size={52} />
        <div className="stack">
          <h1 className="auth-title">Welcome to Luady</h1>
          <p className="text-muted">Your Claude Code sessions, in one office. Sign in with this device's passkey.</p>
        </div>
        {!supported ? (
          <Banner tone="warn">
            {linkWay ? "This browser can't use passkeys. Use a login link instead (below)." : "This browser can't use passkeys. Open Luady in Chrome, Edge or Firefox."}
          </Banner>
        ) : null}
        <SignIn disabled={!supported} onSignedIn={onSignedIn} onNoPasskey={() => setNoPasskeyYet(true)} />
        {setup !== null ? (
          <section className="auth-section" aria-labelledby="link-title">
            <h2 id="link-title" className="section-title">No passkey on this device?</h2>
            <LoginLinkHelp remote={setup.remote} />
          </section>
        ) : null}
        {/* A claimed install takes no setup code for a passkey: its owner signs in with a link and adds one in Settings. */}
        {setup !== null && noPasskeyYet ? <Banner tone="info">{CLAIMED_NO_PASSKEY}</Banner> : null}
        {setup === null ? <FirstRun disabled={!supported} highlight={noPasskeyYet} onRegistered={onRegistered} /> : null}
      </div>
    </main>
  );
}

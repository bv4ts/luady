import { PIN_RE } from '@luady/shared';
import { useState } from 'react';
import { useApi } from '../api/context.js';
import { isApiError } from '../api/errors.js';
import { browserZone } from '../lib/browser-zone.js';
import { pinDigits } from '../lib/digits.js';
import { BrandMark } from '../ui/BrandMark.js';
import { Button } from '../ui/Button.js';
import { TextField } from '../ui/Field.js';
import { signInMessage } from './messages.js';
import { CODE_HINT, CODE_REJECTED, NEW_CODE_HOW } from './SignedOutPage.js';
import './auth.css';

export interface PinSetupProps {
  /** The code the gate remembers in memory; null means "ask for it". */
  readonly setupCode: string | null;
  readonly onDone: () => Promise<void>;
  readonly onCodeRejected: () => void;
}

/** What the PIN is for, in one sentence. */
export const PIN_PURPOSE = 'Luady asks for this PIN before anything risky: stopping a session, changing a file, adding a server.';

function usePinSetup({ setupCode, onDone, onCodeRejected }: PinSetupProps) {
  const api = useApi();
  const [typedCode, setTypedCode] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const code = (setupCode ?? typedCode).trim();
    if (code.length < 8 || code.length > 64) return setError(`Enter the setup code from the terminal (8 to 64 characters). ${NEW_CODE_HOW}`);
    if (!PIN_RE.test(pin)) return setError('Use 6 to 12 digits for the PIN.');
    if (pin !== again) return setError('The two PINs do not match.');
    setBusy(true);
    setError(null);
    try {
      // The claim: the hub keeps this browser's zone as the owner's when none is set yet.
      const zone = browserZone();
      await api.setPin({ newPin: pin, setupCode: code, ...(zone === null ? {} : { timeZone: zone }) });
      await onDone();
    } catch (err) {
      setBusy(false);
      if (isApiError(err) && err.status === 401) {
        setTypedCode('');
        onCodeRejected();
        setError(CODE_REJECTED);
      } else {
        setError(signInMessage(err));
      }
    }
  }

  return { typedCode, setTypedCode, pin, setPin, again, setAgain, busy, error, save };
}

/** The first PIN (with the setup code): used by the PIN page and by the setup wizard's PIN step. */
export function PinSetupForm(props: PinSetupProps) {
  const form = usePinSetup(props);
  return (
    <form className="stack" noValidate onSubmit={(event) => { event.preventDefault(); void form.save(); }}>
      {props.setupCode === null ? (
        <TextField label="Setup code" hint={CODE_HINT} className="input--mono" value={form.typedCode} autoComplete="one-time-code"
          autoCapitalize="characters" spellCheck={false} data-testid="setup-code-input" onChange={(event) => form.setTypedCode(event.target.value)} />
      ) : null}
      <TextField label="New PIN" hint="6 to 12 digits." type="password" inputMode="numeric" autoComplete="one-time-code"
        maxLength={12} value={form.pin} data-testid="pin-new-input" onChange={(event) => form.setPin(pinDigits(event.target.value))} />
      <TextField label="Repeat PIN" type="password" inputMode="numeric" autoComplete="one-time-code" maxLength={12}
        value={form.again} data-testid="pin-confirm-input" onChange={(event) => form.setAgain(pinDigits(event.target.value))} />
      {form.error ? <p className="form-error" role="alert">{form.error}</p> : null}
      <Button type="submit" variant="primary" icon="lock" className="btn--block" busy={form.busy}
        data-testid="pin-save-button">Save PIN</Button>
    </form>
  );
}

/** The PIN screen, shown by AuthGate while `me.pinSet` is false and the hub gave no setup state. */
export function PinSetupPage(props: PinSetupProps) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <BrandMark size={48} />
        <div className="stack">
          <h1 className="auth-title">Choose your PIN</h1>
          <p className="text-muted">{PIN_PURPOSE}</p>
        </div>
        <PinSetupForm {...props} />
      </div>
    </main>
  );
}

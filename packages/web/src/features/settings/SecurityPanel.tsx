import { PIN_RE } from '@luady/shared';
import { useState } from 'react';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { useAuth } from '../../auth/AuthContext.js';
import { pinDigits } from '../../lib/digits.js';
import { pinNotice } from '../../pin/pin-notice.js';
import { useStore } from '../../state/store.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { TextField } from '../../ui/Field.js';
import { PasskeysPanel } from './PasskeysPanel.js';

function ChangePin() {
  const api = useApi();
  const { toast } = useStore();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!PIN_RE.test(current) || !PIN_RE.test(next)) return setError('PINs have 6 to 12 digits.');
    if (next !== repeat) return setError('The new PINs do not match.');
    if (next === current) return setError('Choose a PIN that differs from the current one.');
    setBusy(true);
    setError(null);
    try {
      await api.setPin({ newPin: next, currentPin: current });
      setCurrent('');
      setNext('');
      setRepeat('');
      toast('success', 'PIN changed');
    } catch (err) {
      setError(pinNotice(err)?.message ?? userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const pinInput = { type: 'password', inputMode: 'numeric', maxLength: 12 } as const;
  return (
    <form className="stack" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <TextField label="Current PIN" autoComplete="one-time-code" {...pinInput} value={current} onChange={(event) => setCurrent(pinDigits(event.target.value))} />
      <TextField label="New PIN" autoComplete="one-time-code" {...pinInput} value={next} onChange={(event) => setNext(pinDigits(event.target.value))} />
      <TextField label="Repeat new PIN" autoComplete="one-time-code" {...pinInput} value={repeat} onChange={(event) => setRepeat(pinDigits(event.target.value))} />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="row"><Button type="submit" variant="secondary" icon="lock" busy={busy}>Change PIN</Button></div>
    </form>
  );
}

export function SecurityPanel() {
  const { me, logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
    }
  }

  // The gate renders the app only once a PIN exists, so ChangePin always applies here.
  return (
    <Card title="Security" subtitle={`Signed in as ${me.owner}`}>
      <div className="stack">
        <h3 className="section-title">PIN</h3>
        <ChangePin />
      </div>
      <PasskeysPanel />
      <div className="row">
        <Button variant="ghost" icon="logout" busy={signingOut} onClick={() => void signOut()} data-testid="logout-button">Sign out</Button>
      </div>
    </Card>
  );
}

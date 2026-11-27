import { useState } from 'react';
import type { PasskeyEntry } from '../../api/schemas.js';
import { defaultPasskeyLabel } from '../../auth/passkeys.js';
import { ownerDateTime } from '../../lib/format.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { TextField } from '../../ui/Field.js';
import { Spinner } from '../../ui/Spinner.js';
import { usePasskeys, type PasskeyBusy } from './usePasskeys.js';

interface PasskeyRowProps {
  readonly passkey: PasskeyEntry;
  readonly only: boolean;
  readonly busy: PasskeyBusy;
  readonly onDelete: (passkey: PasskeyEntry) => Promise<void>;
}

function PasskeyRow({ passkey, only, busy, onDelete }: PasskeyRowProps) {
  const [confirming, setConfirming] = useState(false);
  const deleting = busy?.kind === 'delete' && busy.id === passkey.id;
  const name = passkey.label || 'Unnamed passkey';
  const used = passkey.lastUsedAt ? `last used ${ownerDateTime(passkey.lastUsedAt)}` : 'never used';

  async function confirmDelete() {
    await onDelete(passkey);
    setConfirming(false);
  }

  return (
    <li className="passkey">
      <div className="passkey__main">
        <span className="passkey__name" dir="auto">{name}</span>
        <span className="passkey__meta">Added {ownerDateTime(passkey.createdAt)} · {used}</span>
      </div>
      {confirming ? (
        <div className="passkey__confirm" role="group" aria-label={`Confirm deleting ${name}`}>
          <span className="passkey__question">Delete this passkey?</span>
          <Button variant="ghost" size="sm" autoFocus disabled={deleting} onClick={() => setConfirming(false)}>Keep</Button>
          <Button variant="danger" size="sm" icon="lock" busy={deleting} onClick={() => void confirmDelete()}>Delete with PIN</Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" icon="trash" aria-label={`Delete passkey ${name}`} disabled={only || busy !== null}
          onClick={() => setConfirming(true)}>Delete</Button>
      )}
    </li>
  );
}

export function PasskeysPanel() {
  const { items, error, busy, add, remove } = usePasskeys();
  const [label, setLabel] = useState(() => defaultPasskeyLabel());
  const only = items?.length === 1;

  return (
    <div className="stack">
      <h3 className="section-title">Passkeys</h3>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {items === null && !error ? <Spinner label="Loading passkeys" /> : null}
      {items && items.length > 0 ? (
        <ul className="passkeys" aria-label="Registered passkeys">
          {items.map((passkey) => <PasskeyRow key={passkey.id} passkey={passkey} only={only} busy={busy} onDelete={remove} />)}
        </ul>
      ) : null}
      {only ? <p className="text-subtle">Add a second passkey before you can delete this one.</p> : null}
      <TextField label="Name for a new passkey" value={label} maxLength={64} onChange={(event) => setLabel(event.target.value)} />
      <div className="row">
        <Button variant="secondary" icon="key" busy={busy?.kind === 'add'} disabled={busy !== null} onClick={() => void add(label)}>
          Add a passkey on this device
        </Button>
      </div>
    </div>
  );
}

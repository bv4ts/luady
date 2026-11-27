import type { ActionDTO } from '@luady/shared';
import { useState } from 'react';
import { expiresIn } from '../../lib/actions.js';
import { channelLabel } from '../../lib/channels.js';
import { pinDigits } from '../../lib/digits.js';
import { Button } from '../../ui/Button.js';
import { TextField } from '../../ui/Field.js';
import { ActionFullText } from './ActionFullText.js';
import { CardHead } from './CardHead.js';
import { useConfirmation } from './useConfirmation.js';
import { managerName } from '@luady/shared';

export function ConfirmationCard({ action }: { action: ActionDTO }) {
  const { approve, deny, busy, error, locked } = useConfirmation(action);
  const [pin, setPin] = useState('');

  async function submit() {
    if (await approve(pin)) setPin('');
  }

  const who = action.actor === 'manager' ? managerName() : 'You';
  return (
    <article className="qcard qcard--action" aria-label={`Confirmation #${action.id}`}
      data-testid="action-card" data-action-id={action.id}>
      <CardHead kind="Needs your PIN" tone="accent" label={`${who} · via ${channelLabel(action.channel)}`}
        reference={action.id} createdAt={action.createdAt} />
      <p className="qcard__summary qcard__summary--lines" dir="auto">{action.summary}</p>
      <ActionFullText action={action} />
      <p className="text-subtle">{expiresIn(action.createdAt)}</p>
      <form className="qcard__approve" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <TextField label={`PIN for #${action.id}`} className="qcard__pin" type="password" inputMode="numeric"
          autoComplete="one-time-code" maxLength={12} value={pin} error={error} disabled={locked || busy !== null}
          data-testid="action-pin-input" onChange={(event) => setPin(pinDigits(event.target.value))} />
        <div className="qcard__actions">
          <Button type="submit" variant="primary" icon="lock" busy={busy === 'approve'} disabled={locked || busy !== null}
            data-testid="action-approve-button">Approve</Button>
          <Button variant="secondary" icon="x" busy={busy === 'deny'} disabled={busy !== null} onClick={() => void deny()}>Deny</Button>
        </div>
      </form>
    </article>
  );
}

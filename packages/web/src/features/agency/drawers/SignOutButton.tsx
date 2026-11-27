import type { ActionDTO } from '@luady/shared';
import { useState } from 'react';
import { userMessage } from '../../../api/errors.js';
import { describeAction } from '../../../lib/actions.js';
import { mustPin, usePin } from '../../../pin/PinProvider.js';
import { useStore } from '../../../state/store.js';
import { Button } from '../../../ui/Button.js';
import { Modal } from '../../../ui/Modal.js';

export interface SignOutWords {
  /** The confirmation's title (a question). */
  readonly title: string;
  readonly body: string;
  /** The PIN prompt's title. */
  readonly pinTitle: string;
  /** The toast once it is done. */
  readonly done: string;
}

/** "Log out": asks first in plain words, then for the PIN (a tier-1 action), and only then calls the hub. */
export function SignOutButton({ words, label, call }: {
  words: SignOutWords; label: string; call: (pin: string) => Promise<ActionDTO>;
}) {
  const { toast } = useStore();
  const { runPinned } = usePin();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setAsking(false);
    setBusy(true);
    try {
      const action = await runPinned((pin) => call(mustPin(pin)), { require: true, title: words.pinTitle });
      if (action !== null) {
        const outcome = action.status === 'done' ? { kind: 'success' as const, text: words.done } : describeAction(action);
        toast(outcome.kind, outcome.text);
      }
    } catch (err) {
      toast('error', userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" icon="logout" busy={busy} data-testid="account-logout" onClick={() => setAsking(true)}>{label}</Button>
      <Modal open={asking} title={words.title} onClose={() => setAsking(false)}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
            <Button variant="danger" icon="logout" onClick={() => void confirm()}>Sign out</Button>
          </>
        )}>
        <p>{words.body}</p>
      </Modal>
    </>
  );
}

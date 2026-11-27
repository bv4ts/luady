import { useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { mustPin, usePin } from '../../../../pin/PinProvider.js';
import { useStore } from '../../../../state/store.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { jiraErrorText } from './jira-model.js';

type Step = 'closed' | 'menu' | 'confirm';

/** The small "⋯" menu of a connected office: sign in again, or disconnect (asked first, then the PIN). */
export function JiraMenu({ server, onReconnect, onDisconnected }: {
  server: string; onReconnect: () => void; onDisconnected: () => void;
}) {
  const api = useApi();
  const { runPinned } = usePin();
  const { toast } = useStore();
  const [step, setStep] = useState<Step>('closed');
  const [busy, setBusy] = useState(false);
  const name = useRooms().roomName(server);

  async function disconnect() {
    setBusy(true);
    try {
      const done = await runPinned((pin) => api.disconnectJira(server, mustPin(pin)), { require: true, title: `Disconnect Jira from ${name}` });
      if (done === null) return;
      toast('success', `Jira is disconnected from ${name}.`);
      setStep('closed');
      onDisconnected();
    } catch (err) {
      toast('error', jiraErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="jira-menu">
      <button type="button" className="jira-btn jira-btn--quiet jira-menu__open" aria-haspopup="true" aria-expanded={step !== 'closed'}
        aria-label="Jira connection" onClick={() => setStep(step === 'closed' ? 'menu' : 'closed')}>
        <span aria-hidden="true">⋯</span>
      </button>
      {step === 'menu' ? (
        <div className="jira-menu__list" role="menu" aria-label="Jira connection">
          <button type="button" role="menuitem" className="jira-menu__item" onClick={() => { setStep('closed'); onReconnect(); }}>Sign in again</button>
          <button type="button" role="menuitem" className="jira-menu__item jira-menu__item--danger" onClick={() => setStep('confirm')}>Disconnect…</button>
        </div>
      ) : null}
      {step === 'confirm' ? (
        <div className="jira-menu__list jira-confirm" role="alertdialog" aria-label="Disconnect Jira?">
          <p>Disconnect Jira from {name}? The token is deleted from the hub. Your tickets stay in Jira.</p>
          <div className="jira-form__row">
            <button type="button" className="jira-btn jira-btn--danger" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
            <button type="button" className="jira-btn jira-btn--quiet" onClick={() => setStep('closed')}>Keep it</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

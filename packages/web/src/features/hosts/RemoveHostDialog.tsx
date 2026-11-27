import type { HostDTO } from '@luady/shared';
import { useId, useState } from 'react';
import type { HostRemoveResult } from '../../api/hosts.js';
import { mustPin, usePin } from '../../pin/PinProvider.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { Modal } from '../../ui/Modal.js';
import { useHostsApi } from './context.js';
import { hostErrorText, stepText } from './messages.js';
import { CopyBlock, Problem } from './parts.js';

/** The choices of a removal; the defaults take everything off the server and keep the rooms with their history. */
export interface RemoveChoices {
  uninstallKit: boolean;
  removeKey: boolean;
  rooms: 'delete' | 'keep';
}

export const REMOVE_DEFAULTS: Readonly<RemoveChoices> = Object.freeze({ uninstallKit: true, removeKey: true, rooms: 'keep' });

function Result({ result }: { result: HostRemoveResult }) {
  return (
    <div className="stack" data-testid="host-remove-result">
      <Banner tone={result.note === null ? 'info' : 'warn'}>{result.note ?? `${result.host} was removed. Its history is kept.`}</Banner>
      <ul className="host-missing">
        <li>Kit: {stepText(result.steps.kit)}</li>
        <li>Key line: {stepText(result.steps.key)}</li>
        <li>Rooms: {result.steps.rooms === 'deleted' ? 'deleted' : 'kept'}</li>
      </ul>
      {result.keyCommand !== null ? <CopyBlock label="Run on the server to remove the key line" text={result.keyCommand} testId="host-key-command" /> : null}
    </div>
  );
}

/** Removing a server: what goes, said before it goes; the PIN; then what happened, step by step. */
export function RemoveHostDialog({ host, onClose, onRemoved }: { host: HostDTO; onClose: () => void; onRemoved: () => void }) {
  const api = useHostsApi();
  const { runPinned } = usePin();
  const group = useId();
  const [choices, setChoices] = useState<RemoveChoices>({ ...REMOVE_DEFAULTS });
  const [result, setResult] = useState<HostRemoveResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const local = host.kind === 'local';
  const name = local ? 'this computer' : host.id;
  async function remove(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const done = await runPinned((pin) => api.remove(host.id, { ...choices, removeKey: !local && choices.removeKey, pin: mustPin(pin) }), {
        title: 'Confirm with your PIN', detail: `Remove ${name}`, require: true,
      });
      if (done !== null) {
        setResult(done);
        onRemoved();
      }
    } catch (err) {
      setProblem(hostErrorText(err));
    } finally {
      setBusy(false);
    }
  }
  const footer = result !== null
    ? <Button variant="primary" onClick={onClose}>Close</Button>
    : <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button variant="danger" icon="trash" busy={busy} onClick={() => void remove()}>Remove {name}</Button>
    </>;
  return (
    <Modal open title={`Remove ${name}`} onClose={onClose} footer={footer}>
      {result !== null ? <Result result={result} /> : (
        <div className="stack" data-testid="host-remove-dialog">
          <p>The hub stops watching {name}. Its sessions' history stays readable, and its name is never given to another server.</p>
          <label className="host-check">
            <input type="checkbox" checked={choices.uninstallKit} onChange={(event) => setChoices({ ...choices, uninstallKit: event.target.checked })} />
            <span>Remove the kit from {name} (its hooks leave Claude Code's settings)</span>
          </label>
          {local ? null : (
            <label className="host-check">
              <input type="checkbox" checked={choices.removeKey} onChange={(event) => setChoices({ ...choices, removeKey: event.target.checked })} />
              <span>Remove the hub's key line from {name}, so it can no longer sign in</span>
            </label>
          )}
          <fieldset className="host-rooms">
            <legend className="field__label">Its rooms</legend>
            <label className="host-check">
              <input type="radio" name={`${group}-rooms`} checked={choices.rooms === 'keep'} onChange={() => setChoices({ ...choices, rooms: 'keep' })} />
              <span>Keep them (marked as removed, still editable)</span>
            </label>
            <label className="host-check">
              <input type="radio" name={`${group}-rooms`} checked={choices.rooms === 'delete'} onChange={() => setChoices({ ...choices, rooms: 'delete' })} />
              <span>Delete them, with their links and Jira site</span>
            </label>
          </fieldset>
          <Problem text={problem} />
        </div>
      )}
    </Modal>
  );
}

import type { ActionDTO, SessionDTO } from '@luady/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { describeAction } from '../../lib/actions.js';
import { mustPin, usePin } from '../../pin/PinProvider.js';
import { sessionLabel } from '../../state/selectors.js';
import { useStore } from '../../state/store.js';
import { Button } from '../../ui/Button.js';
import { terminalPath } from '../agency/hud/useSessionCommands.js';
import { usePause } from '../agency/model/usePause.js';
import { useRooms } from '../rooms/useRooms.js';

type Busy = 'interrupt' | 'stop' | 'restart' | 'delete' | null;
const TITLE = { stop: 'Stop', restart: 'Restart', delete: 'Delete' } as const;

export function SessionControls({ session }: { session: SessionDTO }) {
  const api = useApi();
  const { state, toast } = useStore();
  const { hostLabel } = useRooms();
  const { runPinned } = usePin();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<Busy>(null);
  const ended = session.state === 'ended';
  const terminal = terminalPath(session, state.servers);
  const pause = usePause(session);

  async function run(kind: Exclude<Busy, null>, op: () => Promise<ActionDTO | null>) {
    setBusy(kind);
    try {
      const action = await op();
      if (!action) return;
      const outcome = describeAction(action);
      toast(outcome.kind, outcome.text);
      if (kind === 'delete' && action.status === 'done') void navigate('/sessions');
    } catch (err) {
      toast('error', userMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const pinned = (kind: 'stop' | 'restart' | 'delete', detail: string, call: (pin: string) => Promise<ActionDTO>) =>
    run(kind, () => runPinned((pin) => call(mustPin(pin)), { require: true, title: `${TITLE[kind]} ${sessionLabel(session, hostLabel)}`, detail }));

  return (
    <div className="session-controls" role="toolbar" aria-label="Session controls">
      <Button size="sm" icon="pause" disabled={ended || busy !== null} busy={busy === 'interrupt'}
        onClick={() => void run('interrupt', () => api.interruptSession(session.id))}>Interrupt</Button>
      {pause.hidden || ended ? null : (
        <Button size="sm" icon={pause.paused ? 'play' : 'hold'} disabled={!pause.canPause || busy !== null} busy={pause.busy}
          title={pause.reason ?? undefined} onClick={() => void pause.toggle()}>{pause.paused ? 'Resume' : 'Pause'}</Button>
      )}
      <Button size="sm" icon="stop" disabled={ended || busy !== null} busy={busy === 'stop'}
        onClick={() => void pinned('stop', 'Sends Escape and /exit, then closes the pane after 10 seconds.',
          (pin) => api.stopSession(session.id, { pin, force: false }))}>Stop</Button>
      <Button size="sm" icon="restart" disabled={busy !== null} busy={busy === 'restart'}
        onClick={() => void pinned('restart', 'Stops the session and resumes it with claude --resume.',
          (pin) => api.restartSession(session.id, { pin }))}>Restart</Button>
      <Button size="sm" variant="danger" icon="trash" disabled={busy !== null} busy={busy === 'delete'}
        onClick={() => void pinned('delete', 'Stops the session and moves its transcript to trash (restorable for 7 days).',
          (pin) => api.deleteSession(session.id, { pin }))}>Delete</Button>
      {terminal === null ? null : (
        <Button size="sm" variant="ghost" icon="terminal" onClick={() => void navigate(terminal)}>Terminal</Button>
      )}
    </div>
  );
}

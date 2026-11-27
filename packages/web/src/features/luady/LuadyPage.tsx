import type { LuadyStatusDTO } from '@luady/shared';
import { useState } from 'react';
import { missions } from '../../state/selectors.js';
import { useStore } from '../../state/store.js';
import { Badge } from '../../ui/Badge.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Segmented } from '../../ui/Segmented.js';
import { LUADY_LABEL, luadyTone, type Tone } from '../../ui/tones.js';
import { SessionRow } from '../sessions/SessionRow.js';
import { LuadyChat } from './LuadyChat.js';
import { ManagerOffHint } from './ManagerOff.js';
import { MemoryBrowser } from './MemoryBrowser.js';
import '../sessions/sessions.css';
import './luady.css';
import { managerName } from '@luady/shared';

type View = 'chat' | 'memory' | 'missions';

/** The pill's tone and words; switched off is a calm grey, never the alarm red of a manager that is down. */
export function statusLook(state: LuadyStatusDTO['state']): { readonly tone: Tone; readonly label: string } {
  return state === 'off' ? { tone: 'ended', label: 'Switched off' } : { tone: luadyTone(state), label: LUADY_LABEL[state] };
}

function LuadyStatusPill({ status }: { status: LuadyStatusDTO }) {
  const look = statusLook(status.state);
  return (
    <span className="row">
      <Badge tone={look.tone}>{look.label}</Badge>
      {status.queued > 0 ? <span className="chip">{status.queued} queued</span> : null}
    </span>
  );
}

export function LuadyPage() {
  const { state } = useStore();
  const [view, setView] = useState<View>('chat');
  const list = missions(state.sessions);
  const options = [
    { value: 'chat', label: 'Chat' },
    { value: 'memory', label: 'Memory' },
    { value: 'missions', label: list.length > 0 ? `Missions (${list.length})` : 'Missions' },
  ] as const;

  return (
    <div className="page luady-page">
      <header className="page-header">
        <div className="page-header__text">
          <div className="row"><h1>{managerName()}</h1>{state.luady ? <LuadyStatusPill status={state.luady} /> : null}</div>
          <p className="page-header__sub">Your assistant on the hub. This thread is shared with your chat channel.</p>
        </div>
      </header>
      {state.luady?.state === 'off' ? <ManagerOffHint className="manager-off" /> : null}
      <Segmented label={`${managerName()} views`} value={view} onChange={setView} options={options} />
      <div role="tabpanel" aria-label={view}>
        {view === 'chat' ? <LuadyChat /> : null}
        {view === 'memory' ? <MemoryBrowser /> : null}
        {view === 'missions' && list.length === 0 ? (
          <EmptyState icon="sessions" title="No missions yet" body={`When ${managerName()} starts a session for you, it shows up here.`} />
        ) : null}
        {view === 'missions' && list.length > 0 ? (
          <ul className="session-list">{list.map((session) => <SessionRow key={session.id} session={session} />)}</ul>
        ) : null}
      </div>
    </div>
  );
}

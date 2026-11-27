import type { ServerDTO } from '@luady/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { groupByHost, needsYou, type HostGroup } from '../../state/selectors.js';
import { useStore } from '../../state/store.js';
import { Badge } from '../../ui/Badge.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Switch } from '../../ui/Field.js';
import { Icon } from '../../ui/Icon.js';
import { Spinner } from '../../ui/Spinner.js';
import { serverTone } from '../../ui/tones.js';
import { useRooms } from '../rooms/useRooms.js';
import { SessionRow } from './SessionRow.js';
import './sessions.css';
import { managerName } from '@luady/shared';

function HostGroupView({ group, label, server }: { group: HostGroup; label: string; server: ServerDTO | undefined }) {
  const headingId = `host-${group.host}`;
  const count = group.sessions.length;
  return (
    <section className="host-group" aria-labelledby={headingId}>
      <header className="host-group__head">
        <h2 className="host-group__title" id={headingId}>{label}</h2>
        {server ? <Badge tone={serverTone(server.status)}>{server.status}</Badge> : null}
        <span className="text-subtle">{count} {count === 1 ? 'session' : 'sessions'}</span>
      </header>
      <ul className="session-list">
        {group.sessions.map((session) => <SessionRow key={session.id} session={session} />)}
      </ul>
    </section>
  );
}

export function SessionsPage() {
  const { state } = useStore();
  const { hostLabel } = useRooms();
  const [showEnded, setShowEnded] = useState(false);
  const groups = groupByHost(state.sessions, { includeEnded: showEnded, rooms: state.rooms });
  const ended = state.sessions.filter((session) => session.state === 'ended').length;
  const urgent = state.sessions.filter(needsYou).length;
  const servers = new Map<string, ServerDTO>(state.servers.map((server) => [server.name, server]));
  const summary = `${state.sessions.length - ended} active${urgent > 0 ? ` · ${urgent} need${urgent === 1 ? 's' : ''} you` : ''}`;

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1>Sessions</h1>
          <p className="page-header__sub">{state.loaded ? summary : 'Loading…'}</p>
        </div>
        <Link to="/sessions/new" className="btn btn--primary btn--sm"><Icon name="plus" /><span className="btn__label">New session</span></Link>
      </header>
      {ended > 0 ? <Switch label={`Show ended sessions (${ended})`} checked={showEnded} onChange={setShowEnded} /> : null}
      {!state.loaded ? <div className="page-loading"><Spinner size="lg" label="Loading sessions" /></div> : null}
      {state.loaded && groups.length === 0 ? (
        <EmptyState icon="sessions" title="No running sessions" body={`Start one here, from your chat channel, or ask ${managerName()} to start a mission.`}
          action={<Link className="btn btn--primary" to="/sessions/new">New session</Link>} />
      ) : null}
      {groups.map((group) => (
        <HostGroupView key={group.host} group={group} label={hostLabel(group.host)} server={servers.get(group.host)} />
      ))}
    </div>
  );
}

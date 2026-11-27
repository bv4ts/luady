import { useMemo } from 'react';
import { Link } from 'react-router';
import { hostOrder } from '../../state/selectors.js';
import { useStore } from '../../state/store.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Spinner } from '../../ui/Spinner.js';
import { ServerCard } from './ServerCard.js';
import './servers.css';

export function ServersPage() {
  const { state } = useStore();
  const { servers, rooms } = state;
  // The office's order: by home room, then by id.
  const ordered = useMemo(() => {
    const order = hostOrder(rooms);
    return servers.toSorted((a, b) => order(a.name, b.name));
  }, [servers, rooms]);
  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1>Servers</h1>
          <p className="page-header__sub">Health, versions and projects of your servers.</p>
        </div>
      </header>
      {!state.loaded ? <div className="page-loading"><Spinner size="lg" label="Loading servers" /></div> : null}
      {state.loaded && servers.length === 0 ? (
        <EmptyState icon="server" title="No servers yet" body="Add a server or this computer in Settings, then it shows up here."
          action={<Link className="btn btn--secondary" to="/settings">Open Settings</Link>} />
      ) : null}
      <div className="server-grid">
        {ordered.map((server) => <ServerCard key={server.name} server={server} />)}
      </div>
    </div>
  );
}

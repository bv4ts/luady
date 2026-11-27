import type { JiraSiteDTO } from '@luady/shared';
import { useCallback, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { useStore } from '../../../../state/store.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { teamStyle } from '../../model/team-style.js';
import { useLoaded } from '../library/useLoaded.js';
import { ConnectForm } from './ConnectForm.js';
import { JiraBoard } from './JiraBoard.js';
import { JiraMenu } from './JiraMenu.js';
import { jiraErrorText, officeOf, siteHost } from './jira-model.js';
import './jira.css';

export interface JiraModalProps {
  /** The office room whose Jira board is shown. */
  readonly room: string;
  /** A ticket to open at once. */
  readonly issueKey?: string;
  readonly onClose: () => void;
}

/**
 * A room's Jira: the connect form while it has no connection (or the owner asked to sign in again),
 * otherwise the board with its tickets. Reloads on `jira.changed`. An office without rooms has no board yet.
 */
export function JiraModal({ room, issueKey }: JiraModalProps) {
  const lookup = useRooms();
  const server = officeOf(room, lookup);
  if (server === null) {
    return (
      <div className="jira" data-testid="jira-modal">
        <p className="jira__quiet" role="status">Add a room first. Each room can connect its own Jira board.</p>
      </div>
    );
  }
  return <JiraRoom key={server} server={server} {...(issueKey === undefined ? {} : { issueKey })} />;
}

function JiraRoom({ server, issueKey }: { server: string; issueKey?: string }) {
  const api = useApi();
  const version = useStore().state.jiraVersion;
  const { roomName, roomPalette } = useRooms();
  const [reconnect, setReconnect] = useState(false);
  const sites = useLoaded(useCallback(() => api.jiraSites(), [api]), 'sites', version);
  const site: JiraSiteDTO | null = sites.state.kind === 'ready' ? sites.state.value.sites.find((s) => s.server === server) ?? null : null;

  const onConnected = useCallback((fresh: JiraSiteDTO) => {
    setReconnect(false);
    if (sites.state.kind === 'ready') {
      sites.set({ sites: [...sites.state.value.sites.filter((s) => s.server !== fresh.server), fresh] });
    } else {
      sites.reload();
    }
  }, [sites]);

  const gone = useCallback(() => {
    if (sites.state.kind === 'ready') sites.set({ sites: sites.state.value.sites.filter((s) => s.server !== server) });
  }, [sites, server]);

  return (
    <div className="jira" style={teamStyle(roomPalette(server))} data-testid="jira-modal">
      <header className="jira__head">
        <span className="jira__mark" aria-hidden="true" />
        <div className="jira__where">
          <span className="jira__office">{roomName(server)}</span>
          <span className="jira__site">{site === null ? 'Jira' : `${siteHost(site.baseUrl)} · ${site.displayName ?? site.email}`}</span>
        </div>
        {site === null || reconnect ? null : <JiraMenu server={server} onReconnect={() => setReconnect(true)} onDisconnected={gone} />}
      </header>
      {sites.state.kind === 'loading' ? <p className="jira__quiet" role="status">Opening Jira…</p> : null}
      {sites.state.kind === 'failed' ? <p className="jira__quiet" role="alert">{jiraErrorText(sites.state.error)}</p> : null}
      {sites.state.kind === 'ready' && (site === null || reconnect) ? (
        <ConnectForm server={server} again={site} onConnected={onConnected} {...(reconnect ? { onCancel: () => setReconnect(false) } : {})} />
      ) : null}
      {site !== null && !reconnect ? (
        <JiraBoard server={server} site={site} {...(issueKey === undefined ? {} : { issueKey })} onNotConnected={gone} onReconnect={() => setReconnect(true)} />
      ) : null}
    </div>
  );
}

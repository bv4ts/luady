import { MUTE_PALETTE, type AgencySnapshot } from '@luady/office';
import type { ServerDTO } from '@luady/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { formatUptime } from '../../../lib/format.js';
import { useStore } from '../../../state/store.js';
import { PanelHead } from './PanelHead.js';
import { gb, loadText, seenAt } from './rack-format.js';

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** A value with the rack light's warning next to it: amber for tight memory, red for a nearly full disk. */
function Warned({ value, warning, tone }: { value: string; warning: string | null; tone: 'amber' | 'red' }) {
  return (
    <>
      <span>{value}</span>
      {warning === null ? null : <> <span className={`agency-warn agency-warn--${tone}`}>{warning}</span></>}
    </>
  );
}

function Numbers({ server, snapshot, roomId }: { server: ServerDTO; snapshot: AgencySnapshot; roomId: string }) {
  const info = server.sysinfo;
  const rack = snapshot.rooms[roomId]?.rack ?? null;
  return (
    <dl className="kv agency-facts" aria-label="Server numbers">
      <Fact term="Status">{server.status}</Fact>
      {info ? (
        <>
          <Fact term="Load">{loadText(info.load1, info.load5)}</Fact>
          <Fact term="Memory">
            <Warned value={`${gb(info.mem_avail_kb)} free of ${gb(info.mem_total_kb)}`} tone="amber"
              warning={rack?.memory === 'tight' ? 'low' : null} />
          </Fact>
          <Fact term="Free disk">
            <Warned value={gb(info.disk_free_kb)} tone="red" warning={rack?.disk === 'low' ? 'almost full' : null} />
          </Fact>
          <Fact term="Up for">{formatUptime(info.uptime_s)}</Fact>
        </>
      ) : null}
      <Fact term="Claude Code">{server.claudeVersion ?? 'unknown'}</Fact>
      <Fact term="Kit">{server.kitVersion ?? 'unknown'}</Fact>
      <Fact term="Last seen">{seenAt(server.lastSeenAt, Date.now())}</Fact>
    </dl>
  );
}

/** The server rack of a room: the numbers the hub has for that server. */
export function RackPanel({ snapshot, roomId }: { snapshot: AgencySnapshot; roomId: string }) {
  const { state } = useStore();
  const def = snapshot.map.rooms[roomId];
  const host = def?.host ?? null;
  const server = host === null ? undefined : state.servers.find((candidate) => candidate.name === host);
  const removed = state.rooms.find((room) => room.id === roomId)?.hostState === 'removed';
  return (
    <>
      <PanelHead title={host === null ? (def?.name ?? 'Room') : `Server ${host}`} palette={def?.palette ?? MUTE_PALETTE}>{def?.name ?? null}</PanelHead>
      <div className="agency-panel__body">
        {removed ? <p className="agency-panel__note" role="status">Server removed. This room is kept: you can rename it, recolour it, give it another server or remove it.</p> : null}
        {server === undefined ? (removed ? null : <p className="agency-panel__note">{host === null ? 'This room takes projects from any server; it has no rack of its own.' : 'No numbers from this server yet.'}</p>) : (
          <>
            {server.sysinfo === null ? <p className="agency-panel__note">No numbers from this server yet.</p> : null}
            <Numbers server={server} snapshot={snapshot} roomId={roomId} />
            <Link className="agency-panel__link" to={`/servers/${server.name}`}>Open server page</Link>
          </>
        )}
      </div>
    </>
  );
}

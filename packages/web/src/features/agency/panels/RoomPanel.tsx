import { HQ_ID, HQ_PALETTE, MUTE_PALETTE, isEmptySlot, type AgencySnapshot, type BubbleIcon, type RoomDef } from '@luady/office';
import { managerName } from '@luady/shared';
import type { Dispatch } from 'react';
import { Link } from 'react-router';
import type { AppState } from '../../../state/reducer.js';
import { useStore } from '../../../state/store.js';
import { Button } from '../../../ui/Button.js';
import { useBulkRooms } from '../../rooms/useBulkRooms.js';
import { AccountLine } from './AccountLine.js';
import { BubbleGlyph } from '../hud/BubbleGlyph.js';
import { lotPosition, type AgencyUiAction } from '../model/ui-state.js';
import { doingOf, linkDown, linkNotice, luadyWords, stateWords } from '../model/words.js';
import { LUADY_ACTOR_ID } from '../stage-types.js';
import { MANAGER_SWITCH_LINK } from './LuadyPanel.js';
import { PanelHead } from './PanelHead.js';
import './agent/agent.css';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly meta: string;
  readonly needs: boolean;
  readonly icon: BubbleIcon | null;
}

function agentRows(snapshot: AgencySnapshot, ids: readonly string[], activity: AppState['activity']): readonly Row[] {
  return ids.flatMap((id) => {
    const actor = snapshot.actors[id];
    if (actor === undefined) return [];
    const doing = doingOf(actor.state, Object.hasOwn(activity, id) ? activity[id] : undefined);
    const meta = [stateWords(actor.state), doing?.words ?? null, actor.project].filter((part): part is string => Boolean(part)).join(' · ');
    return [{ id, name: actor.name, meta, needs: actor.visual.needsOwner, icon: doing?.icon ?? null }];
  });
}

function RowList({ rows, dispatch }: { rows: readonly Row[]; dispatch: Dispatch<AgencyUiAction> }) {
  if (rows.length === 0) return <p className="agency-panel__note">Nobody is working here right now.</p>;
  return (
    <ul className="agency-rows">
      {rows.map((row) => (
        <li key={row.id}>
          <button type="button" className="agency-row" onClick={() => dispatch({ type: 'select', id: row.id })}>
            {row.icon === null ? null : <BubbleGlyph icon={row.icon} />}
            <span className="agency-row__main">
              <b className="agency-row__name" dir="auto">{row.name}</b>
              <small className="agency-row__meta" dir="auto">{row.meta}</small>
            </span>
            {row.needs ? <span className="agency-row__need">Needs you</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "+2 more: a, b" for sessions that did not fit in the room, or sessions with no room on the map. */
function MoreList({ ids, intro }: { ids: readonly string[]; intro: (count: number) => string }) {
  const { state } = useStore();
  if (ids.length === 0) return null;
  const names = ids.map((id) => state.sessions.find((session) => session.id === id)?.displayName ?? 'a session');
  return (
    <p className="agency-panel__note">
      <span dir="auto">{`${intro(ids.length)}${names.join(', ')}`}</span>{' '}
      <Link to="/sessions">See all sessions</Link>
    </p>
  );
}

/** What the room's head says under its name: its server and how it is, or which projects it holds. */
export function roomLine(def: RoomDef, status: string | undefined): string {
  if (def.kind === 'project') return def.host === null ? 'Projects from any server' : `Projects on ${def.host}`;
  const what = def.kind === 'local' ? 'This computer' : `Server ${def.host ?? ''}`;
  return status === undefined ? `${what} has not reported yet` : `${what} is ${status}`;
}

/**
 * The empty office: a room for each server in one press, a room for this computer, or one
 * room at a time. Without any server set up, the way to Settings → Servers.
 */
function EmptyOffice({ dispatch }: { dispatch: Dispatch<AgencyUiAction> }) {
  const bulk = useBulkRooms();
  const servers = bulk.waiting.filter((host) => !host.local);
  return (
    <div className="agency-empty" data-testid="office-empty">
      <p className="agency-panel__note"><b>Your office is empty.</b> Each room you add appears on the map, next to HQ.</p>
      <div className="agency-panel__actions">
        {servers.length > 0 ? (
          <Button size="sm" variant="primary" busy={bulk.busy} onClick={() => void bulk.createAll()}>
            {servers.length === 1 && bulk.computer === null ? 'Create a room for this server' : 'Create a room for each server'}
          </Button>
        ) : null}
        {bulk.computer !== null && servers.length === 0 ? (
          <Button size="sm" variant="primary" busy={bulk.busy} onClick={() => void bulk.addComputer()}>Add this computer</Button>
        ) : null}
        <Button size="sm" onClick={() => dispatch({ type: 'modal', modal: { kind: 'rooms', add: true } })}>Add a room</Button>
      </div>
      {bulk.waiting.length === 0 ? <p className="agency-panel__hint">No server is set up yet. <Link to="/settings">Add one in Settings → Servers</Link>.</p> : null}
      {bulk.problem === null ? null : <p className="agency-panel__down" role="alert">{bulk.problem.text}</p>}
    </div>
  );
}

function FreeSpot({ def, dispatch }: { def: RoomDef | undefined; dispatch: Dispatch<AgencyUiAction> }) {
  const position = def === undefined ? null : lotPosition(def.id);
  return (
    <>
      <PanelHead title={position === null ? 'Free spot' : `Free spot ${position + 1}`} palette={MUTE_PALETTE} />
      <div className="agency-panel__body">
        <p className="agency-panel__note">No room here yet.</p>
        {position === null ? null : (
          <div className="agency-panel__actions">
            <Button size="sm" variant="primary" onClick={() => dispatch({ type: 'modal', modal: { kind: 'rooms', position } })}>Add a room here</Button>
          </div>
        )}
      </div>
    </>
  );
}

function HqPanel({ snapshot, dispatch }: { snapshot: AgencySnapshot; dispatch: Dispatch<AgencyUiAction> }) {
  const { state } = useStore();
  const off = snapshot.luady.state === 'off';
  const rows = [{ id: LUADY_ACTOR_ID, name: managerName(), meta: luadyWords(snapshot.luady.state), needs: false, icon: null }];
  return (
    <>
      <PanelHead title={snapshot.map.rooms[snapshot.map.order[2] ?? '']?.name ?? 'HQ'} palette={HQ_PALETTE}>{`${managerName()}’s office`}</PanelHead>
      <div className="agency-panel__body">
        {off ? (
          <p className="agency-panel__note" data-testid="manager-off-hint">
            The manager is switched off, so HQ is quiet. <Link to={MANAGER_SWITCH_LINK}>Turn it on in Settings</Link>
          </p>
        ) : null}
        {state.rooms.length === 0 && state.loaded ? <EmptyOffice dispatch={dispatch} /> : null}
        <RowList rows={rows} dispatch={dispatch} />
        <MoreList ids={snapshot.unplaced} intro={() => 'Not on the map: '} />
        <p className="agency-panel__hint">Right-click a character for its menu. On a phone, press and hold.</p>
      </div>
    </>
  );
}

export function RoomPanel({ snapshot, roomId, dispatch }: { snapshot: AgencySnapshot; roomId: string; dispatch: Dispatch<AgencyUiAction> }) {
  const { state } = useStore();
  const def = snapshot.map.rooms[roomId];
  if (def === undefined || isEmptySlot(def)) return <FreeSpot def={def} dispatch={dispatch} />;
  if (def.kind === HQ_ID) return <HqPanel snapshot={snapshot} dispatch={dispatch} />;
  const room = snapshot.rooms[roomId];
  const dto = state.rooms.find((candidate) => candidate.id === roomId);
  const removed = dto?.hostState === 'removed';
  const rows = agentRows(snapshot, room?.actors ?? [], state.activity);
  const status = room?.status ?? (def.host === null ? undefined : state.servers.find((server) => server.name === def.host)?.status);
  const down = removed ? null : linkDown(status);

  return (
    <>
      <PanelHead title={def.name} palette={def.palette}>{removed ? 'Server removed' : roomLine(def, status)}</PanelHead>
      <div className="agency-panel__body">
        {removed ? <p className="agency-panel__note" role="status">Its server was removed. The room is kept: edit it to give it another server, or remove it.</p> : null}
        {down === null ? null : <p className="agency-panel__down" role="status">{linkNotice(down)}</p>}
        {def.host === null || def.kind === 'project' || removed ? null : <AccountLine host={def.host} dispatch={dispatch} />}
        <RowList rows={rows} dispatch={dispatch} />
        <MoreList ids={room?.overflow ?? []} intro={(count) => `+${count} more: `} />
        <div className="agency-panel__actions">
          {def.host === null || removed ? null : (
            <Button size="sm" icon="server"
              onClick={() => dispatch({ type: 'stage', event: { type: 'fixture', fixture: 'rack', id: `rack-${roomId}`, room: roomId } })}>Server</Button>
          )}
          {dto === undefined ? null : (
            <Button size="sm" icon="settings" onClick={() => dispatch({ type: 'modal', modal: { kind: 'rooms', room: roomId } })}>Edit room</Button>
          )}
        </div>
        <p className="agency-panel__hint">Right-click a character for its menu. On a phone, press and hold.</p>
      </div>
    </>
  );
}

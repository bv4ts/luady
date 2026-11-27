import type { RoomDTO } from '@luady/shared';
import { useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { SelectField } from '../../ui/Field.js';
import { DeleteRoomDialog } from './DeleteRoomDialog.js';
import { RoomEditor } from './RoomEditor.js';
import type { RoomProblem } from './room-errors.js';
import { hasGaps, reordered, roomMatches, roomWhere, spotChoices } from './room-list.js';
import { useBulkRooms } from './useBulkRooms.js';
import { useRoomActions } from './useRoomActions.js';
import { useRooms, type RoomLookup } from './useRooms.js';
import { VirtualList } from './VirtualList.js';

/** Above this many rows the list draws only what is in view. */
export const VIRTUAL_ROWS = 50;
const ROW_PX = 56;
const LIST_PX = 448;
/** From this many rooms the list has a search box. */
const SEARCH_FROM = 8;

export type RoomsView =
  | { readonly kind: 'list' }
  | { readonly kind: 'add'; readonly position?: number }
  | { readonly kind: 'edit'; readonly id: string }
  | { readonly kind: 'remove'; readonly id: string };

const dot = (room: RoomDTO): CSSProperties => ({ '--swatch': room.colour }) as CSSProperties;

function MovePanel({ room, rooms, onMove, onCancel, busy }: {
  room: RoomDTO; rooms: readonly RoomDTO[]; onMove: (position: number) => void; onCancel: () => void; busy: boolean;
}) {
  const spots = spotChoices(rooms, room);
  const [position, setPosition] = useState(spots[0]?.position ?? room.position);
  return (
    <div className="room-move" role="group" aria-label={`Move ${room.name}`}>
      <SelectField label={`Move ${room.name} to`} value={String(position)} onChange={(event) => setPosition(Number(event.target.value))}
        options={spots.map((spot) => ({
          value: String(spot.position),
          label: spot.room === null ? `Spot ${spot.position + 1} (free)` : `Spot ${spot.position + 1} (swap with ${spot.room.name})`,
        }))} />
      <div className="room-editor__actions">
        <Button variant="primary" size="sm" busy={busy} onClick={() => onMove(position)}>Move</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function RoomRow({ room, lookup, onEdit, onMove, onRemove, drag }: {
  room: RoomDTO; lookup: RoomLookup; onEdit: () => void; onMove: () => void; onRemove: () => void;
  drag: { onStart: (event: DragEvent) => void; onOver: (event: DragEvent) => void; onDrop: (event: DragEvent) => void; over: boolean };
}) {
  return (
    <li className={drag.over ? 'room-row room-row--over' : 'room-row'} data-testid="room-row" data-room={room.id}
      draggable onDragStart={drag.onStart} onDragOver={drag.onOver} onDrop={drag.onDrop}>
      <span className="room-row__grip" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
      <span className="room-row__spot">{room.position + 1}</span>
      <span className="room-row__dot" style={dot(room)} aria-hidden="true" />
      <span className="room-row__main">
        <b dir="auto">{room.name}</b>
        <small>{roomWhere(room, lookup)}{room.hostState === 'removed' ? ' · server removed' : ''}</small>
      </span>
      <span className="room-row__actions">
        <Button size="sm" onClick={onEdit} aria-label={`Edit ${room.name}`}>Edit</Button>
        <Button size="sm" variant="ghost" onClick={onMove} aria-label={`Move ${room.name} to another spot`}>Move to…</Button>
        <Button size="sm" variant="ghost" icon="trash" onClick={onRemove} aria-label={`Remove ${room.name}`} />
      </span>
    </li>
  );
}

function useListActions() {
  const actions = useRoomActions();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<RoomProblem | null>(null);
  const run = async (work: () => ReturnType<typeof actions.order>): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    const result = await work();
    setBusy(false);
    if (!result.ok) setProblem(result.problem);
    return result.ok;
  };
  return { actions, busy, problem, run };
}

/**
 * Every room in slot order: add, edit, move to a spot, drag to reorder, close gaps and remove. Any number
 * of rooms: from VIRTUAL_ROWS rows on only the rows in view are drawn, and a search box narrows the list.
 */
type View = RoomsView;

export function RoomsManager({ initial, onFinish }: {
  /** Open on an editor (a room, or a new room for a spot) instead of the list. */
  initial?: RoomsView;
  /** With an editor as `initial`: called when it is done (the saved room, or null) instead of going back to the list. */
  onFinish?: (room: RoomDTO | null) => void;
}) {
  const lookup = useRooms();
  const bulk = useBulkRooms();
  const list = useListActions();
  const [view, setView] = useState<View>(initial ?? { kind: 'list' });
  const [query, setQuery] = useState('');
  const [moving, setMoving] = useState<string | null>(null);
  // The dragged row's id: a ref, so every dragover of the same drag sees it without waiting for a render.
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const rooms = lookup.list;
  const direct = initial !== undefined && initial.kind !== 'list' && onFinish !== undefined;
  const back = (room: RoomDTO | null = null) => {
    if (direct) onFinish(room);
    else setView({ kind: 'list' });
  };

  if (view.kind === 'add') {
    return <RoomEditor {...(view.position === undefined ? {} : { position: view.position })} onDone={(room) => back(room)} onCancel={() => back()} />;
  }
  const target = view.kind === 'list' ? undefined : rooms.find((room) => room.id === view.id);
  if (view.kind === 'edit' && target !== undefined) {
    return <RoomEditor key={target.id} room={target} onDone={(room) => back(room)} onCancel={() => back()}
      extraActions={<Button variant="danger" icon="trash" onClick={() => setView({ kind: 'remove', id: target.id })}>Remove…</Button>} />;
  }
  if (view.kind === 'remove' && target !== undefined) return <DeleteRoomDialog room={target} onDone={() => back()} onCancel={() => back()} />;

  const shown = rooms.filter((room) => roomMatches(room, query, lookup));
  const movingRoom = rooms.find((room) => room.id === moving);
  const drop = (onto: string) => {
    const from = dragged.current;
    dragged.current = null;
    setOver(null);
    if (from === null || from === onto) return;
    void list.run(() => list.actions.order(reordered(rooms.map((room) => room.id), from, onto)));
  };

  return (
    <div className="rooms-manager stack" data-testid="rooms-manager">
      <div className="rooms-manager__bar">
        <Button variant="primary" icon="plus" onClick={() => setView({ kind: 'add' })}>Add a room</Button>
        {bulk.waiting.length > 1 ? <Button busy={bulk.busy} onClick={() => void bulk.createAll()}>Create a room for each server</Button> : null}
        {hasGaps(rooms) ? <Button busy={list.busy} onClick={() => void list.run(() => list.actions.order(rooms.map((room) => room.id)))}>Close gaps</Button> : null}
      </div>
      {rooms.length >= SEARCH_FROM ? (
        <input className="input" type="search" placeholder="Find a room by name, server or kind" aria-label="Find a room" value={query}
          onChange={(event) => setQuery(event.target.value)} />
      ) : null}
      {list.problem === null ? null : <Banner tone="error">{list.problem.text}</Banner>}
      {bulk.problem === null ? null : <Banner tone="error">{bulk.problem.text}</Banner>}
      {movingRoom === undefined ? null : (
        <MovePanel room={movingRoom} rooms={rooms} busy={list.busy} onCancel={() => setMoving(null)}
          onMove={(position) => void list.run(() => list.actions.move(movingRoom.id, position)).then((ok) => { if (ok) setMoving(null); })} />
      )}
      {rooms.length === 0 ? <p className="text-muted">No rooms yet. Add one, and it appears on the map.</p> : (
        <>
          <p className="field__hint">Spots are places on the map, in order out from HQ. Drag a room onto another to put it there (the rooms are then packed together), or use Move to… for an exact spot.</p>
          <VirtualList items={shown} rowHeight={ROW_PX} height={LIST_PX} threshold={VIRTUAL_ROWS} className="room-rows" label="Rooms"
            render={(room) => (
              <RoomRow key={room.id} room={room} lookup={lookup} onEdit={() => setView({ kind: 'edit', id: room.id })}
                onMove={() => setMoving(room.id)} onRemove={() => setView({ kind: 'remove', id: room.id })}
                drag={{
                  over: over === room.id,
                  onStart: (event) => { dragged.current = room.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', room.id); },
                  onOver: (event) => { if (dragged.current !== null) { event.preventDefault(); setOver(room.id); } },
                  onDrop: (event) => { event.preventDefault(); drop(room.id); },
                }} />
            )} />
          {shown.length === 0 ? <p className="text-muted">No room matches “{query}”.</p> : null}
        </>
      )}
    </div>
  );
}

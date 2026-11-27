import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type KeyboardEvent } from 'react';
import { HQ_ID } from '@luady/office';
import { OfficePortal } from '../OfficePortal.js';
import { VirtualList } from '../../rooms/VirtualList.js';
import type { RoomCount } from '../model/room-counts.js';
import { teamStyle } from '../model/team-style.js';
import type { AgencyUiAction } from '../model/ui-state.js';
import { sessionCount } from '../model/words.js';
import './rooms-menu.css';

/** From this many rooms on, the menu draws only the rows in view. */
export const MENU_VIRTUAL_ROWS = 50;
const ROW_PX = 44;
const LIST_PX = 352;

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  server: 'server', local: 'this computer', project: 'project',
});

/** A room's line in the menu: its kind and server ("server mars", "project, any server"); HQ is the headquarters. */
export function roomKindWords(room: RoomCount): string {
  if (room.key === HQ_ID) return 'headquarters';
  const kind = KIND_WORDS[room.def.kind] ?? room.def.kind;
  if (room.def.kind === 'project') return `${kind}, ${room.def.host ?? 'any server'}`;
  return room.def.kind === 'server' && room.def.host !== null ? `${kind} ${room.def.host}` : kind;
}

/** True when every word of the query is in the room's name, short name, server or kind (any case). */
export function menuMatches(room: RoomCount, query: string): boolean {
  const words = query.toLocaleLowerCase('und').split(/\s+/).filter(Boolean);
  const text = [room.def.name, room.def.short, room.def.host ?? '', roomKindWords(room)].join(' ').toLocaleLowerCase('und');
  return words.every((word) => text.includes(word));
}

function Row({ room, active, here, id, onPick }: { room: RoomCount; active: boolean; here: boolean; id: string; onPick: () => void }) {
  return (
    <li id={id} role="option" aria-selected={active} className={active ? 'rooms-menu__row rooms-menu__row--active' : 'rooms-menu__row'}
      style={teamStyle(room.def.palette)} data-room={room.key} onMouseDown={(event) => event.preventDefault()} onClick={onPick}>
      <span className="rooms-menu__dot" aria-hidden="true" />
      <span className="rooms-menu__main">
        <b dir="auto">{room.def.name}</b>
        <small>{roomKindWords(room)}{room.down === null ? '' : `, ${room.down}`}{here ? ', shown now' : ''}</small>
      </span>
      {room.count === null ? null : <span className="rooms-menu__count">{sessionCount(room.count)}</span>}
      {room.waiting > 0 ? <span className="rooms-menu__need">{room.waiting} waiting</span> : null}
    </li>
  );
}

/**
 * The Rooms button and its menu: every room (any number), searched by name, server or kind; arrow keys move, Enter
 * flies the camera there, Esc closes. "Manage rooms" opens the rooms list. Long lists draw only the rows in view.
 */
export function RoomsMenu({ rooms, current, dispatch }: { rooms: readonly RoomCount[]; current: string | null; dispatch: Dispatch<AgencyUiAction> }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const scrollTo = useRef<((index: number) => void) | null>(null);
  const listId = useId();
  const shown = useMemo(() => rooms.filter((room) => menuMatches(room, query)), [rooms, query]);
  const total = rooms.filter((room) => room.key !== HQ_ID).length;

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery('');
    setActive(0);
    if (refocus) button.current?.focus();
  };
  const pick = (room: RoomCount | undefined) => {
    if (room === undefined) return;
    close(true);
    dispatch({ type: 'focus', focus: { kind: 'room', room: room.key } });
  };
  const moveTo = (index: number) => {
    const next = Math.max(0, Math.min(shown.length - 1, index));
    setActive(next);
    scrollTo.current?.(next);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const moves: Readonly<Record<string, number>> = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: shown.length - 1, PageDown: active + 8, PageUp: active - 8 };
    if (event.key in moves) {
      event.preventDefault();
      moveTo(moves[event.key] ?? 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(shown[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };
  const optionId = (index: number): string => `${listId}-${index}`;

  return (
    <div className="rooms-menu">
      <button ref={button} type="button" className="agency-chip rooms-menu__button" aria-haspopup="dialog" aria-expanded={open}
        data-testid="rooms-menu-button" onClick={() => (open ? close(false) : setOpen(true))}>
        Rooms <span className="agency-chip__count">{total}</span>
      </button>
      {open ? (
        <OfficePortal>
          <div className="rooms-menu__panel" role="dialog" aria-label="Find a room" data-testid="rooms-menu"
            onBlur={(event) => {
              const to = event.relatedTarget as Node | null;
              if (to !== button.current && !event.currentTarget.contains(to)) close(false);
            }}>
            <input ref={input} className="rooms-menu__search" type="search" role="combobox" aria-expanded="true" aria-controls={listId}
              aria-activedescendant={shown.length === 0 ? undefined : optionId(active)} aria-autocomplete="list"
              aria-label="Find a room by name, server or kind" placeholder="Find a room" value={query}
              onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKey} />
            {shown.length === 0 ? <p className="rooms-menu__empty">No room matches.</p> : (
              <div className="rooms-menu__scroll">
                <VirtualList id={listId} items={shown} rowHeight={ROW_PX} height={LIST_PX} threshold={MENU_VIRTUAL_ROWS} role="listbox" label="Rooms"
                  className="rooms-menu__list" onScrollTo={(scroll) => { scrollTo.current = scroll; }}
                  render={(room, index) => (
                    <Row key={room.key} room={room} id={optionId(index)} active={index === active} here={room.key === current} onPick={() => pick(room)} />
                  )} />
              </div>
            )}
            <div className="rooms-menu__foot">
              <button type="button" className="rooms-menu__manage" onClick={() => { close(true); dispatch({ type: 'modal', modal: { kind: 'rooms' } }); }}>
                Manage rooms
              </button>
              <button type="button" className="rooms-menu__manage" onClick={() => { close(true); dispatch({ type: 'modal', modal: { kind: 'rooms', add: true } }); }}>
                + Add a room
              </button>
            </div>
          </div>
        </OfficePortal>
      ) : null}
    </div>
  );
}

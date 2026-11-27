import type { AgencySnapshot } from '@luady/office';
import type { Dispatch } from 'react';
import type { AgencyUiAction } from '../model/ui-state.js';
import { roomCounts, type RoomCount } from '../model/room-counts.js';
import { teamStyle } from '../model/team-style.js';
import { sessionCount } from '../model/words.js';
import { focusedRoom } from '../model/focus.js';
import type { StageFocus } from '../stage-types.js';
import { RoomsMenu } from './RoomsMenu.js';

const ALL: StageFocus = Object.freeze({ kind: 'all' });

export function chipLabel(chip: RoomCount): string {
  const parts = [chip.def.name, chip.down, chip.count === null ? null : sessionCount(chip.count), chip.waiting > 0 ? `${chip.waiting} waiting for you` : null];
  return parts.filter((part): part is string => part !== null).join(', ');
}

/**
 * The Rooms menu, "All", then one chip per room in slot order (HQ in its place), each with its agents and who waits for
 * the owner. Any number of rooms: the strip scrolls, and the Rooms menu finds any room by name, server or kind.
 * The counts come from one pass over the snapshot per render (model/room-counts.ts).
 */
export function RoomChips({ snapshot, focus, dispatch }: {
  snapshot: AgencySnapshot; focus: StageFocus; dispatch: Dispatch<AgencyUiAction>;
}) {
  const current = focusedRoom(snapshot, focus);
  const chips = roomCounts(snapshot);
  return (
    <div className="agency-chips" role="group" aria-label="Rooms">
      <RoomsMenu rooms={chips} current={current} dispatch={dispatch} />
      <button type="button" className="agency-chip" aria-pressed={focus.kind === 'all'} aria-label="Whole office"
        onClick={() => dispatch({ type: 'focus', focus: ALL })}>All</button>
      {chips.map((chip) => (
        <button key={chip.key} type="button" className={chip.down === null ? 'agency-chip agency-chip--room' : 'agency-chip agency-chip--room agency-chip--down'}
          style={teamStyle(chip.def.palette)} data-room={chip.key}
          aria-pressed={current === chip.key} aria-label={chipLabel(chip)}
          onClick={() => dispatch({ type: 'focus', focus: { kind: 'room', room: chip.key } })}>
          <span className="agency-chip__name">{chip.def.short}</span>
          {chip.down === null ? null : <span className="agency-chip__link">{chip.down}</span>}
          {chip.count === null ? null : <span className="agency-chip__count">{chip.count}</span>}
          {chip.waiting > 0 ? <span className="agency-chip__need">{chip.waiting}</span> : null}
        </button>
      ))}
    </div>
  );
}

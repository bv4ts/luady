import type { RoomDTO, SessionDTO } from '@luady/shared';
import { OfficePortal } from '../OfficePortal.js';
import { roomLookup } from '../../rooms/room-lookup.js';
import { dropTargetOf, type DragState } from './drag.js';
import { targetName } from './targets.js';
import { managerName } from '@luady/shared';

/** What a drop would do now, in words. */
export function dropWords(state: Extract<DragState, { phase: 'dragging' }>, sessions: readonly SessionDTO[], rooms: readonly RoomDTO[]): string {
  const drop = dropTargetOf(state.target, sessions, rooms);
  if (drop === null) return 'Drop on a character or a room. Esc cancels.';
  const name = targetName(drop.to, sessions, roomLookup(rooms));
  if (drop.to.kind === 'auto') return `Drop to let ${managerName()} decide`;
  return drop.to.kind === 'server' ? `Drop for a new session in ${name ?? 'this office'}` : `Drop to give it to ${name ?? 'this session'}`;
}

/** Room the chip needs left of and above the pointer (its widest and tallest, plus the gap); less flips that side. */
export const CHIP_ROOM_X = 290;
export const CHIP_ROOM_Y = 96;

/** Above and to the left of the pointer, so its tip and the target stay in view; flipped only near the window's edge. */
export function chipSide(x: number, y: number): { readonly x: 'left' | 'right'; readonly y: 'above' | 'below' } {
  return { x: x < CHIP_ROOM_X ? 'right' : 'left', y: y < CHIP_ROOM_Y ? 'below' : 'above' };
}

/** The pop-up shrunk to a chip that follows the pointer while something is dragged. */
export function DragChip({ state, sessions, rooms }: {
  state: Extract<DragState, { phase: 'dragging' }>; sessions: readonly SessionDTO[]; rooms: readonly RoomDTO[];
}) {
  const armed = dropTargetOf(state.target, sessions, rooms) !== null;
  const side = chipSide(state.x, state.y);
  return (
    <OfficePortal>
      <div className={armed ? 'give-chip give-chip--armed' : 'give-chip'} data-testid="give-chip" data-side={`${side.x} ${side.y}`}
        role="status" aria-live="polite"
        style={{ transform: `translate(${String(Math.round(state.x))}px, ${String(Math.round(state.y))}px)` }}>
        <span className="give-chip__label" dir="auto">{state.load.label}</span>
        <span className="give-chip__hint">{dropWords(state, sessions, rooms)}</span>
      </div>
    </OfficePortal>
  );
}

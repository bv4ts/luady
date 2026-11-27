import { HQ_ID, type AgencySnapshot } from '@luady/office';
import { LUADY_ACTOR_ID, type StageFocus } from '../stage-types.js';

/** The room the camera is on: the focused room, or the room of the focused agent (Luady: HQ); null for the whole office. */
export function focusedRoom(snapshot: AgencySnapshot, focus: StageFocus): string | null {
  if (focus.kind === 'room') return focus.room;
  if (focus.kind === 'actor') return focus.id === LUADY_ACTOR_ID ? HQ_ID : (snapshot.actors[focus.id]?.room ?? null);
  return null;
}

import { HQ_ID, HQ_PALETTE, type AgencySnapshot, type Palette } from '@luady/office';
import { managerName } from '@luady/shared';
import { focusedRoom } from '../model/focus.js';
import type { LabelView } from '../model/view-rooms.js';
import { luadyWords, stateWords } from '../model/words.js';
import { LUADY_ACTOR_ID, type StageFocus } from '../stage-types.js';

export interface PlateInfo {
  readonly id: string;
  readonly name: string;
  readonly palette: Palette;
  readonly guest: boolean;
  readonly needs: boolean;
  readonly words: string;
  /** Sits in a 20-desk room: smaller type, on its desk front. */
  readonly tight: boolean;
  /** Luady has no neighbouring desks: his plate shows at any zoom. */
  readonly luady: boolean;
}

/**
 * Who gets a name plate: everyone in the focused room, the selected actor, everyone waiting for the owner, and Luady.
 * Agents come in reading order (room order, then desk), then Luady; this is also the keyboard order. With a view, only
 * actors the scene draws get one: none in far mode, and only those in rooms the view shows.
 */
export function plateList(
  snapshot: AgencySnapshot, focus: StageFocus, selectedId: string | null, view?: LabelView,
): readonly PlateInfo[] {
  if (view?.far === true) return [];
  const shown = view?.rooms === null || view?.rooms === undefined ? null : new Set(view.rooms);
  const room = focusedRoom(snapshot, focus);
  const keys = shown === null ? snapshot.map.order : snapshot.map.order.filter((key) => shown.has(key));
  const agents = keys.flatMap((key) => (snapshot.rooms[key]?.actors ?? []).flatMap((id): PlateInfo[] => {
    const actor = snapshot.actors[id];
    if (actor === undefined) return [];
    if (id !== selectedId && !actor.visual.needsOwner && actor.room !== room) return [];
    return [{
      id, name: actor.name, palette: actor.look.palette, guest: actor.look.guest, needs: actor.visual.needsOwner,
      words: stateWords(actor.state), tight: snapshot.rooms[key]?.mode === 'tight', luady: false,
    }];
  }));
  if (shown !== null && !shown.has(HQ_ID)) return agents;
  const luady: PlateInfo = {
    id: LUADY_ACTOR_ID, name: managerName(), palette: HQ_PALETTE, guest: false, needs: false, words: luadyWords(snapshot.luady.state), tight: false, luady: true,
  };
  return [...agents, luady];
}

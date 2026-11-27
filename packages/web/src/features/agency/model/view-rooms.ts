import { HQ_ID, isEmptySlot, roomRectPx, roomsMeeting, type OfficeMap, type PixelRect } from '@luady/office';
import { FAR_BADGES, ROOM_REACH, grow, liveRooms } from '../scene/live-set.js';
import type { StageView } from '../stage-types.js';

/**
 * Which rooms the HUD labels for the stage's view: in detailed mode a plaque for each room meeting the
 * view, and a "+ Add room" plaque for each empty slot there; in far mode a badge for each of the FAR_BADGES live rooms
 * nearest the view's centre (the scene gives exactly those a point). Pure, and O(rooms met), never O(rooms).
 */
export interface LabelView {
  readonly far: boolean;
  /** Rooms and HQ that get a plaque or badge, in map order; null before the first view (every room then). */
  readonly rooms: readonly string[] | null;
  /** Empty slots (`lot-<n>`) in the view that get a "+ Add room" plaque; none in far mode. */
  readonly lots: readonly string[];
  /** Changes exactly when what is labelled changes. */
  readonly key: string;
}

export const NO_VIEW: LabelView = Object.freeze({ far: false, rooms: null, lots: Object.freeze([]), key: 'none' });

const meets = (a: PixelRect, b: PixelRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const keyOf = (far: boolean, rooms: readonly string[], lots: readonly string[]): string => `${far ? 'far' : 'near'}|${rooms.join(',')}|${lots.join(',')}`;

/** The far badges: the live rooms nearest the centre, and HQ while it is in reach. */
function farRooms(map: OfficeMap, view: StageView): readonly string[] {
  const centre = { x: view.rect.x + view.rect.w / 2, y: view.rect.y + view.rect.h / 2 };
  const near = liveRooms(map, view.rect).filter((room) => !isEmptySlot(room)).map((room) => {
    const q = roomRectPx(room);
    return { id: room.id, d: Math.hypot(q.x + q.w / 2 - centre.x, q.y + q.h / 2 - centre.y) };
  }).sort((a, b) => a.d - b.d).slice(0, FAR_BADGES);
  const hq = map.rooms[HQ_ID];
  const withHq = hq !== undefined && meets(grow(view.rect, ROOM_REACH.x, ROOM_REACH.y), roomRectPx(hq)) ? [HQ_ID] : [];
  const chosen = new Set([...near.map((room) => room.id), ...withHq]);
  return map.order.filter((key) => chosen.has(key));
}

export function labelView(map: OfficeMap, view: StageView | null): LabelView {
  if (view === null) return NO_VIEW;
  if (view.far) {
    const rooms = farRooms(map, view);
    return { far: true, rooms, lots: [], key: keyOf(true, rooms, []) };
  }
  const met = roomsMeeting(map, view.rect);
  const rooms = met.filter((room) => !isEmptySlot(room)).map((room) => room.id);
  const lots = met.filter((room) => room.kind === 'lot').map((room) => room.id);
  return { far: false, rooms, lots, key: keyOf(false, rooms, lots) };
}

/** The same object while the labelled rooms stay the same: React re-renders the labels only when the set changes. */
export function nextLabelView(previous: LabelView, map: OfficeMap, view: StageView | null): LabelView {
  const made = labelView(map, view);
  return made.key === previous.key ? previous : made;
}

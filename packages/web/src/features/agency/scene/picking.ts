import { roomAtPx, type AgencySnapshot, type FixtureDef } from '@luady/office';
import type { StageEvent, StageTarget } from '../stage-types.js';
import type { ActorBody } from './actors.js';

/** What is under a point of the map. */
export interface Pick { readonly actor: string | null; readonly fixture: FixtureDef | null; readonly room: string | null }

/** Below this zoom characters are too small to aim at: taps go to the room. */
export const MIN_ACTOR_PICK_SCALE = 0.45;
/** Extra reach around a body, in map pixels (±11 across a 16-pixel body, 8 above it for the bubble). */
const REACH_X = 3;
const REACH_TOP = 8;
const REACH_BELOW = 4;
/** Extra reach round a fixture's picture, in map pixels, so the small ones (the fuse box) are easy to hit. */
const FIXTURE_REACH = 2;

/** What picking reads of a body: the feet and the painted size above them. */
export type BodyBox = Omit<ActorBody, 'top' | 'base'>;

/** The character under a map point (its body, a little around it, and its bubble); the one furthest forward wins. */
export function pickActor(bodies: readonly BodyBox[], wx: number, wy: number): string | null {
  const hits = bodies.filter((b) => Math.abs(wx - b.x) <= b.w / 2 + REACH_X && wy >= b.y - b.h - REACH_TOP && wy <= b.y + REACH_BELOW);
  const front = hits.reduce<BodyBox | null>((best, b) => (best === null || b.y > best.y ? b : best), null);
  return front?.id ?? null;
}

/** The fixture whose picture (and a little round it) is under a map point. */
export function pickFixture(snapshot: AgencySnapshot, wx: number, wy: number): FixtureDef | null {
  const r = FIXTURE_REACH;
  return snapshot.fixtures.find((f) => wx >= f.box.x - r && wx < f.box.x + f.box.w + r && wy >= f.box.y - r && wy < f.box.y + f.box.h + r) ?? null;
}

export function pickAt(snapshot: AgencySnapshot, bodies: readonly BodyBox[], wx: number, wy: number, scale: number): Pick {
  return Object.freeze({
    actor: scale >= MIN_ACTOR_PICK_SCALE ? pickActor(bodies, wx, wy) : null,
    fixture: pickFixture(snapshot, wx, wy),
    room: roomAtPx(snapshot.map, wx, wy),
  });
}

/** A tap: a character, else a fixture (before the room it hangs in), else a room floor, else outside the building. */
export function eventForTap(pick: Pick): StageEvent {
  if (pick.actor !== null) return { type: 'actor', id: pick.actor };
  const f = pick.fixture;
  if (f !== null) return { type: 'fixture', fixture: f.kind, id: f.id, room: f.room };
  return { type: 'room', room: pick.room };
}

/** What is under a point for the page (drops, tooltips): a character, else a fixture, else the room, else nothing. */
export function targetOf(pick: Pick): StageTarget | null {
  if (pick.actor !== null) return { kind: 'actor', id: pick.actor };
  if (pick.fixture !== null) return { kind: 'fixture', id: pick.fixture.id };
  return pick.room === null ? null : { kind: 'room', room: pick.room };
}

/** A hold or right-click opens the menu, but only on a character. */
export function eventForHold(pick: Pick, at: { readonly x: number; readonly y: number }): StageEvent | null {
  return pick.actor === null ? null : { type: 'menu', id: pick.actor, x: at.x, y: at.y };
}

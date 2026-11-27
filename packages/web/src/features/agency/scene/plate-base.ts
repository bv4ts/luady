import { FURNITURE_SIZE, type PropDef } from '@luady/office';
import type { StageActor } from './actor-store.js';

/** Furniture that a plate goes under: Luady's desk (agents use their own desk from the snapshot). */
export interface Bases { readonly luadyDesk: PropDef | null }

/** A walker's plate starts this far below its feet. */
const UNDER_FEET = 2;

const settled = (a: StageActor): boolean => a.walk === null && !a.leaving;

/**
 * World y where a character's name plate starts: the bottom of its desk's front while it sits there (Luady: his own
 * desk), otherwise just under its feet. Never above the character, so a plate never covers its face or bubble.
 */
export function plateBase(a: StageActor, bases: Bases): number {
  const { view, pos } = a;
  if (settled(a) && view !== null && pos.x === view.sit.x && pos.y === view.sit.y) return view.desk.y + FURNITURE_SIZE.desk.h;
  const desk = bases.luadyDesk;
  if (settled(a) && view === null && desk !== null) return desk.y + FURNITURE_SIZE[desk.kind].h;
  return pos.y + UNDER_FEET;
}

import type { ActorView, AgencySnapshot } from '@luady/office';

/** What happened to one character between two snapshots. A move also carries the actor's new look. */
export type ActorChange =
  | { readonly kind: 'enter'; readonly actor: ActorView }
  | { readonly kind: 'leave'; readonly id: string }
  | { readonly kind: 'move'; readonly actor: ActorView }
  | { readonly kind: 'restyle'; readonly actor: ActorView };

/** The seat is a place, not a number: a room that changes its desk arrangement moves people at the same number. */
const seatChanged = (a: ActorView, b: ActorView): boolean => a.room !== b.room || a.sit.x !== b.sit.x || a.sit.y !== b.sit.y;

const lookChanged = (a: ActorView, b: ActorView): boolean =>
  a.state !== b.state ||
  a.visual.pose !== b.visual.pose || a.visual.bubble !== b.visual.bubble || a.visual.monitor !== b.visual.monitor ||
  a.visual.needsOwner !== b.visual.needsOwner ||
  a.look.species !== b.look.species || a.look.palette.base !== b.look.palette.base || a.look.palette.accent !== b.look.palette.accent ||
  a.look.variant !== b.look.variant || a.look.guest !== b.look.guest ||
  a.helpers !== b.helpers || a.strained !== b.strained;

const changeFor = (before: ActorView | undefined, after: ActorView): ActorChange | null => {
  if (before === undefined) return { kind: 'enter', actor: after };
  if (seatChanged(before, after)) return { kind: 'move', actor: after };
  return lookChanged(before, after) ? { kind: 'restyle', actor: after } : null;
};

/** The changes that turn `prev` into `next`: leavers first (by id), then everyone else in `next`'s order. First load: all enter. */
export function diffActors(prev: AgencySnapshot | null, next: AgencySnapshot): readonly ActorChange[] {
  const before = prev?.actors ?? {};
  const leaves: ActorChange[] = Object.keys(before)
    .filter((id) => !Object.hasOwn(next.actors, id))
    .toSorted()
    .map((id) => ({ kind: 'leave', id }));
  const others = Object.values(next.actors).flatMap((actor) => {
    const change = changeFor(Object.hasOwn(before, actor.id) ? before[actor.id] : undefined, actor);
    return change === null ? [] : [change];
  });
  return Object.freeze([...leaves, ...others]);
}

import type { ActorView } from '@luady/office';
import { nextNeedId } from './ui-state.js';

/** The classic page of a session. */
export function sessionPath(id: string): string {
  return `/sessions/${encodeURIComponent(id)}`;
}

/**
 * Where the bell's next step goes when it cannot be shown on the map: a waiting session with no character
 * (its room is over 20 desks, or its host has no room) opens its classic session page. Null means "select it on the map".
 */
export function offMapNeedPath(
  needs: readonly string[], selectedId: string | null, actors: Readonly<Record<string, ActorView>>,
): string | null {
  const id = nextNeedId(needs, selectedId);
  return id === null || Object.hasOwn(actors, id) ? null : sessionPath(id);
}

import type { Clock } from '../core/contracts.js';

/**
 * Requests the owner made on the website (the board's Run and Give) that the hub hands the manager as an Event. Each one
 * is kept as the SHA-256 of the exact prompt the hub injected, until the manager's prompt hook reports that prompt or the
 * time runs out. Only the website's request marks one, and the turn that prompt starts takes the mark: once, and it ends
 * with that turn (luady/replies.ts). Marks live in memory only, so after a restart such a turn is no longer the owner's.
 */
export interface OwnerRequests {
  mark(promptSha256: string): void;
  /** True once for a marked prompt (the mark is then gone); false for any other. */
  take(promptSha256: string): boolean;
}

/** A mark whose prompt has not come by then is dropped (the same hour the reply router looks back for injections). */
export const OWNER_REQUEST_TTL_MS = 60 * 60_000;

export function createOwnerRequests(clock: Clock): OwnerRequests {
  let marks: ReadonlyMap<string, number> = new Map();
  const fresh = (now: number): Map<string, number> => new Map([...marks].filter(([, expires]) => expires > now));
  return {
    mark(promptSha256) {
      const now = clock.now().getTime();
      marks = new Map([...fresh(now), [promptSha256, now + OWNER_REQUEST_TTL_MS]]);
    },
    take(promptSha256) {
      const live = fresh(clock.now().getTime());
      const found = live.has(promptSha256);
      live.delete(promptSha256);
      marks = live;
      return found;
    },
  };
}

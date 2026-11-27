import { randomBytes } from 'node:crypto';
import type { Clock } from '../core/contracts.js';
import { sha256Hex } from '../core/ids.js';

/**
 * Grants: after a PIN check (the PIN service locks out), one host's add-server flow may
 * scan, pin, check and install for ten minutes without the PIN again. A grant is bound to the session (its sid hash)
 * and to the host id, and only its sha256 is kept, in memory: a restart ends every grant, and the flow asks for the PIN
 * once more. The token itself is returned once and never logged.
 */
export const GRANT_TTL_MS = 10 * 60_000;
/** Live grants kept at most; the oldest goes first. Every grant comes after a PIN check, so this is never reached in use. */
export const GRANT_MAX = 1_000;

export interface Grant {
  readonly grant: string;
  readonly expiresAt: string;
}

export interface GrantStore {
  issue(sidHash: string, host: string): Grant;
  /** True for a live grant of this session and this host. */
  check(grant: string | undefined, sidHash: string, host: string): boolean;
  /** Ends every grant of a host (it was removed). */
  revokeHost(host: string): void;
  size(): number;
}

interface Held {
  readonly sidHash: string;
  readonly host: string;
  readonly expiresAt: number;
}

export function createGrantStore(deps: { clock: Clock; ttlMs?: number; max?: number }): GrantStore {
  const ttl = deps.ttlMs ?? GRANT_TTL_MS;
  const max = deps.max ?? GRANT_MAX;
  let held: ReadonlyMap<string, Held> = new Map();
  const now = (): number => deps.clock.now().getTime();

  function prune(): void {
    const at = now();
    const live = [...held].filter(([, grant]) => grant.expiresAt > at);
    held = new Map(live.slice(Math.max(0, live.length - (max - 1))));
  }

  return {
    issue(sidHash, host) {
      prune();
      const grant = randomBytes(32).toString('base64url');
      const expiresAt = now() + ttl;
      held = new Map([...held, [sha256Hex(grant), { sidHash, host, expiresAt }]]);
      return { grant, expiresAt: new Date(expiresAt).toISOString() };
    },
    check(grant, sidHash, host) {
      if (typeof grant !== 'string' || grant.length < 16 || grant.length > 128) return false;
      const found = held.get(sha256Hex(grant));
      return found !== undefined && found.expiresAt > now() && found.sidHash === sidHash && found.host === host;
    },
    revokeHost(host) {
      held = new Map([...held].filter(([, grant]) => grant.host !== host));
    },
    size: () => held.size,
  };
}

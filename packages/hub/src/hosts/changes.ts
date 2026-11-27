import type { HostDTO } from '@luady/shared';
import type { Clock, EventBus } from '../core/contracts.js';

/**
 * `hosts.changed` with the full list: coalesced to at most four a second, and sent only when the
 * list differs from the last one sent, so a hundred links reporting sysinfo every minute do not flood the sockets.
 */
export const HOSTS_CHANGED_INTERVAL_MS = 250;

export interface ChangeFeed {
  /** Asks for a `hosts.changed`; several asks inside one interval become one. */
  schedule(): void;
  /** Sends now (when the list changed); cancels a scheduled send. */
  flush(): void;
  stop(): void;
}

export function createChangeFeed(deps: { bus: EventBus; clock: Clock; list: () => HostDTO[]; intervalMs?: number }): ChangeFeed {
  const interval = deps.intervalMs ?? HOSTS_CHANGED_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: string | null = null;
  let stopped = false;

  function flush(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (stopped) return;
    const hosts = deps.list();
    const text = JSON.stringify(hosts);
    if (text === last) return;
    last = text;
    deps.bus.emit('hosts.changed', { hosts, at: deps.clock.now().toISOString() });
  }

  return {
    schedule() {
      if (stopped || timer !== null) return;
      timer = setTimeout(flush, interval);
    },
    flush,
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

import type { HostId, LoginStartDTO } from '@luady/shared';

/** A sign-in link waits this long for its code. */
export const LOGIN_WAIT_MS = 30 * 60_000;

export interface PendingSignIn {
  readonly host: HostId;
  /** The link the kit returned; never logged, never stored anywhere but here. */
  readonly url: string;
  readonly at: number;
  /** Codes tried on this sign-in so far, each counted before it reached the kit. */
  readonly tries: number;
}

/** One waiting sign-in per host, kept in memory only; a sign-in older than 30 minutes is gone. */
export interface PendingSignIns {
  put(host: HostId, url: string, atMs: number): void;
  get(host: HostId, nowMs: number): PendingSignIn | null;
  /** The host whose sign-in started last and still waits. */
  latest(nowMs: number): HostId | null;
  /** Counts one try (before it is sent); returns the new count (0 when nothing waits). */
  countTry(host: HostId, nowMs: number): number;
  clear(host: HostId): void;
}

export function toLoginStart(pending: PendingSignIn): LoginStartDTO {
  return { host: pending.host, url: pending.url, expiresAt: new Date(pending.at + LOGIN_WAIT_MS).toISOString() };
}

export function createPendingSignIns(): PendingSignIns {
  let byHost: ReadonlyMap<HostId, PendingSignIn> = new Map();
  const live = (pending: PendingSignIn | undefined, nowMs: number): pending is PendingSignIn =>
    pending !== undefined && nowMs - pending.at < LOGIN_WAIT_MS;
  const without = (host: HostId): ReadonlyMap<HostId, PendingSignIn> => new Map([...byHost].filter(([key]) => key !== host));

  return {
    put(host, url, atMs) {
      byHost = new Map([...without(host), [host, { host, url, at: atMs, tries: 0 }]]);
    },
    get(host, nowMs) {
      const pending = byHost.get(host);
      if (live(pending, nowMs)) return pending;
      if (pending !== undefined) byHost = without(host);
      return null;
    },
    latest(nowMs) {
      const waiting = [...byHost.values()].filter((pending) => live(pending, nowMs));
      const newest = waiting.reduce<PendingSignIn | null>((best, pending) => (best === null || pending.at >= best.at ? pending : best), null);
      return newest?.host ?? null;
    },
    countTry(host, nowMs) {
      const pending = byHost.get(host);
      if (!live(pending, nowMs)) return 0;
      const next = { ...pending, tries: pending.tries + 1 };
      byHost = new Map([...without(host), [host, next]]);
      return next.tries;
    },
    clear(host) {
      byHost = without(host);
    },
  };
}

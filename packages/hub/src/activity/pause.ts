import {
  KIT_V2, TARGET_RE, isSelfHost, makeSessionId, parseSessionId, versionAtLeast, type CtlPane, type HostId, type ServerDTO, type SessionDTO,
} from '@luady/shared';
import { systemClock } from '../core/clock.js';
import type { Clock, EventBus, Fleet, Logger, SessionService } from '../core/contracts.js';
import { CtlError, KitTooOldError, NotFoundError, RefusedError } from '../core/errors.js';
import { sessionLabel } from '../sessions/naming.js';
import { dialogOpenText } from '../sessions/terminal-dialog.js';

/** Who set a pause: Luady may lift only his own. */
export type Pauser = 'owner' | 'manager';
export const OWNER_PAUSE_TEXT = 'The owner paused this session; only the owner can resume it.';

/**
 * Pause is a flag, never a session state. The kit's flag files are the truth (re-read with every 15-second
 * reconciliation through `sync`); this set is only the fast answer.
 */
export interface PauseService {
  isPaused(sessionId: string): boolean;
  /** The flag is set AND the kit's `paused` line was seen: the session really stopped, its Stop or drop is held. */
  isHeld(sessionId: string): boolean;
  /** The kit's `paused` line arrived for this session; counts only while its flag is set. */
  markHit(sessionId: string): void;
  /**
   * A step after the hit shows the session runs again: no longer held, and whatever was held is released as going on
   * (`sent` true). The flag stays; the next real stop marks it again.
   */
  clearHit(sessionId: string): void;
  list(): readonly string[];
  /** `by` defaults to the owner. Luady pausing a session the owner paused leaves it the owner's. */
  pause(sessionId: string, by?: Pauser): Promise<void>;
  /** Refused for Luady when the owner set the pause (before the kit is asked). `wasHit`: the pause had stopped it. */
  resume(sessionId: string, by?: Pauser): Promise<{ wasHit: boolean; sent: boolean }>;
  /**
   * Who paused it, or null when it is not paused. A pause the hub only learned from the kit (set before a restart) counts
   * as the owner's.
   */
  pausedBy(sessionId: string): Pauser | null;
  /**
   * A `sessions()` snapshot of the host. `requestedAt` = when it was asked for: a session paused or resumed here since
   * then keeps its local state (the snapshot may predate the kit's change). Without it the snapshot counts as new.
   */
  sync(host: HostId, panes: readonly CtlPane[], requestedAt?: string): void;
  /** Reads the flags of every online server now, and of each server again when it comes back online. */
  start(): void;
  stop(): void;
  /** Resolves once the host's flags were read since it came online (reading them now if needed); rejects if they cannot be. */
  ensureSynced(host: HostId): Promise<void>;
  onChange(listener: (sessionId: string) => void): () => void;
  /**
   * A hold ended: `sent` true = the session goes on (the kit typed the resume text, or it was seen running again);
   * false = the flag went away and nothing was typed, so whatever was held is due now.
   */
  onReleased(listener: (sessionId: string, sent: boolean) => void): () => void;
}

export interface PauseDeps {
  fleet: Pick<Fleet, 'client' | 'servers'>;
  /** Late-bound: the session service is created after this one. */
  sessions: () => Pick<SessionService, 'get' | 'dialogInTerminal'>;
  log: Logger;
  clock?: Clock;
  /** `server.updated`: a server that comes online is read again before anything is typed into it. */
  bus?: EventBus;
}

type Listener = (sessionId: string) => void;
type ReleaseListener = (sessionId: string, sent: boolean) => void;

/** Listeners that never stop each other: a throwing one is logged and the rest still run. */
function listenerList<A extends unknown[]>(log: Logger) {
  let listeners: ReadonlyArray<(...args: A) => void> = [];
  return {
    add(listener: (...args: A) => void): () => void {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((item) => item !== listener);
      };
    },
    emit(...args: A): void {
      for (const listener of listeners) {
        try {
          listener(...args);
        } catch (err) {
          log.warn({ args, err: err instanceof Error ? err.message : String(err) }, 'pause listener failed');
        }
      }
    },
  };
}

function tooOld(host: HostId): KitTooOldError {
  return new KitTooOldError(`${host}'s kit is older than ${KIT_V2} and cannot pause. Update the kit on ${host} first.`);
}

/** A kit-1 server answers an unknown verb with a usage error (exit 2): the same as a known-old kit. */
function kitError(host: HostId, err: unknown): unknown {
  return err instanceof CtlError && err.code === 'usage' ? tooOld(host) : err;
}

function hostOf(sessionId: string): string | null {
  return parseSessionId(sessionId)?.host ?? null;
}

export function createPauseService(deps: PauseDeps): PauseService {
  const clock = deps.clock ?? systemClock;
  let paused: ReadonlySet<string> = new Set();
  let hits: ReadonlySet<string> = new Set();
  let pausers: ReadonlyMap<string, Pauser> = new Map();
  /** Hosts whose flags were read since they came online; a send waits until its host is in here. */
  let synced: ReadonlySet<HostId> = new Set();
  const reading = new Map<HostId, Promise<void>>();
  /** When each session was last paused or resumed here (ms). */
  const lastLocal = new Map<string, number>();
  const statuses = new Map<string, ServerDTO['status']>();
  let offs: ReadonlyArray<() => void> = [];
  const changes = listenerList<Parameters<Listener>>(deps.log);
  const releases = listenerList<Parameters<ReleaseListener>>(deps.log);

  /** `sent` is what the kit reported for a resume; a flag that vanished from a snapshot released nothing typed. */
  function replace(next: ReadonlySet<string>, sent = false): void {
    const removed = [...paused].filter((id) => !next.has(id));
    const added = [...next].filter((id) => !paused.has(id));
    paused = next;
    hits = new Set([...hits].filter((id) => next.has(id)));
    pausers = new Map([...pausers].filter(([id]) => next.has(id)));
    for (const id of [...removed, ...added]) changes.emit(id);
    for (const id of removed) releases.emit(id, sent);
  }

  function set(sessionId: string, on: boolean, sent = false): void {
    if (paused.has(sessionId) === on) return;
    replace(on ? new Set([...paused, sessionId]) : new Set([...paused].filter((id) => id !== sessionId)), sent);
  }

  function requireSession(sessionId: string): SessionDTO {
    const session = deps.sessions().get(sessionId);
    if (session === undefined) throw new NotFoundError(`unknown session ${sessionId}`);
    if (isSelfHost(session.host)) throw new RefusedError(`${sessionLabel(session.host, session.displayName)} cannot be paused`);
    return session;
  }

  function isKit2(host: HostId): boolean {
    return versionAtLeast(deps.fleet.servers().find((server) => server.name === host)?.kitVersion, KIT_V2);
  }

  const pausedBy = (sessionId: string): Pauser | null => (paused.has(sessionId) ? pausers.get(sessionId) ?? 'owner' : null);

  async function pause(sessionId: string, by: Pauser = 'owner'): Promise<void> {
    const session = requireSession(sessionId);
    if (session.state === 'ended') throw new RefusedError(`${sessionLabel(session.host, session.displayName)} cannot be paused`);
    if (!isKit2(session.host)) throw tooOld(session.host);
    try {
      await deps.fleet.client(session.host).pause(session.target);
    } catch (err) {
      throw kitError(session.host, err);
    }
    lastLocal.set(sessionId, clock.now().getTime());
    const owner = pausedBy(sessionId) === 'owner';
    set(sessionId, true);
    pausers = new Map([...pausers, [sessionId, owner ? 'owner' : by]]);
  }

  async function resume(sessionId: string, by: Pauser = 'owner'): Promise<{ wasHit: boolean; sent: boolean }> {
    const session = requireSession(sessionId);
    if (by === 'manager' && pausedBy(sessionId) === 'owner') throw new RefusedError(OWNER_PAUSE_TEXT);
    // A resume may type a line and Enter into the pane: never into Claude Code's own dialog.
    if (deps.sessions().dialogInTerminal?.(sessionId) === true) throw new RefusedError(dialogOpenText(sessionLabel(session.host, session.displayName)));
    try {
      const result = await deps.fleet.client(session.host).resume(session.target);
      lastLocal.set(sessionId, clock.now().getTime());
      set(sessionId, false, result.sent);
      return { wasHit: result.was_hit, sent: result.sent };
    } catch (err) {
      throw kitError(session.host, err);
    }
  }

  /** Kit-2 rows carry `paused`; kit-1 rows do not, and then nothing changes (an empty kit-2 host clears its flags). */
  function sync(host: HostId, panes: readonly CtlPane[], requestedAt?: string): void {
    synced = new Set([...synced, host]);
    const kit2 = panes.some((pane) => pane.paused !== undefined) || (panes.length === 0 && isKit2(host));
    if (!kit2) return;
    const asked = requestedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(requestedAt);
    const keepLocal = (id: string): boolean => (lastLocal.get(id) ?? Number.NEGATIVE_INFINITY) >= asked;
    const flagged = panes
      .filter((pane) => pane.paused === true && TARGET_RE.test(pane.target))
      .map((pane) => makeSessionId(host, pane.target))
      .filter((id) => !keepLocal(id));
    replace(new Set([...[...paused].filter((id) => hostOf(id) !== host || keepLocal(id)), ...flagged]));
  }

  function read(host: HostId): Promise<void> {
    const running = reading.get(host);
    if (running !== undefined) return running;
    const requestedAt = clock.now().toISOString();
    const task = deps.fleet.client(host).sessions()
      .then(({ sessions }) => sync(host, sessions, requestedAt))
      .finally(() => reading.delete(host));
    reading.set(host, task);
    return task;
  }

  function readQuietly(host: HostId): void {
    read(host).catch((err: unknown) => deps.log.warn({ host, err: err instanceof Error ? err.message : String(err) }, 'pause flags not read'));
  }

  function onServer(server: ServerDTO): void {
    const previous = statuses.get(server.name);
    statuses.set(server.name, server.status);
    if (server.status === 'online' && previous === 'online') return;
    synced = new Set([...synced].filter((host) => host !== server.name));
    if (server.status === 'online') readQuietly(server.name);
  }

  function ensureSynced(host: HostId): Promise<void> {
    return isSelfHost(host) || synced.has(host) ? Promise.resolve() : read(host);
  }

  return {
    isPaused: (sessionId) => paused.has(sessionId),
    isHeld: (sessionId) => paused.has(sessionId) && hits.has(sessionId),
    markHit(sessionId) {
      if (paused.has(sessionId)) hits = new Set([...hits, sessionId]);
    },
    clearHit(sessionId) {
      if (!hits.has(sessionId)) return;
      hits = new Set([...hits].filter((id) => id !== sessionId));
      releases.emit(sessionId, true);
    },
    list: () => [...paused],
    pause,
    resume,
    pausedBy,
    sync,
    ensureSynced,
    start() {
      if (offs.length > 0) return;
      offs = deps.bus === undefined ? [() => undefined] : [deps.bus.on('server.updated', onServer)];
      for (const server of deps.fleet.servers()) {
        statuses.set(server.name, server.status);
        if (server.status === 'online') readQuietly(server.name);
      }
    },
    stop() {
      for (const off of offs) off();
      offs = [];
    },
    onChange: (listener) => changes.add(listener),
    onReleased: (listener) => releases.add(listener),
  };
}

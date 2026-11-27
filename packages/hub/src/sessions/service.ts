import type { CtlPane, HostId, SessionDTO } from '@luady/shared';
import type { Clock, Db, EventBus, Fleet, Logger, MemoryService, SessionService } from '../core/contracts.js';
import { NotFoundError } from '../core/errors.js';
import { condensedTranscript, readTranscriptPage } from '../transcripts/reader.js';
import { createSessionCommands, type StartSessionArgs } from './commands.js';
import { createSessionEventHandler } from './events.js';
import { findSessionByRef } from './find.js';
import { sessionLabel } from './naming.js';
import { RECONCILE_INTERVAL_MS, createSessionReconciler } from './reconcile.js';
import type { SessionRow } from './registry.js';
import { createSessionsRepo, toSessionDto } from './repo.js';
import { createTerminalDialogs } from './terminal-dialog.js';

export interface SessionDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  fleet: Fleet;
  memory: MemoryService;
  log: Logger;
  /** Pause flag of the owner (activity/pause.ts): a paused session refuses `send`. */
  isPaused?: (sessionId: string) => boolean;
  /** Who paused it, for the refusal's wording (activity/pause.ts). */
  pausedBy?: (sessionId: string) => 'owner' | 'manager' | null;
  /** The pause really stopped the session: a Stop now is held until the pause is released. */
  isHeld?: (sessionId: string) => boolean;
  /** Subscribes to pause releases (`sent` = the kit typed the resume text). */
  onReleased?: (listener: (sessionId: string, sent: boolean) => void) => () => void;
  /** Handed every `sessions()` reply of the reconciler, with the time it was asked for. */
  onPanes?: (host: HostId, panes: readonly CtlPane[], requestedAt: string) => void;
  /** `send` waits until the pause flags of the session's server are known. */
  ensureSynced?: (host: HostId) => Promise<void>;
  /** Runs after each reconciliation pass. */
  afterReconcile?: () => void;
}

export function createSessionService(deps: SessionDeps): SessionService & { start(): void; stop(): void } {
  const repo = createSessionsRepo(deps.db, deps.log);
  const base = { repo, bus: deps.bus, log: deps.log };
  const paused = {
    ...(deps.isPaused === undefined ? {} : { isPaused: deps.isPaused }),
    ...(deps.pausedBy === undefined ? {} : { pausedBy: deps.pausedBy }),
    ...(deps.ensureSynced === undefined ? {} : { ensureSynced: deps.ensureSynced }),
  };
  const events = createSessionEventHandler({ ...base, memory: deps.memory, ...(deps.isHeld === undefined ? {} : { isHeld: deps.isHeld }) });
  const dialogs = createTerminalDialogs();
  const commands = createSessionCommands({ ...base, clock: deps.clock, fleet: deps.fleet, ...paused, dialogOpen: dialogs.isOpen });
  const reconciler = createSessionReconciler({
    ...base, clock: deps.clock, fleet: deps.fleet, ...(deps.onPanes === undefined ? {} : { onPanes: deps.onPanes }),
    ...(deps.afterReconcile === undefined ? {} : { afterReconcile: deps.afterReconcile }),
  });
  let unsubscribe: (() => void) | null = null;
  let unrelease: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function requireRow(id: string): SessionRow {
    const row = repo.get(id);
    if (row === undefined) throw new NotFoundError(`unknown session ${id}`);
    return row;
  }

  function startLifecycle(): void {
    if (unsubscribe !== null) return;
    unsubscribe = deps.bus.on('spool.event', ({ host, event, replay }) => {
      dialogs.apply(host, event);
      events.apply(host, event, replay);
    });
    unrelease = deps.onReleased?.((sessionId, sent) => events.release(sessionId, sent)) ?? null;
    timer = setInterval(() => {
      void reconciler.runAll();
    }, RECONCILE_INTERVAL_MS);
  }

  function stopLifecycle(): void {
    unsubscribe?.();
    unsubscribe = null;
    unrelease?.();
    unrelease = null;
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  // One start()/stop() serves both the lifecycle and SessionService.start(args)/stop(id, force): arity decides.
  function start(): void;
  function start(args: StartSessionArgs): Promise<SessionDTO>;
  function start(args?: StartSessionArgs): Promise<SessionDTO> | void {
    if (args === undefined) {
      startLifecycle();
      return;
    }
    return commands.start(args);
  }

  function stop(): void;
  function stop(id: string, force: boolean): Promise<void>;
  function stop(id?: string, force?: boolean): Promise<void> | void {
    if (id === undefined) {
      stopLifecycle();
      return;
    }
    return commands.stop(id, force ?? false);
  }

  return {
    start,
    stop,
    list: (opts = {}) => repo.list().filter((row) => opts.includeSystem === true || row.origin !== 'system').map(toSessionDto),
    get: (id) => {
      const row = repo.get(id);
      return row === undefined ? undefined : toSessionDto(row);
    },
    findByRef: (ref) => {
      const row = findSessionByRef(repo.list(), ref);
      return row === undefined ? undefined : toSessionDto(row);
    },
    send: (id, text, channel) => commands.send(id, text, channel),
    dialogInTerminal: (id) => dialogs.isOpen(id),
    interrupt: (id) => commands.interrupt(id),
    restart: (id) => commands.restart(id),
    remove: (id) => commands.remove(id),
    transcript: async (id, cursor, limit) => {
      const row = requireRow(id);
      if (row.claudeSessionId === null) return { items: [], nextCursor: null };
      return readTranscriptPage(deps.fleet.client(row.host), row.claudeSessionId, cursor, limit);
    },
    condensed: async (id, lastN) => {
      const row = requireRow(id);
      if (row.claudeSessionId === null) return `${sessionLabel(row.host, row.displayName)}: no transcript yet`;
      return condensedTranscript(deps.fleet.client(row.host), row.claudeSessionId, lastN);
    },
  };
}

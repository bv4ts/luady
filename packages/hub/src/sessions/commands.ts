import { posix } from 'node:path';
import {
  LIMITS,
  NAME_RE,
  TARGET_RE,
  isUnderRoot,
  makeSessionId,
  promptHash,
  type Channel,
  type HostId,
  type SessionDTO, managerName,
} from '@luady/shared';
import type { Clock, EventBus, Fleet, Logger } from '../core/contracts.js';
import { CtlError, NotFoundError, QuestionPendingError, RefusedError, SessionPausedError, ValidationError } from '../core/errors.js';
import { isoNow } from '../core/time.js';
import { SESSION_NAME_MAX, SESSION_PREFIX, deriveSessionName, sessionLabel } from './naming.js';
import { createSessionRow, type SessionRow } from './registry.js';
import { CLOCK_SKEW_MS, toSessionDto, type SessionsRepo } from './repo.js';
import { dialogOpenText } from './terminal-dialog.js';

export interface StartSessionArgs {
  server: HostId;
  cwd: string;
  prompt?: string;
  name?: string;
  origin: 'owner' | 'manager';
}

export interface SessionCommandDeps {
  repo: SessionsRepo;
  bus: EventBus;
  clock: Clock;
  fleet: Fleet;
  log: Logger;
  /** The owner paused the session: `send` refuses until it is resumed. */
  isPaused?: (sessionId: string) => boolean;
  /** Who paused it: the refusal tells Luady to ask the owner about an owner's pause instead of resuming it. */
  pausedBy?: (sessionId: string) => 'owner' | 'manager' | null;
  /** Resolves once the pause flags of that server are known (after a restart or a reconnect); `send` waits for it. */
  ensureSynced?: (host: HostId) => Promise<void>;
  /** A question of the session went back to its terminal and its dialog may still wait there (terminal-dialog.ts). */
  dialogOpen?: (sessionId: string) => boolean;
}

export interface SessionCommands {
  send(id: string, text: string, channel: Channel): Promise<void>;
  interrupt(id: string): Promise<void>;
  start(args: StartSessionArgs): Promise<SessionDTO>;
  stop(id: string, force: boolean): Promise<void>;
  restart(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Channel recorded for the first prompt of a hub-started session, so that its first turn counts as remote. */
const START_CHANNEL: Record<StartSessionArgs['origin'], Channel> = { owner: 'web', manager: 'event' };

/** A normalised folder strictly inside `root`, the host's projects folder (the hub checks the cwd). */
export function checkProjectCwd(cwd: string, root: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  const base = root.replace(/\/+$/, '') || '/';
  if (/[\0\n\r]/.test(trimmed) || posix.normalize(trimmed) !== trimmed || trimmed === base || !isUnderRoot(trimmed, base)) {
    throw new ValidationError(`cwd must be a normalized path inside ${base}`);
  }
  return trimmed;
}

/**
 * Where sessions may start: an SSH server or this computer the fleet has, never the manager's own host. Returns that
 * host's projects folder.
 */
function startRoot(fleet: Fleet, host: string): string | null {
  if (!fleet.hasServer(host) && !fleet.hasLocal(host)) return null;
  return fleet.hostInfo(host)?.projectsRoot ?? null;
}

/** A row that received events since `sinceIso` (minus clock skew) reflects the real pane better than our guess. */
function isFresh(row: SessionRow | undefined, sinceIso: string): boolean {
  if (row === undefined || row.state === 'ended' || row.lastEventAt === null) return false;
  return Date.parse(row.lastEventAt) >= Date.parse(sinceIso) - CLOCK_SKEW_MS;
}

function startName(args: StartSessionArgs, cwd: string): string {
  const name = args.name ?? deriveSessionName(cwd);
  if (!NAME_RE.test(name) || name.length > SESSION_NAME_MAX) throw new ValidationError(`invalid session name: ${JSON.stringify(name)}`);
  return name;
}

export function createSessionCommands(deps: SessionCommandDeps): SessionCommands {
  function requireRow(id: string): SessionRow {
    const row = deps.repo.get(id);
    if (row === undefined) throw new NotFoundError(`unknown session ${id}`);
    return row;
  }

  function publish(row: SessionRow): SessionDTO {
    deps.repo.save(row);
    const dto = toSessionDto(row);
    deps.bus.emit('session.updated', dto);
    return dto;
  }

  function pausedText(label: string, by: 'owner' | 'manager' | null): string {
    if (by === 'owner') return `${label} was paused by the owner. Ask the owner before going on: only the owner can resume it.`;
    if (by === 'manager') return `${label} was paused by ${managerName()}. Resume it first.`;
    return `${label} is paused. Resume it first.`;
  }

  async function send(id: string, text: string, channel: Channel): Promise<void> {
    await deps.ensureSynced?.(requireRow(id).host);
    const row = requireRow(id);
    const label = sessionLabel(row.host, row.displayName);
    if (row.pendingQid !== null) {
      throw new QuestionPendingError(row.pendingQid, `${label} is waiting for an answer to #${row.pendingQid}`);
    }
    if (row.state === 'ended') throw new RefusedError(`${label} has ended`);
    // Enter would answer Claude Code's own dialog, which nobody on this side has seen.
    if (deps.dialogOpen?.(row.id) === true) throw new RefusedError(dialogOpenText(label));
    if (deps.isPaused?.(row.id) === true) throw new SessionPausedError(pausedText(label, deps.pausedBy?.(row.id) ?? null));
    if (text.trim() === '' || text.length > LIMITS.sendTextMax) {
      throw new ValidationError(`text must be 1..${LIMITS.sendTextMax} characters`);
    }
    deps.repo.recordInjection(row.id, promptHash(text), channel, isoNow(deps.clock));
    await deps.fleet.client(row.host).send(row.tmuxTarget, text);
  }

  async function start(args: StartSessionArgs): Promise<SessionDTO> {
    const root = startRoot(deps.fleet, args.server);
    if (root === null) throw new ValidationError(`unknown server: ${String(args.server)}`);
    const cwd = checkProjectCwd(args.cwd, root);
    const name = startName(args, cwd);
    const prompt = args.prompt !== undefined && args.prompt.trim() !== '' ? args.prompt : undefined;
    const startedAt = isoNow(deps.clock);
    if (prompt !== undefined) {
      const expectedId = makeSessionId(args.server, `${SESSION_PREFIX}${name}:0.0`);
      deps.repo.recordInjection(expectedId, promptHash(prompt), START_CHANNEL[args.origin], startedAt);
    }
    const result = await deps.fleet.client(args.server).start(prompt === undefined ? { name, cwd } : { name, cwd, prompt });
    if (!TARGET_RE.test(result.target)) throw new CtlError('failed', 'luady-ctl start returned an invalid target', 0);
    const existing = deps.repo.get(makeSessionId(args.server, result.target));
    if (existing !== undefined && isFresh(existing, startedAt)) return publish({ ...existing, origin: args.origin });
    const created = createSessionRow({ host: args.server, target: result.target, createdAt: startedAt, origin: args.origin, cwd });
    return publish({ ...created, state: 'starting' });
  }

  async function stop(id: string, force: boolean): Promise<void> {
    const row = requireRow(id);
    await deps.fleet.client(row.host).stop(row.tmuxTarget, force);
    const latest = deps.repo.get(id) ?? row;
    if (latest.state === 'ended') return;
    const session = publish({ ...latest, state: 'ended', pendingQid: null, turnStartedAt: null, turnRemote: false, unexpectedEnd: false });
    deps.bus.emit('session.ended', { session, unexpected: false, reason: force ? 'killed' : 'stopped', replay: false });
  }

  /**
   * An ended session has no pane left (server rebooted, tmux killed): open its tmux session again with
   * `claude --resume`, so the same conversation continues. False when its tmux session still exists.
   */
  async function revive(row: SessionRow): Promise<boolean> {
    const root = startRoot(deps.fleet, row.host);
    if (root === null) throw new RefusedError(`${sessionLabel(row.host, row.displayName)} is not on a server the hub can start sessions on`);
    if (row.claudeSessionId === null || row.cwd === null) {
      throw new RefusedError(`${sessionLabel(row.host, row.displayName)} can't be resumed: its conversation id or folder is unknown`);
    }
    const name = row.tmuxTarget.replace(/:\d+\.\d+$/, '').replace(new RegExp(`^${SESSION_PREFIX}`), '');
    try {
      await deps.fleet.client(row.host).start({ name, cwd: checkProjectCwd(row.cwd, root), resume: row.claudeSessionId });
      return true;
    } catch (err) {
      if (err instanceof CtlError && /already exists/.test(err.message)) return false;
      throw err;
    }
  }

  async function restart(id: string): Promise<void> {
    const row = requireRow(id);
    const startedAt = isoNow(deps.clock);
    const revived = row.state === 'ended' && await revive(row);
    if (!revived) await deps.fleet.client(row.host).restart(row.tmuxTarget);
    const latest = deps.repo.get(id) ?? row;
    if (isFresh(latest, startedAt)) return;
    publish({ ...latest, state: 'starting', pendingQid: null, turnStartedAt: null, turnRemote: false, unexpectedEnd: false });
  }

  async function remove(id: string): Promise<void> {
    const row = requireRow(id);
    if (row.claudeSessionId === null) {
      throw new RefusedError(`${sessionLabel(row.host, row.displayName)} has no Claude session id yet`);
    }
    await deps.fleet.client(row.host).remove(row.claudeSessionId);
    deps.repo.remove(id);
    deps.bus.emit('session.removed', { id });
  }

  async function interrupt(id: string): Promise<void> {
    const row = requireRow(id);
    await deps.fleet.client(row.host).keys(row.tmuxTarget, 'Escape');
  }

  return { send, interrupt, start, stop, restart, remove };
}

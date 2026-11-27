import { SELF_HOST_ID, makeSessionId, type Channel, type LuadyEffort } from '@luady/shared';
import type { Db, HubConfig, Logger } from '../core/contracts.js';
import { ownerDateKey } from '../scheduler/zone.js';
import { managerName } from '@luady/shared';

/** The manager's tmux session and pane on the self host (a fixed, role-neutral name: it is stored in session ids). */
export const LUADY_TMUX_SESSION = 'manager';
export const LUADY_TARGET = `${LUADY_TMUX_SESSION}:0.0`;
export const LUADY_SESSION_ID = makeSessionId(SELF_HOST_ID, LUADY_TARGET);
export const DEFAULT_LUADY_MODEL = 'opus';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
const CLAUDE_SESSION_RE = /^[A-Za-z0-9-]{8,64}$/;

export interface LuadyStateRow {
  claude_session_id: string | null;
  started_at: string | null;
  last_input_channel: string | null;
}

export function readLuadyState(db: Db): LuadyStateRow {
  const row = db
    .prepare<[], LuadyStateRow>('SELECT claude_session_id, started_at, last_input_channel FROM manager_state WHERE id = 1')
    .get();
  return row ?? { claude_session_id: null, started_at: null, last_input_channel: null };
}

/** A Luady day runs from 04:00 to 04:00 owner time (the daily rotation), so a 02:00 crash still resumes. */
export const LUADY_DAY_START_HOURS = 4;

export function luadyDayKey(at: Date): string {
  return ownerDateKey(new Date(at.getTime() - LUADY_DAY_START_HOURS * 60 * 60_000));
}

/** The session id to resume, only when the stored session started in the current Luady day. */
export function resumeIdFor(state: LuadyStateRow, now: Date): string | null {
  const id = state.claude_session_id;
  if (!id || !state.started_at || !CLAUDE_SESSION_RE.test(id)) return null;
  return luadyDayKey(new Date(state.started_at)) === luadyDayKey(now) ? id : null;
}

/** A model name that cannot be mistaken for a flag; anything else falls back to opus. */
export function safeModel(model: string, log: Logger): string {
  if (MODEL_RE.test(model)) return model;
  log.warn('luady: manager_model is not a plain model name, using opus');
  return DEFAULT_LUADY_MODEL;
}

/**
 * The manager's launch in its own tmux server. With `managerHome`, `new-session -e HOME=<managerHome>` sets the pane's
 * HOME explicitly as well (`-e` on new-session needs tmux 3.2 or later); the runner already carries HOME and
 * TMUX_TMPDIR.
 */
export function buildStartArgs(
  paths: Pick<HubConfig, 'brainDir' | 'claudePath'> & { readonly managerHome?: string | null },
  model: string,
  effort: LuadyEffort,
  resumeId: string | null,
): string[] {
  const home = paths.managerHome === undefined || paths.managerHome === null ? [] : ['-e', `HOME=${paths.managerHome}`];
  return [
    'new-session', '-d', ...home, '-s', LUADY_TMUX_SESSION, '-c', paths.brainDir, '--', paths.claudePath,
    // Only the user's settings (the manager's own HOME) and the rendered file: project and local settings in the brain
    // are never read (`--setting-sources`, from `claude --help`).
    '--restricted', '--setting-sources', 'user', '--settings', `${paths.brainDir}/.manager/settings.json`,
    '--mcp-config', `${paths.brainDir}/.manager/mcp.json`, '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--disallowedTools', 'AskUserQuestion',
    '--model', model, '--effort', effort, '--remote-control', managerName(),
    ...(resumeId ? ['--resume', resumeId] : []),
  ];
}

export function recordLaunch(db: Db, atIso: string, resumed: boolean): void {
  if (resumed) return;
  db.prepare('UPDATE manager_state SET started_at = ?, claude_session_id = NULL WHERE id = 1').run(atIso);
}

export function recordClaudeSession(db: Db, claudeSessionId: string): void {
  db.prepare('UPDATE manager_state SET claude_session_id = ? WHERE id = 1').run(claudeSessionId);
}

export function recordInputChannel(db: Db, channel: Channel): void {
  db.prepare('UPDATE manager_state SET last_input_channel = ? WHERE id = 1').run(channel);
}

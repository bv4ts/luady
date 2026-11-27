import { posix } from 'node:path';
import { NAME_RE, TARGET_RE, makeSessionId, type HostId, type SpoolEvent } from '@luady/shared';

export const SESSION_PREFIX = 'cc-';
/** tmux session `cc-<name>` must still fit the 64-character session part of TARGET_RE. */
export const SESSION_NAME_MAX = 61;

/** The tmux session name without `cc-`, plus `#<window>.<pane>` when the pane is not `0.0`. */
export function displayNameFor(target: string): string {
  const colon = target.lastIndexOf(':');
  const session = colon > 0 ? target.slice(0, colon) : target;
  const pane = colon > 0 ? target.slice(colon + 1) : '0.0';
  const base = session.startsWith(SESSION_PREFIX) && session.length > SESSION_PREFIX.length
    ? session.slice(SESSION_PREFIX.length)
    : session;
  return pane === '0.0' ? base : `${base}#${pane}`;
}

/** The project is the basename of the cwd. */
export function projectFor(cwd: string | null): string | null {
  if (cwd === null) return null;
  const base = posix.basename(cwd.replace(/\/+$/, ''));
  return base === '' ? null : base;
}

/** The label: `{host} · {displayName}`. */
export function sessionLabel(host: HostId, displayName: string): string {
  return `${host} · ${displayName}`;
}

/** Hub session id for an event's pane, or null when the event has no valid tmux target. */
export function sessionIdForEvent(host: HostId, event: Pick<SpoolEvent, 'tmux'>): string | null {
  return event.tmux !== null && TARGET_RE.test(event.tmux) ? makeSessionId(host, event.tmux) : null;
}

/** Default `cc-<name>` for a cwd: its basename with unsafe characters replaced by `-`. */
export function deriveSessionName(cwd: string): string {
  const cleaned = (projectFor(cwd) ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, SESSION_NAME_MAX);
  return NAME_RE.test(cleaned) ? cleaned : 'session';
}

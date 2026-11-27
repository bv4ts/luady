import { isHostId, isLocalHost, isSelfHost, type ActionDTO, type ServerDTO, type SessionDTO } from '@luady/shared';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useApi } from '../../../api/context.js';
import { userMessage } from '../../../api/errors.js';
import { describeAction } from '../../../lib/actions.js';
import { mustPin, usePin } from '../../../pin/PinProvider.js';
import { sessionLabel } from '../../../state/selectors.js';
import { useStore } from '../../../state/store.js';
import { useRooms } from '../../rooms/useRooms.js';

/** Same wording as SessionControls on the session page. */
const STOP_DETAIL = 'Sends Escape and /exit, then closes the pane after 10 seconds.';
const RESTART_DETAIL = 'Stops the session and resumes it with claude --resume.';

/**
 * Whether a host has a web terminal: with the hub's server list, a listed server whose `terminal` is not off; without
 * one, any host id but the manager's own and this computer's (neither has a web terminal).
 */
export function hasTerminal(host: string, servers?: readonly Pick<ServerDTO, 'name' | 'terminal'>[]): boolean {
  if (!isHostId(host) || isSelfHost(host)) return false;
  if (servers === undefined) return !isLocalHost(host);
  const row = servers.find((server) => server.name === host);
  return row !== undefined && row.terminal !== false;
}

/** The terminal page of a session's pane, or null when its host has no terminal (see hasTerminal). */
export function terminalPath(session: Pick<SessionDTO, 'host' | 'target'>, servers?: readonly Pick<ServerDTO, 'name' | 'terminal'>[]): string | null {
  return hasTerminal(session.host, servers) ? `/terminal/${session.host}?target=${encodeURIComponent(session.target)}` : null;
}

/** Stop, Restart and Terminal with the same client calls and PIN flow as SessionControls. */
export function useSessionCommands() {
  const api = useApi();
  const { state, toast } = useStore();
  const { hostLabel } = useRooms();
  const { runPinned } = usePin();
  const navigate = useNavigate();
  const servers = state.servers;

  const settle = useCallback(async (op: () => Promise<ActionDTO | null>) => {
    try {
      const action = await op();
      if (!action) return;
      const outcome = describeAction(action);
      toast(outcome.kind, outcome.text);
    } catch (err) {
      toast('error', userMessage(err));
    }
  }, [toast]);

  const stop = useCallback((session: SessionDTO) => settle(() => runPinned(
    (pin) => api.stopSession(session.id, { pin: mustPin(pin), force: false }),
    { require: true, title: `Stop ${sessionLabel(session, hostLabel)}`, detail: STOP_DETAIL },
  )), [api, hostLabel, runPinned, settle]);

  const restart = useCallback((session: SessionDTO) => settle(() => runPinned(
    (pin) => api.restartSession(session.id, { pin: mustPin(pin) }),
    { require: true, title: `Restart ${sessionLabel(session, hostLabel)}`, detail: RESTART_DETAIL },
  )), [api, hostLabel, runPinned, settle]);

  /** The terminal page of a session's pane by the hub's server list; null when its host has none. */
  const terminalOf = useCallback((session: Pick<SessionDTO, 'host' | 'target'>) => terminalPath(session, servers), [servers]);

  const openTerminal = useCallback((session: SessionDTO) => {
    const path = terminalOf(session);
    if (path !== null) void navigate(path);
  }, [navigate, terminalOf]);

  return { stop, restart, openTerminal, terminalOf };
}

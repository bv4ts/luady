import '@xterm/xterm/css/xterm.css';
import { TARGET_RE, isHostId } from '@luady/shared';
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { reportError } from '../../lib/report.js';
import { mustPin, usePin } from '../../pin/PinProvider.js';
import { useStore } from '../../state/store.js';
import { Badge } from '../../ui/Badge.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import type { Tone } from '../../ui/tones.js';
import { useRooms } from '../rooms/useRooms.js';
import { mountTerminal, type MountHandlers } from './mount.js';
import type { TermBridge } from './term-bridge.js';
import './terminal.css';

type Phase =
  | { kind: 'auth' }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'ended'; reason: string }
  | { kind: 'error'; message: string }
  /** The host has no web terminal (this computer): nothing to retry. */
  | { kind: 'unavailable'; message: string };

const PHASE_VIEW: Readonly<Record<Phase['kind'], { label: string; tone: Tone }>> = {
  auth: { label: 'Waiting for PIN', tone: 'waiting' },
  connecting: { label: 'Connecting', tone: 'starting' },
  open: { label: 'Connected', tone: 'idle' },
  ended: { label: 'Closed', tone: 'ended' },
  error: { label: 'Error', tone: 'error' },
  unavailable: { label: 'Not available', tone: 'ended' },
};

export const NO_TERMINAL = 'Terminal is not available for this computer.';

/** Whether the link can open: wait for the server list, then a listed host with a terminal. */
type Access = 'wait' | 'invalid' | 'none' | 'ok';

function useAccess(server: string, target: string | undefined): Access {
  const { loaded, servers } = useStore().state;
  if (!isHostId(server) || (target !== undefined && !TARGET_RE.test(target))) return 'invalid';
  if (!loaded) return 'wait';
  const row = servers.find((candidate) => candidate.name === server);
  if (row === undefined) return 'invalid';
  return row.terminal ? 'ok' : 'none';
}

/** Close codes: 4408 idle timeout, 4401 session expired. */
function closeReason(code: number): string {
  if (code === 4408) return 'The terminal closed after 15 minutes without input.';
  if (code === 4401) return 'Your session expired. Reload the page and sign in again.';
  return 'The connection closed.';
}

const KEYS = [
  { label: 'Esc', data: '\u001b', name: 'Escape' },
  { label: 'Tab', data: '\t', name: 'Tab' },
  { label: '^C', data: '\u0003', name: 'Control C' },
  { label: '↑', data: '\u001b[A', name: 'Arrow up' },
  { label: '↓', data: '\u001b[B', name: 'Arrow down' },
  { label: '←', data: '\u001b[D', name: 'Arrow left' },
  { label: '→', data: '\u001b[C', name: 'Arrow right' },
] as const;

function phaseHandlers(setPhase: Dispatch<SetStateAction<Phase>>, setRenderer: (kind: 'webgl' | 'dom') => void): MountHandlers {
  return {
    onOpen: () => setPhase({ kind: 'open' }),
    onExit: (code) => setPhase({ kind: 'ended', reason: code === null ? 'The shell closed.' : `The shell exited with code ${code}.` }),
    onClose: (code) => setPhase((current) => (current.kind === 'ended' ? current : { kind: 'ended', reason: closeReason(code) })),
    onWarning: (message) => reportError('terminal', new Error(message)),
    onRenderer: setRenderer,
  };
}

interface TerminalTarget {
  readonly server: string;
  readonly target: string | undefined;
  /** The host as the owner knows it (its room's name). */
  readonly label: string;
  readonly access: Access;
}

function useTerminal({ server, target, label, access }: TerminalTarget, host: RefObject<HTMLDivElement | null>, attempt: number) {
  const api = useApi();
  const { runPinned } = usePin();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  const bridge = useRef<TermBridge | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'auth' });
  const [renderer, setRenderer] = useState<'webgl' | 'dom'>('webgl');

  // A room renamed while the terminal runs must not reopen it: the label is read when the PIN prompt opens.
  const labelRef = useRef(label);
  useEffect(() => {
    navigateRef.current = navigate;
    labelRef.current = label;
  }, [navigate, label]);

  useEffect(() => {
    const element = host.current;
    if (!element || access === 'wait') return undefined;
    if (access === 'invalid') {
      setPhase({ kind: 'error', message: 'This terminal link is not valid.' });
      return undefined;
    }
    if (access === 'none') {
      setPhase({ kind: 'unavailable', message: NO_TERMINAL });
      return undefined;
    }
    let cancelled = false;
    let dispose: (() => void) | null = null;
    const start = async () => {
      setPhase({ kind: 'auth' });
      const granted = await runPinned((pin) => api.openTerminal({ server, ...(target ? { target } : {}), pin: mustPin(pin) }),
        { require: true, title: `Open terminal on ${labelRef.current}`, detail: target ? `Attach to ${target}` : 'A new shell' });
      if (cancelled) return;
      if (!granted) {
        void navigateRef.current(-1);
        return;
      }
      setPhase({ kind: 'connecting' });
      const mounted = mountTerminal(element, granted.ticket, phaseHandlers(setPhase, setRenderer));
      bridge.current = mounted.bridge;
      dispose = mounted.dispose;
    };
    start().catch((err: unknown) => {
      if (!cancelled) setPhase({ kind: 'error', message: userMessage(err) });
    });
    return () => {
      cancelled = true;
      bridge.current = null;
      dispose?.();
    };
  }, [access, api, attempt, host, runPinned, server, target]);

  return { phase, renderer, bridge };
}

function noticeOf(phase: Phase): string | null {
  if (phase.kind === 'error' || phase.kind === 'unavailable') return phase.message;
  return phase.kind === 'ended' ? phase.reason : null;
}

export function TerminalPage() {
  const { server = '' } = useParams();
  const [search] = useSearchParams();
  const target = search.get('target') ?? undefined;
  const navigate = useNavigate();
  const hostRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const label = useRooms().hostLabel(server);
  const access = useAccess(server, target);
  const { phase, renderer, bridge } = useTerminal({ server, target, label, access }, hostRef, attempt);
  const view = PHASE_VIEW[phase.kind];
  const notice = noticeOf(phase);

  return (
    <div className="terminal-page">
      <header className="terminal-page__bar">
        <Button variant="ghost" size="sm" icon="back" onClick={() => void navigate(-1)}>Back</Button>
        <div className="terminal-page__title">
          <strong className="mono">{label}</strong>
          <span className="mono">{target ?? 'new shell'}</span>
        </div>
        <Badge tone={view.tone}>{view.label}</Badge>
      </header>
      {renderer === 'dom' ? <Banner tone="warn">Basic rendering: this browser has no WebGL, so colours may be missing.</Banner> : null}
      {notice ? (
        <div className="terminal-page__notice">
          <Banner tone={phase.kind === 'error' ? 'error' : 'info'}>{notice}</Banner>
          {phase.kind === 'unavailable' ? null : (
            <Button variant="primary" size="sm" icon="restart" onClick={() => setAttempt((n) => n + 1)}>Reconnect</Button>
          )}
        </div>
      ) : null}
      <div className="terminal-host" ref={hostRef} />
      <div className="term-keys" role="toolbar" aria-label="Terminal keys">
        {KEYS.map((key) => (
          <button key={key.name} type="button" className="term-key" aria-label={key.name} disabled={phase.kind !== 'open'}
            onClick={() => bridge.current?.sendInput(key.data)}>{key.label}</button>
        ))}
      </div>
    </div>
  );
}

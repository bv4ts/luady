import type { FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { TermClientMessageSchema, type TermClientMessage, type TermServerMessage } from '@luady/shared';
import type { ShellStream } from '../core/contracts.js';
import type { RouteModule, WebContext } from './context.js';
import { TerminalQuerySchema } from './schemas.js';
import { parseJsonMessage, sendJson, sessionStillLive } from './ws-common.js';

export const TERMINAL_CLOSE = { normal: 1000, badMessage: 1008, shellFailed: 1011, badTicket: 4401, idle: 4408, sessionEnded: 4401 } as const;
export const TERMINAL_SIZE = { cols: 120, rows: 32 } as const;
const MAX_PENDING_MESSAGES = 64;

function apply(shell: ShellStream, message: TermClientMessage): void {
  if (message.type === 'input') shell.write(message.data);
  else shell.resize(message.cols, message.rows);
}

/** Bridges one /ws/terminal socket to one ShellStream and closes after idleMs without input. */
class TerminalBridge {
  private shell: ShellStream | null = null;
  private pending: readonly TermClientMessage[] = [];
  private disposed = false;
  private idle: ReturnType<typeof setTimeout>;
  private readonly sessionCheck: ReturnType<typeof setInterval>;
  private readonly socket: WebSocket;
  private readonly idleMs: number;

  /**
   * `sessionLive` is asked on a timer (as the live socket does, web/ws.ts): when the session that opened this terminal
   * ends (signed out, expired, or every session ended by `luady pin reset`), the terminal closes with it.
   */
  constructor(socket: WebSocket, idleMs: number, session: { readonly live: () => boolean; readonly everyMs: number }) {
    this.socket = socket;
    this.idleMs = idleMs;
    this.idle = setTimeout(() => this.onIdle(), idleMs);
    this.sessionCheck = setInterval(() => {
      if (!session.live()) this.socket.close(TERMINAL_CLOSE.sessionEnded, 'session ended');
    }, session.everyMs);
    // The check must never be what keeps a stopping hub alive.
    this.sessionCheck.unref();
  }

  onClientMessage(raw: RawData): void {
    const message = parseJsonMessage(raw, TermClientMessageSchema);
    if (message === null) {
      this.socket.close(TERMINAL_CLOSE.badMessage, 'invalid message');
      return;
    }
    if (message.type === 'input') this.resetIdle();
    if (this.shell !== null) apply(this.shell, message);
    else if (this.pending.length < MAX_PENDING_MESSAGES) this.pending = [...this.pending, message];
  }

  attach(shell: ShellStream): void {
    if (this.disposed) {
      shell.close();
      return;
    }
    this.shell = shell;
    shell.onData((data) => this.send({ type: 'output', data }));
    shell.onExit((code) => {
      this.send({ type: 'exit', code });
      this.socket.close(TERMINAL_CLOSE.normal, 'shell exited');
    });
    for (const message of this.pending) apply(shell, message);
    this.pending = [];
  }

  fail(): void {
    this.send({ type: 'exit', code: null });
    this.socket.close(TERMINAL_CLOSE.shellFailed, 'shell unavailable');
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.idle);
    clearInterval(this.sessionCheck);
    this.shell?.close();
    this.shell = null;
  }

  private send(message: TermServerMessage): void {
    sendJson(this.socket, message);
  }

  private onIdle(): void {
    this.socket.close(TERMINAL_CLOSE.idle, 'idle timeout');
  }

  private resetIdle(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.onIdle(), this.idleMs);
  }
}

function openTerminal(socket: WebSocket, request: FastifyRequest, ctx: WebContext): void {
  const parsed = TerminalQuerySchema.safeParse(request.query ?? {});
  // The session whose cookie opened the socket (the auth chain requires one on /ws/terminal); the terminal lives with it.
  const sid = request.luadySession?.sid ?? null;
  // The ticket was bound to the session that asked for it: presented from another session it opens nothing.
  const grant = parsed.success && sid !== null ? ctx.deps.tickets.consume(parsed.data.ticket, sid) : null;
  if (grant === null || sid === null) {
    socket.close(TERMINAL_CLOSE.badTicket, 'invalid or used ticket');
    return;
  }
  // peek, not touch: an open terminal must not keep the 1 h idle window alive by itself.
  const bridge = new TerminalBridge(socket, ctx.options.terminalIdleMs, {
    live: () => sessionStillLive(() => ctx.store.peek(sid)), everyMs: ctx.options.wsSessionCheckMs,
  });
  socket.on('message', (raw) => bridge.onClientMessage(raw));
  socket.on('close', () => bridge.dispose());
  const size = grant.target === undefined ? { ...TERMINAL_SIZE } : { ...TERMINAL_SIZE, tmuxTarget: grant.target };
  void ctx.deps.fleet.openShell(grant.server, size).then(
    (shell) => bridge.attach(shell),
    (err: unknown) => {
      ctx.deps.log.warn({ err, server: grant.server }, 'terminal shell failed to open');
      bridge.fail();
    },
  );
}

/**
 * The terminal.open action audits the session; here the ticket is consumed exactly once.
 * This socket has no first-message auth: the single-use ticket is its equivalent. Obtaining one (POST
 * /api/terminal/open) needs the page key and the PIN (unless require_pin is off), it lives 60 s, and it opens exactly
 * one socket. The socket also needs a live session cookie, and closes when that session ends.
 */
export const terminalRoutes: RouteModule = (app, ctx) => {
  app.get('/ws/terminal', { websocket: true, exposeHeadRoute: false }, (socket, request) => {
    openTerminal(socket, request, ctx);
  });
};

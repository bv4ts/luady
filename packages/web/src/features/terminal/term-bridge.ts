import { TermServerMessageSchema, type TermClientMessage } from '@luady/shared';
import { wsUrl, type SocketLike } from '../../api/ws.js';

/** The part of an xterm.js Terminal the bridge needs. */
export interface TermLike {
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void };
}

export interface BridgeHandlers {
  onOpen?(): void;
  onExit(code: number | null): void;
  /** WebSocket close code (4401 session expired, 4408 idle timeout). */
  onClose(code: number): void;
  onWarning?(message: string): void;
}

export interface TermBridge {
  sendInput(data: string): void;
  dispose(): void;
}

const CONNECTING = 0;
const OPEN = 1;
/** TermClientMessage input max. */
export const INPUT_CHUNK = 65_536;

export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  return { cols: Math.min(500, Math.max(10, Math.floor(cols))), rows: Math.min(200, Math.max(5, Math.floor(rows))) };
}

export function chunkText(text: string, size: number = INPUT_CHUNK): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export function terminalUrl(ticket: string, loc?: Pick<Location, 'protocol' | 'host'>): string {
  return wsUrl(`/ws/terminal?ticket=${encodeURIComponent(ticket)}`, loc);
}

function handleMessage(data: unknown, term: TermLike, handlers: BridgeHandlers): void {
  let raw: unknown;
  try {
    raw = JSON.parse(String(data));
  } catch {
    handlers.onWarning?.('Ignored a terminal message that is not JSON');
    return;
  }
  const parsed = TermServerMessageSchema.safeParse(raw);
  if (!parsed.success) {
    handlers.onWarning?.('Ignored an invalid terminal message');
    return;
  }
  if (parsed.data.type === 'output') term.write(parsed.data.data);
  else handlers.onExit(parsed.data.code);
}

export function bridgeTerminal(socket: SocketLike, term: TermLike, handlers: BridgeHandlers): TermBridge {
  const send = (message: TermClientMessage) => {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
  };
  const sendInput = (data: string) => {
    for (const chunk of chunkText(data)) send({ type: 'input', data: chunk });
  };

  socket.onopen = () => {
    send({ type: 'resize', ...clampSize(term.cols, term.rows) });
    handlers.onOpen?.();
  };
  socket.onmessage = (event) => handleMessage(event.data, term, handlers);
  socket.onclose = (event) => handlers.onClose(event.code);
  socket.onerror = () => handlers.onWarning?.('Terminal connection error');
  const dataSub = term.onData(sendInput);
  const resizeSub = term.onResize(({ cols, rows }) => send({ type: 'resize', ...clampSize(cols, rows) }));
  let disposed = false;

  return {
    sendInput,
    dispose() {
      if (disposed) return;
      disposed = true;
      dataSub.dispose();
      resizeSub.dispose();
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState === OPEN || socket.readyState === CONNECTING) socket.close(1000, 'closed by user');
    },
  };
}

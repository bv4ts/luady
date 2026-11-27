import { describe, expect, it, vi } from 'vitest';
import { bridgeTerminal, chunkText, clampSize, terminalUrl, type TermLike } from '../../../src/features/terminal/term-bridge.js';
import { FakeSocket } from '../../helpers/fake-socket.js';

function fakeTerm(cols = 120, rows = 40) {
  const written: string[] = [];
  const disposed = { data: false, resize: false };
  let dataListener: ((data: string) => void) | null = null;
  let resizeListener: ((size: { cols: number; rows: number }) => void) | null = null;
  const term: TermLike = {
    cols,
    rows,
    write: (data) => {
      written.push(data);
    },
    onData: (listener) => {
      dataListener = listener;
      return { dispose: () => { disposed.data = true; } };
    },
    onResize: (listener) => {
      resizeListener = listener;
      return { dispose: () => { disposed.resize = true; } };
    },
  };
  return {
    term, written, disposed,
    type: (data: string) => dataListener?.(data),
    resize: (size: { cols: number; rows: number }) => resizeListener?.(size),
  };
}

const handlers = () => ({ onOpen: vi.fn(), onExit: vi.fn(), onClose: vi.fn(), onWarning: vi.fn() });

describe('bridgeTerminal', () => {
  it('sends the size on open and bridges input and output', () => {
    const socket = new FakeSocket('wss://luady.example/ws/terminal?ticket=t');
    const fake = fakeTerm();
    const h = handlers();
    bridgeTerminal(socket, fake.term, h);
    socket.open();
    expect(socket.sentJson()).toEqual([{ type: 'resize', cols: 120, rows: 40 }]);
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    fake.type('ls -la\r');
    socket.receive({ type: 'output', data: 'total 42\r\n' });
    expect(socket.sentJson().at(-1)).toEqual({ type: 'input', data: 'ls -la\r' });
    expect(fake.written).toEqual(['total 42\r\n']);
  });

  it('reports exit and close and ignores invalid messages', () => {
    const socket = new FakeSocket('wss://x/ws/terminal?ticket=t');
    const fake = fakeTerm();
    const h = handlers();
    bridgeTerminal(socket, fake.term, h);
    socket.open();
    socket.receive({ type: 'output' });
    socket.receive('garbage');
    expect(h.onWarning).toHaveBeenCalledTimes(2);
    expect(fake.written).toEqual([]);
    socket.receive({ type: 'exit', code: 130 });
    expect(h.onExit).toHaveBeenCalledWith(130);
    socket.drop(4408);
    expect(h.onClose).toHaveBeenCalledWith(4408);
  });

  it('clamps resizes to the limits', () => {
    const socket = new FakeSocket('wss://x/ws/terminal?ticket=t');
    const fake = fakeTerm();
    bridgeTerminal(socket, fake.term, handlers());
    socket.open();
    fake.resize({ cols: 4, rows: 900 });
    expect(socket.sentJson().at(-1)).toEqual({ type: 'resize', cols: 10, rows: 200 });
    expect(clampSize(80.7, 24.2)).toEqual({ cols: 80, rows: 24 });
  });

  it('chunks large pastes without splitting surrogate pairs', () => {
    const text = `${'a'.repeat(65_535)}😀${'b'.repeat(10)}`;
    const chunks = chunkText(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks[0]).toHaveLength(65_535);
    expect(chunks.every((chunk) => chunk.length <= 65_536)).toBe(true);
    expect(chunkText('xyz', 2)).toEqual(['xy', 'z']);
  });

  it('dispose stops listening and closes the socket', () => {
    const socket = new FakeSocket('wss://x/ws/terminal?ticket=t');
    const fake = fakeTerm();
    const bridge = bridgeTerminal(socket, fake.term, handlers());
    socket.open();
    bridge.dispose();
    bridge.dispose();
    expect(fake.disposed).toEqual({ data: true, resize: true });
    expect(socket.closedWith).toBe(1000);
    expect(socket.onmessage).toBeNull();
  });

  it('terminalUrl encodes the ticket on the page origin', () => {
    expect(terminalUrl('a b', { protocol: 'https:', host: 'luady.example.com' }))
      .toBe('wss://luady.example.com/ws/terminal?ticket=a%20b');
  });
});

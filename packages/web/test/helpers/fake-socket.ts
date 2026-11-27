import type { SocketLike } from '../../src/api/ws.js';

export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];

  static reset(): void {
    FakeSocket.instances = [];
  }

  static last(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) throw new Error('no socket was created');
    return socket;
  }

  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: number | null = null;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  receive(message: unknown): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code }));
  }

  sentJson(): unknown[] {
    return this.sent.map((data) => JSON.parse(data) as unknown);
  }
}
